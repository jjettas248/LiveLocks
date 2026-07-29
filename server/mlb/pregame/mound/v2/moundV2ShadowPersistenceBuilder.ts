// Mound Radar V2 (shadow) — pure builder from a shadow evaluation result to
// persistable prediction rows. No I/O — server/storage.ts calls this and
// then issues the actual (fire-and-forget, never-awaited-by-the-build-loop)
// INSERT. Kept pure and separate specifically so it is unit-testable without
// a database (this sandbox has none).
//
// One row per market (pitcher_strikeouts, pitcher_outs) — a single shadow
// evaluation always produces exactly two rows when it succeeded, and zero
// rows when it failed (there is nothing real to persist for a failed
// evaluation; the failure itself is already captured in the in-memory
// metrics store — see moundV2ShadowStore.ts — and, for a future capture
// pass, could be its own append-only failure log if that becomes valuable).

import type { MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";
import type { InsertMoundV2ShadowPrediction } from "@shared/schema";

const MOUND_V2_MARKETS = ["pitcher_strikeouts", "pitcher_outs"] as const;

export function buildMoundV2ShadowPredictionRows(
  result: MoundV2ShadowEvaluationResult,
): InsertMoundV2ShadowPrediction[] {
  if (!result.frozen || !result.distribution) return [];
  const { frozen, distribution } = result;

  return MOUND_V2_MARKETS.map((market) => {
    const marketQuote = market === "pitcher_strikeouts" ? frozen.strikeoutsMarket : frozen.outsMarket;
    const marketResult = market === "pitcher_strikeouts" ? distribution.strikeouts : distribution.outs;

    const row: InsertMoundV2ShadowPrediction = {
      predictionId: `${result.snapshotId}:${market}`,
      snapshotId: result.snapshotId,
      gameId: result.gameId,
      pitcherId: result.pitcherId,
      pitcherName: frozen.pitcherName,
      market,
      frozenLine: marketQuote.line != null ? String(marketQuote.line) : null,
      frozenOverPrice: marketQuote.overPrice,
      frozenUnderPrice: marketQuote.underPrice,
      sportsbook: marketQuote.sportsbook,
      oddsFetchedAt: marketQuote.fetchedAt ? new Date(marketQuote.fetchedAt) : null,
      evaluationTimestamp: new Date(frozen.evaluationTimestamp),
      v1Score10: result.v1Score10 != null ? String(result.v1Score10) : null,
      v1Tier: result.v1Tier,
      setupGrade: result.v1Tier,
      v2ExpectedValue: String(marketResult.expectedValue),
      v2OverProbability: String(marketResult.overProbability),
      v2UnderProbability: String(marketResult.underProbability),
      v2PushProbability: String(marketResult.pushProbability),
      productionModelVersion: frozen.productionModelVersion,
      v2ModelVersion: frozen.v2ModelVersion,
      contractVersion: frozen.contractVersion,
      featureHash: frozen.featureHash,
      dataQuality: frozen.dataQuality,
      lineupStatus: frozen.lineupStatus,
      shadowLatencyMs: String(result.latencyMs),
      shadowFailureReason: null,
      settlementStatus: "pending",
      finalResult: null,
      finalStatValue: null,
      gradedAt: null,
    };
    return row;
  });
}
