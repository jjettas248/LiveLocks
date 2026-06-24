/**
 * scripts/backtestHrRadar.ts — HR Radar outcome proof-table generator (READ-ONLY).
 *
 * Joins ground-truth HRs (`hr_outcomes`) to the radar's view
 * (`hr_radar_alerts` + append-only `hr_radar_signal_events`) and prints, per HR:
 *   player | game | HR inning | seen-before-HR | first-detection | highest-section
 *   | score-before-HR | raw-pre-cap-score | cap/suppression reason | missing-inputs
 *   | classification (alerted-TP | hidden-TP | late-positive | full-miss | false-negative)
 * then a confusion table with the VERIFIED denominator (count of real HRs scanned).
 *
 * It mutates nothing. It only reads. Run against the production (or a restored) DB:
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/backtestHrRadar.ts            # last 3 game-dates
 *   DATABASE_URL=postgres://... npx tsx scripts/backtestHrRadar.ts --days=7
 *   DATABASE_URL=postgres://... npx tsx scripts/backtestHrRadar.ts --date=2026-06-23
 *
 * HONEST LIMITS (documented in docs/HR_RADAR_DIAGNOSTIC_AUDIT.md §9):
 *  - `hr_outcomes` has no gameId and no HR end-timestamp; it keys on
 *    (gameDate, batterName, batterMlbId, inning). We bridge to radar by
 *    (sessionDate=gameDate, playerId=batterMlbId) and fall back to a normalized
 *    name match. Game alignment is by date+player, not gameId.
 *  - "score before HR" uses event timestamp when `hitDetectedAt` exists, else
 *    inning ordering (<= HR inning).
 *  - RAW pre-cap score and structured suppression reasons are NOT persisted today
 *    (only the in-memory qualificationAudit holds them). Those columns print
 *    `n/a (not persisted)` until the Phase-0 reason taxonomy lands. Missing-inputs
 *    are inferred from null keys in the persisted batter/pitcher snapshots when present.
 */
import { and, desc, eq, gte, inArray, asc } from "drizzle-orm";
import { db, pool } from "../server/db";
import { hrOutcomes, hrRadarAlerts, hrRadarSignalEvents } from "../shared/schema";
import { reachedHrMaxWindow, reachedHrMaxWindowPeak } from "../server/mlb/hrRadarSection";

// ── stage ranking so we can take the highest section a candidate reached ──
const STAGE_RANK: Record<string, number> = {
  watch: 1, watching: 1, lean: 2, building: 3, live: 3, strong: 4, elite: 5,
  actionable: 6, fire: 6,
};
const stageRank = (s?: string | null) => STAGE_RANK[String(s ?? "").toLowerCase()] ?? 0;
const norm = (s?: string | null) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

function parseArgs() {
  const a = process.argv.slice(2);
  const date = a.find((x) => x.startsWith("--date="))?.split("=")[1];
  const days = Number(a.find((x) => x.startsWith("--days="))?.split("=")[1] ?? 3);
  return { date, days: Number.isFinite(days) ? days : 3 };
}

async function recentGameDates(days: number, fixed?: string): Promise<string[]> {
  if (fixed) return [fixed];
  const rows = await db
    .selectDistinct({ d: hrOutcomes.gameDate })
    .from(hrOutcomes)
    .orderBy(desc(hrOutcomes.gameDate));
  return rows.map((r: any) => r.d).slice(0, days);
}

type Row = {
  player: string; game: string; hrInning: string; seen: string; firstSeen: string;
  highestSection: string; scoreBeforeHr: string; rawPreCap: string; capReason: string;
  missingInputs: string; classification: string;
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set. This harness is read-only but needs a DB to read.");
    process.exit(1);
  }
  const { date, days } = parseArgs();
  const dates = await recentGameDates(days, date);
  if (dates.length === 0) { console.error("No hr_outcomes rows found."); process.exit(0); }
  console.log(`\nHR Radar proof table — game-dates: ${dates.join(", ")}\n`);

  const hrs: any[] = await db.select().from(hrOutcomes).where(inArray(hrOutcomes.gameDate, dates));
  // Pull all alerts + events for those session dates once, index in memory.
  const alerts: any[] = await db.select().from(hrRadarAlerts).where(inArray(hrRadarAlerts.sessionDate, dates));
  const alertById = new Map<string, any>();        // playerId|sessionDate -> alert
  const alertByName = new Map<string, any>();       // normName|sessionDate -> alert
  for (const al of alerts) {
    alertById.set(`${al.playerId}|${al.sessionDate}`, al);
    alertByName.set(`${norm(al.playerName)}|${al.sessionDate}`, al);
  }

  const rows: Row[] = [];
  const tally = { alertedTP: 0, hiddenTP: 0, latePositive: 0, fullMiss: 0, falseNegative: 0 };

  for (const hr of hrs) {
    const sessionDate = hr.gameDate;
    const alert =
      (hr.batterMlbId && alertById.get(`${hr.batterMlbId}|${sessionDate}`)) ||
      alertByName.get(`${norm(hr.batterName)}|${sessionDate}`) ||
      null;

    let events: any[] = [];
    if (alert) {
      events = await db
        .select()
        .from(hrRadarSignalEvents)
        .where(and(eq(hrRadarSignalEvents.gameId, alert.gameId), eq(hrRadarSignalEvents.playerId, alert.playerId)))
        .orderBy(asc(hrRadarSignalEvents.detectedAt));
    }

    // pre-HR slice: prefer timestamp, else inning ordering.
    const hitAt = alert?.hitDetectedAt ? new Date(alert.hitDetectedAt).getTime() : null;
    const hrInning = hr.inning ?? alert?.hitInning ?? null;
    const preHr = events.filter((e) => {
      if (hitAt && e.detectedAt) return new Date(e.detectedAt).getTime() < hitAt;
      if (hrInning != null && e.inning != null) return e.inning <= hrInning;
      return true; // no ordering info — count it as pre-HR (conservative: gives engine credit)
    });

    const firstSeenEv = preHr[0] ?? null;
    const peakStageEv = preHr.reduce((best, e) => (stageRank(e.signalState) > stageRank(best?.signalState) ? e : best), null as any);
    const lastScoreEv = [...preHr].reverse().find((e) => e.score != null) ?? null;
    const suppressEv = [...preHr].reverse().find((e) => String(e.eventType).toLowerCase() === "suppressed") ?? null;

    // classification
    const seenBeforeHr = preHr.length > 0 || (alert?.signalDetectedAt && hitAt && new Date(alert.signalDetectedAt).getTime() < hitAt);
    const curWindow = alert ? reachedHrMaxWindow({ alertTier: alert.alertTier, confidenceTier: alert.confidenceTier, signalState: alert.signalState }) : false;
    const peakWindow = alert ? reachedHrMaxWindowPeak({ peakState: (alert.signalState ?? null), peakConversionProbability: null }) : false;
    const grade = String(alert?.gradingStatus ?? "").toLowerCase();

    let classification: string;
    if (!alert && events.length === 0) {
      classification = "full-miss (never seen)"; tally.fullMiss++;
    } else if (grade === "late_signal" || (!seenBeforeHr && (alert || events.length))) {
      classification = "late-positive"; tally.latePositive++;
    } else if (grade.startsWith("called_hit") || (curWindow && alert?.matchedBeforeHr)) {
      classification = "alerted true positive"; tally.alertedTP++;
    } else if (seenBeforeHr && !curWindow && !peakWindow) {
      classification = "HIDDEN true positive (seen, never promoted)"; tally.hiddenTP++;
    } else if (!seenBeforeHr) {
      classification = "false-negative (no pre-HR signal)"; tally.falseNegative++;
    } else {
      classification = "alerted true positive"; tally.alertedTP++;
    }

    // missing-inputs inference from persisted snapshots (best-effort; many nulls = degraded)
    const snap = firstSeenEv?.batterSnapshot ?? peakStageEv?.batterSnapshot ?? null;
    const psnap = firstSeenEv?.pitcherSnapshot ?? peakStageEv?.pitcherSnapshot ?? null;
    const missing: string[] = [];
    const checkNull = (obj: any, keys: string[], label: string) => {
      if (!obj) { missing.push(`${label}:no-snapshot`); return; }
      for (const k of keys) if (obj[k] == null) missing.push(`${label}.${k}`);
    };
    checkNull(snap, ["seasonHrRate", "barrelRate", "xISO", "handednessSplit"], "batter");
    checkNull(psnap, ["handednessSplit", "hrPer9", "pitchMix"], "pitcher");

    rows.push({
      player: `${hr.batterName} (${hr.batterMlbId ?? "?"})`,
      game: `${hr.batterTeam} ${sessionDate}${alert ? " g=" + alert.gameId : ""}`,
      hrInning: hrInning != null ? `inn ${hrInning}` : "?",
      seen: seenBeforeHr ? "YES" : alert || events.length ? "after-only" : "NO",
      firstSeen: firstSeenEv?.detectedAt ? new Date(firstSeenEv.detectedAt).toISOString().slice(11, 19) + (firstSeenEv.inning ? ` (inn ${firstSeenEv.inning})` : "") : "—",
      highestSection: peakStageEv?.signalState ?? alert?.signalState ?? "—",
      scoreBeforeHr: lastScoreEv?.score != null ? String(lastScoreEv.score) : alert?.currentReadinessScore != null ? `${alert.currentReadinessScore}(cur)` : "—",
      rawPreCap: "n/a (not persisted)",
      capReason: suppressEv ? `suppressed@inn${suppressEv.inning ?? "?"}` : alert?.gradingStatus === "uncalled_hr" ? "uncalled_hr" : "—",
      missingInputs: missing.length ? missing.join(",") : (snap || psnap ? "none" : "n/a (no snapshot)"),
      classification,
    });
  }

  // print table
  const cols: (keyof Row)[] = ["player", "game", "hrInning", "seen", "firstSeen", "highestSection", "scoreBeforeHr", "rawPreCap", "capReason", "missingInputs", "classification"];
  console.log(cols.join(" | "));
  console.log(cols.map(() => "---").join(" | "));
  for (const r of rows) console.log(cols.map((c) => r[c]).join(" | "));

  const total = hrs.length;
  console.log(`\n── Confusion table (denominator = ${total} real HRs scanned) ──`);
  console.log(`alerted true positive : ${tally.alertedTP}`);
  console.log(`HIDDEN true positive  : ${tally.hiddenTP}   <-- seen (watch/build) but never promoted, then HR`);
  console.log(`late positive         : ${tally.latePositive}`);
  console.log(`full miss (never seen): ${tally.fullMiss}`);
  console.log(`false negative        : ${tally.falseNegative}`);
  console.log(`\nHidden+late share of HRs: ${total ? Math.round((100 * (tally.hiddenTP + tally.latePositive)) / total) : 0}% ` +
    `(if high, the engine SAW them but caps/timing kept them from being actionable).`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
