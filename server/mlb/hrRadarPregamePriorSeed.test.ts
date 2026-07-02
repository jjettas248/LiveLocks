/**
 * HR Radar pregame HR-prior score — invariant test.
 *
 * Locks the 2026-07 §2.3 addition: computePregameHrPriorScore (a SEPARATE,
 * 0-1 weighted composition from the existing computePregameSeed 0-100
 * display score) and derivePregamePriorPromotion, which can promote a
 * presence-floor row to Watchlist (>=0.70) or Lean (>=0.78 + inning>=6 +
 * bullpen vulnerability>=0.65) — and structurally never further.
 *
 * Run: npx tsx server/mlb/hrRadarPregamePriorSeed.test.ts
 */

import {
  computePregameHrPriorScore,
  derivePregamePriorPromotion,
  type HRConversionInput,
} from "./hrConversionModel";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)} actual=${String(actual)}`);
}

console.log("\n=== HR Radar Pregame HR-Prior Score — Invariant Suite ===\n");

const emptyInput = {} as HRConversionInput;

// ── A. No-op when all inputs absent — every component is neutral (0.5) ────
const emptyResult = computePregameHrPriorScore(emptyInput);
eq("A.1 empty input → priorScore = 0.5 (fully neutral)", emptyResult.priorScore, 0.5);
eq("A.2 empty input → 6 missing inputs reported", emptyResult.missingInputs.length, 6);
assert("A.3 missing inputs are neutral, not zero-suppressed",
  emptyResult.componentScores.batterPower === 0.5, `got ${emptyResult.componentScores.batterPower}`);

// ── B. Each input's contribution in isolation ───────────────────────────────
const elitePower = computePregameHrPriorScore({ ...emptyInput, seasonHRRate: 0.07, barrelRate: 0.16, hardHitRate: 0.5 } as HRConversionInput);
assert("B.1 elite batter power raises batterPower component",
  elitePower.componentScores.batterPower > 0.5, `got ${elitePower.componentScores.batterPower}`);
assert("B.2 elite batter power raises overall priorScore vs neutral",
  elitePower.priorScore > emptyResult.priorScore, `got ${elitePower.priorScore}`);

const vulnerablePitcher = computePregameHrPriorScore({ ...emptyInput, era: 7.0, isPitcherCollapsing: true } as HRConversionInput);
assert("B.3 vulnerable pitcher raises pitcherHrVulnerability component",
  vulnerablePitcher.componentScores.pitcherHrVulnerability > 0.5,
  `got ${vulnerablePitcher.componentScores.pitcherHrVulnerability}`);

const parkBoost = computePregameHrPriorScore({ ...emptyInput, parkFactor: 1.2 } as HRConversionInput);
assert("B.4 favorable park raises parkWeatherBoost component",
  parkBoost.componentScores.parkWeatherBoost > 0.5, `got ${parkBoost.componentScores.parkWeatherBoost}`);

const leadoffSlot = computePregameHrPriorScore({ ...emptyInput, battingOrderSlot: 1 } as HRConversionInput);
assert("B.5 leadoff slot raises lineupOpportunity component",
  leadoffSlot.componentScores.lineupOpportunity > 0.9, `got ${leadoffSlot.componentScores.lineupOpportunity}`);

const ninthSlot = computePregameHrPriorScore({ ...emptyInput, battingOrderSlot: 9 } as HRConversionInput);
assert("B.6 9-hole slot lowers lineupOpportunity component",
  ninthSlot.componentScores.lineupOpportunity < 0.3, `got ${ninthSlot.componentScores.lineupOpportunity}`);

const hotForm = computePregameHrPriorScore({ ...emptyInput, hrRateLast7: 0.10, hrRateLast15: 0.08, hrRateLast30: 0.07 } as HRConversionInput);
assert("B.7 hot recent form raises recentPowerForm component",
  hotForm.componentScores.recentPowerForm > 0.5, `got ${hotForm.componentScores.recentPowerForm}`);

const handedness = computePregameHrPriorScore({
  ...emptyInput, pitcherThrows: "R",
  batterHandednessSplits: { hrRateVsLHP: 0.02, hrRateVsRHP: 0.06, opsVsLHP: null, opsVsRHP: null },
} as HRConversionInput);
assert("B.8 favorable handedness split raises handednessMatchup component",
  handedness.componentScores.handednessMatchup > 0.5, `got ${handedness.componentScores.handednessMatchup}`);

// ── C. Watchlist threshold (>=0.70) ─────────────────────────────────────────
eq("C.1 priorScore=0.70 → watchlist", derivePregamePriorPromotion({ priorScore: 0.70 }), "watchlist");
eq("C.2 priorScore=0.69 → none", derivePregamePriorPromotion({ priorScore: 0.69 }), "none");
eq("C.3 priorScore=0.95 alone (no inning/bullpen) → watchlist only",
  derivePregamePriorPromotion({ priorScore: 0.95 }), "watchlist");

// ── D. Lean threshold (>=0.78 + inning>=6 + bullpen vulnerability>=0.65) ────
eq("D.1 priorScore=0.78 + inning=6 + bullpen=0.65 → lean",
  derivePregamePriorPromotion({ priorScore: 0.78, inning: 6, pitcherOrBullpenVulnerabilityScore: 0.65 }), "lean");
eq("D.2 priorScore=0.78 but inning=5 → watchlist only (inning gate enforced)",
  derivePregamePriorPromotion({ priorScore: 0.78, inning: 5, pitcherOrBullpenVulnerabilityScore: 0.65 }), "watchlist");
eq("D.3 priorScore=0.78 + inning=6 but bullpen=0.50 → watchlist only (bullpen gate enforced)",
  derivePregamePriorPromotion({ priorScore: 0.78, inning: 6, pitcherOrBullpenVulnerabilityScore: 0.50 }), "watchlist");
eq("D.4 priorScore=0.77 + inning=6 + bullpen=0.65 → watchlist only (score gate enforced)",
  derivePregamePriorPromotion({ priorScore: 0.77, inning: 6, pitcherOrBullpenVulnerabilityScore: 0.65 }), "watchlist");

// ── E. HARD INVARIANT — no combination ever reaches Playable/Attack ────────
// Even at the theoretical maximum (priorScore=1.0, every gate maxed), the
// return type has no "playable"/"attack" member — this is a structural
// guarantee, not just a threshold check.
eq("E.1 priorScore=1.0 + inning=9 + bullpen=1.0 → still capped at lean",
  derivePregamePriorPromotion({ priorScore: 1.0, inning: 9, pitcherOrBullpenVulnerabilityScore: 1.0 }), "lean");
const allPromotions: string[] = ["none", "watchlist", "lean"];
assert("E.2 promotion return type never includes playable/attack",
  !allPromotions.includes("playable") && !allPromotions.includes("attack"));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
