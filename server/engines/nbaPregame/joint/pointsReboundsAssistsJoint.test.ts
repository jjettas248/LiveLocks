// Run: npx tsx server/engines/nbaPregame/joint/pointsReboundsAssistsJoint.test.ts
// Pregame Targets PR3 — (pts,reb,ast) joint + marginals: joint sums to 1,
// marginalizing reproduces each component marginal, mean/variance preserved,
// determinism, fail-closed on invalid moments.
import {
  buildNbaJoint,
  marginalPmf,
  materializeComboFromStates,
  jointMoments,
  jointIsWellFormed,
  LATENT_STRENGTH_DEFAULT,
  JOINT_STATS,
  type NbaJointInputs,
} from "./pointsReboundsAssistsJoint";
import { isNormalized, meanOfPmf, varianceOfPmf } from "../math/pmf";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const REALISTIC: NbaJointInputs = {
  points: { mean: 22, variance: 55 },
  rebounds: { mean: 8, variance: 16 },
  assists: { mean: 5.5, variance: 11 },
};

// ── Well-formed: every conditional + marginal normalized; weights sum to 1 ──
{
  const dist = buildNbaJoint(REALISTIC);
  ok(jointIsWellFormed(dist), "joint is well-formed (all PMFs normalized)");
  for (const s of JOINT_STATS) {
    ok(isNormalized(marginalPmf(dist, s)), `${s} marginal sums to 1`);
    ok(dist.conditionalPmfs[s].length === dist.latent.multipliers.length, `${s} has one conditional per latent state`);
  }
  ok(approx(dist.latent.multipliers.reduce((a, m, i) => a + dist.latent.weights[i] * m, 0), 1, 1e-9), "E[latent] = 1 (mean preserved)");
  ok(dist.latent.variance > 0, "latent variance positive");
}

// ── Mean preserved; variance preserved (within overdispersion-lift tolerance) ─
{
  const dist = buildNbaJoint(REALISTIC);
  const m = jointMoments(dist);
  ok(approx(m.means.points, 22, 0.15), "points marginal mean ≈ requested");
  ok(approx(m.means.rebounds, 8, 0.1), "rebounds marginal mean ≈ requested");
  ok(approx(m.means.assists, 5.5, 0.1), "assists marginal mean ≈ requested");
  // Variance lands near requested (small drift from NB overdispersion lift + truncation).
  ok(Math.abs(m.variances.points - 55) < 3, "points marginal variance ≈ requested");
  ok(Math.abs(m.variances.rebounds - 16) < 2, "rebounds marginal variance ≈ requested");
  ok(Math.abs(m.variances.assists - 11) < 2, "assists marginal variance ≈ requested");
}

// ── Marginalizing the explicit joint states reproduces the component marginal ─
{
  // Use small means so the explicit outer-product enumeration is cheap + exact.
  const small = buildNbaJoint({
    points: { mean: 6, variance: 12 },
    rebounds: { mean: 3, variance: 6 },
    assists: { mean: 2, variance: 4 },
    maxCount: { points: 30, rebounds: 20, assists: 16 },
  });
  for (const s of JOINT_STATS) {
    const viaMixture = marginalPmf(small, s);
    const viaStates = materializeComboFromStates(small, [s]); // single-component "combo" = marginal
    // Compare over the shared prefix.
    let maxDiff = 0;
    for (let k = 0; k < Math.min(viaMixture.length, viaStates.length); k++) {
      maxDiff = Math.max(maxDiff, Math.abs(viaMixture[k] - viaStates[k]));
    }
    ok(maxDiff < 1e-9, `${s}: marginalizing joint states reproduces the component marginal`);
  }
}

// ── Determinism: identical inputs → byte-identical distribution ─────────────
{
  const a = buildNbaJoint(REALISTIC);
  const b = buildNbaJoint(REALISTIC);
  ok(JSON.stringify(a.conditionalPmfs) === JSON.stringify(b.conditionalPmfs), "conditional PMFs deterministic");
  ok(JSON.stringify(a.latent) === JSON.stringify(b.latent), "latent grid deterministic");
}

// ── Latent strength defaults + is clamped so within-variance stays positive ──
{
  ok(LATENT_STRENGTH_DEFAULT > 0 && LATENT_STRENGTH_DEFAULT < 0.1, "default latent strength is a small positive");
  // A tiny-variance stat forces τ_eff below the target (within-variance floor).
  const tight = buildNbaJoint({
    points: { mean: 30, variance: 31 }, // very low relative variance
    rebounds: { mean: 8, variance: 16 },
    assists: { mean: 5, variance: 10 },
    latentStrength: 0.05,
  });
  // (variance - floor)/mean^2 for points = (31-0.5)/900 ≈ 0.0339 < 0.05 target.
  ok(tight.latent.variance < 0.05, "latent strength reduced to keep within-variance positive");
  ok(jointIsWellFormed(tight), "tight-variance joint still well-formed");
}

// ── Fail-closed: pure core throws on invalid moments ────────────────────────
{
  ok(throws(() => buildNbaJoint({ ...REALISTIC, points: { mean: NaN, variance: 10 } })), "throws on non-finite mean");
  ok(throws(() => buildNbaJoint({ ...REALISTIC, rebounds: { mean: -1, variance: 5 } })), "throws on negative mean");
  ok(throws(() => buildNbaJoint({ ...REALISTIC, assists: { mean: 5, variance: 0 } })), "throws on non-positive variance");
}

console.log(`\npointsReboundsAssistsJoint.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
