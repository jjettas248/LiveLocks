// One-shot regrade for pregame_power_radar_signals rows whose final-game
// outcome was permanently wiped by the pre-fix "graded-outcome clobbering"
// bug (see git history: "Fix Pregame Radar serving yesterday's slate and
// wiping today's cashed wins"). Before that fix landed, every 15-min rebuild
// re-persisted the day's slate with outcomes=null/status=active|locked,
// overwriting whatever the shadow grader had already stamped — and once the
// slate day rolled over, no further rebuild ever touched those rows again,
// so the wipe was permanent. storage.upsertPregamePowerRadarSignal now
// COALESCEs outcome-bearing columns instead of clobbering them, so this is
// safe to run without fear of a future rebuild erasing the result.
//
// This does NOT fix mis-keyed sessionDate rows (a separate bug, already
// covered by server/scripts/repairPregameRadarSlateDates.ts) — run that
// script first if a date's rows might be stamped under the wrong key.
//
// Re-derives each candidate row's outcome from the game's own final box
// score, fetched fresh from the MLB Stats API. syncGameBoxScore is keyed by
// MLB gamePk (not by date), so historical games resolve exactly like live
// ones — but the DB only stores the ESPN gameId, so gamePk is first resolved
// per-date via the same team-matching helpers game discovery already uses in
// production (fetchMlbGamePkMap/normalizeAbbr). A game whose gamePk can't be
// resolved is skipped and logged, never guessed at.
//
// Usage:
//   npx tsx server/scripts/regradePregameRadarHistory.ts --dates=2026-06-29,2026-06-30,2026-07-01 --dry-run
//   npx tsx server/scripts/regradePregameRadarHistory.ts --dates=2026-06-29,2026-06-30,2026-07-01 --apply

import { storage } from "../storage";
import { syncGameBoxScore } from "../mlb/dataPullService";
import { resolveOutcome } from "../mlb/pregamePowerRadar/shadowOutcomes";
import { rowToSignal, signalToRow } from "../mlb/pregamePowerRadar/pregamePersistence";
import { fetchMlbGamePkMap, normalizeAbbr, type MlbScheduleEntry } from "../mlb/gameDiscoveryService";
import type { PregamePowerRadarSignalRow } from "@shared/schema";

/** Resolve one game's MLB gamePk from its two ESPN team abbreviations + start time. */
function resolveGamePkForRow(
  row: PregamePowerRadarSignalRow,
  pkMap: Map<string, MlbScheduleEntry[]>,
): string | null {
  const a = normalizeAbbr(row.team);
  const b = normalizeAbbr(row.opponent);
  const candidates = [...(pkMap.get(`${a}|${b}`) ?? []), ...(pkMap.get(`${b}|${a}`) ?? [])];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].gamePk;

  // Doubleheader: pick the schedule entry whose start time is closest to the
  // row's own recorded startsAt, rather than guessing.
  if (!row.startsAt) return null;
  const target = Date.parse(row.startsAt);
  if (!Number.isFinite(target)) return null;
  return candidates.reduce((best, c) =>
    Math.abs(Date.parse(c.gameTime) - target) < Math.abs(Date.parse(best.gameTime) - target) ? c : best,
  ).gamePk;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  const datesArg = process.argv.find((a) => a.startsWith("--dates="));
  if (!datesArg) {
    console.error("Usage: npx tsx server/scripts/regradePregameRadarHistory.ts --dates=YYYY-MM-DD,YYYY-MM-DD [--apply]");
    process.exit(1);
  }
  const dates = datesArg
    .slice("--dates=".length)
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  console.log(`[PREGAME_REGRADE] mode=${dryRun ? "dry-run" : "apply"} dates=${dates.join(",")}`);

  let scanned = 0;
  let candidates = 0;
  let unresolvedGames = 0;
  let regraded = 0;
  let failed = 0;

  for (const sessionDate of dates) {
    const rows = await storage.getPregamePowerRadarSignalsByDate(sessionDate);
    scanned += rows.length;

    const needsRegrade = rows.filter((r) => r.gameStatus === "final" && (r.status !== "graded" || !r.outcomes));
    console.log(`[PREGAME_REGRADE] ${sessionDate}: ${rows.length} row(s) scanned, ${needsRegrade.length} candidate(s)`);
    if (needsRegrade.length === 0) continue;
    candidates += needsRegrade.length;

    const pkMap = await fetchMlbGamePkMap(sessionDate);
    const gamePkByGameId = new Map<string, string | null>();
    for (const row of needsRegrade) {
      if (!gamePkByGameId.has(row.gameId)) {
        gamePkByGameId.set(row.gameId, resolveGamePkForRow(row, pkMap));
      }
    }

    for (const [gameId, gamePk] of Array.from(gamePkByGameId.entries())) {
      if (!gamePk) {
        unresolvedGames++;
        console.warn(`[PREGAME_REGRADE] ${sessionDate}: could not resolve MLB gamePk for gameId=${gameId} — skipping its rows`);
        continue;
      }
      try {
        await syncGameBoxScore(gamePk, gameId);
      } catch (err: any) {
        console.warn(`[PREGAME_REGRADE] box score fetch failed gameId=${gameId} gamePk=${gamePk}:`, err?.message ?? err);
      }
    }

    for (const row of needsRegrade) {
      const gamePk = gamePkByGameId.get(row.gameId);
      if (!gamePk) continue;

      const signal = rowToSignal(row);
      const outcome = resolveOutcome(signal);
      if (!outcome) {
        console.warn(`[PREGAME_REGRADE_ROW] ${row.signalId} — no box score line for this batter, skipped`);
        continue;
      }

      console.log(
        `[PREGAME_REGRADE_ROW] ${row.signalId} player=${row.batterName} hr=${outcome.hitHr} outcome=${outcome.outcome} userVisible=${outcome.userVisible}`,
      );
      if (dryRun) continue;

      signal.outcomes = outcome;
      signal.status = "graded";
      try {
        await storage.upsertPregamePowerRadarSignal({ ...signalToRow(signal), gradedAt: new Date() });
        regraded++;
      } catch (err: any) {
        failed++;
        console.error(`[PREGAME_REGRADE] persist failed ${row.signalId}:`, err?.message ?? err);
      }
    }
  }

  console.log(
    `[PREGAME_REGRADE] DONE scanned=${scanned} candidates=${candidates} unresolvedGames=${unresolvedGames} ` +
      `regraded=${regraded} failed=${failed}` +
      (dryRun ? " (dry-run — re-run with --apply to write)" : ""),
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[PREGAME_REGRADE] FATAL:", err);
  process.exit(1);
});
