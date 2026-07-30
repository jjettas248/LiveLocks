// Mound Radar V2 (shadow) — barrel export.
//
// SHADOW-ONLY MODULE. Everything under server/mlb/pregame/mound/v2/ is
// additive research/backtesting instrumentation for a possible future
// pitcher strikeout/outs PROBABILITY DISTRIBUTION model. As of this PR:
//   - Nothing in this directory is imported by production Mound
//     (buildMlbMoundRadar.ts, scoring.ts, moundDirection.ts,
//     moundOutcomeAttribution.ts, evaluationSnapshot.ts,
//     moundGradedStateCarry.ts, mlbMoundRadarStore.ts, moundPersistence.ts,
//     or any server/storage.ts mound method).
//   - Nothing here is persisted — no DB table, no wiring into
//     buildMlbMoundRadar.ts's build cycle.
//   - Nothing here is promotable by itself — see moundV2PromotionGate.ts.
// Wiring V2 into a live capture/backtest pipeline, and any eventual
// promotion decision, are separate, later pieces of work — see CLAUDE.md's
// Mound V2 status note once added.

export { poissonBinomialPmf, negativeBinomialPmf, computeLineProbabilities, expectedValueOfPmf } from "./moundV2Math";
export { computeBatterStrikeoutProbability, LEAGUE_K_RATE } from "./batterStrikeoutProbability";
export { computeWorkloadDistributions } from "./battersFacedWorkloadModel";
export { computeMoundV2Distribution } from "./moundV2Engine";
export {
  evaluateMoundV2PromotionReadiness,
  MOUND_V2_PROMOTION_THRESHOLDS,
  MOUND_V2_PROMOTION_BLOCKERS,
  type MoundV2PromotionEvidence,
  type MoundV2PromotionVerdict,
  type MoundV2PromotionBlocker,
} from "./moundV2PromotionGate";
export type {
  MoundV2BatterInput,
  MoundV2WorkloadInputs,
  MoundV2Inputs,
  MoundV2MarketResult,
  MoundV2Distribution,
} from "./moundV2Types";
