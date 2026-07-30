// Mound V2 versioned decision policy — invariants (Final Pre-Push Integrity
// Pass). Pure — no database, no network.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2DecisionPolicy.test.ts

import {
  applyMoundV2DecisionPolicy,
  MOUND_V2_DEFAULT_DECISION_POLICIES,
  MOUND_V2_DECISION_POLICY_VERSION,
  type MoundV2DecisionPolicy,
  type MoundV2DecisionPolicyInput,
} from "./moundV2DecisionPolicy";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = new Date("2026-07-30T20:00:00.000Z");
const K_POLICY = MOUND_V2_DEFAULT_DECISION_POLICIES.pitcher_strikeouts;

function baseInput(overrides: Partial<MoundV2DecisionPolicyInput> = {}): MoundV2DecisionPolicyInput {
  return {
    overProbability: 0.62,
    underProbability: 0.35,
    pushProbability: 0.03,
    dataQuality: "complete",
    lineupStatus: "confirmed",
    overPrice: -120,
    underPrice: 100,
    sportsbook: "draftkings",
    oddsFetchedAt: "2026-07-30T19:58:00.000Z",
    now: NOW,
    ...overrides,
  };
}

// ── Every default policy declares a real version ────────────────────────────
{
  ok(K_POLICY.policyVersion === MOUND_V2_DECISION_POLICY_VERSION, "the strikeouts policy carries the module's declared version string");
  ok(MOUND_V2_DEFAULT_DECISION_POLICIES.pitcher_outs.policyVersion === MOUND_V2_DECISION_POLICY_VERSION, "the outs policy carries the same version string (both markets share one policy generation today)");
}

// ── A clear, well-qualified OVER recommendation ─────────────────────────────
{
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput());
  ok(result.qualified === true && result.side === "OVER" && result.reason === "qualified", `a real edge with good provenance qualifies as OVER (got ${JSON.stringify(result)})`);
  ok(result.qualifyingProbability === 0.62, "qualifyingProbability reports the qualifying side's own probability");
  ok(result.policyVersion === K_POLICY.policyVersion, "the result carries the exact policy version that produced it");
}

// ── A clear UNDER recommendation ────────────────────────────────────────────
{
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ overProbability: 0.30, underProbability: 0.67, pushProbability: 0.03 }));
  ok(result.qualified === true && result.side === "UNDER", `a real UNDER edge qualifies (got ${JSON.stringify(result)})`);
}

// ── Below minimum probability -> explicit abstention, never a forced side ───
{
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ overProbability: 0.52, underProbability: 0.45, pushProbability: 0.03 }));
  ok(result.side === null && result.qualified === false && result.reason === "below_minimum_probability", `neither side clears 0.55 -> explicit abstention, never a forced pick (got ${JSON.stringify(result)})`);
}

// ── Above minimum probability but below minimum advantage -> abstain ───────
{
  // Both comfortably above 0.55, but the margin between them is only 0.02 < minimumModelAdvantage (0.03).
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ overProbability: 0.56, underProbability: 0.54, pushProbability: -0.10 }));
  ok(result.side === null && result.reason === "below_minimum_advantage", `a real but too-thin edge abstains distinctly from below_minimum_probability (got ${JSON.stringify(result)})`);
}

// ── Never forces a side when the model is genuinely uncertain ──────────────
{
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ overProbability: 0.50, underProbability: 0.47, pushProbability: 0.03 }));
  ok(result.side === null, "V2 is never forced to recommend a side on every snapshot — this is the core fix vs. 'V2's implied side'");
}

// ── Missing price -> abstain, never fabricated ──────────────────────────────
{
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ overPrice: null }));
  ok(result.side === null && result.reason === "missing_price", `a qualifying side with no real price to grade against abstains (got ${JSON.stringify(result)})`);
}
{
  // The OTHER side's price being present doesn't rescue a qualifying side whose OWN price is missing.
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ overProbability: 0.30, underProbability: 0.67, pushProbability: 0.03, underPrice: null, overPrice: -110 }));
  ok(result.side === null && result.reason === "missing_price", "the qualifying side's OWN price must be present — the other side's price is irrelevant");
}

// ── Missing provenance (no sportsbook or no fetch timestamp) -> abstain ─────
{
  const noBook = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ sportsbook: null }));
  ok(noBook.side === null && noBook.reason === "missing_provenance", "a missing sportsbook abstains — a price with no attributable source is never graded");
  const noTimestamp = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ oddsFetchedAt: null }));
  ok(noTimestamp.side === null && noTimestamp.reason === "missing_provenance", "a missing fetch timestamp abstains too");
}

// ── Stale odds -> abstain ───────────────────────────────────────────────────
{
  const stale = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ oddsFetchedAt: "2026-07-30T10:00:00.000Z" })); // 10h before `now`, policy allows 6h
  ok(stale.side === null && stale.reason === "odds_too_stale", `a price older than maximumOddsAgeMs abstains (got ${JSON.stringify(stale)})`);
  const fresh = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ oddsFetchedAt: "2026-07-30T15:00:00.000Z" })); // 5h before `now`, within the 6h window
  ok(fresh.qualified === true, "a price within the allowed age window still qualifies");
}

// ── Data-quality / lineup-status gates ──────────────────────────────────────
{
  const degraded = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ dataQuality: "degraded" }));
  ok(degraded.side === null && degraded.reason === "data_quality_not_allowed", "a disallowed data-quality state abstains regardless of how strong the probability edge is");
  const unconfirmed = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ lineupStatus: "unconfirmed" }));
  ok(unconfirmed.side === null && unconfirmed.reason === "lineup_status_not_allowed", "a disallowed lineup status abstains too");
}

// ── A policy with no minimumModelAdvantage only enforces the probability floor ──
{
  const looser: MoundV2DecisionPolicy = { ...K_POLICY, minimumModelAdvantage: undefined };
  const result = applyMoundV2DecisionPolicy(looser, baseInput({ overProbability: 0.56, underProbability: 0.54, pushProbability: -0.10 }));
  ok(result.qualified === true && result.side === "OVER", "omitting minimumModelAdvantage allows a thin-margin qualification purely on the probability floor");
}

// ── Every gate is checked in a stable, sensible precedence (data quality first) ──
{
  // Both a bad data quality AND a missing price -- data quality should be caught first (checked before probability/price logic even runs).
  const result = applyMoundV2DecisionPolicy(K_POLICY, baseInput({ dataQuality: "degraded", overPrice: null }));
  ok(result.reason === "data_quality_not_allowed", "data-quality is gated before price/provenance checks even run");
}

console.log(`\nmoundV2DecisionPolicy.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
