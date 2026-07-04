// Pre-Game Power Radar — slate-date repair runner (I/O adapter).
//
// Extracted from server/scripts/repairPregameRadarSlateDates.ts so the same
// logic is reachable both from the CLI script and from the admin-triggered
// HTTP route — the route is what actually runs this in production, since
// this repo's dev sandbox has no route to the live DB. See slateDateRepair.ts
// for the pure planning logic this wraps.

import { db } from "../../db";
import { pregamePowerRadarSignals } from "@shared/schema";
import { eq } from "drizzle-orm";
import { planSlateDateRepair, type SlateDateRepairPlanEntry, type SlateDateRepairRow } from "./slateDateRepair";

export interface SlateDateRepairRunResult {
  mode: "dry-run" | "apply";
  scanned: number;
  plan: SlateDateRepairPlanEntry[];
  actionableCount: number;
  collisionCount: number;
  repaired: number;
  failed: number;
}

/** Scans the full pregame_power_radar_signals table and repairs mis-keyed sessionDate rows. */
export async function runSlateDateRepair(apply: boolean): Promise<SlateDateRepairRunResult> {
  const rows = await db.select().from(pregamePowerRadarSignals);

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

  if (!apply) {
    return {
      mode: "dry-run",
      scanned: rows.length,
      plan,
      actionableCount: actionable.length,
      collisionCount: collisions.length,
      repaired: 0,
      failed: 0,
    };
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

  return {
    mode: "apply",
    scanned: rows.length,
    plan,
    actionableCount: actionable.length,
    collisionCount: collisions.length,
    repaired,
    failed,
  };
}
