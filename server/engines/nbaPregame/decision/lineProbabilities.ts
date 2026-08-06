// PR4 — NBA Pregame Targets: coherent line probabilities (decision layer).
//
// This is the FIRST place a betting line meets the projection. It joins a line to
// the frozen, line-blind PR3 count PMF and produces coherent OVER/UNDER/push
// probabilities. It lives in the DECISION layer (server/engines/nbaPregame/decision/),
// downstream of PR3's blind core — the PR3 engine, its frozen input, and its hashes
// never see a line and are unchanged by anything here.
//
// Coherence guarantees (all from ONE shared PMF — opposite sides are never
// estimated independently, so they can never contradict):
//   • integer line → real push mass at exactly that count; pOver+pUnder+pPush = 1
//   • half line    → pPush = 0; pOver+pUnder = 1
//   • no-push win  → pNoPushWinOver + pNoPushWinUnder = 1 (when any decidable mass)
//
// The PR3 PMF's LAST bucket carries folded tail mass (P(count ≥ maxK)). A line at
// or above that folded bucket cannot be cleanly resolved (the ≥maxK mass can't be
// split), so `resolvable` is false there and the decision boundary fails closed.
//
// No EV, no odds, no price, no edge, no staking, no recommendation — only the
// probability decomposition of the PMF against the line.

import { isNormalized, PMF_SUM_TOLERANCE } from "../math/pmf";

export interface LineProbabilities {
  line: number;
  isIntegerLine: boolean;
  /** False when the line sits at/above the folded tail bucket (not cleanly decidable). */
  resolvable: boolean;
  pOver: number;
  pUnder: number;
  /** Real push mass for an integer line; exactly 0 for a half line. */
  pPush: number;
  /** pOver / (1 − pPush); 0 when there is no decidable (non-push) mass. */
  pNoPushWinOver: number;
  /** pUnder / (1 − pPush); 0 when there is no decidable (non-push) mass. */
  pNoPushWinUnder: number;
}

/**
 * Decompose a normalized count PMF against a betting line. Pure. THROWS on an
 * empty or non-normalized PMF (an impossible upstream state — the fresh-line
 * decision boundary catches it and fails closed). A half line (…-.5) can never
 * push; an integer line carries the exact count's mass as push.
 */
export function computeLineProbabilities(pmf: number[], line: number): LineProbabilities {
  if (pmf.length === 0) throw new Error("computeLineProbabilities: empty PMF");
  if (!Number.isFinite(line)) throw new Error(`computeLineProbabilities: non-finite line ${line}`);
  if (!isNormalized(pmf, 1e-6)) throw new Error("computeLineProbabilities: PMF not normalized");

  const lastIndex = pmf.length - 1;
  const isIntegerLine = Number.isInteger(line);
  // The last bucket is folded tail mass (≥ maxK); a line must fall strictly below
  // it to be cleanly decidable. (A half line at lastIndex−0.5 is still < lastIndex.)
  const resolvable = line < lastIndex;

  let pOver = 0;
  let pUnder = 0;
  let pPush = 0;
  for (let k = 0; k <= lastIndex; k++) {
    const mass = pmf[k];
    if (isIntegerLine && k === line) pPush += mass;
    else if (k > line) pOver += mass;
    else pUnder += mass;
  }

  // Complementarity is structural (all three come from the same PMF); assert it.
  const total = pOver + pUnder + pPush;
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`computeLineProbabilities: incoherent total ${total} (PMF not normalized?)`);
  }

  const decidable = pOver + pUnder; // = 1 − pPush
  const pNoPushWinOver = decidable > PMF_SUM_TOLERANCE ? pOver / decidable : 0;
  const pNoPushWinUnder = decidable > PMF_SUM_TOLERANCE ? pUnder / decidable : 0;

  return { line, isIntegerLine, resolvable, pOver, pUnder, pPush, pNoPushWinOver, pNoPushWinUnder };
}

/** True iff over/under/push sum to 1 and (when decidable) the no-push pair sums to 1. */
export function lineProbabilitiesAreCoherent(lp: LineProbabilities, tol: number = 1e-9): boolean {
  if (Math.abs(lp.pOver + lp.pUnder + lp.pPush - 1) > tol) return false;
  const noPushSum = lp.pNoPushWinOver + lp.pNoPushWinUnder;
  // Either fully-push degenerate (both 0) or a proper complement summing to 1.
  if (noPushSum === 0) return lp.pPush >= 1 - tol;
  return Math.abs(noPushSum - 1) <= tol;
}
