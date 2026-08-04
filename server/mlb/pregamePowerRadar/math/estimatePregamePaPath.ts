// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: joint starter/bullpen PA-path distribution
//
// Pure. Estimates the JOINT distribution over (PA vs starter = n_s, PA vs bullpen
// = n_b) for a hitter. The batter's PA are sequential: the starter is faced first
// (n_s of them), then — once removed — the bullpen (n_b of them). So for a total
// of N PA, n_s ∈ {0..N} and n_b = N − n_s.
//
// Construction:
//   1. Total-PA marginal P(N=n) from estimatePregamePaDistribution (slot + runs).
//   2. Expected starter-faced PA (muS) from the projected split (opener-aware).
//   3. For each total n, a discrete kernel over the starter-faced count k∈{0..n}
//      centered on muS (truncated + renormalized), then joint mass
//      P(n_s=k, n_b=n−k) = P(N=n) · P(k | n).
//
// Opener/bulk-pitcher handling: a short-leash starter has a small muS, so the
// kernel concentrates mass at low k (few PA vs the starter, most vs the pen). A
// deep starter has a large muS, concentrating mass at high k.
//
// No-op-safe degradation: when NO projected split is available (both
// projectedPaVsStarter and projectedPaVsBullpen null), the whole game routes to
// the starter path (n_b = 0). The joint game-HR probability then collapses to the
// single starter-path result — missing optional bullpen exposure is neutral, never
// fabricated.
//
// Kernel spread / muS anchors below are documented DEFAULT PRIORS, NOT fitted.
// ─────────────────────────────────────────────────────────────────────────────

import type { PaPathJointDistribution, StarterBullpenPathInputs } from "./mathTypes";
import { clamp } from "./normalizeStats";
import { estimatePregamePaDistribution } from "./estimatePregamePaDistribution";

/** Base spread of the starter-faced-PA kernel (in PA). Widened when the split is uncertain. */
const STARTER_KERNEL_SIGMA = 0.9;
const OPENER_KERNEL_SIGMA = 1.3;

export interface PregamePaPathArgs {
  battingOrderSlot: number | null | undefined;
  teamImpliedRuns?: number | null;
  starterBullpen?: StarterBullpenPathInputs | null;
}

export function estimatePregamePaPath(args: PregamePaPathArgs): PaPathJointDistribution {
  const { distribution: totalDist } = estimatePregamePaDistribution({
    battingOrderSlot: args.battingOrderSlot,
    teamImpliedRuns: args.teamImpliedRuns,
  });

  const sb = args.starterBullpen ?? null;
  const vsStarter = finiteOrNull(sb?.projectedPaVsStarter);
  const vsBullpen = finiteOrNull(sb?.projectedPaVsBullpen);

  // No projected split → route the whole game to the starter path (neutral).
  const noSplitSignal = vsStarter == null && vsBullpen == null;
  if (noSplitSignal) {
    return allStarterPath(totalDist);
  }

  // Expected starter-faced PA. Prefer the explicit projection; otherwise derive
  // from the total mean minus projected bullpen PA. Clamp into a sane range.
  const totalMeanRaw = meanOf(totalDist);
  let muS: number;
  if (vsStarter != null) {
    muS = vsStarter;
  } else {
    // vsBullpen present, vsStarter absent.
    muS = totalMeanRaw - (vsBullpen ?? 0);
  }
  muS = clamp(muS, 0, 6);

  const sigma = sb?.isOpenerLikely === true ? OPENER_KERNEL_SIGMA : STARTER_KERNEL_SIGMA;

  const joint: Record<string, number> = {};
  for (const [key, pn] of Object.entries(totalDist)) {
    const n = Number(key);
    if (!Number.isFinite(n) || n < 0 || !Number.isFinite(pn) || pn <= 0) continue;

    // Conditional kernel over k = starter-faced count ∈ {0..n}, centered on muS.
    const weights: number[] = [];
    let wsum = 0;
    for (let k = 0; k <= n; k++) {
      const w = Math.exp(-((k - muS) ** 2) / (2 * sigma * sigma));
      weights.push(w);
      wsum += w;
    }
    if (wsum <= 0) {
      // Degenerate (should not happen) — put all mass on all-starter.
      joint[`${n}:0`] = (joint[`${n}:0`] ?? 0) + pn;
      continue;
    }
    for (let k = 0; k <= n; k++) {
      const pk = weights[k] / wsum;
      const nb = n - k;
      const kk = `${k}:${nb}`;
      joint[kk] = (joint[kk] ?? 0) + pn * pk;
    }
  }

  return finalize(joint);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function allStarterPath(totalDist: Record<string, number>): PaPathJointDistribution {
  const joint: Record<string, number> = {};
  for (const [key, pn] of Object.entries(totalDist)) {
    const n = Number(key);
    if (!Number.isFinite(n) || !Number.isFinite(pn) || pn <= 0) continue;
    joint[`${n}:0`] = (joint[`${n}:0`] ?? 0) + pn;
  }
  const out = finalize(joint);
  out.allStarter = true;
  return out;
}

function finalize(joint: Record<string, number>): PaPathJointDistribution {
  // Renormalize defensively.
  let total = 0;
  for (const v of Object.values(joint)) total += v;
  if (total > 0 && Math.abs(total - 1) > 1e-12) {
    for (const k of Object.keys(joint)) joint[k] /= total;
  }

  let starterMean = 0;
  let bullpenMean = 0;
  for (const [key, mass] of Object.entries(joint)) {
    const [ns, nb] = key.split(":").map(Number);
    starterMean += ns * mass;
    bullpenMean += nb * mass;
  }

  return {
    joint,
    starterMean,
    bullpenMean,
    totalMean: starterMean + bullpenMean,
    allStarter: bullpenMean === 0,
  };
}

function meanOf(dist: Record<string, number>): number {
  let m = 0;
  for (const [key, mass] of Object.entries(dist)) {
    const n = Number(key);
    if (Number.isFinite(n) && Number.isFinite(mass)) m += n * mass;
  }
  return m;
}

function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}
