// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: joint starter/bullpen PA-path distribution
//
// Pure. Estimates the JOINT distribution over (PA vs starter = n_s, PA vs bullpen
// = n_b) for a hitter. The batter's PA are sequential: the starter is faced first
// (n_s of them), then — once removed — the bullpen (n_b of them). So for a total
// of N PA, n_s ∈ {0..N} and n_b = N − n_s.
//
// Construction:
//   1. Total-PA marginal P(N=n) from estimatePregamePaDistribution (slot ONLY —
//      NOT teamImpliedRuns, which is market-derived and excluded from probability).
//   2. A starter EXPOSURE SHARE ∈ [0,1] from the projected split (BOTH fields
//      matter): starterShare = s / (s + b). When only one projection exists, the
//      other is inferred from the total-PA mean. An opener signal independently
//      moves mass toward the bullpen (discounts the share, or supplies a frozen
//      opener prior when no explicit split exists).
//   3. For each total n, the conditional starter-faced mean is n · starterShare;
//      a discrete kernel over k∈{0..n} is centered there (boundary shares collapse
//      cleanly to all-starter / all-bullpen), then joint mass
//      P(n_s=k, n_b=n−k) = P(N=n) · P(k | n).
//
// No-op-safe degradation: when there is NO exposure evidence at all (no projected
// split AND no opener signal), the path is UNAVAILABLE — `available:false`,
// `joint:{}`, reason `missing_pa_path`. It is NOT fabricated as all-starter (which
// would maximize starter exposure and ignore the bullpen). Missing exposure cannot
// be reconstructed later (no-backfill), so it must be captured, never assumed.
//
// Share/kernel/opener anchors below are documented DEFAULT PRIORS, NOT fitted.
// ─────────────────────────────────────────────────────────────────────────────

import type { PaPathJointDistribution, StarterBullpenPathInputs } from "./mathTypes";
import { clamp, clamp01 } from "./normalizeStats";
import { estimatePregamePaDistribution } from "./estimatePregamePaDistribution";

/** Base spread of the starter-faced-PA kernel (in PA). Widened for an opener. */
const STARTER_KERNEL_SIGMA = 0.9;
const OPENER_KERNEL_SIGMA = 1.3;

/**
 * Frozen opener exposure prior: with an opener signal but NO explicit projected
 * split, the batter is expected to face the starter for a small share of PA (an
 * opener typically faces the batter ~once), with the rest vs the bullpen.
 */
const OPENER_STARTER_SHARE_PRIOR = 0.2;
/**
 * Frozen opener discount: when an explicit split EXISTS and the opener flag is
 * set, move additional mass toward the bullpen (short leash) on top of the split.
 */
const OPENER_STARTER_SHARE_DISCOUNT = 0.6;

const SHARE_EPS = 1e-6;

export interface PregamePaPathArgs {
  battingOrderSlot: number | null | undefined;
  starterBullpen?: StarterBullpenPathInputs | null;
}

export function estimatePregamePaPath(args: PregamePaPathArgs): PaPathJointDistribution {
  // Total-PA marginal — slot only; teamImpliedRuns is market-derived and excluded.
  const { distribution: totalDist } = estimatePregamePaDistribution({
    battingOrderSlot: args.battingOrderSlot,
  });
  const totalMean = meanOf(totalDist);

  const sb = args.starterBullpen ?? null;
  const vsStarter = finiteNonNegOrNull(sb?.projectedPaVsStarter);
  const vsBullpen = finiteNonNegOrNull(sb?.projectedPaVsBullpen);
  const isOpener = sb?.isOpenerLikely === true;

  const shareResult = computeStarterShare(vsStarter, vsBullpen, totalMean, isOpener);
  if (shareResult == null) {
    return unavailablePath("missing_pa_path");
  }
  const { starterShare, usedOpenerExposurePrior } = shareResult;
  const sigma = isOpener ? OPENER_KERNEL_SIGMA : STARTER_KERNEL_SIGMA;

  const joint: Record<string, number> = {};
  for (const [key, pn] of Object.entries(totalDist)) {
    const n = Number(key);
    if (!Number.isFinite(n) || n < 0 || !Number.isFinite(pn) || pn <= 0) continue;

    // Boundary shares collapse cleanly (no kernel leakage).
    if (starterShare >= 1 - SHARE_EPS) {
      addMass(joint, n, 0, pn);
      continue;
    }
    if (starterShare <= SHARE_EPS) {
      addMass(joint, 0, n, pn);
      continue;
    }

    // Conditional starter-faced mean scales with total PA (both projections matter).
    const muS = n * starterShare;
    const weights: number[] = [];
    let wsum = 0;
    for (let k = 0; k <= n; k++) {
      const w = Math.exp(-((k - muS) ** 2) / (2 * sigma * sigma));
      weights.push(w);
      wsum += w;
    }
    if (wsum <= 0) {
      addMass(joint, n, 0, pn);
      continue;
    }
    for (let k = 0; k <= n; k++) {
      addMass(joint, k, n - k, pn * (weights[k] / wsum));
    }
  }

  return finalize(joint, usedOpenerExposurePrior);
}

// ── share model ────────────────────────────────────────────────────────────

/**
 * Starter exposure share ∈ [0,1]. Returns null when there is NO exposure evidence
 * (no projections and no opener signal) — the path is then unavailable.
 */
function computeStarterShare(
  vsStarter: number | null,
  vsBullpen: number | null,
  totalMean: number,
  isOpener: boolean,
): { starterShare: number; usedOpenerExposurePrior: boolean } | null {
  let share: number;
  let usedOpenerExposurePrior = false;

  if (vsStarter != null && vsBullpen != null) {
    const denom = vsStarter + vsBullpen;
    if (denom <= 0) return null; // no exposure to either — cannot model
    share = vsStarter / denom;
    if (isOpener) share *= OPENER_STARTER_SHARE_DISCOUNT;
  } else if (vsStarter != null) {
    // Infer bullpen exposure from the total-PA mean.
    const impliedBullpen = Math.max(0, totalMean - vsStarter);
    const denom = vsStarter + impliedBullpen;
    share = denom > 0 ? vsStarter / denom : 1;
    if (isOpener) share *= OPENER_STARTER_SHARE_DISCOUNT;
  } else if (vsBullpen != null) {
    // Infer starter exposure from the total-PA mean.
    const impliedStarter = Math.max(0, totalMean - vsBullpen);
    const denom = impliedStarter + vsBullpen;
    share = denom > 0 ? impliedStarter / denom : 0;
    if (isOpener) share *= OPENER_STARTER_SHARE_DISCOUNT;
  } else if (isOpener) {
    // Opener signal with no explicit split → frozen opener prior (lower confidence).
    share = OPENER_STARTER_SHARE_PRIOR;
    usedOpenerExposurePrior = true;
  } else {
    return null; // no exposure evidence at all
  }

  return { starterShare: clamp01(share), usedOpenerExposurePrior };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function unavailablePath(reason: string): PaPathJointDistribution {
  return {
    joint: {},
    starterMean: 0,
    bullpenMean: 0,
    totalMean: 0,
    allStarter: false,
    available: false,
    unavailableReason: reason,
    usedOpenerExposurePrior: false,
  };
}

function addMass(joint: Record<string, number>, ns: number, nb: number, mass: number): void {
  const key = `${ns}:${nb}`;
  joint[key] = (joint[key] ?? 0) + mass;
}

function finalize(
  joint: Record<string, number>,
  usedOpenerExposurePrior: boolean,
): PaPathJointDistribution {
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
    allStarter: bullpenMean <= 1e-12,
    available: true,
    unavailableReason: null,
    usedOpenerExposurePrior,
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

function finiteNonNegOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) && v >= 0 ? v : null;
}
