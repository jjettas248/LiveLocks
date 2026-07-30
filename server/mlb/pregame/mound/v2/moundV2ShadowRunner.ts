// Mound Radar V2 (shadow) — the exact try/catch/record/log wrapper
// buildMlbMoundRadar.ts's per-pitcher loop calls, extracted into its own
// testable function (Correction 2). Previously this logic lived inline in
// the build loop, provable only by reading source text (moundV2ShadowWiring
// .test.ts). Extracting it lets moundV2ShadowRunner.test.ts exercise the
// REAL function at runtime — including forcing evaluate()/record() to throw
// via injected stubs — and prove behaviorally, not just structurally, that
// nothing here can propagate an exception into the caller.
//
// evaluate/record default to the real evaluateMoundV2Shadow/
// recordMoundV2ShadowEvaluation; the deps parameter exists ONLY so tests can
// substitute throwing stubs to prove the containment guarantee — production
// code never passes deps.

import { evaluateMoundV2Shadow, type EvaluateMoundV2ShadowArgs, type MoundV2ShadowEvaluationResult } from "./moundV2ShadowEvaluation";
import { recordMoundV2ShadowEvaluation } from "./moundV2ShadowStore";

export interface RunMoundV2ShadowForPitcherArgs {
  /** For log correlation only — the same signalId V1's own signal uses. */
  signalId: string;
  evaluateArgs: EvaluateMoundV2ShadowArgs;
}

export interface RunMoundV2ShadowForPitcherDeps {
  evaluate?: (args: EvaluateMoundV2ShadowArgs) => MoundV2ShadowEvaluationResult;
  record?: (result: MoundV2ShadowEvaluationResult) => void;
}

/**
 * Never throws, regardless of what `evaluate`/`record` do — this is the
 * ENTIRE containment boundary between the V2 shadow system and V1's own
 * per-pitcher loop iteration. Returns void; there is no result for a caller
 * to read, use, or accidentally merge into V1's own signal.
 */
export function runMoundV2ShadowForPitcher(
  args: RunMoundV2ShadowForPitcherArgs,
  deps: RunMoundV2ShadowForPitcherDeps = {},
): void {
  const evaluate = deps.evaluate ?? evaluateMoundV2Shadow;
  const record = deps.record ?? recordMoundV2ShadowEvaluation;
  try {
    const shadowResult = evaluate(args.evaluateArgs);
    record(shadowResult);
    if (shadowResult.failureReason) {
      console.warn(`[MOUND_V2_SHADOW_FAILURE] ${args.signalId} ${shadowResult.failureReason}`);
    } else if (shadowResult.parity && !shadowResult.parity.matches) {
      console.warn(`[MOUND_V2_PARITY_MISMATCH] ${args.signalId} ${shadowResult.parity.mismatches.join("; ")}`);
    }
  } catch (err: any) {
    // Belt-and-suspenders: evaluateMoundV2Shadow itself never throws (every
    // failure mode inside it is caught and reported via failureReason
    // instead), but this outer guard ensures a defect anywhere in this
    // wrapper (an injected stub in tests, or a future bug in record()) can
    // never affect the caller.
    console.warn(`[MOUND_V2_SHADOW_UNEXPECTED_ERROR] ${args.signalId}`, err?.message ?? err);
  }
}
