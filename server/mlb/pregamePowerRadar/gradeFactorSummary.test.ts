// Pre-Game Power Radar — "Grade Factors" summary invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/gradeFactorSummary.test.ts

import { composePregameScore, type ScoringComponents, type ScoringFlags } from "./scoring";
import { buildGradeFactorSummary, computeRealizedImpacts, type GradeFactorComponentInput } from "./gradeFactorSummary";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) <= eps; }

const fullFlags: ScoringFlags = {
  batterPowerAvailable: true,
  pitcherProfileAvailable: true,
  confirmedLineup: true,
  parkAvailable: true,
  weatherAvailable: true,
  bvpAvailable: false,
  parkIsOnlyPositiveDriver: false,
  positiveDriverCount: 3,
};

function components(overrides: Partial<Record<GradeFactorComponentInput["key"], { score: number; available: boolean }>> = {}): GradeFactorComponentInput[] {
  const defaults: Record<GradeFactorComponentInput["key"], { label: string; score: number; available: boolean }> = {
    batterPower: { label: "Batter Power", score: 6, available: true },
    pitcherVulnerability: { label: "Pitcher Vulnerability", score: 6, available: true },
    matchupFit: { label: "Matchup Fit", score: 6, available: true },
    parkWeather: { label: "Park & Weather", score: 6, available: true },
    lineupOpportunity: { label: "Lineup Opportunity", score: 6, available: true },
    nearHrRecentForm: { label: "Near-HR Recent Form", score: 6, available: true },
  };
  return (Object.keys(defaults) as GradeFactorComponentInput["key"][]).map((key) => ({
    key,
    label: defaults[key].label,
    score: overrides[key]?.score ?? defaults[key].score,
    available: overrides[key]?.available ?? defaults[key].available,
  }));
}

// ── (1) Double-counting regression: cap binds AND matchupPenalty > 0 at once ─
// pitcherProfileAvailable=false → cap=5.9; pitcherVulnerabilityScore < 5 → matchupPenalty > 0.
const dblComps: ScoringComponents = {
  batterPowerScore: 9.0, pitcherVulnerabilityScore: 3.0, matchupFitScore: 8.0,
  parkWeatherScore: 8.0, lineupOpportunityScore: 8.0, nearHrRecentFormScore: 8.0, bvpModifier: 0.3,
};
const dblFlags: ScoringFlags = { ...fullFlags, pitcherProfileAvailable: false };
const dblResult = composePregameScore(dblComps, dblFlags);
ok(dblResult.finalScoreCap === 5.9, `sanity: cap established (got ${dblResult.finalScoreCap})`);
ok(dblResult.matchupPenalty > 0, `sanity: matchupPenalty > 0 (got ${dblResult.matchupPenalty})`);
const dblImpacts = computeRealizedImpacts({
  baseScore: dblResult.baseScore,
  finalScoreBeforeCaps: dblResult.finalScoreBeforeCaps,
  finalScoreCap: dblResult.finalScoreCap,
  score10: dblResult.score10,
});
ok(
  approx(dblImpacts.coverageCapImpact + dblImpacts.matchupImpact, dblResult.score10 - dblResult.finalScoreBeforeCaps, 1e-9),
  `coverageCapImpact + matchupImpact must equal score10 - finalScoreBeforeCaps exactly, no double-count (got ${dblImpacts.coverageCapImpact} + ${dblImpacts.matchupImpact} vs ${dblResult.score10 - dblResult.finalScoreBeforeCaps})`,
);

// ── (2) finalScoreCap defined but NOT binding → coverageCapImpact must be 0 ──
// pitcherProfileAvailable=false alone establishes cap=5.9, but a low base score
// keeps bvpAdjustedScore well beneath it — the cap is present, never bites.
const noBiteComps: ScoringComponents = {
  batterPowerScore: 2, pitcherVulnerabilityScore: 2, matchupFitScore: 2,
  parkWeatherScore: 2, lineupOpportunityScore: 2, nearHrRecentFormScore: 2, bvpModifier: 0,
};
const noBiteResult = composePregameScore(noBiteComps, { ...fullFlags, pitcherProfileAvailable: false });
ok(noBiteResult.finalScoreCap === 5.9, `sanity: finalScoreCap still defined (got ${noBiteResult.finalScoreCap})`);
const noBiteImpacts = computeRealizedImpacts({
  baseScore: noBiteResult.baseScore,
  finalScoreBeforeCaps: noBiteResult.finalScoreBeforeCaps,
  finalScoreCap: noBiteResult.finalScoreCap,
  score10: noBiteResult.score10,
});
ok(noBiteImpacts.coverageCapImpact === 0, `finalScoreCap being defined must NOT imply the cap bound (got coverageCapImpact=${noBiteImpacts.coverageCapImpact})`);

// ── (3) Legacy-absence: Pitcher Vulnerability unavailable → null, never fabricated ─
const unavailablePv = buildGradeFactorSummary({
  components: components({ pitcherVulnerability: { score: 5, available: false } }),
  bvpModifier: 0, bvpAvailable: false,
  baseScore: 6, finalScoreBeforeCaps: 6, finalScoreCap: undefined, matchupPenalty: 0, score10: 6,
});
ok(unavailablePv === null, "Pitcher Vulnerability unavailable → summary is null, never fabricated");

// ── (4) Always includes Pitcher Vulnerability; picks top 2 by |impact| ──────
const summary = buildGradeFactorSummary({
  components: components({
    pitcherVulnerability: { score: 10, available: true }, // weight 0.23, impact = 0.23*5 = 1.15
    batterPower: { score: 5.2, available: true },          // weight 0.28, impact = 0.28*0.2 = 0.056 (small — near neutral despite high weight)
    lineupOpportunity: { score: 10, available: true },     // weight 0.09, impact = 0.09*5 = 0.45
    nearHrRecentForm: { score: 9.5, available: true },     // weight 0.08, impact = 0.08*4.5 = 0.36
    matchupFit: { score: 5, available: true },              // impact 0
    parkWeather: { score: 5, available: true },             // impact 0
  }),
  bvpModifier: 0, bvpAvailable: false,
  baseScore: 7, finalScoreBeforeCaps: 7, finalScoreCap: undefined, matchupPenalty: 0, score10: 7,
});
ok(summary !== null && summary.length === 3, `expected exactly 3 entries (got ${summary?.length})`);
ok(summary![0].key === "pitcherVulnerability", "Pitcher Vulnerability is always first/always included");
const keys = summary!.map((f) => f.key);
ok(keys.includes("lineupOpportunity") && keys.includes("nearHrRecentForm"), `top-2 by |impact| should be lineupOpportunity + nearHrRecentForm, NOT high-weight-but-near-neutral batterPower (got ${keys.join(",")})`);
ok(!keys.includes("batterPower"), "high weight alone (batterPower) must not outrank a smaller-weight but materially impactful factor");

// ── (5) Compact presentation: translate model diagnostics into user meaning
//     and give each concept its own semantic color. The numeric values remain
//     present for expanded/debug detail, but are not the compact-card wording. ─
const readable = buildGradeFactorSummary({
  components: components({
    pitcherVulnerability: { score: 8.3, available: true },
    batterPower: { score: 8.5, available: true },
    matchupFit: { score: 7.6, available: true },
    parkWeather: { score: 5, available: true },
    lineupOpportunity: { score: 5, available: true },
    nearHrRecentForm: { score: 5, available: true },
  }),
  bvpModifier: 0, bvpAvailable: false,
  baseScore: 7.7, finalScoreBeforeCaps: 7.7, finalScoreCap: undefined, matchupPenalty: 0, score10: 7.7,
})!;
const readablePv = readable.find((f) => f.key === "pitcherVulnerability")!;
const readablePower = readable.find((f) => f.key === "batterPower")!;
const readableMatchup = readable.find((f) => f.key === "matchupFit")!;
ok(readablePv.displayLabel === "High" && readablePv.tone === "attack" && readablePv.value === 8.3,
  `8.3 Pitcher Vulnerability should render High/attack while preserving raw value (got ${JSON.stringify(readablePv)})`);
ok(readablePower.displayLabel === "Elite" && readablePower.tone === "standout" && readablePower.value === 8.5,
  `8.5 Batter Power should render Elite/standout while preserving raw value (got ${JSON.stringify(readablePower)})`);
ok(readableMatchup.displayLabel === "Favorable" && readableMatchup.tone === "context" && readableMatchup.value === 7.6,
  `7.6 Matchup Fit should render Favorable/context while preserving raw value (got ${JSON.stringify(readableMatchup)})`);

// ── (6) Tone/direction: a stingy (low-vulnerability) pitcher must render
//     negative, never hardcoded positive — Pitcher Vulnerability follows the
//     SAME risk rule as every other entry. ───────────────────────────────────
const stingy = buildGradeFactorSummary({
  components: components({ pitcherVulnerability: { score: 1.0, available: true } }), // impact = 0.23*(1-5) = -0.92 → negative
  bvpModifier: 0, bvpAvailable: false,
  baseScore: 5, finalScoreBeforeCaps: 5, finalScoreCap: undefined, matchupPenalty: 0, score10: 5,
});
const pvEntry = stingy!.find((f) => f.key === "pitcherVulnerability")!;
ok(pvEntry.direction === "negative", `a stingy/low-vulnerability pitcher must render "negative" (rose), not a hardcoded attack tone (got ${pvEntry.direction})`);
ok(pvEntry.displayLabel === "Very Low" && pvEntry.tone === "risk",
  `a stingy pitcher should read Very Low with risk tone (got ${pvEntry.displayLabel}/${pvEntry.tone})`);

// ── (7) Neutral epsilon band ────────────────────────────────────────────────
const neutralPv = buildGradeFactorSummary({
  components: components({ pitcherVulnerability: { score: 5.05, available: true } }), // impact = 0.23*0.05 ≈ 0.0115 → within epsilon
  bvpModifier: 0, bvpAvailable: false,
  baseScore: 5, finalScoreBeforeCaps: 5, finalScoreCap: undefined, matchupPenalty: 0, score10: 5,
});
ok(neutralPv!.find((f) => f.key === "pitcherVulnerability")!.direction === "neutral", "near-zero impact classifies as neutral (gray), not positive or negative");
ok(neutralPv!.find((f) => f.key === "pitcherVulnerability")!.tone === "neutral", "near-zero impact receives neutral semantic tone");

const neutralWording = buildGradeFactorSummary({
  components: components({
    pitcherVulnerability: { score: 5.5, available: true },
    batterPower: { score: 5.5, available: true },
  }),
  bvpModifier: 0, bvpAvailable: false,
  baseScore: 5.5, finalScoreBeforeCaps: 5.5, finalScoreCap: undefined, matchupPenalty: 0, score10: 5.5,
})!;
ok(neutralWording.find((f) => f.key === "pitcherVulnerability")?.displayLabel === "Neutral" &&
   neutralWording.find((f) => f.key === "pitcherVulnerability")?.tone === "neutral",
  "neutral wording never receives a favorable attack color even when its small weighted impact exceeds epsilon");

console.log(`\ngradeFactorSummary.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
