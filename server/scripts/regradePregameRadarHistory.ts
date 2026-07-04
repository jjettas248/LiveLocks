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
// Thin CLI wrapper over historicalRegradeRunner.ts, which is also reachable
// via POST /api/admin/mlb/pregame-power-radar/regrade-history for
// environments (like production) where this script can't be run directly.
//
// Usage:
//   npx tsx server/scripts/regradePregameRadarHistory.ts --dates=2026-06-29,2026-06-30,2026-07-01 --dry-run
//   npx tsx server/scripts/regradePregameRadarHistory.ts --dates=2026-06-29,2026-06-30,2026-07-01 --apply

import { runHistoricalRegrade } from "../mlb/pregamePowerRadar/historicalRegradeRunner";

async function main() {
  const apply = process.argv.includes("--apply");
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

  console.log(`[PREGAME_REGRADE] mode=${apply ? "apply" : "dry-run"} dates=${dates.join(",")}`);

  const result = await runHistoricalRegrade(dates, apply);

  console.log(`[PREGAME_REGRADE] scanned=${result.scanned} candidates=${result.candidates}`);
  for (const r of result.rows) {
    console.log(
      `[PREGAME_REGRADE_ROW] ${r.signalId} player=${r.batterName} hr=${r.hitHr} outcome=${r.outcome} userVisible=${r.userVisible}`,
    );
  }
  if (result.unresolvedGames.length > 0) {
    console.warn(`[PREGAME_REGRADE] unresolved games (skipped): ${result.unresolvedGames.join(", ")}`);
  }

  console.log(
    `[PREGAME_REGRADE] DONE scanned=${result.scanned} candidates=${result.candidates} ` +
      `unresolvedGames=${result.unresolvedGames.length} regraded=${result.regraded} failed=${result.failed}` +
      (result.mode === "dry-run" ? " (dry-run — re-run with --apply to write)" : ""),
  );
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[PREGAME_REGRADE] FATAL:", err);
  process.exit(1);
});
