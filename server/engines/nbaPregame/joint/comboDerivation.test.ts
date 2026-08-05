// Run: npx tsx server/engines/nbaPregame/joint/comboDerivation.test.ts
// Pregame Targets PR3 — combo derivation + covariance conservation: combos read
// off joint states (== explicit joint-state summation, != separated-marginal
// convolution); combo mean = Σ component means; combo variance includes
// covariance; covariance is POSITIVE and its magnitude tracks the latent variance.
import {
  buildNbaJoint,
  comboPmf,
  materializeComboFromStates,
  marginalPmf,
  jointMoments,
  covKey,
  type NbaJointInputs,
} from "./pointsReboundsAssistsJoint";
import { NBA_COMBO_COMPONENTS } from "../markets";
import { convolvePmf, meanOfPmf, varianceOfPmf, isNormalized } from "../math/pmf";

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

const INPUTS: NbaJointInputs = {
  points: { mean: 20, variance: 50 },
  rebounds: { mean: 9, variance: 18 },
  assists: { mean: 6, variance: 12 },
};

// ── Combo PMF (efficient path) == explicit joint-state summation ────────────
{
  const dist = buildNbaJoint({ ...INPUTS, maxCount: { points: 40, rebounds: 24, assists: 18 } });
  for (const [key, comps] of Object.entries(NBA_COMBO_COMPONENTS)) {
    const viaCombo = comboPmf(dist, comps);
    const viaStates = materializeComboFromStates(dist, comps);
    let maxDiff = 0;
    for (let k = 0; k < Math.min(viaCombo.length, viaStates.length); k++) {
      maxDiff = Math.max(maxDiff, Math.abs(viaCombo[k] - viaStates[k]));
    }
    ok(maxDiff < 1e-9, `${key}: comboPmf == explicit joint-state summation`);
    ok(isNormalized(viaCombo, 1e-6), `${key}: combo PMF normalized`);
  }
}

// ── Combo mean = sum of component means ─────────────────────────────────────
{
  const dist = buildNbaJoint(INPUTS);
  const m = jointMoments(dist);
  for (const [key, comps] of Object.entries(NBA_COMBO_COMPONENTS)) {
    const combo = comboPmf(dist, comps);
    const expectedMean = comps.reduce((acc, s) => acc + m.means[s], 0);
    ok(approx(meanOfPmf(combo), expectedMean, 1e-6), `${key}: combo mean = Σ component means`);
  }
}

// ── Combo variance INCLUDES covariance (Var(ΣX) = ΣV + 2ΣCov) ───────────────
{
  const dist = buildNbaJoint(INPUTS);
  const m = jointMoments(dist);
  for (const [key, comps] of Object.entries(NBA_COMBO_COMPONENTS)) {
    const combo = comboPmf(dist, comps);
    let expectedVar = 0;
    for (const s of comps) expectedVar += m.variances[s];
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        expectedVar += 2 * m.covariances[covKey(comps[i], comps[j])];
      }
    }
    ok(approx(varianceOfPmf(combo), expectedVar, 1e-4), `${key}: combo variance = ΣV + 2ΣCov`);
  }
}

// ── Covariance is POSITIVE for every pair (shared latent induces dependence) ─
{
  const dist = buildNbaJoint(INPUTS);
  const m = jointMoments(dist);
  ok(m.covariances[covKey("points", "rebounds")] > 0, "Cov(points,rebounds) > 0");
  ok(m.covariances[covKey("points", "assists")] > 0, "Cov(points,assists) > 0");
  ok(m.covariances[covKey("rebounds", "assists")] > 0, "Cov(rebounds,assists) > 0");
}

// ── Combo variance from the joint EXCEEDS the independent (separated) case ───
{
  const dist = buildNbaJoint(INPUTS);
  // Independent path: convolve the mixture-collapsed MARGINALS (wrong for combos —
  // discards covariance). Its variance = ΣV, strictly less than the joint's.
  const pts = marginalPmf(dist, "points");
  const reb = marginalPmf(dist, "rebounds");
  const independentSum = convolvePmf(pts, reb);
  const jointCombo = comboPmf(dist, ["points", "rebounds"]);
  ok(
    varianceOfPmf(jointCombo) > varianceOfPmf(independentSum) + 1e-6,
    "joint combo variance > independent-convolution variance (covariance matters)",
  );
  // Both must share the same mean (covariance shifts spread, not center).
  ok(approx(meanOfPmf(jointCombo), meanOfPmf(independentSum), 1e-6), "joint and independent combos share the mean");
}

// ── Covariance MAGNITUDE tracks the latent variance (stronger τ ⇒ larger cov) ─
{
  const weak = buildNbaJoint({ ...INPUTS, latentStrength: 0.005 });
  const strong = buildNbaJoint({ ...INPUTS, latentStrength: 0.03 });
  const covWeak = jointMoments(weak).covariances[covKey("points", "rebounds")];
  const covStrong = jointMoments(strong).covariances[covKey("points", "rebounds")];
  ok(covStrong > covWeak, "larger latent strength ⇒ larger positive covariance");
  ok(strong.latent.variance > weak.latent.variance, "realized latent variance ordered by strength");
  // Combo tail spread grows with the shared factor too.
  const varWeak = varianceOfPmf(comboPmf(weak, ["points", "rebounds", "assists"]));
  const varStrong = varianceOfPmf(comboPmf(strong, ["points", "rebounds", "assists"]));
  ok(varStrong > varWeak, "PRA combo variance grows with latent strength");
}

console.log(`\ncomboDerivation.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
