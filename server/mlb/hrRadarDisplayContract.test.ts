/**
 * HR Radar display contract — invariant test.
 *
 * Locks the 2026-06 presentation-layer fix that stopped the "BUILDING looks
 * better than TOP WINDOW" confusion:
 *   - HR chance % is the true calibrated probability, never tier-capped
 *   - null/blank probability → null (never a false 0%)
 *   - action strength is tier-banded (WATCHING ≤54, ALMOST 55-69, TOP WINDOW ≥70)
 *   - current-readiness helper never falls back to peak (the old sort bug)
 *   - record eligibility derives only from officialSignalStage
 *
 * Run: npx tsx server/mlb/hrRadarDisplayContract.test.ts
 */

import {
  normalizeProbabilityPct,
  normalizeScore10,
  getRawCurrentReadinessScore10,
  buildHrRadarDisplayContract,
} from "./hrRadarDisplayContract";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq<T>(name: string, actual: T, expected: T): void {
  if (actual === expected) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} — expected=${String(expected)} actual=${String(actual)}`);
    console.log(`  ✗ ${name} — expected=${String(expected)} actual=${String(actual)}`);
  }
}
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== HR Radar Display Contract — Invariant Suite ===\n");

// ── normalizeProbabilityPct ────────────────────────────────────────────────
console.log("normalizeProbabilityPct");
eq("null → null", normalizeProbabilityPct(null), null);
eq("undefined → null", normalizeProbabilityPct(undefined), null);
eq('"" → null', normalizeProbabilityPct(""), null);
eq("0.16 → 16", normalizeProbabilityPct(0.16), 16);
eq("16 → 16 (stale 0-100 payload)", normalizeProbabilityPct(16), 16);
eq("1600 → null (out of range)", normalizeProbabilityPct(1600), null);
eq("NaN → null", normalizeProbabilityPct(Number.NaN), null);

// ── normalizeScore10 ───────────────────────────────────────────────────────
console.log("\nnormalizeScore10");
eq("null → null", normalizeScore10(null), null);
eq("undefined → null", normalizeScore10(undefined), null);
eq('"" → null', normalizeScore10(""), null);
eq("80 → 8.0 (0-100 scale)", normalizeScore10(80), 8.0);
eq("8 → 8.0 (0-10 scale)", normalizeScore10(8), 8.0);

// ── getRawCurrentReadinessScore10 — NO peak fallback ───────────────────────
console.log("\ngetRawCurrentReadinessScore10");
eq("current 4.0 / peak 9.0 → 4.0 (never peak)",
  getRawCurrentReadinessScore10({ currentSignalScore10: 4.0, peakSignalScore10: 9.0 }), 4.0);
eq("only peak present → null (peak is not a current fallback)",
  getRawCurrentReadinessScore10({ peakSignalScore10: 9.0 }), null);
eq("falls through to readiness 0-100 → 6.0",
  getRawCurrentReadinessScore10({ currentReadinessScore: 60 }), 6.0);

// ── tier-banded action strength + uncapped HR chance ───────────────────────
console.log("\nbuildHrRadarDisplayContract — tier bands");

// WATCHING: raw 8.0 but path-capped to 6.0 → action must stay in the 0-54 band.
const watching = buildHrRadarDisplayContract(
  { currentSignalScore10: 8.0, displayCurrentScore10: 6.0, conversionProbability: 0.30, officialSignalStage: null },
  "watch",
);
assert("WATCHING raw 8.0 / path-capped 6.0 → actionPct ≤ 54", (watching.displayActionPct ?? 0) <= 54,
  `actionPct=${watching.displayActionPct}`);
eq("WATCHING stage label", watching.displayStageLabel, "WATCHING");
eq("WATCHING HR chance uncapped (30%)", watching.displayHrChancePct, 30);
eq("WATCHING readiness preserves RAW (8.0, not 6.0)", watching.displayReadinessScore10, 8.0);
assert("WATCHING surfaces a why-not-top-window line", !!watching.displayWhyNotTopWindow);
eq("WATCHING not record-eligible", watching.displayRecordEligible, false);

// ALMOST: raw 8.0 → action in the 55-69 band.
const almost = buildHrRadarDisplayContract(
  { currentSignalScore10: 8.0, conversionProbability: 0.22, officialSignalStage: null },
  "building",
);
assert("ALMOST raw 8.0 → actionPct in 55-69",
  (almost.displayActionPct ?? 0) >= 55 && (almost.displayActionPct ?? 0) <= 69, `actionPct=${almost.displayActionPct}`);
eq("ALMOST stage label", almost.displayStageLabel, "ALMOST");

// TOP WINDOW: even a modest raw 5.0 → action ≥ 70 (tier floor) and probability uncapped.
const top = buildHrRadarDisplayContract(
  { currentSignalScore10: 5.0, conversionProbability: 0.42, officialSignalStage: "fire" },
  "attackNow",
);
assert("TOP WINDOW raw 5.0 → actionPct ≥ 70", (top.displayActionPct ?? 0) >= 70, `actionPct=${top.displayActionPct}`);
eq("TOP WINDOW stage label", top.displayStageLabel, "TOP WINDOW");
eq("TOP WINDOW HR chance uncapped (42%)", top.displayHrChancePct, 42);
eq("TOP WINDOW has no why-not line", top.displayWhyNotTopWindow, null);
eq("TOP WINDOW record-eligible (officialSignalStage=fire)", top.displayRecordEligible, true);

// Monotonicity: a strong WATCHING can never out-rank a weak TOP WINDOW on the bar.
assert("WATCHING actionPct < TOP WINDOW actionPct (hierarchy holds)",
  (watching.displayActionPct ?? 0) < (top.displayActionPct ?? 0),
  `watching=${watching.displayActionPct} top=${top.displayActionPct}`);

// Record eligibility derives ONLY from officialSignalStage, and FIRE-ONLY
// (2026-06): a committed FIRE call is record-eligible; READY (high-watch
// context) is NOT part of the official record and must be ineligible.
eq("record-eligible when officialSignalStage=fire",
  buildHrRadarDisplayContract({ currentSignalScore10: 9.0, officialSignalStage: "fire" }, "attackNow").displayRecordEligible, true);
eq("NOT record-eligible when officialSignalStage=null (was ready)",
  buildHrRadarDisplayContract({ currentSignalScore10: 7.0, officialSignalStage: null }, "building").displayRecordEligible, false);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
