// Mound Radar V2 (shadow) — non-blocking shadow evaluation.
//
// Called from buildMlbMoundRadar.ts's per-pitcher loop, AFTER the real
// MoundSignal (V1's actual output) has been fully assembled — this function
// never receives, returns, or mutates that signal object, and its result is
// never written back into it. It is pure, synchronous computation (no I/O:
// every input is a value the caller already fetched for V1's own use, so
// this never issues an additional provider/odds/roster request) wrapped in
// its own try/catch so nothing it does can ever throw into the surrounding
// build loop. Latency is measured explicitly (performance.now(), not
// Date.now(), for sub-millisecond precision) precisely so a future increase
// in cost — the trigger for moving to real worker-thread isolation instead
// of inline computation — would be observable rather than silently eating
// into build latency. See CLAUDE.md's Mound V2 status note for why inline
// synchronous execution (not setImmediate, not a worker thread) is the
// right call today: every function in server/mlb/pregame/mound/v2/moundV2Math.ts
// is a closed-form O(n^2)-or-better DP over a lineup of ~9-40 entries — on
// the order of tens of thousands of arithmetic operations, sub-millisecond
// in practice — not a cost that warrants out-of-process isolation. If
// recorded latencyMs ever regresses well past that, that is the signal to
// revisit this decision, not a reason to pre-build unused infrastructure now.

import { performance } from "node:perf_hooks";
import {
  buildFrozenMoundInput,
  type BuildFrozenMoundInputArgs,
  type FrozenMoundInput,
} from "./frozenMoundShadowInput";
import { toMoundV2Inputs, checkMoundV1Parity, type MoundV1ComponentScores, type MoundV1ParityResult } from "./moundV1Adapters";
import { computeMoundV2Distribution } from "./moundV2Engine";
import type { MoundV2Distribution } from "./moundV2Types";
import {
  applyMoundV2DecisionPolicy,
  MOUND_V2_DEFAULT_DECISION_POLICIES,
  type MoundV2DecisionPolicyResult,
} from "./moundV2DecisionPolicy";

export const MOUND_V1_MODEL_VERSION = "mound_v1_production";
export const MOUND_V2_MODEL_VERSION = "mound_v2_shadow_v1";

/** "recommended" only when v1RecommendedSide reflects a genuinely publicly-qualified V1 recommendation (everPubliclyFlagged/everPubliclyFlaggedFade) — never a generic model lean. See moundV2ShadowEvaluation.ts's v1RecommendedSide doc + buildMlbMoundRadar.ts's capture site. */
export type MoundV1QualificationStatus = "recommended" | "not_recommended";

export interface MoundV2ShadowEvaluationResult {
  snapshotId: string;
  gameId: string;
  pitcherId: string;
  evaluatedAt: string;
  frozen: FrozenMoundInput | null;
  distribution: MoundV2Distribution | null;
  parity: MoundV1ParityResult | null;
  /** V1's own overall output for the same candidate — captured for side-by-side persistence/comparison (Part 4/6), never derived or recomputed here. */
  v1Score10: number | null;
  v1Tier: string | null;
  /**
   * V1's own frozen recommended side for THIS exact candidate at THIS exact
   * evaluation moment — null unless v1QualificationStatus is "recommended".
   * Captured, never recomputed. Combined with the frozen strikeoutsMarket
   * prices already on `frozen`, this is what makes a real V1 captured-price
   * decision-policy evaluation possible going forward (see
   * moundV2ComparisonStats.ts's decision-policy evaluation).
   */
  v1RecommendedSide: "OVER" | "UNDER" | null;
  /** Whether v1RecommendedSide represents a real, publicly-qualified V1 wager — see the type's own doc comment. Null only in the failure branch (frozen input itself could not be built), where no V1 capture context was ever resolved. */
  v1QualificationStatus: MoundV1QualificationStatus | null;
  /** V2's OWN versioned decision-policy verdict for each market — qualify-or-abstain, distinct from the raw distribution probabilities. Null only in the failure branch. */
  strikeoutsDecision: MoundV2DecisionPolicyResult | null;
  outsDecision: MoundV2DecisionPolicyResult | null;
  latencyMs: number;
  failureReason: string | null;
}

export interface EvaluateMoundV2ShadowArgs {
  snapshotId: string;
  now: Date;
  frozenInputArgs: Omit<BuildFrozenMoundInputArgs, "snapshotId" | "now">;
  productionComponentScores: MoundV1ComponentScores;
  /** V1's own already-computed overall score10/tier for this exact candidate — passed straight through, never recomputed. */
  v1Score10: number | null;
  v1Tier: string | null;
  /** V1's own frozen recommended side — see the result field's doc comment. */
  v1RecommendedSide: "OVER" | "UNDER" | null;
  /** Whether v1RecommendedSide is a real, publicly-qualified recommendation — see the result field's doc comment. */
  v1QualificationStatus: MoundV1QualificationStatus;
  strikeoutsLine?: number | null;
  outsLine?: number | null;
}

/**
 * Never throws. Every failure mode (a bad input, an arithmetic edge case, a
 * defect in the model itself) is caught and reported via `failureReason`
 * instead — the caller's build loop and V1's own signal are structurally
 * unreachable from this function's error path.
 */
export function evaluateMoundV2Shadow(args: EvaluateMoundV2ShadowArgs): MoundV2ShadowEvaluationResult {
  const start = performance.now();
  const base = {
    snapshotId: args.snapshotId,
    gameId: args.frozenInputArgs.gameId,
    pitcherId: args.frozenInputArgs.pitcherId,
    evaluatedAt: args.now.toISOString(),
  };
  try {
    const frozen = buildFrozenMoundInput({
      snapshotId: args.snapshotId,
      now: args.now,
      ...args.frozenInputArgs,
    });
    const v2Inputs = toMoundV2Inputs(frozen, { strikeoutsLine: args.strikeoutsLine, outsLine: args.outsLine });
    const distribution = computeMoundV2Distribution(v2Inputs);
    const parity = checkMoundV1Parity(frozen, args.productionComponentScores);

    // Decision-policy application happens HERE, downstream of the pure
    // probability computation above — price/provenance/data-quality are
    // read here to decide qualify-or-abstain, never fed back into
    // computeMoundV2Distribution itself.
    const strikeoutsDecision = applyMoundV2DecisionPolicy(MOUND_V2_DEFAULT_DECISION_POLICIES.pitcher_strikeouts, {
      overProbability: distribution.strikeouts.overProbability,
      underProbability: distribution.strikeouts.underProbability,
      pushProbability: distribution.strikeouts.pushProbability,
      dataQuality: frozen.dataQuality,
      lineupStatus: frozen.lineupStatus,
      overPrice: frozen.strikeoutsMarket.overPrice,
      underPrice: frozen.strikeoutsMarket.underPrice,
      sportsbook: frozen.strikeoutsMarket.sportsbook,
      oddsFetchedAt: frozen.strikeoutsMarket.fetchedAt,
      now: args.now,
    });
    const outsDecision = applyMoundV2DecisionPolicy(MOUND_V2_DEFAULT_DECISION_POLICIES.pitcher_outs, {
      overProbability: distribution.outs.overProbability,
      underProbability: distribution.outs.underProbability,
      pushProbability: distribution.outs.pushProbability,
      dataQuality: frozen.dataQuality,
      lineupStatus: frozen.lineupStatus,
      overPrice: frozen.outsMarket.overPrice,
      underPrice: frozen.outsMarket.underPrice,
      sportsbook: frozen.outsMarket.sportsbook,
      oddsFetchedAt: frozen.outsMarket.fetchedAt,
      now: args.now,
    });

    return {
      ...base,
      frozen,
      distribution,
      parity,
      v1Score10: args.v1Score10,
      v1Tier: args.v1Tier,
      v1RecommendedSide: args.v1RecommendedSide,
      v1QualificationStatus: args.v1QualificationStatus,
      strikeoutsDecision,
      outsDecision,
      latencyMs: performance.now() - start,
      failureReason: null,
    };
  } catch (err: unknown) {
    return {
      ...base,
      frozen: null,
      distribution: null,
      parity: null,
      v1Score10: args.v1Score10,
      v1Tier: args.v1Tier,
      v1RecommendedSide: args.v1RecommendedSide,
      v1QualificationStatus: null,
      strikeoutsDecision: null,
      outsDecision: null,
      latencyMs: performance.now() - start,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}
