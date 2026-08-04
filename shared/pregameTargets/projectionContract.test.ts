// Run: npx tsx shared/pregameTargets/projectionContract.test.ts
import {
  type BlindProjection,
  CONFIDENCE_MARGIN_PP_BOUND,
  FORBIDDEN_PROJECTION_KEYS,
  checkProjectionBlindness,
  confidenceMarginPp,
  isBlindProjection,
} from "./projectionContract";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

function blind(over: Partial<BlindProjection> = {}): BlindProjection {
  const probability = over.probability ?? 0.62;
  return {
    sport: "nba",
    side: "over",
    probability,
    confidenceMarginPp: confidenceMarginPp(probability),
    projection: 24.5,
    modelVersion: "nba_court_v0",
    contractVersion: "projection_blind_v1",
    ...over,
  };
}

// ── confidenceMarginPp = 100 × (p − 0.5), in [-50, +50] ──────────────────────
{
  ok(approx(confidenceMarginPp(0.5), 0), "p=0.5 → margin 0 (no confidence either way)");
  ok(approx(confidenceMarginPp(1), 50), "p=1 → +50 (upper bound)");
  ok(approx(confidenceMarginPp(0), -50), "p=0 → -50 (lower bound)");
  ok(approx(confidenceMarginPp(0.62), 12), "p=0.62 → +12 pp");
  ok(Math.abs(confidenceMarginPp(0.9)) <= CONFIDENCE_MARGIN_PP_BOUND, "margin within the ±50 bound");
  // Out-of-range clamps to the unit interval before the transform.
  ok(approx(confidenceMarginPp(1.4), 50), "p>1 clamps to 1 → +50");
  ok(approx(confidenceMarginPp(-0.3), -50), "p<0 clamps to 0 → -50");
  // Non-finite fails safe to 0 (neutral), never NaN.
  ok(confidenceMarginPp(NaN) === 0, "NaN probability → margin 0 (fail-safe)");
  ok(confidenceMarginPp(Infinity) === 0, "Infinity probability → margin 0 (fail-safe)");
}

// ── NOT EV: margin is independent of any price / odds ────────────────────────
{
  // Two projections with the same probability have the SAME margin regardless
  // of any line or odds one might attach downstream — the margin is a pure
  // transform of the projection's own probability, never an edge/EV.
  const a = confidenceMarginPp(0.58);
  const b = confidenceMarginPp(0.58);
  ok(a === b, "same probability → identical margin (price-independent, not EV)");
}

// ── Over/Under complement coherence (§8A.3) ──────────────────────────────────
{
  const p = 0.62;
  const over = confidenceMarginPp(p);
  const under = confidenceMarginPp(1 - p);
  ok(approx(under, -over), "confidenceMarginPp(1−p) = −confidenceMarginPp(p) (complement coherence)");
}

// ── Blindness guard: no price/EV field may appear on a projection ────────────
{
  ok(isBlindProjection(blind() as unknown as Record<string, unknown>), "a well-formed blind projection passes");
  // Every forbidden key is individually rejected.
  for (const key of FORBIDDEN_PROJECTION_KEYS) {
    const tainted = { ...blind(), [key]: 1 } as unknown as Record<string, unknown>;
    const v = checkProjectionBlindness(tainted);
    ok(v.includes("carries_price_or_ev_field"), `a projection carrying "${key}" is rejected (price/EV leak)`);
  }
  // A real edge/EV smuggling attempt trips it.
  ok(!isBlindProjection({ ...blind(), edgeGap: 3.2 } as unknown as Record<string, unknown>), "edgeGap present → not blind");
  ok(!isBlindProjection({ ...blind(), americanOdds: -120 } as unknown as Record<string, unknown>), "americanOdds present → not blind");
}

// ── Probability + margin integrity ───────────────────────────────────────────
{
  ok(checkProjectionBlindness({ ...blind({ probability: 1.5 }) } as unknown as Record<string, unknown>).includes("probability_not_in_unit_interval"), "probability outside [0,1] is rejected");
  ok(checkProjectionBlindness({ ...blind(), probability: NaN } as unknown as Record<string, unknown>).includes("probability_not_in_unit_interval"), "NaN probability is rejected");
  // A margin that does NOT equal 100×(p−0.5) is rejected — nothing can smuggle an
  // independent EV/edge value in under the "margin" label.
  const inconsistent = { ...blind({ probability: 0.6 }), confidenceMarginPp: 30 } as unknown as Record<string, unknown>;
  ok(checkProjectionBlindness(inconsistent).includes("margin_inconsistent"), "a margin != 100×(p−0.5) is rejected (no EV under a margin label)");
  ok(checkProjectionBlindness(blind() as unknown as Record<string, unknown>).length === 0, "the canonical blind projection has zero violations");
}

console.log(`\nprojectionContract.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
