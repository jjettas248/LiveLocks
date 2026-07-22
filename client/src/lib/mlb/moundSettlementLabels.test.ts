// moundSettlementLabels — invariants.
// Run: npx tsx client/src/lib/mlb/moundSettlementLabels.test.ts
//
// Guards the baseline-only fallback label the compact/expanded Mound card
// falls back to whenever no real sportsbook line was ever captured. Locked
// product rule: this function must NEVER return the words "Cashed",
// "Missed", or "Push" (the market-facing vocabulary) — "Push" is reserved
// exclusively for a real market-line tie, and the baseline-tie case here
// must read "Matched Engine Baseline" instead.

import { baselineOnlyLabel } from "@/lib/mlb/moundSettlementLabels";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("\n=== moundSettlementLabels — Invariant Suite ===\n");

assert("Follow + confirmed → 'Follow Read Confirmed'", baselineOnlyLabel("confirmed", "OVER") === "Follow Read Confirmed");
assert("Fade + confirmed → 'Fade Read Confirmed'", baselineOnlyLabel("confirmed", "UNDER") === "Fade Read Confirmed");
assert("Follow + not_confirmed → 'Performed Below Baseline'", baselineOnlyLabel("not_confirmed", "OVER") === "Performed Below Baseline");
assert("Fade + not_confirmed → 'Performed Above Baseline'", baselineOnlyLabel("not_confirmed", "UNDER") === "Performed Above Baseline");
assert("Follow + baseline tie → 'Matched Engine Baseline', never 'Push'", baselineOnlyLabel("push", "OVER") === "Matched Engine Baseline");
assert("Fade + baseline tie → 'Matched Engine Baseline', never 'Push'", baselineOnlyLabel("push", "UNDER") === "Matched Engine Baseline");
assert("null modelOutcome → null, never fabricated", baselineOnlyLabel(null, "OVER") === null);
assert("null recommendedSide + confirmed → treated as Follow (non-UNDER)", baselineOnlyLabel("confirmed", null) === "Follow Read Confirmed");

// Reserved-word guard: enumerate every possible input and confirm the
// literal strings "Cashed"/"Missed"/"Push" never appear anywhere in output.
const ALL_MODEL_OUTCOMES: Array<"confirmed" | "not_confirmed" | "push" | null> = ["confirmed", "not_confirmed", "push", null];
const ALL_SIDES: Array<"OVER" | "UNDER" | null> = ["OVER", "UNDER", null];
let sawForbiddenWord = false;
for (const mo of ALL_MODEL_OUTCOMES) {
  for (const side of ALL_SIDES) {
    const label = baselineOnlyLabel(mo, side);
    if (label && /\b(Cashed|Missed|Push)\b/.test(label)) sawForbiddenWord = true;
  }
}
assert("no combination of inputs ever produces the literal words Cashed/Missed/Push", !sawForbiddenWord);

console.log(`\nmoundSettlementLabels.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
