// One-shot repair for pregame_power_radar_signals rows whose sessionDate is
// off from the game's actual slate day (see slateDateRepair.ts for the pure
// planning logic and buildPregamePowerRadar.ts's history for why this could
// have happened pre-fix). Recomputes sessionDate from the row's own game
// start time / game date — never a blanket day-subtraction — and is safe to
// re-run (idempotent: a row already correctly stamped produces no plan entry).
//
// Thin CLI wrapper over slateDateRepairRunner.ts, which is also reachable via
// POST /api/admin/mlb/pregame-power-radar/repair-slate-dates for environments
// (like production) where this script can't be run directly.
//
// Usage:
//   npx tsx server/scripts/repairPregameRadarSlateDates.ts --dry-run
//   npx tsx server/scripts/repairPregameRadarSlateDates.ts --apply

import { runSlateDateRepair } from "../mlb/pregamePowerRadar/slateDateRepairRunner";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(`[PREGAME_SLATE_REPAIR] mode=${apply ? "apply" : "dry-run"}`);

  const result = await runSlateDateRepair(apply);
  console.log(`[PREGAME_SLATE_REPAIR] scanned ${result.scanned} rows`);
  console.log(`[PREGAME_SLATE_REPAIR] rows needing repair: ${result.plan.length}`);
  console.log(`[PREGAME_SLATE_REPAIR]   actionable (safe rename): ${result.actionableCount}`);
  console.log(`[PREGAME_SLATE_REPAIR]   collisions (needs manual review, skipped): ${result.collisionCount}`);

  for (const entry of result.plan) {
    console.log(
      `[PREGAME_SLATE_REPAIR_ROW] signalId=${entry.signalId} ${entry.currentSessionDate} -> ${entry.correctSessionDate} ` +
        `source=${entry.source} collision=${entry.collision}`,
    );
  }

  if (result.collisionCount > 0) {
    const collisionIds = result.plan.filter((p) => p.collision).map((p) => p.signalId);
    console.warn(
      `[PREGAME_SLATE_REPAIR] ${result.collisionCount} row(s) collide with an already-existing correctly-dated row — ` +
        `these were NOT modified. Review manually: ${collisionIds.join(", ")}`,
    );
  }

  if (result.mode === "dry-run") {
    console.log("[PREGAME_SLATE_REPAIR] dry-run complete — no changes made. Re-run with --apply to write.");
    process.exit(0);
  }

  console.log(
    `[PREGAME_SLATE_REPAIR] DONE — repaired=${result.repaired} failed=${result.failed} skipped(collision)=${result.collisionCount}`,
  );
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[PREGAME_SLATE_REPAIR] FATAL:", err);
  process.exit(1);
});
