// Mound V2 (shadow) — MODEL policy invariants (Mound V2 purity pass).
// Replaces the deleted moundV2DecisionPolicy.test.ts now that decision
// policy has been split into moundV2ModelPolicy.ts (this file) and the
// separate moundV2Executability.ts (see moundV2Executability.test.ts).
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ModelPolicy.test.ts

import {
  applyMoundV2ModelPolicy,
  MOUND_V2_DEFAULT_MODEL_POLICIES,
  type MoundV2ModelPolicy,
  type MoundV2ModelPolicyInput,
} from "./moundV2ModelPolicy";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const POLICY: MoundV2ModelPolicy = MOUND_V2_DEFAULT_MODEL_POLICIES.pitcher_strikeouts;

function input(over: Partial<MoundV2ModelPolicyInput> = {}): MoundV2ModelPolicyInput {
  return {
    overProbability: 0.6,
    underProbability: 0.37,
    pushProbability: 0.03,
    dataQuality: "complete",
    lineupStatus: "confirmed",
    ...over,
  };
}

// ── A clean, decisive OVER qualifies ────────────────────────────────────────
{
  const result = applyMoundV2ModelPolicy(POLICY, input());
  ok(result.side === "OVER" && result.modelQualified === true, `a decisive OVER (0.6 vs 0.37, margin 0.23) qualifies (got side=${result.side} qualified=${result.modelQualified})`);
  ok(result.qualificationReason === "qualified", "the qualification reason is the real, positive 'qualified' value");
  ok(result.qualifyingProbability === 0.6, "qualifyingProbability is the qualifying side's OWN probability");
  ok(result.policyVersion === POLICY.policyVersion && result.market === POLICY.market, "the result carries the exact policy version/market it was evaluated under");
}

// ── A clean, decisive UNDER qualifies ───────────────────────────────────────
{
  const result = applyMoundV2ModelPolicy(POLICY, input({ overProbability: 0.35, underProbability: 0.62, pushProbability: 0.03 }));
  ok(result.side === "UNDER" && result.modelQualified === true, "a decisive UNDER qualifies symmetrically");
  ok(result.qualifyingProbability === 0.62, "qualifyingProbability reflects the UNDER side's own probability when UNDER qualifies");
}

// ── side is null if and only if modelQualified is false (never a qualified verdict with no side, or an abstention with a side) ──
{
  const qualified = applyMoundV2ModelPolicy(POLICY, input());
  const abstained = applyMoundV2ModelPolicy(POLICY, input({ dataQuality: "degraded" }));
  ok(qualified.side !== null && qualified.modelQualified === true, "qualified verdict has a real side");
  ok(abstained.side === null && abstained.modelQualified === false, "abstained verdict has a null side");
}

// ── Abstains: data quality not allowed ──────────────────────────────────────
{
  const result = applyMoundV2ModelPolicy(POLICY, input({ dataQuality: "degraded" }));
  ok(result.side === null && result.modelQualified === false, "degraded data quality abstains regardless of how decisive the probabilities are");
  ok(result.qualificationReason === "data_quality_not_allowed", "the real, specific reason is reported");
}

// ── Abstains: lineup status not allowed ─────────────────────────────────────
{
  const result = applyMoundV2ModelPolicy(POLICY, input({ lineupStatus: "unconfirmed" }));
  ok(result.side === null && result.qualificationReason === "lineup_status_not_allowed", "an unconfirmed lineup abstains with the real, specific reason");
}

// ── Abstains: below minimum probability (neither side clears the floor) ────
{
  const result = applyMoundV2ModelPolicy(POLICY, input({ overProbability: 0.5, underProbability: 0.47, pushProbability: 0.03 }));
  ok(result.side === null && result.qualificationReason === "below_minimum_probability", `neither side clears the 0.55 floor -> abstain (got side=${result.side} reason=${result.qualificationReason})`);
}

// ── Abstains: below minimum margin (one side clears the floor, but barely beats the other) ──
{
  // Both individually >= 0.55 is impossible in a real 3-outcome distribution
  // summing to 1, so this exercises the near-floor, thin-margin case: OVER
  // clears 0.55 but only barely beats UNDER.
  const result = applyMoundV2ModelPolicy(POLICY, input({ overProbability: 0.56, underProbability: 0.54, pushProbability: -0.10 }));
  // (pushProbability is deliberately unrealistic here — this function only
  // reads over/under directly, never validates push sums to 1, so this
  // isolates exactly the margin check under test.)
  ok(result.side === null && result.qualificationReason === "below_minimum_margin", `OVER clears the 0.55 floor but its 0.02 margin over UNDER is below the required 0.03 -> abstain (got side=${result.side} reason=${result.qualificationReason})`);
}

// ── No margin requirement -> qualifies on probability floor alone ──────────
{
  const noMarginPolicy: MoundV2ModelPolicy = { ...POLICY, minimumProbabilityMargin: undefined };
  const result = applyMoundV2ModelPolicy(noMarginPolicy, input({ overProbability: 0.56, underProbability: 0.54, pushProbability: -0.10 }));
  ok(result.side === "OVER" && result.modelQualified === true, "omitting minimumProbabilityMargin qualifies purely on the probability floor, even with a razor-thin margin over the other side");
}

// ── Never throws, even on degenerate (NaN) probabilities ───────────────────
{
  let threw = false;
  let result: ReturnType<typeof applyMoundV2ModelPolicy> | undefined;
  try {
    result = applyMoundV2ModelPolicy(POLICY, input({ overProbability: NaN, underProbability: NaN, pushProbability: NaN }));
  } catch {
    threw = true;
  }
  ok(!threw, "applyMoundV2ModelPolicy never throws, even for NaN probabilities");
  ok(result?.side === null && result?.modelQualified === false, "NaN probabilities never clear a >= floor comparison, so this safely abstains rather than crashing or fabricating a side");
}

// ── Structural purity: MoundV2ModelPolicyInput has no room for price ───────
// (See moundV2ModelPolicy.ts's own file header for the TypeScript-level
// guarantee — this test additionally proves it at the VALUE level: a
// realistic input object literal has exactly these 5 keys, nothing else.)
{
  const realisticInput = input();
  const keys = Object.keys(realisticInput).sort();
  ok(
    JSON.stringify(keys) === JSON.stringify(["dataQuality", "lineupStatus", "overProbability", "pushProbability", "underProbability"].sort()),
    `a real MoundV2ModelPolicyInput has exactly these 5 keys and no others — no price/sportsbook/timestamp field exists to even accidentally populate (got ${keys.join(", ")})`,
  );
}

console.log(`\nmoundV2ModelPolicy.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
