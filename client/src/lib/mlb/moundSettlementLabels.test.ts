// moundSettlementLabels — invariants.
// Run: npx tsx client/src/lib/mlb/moundSettlementLabels.test.ts
//
// Guards the baseline-only fallback label the compact/expanded Mound card
// falls back to whenever no real sportsbook line was ever captured. Locked
// product rule: this function must NEVER return the words "Cashed",
// "Missed", or "Push" (the market-facing vocabulary) — "Push" is reserved
// exclusively for a real market-line tie, and the baseline-tie case here
// must read "Matched Engine Baseline" instead.

import {
  baselineOnlyLabel,
  moundResultLabel,
  moundFinalStatLabel,
  MOUND_INTEGRITY_LABEL,
  type MoundMarketOutcome,
  type MoundSettlementLane,
} from "@/lib/mlb/moundSettlementLabels";

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

// ── moundResultLabel: the single result string shown beneath the grade ──────
// Mirrors the batting card's single "Cashed"/tier-label result slot — market
// available always wins with Cashed/Missed/Push; market unavailable falls
// back to the baseline-only wording, never inventing a ninth string.
assert("market cashed → 'Cashed', regardless of model/side", moundResultLabel("cashed", "not_confirmed", "UNDER") === "Cashed");
assert("market missed → 'Missed', regardless of model/side", moundResultLabel("missed", "confirmed", "OVER") === "Missed");
assert("market push (real line tie) → 'Push', regardless of model/side", moundResultLabel("push", "confirmed", "OVER") === "Push");
assert("market unavailable, Follow confirmed → 'Follow Read Confirmed'", moundResultLabel("unavailable", "confirmed", "OVER") === "Follow Read Confirmed");
assert("market unavailable, Fade confirmed → 'Fade Read Confirmed'", moundResultLabel("unavailable", "confirmed", "UNDER") === "Fade Read Confirmed");
assert("market unavailable, Follow not_confirmed → 'Performed Below Baseline'", moundResultLabel("unavailable", "not_confirmed", "OVER") === "Performed Below Baseline");
assert("market unavailable, Fade not_confirmed → 'Performed Above Baseline'", moundResultLabel("unavailable", "not_confirmed", "UNDER") === "Performed Above Baseline");
assert("market unavailable, baseline tie → 'Matched Engine Baseline'", moundResultLabel("unavailable", "push", "OVER") === "Matched Engine Baseline");
assert("market unavailable + null modelOutcome (ungraded) → null, never fabricated", moundResultLabel("unavailable", null, "OVER") === null);

// Exhaustive: every (marketOutcome × modelOutcome × side) combination
// resolves to exactly one of the 8 allowed strings, or null — never a 9th
// invented string, and market always takes precedence over model wording.
const ALL_MARKET_OUTCOMES: MoundMarketOutcome[] = ["cashed", "missed", "push", "unavailable"];
const ALLOWED_RESULT_LABELS = new Set([
  "Cashed", "Missed", "Push",
  "Follow Read Confirmed", "Fade Read Confirmed",
  "Performed Below Baseline", "Performed Above Baseline",
  "Matched Engine Baseline",
  "Result Unavailable",
]);
let sawUnexpectedResultLabel = false;
for (const mkt of ALL_MARKET_OUTCOMES) {
  for (const mo of ["confirmed", "not_confirmed", "push", null] as const) {
    for (const side of ["OVER", "UNDER", null] as const) {
      for (const lane of ["market", "integrity_gap", "model_review", undefined] as const) {
        const label = lane === undefined ? moundResultLabel(mkt, mo, side) : moundResultLabel(mkt, mo, side, lane);
        if (label != null && !ALLOWED_RESULT_LABELS.has(label)) sawUnexpectedResultLabel = true;
      }
    }
  }
}
assert("every input combination resolves to one of the 9 allowed result strings, or null", !sawUnexpectedResultLabel);

// ── Lane precedence: a public bet never falls back to model wording ────────
// The integrity lane exists for exactly one case — the card WAS a public
// sportsbook recommendation, but its frozen side/line can no longer be
// recovered. That must read as an unavailable result, never as a
// model-performance verdict (which would silently rewrite a bet's outcome)
// and never as a Cashed (which would fabricate a win from the engine
// baseline).
const ALL_LANES: MoundSettlementLane[] = ["market", "integrity_gap", "model_review"];
const MODEL_WORDING = new Set([
  "Follow Read Confirmed", "Fade Read Confirmed",
  "Performed Below Baseline", "Performed Above Baseline",
  "Matched Engine Baseline",
]);

assert(
  "integrity lane → 'Result Unavailable', never the model-performance label",
  moundResultLabel("unavailable", "not_confirmed", "UNDER", "integrity_gap") === MOUND_INTEGRITY_LABEL,
);
assert(
  "integrity lane never says Cashed even when the model read confirmed",
  moundResultLabel("unavailable", "confirmed", "OVER", "integrity_gap") === MOUND_INTEGRITY_LABEL,
);
assert(
  "model_review lane keeps the baseline wording (no bet was ever recommended)",
  moundResultLabel("unavailable", "not_confirmed", "UNDER", "model_review") === "Performed Above Baseline",
);
assert(
  "omitted lane defaults to model_review — legacy responses render as before",
  moundResultLabel("unavailable", "not_confirmed", "UNDER") === "Performed Above Baseline",
);

// A real market result outranks the lane argument entirely.
let marketAlwaysWins = true;
for (const lane of ALL_LANES) {
  if (moundResultLabel("cashed", "not_confirmed", "UNDER", lane) !== "Cashed") marketAlwaysWins = false;
  if (moundResultLabel("missed", "confirmed", "OVER", lane) !== "Missed") marketAlwaysWins = false;
  if (moundResultLabel("push", "confirmed", "OVER", lane) !== "Push") marketAlwaysWins = false;
}
assert("a real market result outranks every lane value", marketAlwaysWins);

// Exhaustive: model-performance wording can never escape the model lane.
let modelWordingLeaked = false;
for (const mkt of ["cashed", "missed", "push", "unavailable"] as MoundMarketOutcome[]) {
  for (const mo of ALL_MODEL_OUTCOMES) {
    for (const side of ALL_SIDES) {
      for (const lane of ALL_LANES) {
        const label = moundResultLabel(mkt, mo, side, lane);
        if (label != null && MODEL_WORDING.has(label) && lane !== "model_review") modelWordingLeaked = true;
      }
    }
  }
}
assert("model-performance wording never renders outside the model_review lane", !modelWordingLeaked);

// ── moundFinalStatLabel: the factual final-performance text on the left ─────
// Mirrors the batting card's HOMERED/No HR left-side position — always the
// same "{stat} {unit} · Final" shape, identical regardless of how it graded.
assert("9 Ks final → '9 Ks · Final'", moundFinalStatLabel(9, "Ks") === "9 Ks · Final");
assert("18 Outs final → '18 Outs · Final'", moundFinalStatLabel(18, "Outs") === "18 Outs · Final");
assert("0 Ks final → '0 Ks · Final' (falsy but real value, never omitted)", moundFinalStatLabel(0, "Ks") === "0 Ks · Final");
assert("null final stat → null, never a placeholder", moundFinalStatLabel(null, "Ks") === null);

// ── No-duplication invariant: the left-side factual text and the right-side
// result text must never overlap in content — the result word(s) never
// appear in the factual line, and "Final" never appears in the result word.
for (const mkt of ALL_MARKET_OUTCOMES) {
  for (const mo of ["confirmed", "not_confirmed", "push", null] as const) {
    for (const side of ["OVER", "UNDER", null] as const) {
      const result = moundResultLabel(mkt, mo, side);
      const final = moundFinalStatLabel(9, "Ks");
      if (result != null && final != null) {
        assert(
          `no overlap: result="${result}" (market=${mkt} model=${mo} side=${side}) vs final="${final}"`,
          !final.includes(result) && !result.includes("Final"),
        );
      }
    }
  }
}

console.log(`\nmoundSettlementLabels.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
