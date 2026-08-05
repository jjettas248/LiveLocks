// MLB Odds Probability (no-vig, strict pairing) — invariants.
//
// Run: npx tsx server/mlb/oddsProbability.test.ts

import {
  americanToImpliedPct,
  noVigTwoWay,
  modelEdgePctPoints,
  noVigForSide,
  isValidAmericanOdds,
  MLB_EDGE_VERSION,
  type PairedTwoSidedQuote,
} from "./oddsProbability";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

// American → implied
{
  ok(approx(americanToImpliedPct(-110), 52.380952, 1e-4), "-110 implied ~52.38%");
  ok(approx(americanToImpliedPct(100), 50), "+100 implied 50%");
  ok(approx(americanToImpliedPct(-200), 66.666666, 1e-4), "-200 implied ~66.67%");
  ok(isValidAmericanOdds(-110) && isValidAmericanOdds(120), "valid odds accepted");
  ok(!isValidAmericanOdds(50) && !isValidAmericanOdds(0) && !isValidAmericanOdds(NaN), "invalid odds rejected");
}

const fresh = (over: number | null, under: number | null): PairedTwoSidedQuote => ({
  book: "draftkings",
  line: 1.5,
  overOdds: over,
  underOdds: under,
  sourceTimestamp: 1_700_000_000_000,
  ageMs: 5_000, // 5s — fresh for live (30s TTL)
});

// -110/-110 → 50/50 no-vig
{
  const r = noVigTwoWay(fresh(-110, -110), "live");
  ok(r.ok === true, "-110/-110 pair de-vigs");
  if (r.ok) {
    ok(approx(r.result.pOverNoVig, 50, 1e-6), "over no-vig 50%");
    ok(approx(r.result.pUnderNoVig, 50, 1e-6), "under no-vig 50%");
    ok(approx(r.result.pOverNoVig + r.result.pUnderNoVig, 100, 1e-6), "no-vig sums to 100");
    ok(r.result.edgeVersion === MLB_EDGE_VERSION, "stamps edge version");
  }
}

// Asymmetric prices normalize and sum to 100
{
  const r = noVigTwoWay(fresh(-150, 130), "live");
  ok(r.ok === true, "asymmetric pair de-vigs");
  if (r.ok) {
    ok(approx(r.result.pOverNoVig + r.result.pUnderNoVig, 100, 1e-6), "asymmetric no-vig sums to 100");
    ok(r.result.pOverNoVig > r.result.pUnderNoVig, "favored side higher no-vig");
    ok(r.result.pOverNoVig < r.result.pOverRawImplied, "no-vig strips vig below raw implied");
  }
}

// One-sided quote → unavailable → non-actionable
{
  const rOver = noVigTwoWay(fresh(-110, null), "live");
  ok(rOver.ok === false && rOver.reason === "missing_under_odds", "one-sided (no under) unavailable");
  const rUnder = noVigTwoWay(fresh(null, -110), "live");
  ok(rUnder.ok === false && rUnder.reason === "missing_over_odds", "one-sided (no over) unavailable");
}

// Stale observation → unavailable
{
  const stale: PairedTwoSidedQuote = { ...fresh(-110, -110), ageMs: 60_000 }; // 60s > 30s live TTL
  const r = noVigTwoWay(stale, "live");
  ok(r.ok === false && r.reason === "stale_observation", "stale live quote unavailable");
  // unknown status can never be confirmed fresh
  const rUnknown = noVigTwoWay(fresh(-110, -110), "unknown");
  ok(rUnknown.ok === false && rUnknown.reason === "stale_observation", "unknown status never fresh");
  // final is immutable → always fresh
  const rFinal = noVigTwoWay({ ...fresh(-110, -110), ageMs: 10_000_000 }, "final");
  ok(rFinal.ok === true, "final status always fresh");
}

// Missing book / line / source timestamp
{
  ok(noVigTwoWay({ ...fresh(-110, -110), book: null }, "live").ok === false, "missing book unavailable");
  ok(noVigTwoWay({ ...fresh(-110, -110), line: null }, "live").ok === false, "missing line unavailable");
  ok(noVigTwoWay({ ...fresh(-110, -110), sourceTimestamp: null }, "live").ok === false, "missing source ts unavailable");
}

// Edge = candidate probability − no-vig side probability (percentage points)
{
  const r = noVigTwoWay(fresh(-110, -110), "live");
  if (r.ok) {
    const noVigOver = noVigForSide(r.result, "OVER"); // 50
    ok(modelEdgePctPoints(58, noVigOver) === 8, "edge = 58 − 50 = 8pp");
    ok(modelEdgePctPoints(45, noVigOver) === -5, "negative edge = 45 − 50 = -5pp");
  }
  ok(modelEdgePctPoints(null, 50) === null, "null candidate → edge null");
  ok(modelEdgePctPoints(58, null) === null, "null no-vig → edge null (never 0)");
}

console.log(`\noddsProbability.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
