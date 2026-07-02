/**
 * HR Radar massive single-contact floor + Attack gate — invariant test.
 *
 * Locks the 2026-07 §7a calibration change (goldmaster v20): a
 * massive_single_contact signal (maxEV>=108, or barrel && maxEV>=105) alone
 * now caps at Playable (ready, floor 7.5) instead of auto-firing to Attack.
 * It only reaches Attack (fire, floor 9.0) when paired with an independent
 * vulnerability signal (pitcher_collapse_power or park_weather_boost).
 *
 * Fixture: Tyler O'Neill — 109.5 mph / 30° LA / 430 ft barrel before HR,
 * previously displayed a 0.4/10 score despite being flagged STRONG/
 * ACTIONABLE. This suite locks that the score floor now applies and the row
 * lands at Playable or Attack before the HR, never below its floor.
 *
 * Run: npx tsx server/mlb/hrRadarMassiveContactFloor.test.ts
 */

import {
  deriveQualifyingSignals,
  deriveSuggestedUserStageFromSignals,
  enrichWithUserStage,
} from "./hrRadarUserStage";

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

console.log("\n=== HR Radar Massive-Contact Floor + Attack Gate — Invariant Suite ===\n");

// ── A. maxEV=108 alone → ready (Playable), NOT fire (Attack) ───────────────
const massiveAlone = deriveQualifyingSignals({
  factors: { maxEV: 108, barrels: 0 },
  triggerTags: [], inning: 3, positiveDrivers: [], conversionProbability: null,
});
assert("A.1 maxEV=108 alone flags massive_single_contact", massiveAlone.includes("massive_single_contact"));
eq("A.2 maxEV=108 alone → suggested stage = ready (capped, no auto-fire)",
  deriveSuggestedUserStageFromSignals({ qualifyingSignals: massiveAlone }), "ready");

// ── B. maxEV=108 + pitcher_collapse_power → fire (Attack) ─────────────────
const massiveWithFatigue = deriveQualifyingSignals({
  factors: { maxEV: 108, barrels: 0, pitcherFatigueBoost: 1 },
  triggerTags: [], inning: 3, positiveDrivers: [], conversionProbability: null,
});
assert("B.1 fatigue co-signal present", massiveWithFatigue.includes("pitcher_collapse_power"));
eq("B.2 maxEV=108 + pitcher_collapse_power → fire (Attack)",
  deriveSuggestedUserStageFromSignals({ qualifyingSignals: massiveWithFatigue }), "fire");

// ── C. maxEV=108 + park/weather boost → fire (Attack) ──────────────────────
const massiveWithPark = deriveQualifyingSignals({
  factors: { maxEV: 108, barrels: 0, parkWindBoost: 1 },
  triggerTags: [], inning: 3, positiveDrivers: [], conversionProbability: null,
});
assert("C.1 park_weather_boost co-signal present", massiveWithPark.includes("park_weather_boost"));
eq("C.2 maxEV=108 + park_weather_boost → fire (Attack)",
  deriveSuggestedUserStageFromSignals({ qualifyingSignals: massiveWithPark }), "fire");

// ── D. Tyler O'Neill fixture: 109.5 mph / 30° / 430 ft barrel ──────────────
const oneillSignals = deriveQualifyingSignals({
  factors: { barrels: 1, maxEV: 109.5, maxLA: 30, maxDistance: 430 },
  triggerTags: [], inning: 5, positiveDrivers: [], conversionProbability: null,
});
assert("D.1 O'Neill fixture flags elite_barrel", oneillSignals.includes("elite_barrel"));
assert("D.2 O'Neill fixture flags massive_single_contact", oneillSignals.includes("massive_single_contact"));
const oneillStage = deriveSuggestedUserStageFromSignals({ qualifyingSignals: oneillSignals });
assert("D.3 O'Neill fixture → ready or fire (Playable or Attack)",
  oneillStage === "ready" || oneillStage === "fire", `got ${oneillStage}`);

const oneillRow = enrichWithUserStage({
  legacyTier: "strong", legacyState: "actionable", dynamicState: "BET_NOW",
  canonicalStage: "attack", outcome: "pending",
  currentReadinessScore: 4, peakReadinessScore: 4, // the historical stuck-at-0.4 case (0-100 scale)
  factors: { barrels: 1, maxEV: 109.5, maxLA: 30, maxDistance: 430 },
  triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.15, confidenceScore: 8, inning: 5, alertPath: null,
  useFallbackScore: true,
  detectedAt: "2026-05-20T01:00:00.000Z", detectedInning: 5,
  signalDetectedAt: "2026-05-20T01:00:00.000Z", signalInning: 5,
  gameId: "g-oneill", playerId: "p-oneill", player: "Tyler O'Neill",
});
assert("D.4 O'Neill row score does not remain 0.4",
  (oneillRow.displayCurrentScore10 ?? 0) > 1.0, `score=${oneillRow.displayCurrentScore10}`);
assert("D.5 O'Neill row lands at Playable or Attack",
  oneillRow.playabilityStatus === "playable" || oneillRow.playabilityStatus === "attack",
  `status=${oneillRow.playabilityStatus}`);
assert("D.6 O'Neill row is an official signal",
  oneillRow.isOfficialSignal === true, `isOfficialSignal=${oneillRow.isOfficialSignal}`);

// ── E. Regression: old behavior (auto-fire on massive contact alone) is
// intentionally removed as of MLB_GOLDMASTER_VERSION v20 (massive-contact-
// attack-gate). This assertion documents the removal so a future revert
// shows up here instead of silently reintroducing the false-positive class.
eq("E.1 massive_single_contact alone no longer auto-fires (documents the v20 gate)",
  deriveSuggestedUserStageFromSignals({ qualifyingSignals: ["massive_single_contact"] as any }),
  "ready");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
