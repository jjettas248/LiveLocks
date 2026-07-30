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

export const MOUND_V1_MODEL_VERSION = "mound_v1_production";
export const MOUND_V2_MODEL_VERSION = "mound_v2_shadow_v1";

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
   * evaluation moment (derived from moundDirection: follow->OVER,
   * fade->UNDER, null if V1 had no resolved direction) — captured, never
   * recomputed. Combined with the frozen strikeoutsMarket prices already on
   * `frozen`, this is what makes a real V1 captured-price decision-policy
   * evaluation possible going forward (see moundV2ComparisonStats.ts's
   * decision-policy evaluation) — correcting the earlier assumption that
   * V1's captured-price performance was structurally unavailable.
   */
  v1RecommendedSide: "OVER" | "UNDER" | null;
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
    return {
      ...base,
      frozen,
      distribution,
      parity,
      v1Score10: args.v1Score10,
      v1Tier: args.v1Tier,
      v1RecommendedSide: args.v1RecommendedSide,
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
      latencyMs: performance.now() - start,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}
