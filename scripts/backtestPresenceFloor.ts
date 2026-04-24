/**
 * Task #128 — Tune presence-floor eligibility thresholds against backtested
 * HR data. ROW/EVENT-LEVEL replay over a historical date range, scoped to a
 * single season.
 *
 * Universe
 * --------
 *   Each row in `game_player_stats` (game_date, game_id, player_id) within
 *   the requested window is one historical event = one chance the
 *   presence-floor pass would have evaluated that batter in that game. We do
 *   NOT dedupe by player — a batter who appeared in 19 games contributes 19
 *   events. Doubleheaders are preserved because the (game_id) component is
 *   carried through.
 *
 * Per-event labels
 * ----------------
 *   - homered            true if `hr_outcomes` has a row for
 *                        (game_date, batter_mlb_id) within the same season.
 *                        Note: same per-day granularity as the alert key
 *                        below, so for the rare doubleheader case where a
 *                        player homers in only one of two games on a date
 *                        we will treat both events as "homered" for the
 *                        coverage tally. Acceptable given the keying
 *                        constraint documented under hadRealAlertRow.
 *   - hadRealAlertRow    true if `hr_radar_alerts` has a non-presence row
 *                        for (sessionDate, playerId) — meaning a real
 *                        PATH A–E (or late-signal/fallback) row already
 *                        exists and the presence-floor pass would have
 *                        skipped this batter for the day. Keying note:
 *                        `hr_radar_alerts.game_id` and
 *                        `game_player_stats.game_id` come from different
 *                        upstream identifier systems and do not align (we
 *                        verified 0 / 158 join matches on shared dates),
 *                        so we cannot reliably narrow to a single game id.
 *                        Per-day keying is the most accurate reconstruction
 *                        available; in practice a real signal earlier in
 *                        the day would have made the floor pass irrelevant
 *                        for that batter for the rest of that day anyway.
 *
 * Per-event point-in-time stats (computed from on-platform tables — no
 * external API calls required, all scoped to the same season)
 * ----------------------------
 *   - seasonHRRate       cumulative HR / PA across all `game_player_stats`
 *                        rows for this player_id with game_date < event date
 *                        AND in the same season (PA approximated as ab + bb;
 *                        gated on PA ≥ 50)
 *   - hrRateLast30       same numerator/denominator over a trailing 30-day
 *                        window (gated on PA ≥ 10)
 *   - barrelRate         barrels / batted-ball events from `contact_events`
 *                        in the trailing 30-day window (gated on BBE ≥ 10)
 *
 * Sweep
 * -----
 *   For each combination of (seasonHRRate, hrRateLast30, barrelRate)
 *   threshold values plus a hot-hitter toggle, we evaluate every event:
 *
 *     - candidate (no real alert row) ?
 *         eligible (any threshold passes) ?
 *           homered ?  -> uncalledHrCovered++
 *                else  -> calledMissPresenceAdded++
 *           presenceRowsSurfaced++ either way
 *
 *   We then report per combo:
 *     presenceRowsSurfaced, uncalledHrCovered / uncalledHrTotal,
 *     calledMissPresenceAdded, missToHrRatio, coverageRate.
 *
 * Recommendation strategy
 * -----------------------
 *   Pick the combination that achieves the **lowest miss:hr ratio** while
 *   covering at least 60% of historical uncalled HRs in the window. If no
 *   combination crosses 60%, pick the lowest miss:hr ratio overall. The
 *   final recommendation, the run window, and the top-25 sorted table are
 *   written to `.local/state/presence-floor-tuning.md`.
 *
 * Usage
 * -----
 *   tsx scripts/backtestPresenceFloor.ts                 # last 14 days
 *   tsx scripts/backtestPresenceFloor.ts --days 30
 *   tsx scripts/backtestPresenceFloor.ts --from 2026-04-04 --to 2026-04-23
 *   tsx scripts/backtestPresenceFloor.ts --season 2026
 *   tsx scripts/backtestPresenceFloor.ts --hot-hitter
 *   tsx scripts/backtestPresenceFloor.ts --json
 *   tsx scripts/backtestPresenceFloor.ts --no-write
 */

import * as fs from "fs";
import * as path from "path";
import { db } from "../server/db";
import { sql } from "drizzle-orm";
import {
  refreshOnlyHomersCache,
  getOnlyHomersEnrichment,
} from "../server/mlb/liveGameOrchestrator";
import { storage } from "../server/storage";

interface CliArgs {
  from: string;
  to: string;
  season: number;
  asJson: boolean;
  writeArtifact: boolean;
  hotHitterEnrich: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const today = new Date();
  const def = (d: Date) => d.toISOString().slice(0, 10);
  let from = def(new Date(today.getTime() - 14 * 86_400_000));
  let to = def(today);
  let asJson = false;
  let writeArtifact = true;
  let hotHitterEnrich = false;
  let explicitSeason: number | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") from = argv[++i];
    else if (a === "--to") to = argv[++i];
    else if (a === "--days") {
      const n = parseInt(argv[++i], 10);
      from = def(new Date(today.getTime() - n * 86_400_000));
      to = def(today);
    } else if (a === "--season") explicitSeason = parseInt(argv[++i], 10);
    else if (a === "--json") asJson = true;
    else if (a === "--no-write") writeArtifact = false;
    else if (a === "--hot-hitter") hotHitterEnrich = true;
  }
  // Explicit --season wins. Otherwise default to the year of `from` so
  // seasonHRRate windows are coherent with the requested replay window.
  let season: number;
  if (explicitSeason != null && Number.isFinite(explicitSeason)) {
    season = explicitSeason;
  } else {
    const fromYear = parseInt(from.slice(0, 4), 10);
    season = Number.isFinite(fromYear) ? fromYear : today.getFullYear();
  }
  return { from, to, season, asJson, writeArtifact, hotHitterEnrich };
}

interface RawAppearance {
  playerId: string;
  playerName: string;
  gameId: string;
  gameDate: string;
  ab: number;
  bb: number;
}
interface ContactSample {
  playerId: string;
  ts: number;
  isBarrel: boolean;
}
interface EventLabeled {
  playerId: string;
  playerName: string;
  gameId: string;
  gameDate: string;
  homered: boolean;
  hadRealAlertRow: boolean;
  seasonHRRate: number | null;
  hrRateLast30: number | null;
  barrelRate: number | null;
  isHotHitter: boolean;
  fromSnapshot: boolean;
}

interface AppearanceRow {
  player_id: unknown;
  player_name: unknown;
  game_id: unknown;
  game_date: unknown;
  ab: unknown;
  bb: unknown;
}
interface HrOutcomeRow {
  player_id: unknown;
  game_date: unknown;
}
interface ContactRow {
  player_id: unknown;
  ts_ms: unknown;
  is_barrel: unknown;
}
interface AlertRow {
  session_date: unknown;
  game_id: unknown;
  player_id: unknown;
  trigger_tags: unknown;
}

const SEASON_HR_RATE_GRID = [0.015, 0.020, 0.025, 0.030, 0.035, 0.040];
const HR_RATE_L30_GRID    = [0.020, 0.025, 0.030, 0.035, 0.040, 0.050];
const BARREL_RATE_GRID    = [0.060, 0.080, 0.100, 0.120, 0.150];
const HOT_TOGGLES         = [true, false];

interface Combo {
  seasonHRRate: number;
  hrRateLast30: number;
  barrelRate: number;
  hotHitterEnabled: boolean;
}
interface ComboResult extends Combo {
  presenceRowsSurfaced: number;
  uncalledHrCovered: number;
  uncalledHrTotal: number;
  candidateEvents: number;
  calledMissPresenceAdded: number;
  missToHrRatio: number;
  coverageRate: number;
}

function isEligible(ev: EventLabeled, c: Combo): boolean {
  if (ev.seasonHRRate != null && ev.seasonHRRate >= c.seasonHRRate) return true;
  if (ev.hrRateLast30 != null && ev.hrRateLast30 >= c.hrRateLast30) return true;
  if (ev.barrelRate    != null && ev.barrelRate    >= c.barrelRate ) return true;
  if (c.hotHitterEnabled && ev.isHotHitter) return true;
  return false;
}

function asString(v: unknown): string {
  return v == null ? "" : String(v);
}
function asNumber(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1 || v === "1";
}

interface SnapshotLookup {
  seasonHRRate: number | null;
  hrRateLast30: number | null;
  barrelRate: number | null;
  isHotHitter: boolean;
}

async function loadSnapshotIndex(from: string, to: string): Promise<Map<string, SnapshotLookup>> {
  const idx = new Map<string, SnapshotLookup>();
  try {
    const snaps = await storage.getBatterRollingSnapshotsForDateRange(from, to);
    for (const s of snaps) {
      const key = `${s.playerId}|${s.sessionDate}`;
      const toNum = (v: unknown): number | null => {
        if (v == null) return null;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      idx.set(key, {
        seasonHRRate: toNum(s.seasonHRRate),
        hrRateLast30: toNum(s.hrRateLast30),
        barrelRate:   toNum(s.barrelRate),
        isHotHitter:  Boolean(s.isHotHitter),
      });
    }
  } catch (err: any) {
    console.error(`[backtest] snapshot lookup failed (falling back to live compute): ${err.message}`);
  }
  return idx;
}

async function loadEvents(args: CliArgs): Promise<{ events: EventLabeled[]; snapshotHits: number; snapshotMisses: number; }> {
  const seasonStart = `${args.season}-01-01`;
  const seasonEnd   = `${args.season}-12-31`;
  const snapshotIndex = await loadSnapshotIndex(args.from, args.to);

  // 1. All in-season game appearances (we need history before the window
  //    too, to compute season-to-date stats — but only within the same
  //    season).
  const appearancesResult = await db.execute<AppearanceRow>(sql`
    SELECT player_id, player_name, game_id, game_date,
           COALESCE(ab, 0)::int AS ab, COALESCE(bb, 0)::int AS bb
    FROM game_player_stats
    WHERE player_id IS NOT NULL
      AND game_date >= ${seasonStart}
      AND game_date <= ${seasonEnd}
    ORDER BY player_id, game_date
  `);
  const allAppearances: RawAppearance[] = appearancesResult.rows.map((r) => ({
    playerId: asString(r.player_id),
    playerName: asString(r.player_name),
    gameId: asString(r.game_id),
    gameDate: asString(r.game_date),
    ab: asNumber(r.ab),
    bb: asNumber(r.bb),
  }));

  // 2. HR events from hr_outcomes, scoped to the same season.
  const hrResult = await db.execute<HrOutcomeRow>(sql`
    SELECT batter_mlb_id AS player_id, game_date
    FROM hr_outcomes
    WHERE batter_mlb_id IS NOT NULL
      AND season = ${args.season}
  `);
  const hrSet = new Set<string>();
  const hrByPlayer = new Map<string, string[]>();
  for (const r of hrResult.rows) {
    const pid = asString(r.player_id);
    const date = asString(r.game_date);
    hrSet.add(`${pid}|${date}`);
    if (!hrByPlayer.has(pid)) hrByPlayer.set(pid, []);
    hrByPlayer.get(pid)!.push(date);
  }
  for (const arr of hrByPlayer.values()) arr.sort();

  // 3. Contact events for trailing barrel rate, scoped to the same season.
  const contactResult = await db.execute<ContactRow>(sql`
    SELECT player_id, EXTRACT(EPOCH FROM timestamp)*1000 AS ts_ms, is_barrel
    FROM contact_events
    WHERE timestamp IS NOT NULL
      AND player_id IS NOT NULL
      AND timestamp >= ${seasonStart}::timestamp
      AND timestamp <  ${`${args.season + 1}-01-01`}::timestamp
  `);
  const contactByPlayer = new Map<string, ContactSample[]>();
  for (const r of contactResult.rows) {
    const pid = asString(r.player_id);
    if (!contactByPlayer.has(pid)) contactByPlayer.set(pid, []);
    contactByPlayer.get(pid)!.push({
      playerId: pid,
      ts: asNumber(r.ts_ms),
      isBarrel: asBool(r.is_barrel),
    });
  }
  for (const arr of contactByPlayer.values()) arr.sort((a, b) => a.ts - b.ts);

  // 4. Real alert rows (non-presence) keyed by (playerId, sessionDate).
  //    See header comment for why we cannot key by gameId here: the upstream
  //    id systems for hr_radar_alerts.game_id and game_player_stats.game_id
  //    do not align, so per-day is the most accurate keying available.
  const alertResult = await db.execute<AlertRow>(sql`
    SELECT session_date, game_id, player_id, trigger_tags
    FROM hr_radar_alerts
    WHERE session_date >= ${seasonStart}
      AND session_date <= ${seasonEnd}
  `);
  const realAlertSet = new Set<string>();
  for (const r of alertResult.rows) {
    const tags = Array.isArray(r.trigger_tags)
      ? (r.trigger_tags as unknown[]).map(asString)
      : [];
    if (tags.includes("presence_floor")) continue;
    realAlertSet.add(`${asString(r.player_id)}|${asString(r.session_date)}`);
  }

  // 5. Per-player in-season appearances bucketed for cumulative stats.
  const appearancesByPlayer = new Map<string, RawAppearance[]>();
  for (const ap of allAppearances) {
    if (!appearancesByPlayer.has(ap.playerId)) appearancesByPlayer.set(ap.playerId, []);
    appearancesByPlayer.get(ap.playerId)!.push(ap);
  }

  // 6. Build labeled events restricted to the requested window. When a
  //    snapshot row exists for (playerId, sessionDate) we prefer those
  //    point-in-time values (Task #129) over the live recompute below — they
  //    reflect what the floor pass would actually have seen at end of slate.
  const labeled: EventLabeled[] = [];
  let snapshotHits = 0;
  let snapshotMisses = 0;
  for (const ap of allAppearances) {
    if (ap.gameDate < args.from || ap.gameDate > args.to) continue;

    const snap = snapshotIndex.get(`${ap.playerId}|${ap.gameDate}`);
    if (snap) {
      snapshotHits++;
      labeled.push({
        playerId: ap.playerId,
        playerName: ap.playerName,
        gameId: ap.gameId,
        gameDate: ap.gameDate,
        homered: hrSet.has(`${ap.playerId}|${ap.gameDate}`),
        hadRealAlertRow: realAlertSet.has(`${ap.playerId}|${ap.gameDate}`),
        seasonHRRate: snap.seasonHRRate,
        hrRateLast30: snap.hrRateLast30,
        barrelRate: snap.barrelRate,
        isHotHitter: snap.isHotHitter,
        fromSnapshot: true,
      });
      continue;
    }
    snapshotMisses++;

    const playerAppearances = appearancesByPlayer.get(ap.playerId) ?? [];

    // a. season-to-date HR rate (in-season only by construction)
    let cumPA = 0;
    for (const pe of playerAppearances) {
      if (pe.gameDate >= ap.gameDate) break;
      cumPA += pe.ab + pe.bb;
    }
    const playerHrDates = hrByPlayer.get(ap.playerId) ?? [];
    let cumHR = 0;
    for (const d of playerHrDates) {
      if (d >= ap.gameDate) break;
      cumHR++;
    }
    const seasonHRRate = cumPA >= 50 ? cumHR / cumPA : null;

    // b. trailing 30 days
    const cutoffDate = (() => {
      const d = new Date(ap.gameDate);
      d.setDate(d.getDate() - 30);
      const iso = d.toISOString().slice(0, 10);
      return iso < seasonStart ? seasonStart : iso;
    })();
    let pa30 = 0;
    let hr30 = 0;
    for (const pe of playerAppearances) {
      if (pe.gameDate >= ap.gameDate) break;
      if (pe.gameDate < cutoffDate) continue;
      pa30 += pe.ab + pe.bb;
    }
    for (const d of playerHrDates) {
      if (d >= ap.gameDate) break;
      if (d < cutoffDate) continue;
      hr30++;
    }
    const hrRateLast30 = pa30 >= 10 ? hr30 / pa30 : null;

    // c. trailing 30d barrel rate
    const eventTs = new Date(ap.gameDate).getTime();
    const seasonStartTs = new Date(seasonStart).getTime();
    const cutoffTs = Math.max(seasonStartTs, eventTs - 30 * 86_400_000);
    const contacts = contactByPlayer.get(ap.playerId) ?? [];
    let bbe = 0;
    let barrels = 0;
    for (const c of contacts) {
      if (c.ts >= eventTs) break;
      if (c.ts < cutoffTs) continue;
      bbe++;
      if (c.isBarrel) barrels++;
    }
    const barrelRate = bbe >= 10 ? barrels / bbe : null;

    labeled.push({
      playerId: ap.playerId,
      playerName: ap.playerName,
      gameId: ap.gameId,
      gameDate: ap.gameDate,
      homered: hrSet.has(`${ap.playerId}|${ap.gameDate}`),
      hadRealAlertRow: realAlertSet.has(`${ap.playerId}|${ap.gameDate}`),
      seasonHRRate,
      hrRateLast30,
      barrelRate,
      isHotHitter: false,
      fromSnapshot: false,
    });
  }
  return { events: labeled, snapshotHits, snapshotMisses };
}

function sweep(events: EventLabeled[]): ComboResult[] {
  const candidates = events.filter(e => !e.hadRealAlertRow);
  const uncalledHrTotal = candidates.filter(e => e.homered).length;
  const results: ComboResult[] = [];
  for (const seasonHRRate of SEASON_HR_RATE_GRID) {
    for (const hrRateLast30 of HR_RATE_L30_GRID) {
      for (const barrelRate of BARREL_RATE_GRID) {
        for (const hot of HOT_TOGGLES) {
          const combo: Combo = { seasonHRRate, hrRateLast30, barrelRate, hotHitterEnabled: hot };
          let presence = 0;
          let covered = 0;
          let miss = 0;
          for (const e of candidates) {
            if (!isEligible(e, combo)) continue;
            presence++;
            if (e.homered) covered++;
            else miss++;
          }
          results.push({
            ...combo,
            presenceRowsSurfaced: presence,
            uncalledHrCovered: covered,
            uncalledHrTotal,
            candidateEvents: candidates.length,
            calledMissPresenceAdded: miss,
            missToHrRatio: covered > 0 ? miss / covered : Infinity,
            coverageRate: uncalledHrTotal > 0 ? covered / uncalledHrTotal : 0,
          });
        }
      }
    }
  }
  return results;
}

function pickRecommendation(results: ComboResult[]): ComboResult | null {
  const usable = results.filter(r => r.uncalledHrTotal > 0 && r.uncalledHrCovered > 0);
  if (usable.length === 0) return null;
  const sufficient = usable.filter(r => r.coverageRate >= 0.60);
  const pool = sufficient.length > 0 ? sufficient : usable;
  return pool.slice().sort((a, b) => {
    if (a.missToHrRatio !== b.missToHrRatio) return a.missToHrRatio - b.missToHrRatio;
    return b.coverageRate - a.coverageRate;
  })[0];
}

function formatTable(results: ComboResult[]): string {
  const rows = results.slice().sort((a, b) => a.missToHrRatio - b.missToHrRatio).slice(0, 25);
  const header = ["seasonHR", "hrL30", "barrel", "hot", "presence", "covered", "extraMiss", "miss:hr", "cov%"];
  const widths  = [9,         7,       8,        5,     9,          12,        10,          8,         6];
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(" ");
  const lines = [fmt(header)];
  for (const r of rows) {
    lines.push(fmt([
      r.seasonHRRate.toFixed(3),
      r.hrRateLast30.toFixed(3),
      r.barrelRate.toFixed(3),
      r.hotHitterEnabled ? "on" : "off",
      String(r.presenceRowsSurfaced),
      `${r.uncalledHrCovered}/${r.uncalledHrTotal}`,
      String(r.calledMissPresenceAdded),
      Number.isFinite(r.missToHrRatio) ? r.missToHrRatio.toFixed(2) : "inf",
      (r.coverageRate * 100).toFixed(1) + "%",
    ]));
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  console.error(`[backtest] window=${args.from}..${args.to} season=${args.season} hotHitter=${args.hotHitterEnrich}`);

  const { events, snapshotHits, snapshotMisses } = await loadEvents(args);
  const candidateCount = events.filter(e => !e.hadRealAlertRow).length;
  const uncalledHrCount = events.filter(e => e.homered && !e.hadRealAlertRow).length;
  console.error(`[backtest] events in window: ${events.length}`);
  console.error(`[backtest] candidate events (no real alert row): ${candidateCount}`);
  console.error(`[backtest] uncalled HRs in window: ${uncalledHrCount}`);
  console.error(`[backtest] snapshot lookups: hits=${snapshotHits} misses=${snapshotMisses} (point-in-time when hit, fallback recompute when miss)`);

  if (args.hotHitterEnrich) {
    try {
      await refreshOnlyHomersCache();
      // Snapshot rows already carry the point-in-time isHotHitter value
      // captured at end of slate (Task #129); never overwrite them with the
      // current-time enrichment, since that would destroy historical fidelity.
      // Only enrich events that came from the live recompute fallback path.
      for (const e of events) {
        if (e.fromSnapshot) continue;
        e.isHotHitter = getOnlyHomersEnrichment(e.playerName).isHotHitter;
      }
    } catch (err) {
      console.error(`[backtest] hot-hitter enrich failed:`, err instanceof Error ? err.message : err);
    }
  }

  const results = sweep(events);
  const recommendation = pickRecommendation(results);

  if (args.asJson) {
    console.log(JSON.stringify({
      window: { from: args.from, to: args.to, season: args.season },
      eventsTotal: events.length,
      candidateEvents: candidateCount,
      uncalledHrTotal: uncalledHrCount,
      results,
      recommendation,
    }, null, 2));
  } else {
    console.log(`\nWindow: ${args.from} → ${args.to}  (season ${args.season})`);
    console.log(`Events in window: ${events.length}`);
    console.log(`Candidate events (no real alert row): ${candidateCount}`);
    console.log(`Uncalled HRs in window: ${uncalledHrCount}`);
    console.log(`\nTop 25 combinations by lowest miss:hr ratio:\n`);
    console.log(formatTable(results));
    console.log(`\nRecommendation:`);
    if (recommendation) console.log(JSON.stringify(recommendation, null, 2));
    else console.log("Insufficient data to recommend new thresholds — keep current production defaults.");
  }

  if (args.writeArtifact) {
    const outDir = path.join(process.cwd(), ".local", "state");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "presence-floor-tuning.md");
    const md = [
      `# Presence Floor Threshold Tuning Report`,
      ``,
      `**Window:** ${args.from} → ${args.to}`,
      `**Season scope:** ${args.season}`,
      `**Events in window:** ${events.length}`,
      `**Candidate events (no real PATH A–E row):** ${candidateCount}`,
      `**Uncalled HRs (homered, no real row):** ${uncalledHrCount}`,
      `**Hot-hitter axis enriched:** ${args.hotHitterEnrich}`,
      ``,
      `## Top 25 combinations by lowest miss:hr ratio`,
      ``,
      "```",
      formatTable(results),
      "```",
      ``,
      `## Recommendation`,
      ``,
      recommendation
        ? "```json\n" + JSON.stringify(recommendation, null, 2) + "\n```"
        : "_Insufficient data to recommend new thresholds — keep current production defaults._",
      ``,
      `## Production constants (after this run)`,
      ``,
      "See `server/mlb/liveGameOrchestrator.ts` — `PRESENCE_FLOOR_*` constants.",
      ``,
    ].join("\n");
    fs.writeFileSync(outPath, md);
    console.error(`[backtest] artifact written: ${outPath}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("[backtest] fatal:", err);
  process.exit(1);
});
