// One-shot repair for pregame_power_radar_signals rows whose sessionDate is
// off from the game's actual slate day (see slateDateRepair.ts for the pure
// planning logic and buildPregamePowerRadar.ts's history for why this could
// have happened pre-fix). Recomputes sessionDate from the row's own game
// start time / game date — never a blanket day-subtraction — and is safe to
// re-run (idempotent: a row already correctly stamped produces no plan entry).
//
// Usage:
//   npx tsx server/scripts/repairPregameRadarSlateDates.ts --dry-run
//   npx tsx server/scripts/repairPregameRadarSlateDates.ts --apply

import { db } from "../db";
import { pregamePowerRadarSignals } from "@shared/schema";
import { eq } from "drizzle-orm";
import { planSlateDateRepair, type SlateDateRepairRow } from "../mlb/pregamePowerRadar/slateDateRepair";

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  console.log(`[PREGAME_SLATE_REPAIR] mode=${dryRun ? "dry-run" : "apply"}`);

  const rows = await db.select().from(pregamePowerRadarSignals);
  console.log(`[PREGAME_SLATE_REPAIR] scanned ${rows.length} rows`);

  const projection: SlateDateRepairRow[] = rows.map((r) => ({
    signalId: r.signalId,
    sessionDate: r.sessionDate,
    gameDate: r.gameDate,
    startsAt: r.startsAt ?? null,
    gameId: r.gameId,
    batterId: r.batterId,
  }));

  const plan = planSlateDateRepair(projection);
  const collisions = plan.filter((p) => p.collision);
  const actionable = plan.filter((p) => !p.collision);

  console.log(`[PREGAME_SLATE_REPAIR] rows needing repair: ${plan.length}`);
  console.log(`[PREGAME_SLATE_REPAIR]   actionable (safe rename): ${actionable.length}`);
  console.log(`[PREGAME_SLATE_REPAIR]   collisions (needs manual review, skipped): ${collisions.length}`);

  for (const entry of plan) {
    console.log(
      `[PREGAME_SLATE_REPAIR_ROW] signalId=${entry.signalId} ${entry.currentSessionDate} -> ${entry.correctSessionDate} ` +
        `source=${entry.source} collision=${entry.collision}`,
    );
  }

  if (collisions.length > 0) {
    console.warn(
      `[PREGAME_SLATE_REPAIR] ${collisions.length} row(s) collide with an already-existing correctly-dated row — ` +
        `these were NOT modified. Review manually: ${collisions.map((c) => c.signalId).join(", ")}`,
    );
  }

  if (dryRun) {
    console.log("[PREGAME_SLATE_REPAIR] dry-run complete — no changes made. Re-run with --apply to write.");
    process.exit(0);
  }

  let repaired = 0;
  let failed = 0;
  const rowById = new Map(rows.map((r) => [r.signalId, r]));

  for (const entry of actionable) {
    const row = rowById.get(entry.signalId);
    if (!row) continue;
    try {
      await db.transaction(async (tx) => {
        const { signalId: _oldId, sessionDate: _oldDate, createdAt, updatedAt, ...rest } = row;
        await tx.insert(pregamePowerRadarSignals).values({
          ...rest,
          signalId: entry.correctSignalId,
          sessionDate: entry.correctSessionDate,
        });
        await tx.delete(pregamePowerRadarSignals).where(eq(pregamePowerRadarSignals.signalId, entry.signalId));
      });
      repaired++;
    } catch (err: any) {
      failed++;
      console.error(`[PREGAME_SLATE_REPAIR] failed to repair ${entry.signalId}:`, err?.message ?? err);
    }
  }

  console.log(`[PREGAME_SLATE_REPAIR] DONE — repaired=${repaired} failed=${failed} skipped(collision)=${collisions.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[PREGAME_SLATE_REPAIR] FATAL:", err);
  process.exit(1);
});
