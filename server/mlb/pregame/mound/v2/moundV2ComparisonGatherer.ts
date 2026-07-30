// Mound Radar V2 (shadow) — comparison report gatherer (Flagship Program
// Phase 2, Part 6, corrected). Storage-touching; assembles real
// MoundV2ComparisonRow arrays for the pure engine in the sibling
// moundV2ComparisonStats.ts. Admin-only, read-only — this file never
// writes anything.
//
// Correction 1 simplified this considerably: since the V2 shadow row now
// carries V1's OWN frozen recommended side (v1RecommendedSide) and its
// captured price (frozenOverPrice/frozenUnderPrice, now genuinely
// two-sided), everything the decision-policy comparison needs for BOTH
// models lives on this ONE table. There is no longer a cross-table join
// against mlb_mound_radar_signals for this report at all.

import { storage } from "../../../../storage";
import type { MoundV2ShadowPredictionRow } from "@shared/schema";
import {
  buildMoundV2ComparisonReport,
  type MoundV2ComparisonRow,
  type MoundV2ComparisonFinalResult,
  type MoundV2ComparisonReport,
} from "./moundV2ComparisonStats";
import { getMoundV2ShadowMetrics } from "./moundV2ShadowStore";
import { buildAndEvaluateMoundV2Promotion } from "./moundV2PromotionEvidenceAdapter";
import type { MoundV2PromotionEvidence, MoundV2PromotionVerdict } from "./moundV2PromotionGate";
import { gatherMoundV2ShadowGradingCoverageReport } from "./moundV2ShadowReconciliationSweep";
import { MOUND_V2_SHADOW_JOB_LEASE_MS } from "./moundV2ShadowWorker";

function toComparisonRow(row: MoundV2ShadowPredictionRow): MoundV2ComparisonRow {
  return {
    gameId: row.gameId,
    pitcherId: row.pitcherId,
    market: row.market,
    settlementStatus: row.settlementStatus,
    finalResult: (row.finalResult as MoundV2ComparisonFinalResult | null) ?? null,
    frozenOverPrice: row.frozenOverPrice ?? null,
    frozenUnderPrice: row.frozenUnderPrice ?? null,
    v2OverProbability: Number(row.v2OverProbability),
    v2UnderProbability: Number(row.v2UnderProbability),
    v2PushProbability: Number(row.v2PushProbability),
    v1RecommendedSide: (row.v1RecommendedSide as "OVER" | "UNDER" | null) ?? null,
    contractVersion: row.contractVersion,
    v1Tier: row.v1Tier ?? null,
    v2ModelVersion: row.v2ModelVersion,
    productionModelVersion: row.productionModelVersion,
    v2ModelPolicyVersion: row.v2ModelPolicyVersion ?? null,
    v2ModelSide: (row.v2ModelSide as "OVER" | "UNDER" | null) ?? null,
    v2ModelQualified: row.v2ModelQualified ?? null,
    v2Executable: row.v2Executable ?? null,
    dataQuality: row.dataQuality ?? null,
    lineupStatus: row.lineupStatus ?? null,
    sportsbook: row.sportsbook ?? null,
    oddsFetchedAt: row.oddsFetchedAt ? new Date(row.oddsFetchedAt).toISOString() : null,
  };
}

export interface GatherMoundV2ComparisonOpts {
  /** ET slate date, "YYYY-MM-DD", inclusive. */
  windowStart: string;
  /** ET slate date, "YYYY-MM-DD", inclusive. */
  windowEnd: string;
}

async function fetchComparisonRows(opts: GatherMoundV2ComparisonOpts): Promise<MoundV2ComparisonRow[]> {
  const fromEvaluationTimestamp = new Date(`${opts.windowStart}T00:00:00.000Z`);
  const toEvaluationTimestamp = new Date(`${opts.windowEnd}T23:59:59.999Z`);
  const v2Rows = await storage.listMoundV2ShadowPredictions({
    fromEvaluationTimestamp,
    toEvaluationTimestamp,
    limit: 5000,
  });
  return v2Rows.map(toComparisonRow);
}

/**
 * Assembles real V2 shadow predictions for the declared window and hands
 * them to the pure comparison engine. The window is applied server-side via
 * listMoundV2ShadowPredictions' evaluationTimestamp filter (UTC day
 * boundaries — a coarse reporting window, not per-game settlement, so
 * ET-precision at the edges isn't required).
 */
export async function gatherMoundV2ComparisonReport(
  opts: GatherMoundV2ComparisonOpts,
): Promise<MoundV2ComparisonReport> {
  const comparisonRows = await fetchComparisonRows(opts);
  return buildMoundV2ComparisonReport(comparisonRows, { windowStart: opts.windowStart, windowEnd: opts.windowEnd });
}

export interface GatherMoundV2PromotionReadinessOpts extends GatherMoundV2ComparisonOpts {
  /** Which non-V1 reference to score V2's absolute probability quality against. Defaults to "climatology" if omitted. */
  probabilityComparator?: "climatology" | "market_implied";
  /**
   * Required, not defaulted — see moundV2PromotionEvidenceAdapter.ts's own
   * doc comment. No live runtime monitor for a V2-caused settlement/
   * provenance regression exists today; passing false here is a conscious
   * human/CI attestation that the structural evidence (moundV2ShadowWiring
   * .test.ts + moundV2Engine.test.ts's isolation check) has been reviewed
   * for the code currently deployed, not something this function verifies.
   */
  settlementOrProvenanceRegressionDetected: boolean;
}

/**
 * Evidence + verdict only — never applies a promotion. Uses the SAME
 * comparison-row fetch as gatherMoundV2ComparisonReport (Part 6), plus the
 * in-memory shadow-evaluation counters from Part 3's moundV2ShadowStore for
 * marketCoverage, plus (Section 5) the real grading-coverage report (over
 * the SAME declared window, full row population including pending/void —
 * not just graded-with-line) and real worker-queue stats, so the gate's
 * evidence-integrity checks (settlementErrorRatio, pendingGradingRatio,
 * workerJobFailureRatio) are backed by genuine data rather than failing
 * closed by default.
 */
export async function gatherMoundV2PromotionReadiness(
  opts: GatherMoundV2PromotionReadinessOpts,
): Promise<{ evidence: MoundV2PromotionEvidence; verdict: MoundV2PromotionVerdict }> {
  const comparisonRows = await fetchComparisonRows(opts);
  const shadowMetrics = getMoundV2ShadowMetrics();
  const [gradingCoverageReport, workerQueueStats] = await Promise.all([
    gatherMoundV2ShadowGradingCoverageReport({
      fromEvaluationTimestamp: new Date(`${opts.windowStart}T00:00:00.000Z`),
      toEvaluationTimestamp: new Date(`${opts.windowEnd}T23:59:59.999Z`),
    }),
    storage.getMoundV2ShadowJobQueueStats(MOUND_V2_SHADOW_JOB_LEASE_MS),
  ]);
  return buildAndEvaluateMoundV2Promotion(comparisonRows, {
    probabilityComparator: opts.probabilityComparator ?? "climatology",
    shadowEvaluationTotal: shadowMetrics.totalEvaluations,
    shadowEvaluationFailures: shadowMetrics.totalFailures,
    settlementOrProvenanceRegressionDetected: opts.settlementOrProvenanceRegressionDetected,
    evalWindowStart: opts.windowStart,
    evalWindowEnd: opts.windowEnd,
    gradingCoverageReport: {
      totalRows: gradingCoverageReport.totalRows,
      pendingCount: gradingCoverageReport.pendingCount,
      providerFailureCount: gradingCoverageReport.providerFailureCount,
    },
    workerQueueStats: {
      completed: workerQueueStats.completed,
      deadLetter: workerQueueStats.deadLetter,
    },
  });
}
