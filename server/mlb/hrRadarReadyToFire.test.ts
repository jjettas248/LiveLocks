/**
 * HR Radar READY → FIRE promotion — invariant test.
 *
 * Locks the May-2026 fix where live ladder showed FIRE=0 / READY=16 with
 * multiple cards at 10.0/10 + "Attack window is open" copy stuck in READY.
 *
 * Run: npx tsx server/mlb/hrRadarReadyToFire.test.ts
 */

import {
  maybePromoteReadyToFire,
  enrichWithUserStage,
  type HrRadarUserStage,
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

console.log("\n=== HR Radar READY → FIRE Promotion — Invariant Suite ===\n");

// ── Pure helper tests ─────────────────────────────────────────────────────
console.log("maybePromoteReadyToFire — direct rule coverage");

// Rule A: score≥9.5 + canonical=attack + strong driver → fire.
eq("A.1 score=10 + canonical=attack + elite_barrel → fire",
  maybePromoteReadyToFire("ready", {
    displayScore10: 10.0, canonicalStage: "attack",
    qualifyingSignals: ["elite_barrel"],
  }), "fire");

eq("A.2 score=9.5 + canonical=attack + two_hard_hit_balls → fire",
  maybePromoteReadyToFire("ready", {
    displayScore10: 9.5, canonicalStage: "attack",
    qualifyingSignals: ["two_hard_hit_balls"],
  }), "fire");

// Rule A negative — no strong driver.
eq("A.3 score=10 + canonical=attack + only near_barrel (not strong) → ready",
  maybePromoteReadyToFire("ready", {
    displayScore10: 10.0, canonicalStage: "attack",
    qualifyingSignals: ["near_barrel"],
  }), "ready");

// Rule A negative — canonical not attack.
eq("A.4 score=10 + canonical=building + elite_barrel → ready",
  maybePromoteReadyToFire("ready", {
    displayScore10: 10.0, canonicalStage: "building",
    qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Rule A negative — score below threshold.
eq("A.5 score=9.4 + canonical=attack + elite_barrel → ready",
  maybePromoteReadyToFire("ready", {
    displayScore10: 9.4, canonicalStage: "attack",
    qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Rule B: PATH_PROMOTES_TO_FIRE + signalState live|actionable → fire.
eq("B.1 alertPath=FAST_PROMOTE_ELITE + signalState=live → fire",
  maybePromoteReadyToFire("ready", {
    alertPath: "FAST_PROMOTE_ELITE", signalState: "live",
    qualifyingSignals: [],
  }), "fire");

eq("B.2 alertPath=FAST_PROMOTE_ELITE + signalState=actionable → fire",
  maybePromoteReadyToFire("ready", {
    alertPath: "FAST_PROMOTE_ELITE", signalState: "actionable",
    qualifyingSignals: [],
  }), "fire");

eq("B.3 alertPath=FAST_PROMOTE_ELITE + signalState=watching → ready",
  maybePromoteReadyToFire("ready", {
    alertPath: "FAST_PROMOTE_ELITE", signalState: "watching",
    qualifyingSignals: [],
  }), "ready");

eq("B.4 alertPath=PATH_C (READY-only path) + signalState=live → ready",
  maybePromoteReadyToFire("ready", {
    alertPath: "PATH_C", signalState: "live",
    qualifyingSignals: [],
  }), "ready");

// Rule C: BET_NOW + score≥9.5 + not stale → fire.
eq("C.1 dynamic=BET_NOW + score=10 + peak=current → fire",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", displayScore10: 10.0,
    currentReadinessScore: 95, peakReadinessScore: 95,
    qualifyingSignals: [],
  }), "fire");

eq("C.2 dynamic=BET_NOW + score=10 + current=70% of peak (stale) → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", displayScore10: 10.0,
    currentReadinessScore: 70, peakReadinessScore: 100,
    qualifyingSignals: [],
  }), "ready");

eq("C.3 dynamic=BET_NOW + score=9.4 + fresh → ready (score gate)",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", displayScore10: 9.4,
    currentReadinessScore: 95, peakReadinessScore: 95,
    qualifyingSignals: [],
  }), "ready");

// Non-ready inputs — never promoted.
eq("D.1 stage=track is never promoted",
  maybePromoteReadyToFire("track", {
    displayScore10: 10.0, canonicalStage: "attack",
    qualifyingSignals: ["elite_barrel"],
  }), "track");

eq("D.2 stage=build is never promoted",
  maybePromoteReadyToFire("build", {
    dynamicState: "BET_NOW", displayScore10: 10.0,
    currentReadinessScore: 95, peakReadinessScore: 95,
    qualifyingSignals: [],
  }), "build");

eq("D.3 stage=fire is preserved (idempotent)",
  maybePromoteReadyToFire("fire", {
    displayScore10: 10.0, canonicalStage: "attack",
    qualifyingSignals: ["elite_barrel"],
  }), "fire");

eq("D.4 stage=resolved is preserved (sticky)",
  maybePromoteReadyToFire("resolved", {
    displayScore10: 10.0, canonicalStage: "attack",
    qualifyingSignals: ["elite_barrel"],
  }), "resolved");

// ── Integration via enrichWithUserStage — reproduce the live bug shape ────
console.log("\nenrichWithUserStage — bug repro (FIRE=0 / READY=16 at 10.0/10)");

// E.1 The forensic case: PATH_C live + BET_NOW + canonical=attack + score 10.
// Pre-fix this stuck at "ready"; post-fix promotes via Rule C (BET_NOW
// score-max not stale) AND Rule A (score+attack+strong-driver).
const e1 = enrichWithUserStage({
  legacyTier: "strong",
  legacyState: "live",
  dynamicState: "BET_NOW",
  canonicalStage: "attack",
  outcome: "pending",
  currentReadinessScore: 100, peakReadinessScore: 100, initialReadinessScore: 60,
  factors: { barrels: 1, hardHits: 2, maxEV: 110, avgEV: 96 },
  triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.16, confidenceScore: 8,
  inning: 7, alertPath: "PATH_C",
  useFallbackScore: true, gameId: "g1", playerId: "p1", player: "Test Slugger",
});
eq("E.1 PATH_C live + BET_NOW + attack + 10/10 → fire", e1.userStage, "fire");

// E.2 The block side — PATH_C live + canonical=watch + no strong drivers.
const e2 = enrichWithUserStage({
  legacyTier: "monitor", legacyState: "live", dynamicState: "PREPARE",
  canonicalStage: "watch", outcome: "pending",
  currentReadinessScore: 60, peakReadinessScore: 60,
  factors: { barrels: 0, hardHits: 0 }, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.07, confidenceScore: 5,
  inning: 4, alertPath: "PATH_C",
  useFallbackScore: true, gameId: "g2", playerId: "p2", player: "Mid Bat",
});
eq("E.2 PATH_C live + watch + 6.0/10 stays ready", e2.userStage, "ready");

// E.3 PATH_F_BLOCKED_BRIDGE is conviction-capped at 6.0/10. Configure a
// scenario where the LEGACY mapper lands at READY (tier=strong, state=live,
// dynamic=PREPARE, canonical=watch) so the new promotion layer is the
// only thing that could push it to FIRE. The cap brings displayScore10
// to 6.0 (below the 9.5 gate) and PATH_F is not in PATH_PROMOTES_TO_FIRE,
// so all three rules must fail.
const e3 = enrichWithUserStage({
  legacyTier: "strong", legacyState: "live", dynamicState: "PREPARE",
  canonicalStage: "watch", outcome: "pending",
  currentReadinessScore: 100, peakReadinessScore: 100,
  factors: { barrels: 1, hardHits: 2 }, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.10, confidenceScore: 6,
  inning: 6, alertPath: "PATH_F_BLOCKED_BRIDGE",
  useFallbackScore: true, gameId: "g3", playerId: "p3", player: "Capped Bat",
});
eq("E.3 PATH_F_BLOCKED_BRIDGE at READY never promoted to fire (cap=6.0)",
  e3.userStage, "ready");

// E.4 FAST_PROMOTE_ELITE @ live — Rule B promotes regardless of score.
const e4 = enrichWithUserStage({
  legacyTier: "building", legacyState: "live", dynamicState: "PREPARE",
  canonicalStage: "building", outcome: "pending",
  currentReadinessScore: 70, peakReadinessScore: 70,
  factors: {}, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.10, confidenceScore: 7,
  inning: 5, alertPath: "FAST_PROMOTE_ELITE",
  useFallbackScore: true, gameId: "g4", playerId: "p4", player: "Elite Promo",
});
eq("E.4 FAST_PROMOTE_ELITE @ live → fire (Rule B)", e4.userStage, "fire");

// E.5 Resolved is never promoted.
const e5 = enrichWithUserStage({
  legacyTier: "strong", legacyState: "live", dynamicState: "BET_NOW",
  canonicalStage: "attack", outcome: "called_hit",
  currentReadinessScore: 100, peakReadinessScore: 100,
  factors: { barrels: 1, hardHits: 2 }, triggerTags: [], positiveDrivers: [],
  alertPath: "PATH_C", useFallbackScore: true,
  gameId: "g5", playerId: "p5", player: "Resolved Bat",
});
eq("E.5 outcome=called_hit stays resolved", e5.userStage, "resolved");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
