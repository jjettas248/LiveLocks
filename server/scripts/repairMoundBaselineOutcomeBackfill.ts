// One-shot backfill for mlb_mound_radar_signals rows graded BEFORE the
// strikeouts-only settlement fix shipped (see moundBaselineOutcomeBackfill.ts
// for the pure planning logic). Recomputes outcomes.outcome/userVisible/
// seasonBaselineValue for rows whose Best Angle badge (primaryMarket) was
// "pitcher_outs" at original grading time, using the frozen pregame K
// baseline + final strikeouts already captured on the same row regardless of
// Best Angle. Rows already graded on strikeouts, or missing the frozen K
// baseline / final K count, are left untouched — never fabricated.
//
// Merges into the existing `outcomes` object field-by-field — never a blind
// overwrite — so every other outcome field (finalStrikeouts, marketOutcome,
// etc.) is byte-identical before and after. Safe to re-run: recomputing from
// the same stored data always produces the same patch (idempotent).
//
// Usage:
//   npx tsx server/scripts/repairMoundBaselineOutcomeBackfill.ts --dry-run
//   npx tsx server/scripts/repairMoundBaselineOutcomeBackfill.ts --apply

import { db } from "../db";
import { mlbMoundRadarSignals } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  planMoundBaselineOutcomeBackfill,
  type MoundBaselineOutcomeBackfillRow,
} from "../mlb/pregame/mound/moundBaselineOutcomeBackfill";
import { resolveMoundSettlementDirection } from "../mlb/pregame/mound/moundOutcomeAttribution";
import type { MoundDirection } from "../mlb/pregame/mound/moundDirection";
import type { MoundDiagnostics, MoundMarket, MoundOutcome } from "../mlb/pregame/mound/types";

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;
  console.log(`[MOUND_BASELINE_OUTCOME_BACKFILL] mode=${dryRun ? "dry-run" : "apply"}`);

  const rows = await db.select().from(mlbMoundRadarSignals);
  const graded = rows.filter((r) => r.outcomes != null && r.primaryMarket === "pitcher_outs");
  console.log(`[MOUND_BASELINE_OUTCOME_BACKFILL] scanned ${rows.length} rows, ${graded.length} graded with Best Angle = pitcher_outs`);

  const projection: MoundBaselineOutcomeBackfillRow[] = graded.map((r) => {
    const outcomes = r.outcomes as MoundOutcome;
    const diagnostics = r.diagnostics as MoundDiagnostics | null;
    const moundDirection = (r.moundDirection as MoundDirection) ?? null;
    // Same durable-exposure resolution moundShadowOutcomes.ts uses at grading
    // time — the persisted moundDirection column can have been recomputed by
    // a later rebuild, so it is not trustworthy on its own.
    const settledDirection = resolveMoundSettlementDirection({
      moundDirection: outcomes.settledDirection ?? moundDirection,
      everPubliclyFlagged: r.everPubliclyFlagged,
      everPubliclyFlaggedFade: r.everPubliclyFlaggedFade,
    });
    const wasPubliclyFlagged = settledDirection === "fade" ? r.everPubliclyFlaggedFade : r.everPubliclyFlagged;
    return {
      signalId: r.signalId,
      primaryMarket: r.primaryMarket as MoundMarket,
      finalStrikeouts: outcomes.finalStrikeouts ?? null,
      frozenBaselineStrikeouts:
        diagnostics?.evaluation?.finalPregameSnapshot?.champion.frozenProductionBaseline.strikeouts.value ?? null,
      settledDirection,
      wasPubliclyFlagged,
    };
  });

  const plan = planMoundBaselineOutcomeBackfill(projection);
  console.log(`[MOUND_BASELINE_OUTCOME_BACKFILL] rows resolvable for backfill: ${plan.length}`);

  for (const entry of plan) {
    console.log(
      `[MOUND_BASELINE_OUTCOME_BACKFILL_ROW] signalId=${entry.signalId} outcome=${entry.patch.outcome} ` +
        `userVisible=${entry.patch.userVisible} baseline=${entry.patch.seasonBaselineValue}`,
    );
  }

  if (dryRun) {
    console.log("[MOUND_BASELINE_OUTCOME_BACKFILL] dry-run complete — no changes made. Re-run with --apply to write.");
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
        outcome: entry.patch.outcome,
        userVisible: entry.patch.userVisible,
        seasonBaselineValue: entry.patch.seasonBaselineValue,
      };
      await db
        .update(mlbMoundRadarSignals)
        .set({ outcomes: mergedOutcomes })
        .where(eq(mlbMoundRadarSignals.signalId, entry.signalId));
      backfilled++;
    } catch (err: any) {
      failed++;
      console.error(`[MOUND_BASELINE_OUTCOME_BACKFILL] failed to backfill ${entry.signalId}:`, err?.message ?? err);
    }
  }

  console.log(`[MOUND_BASELINE_OUTCOME_BACKFILL] DONE — backfilled=${backfilled} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[MOUND_BASELINE_OUTCOME_BACKFILL] FATAL:", err);
  process.exit(1);
});
