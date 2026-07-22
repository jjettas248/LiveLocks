// One-shot backfill for mlb_mound_radar_signals rows graded BEFORE the
// market-settlement feature shipped (see moundMarketOutcomeBackfill.ts for the
// pure planning logic). Populates marketOutcome/sportsbookLine/recommendedSide
// plus lineSnapshotType/lineFrozenAt/lineSource — but ONLY for rows whose
// original frozen pregame line is provably already persisted in
// diagnostics.evaluation.finalPregameSnapshot. Rows with no such evidence are
// left untouched (marketOutcome stays absent, never fabricated).
//
// Merges into the existing `outcomes` object field-by-field — never a blind
// overwrite — so every existing model-outcome field (outcome, userVisible,
// seasonBaselineValue, finalStrikeouts, etc.) is byte-identical before and
// after. Safe to re-run: a row already carrying marketOutcome is skipped by
// the planner (idempotent).
//
// Usage:
//   npx tsx server/scripts/repairMoundMarketOutcomeBackfill.ts --dry-run
//   npx tsx server/scripts/repairMoundMarketOutcomeBackfill.ts --apply

import { db } from "../db";
import { mlbMoundRadarSignals } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  planMoundMarketOutcomeBackfill,
  type MoundMarketOutcomeBackfillRow,
} from "../mlb/pregame/mound/moundMarketOutcomeBackfill";
import type { MoundDirection } from "../mlb/pregame/mound/moundDirection";
import type { MoundDiagnostics, MoundMarket, MoundOutcome } from "../mlb/pregame/mound/types";

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  console.log(`[MOUND_MARKET_OUTCOME_BACKFILL] mode=${dryRun ? "dry-run" : "apply"}`);

  const rows = await db.select().from(mlbMoundRadarSignals);
  const graded = rows.filter((r) => r.outcomes != null);
  console.log(`[MOUND_MARKET_OUTCOME_BACKFILL] scanned ${rows.length} rows, ${graded.length} already graded`);

  const projection: MoundMarketOutcomeBackfillRow[] = graded.map((r) => {
    const outcomes = r.outcomes as MoundOutcome;
    const diagnostics = r.diagnostics as MoundDiagnostics | null;
    return {
      signalId: r.signalId,
      primaryMarket: r.primaryMarket as MoundMarket,
      moundDirection: (r.moundDirection as MoundDirection) ?? null,
      finalStrikeouts: outcomes.finalStrikeouts ?? null,
      finalOutsRecorded: outcomes.finalOutsRecorded ?? null,
      alreadyHasMarketOutcome: outcomes.marketOutcome != null,
      finalPregameSnapshot: diagnostics?.evaluation?.finalPregameSnapshot ?? null,
    };
  });

  const plan = planMoundMarketOutcomeBackfill(projection);
  console.log(`[MOUND_MARKET_OUTCOME_BACKFILL] rows resolvable for backfill: ${plan.length}`);

  let withSource = 0;
  for (const entry of plan) {
    if (entry.patch.lineSource != null) withSource++;
    console.log(
      `[MOUND_MARKET_OUTCOME_BACKFILL_ROW] signalId=${entry.signalId} marketOutcome=${entry.patch.marketOutcome} ` +
        `line=${entry.patch.sportsbookLine} side=${entry.patch.recommendedSide} source=${entry.patch.lineSource ?? "(none — pre-capture row)"}`,
    );
  }
  console.log(`[MOUND_MARKET_OUTCOME_BACKFILL] rows with a resolvable sportsbook name: ${withSource}/${plan.length}`);

  if (dryRun) {
    console.log("[MOUND_MARKET_OUTCOME_BACKFILL] dry-run complete — no changes made. Re-run with --apply to write.");
    process.exit(0);
  }

  const rowById = new Map(graded.map((r) => [r.signalId, r]));
  let backfilled = 0;
  let failed = 0;

  for (const entry of plan) {
    const row = rowById.get(entry.signalId);
    if (!row) continue;
    try {
      const mergedOutcomes: MoundOutcome = {
        ...(row.outcomes as MoundOutcome),
        marketOutcome: entry.patch.marketOutcome,
        sportsbookLine: entry.patch.sportsbookLine,
        recommendedSide: entry.patch.recommendedSide,
        lineSnapshotType: entry.patch.lineSnapshotType,
        lineFrozenAt: entry.patch.lineFrozenAt,
        lineSource: entry.patch.lineSource,
      };
      await db
        .update(mlbMoundRadarSignals)
        .set({ outcomes: mergedOutcomes })
        .where(eq(mlbMoundRadarSignals.signalId, entry.signalId));
      backfilled++;
    } catch (err: any) {
      failed++;
      console.error(`[MOUND_MARKET_OUTCOME_BACKFILL] failed to backfill ${entry.signalId}:`, err?.message ?? err);
    }
  }

  console.log(`[MOUND_MARKET_OUTCOME_BACKFILL] DONE — backfilled=${backfilled} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[MOUND_MARKET_OUTCOME_BACKFILL] FATAL:", err);
  process.exit(1);
});
