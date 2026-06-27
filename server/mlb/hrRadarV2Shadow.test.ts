/**
 * HR Radar Live v2 Shadow — compute + adapter invariants.
 *
 * Locks: live-only gate, FIRE-only official, stage ladder, split confidence
 * (coverage 0 doesn't crush core; Fire reachable with 0 advanced coverage),
 * stale-peak cannot Fire, advanced-context-alone cannot create a row, adapter
 * + compute mutate nothing, and output shape (version/drivers/suppressors/
 * missingStats).
 *
 * Run: npx tsx server/mlb/hrRadarV2Shadow.test.ts
 */

import {
  buildHrRadarV2InputFromCanonicalState,
  computeHrRadarV2Shadow,
} from "./hrRadarV2Shadow";
import { V2_SHADOW_MODEL_VERSION, type HRRadarV2Input, type V2ContactEvidence } from "./hrRadarV2Types";
import type { CanonicalHrRadarState } from "./hrRadarCanonicalStore";

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

const REF = "2026-06-26T20:05:00Z";
const EV_AT = "2026-06-26T20:04:40Z"; // 20s old → fresh

function baseInput(over: Partial<HRRadarV2Input>): HRRadarV2Input {
  return {
    signalId: null,
    gameId: "g1",
    playerId: "p1",
    playerName: "Test Batter",
    currentStage: null,
    currentScore10: null,
    peakScore10: null,
    lifecycleState: "watch",
    active: true,
    terminal: false,
    hasLiveEvidence: true,
    contactEvidence: [],
    triggerReasons: [],
    triggerTags: [],
    detectedInning: 3,
    latestEvidenceInning: 4,
    detectedAtIso: "2026-06-26T20:00:00Z",
    latestEvidenceAtIso: EV_AT,
    referenceTimeIso: REF,
    availableStats: [],
    derivableStats: [],
    missingStats: [],
    diagnosticsOnlyStats: [],
    ...over,
  };
}

const weak: V2ContactEvidence[] = [{ abIndex: 0, ev: 93, la: 12, distance: 290, xba: 0.2, isBarrel: false, outcome: "out" }];
const watch1: V2ContactEvidence[] = [{ abIndex: 0, ev: 99, la: 24, distance: 360, xba: 0.5, isBarrel: false, outcome: "out" }];
const leanBarrels: V2ContactEvidence[] = [
  { abIndex: 0, ev: 104, la: 26, distance: 395, xba: 0.7, isBarrel: true, outcome: "out" },
  { abIndex: 1, ev: 106, la: 27, distance: 405, xba: 0.78, isBarrel: true, outcome: "out" },
];
const fireBarrels: V2ContactEvidence[] = [
  { abIndex: 0, ev: 102, la: 24, distance: 380, xba: 0.66, isBarrel: true, outcome: "out" },
  { abIndex: 1, ev: 104, la: 26, distance: 392, xba: 0.72, isBarrel: true, outcome: "out" },
  { abIndex: 2, ev: 106, la: 27, distance: 402, xba: 0.78, isBarrel: true, outcome: "out" },
  { abIndex: 3, ev: 108, la: 28, distance: 412, xba: 0.83, isBarrel: true, outcome: "out" },
];

console.log("\n=== HR Radar v2 — Shadow Compute + Adapter ===\n");

// 1. LIVE-ONLY GATE
console.log("1. Live-only gate");
const noEvidence = computeHrRadarV2Shadow(
  baseInput({
    hasLiveEvidence: false,
    contactEvidence: leanBarrels,
    // Even with rich (real) supplemental core data, no live evidence ⇒ no row.
    supplementalCore: { pitcherDeterioration: 0.95, opportunity: 0.95, countLeverage: 0.95, liveEnvironmentFit: 0.95 },
  }),
);
assert("1.1 no live evidence → suggested stage null", noEvidence.v2SuggestedStage === null);
assert("1.2 no live evidence → official null", noEvidence.v2OfficialSignalStage === null);
assert("1.3 no live evidence → final score 0", noEvidence.v2FinalScore === 0);
assert("1.4 advanced/supplemental cannot create a row", noEvidence.v2SuggestedStage === null);

// 2. STAGE LADDER + FIRE-ONLY OFFICIAL
console.log("\n2. Stage ladder + FIRE-only official");
const track = computeHrRadarV2Shadow(baseInput({ contactEvidence: weak }));
assert("2.1 weak evidence → track", track.v2SuggestedStage === "track", `got ${track.v2SuggestedStage} score=${track.v2FinalScore}`);
assert("2.2 track → official null", track.v2OfficialSignalStage === null);

const build = computeHrRadarV2Shadow(
  baseInput({
    contactEvidence: watch1,
    supplementalCore: { pitcherDeterioration: 0.9, opportunity: 0.9, countLeverage: 0.9 },
  }),
);
assert("2.3 moderate evidence → build", build.v2SuggestedStage === "build", `got ${build.v2SuggestedStage} score=${build.v2FinalScore}`);
assert("2.4 build → official null", build.v2OfficialSignalStage === null);

const ready = computeHrRadarV2Shadow(
  baseInput({
    contactEvidence: leanBarrels,
    supplementalCore: { pitcherDeterioration: 0.9, opportunity: 0.8 },
  }),
);
assert("2.5 strong evidence + partial core → ready", ready.v2SuggestedStage === "ready", `got ${ready.v2SuggestedStage} score=${ready.v2FinalScore}`);
assert("2.6 ready → official null (READY not official)", ready.v2OfficialSignalStage === null);

const fire = computeHrRadarV2Shadow(
  baseInput({
    contactEvidence: fireBarrels,
    supplementalCore: { pitcherDeterioration: 0.9, opportunity: 0.9, countLeverage: 0.9, liveEnvironmentFit: 0.9 },
  }),
);
assert("2.7 full convergence → fire", fire.v2SuggestedStage === "fire", `got ${fire.v2SuggestedStage} score=${fire.v2FinalScore} conf=${fire.v2Confidence}`);
assert("2.8 fire → official 'fire'", fire.v2OfficialSignalStage === "fire");

// 3. CONFIDENCE SPLIT — coverage 0 does not crush core; Fire still reachable
console.log("\n3. Confidence split");
assert("3.1 advanced coverage is 0 today", fire.advancedContextCoverage === 0);
assert("3.2 core confidence high despite 0 coverage", fire.coreLiveEvidenceConfidence >= 75, `core=${fire.coreLiveEvidenceConfidence}`);
assert("3.3 Fire reachable with 0 advanced coverage", fire.v2OfficialSignalStage === "fire");
assert("3.4 advanced boost is 0 today", fire.v2AdvancedContextBoost === 0);

// 4. STALE PEAK CANNOT FIRE
console.log("\n4. Stale peak cannot fire");
const stale = computeHrRadarV2Shadow(
  baseInput({
    contactEvidence: fireBarrels,
    latestEvidenceAtIso: "2026-06-26T19:30:00Z", // 35 min before REF → stale
    supplementalCore: { pitcherDeterioration: 0.9, opportunity: 0.9, countLeverage: 0.9, liveEnvironmentFit: 0.9 },
  }),
);
assert("4.1 stale peak → not fire", stale.v2SuggestedStage !== "fire", `got ${stale.v2SuggestedStage}`);
assert("4.2 stale peak → official null", stale.v2OfficialSignalStage === null);

// 5. OUTPUT SHAPE
console.log("\n5. Output shape");
assert("5.1 model version tagged", fire.modelVersion === V2_SHADOW_MODEL_VERSION);
assert("5.2 drivers present (real evidence)", Array.isArray(fire.drivers) && fire.drivers.length > 0);
assert("5.3 missingStats present", Array.isArray(fire.missingStats) && fire.missingStats.length > 0);
assert("5.4 suppressors array present", Array.isArray(track.suppressors));
assert("5.5 readiness 10-scale matches final/10", Math.abs(fire.v2ReadinessScore10 - fire.v2FinalScore / 10) < 0.2);

// 6. COMPUTE MUTATES NOTHING
console.log("\n6. Purity");
const purityInput = baseInput({ contactEvidence: leanBarrels, supplementalCore: { pitcherDeterioration: 0.9 } });
const before = JSON.stringify(purityInput);
computeHrRadarV2Shadow(purityInput);
assert("6.1 compute does not mutate its input", JSON.stringify(purityInput) === before);

// 7. ADAPTER
console.log("\n7. Adapter (canonical state → v2 input)");
const state: CanonicalHrRadarState = {
  gameId: "g1",
  playerId: "p1",
  playerName: "Adapter Batter",
  team: "NYY",
  sessionDate: "2026-06-26",
  lifecycleState: "ready",
  section: "READY",
  userStage: "ready",
  displayScore10: 7.5,
  peakScore10: 8,
  detectedAt: "2026-06-26T20:00:00Z",
  detectedInning: 3,
  latestEvidenceAt: EV_AT,
  latestEvidenceInning: 4,
  triggerAbIndex: 1,
  triggerReasons: ["Statcast barrel"],
  triggerTags: ["BARREL_OVERRIDE"],
  contactEvidence: [{ abIndex: 1, ev: 104, la: 26, distance: 395, xba: 0.7, isBarrel: true, outcome: "out" }],
  active: true,
  terminal: false,
  updatedAt: EV_AT,
};
const stateSnapshot = JSON.stringify(state);
const adapted = buildHrRadarV2InputFromCanonicalState(state, { referenceTimeIso: REF });
assert("7.1 adapter does not mutate state", JSON.stringify(state) === stateSnapshot);
assert("7.2 active state → hasLiveEvidence true", adapted.hasLiveEvidence === true);
assert("7.3 contact evidence mapped", adapted.contactEvidence.length === 1 && adapted.contactEvidence[0].ev === 104);
assert("7.4 availableStats includes contact_ev", adapted.availableStats.includes("contact_ev"));
assert("7.5 derivableStats includes near_hr_tier", adapted.derivableStats.includes("near_hr_tier"));
assert("7.6 diagnosticsOnlyStats includes bvp_history", adapted.diagnosticsOnlyStats.includes("bvp_history"));
assert("7.7 adapter never sets supplementalCore (stays honestly sparse)", adapted.supplementalCore == null);

// PREGAME_SEED rows are ACTIVE but carry NO live contact evidence and a
// pregame-only tag. They must NOT count as live evidence (PR #48 review).
const pregameSeedState: CanonicalHrRadarState = {
  ...state,
  lifecycleState: "watch",
  section: "WATCH",
  userStage: "track",
  active: true,
  terminal: false,
  triggerReasons: ["pregame_priors:pf1.10_era5.20"],
  triggerTags: ["PREGAME_SEED"],
  contactEvidence: [],
};
const adaptedPregame = buildHrRadarV2InputFromCanonicalState(pregameSeedState, { referenceTimeIso: REF });
assert("7.10 pregame-seed active row → hasLiveEvidence false", adaptedPregame.hasLiveEvidence === false);
const pregameShadow = computeHrRadarV2Shadow(adaptedPregame);
assert("7.11 pregame-seed → suppressed (no suggested stage)", pregameShadow.v2SuggestedStage === null);

// A live near-HR row whose contactEvidence bag is empty but carries a live
// matched-path tag IS live evidence (sourceAbIndex-null case).
const liveTagNoEvidence: CanonicalHrRadarState = {
  ...state,
  triggerTags: ["BARREL_OVERRIDE"],
  contactEvidence: [],
};
const adaptedLiveTag = buildHrRadarV2InputFromCanonicalState(liveTagNoEvidence, { referenceTimeIso: REF });
assert("7.12 live near-HR tag (no evidence bag) → hasLiveEvidence true", adaptedLiveTag.hasLiveEvidence === true);

const terminalState: CanonicalHrRadarState = { ...state, active: false, terminal: true, lifecycleState: "cashed" };
const adaptedTerminal = buildHrRadarV2InputFromCanonicalState(terminalState, { referenceTimeIso: REF });
assert("7.8 terminal state → hasLiveEvidence false", adaptedTerminal.hasLiveEvidence === false);
const terminalShadow = computeHrRadarV2Shadow(adaptedTerminal);
assert("7.9 terminal → suppressed (no suggested stage)", terminalShadow.v2SuggestedStage === null);

// 8. END-TO-END: adapter output runs through compute without supplemental →
//    honestly sparse (never fires on canonical-only data)
console.log("\n8. Adapter → compute end-to-end");
const e2e = computeHrRadarV2Shadow(adapted);
assert("8.1 canonical-only never fires (sparse data)", e2e.v2OfficialSignalStage === null);
assert("8.2 canonical-only still produces a live suggested stage", e2e.v2SuggestedStage != null);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
