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

// Lane 1.4 PRIMARY gate: BET_NOW + canonical=attack + sustained(≥N) + CONTACT driver.
// Hit-rate tightening (2026-06): sustain raised 2→3 and the fire gate now
// requires a CONTACT driver (elite_barrel/two_hard_hit_balls/massive_single_contact),
// not pitcher_collapse_power alone.
// Frequency rebalance (2026-07): sustain floor lowered 3→2 — later found to
// help produce a ~7% real-world hit rate (181 calls / 13 HRs).
// Precision restructure (2026-07): reverted the frequency rebalance and went
// further — sustain floor is now 4 (READY_TO_FIRE_SUSTAIN_TICKS).
eq("A.1 BET_NOW + attack + sustain=4 (new floor) + elite_barrel → fire",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
  }), "fire");

// A.1b sits one tick below the new floor — must NOT fire (this used to fire
// under the 2026-07 frequency-rebalance loosening; that loosening is reverted).
eq("A.1b BET_NOW + attack + sustain=3 (below new floor of 4) + elite_barrel → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 3, qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Negative — pitcher_collapse_power is a STRONG driver but NOT a contact driver;
// it can no longer fire on its own.
eq("A.1c BET_NOW + attack + sustain=4 + pitcher_collapse_power only → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["pitcher_collapse_power"],
  }), "ready");

eq("A.2 BET_NOW + attack + sustain=4 + two_hard_hit_balls → fire",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["two_hard_hit_balls"],
  }), "fire");

// Negative — no strong driver.
eq("A.3 BET_NOW + attack + sustain=4 + only near_barrel (not strong) → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["near_barrel"],
  }), "ready");

// Negative — canonical not attack.
eq("A.4 BET_NOW + canonical=building + sustain=4 + elite_barrel → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "building",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Negative — conviction not sustained (single-tick blip).
eq("A.5 BET_NOW + attack + sustain=1 + elite_barrel → ready (not sustained)",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 1, qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Negative — not BET_NOW (only PREPARE conviction).
eq("A.6 PREPARE + attack + sustain=5 + elite_barrel → ready (not BET_NOW)",
  maybePromoteReadyToFire("ready", {
    dynamicState: "PREPARE", canonicalStage: "attack",
    consecutivePromoteTicks: 5, qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Rule B (secondary fast-path): PATH_PROMOTES_TO_FIRE + signalState === "actionable" → fire.
// Precision restructure (2026-07): "live" dropped from bypass eligibility (see
// isFireBypassEligible in hrRadarUserStage.ts) — it's a weaker in-flight state
// than "actionable" and allowing the bypass off it was inconsistent with
// treating this as a rare, high-bar exception. This is also now shared with
// mapToUserStage's Step 2 bypass so the two can't drift out of sync again.
eq("B.1 alertPath=FAST_PROMOTE_ELITE + signalState=live → ready (no longer bypasses)",
  maybePromoteReadyToFire("ready", {
    alertPath: "FAST_PROMOTE_ELITE", signalState: "live",
    qualifyingSignals: [],
  }), "ready");

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

// C: old magic-number rules are gone — these must NOT promote anymore.
eq("C.1 BET_NOW + attack + strong driver but NO sustain field → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack", displayScore10: 10.0,
    currentReadinessScore: 95, peakReadinessScore: 95,
    qualifyingSignals: ["elite_barrel"],
  }), "ready");

eq("C.2 high displayScore10 alone (no BET_NOW) never fires",
  maybePromoteReadyToFire("ready", {
    displayScore10: 10.0, canonicalStage: "attack",
    consecutivePromoteTicks: 5, qualifyingSignals: ["elite_barrel"],
  }), "ready");

// Non-ready inputs — never promoted.
eq("D.1 stage=track is never promoted",
  maybePromoteReadyToFire("track", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 5, qualifyingSignals: ["elite_barrel"],
  }), "track");

eq("D.2 stage=build is never promoted",
  maybePromoteReadyToFire("build", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 5, qualifyingSignals: ["elite_barrel"],
  }), "build");

eq("D.3 stage=fire is preserved (idempotent)",
  maybePromoteReadyToFire("fire", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 5, qualifyingSignals: ["elite_barrel"],
  }), "fire");

eq("D.4 stage=resolved is preserved (sticky)",
  maybePromoteReadyToFire("resolved", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 5, qualifyingSignals: ["elite_barrel"],
  }), "resolved");

// ── Integration via enrichWithUserStage — reproduce the live bug shape ────
console.log("\nenrichWithUserStage — bug repro (FIRE=0 / READY=16 at 10.0/10)");

// E.1 The forensic case: PATH_C live + BET_NOW + canonical=attack + sustained.
// Pre-fix this stuck at "ready"; post-fix promotes via the Lane 1.4 primary
// gate (BET_NOW + attack + sustained conviction + strong driver).
const e1 = enrichWithUserStage({
  legacyTier: "strong",
  legacyState: "live",
  dynamicState: "BET_NOW",
  canonicalStage: "attack",
  consecutivePromoteTicks: 4,
  outcome: "pending",
  currentReadinessScore: 100, peakReadinessScore: 100, initialReadinessScore: 60,
  factors: { barrels: 1, hardHits: 2, maxEV: 110, avgEV: 96 },
  triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.16, confidenceScore: 8,
  inning: 7, alertPath: "PATH_C",
  useFallbackScore: true, gameId: "g1", playerId: "p1", player: "Test Slugger",
});
eq("E.1 PATH_C live + BET_NOW + attack + sustained + strong driver → fire", e1.userStage, "fire");

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

// E.4 FAST_PROMOTE_ELITE @ live — precision restructure (2026-07): "live" no
// longer bypasses to fire (see B.1 above). FAST_PROMOTE_ELITE is still in
// PATH_PROMOTES_TO_READY (legacy mapping Step 3a, state live|actionable), so
// this still reaches READY via the legacy path — it just no longer skips the
// sustain/peak-currency gates all the way to FIRE the way it used to.
const e4 = enrichWithUserStage({
  legacyTier: "building", legacyState: "live", dynamicState: "PREPARE",
  canonicalStage: "building", outcome: "pending",
  currentReadinessScore: 70, peakReadinessScore: 70,
  factors: {}, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.10, confidenceScore: 7,
  inning: 5, alertPath: "FAST_PROMOTE_ELITE",
  useFallbackScore: true, gameId: "g4", playerId: "p4", player: "Elite Promo",
});
eq("E.4 FAST_PROMOTE_ELITE @ live → ready (no longer bypasses straight to fire)", e4.userStage, "ready");

// E.4b FAST_PROMOTE_ELITE @ actionable still bypasses to fire (Rule B retained,
// narrowed to "actionable" only).
const e4b = enrichWithUserStage({
  legacyTier: "building", legacyState: "actionable", dynamicState: "PREPARE",
  canonicalStage: "building", outcome: "pending",
  currentReadinessScore: 70, peakReadinessScore: 70,
  factors: {}, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.10, confidenceScore: 7,
  inning: 5, alertPath: "FAST_PROMOTE_ELITE",
  useFallbackScore: true, gameId: "g4b", playerId: "p4b", player: "Elite Promo Actionable",
});
eq("E.4b FAST_PROMOTE_ELITE @ actionable → fire (Rule B retained)", e4b.userStage, "fire");

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

// ── Fire Gate A — peak currency (no stale peak) ───────────────────────────
console.log("\nmaybePromoteReadyToFire — Gate A peak currency (no stale peak)");

// F.1 Old peak, decayed current AB — must NOT fire even with sustained BET_NOW +
// contact driver. current/peak = 50/100 = 0.5 < 0.90 ⇒ stale peak block.
eq("F.1 BET_NOW + attack + sustain=4 + elite_barrel but current<<peak → ready (stale peak)",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
    currentReadinessScore: 50, peakReadinessScore: 100,
  }), "ready");

// F.1b Precision restructure (2026-07): reverted the frequency-rebalance
// loosening and went further — 0.80 fired under the old 0.75 floor but is now
// BLOCKED under the new 0.90 floor (0.8 < 0.90).
eq("F.1b BET_NOW + attack + sustain=4 + elite_barrel + current/peak=0.8 → ready (below new 0.90 floor)",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
    currentReadinessScore: 80, peakReadinessScore: 100,
  }), "ready");

// F.2 Current right at the new floor (90/100 = 0.90 ≥ 0.90) ⇒ peak is current ⇒ fire.
eq("F.2 BET_NOW + attack + sustain=4 + elite_barrel + current/peak=0.90 (new floor) → fire",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
    currentReadinessScore: 90, peakReadinessScore: 100,
  }), "fire");

// F.2b Current just below the new floor (89/100 = 0.89 < 0.90) ⇒ blocked.
eq("F.2b BET_NOW + attack + sustain=4 + elite_barrel + current/peak=0.89 (just below new floor) → ready",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
    currentReadinessScore: 89, peakReadinessScore: 100,
  }), "ready");

// F.3 Peak unknown/zero ⇒ gate is a no-op (must not fabricate a block) ⇒ fire.
eq("F.3 BET_NOW + attack + sustain=4 + elite_barrel + no readiness scores → fire (gate no-op)",
  maybePromoteReadyToFire("ready", {
    dynamicState: "BET_NOW", canonicalStage: "attack",
    consecutivePromoteTicks: 4, qualifyingSignals: ["elite_barrel"],
  }), "fire");

// F.4 FAST_PROMOTE_ELITE @ actionable still bypasses the peak-currency gate
// (elite barrel is itself the fresh, current evidence) even with a decayed
// current score. Precision restructure (2026-07): must use "actionable", not
// "live" — see B.1.
eq("F.4 FAST_PROMOTE_ELITE @ actionable bypasses stale-peak gate → fire",
  maybePromoteReadyToFire("ready", {
    alertPath: "FAST_PROMOTE_ELITE", signalState: "actionable",
    currentReadinessScore: 10, peakReadinessScore: 100,
    qualifyingSignals: [],
  }), "fire");

// F.4b Same stale-peak scenario but signalState=live — no longer bypasses,
// must fall through to the primary gate, which also fails (no dynamicState/
// canonicalStage/contact-driver set here) ⇒ ready.
eq("F.4b FAST_PROMOTE_ELITE @ live no longer bypasses stale-peak gate → ready",
  maybePromoteReadyToFire("ready", {
    alertPath: "FAST_PROMOTE_ELITE", signalState: "live",
    currentReadinessScore: 10, peakReadinessScore: 100,
    qualifyingSignals: [],
  }), "ready");

// ── FIRE-only official record (officialSignalStage) ───────────────────────
console.log("\nenrichWithUserStage — FIRE-only officialSignalStage");

// G.1 A FIRE row stamps officialSignalStage="fire".
const g1 = enrichWithUserStage({
  legacyTier: "strong", legacyState: "live", dynamicState: "BET_NOW",
  canonicalStage: "attack", consecutivePromoteTicks: 4, outcome: "pending",
  currentReadinessScore: 100, peakReadinessScore: 100,
  factors: { barrels: 1, hardHits: 2, maxEV: 110 }, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.16, confidenceScore: 8, inning: 7, alertPath: "PATH_C",
  useFallbackScore: true, gameId: "gf", playerId: "pf", player: "Fire Bat",
});
eq("G.1 fire row → userStage=fire", g1.userStage, "fire");
eq("G.1 fire row → officialSignalStage=fire", g1.officialSignalStage, "fire");

// G.2 A READY row must NOT stamp an official stage (FIRE-only record).
const g2 = enrichWithUserStage({
  legacyTier: "strong", legacyState: "actionable", dynamicState: "PREPARE",
  canonicalStage: "watch", outcome: "pending",
  currentReadinessScore: 70, peakReadinessScore: 70,
  factors: { barrels: 0, hardHits: 0 }, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.08, confidenceScore: 6, inning: 5, alertPath: "PATH_C",
  useFallbackScore: true, gameId: "gr", playerId: "pr", player: "Ready Bat",
});
eq("G.2 ready row → userStage=ready", g2.userStage, "ready");
eq("G.2 ready row → officialSignalStage=null (READY not official)", g2.officialSignalStage, null);

// G.3 A TRACK row → officialSignalStage=null.
const g3 = enrichWithUserStage({
  legacyTier: "monitor", legacyState: "watching", dynamicState: "WATCH",
  canonicalStage: "watch", outcome: "pending",
  currentReadinessScore: 20, peakReadinessScore: 20,
  factors: {}, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.03, confidenceScore: 2, inning: 2, alertPath: null,
  useFallbackScore: true, gameId: "gt", playerId: "pt", player: "Track Bat",
});
eq("G.3 track row → officialSignalStage=null", g3.officialSignalStage, null);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
