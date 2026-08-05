// PR3 — NBA Pregame Targets: correlated (points, rebounds, assists) joint.
//
// Combo markets (pts_reb, pts_ast, reb_ast, pra) are sums of CORRELATED base
// stats. A big night lifts a player's points, rebounds AND assists together
// (more minutes, higher usage, faster pace), so the three counts are positively
// dependent. Convolving each stat's SEPARATED (mixture-collapsed) marginal would
// wrongly treat them as independent and understate combo-market tail risk. This
// module instead builds an explicit JOINT distribution and reads every combo off
// its joint states.
//
// DEPENDENCE MECHANISM — a shared discrete latent game-context factor.
// A single scalar latent L (usage / pace / minutes-form) lives on a fixed
// symmetric grid of positive multipliers {m_g} with weights {w_g}, normalized so
// E[L] = Σ w_g m_g = 1 (the latent preserves each stat's requested mean) and
// Var(L) = Σ w_g m_g² − 1 = τ (the latent strength). Given L = m_g, the three
// stats are CONDITIONALLY INDEPENDENT negative-binomial counts whose conditional
// mean scales by m_g. The joint is the mixture over the latent grid of the outer
// product of the three conditional PMFs.
//
// Moment bookkeeping (law of total variance/covariance), all EXACT by design:
//   • marginal mean of stat s  = μ_s                         (mean preserved)
//   • marginal variance of s   = within_s + μ_s²·τ = V_s     (variance preserved)
//   • Cov(X_s, X_t), s≠t       = μ_s·μ_t·τ  > 0              (positive; ∝ τ)
//   • combo mean               = Σ component means           (sum of means)
//   • combo variance           = Σ V + 2·Σ Cov  > independent-sum variance
// So covariance DIRECTION is positive and its MAGNITUDE tracks the latent
// variance τ — larger shared-context spread ⇒ larger positive covariance.
//
// Pure, deterministic, line-free. Imports only this engine's own PMF primitives.

import {
  negativeBinomialPmf,
  normalizePmf,
  mixPmfInto,
  convolvePmf,
  meanOfPmf,
  varianceOfPmf,
  isNormalized,
  PMF_SUM_TOLERANCE,
} from "../math/pmf";
import type { NbaJointStat } from "../markets";

export interface JointComponentMoments {
  /** Game-total mean count for this stat (non-negative, finite). */
  mean: number;
  /** Game-total variance for this stat (positive, finite, > mean for overdispersion). */
  variance: number;
}

export interface NbaJointInputs {
  // Each joint stat is OPTIONAL: the joint is built over whichever of pts/reb/ast
  // actually projected (>= 1). A combo whose component is absent is unavailable
  // (the engine decides that); the joint itself simply omits absent stats.
  points?: JointComponentMoments;
  rebounds?: JointComponentMoments;
  assists?: JointComponentMoments;
  /** Shared-latent strength τ = Var(L). Optional; defaults to LATENT_STRENGTH_DEFAULT. */
  latentStrength?: number;
  /** Per-stat truncation caps (max count bucket). Optional; sensible NBA defaults. */
  maxCount?: { points?: number; rebounds?: number; assists?: number };
}

/** Default shared-context strength — a moderate multiplicative "game script" factor. */
export const LATENT_STRENGTH_DEFAULT = 0.02;

/** Minimum idiosyncratic (within-latent) variance retained per stat. */
const WITHIN_VARIANCE_FLOOR = 0.5;

/** Fixed symmetric latent grid SHAPE (mean-0 deviations under the weights below). */
const LATENT_DEVIATIONS = [-2, -1, 0, 1, 2] as const;
const LATENT_WEIGHTS = [0.1, 0.2, 0.4, 0.2, 0.1] as const;

const DEFAULT_MAX_COUNT: Record<NbaJointStat, number> = {
  points: 80,
  rebounds: 40,
  assists: 30,
};

export interface LatentGrid {
  /** Positive multipliers m_g, one per grid point (E[m]=1). */
  multipliers: number[];
  /** Weights w_g summing to 1. */
  weights: number[];
  /** Realized Var(L) = τ_eff (may be reduced from the target to keep within-variance positive). */
  variance: number;
}

export interface NbaJointDistribution {
  latent: LatentGrid;
  /** Which joint stats are present in this distribution (subset of pts/reb/ast). */
  presentStats: NbaJointStat[];
  /** Per-latent-state conditional count PMFs for PRESENT stats, [gridIndex] → PMF. */
  conditionalPmfs: Partial<Record<NbaJointStat, number[][]>>;
  /** Requested moments echoed for provenance / hashing (present stats only). */
  requestedMoments: Partial<Record<NbaJointStat, JointComponentMoments>>;
  maxCount: Partial<Record<NbaJointStat, number>>;
}

const JOINT_STATS: NbaJointStat[] = ["points", "rebounds", "assists"];

function requireMoments(label: string, m: JointComponentMoments): void {
  if (!Number.isFinite(m.mean) || m.mean < 0) {
    throw new Error(`joint: ${label} mean must be finite non-negative, got ${m.mean}`);
  }
  if (!Number.isFinite(m.variance) || m.variance <= 0) {
    throw new Error(`joint: ${label} variance must be finite positive, got ${m.variance}`);
  }
}

/**
 * Build the shared latent grid at the largest strength τ_eff ≤ τ_target for which
 * EVERY stat keeps a positive within-latent variance (within_s = V_s − μ_s²·τ ≥
 * floor). Multipliers are the fixed grid shape scaled to realize exactly Var=τ_eff
 * with mean 1; clamped positive as a final safety.
 */
function buildLatentGrid(inputs: NbaJointInputs, present: NbaJointStat[], target: number): LatentGrid {
  const weights = [...LATENT_WEIGHTS];
  const baseVar = (LATENT_DEVIATIONS as readonly number[]).reduce(
    (acc: number, d: number, i: number) => acc + weights[i] * d * d,
    0,
  ); // Σ w d²
  // τ that still leaves within-variance ≥ floor for the binding (max μ²/V-ratio) stat.
  let tauEff = Math.max(0, Number.isFinite(target) ? target : LATENT_STRENGTH_DEFAULT);
  for (const s of present) {
    const { mean, variance } = inputs[s]!;
    if (mean <= 0) continue; // a zero-mean stat contributes no between-variance
    const maxTauForStat = (variance - WITHIN_VARIANCE_FLOOR) / (mean * mean);
    tauEff = Math.min(tauEff, Math.max(0, maxTauForStat));
  }
  const scale = baseVar > 0 && tauEff > 0 ? Math.sqrt(tauEff / baseVar) : 0;
  const multipliers = LATENT_DEVIATIONS.map((d) => Math.max(1e-6, 1 + d * scale));
  // Realized variance under the (possibly clamped) multipliers, for honest provenance.
  const meanM = multipliers.reduce((acc, m, i) => acc + weights[i] * m, 0);
  const realizedVar = multipliers.reduce((acc, m, i) => acc + weights[i] * (m - meanM) * (m - meanM), 0);
  return { multipliers, weights, variance: realizedVar };
}

/**
 * Construct the joint distribution. Pure and deterministic. THROWS on invalid
 * moments (an impossible internal state the pure core surfaces; the engine's
 * safe boundary catches it).
 */
export function buildNbaJoint(inputs: NbaJointInputs): NbaJointDistribution {
  const present = JOINT_STATS.filter((s) => inputs[s] != null);
  if (present.length === 0) throw new Error("joint: at least one of points/rebounds/assists is required");
  for (const s of present) requireMoments(s, inputs[s]!);

  const target = inputs.latentStrength ?? LATENT_STRENGTH_DEFAULT;
  const latent = buildLatentGrid(inputs, present, target);
  const tauEff = latent.variance;

  const maxCount: Partial<Record<NbaJointStat, number>> = {};
  const conditionalPmfs: Partial<Record<NbaJointStat, number[][]>> = {};
  const requested: Partial<Record<NbaJointStat, JointComponentMoments>> = {};

  for (const s of present) {
    const { mean, variance } = inputs[s]!;
    const cap = inputs.maxCount?.[s] ?? DEFAULT_MAX_COUNT[s];
    maxCount[s] = cap;
    requested[s] = inputs[s]!;
    conditionalPmfs[s] = [];
    // within_s = V_s − μ_s²·τ_eff, floored (the idiosyncratic part). Its mixture
    // expectation over the latent (E[within·m_g]) equals within_s, so the total
    // marginal variance lands at V_s.
    const within = Math.max(WITHIN_VARIANCE_FLOOR, variance - mean * mean * tauEff);
    for (let g = 0; g < latent.multipliers.length; g++) {
      const mG = latent.multipliers[g];
      const condMean = mean * mG;
      // Conditional variance scales with m_g so E[condVar] = within (mean 1 latent).
      const condVar = within * mG;
      const pmf = normalizePmf(negativeBinomialPmf(condMean, condVar, cap), cap);
      conditionalPmfs[s].push(pmf);
    }
  }

  return {
    latent,
    presentStats: present,
    conditionalPmfs,
    requestedMoments: requested,
    maxCount,
  };
}

/** True iff this base stat is present in the (possibly partial) joint. */
export function jointHasStat(dist: NbaJointDistribution, stat: NbaJointStat): boolean {
  return dist.conditionalPmfs[stat] !== undefined;
}

/** Mixture-collapsed marginal PMF for one base stat (Σ_g w_g · conditional_g). Throws if the stat is absent. */
export function marginalPmf(dist: NbaJointDistribution, stat: NbaJointStat): number[] {
  const conds = dist.conditionalPmfs[stat];
  const cap = dist.maxCount[stat];
  if (conds === undefined || cap === undefined) throw new Error(`marginalPmf: stat ${stat} not present in joint`);
  let acc = new Array(cap + 1).fill(0);
  for (let g = 0; g < conds.length; g++) {
    acc = mixPmfInto(acc, conds[g], dist.latent.weights[g]);
  }
  return acc;
}

/**
 * Combo PMF for a set of joint components, READ OFF THE JOINT STATES: for each
 * latent state the components are conditionally independent, so their sum's
 * conditional PMF is the convolution of their conditional PMFs; the combo PMF is
 * the latent-weighted mixture of those conditional convolutions. This is
 * mathematically identical to summing the full joint states by their component
 * total (see materializeComboFromStates, which the tests cross-check against) —
 * and it correctly carries the covariance, unlike convolving separated marginals.
 */
export function comboPmf(dist: NbaJointDistribution, components: readonly NbaJointStat[]): number[] {
  if (components.length === 0) throw new Error("comboPmf: no components");
  for (const c of components) {
    if (dist.conditionalPmfs[c] === undefined) throw new Error(`comboPmf: component ${c} not present in joint`);
  }
  const gCount = dist.latent.multipliers.length;
  let acc: number[] = [];
  for (let g = 0; g < gCount; g++) {
    let conv = dist.conditionalPmfs[components[0]]![g];
    for (let i = 1; i < components.length; i++) {
      conv = convolvePmf(conv, dist.conditionalPmfs[components[i]]![g]);
    }
    acc = mixPmfInto(acc, conv, dist.latent.weights[g]);
  }
  return acc;
}

/**
 * DIRECT joint-state derivation of a combo (reference path, used by tests): for
 * each latent state, form the explicit outer product of the component conditional
 * PMFs and bin every joint state by its component sum, then mix over the latent.
 * Equivalent to comboPmf but constructs the joint states explicitly — proving the
 * combo really is read off joint states rather than from separated marginals.
 */
export function materializeComboFromStates(
  dist: NbaJointDistribution,
  components: readonly NbaJointStat[],
): number[] {
  if (components.length === 0) throw new Error("materializeComboFromStates: no components");
  for (const c of components) {
    if (dist.conditionalPmfs[c] === undefined) throw new Error(`materializeComboFromStates: component ${c} not present`);
  }
  const gCount = dist.latent.multipliers.length;
  const maxSum = components.reduce((acc, s) => acc + (dist.maxCount[s] ?? 0), 0);
  const out = new Array(maxSum + 1).fill(0);
  for (let g = 0; g < gCount; g++) {
    const wG = dist.latent.weights[g];
    // Recursively enumerate the outer product of the component conditionals.
    const enumerate = (idx: number, sum: number, prob: number): void => {
      if (idx === components.length) {
        out[sum] += wG * prob;
        return;
      }
      const pmf = dist.conditionalPmfs[components[idx]]![g];
      for (let k = 0; k < pmf.length; k++) {
        if (pmf[k] === 0) continue;
        enumerate(idx + 1, sum + k, prob * pmf[k]);
      }
    };
    enumerate(0, 0, 1);
  }
  return out;
}

export interface JointMoments {
  means: Partial<Record<NbaJointStat, number>>;
  variances: Partial<Record<NbaJointStat, number>>;
  /** Pairwise covariances keyed "a|b" with a<b alphabetically (present pairs only). */
  covariances: Record<string, number>;
}

function covKey(a: NbaJointStat, b: NbaJointStat): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Moments computed from the joint construction via the law of total
 * variance/covariance (conditional independence ⇒ conditional covariance 0):
 *   Cov(X_s,X_t) = Σ_g w_g·E[X_s|g]·E[X_t|g] − (Σ_g w_g E[X_s|g])(Σ_g w_g E[X_t|g]).
 * Means/variances are taken directly from the mixture-collapsed marginals so they
 * reflect the actual (truncated, overdispersion-lifted) PMFs the engine emits.
 */
export function jointMoments(dist: NbaJointDistribution): JointMoments {
  const means: Partial<Record<NbaJointStat, number>> = {};
  const variances: Partial<Record<NbaJointStat, number>> = {};
  const condMeans: Partial<Record<NbaJointStat, number[]>> = {};
  const present = dist.presentStats;
  for (const s of present) {
    const marg = marginalPmf(dist, s);
    means[s] = meanOfPmf(marg);
    variances[s] = varianceOfPmf(marg);
    condMeans[s] = dist.conditionalPmfs[s]!.map((pmf) => meanOfPmf(pmf));
  }
  const covariances: Record<string, number> = {};
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const a = present[i];
      const b = present[j];
      const w = dist.latent.weights;
      const cmA = condMeans[a]!;
      const cmB = condMeans[b]!;
      let eProduct = 0;
      let eA = 0;
      let eB = 0;
      for (let g = 0; g < w.length; g++) {
        eProduct += w[g] * cmA[g] * cmB[g];
        eA += w[g] * cmA[g];
        eB += w[g] * cmB[g];
      }
      covariances[covKey(a, b)] = eProduct - eA * eB;
    }
  }
  return { means, variances, covariances };
}

/** Validation: every conditional PMF and every marginal is normalized. */
export function jointIsWellFormed(dist: NbaJointDistribution, tol: number = PMF_SUM_TOLERANCE): boolean {
  for (const s of dist.presentStats) {
    for (const pmf of dist.conditionalPmfs[s]!) {
      if (!isNormalized(pmf, tol)) return false;
    }
    if (!isNormalized(marginalPmf(dist, s), tol)) return false;
  }
  const weightSum = dist.latent.weights.reduce((a, b) => a + b, 0);
  return Math.abs(weightSum - 1) <= tol;
}

export { covKey, JOINT_STATS };
