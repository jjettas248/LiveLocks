// MoundPowerRadar — compact-card hierarchy invariant (static source check).
// Run: npx tsx client/src/components/mlb/MoundPowerRadar.test.ts
//
// Locked product rule: the settled Mound card must mirror the settled
// batting card's (PregamePowerRadar.tsx) hierarchy — factual final
// performance on the LEFT beneath the pitcher name (matching HOMERED/No HR's
// position), exactly one recommendation-result string on the RIGHT beneath
// the letter grade, never both. This is a plain-text source scan (no React
// render harness exists in this codebase's test convention) that pins the
// exact structural pattern so a future edit can't silently reintroduce the
// duplication.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("\n=== MoundPowerRadar — Settled-Card Hierarchy Invariant Suite ===\n");

const source = readFileSync(join(__dirname, "MoundPowerRadar.tsx"), "utf-8");

// The old left-side duplicated-result badges must be gone entirely.
assert("no 'Faded — Cashed' compound string anywhere (result is a single word now)", !source.includes("Faded — Cashed"));
assert("no left-side CASHED badge testid remains", !source.includes("mound-cashed-${slug}"));
assert("no left-side Push badge testid remains", !source.includes("mound-push-${slug}"));
assert("no left-side model-outcome (fallback) badge testid remains", !source.includes("mound-model-outcome-${slug}"));

// The new factual-final-stat helper must be imported and used for the left side.
assert("imports moundFinalStatLabel (left-side factual final performance)", source.includes("moundFinalStatLabel"));
assert("imports moundResultLabel (right-side single recommendation result)", source.includes("moundResultLabel"));
assert("left-side badge renders finalStatLabel, not a result string", /\{finalStatLabel &&/.test(source));

// The right side must resolve through exactly one variable (resultLabel) —
// never re-derive Cashed/Missed/Push/fallback text inline in the JSX ternary.
assert(
  "right-side pill renders resultLabel as its single result slot",
  /\{resultLabel \? resultLabel : isFade \? "Fade Candidate" : style\.label\}/.test(source),
);

// SettlementRow must no longer render a "Final X" / "Result Y" line — that
// content now lives exclusively in the left/right badge positions above.
const settlementRowSection = source.slice(source.indexOf("function SettlementRow"), source.indexOf("function StrikeoutLineRow"));
assert("SettlementRow no longer renders a 'Result' line (moved to the right-side pill)", !settlementRowSection.includes(">Result<") && !/\bResult </.test(settlementRowSection));
assert("SettlementRow's market-available branch no longer repeats 'Final' (moved to the left-side badge)", !/Final <span/.test(settlementRowSection));

// ── Terminal-state treatment ────────────────────────────────────────────────
// A real Cashed must be unmistakable: emerald border, emerald glow, emerald
// card tint, and the celebration icon. A real Missed gets the mirrored red
// treatment. Nothing else may borrow a betting-result color.
assert("cashed applies the emerald card tint", /cashed \? "bg-emerald-500\/10"/.test(source));
assert("cashed applies an emerald glow", /cashed[\s\S]{0,40}rgba\(16,185,129,0\.45\)/.test(source));
assert("cashed applies the emerald border color", /borderColor: cashed \? cashedColor/.test(source));
assert("cashed renders the celebration icon", /cashed \? \(\s*<PartyPopper/.test(source));
assert("missed applies the mirrored red tint", /isMissed \? "bg-red-500\/10"/.test(source));
assert("missed applies a red glow", /isMissed[\s\S]{0,60}rgba\(239,68,68,0\.35\)/.test(source));
assert("missed has its own red accent color", /const missedColor = "#ef4444"/.test(source));

// ── Lane discipline ─────────────────────────────────────────────────────────
// The lane is server-decided. The card reads it and never re-derives which
// lane a settled signal belongs to, and the baseline-only wording is only
// ever computed inside the model-review lane.
assert("reads the server-stamped settlementLane", /settlementView\?\.settlementLane \?\? "model_review"/.test(source));
assert("passes the lane into moundResultLabel", /moundResultLabel\([\s\S]{0,160}lane\)/.test(source));
assert("baseline-only fallback wording is gated on the model-review lane", /const fallbackLabel = isModelReview$/m.test(source));
assert("an integrity gap has its own neutral accent, never a betting-result color", /const integrityColor = "#94a3b8"/.test(source));
assert("SettlementRow surfaces the integrity gap explicitly", settlementRowSection.includes("mound-settlement-row-integrity"));
assert(
  "SettlementRow's integrity branch never renders the baseline label",
  /integrity_gap"\) \{[\s\S]{0,600}?\n  \}/.test(settlementRowSection) &&
    !/integrity_gap"\) \{[\s\S]{0,600}?baselineOnlyLabel/.test(settlementRowSection),
);

console.log(`\nMoundPowerRadar.test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
