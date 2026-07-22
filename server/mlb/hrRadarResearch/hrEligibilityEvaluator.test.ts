// HR Radar research eligibility evaluator — invariants.
//
// Run: npx tsx server/mlb/hrRadarResearch/hrEligibilityEvaluator.test.ts

import { evaluateHrEligibility, type HrEligibilityInput } from "./hrEligibilityEvaluator";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const BASE: HrEligibilityInput = {
  hasResolvedPlayerId: true,
  gameStatus: "live",
  stillInBattingOrder: true,
  alreadyHomeredThisGame: false,
  remainingPaEstimate: 2,
  championModeledProbabilityPositive: true,
};

// Every batter — eligible or not — gets a row; exclusion is a reason, not a skip.
{
  const eligible = evaluateHrEligibility(BASE);
  ok(eligible.eligible === true, "fully-clean input is eligible");
  ok(eligible.exclusionReason === null, "eligible batter has null exclusionReason");
}

{
  const r = evaluateHrEligibility({ ...BASE, hasResolvedPlayerId: false });
  ok(r.eligible === false && r.exclusionReason === "identity_missing", "missing identity excludes with identity_missing (checked first)");
}

{
  const r = evaluateHrEligibility({ ...BASE, gameStatus: "suspended" });
  ok(r.eligible === false && r.exclusionReason === "suspended_or_postponed_game", "suspended game excludes with suspended_or_postponed_game");
}

{
  const r = evaluateHrEligibility({ ...BASE, gameStatus: "postponed" });
  ok(r.eligible === false && r.exclusionReason === "suspended_or_postponed_game", "postponed game excludes with suspended_or_postponed_game");
}

{
  const r = evaluateHrEligibility({ ...BASE, stillInBattingOrder: false });
  ok(r.eligible === false && r.exclusionReason === "lineup_removed_or_substituted", "removed batter excludes with lineup_removed_or_substituted");
}

{
  const r = evaluateHrEligibility({ ...BASE, alreadyHomeredThisGame: true });
  ok(r.eligible === false && r.exclusionReason === "already_homered_this_game", "already-homered batter excludes with already_homered_this_game (scoped to first_hr_of_game)");
}

{
  const r = evaluateHrEligibility({ ...BASE, remainingPaEstimate: 0 });
  ok(r.eligible === false && r.exclusionReason === "no_remaining_pa", "zero remaining PA excludes with no_remaining_pa");
}

{
  const r = evaluateHrEligibility({ ...BASE, remainingPaEstimate: null });
  ok(r.eligible === true, "null remainingPaEstimate (unknown, not zero) does not trigger no_remaining_pa");
}

{
  const r = evaluateHrEligibility({ ...BASE, championModeledProbabilityPositive: false });
  ok(r.eligible === false && r.exclusionReason === "no_positive_modeled_probability", "champion-evaluated zero probability excludes with no_positive_modeled_probability");
}

{
  // championEvaluated=false must NOT be conflated with "evaluated and found zero probability".
  const r = evaluateHrEligibility({ ...BASE, championModeledProbabilityPositive: null });
  ok(r.eligible === true, "champion-not-evaluated (null) does not itself exclude — distinct from a champion-evaluated zero probability");
}

// First-match-wins precedence — identity_missing beats every other reason.
{
  const r = evaluateHrEligibility({
    ...BASE,
    hasResolvedPlayerId: false,
    gameStatus: "suspended",
    alreadyHomeredThisGame: true,
  });
  ok(r.exclusionReason === "identity_missing", "identity_missing takes precedence over all other exclusion reasons");
}

console.log(`hrEligibilityEvaluator.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
