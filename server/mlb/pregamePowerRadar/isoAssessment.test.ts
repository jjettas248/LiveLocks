// Canonical ISO assessment — validity, shrinkage, tiers, elite-eligibility.
//
// Run: npx tsx server/mlb/pregamePowerRadar/isoAssessment.test.ts

import {
  assessIso,
  isoFromCountingStats,
  isoFromRateStats,
  resolveIsoTagDisplay,
  type IsoAssessmentInputs,
} from "./isoAssessment";
import { ISO_STABILIZATION_PA, LEAGUE_PRIOR_ISO } from "./isoAssessmentConfig";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const base = (over: Partial<IsoAssessmentInputs> = {}): IsoAssessmentInputs => ({
  rawIso: 0.25,
  samplePA: 400,
  split: "vs_rhp",
  source: "current_split",
  ...over,
});

// ── Fail-closed validation ──────────────────────────────────────────────────
{
  ok(assessIso(base({ rawIso: null })).tier === "UNAVAILABLE", "null ISO → UNAVAILABLE");
  ok(!assessIso(base({ rawIso: null })).eliteEligible, "null ISO → not elite");
  ok(assessIso(base({ rawIso: NaN })).tier === "UNAVAILABLE", "NaN ISO → UNAVAILABLE");
  ok(assessIso(base({ rawIso: Infinity })).tier === "UNAVAILABLE", "Infinity ISO → UNAVAILABLE");
  ok(assessIso(base({ rawIso: -0.05 })).tier === "UNAVAILABLE", "negative ISO → UNAVAILABLE");
  // Percentage-scale contamination must fail closed, never become elite.
  ok(assessIso(base({ rawIso: 24 })).tier === "UNAVAILABLE", "24 (pct scale) → UNAVAILABLE");
  ok(!assessIso(base({ rawIso: 24 })).eliteEligible, "24 (pct scale) → not elite");
  ok(assessIso(base({ rawIso: 240 })).tier === "UNAVAILABLE", "240 (pct scale) → UNAVAILABLE");
  ok(assessIso(base({ rawIso: 24.0 })).tier === "UNAVAILABLE", "24.0 (pct scale) → UNAVAILABLE");
  // A blank string coerced to 0 upstream is a valid-but-WEAK 0, never elite.
  ok(assessIso(base({ rawIso: 0 })).tier === "WEAK", "0 ISO → WEAK (not elite, not crash)");
  ok(!assessIso(base({ rawIso: 0 })).eliteEligible, "0 ISO → not elite");
  // Sample gating.
  ok(assessIso(base({ samplePA: null })).tier === "UNAVAILABLE", "no sample → UNAVAILABLE");
  ok(assessIso(base({ samplePA: 0 })).tier === "UNAVAILABLE", "zero sample → UNAVAILABLE");
  ok(assessIso(base({ samplePA: -10 })).tier === "UNAVAILABLE", "negative sample → UNAVAILABLE");
}

// ── Formula parity: SLG−AVG == coherent counting stats ─────────────────────
{
  // A hitter: 500 AB, 25 2B, 3 3B, 30 HR, 120 singles.
  const ab = 500, doubles = 25, triples = 3, hr = 30, singles = 120;
  const hits = singles + doubles + triples + hr;
  const avg = hits / ab;
  const totalBases = singles + 2 * doubles + 3 * triples + 4 * hr;
  const slg = totalBases / ab;
  const isoRate = isoFromRateStats(slg, avg);
  const isoCount = isoFromCountingStats({ ab, doubles, triples, homeRuns: hr });
  ok(isoCount != null && Math.abs(isoRate - isoCount) < 1e-9, "SLG−AVG == (2B+2·3B+3·HR)/AB");
  // Mismatched/invalid denominators are rejected, never silently blended.
  ok(isoFromCountingStats({ ab: 0, doubles: 5, triples: 0, homeRuns: 2 }) === null, "AB=0 → null (no divide-by-zero)");
  ok(isoFromCountingStats({ ab: 100, doubles: NaN, triples: 0, homeRuns: 2 }) === null, "NaN count → null");
}

// ── Shrinkage toward the prior ──────────────────────────────────────────────
{
  // Small split regresses toward LEAGUE_PRIOR_ISO; large split stays near raw.
  const small = assessIso(base({ rawIso: 0.30, samplePA: 30 }));
  const large = assessIso(base({ rawIso: 0.30, samplePA: 600 }));
  ok(small.adjustedIso! < large.adjustedIso!, "small sample shrinks further than large");
  ok(small.adjustedIso! > LEAGUE_PRIOR_ISO && small.adjustedIso! < 0.30, "shrunk value sits between prior and raw");
  // At samplePA == stabilization, reliability == 0.5 exactly.
  const atStab = assessIso(base({ rawIso: 0.30, samplePA: ISO_STABILIZATION_PA }));
  ok(Math.abs(atStab.reliability - 0.5) < 1e-9, "reliability = 0.5 at stabilization PA");
  ok(
    Math.abs(atStab.adjustedIso! - (0.5 * 0.30 + 0.5 * LEAGUE_PRIOR_ISO)) < 1e-9,
    "adjustedIso is the exact reliability blend",
  );
}

// ── Tier reachability (all five reachable) ─────────────────────────────────
{
  const elite = assessIso(base({ rawIso: 0.30, samplePA: 500 }));
  ok(elite.tier === "ELITE" && elite.eliteEligible, "legit high-power, reliable → ELITE + eliteEligible");
  // Raw .25 with a full sample shrinks to ≈.222 (between the .20/.24 boundaries).
  const strong = assessIso(base({ rawIso: 0.25, samplePA: 500 }));
  ok(strong.tier === "STRONG", "~.25 raw, reliable → STRONG (after shrinkage)");
  ok(!strong.eliteEligible, "STRONG is not elite-eligible");
  const average = assessIso(base({ rawIso: 0.15, samplePA: 500 }));
  ok(average.tier === "AVERAGE", "~.15 → AVERAGE");
  const weak = assessIso(base({ rawIso: 0.08, samplePA: 500 }));
  ok(weak.tier === "WEAK", "~.08 → WEAK");
  const unavail = assessIso(base({ rawIso: null }));
  ok(unavail.tier === "UNAVAILABLE", "missing → UNAVAILABLE");
}

// ── Fallback / provenance can never be elite ───────────────────────────────
{
  const fallback = assessIso(base({ rawIso: 0.30, samplePA: 500, source: "league_fallback" }));
  ok(!fallback.eliteEligible, "league_fallback source never elite-eligible");
  ok(fallback.reasons.some((r) => r.includes("league_fallback")), "records fallback block reason");
  // Thin sample can never be elite-eligible: shrinkage pulls a huge raw toward
  // the prior AND the explicit sample floor blocks eligibility either way.
  const thin = assessIso(base({ rawIso: 0.45, samplePA: 40 }));
  ok(!thin.eliteEligible, "huge raw ISO on a thin (40 PA) sample → never eliteEligible");
}

// ── Split provenance is not overwritten by overall ─────────────────────────
{
  const overall = assessIso(base({ split: "overall", source: "current_overall", rawIso: 0.30, samplePA: 500 }));
  ok(overall.split === "overall" && overall.source === "current_overall", "overall does not masquerade as a hand split");
}

// ── Display resolution ─────────────────────────────────────────────────────
{
  const elite = resolveIsoTagDisplay(assessIso(base({ rawIso: 0.30, samplePA: 500 })));
  ok(elite.displayEligible && elite.label === "Elite Isolated Power", "ELITE → Elite label, displayEligible");
  const strong = resolveIsoTagDisplay(assessIso(base({ rawIso: 0.25, samplePA: 500 })));
  ok(strong.displayEligible && strong.label === "Strong Isolated Power", "STRONG → Strong label, displayEligible");
  const avg = resolveIsoTagDisplay(assessIso(base({ rawIso: 0.15, samplePA: 500 })));
  ok(!avg.displayEligible, "AVERAGE → no promotional chip (displayEligible false)");
  const missing = resolveIsoTagDisplay(assessIso(base({ rawIso: null })));
  ok(!missing.displayEligible && missing.label === "Isolated Power", "missing → not displayed, non-promotional label");
}

console.log(`\nisoAssessment.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
