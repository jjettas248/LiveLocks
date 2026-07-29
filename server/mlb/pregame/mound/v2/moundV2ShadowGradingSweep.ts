// Mound Radar V2 (shadow) — grading orchestration (Flagship Program Phase
// 2, Part 5). Storage-touching; imports the pure decision function from the
// sibling moundV2ShadowGrading.ts (same split as V1's storage-touching
// moundShadowOutcomes.ts built on its pure moundOutcomeAttribution.ts).

import { mlbGameCache } from "../../../dataPullService";
import { storage } from "../../../../storage";
import { computeMoundV2GradingDecision, type MoundV2OfficialStatsLookup } from "./moundV2ShadowGrading";
import type { MoundV2ShadowPredictionRow } from "@shared/schema";

export interface MoundV2ShadowGradingSweepSummary {
  graded: number;
  voided: number;
  held: number;
  errors: number;
}

function lookupOfficialStats(row: Pick<MoundV2ShadowPredictionRow, "gameId" | "pitcherId">): MoundV2OfficialStatsLookup {
  const box = mlbGameCache.gamePitchingBoxScore[row.gameId];
  const pitcherLine = box?.byPitcherId?.[row.pitcherId];
  const pitcherOrderForTeam = pitcherLine ? box?.pitcherOrderByTeam?.[pitcherLine.team] : null;
  return { gameStatus: box?.gameStatus, pitcherLine, pitcherOrderForTeam };
}

/**
 * Routine grading tick — mirrors gradeMoundOutcomes()'s 5-minute cadence.
 * Only ever lists settlementStatus="pending" rows (idempotent by
 * construction: a graded/void row is never re-fetched, let alone
 * re-written, by a routine tick). Never throws — a failure listing
 * predictions or grading one row is logged and the sweep continues.
 */
export async function runMoundV2ShadowGradingSweep(): Promise<MoundV2ShadowGradingSweepSummary> {
  const summary: MoundV2ShadowGradingSweepSummary = { graded: 0, voided: 0, held: 0, errors: 0 };

  let pending: MoundV2ShadowPredictionRow[];
  try {
    pending = await storage.listMoundV2ShadowPredictions({ settlementStatus: "pending", limit: 500 });
  } catch (err: unknown) {
    console.warn(
      "[MOUND_V2_SHADOW_GRADE] failed to list pending predictions:",
      err instanceof Error ? err.message : err,
    );
    return summary;
  }

  for (const row of pending) {
    try {
      const frozenLine = row.frozenLine != null ? Number(row.frozenLine) : null;
      const decision = computeMoundV2GradingDecision({
        market: row.market,
        pitcherId: row.pitcherId,
        frozenLine,
        officialStats: lookupOfficialStats(row),
      });

      if (decision.kind === "hold") {
        summary.held++;
        continue;
      }

      const gradedAt = new Date();
      if (decision.kind === "void") {
        await storage.gradeMoundV2ShadowPrediction(row.predictionId, {
          settlementStatus: "void",
          finalResult: null,
          finalStatValue: null,
          gradedAt,
        });
        summary.voided++;
      } else {
        await storage.gradeMoundV2ShadowPrediction(row.predictionId, {
          settlementStatus: "graded",
          finalResult: decision.finalResult,
          finalStatValue: decision.finalStatValue,
          gradedAt,
        });
        summary.graded++;
      }
    } catch (err: unknown) {
      summary.errors++;
      console.warn(
        `[MOUND_V2_SHADOW_GRADE] failed to grade ${row.predictionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return summary;
}

export interface MoundV2RegradeResult {
  changed: boolean;
  reason: "not_found" | "not_yet_graded" | "hold_would_not_regrade" | "no_material_change" | "regraded";
  row?: MoundV2ShadowPredictionRow | null;
}

/**
 * Deliberate, explicitly-invoked re-grade for a single already-settled
 * (graded or void) prediction — for the rare case of an official MLB
 * scoring correction discovered after the routine sweep already settled it.
 * Never called automatically by the sweep. Re-derives fresh from the same
 * pure decision function and only writes (and logs a
 * [MOUND_V2_SHADOW_REGRADE] audit line) when the recomputed verdict
 * actually differs from what's stored. A "hold" verdict never retracts an
 * existing grade back to pending — that would erase, not correct, a fact
 * already on record.
 */
export async function regradeMoundV2ShadowPrediction(predictionId: string): Promise<MoundV2RegradeResult> {
  const existing = await storage.getMoundV2ShadowPrediction(predictionId);
  if (!existing) return { changed: false, reason: "not_found" };
  if (existing.settlementStatus === "pending") return { changed: false, reason: "not_yet_graded" };

  const frozenLine = existing.frozenLine != null ? Number(existing.frozenLine) : null;
  const decision = computeMoundV2GradingDecision({
    market: existing.market,
    pitcherId: existing.pitcherId,
    frozenLine,
    officialStats: lookupOfficialStats(existing),
  });

  if (decision.kind === "hold") {
    return { changed: false, reason: "hold_would_not_regrade" };
  }

  const nextStatus = decision.kind === "void" ? "void" : "graded";
  const nextFinalResult = decision.kind === "void" ? null : decision.finalResult;
  const nextFinalStatValue = decision.kind === "void" ? null : decision.finalStatValue;
  const existingFinalStatValue = existing.finalStatValue != null ? Number(existing.finalStatValue) : null;

  const unchanged =
    existing.settlementStatus === nextStatus &&
    existing.finalResult === nextFinalResult &&
    existingFinalStatValue === nextFinalStatValue;

  if (unchanged) {
    return { changed: false, reason: "no_material_change" };
  }

  console.warn(
    `[MOUND_V2_SHADOW_REGRADE] ${predictionId}: ${existing.settlementStatus}/${existing.finalResult}/${existingFinalStatValue} -> ${nextStatus}/${nextFinalResult}/${nextFinalStatValue}`,
  );
  const updated = await storage.gradeMoundV2ShadowPrediction(predictionId, {
    settlementStatus: nextStatus,
    finalResult: nextFinalResult,
    finalStatValue: nextFinalStatValue,
    gradedAt: new Date(),
  });
  return { changed: true, reason: "regraded", row: updated };
}
