import type { MLBPropInput, MLBPropOutput } from "../types";

/**
 * Versioned, immutable input contract shared by every HR engine version
 * (evaluateLiveEdgeHrV1 today; evaluateLiveEdgeHrV2 and evaluateRadarShadowV1
 * in later consolidation PRs) so all three are compared on the exact same
 * frozen snapshot of a real evaluation moment — never on independently
 * re-fetched or since-changed live state.
 *
 * `propInput`/`propOutput` are the engine's own Phase 1 contracts
 * (`MLBPropInput`/`MLBPropOutput`) captured verbatim at evaluation time —
 * this snapshot does not redefine engine fields, it freezes them as of the
 * moment of capture. `nearHrTier`/`nearHrDrivers` are the already-computed
 * Phase 2.5 near-HR contact result (`nearHrContact.ts`), likewise captured
 * as a fact rather than recomputed here — near-HR detection is untouched by
 * this consolidation and is not part of the v1/v2/shadow comparison.
 *
 * A future shape change is an additive `HrEvaluationSnapshotV2` type, never
 * a silent mutation of this one.
 */
export interface HrEvaluationSnapshotV1 {
  readonly version: "v1";
  readonly gameId: string;
  readonly playerId: string;
  readonly playerName: string;
  /** ISO timestamp the snapshot was captured. Stamped by the caller — this module never reads the clock. */
  readonly capturedAt: string;
  readonly propInput: MLBPropInput;
  readonly propOutput: MLBPropOutput;
  readonly nearHrTier: "watch" | "lean" | null;
  readonly nearHrDrivers: readonly string[];
}

export function buildHrEvaluationSnapshotV1(params: {
  gameId: string;
  playerId: string;
  playerName: string;
  capturedAt: string;
  propInput: MLBPropInput;
  propOutput: MLBPropOutput;
  nearHrTier: "watch" | "lean" | null;
  nearHrDrivers: readonly string[];
}): HrEvaluationSnapshotV1 {
  return { version: "v1", ...params };
}
