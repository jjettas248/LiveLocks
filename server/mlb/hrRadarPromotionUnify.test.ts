/**
 * HR Radar promotion-path unification (Lane 1) — invariant test.
 *
 * Covers:
 *   - deriveCanonicalPromotionIntent: probability→canonical-event mapping +
 *     hysteresis (sustain) + no-op on uninitialized snapshot.
 *   - PITCHER_FADE reachability through the pure FSM (previously dead event).
 *   - BARREL-after-PROMOTE idempotency (contact-evidence floor preserved).
 *   - terminal lock still rejects prob-rail events.
 *
 * Run: npx tsx server/mlb/hrRadarPromotionUnify.test.ts
 */

import {
  deriveCanonicalPromotionIntent,
  type HRAlertSnapshot,
  type DynamicHRState,
  type HrRadarStage,
} from "./hrAlertEngine";
import { applyHrRadarLifecycleEvent } from "./hrRadarStateMachine";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)} actual=${String(actual)}`);
}

// Minimal full snapshot with overrides.
function snap(overrides: Partial<HRAlertSnapshot>): HRAlertSnapshot {
  return {
    isInitialized: true,
    currentState: "WATCH" as DynamicHRState,
    detectedInning: 3,
    detectedHalf: "top",
    detectedAtMs: Date.now(),
    currentInning: 5,
    lastStateChangeAt: Date.now(),
    dataFreshnessMs: 0,
    tickCount: 5,
    lastRecomputeAt: Date.now(),
    decayFactor: 1,
    buildScore: 4,
    hrReadinessScore: 70,
    peakReadinessScore: 80,
    hrConversionProbabilityRaw: 0.18,
    hrConversionProbabilityCalibrated: 0.13,
    peakConversionProbability: 0.16,
    peakScore: 0.16,
    remainingPAExpectation: 2,
    positiveDrivers: [],
    negativeSuppressors: [],
    cooldownReason: null,
    pitcherHrVulnerability: 50,
    peakState: "PREPARE" as DynamicHRState,
    peakAt: Date.now(),
    alertResult: null as any,
    canonicalStage: "building" as HrRadarStage,
    consecutivePromoteTicks: 0,
    ...overrides,
  };
}

console.log("\n=== HR Radar Promotion Unification — Invariant Suite ===\n");
console.log("deriveCanonicalPromotionIntent — mapping + hysteresis");

// No-op when absent / uninitialized (additive, safe).
eq("M.1 null snapshot → no-op", deriveCanonicalPromotionIntent(null).event, null);
eq("M.2 uninitialized snapshot → no-op",
  deriveCanonicalPromotionIntent(snap({ isInitialized: false })).event, null);

// WATCH → CONTACT_EVIDENCE (floor watch), emitted immediately.
{
  const i = deriveCanonicalPromotionIntent(snap({ currentState: "WATCH" }));
  eq("M.3 WATCH → CONTACT_EVIDENCE", i.event, "CONTACT_EVIDENCE");
  eq("M.3 WATCH floor=watch", i.floor, "watch");
}

// PREPARE → build (immediate, lower-stakes).
{
  const i = deriveCanonicalPromotionIntent(snap({ currentState: "PREPARE", canonicalStage: "building" }));
  eq("M.4 PREPARE → PROMOTE build", i.event, "PROMOTE");
  eq("M.4 PREPARE promoteTo=build", i.promoteTo, "build");
}

// BET_NOW + attack but NOT sustained → no-op (hysteresis holds).
{
  const i = deriveCanonicalPromotionIntent(snap({ currentState: "BET_NOW", canonicalStage: "attack", consecutivePromoteTicks: 1 }));
  eq("M.5 BET_NOW+attack sustain=1 → no-op", i.event, null);
}

// BET_NOW + attack + sustained → PROMOTE ready.
{
  const i = deriveCanonicalPromotionIntent(snap({ currentState: "BET_NOW", canonicalStage: "attack", consecutivePromoteTicks: 2 }));
  eq("M.6 BET_NOW+attack sustain=2 → PROMOTE", i.event, "PROMOTE");
  eq("M.6 promoteTo=ready", i.promoteTo, "ready");
  eq("M.6 floor=ready", i.floor, "ready");
}

// Pitcher fade — high vuln + building + sustained → PITCHER_FADE (floor ready).
{
  const i = deriveCanonicalPromotionIntent(snap({ currentState: "PREPARE", pitcherHrVulnerability: 82, consecutivePromoteTicks: 2 }));
  eq("M.7 high pitcher vuln sustained → PITCHER_FADE", i.event, "PITCHER_FADE");
  eq("M.7 PITCHER_FADE floor=ready", i.floor, "ready");
}
{
  const i = deriveCanonicalPromotionIntent(snap({ currentState: "PREPARE", pitcherHrVulnerability: 82, consecutivePromoteTicks: 1 }));
  eq("M.8 high pitcher vuln NOT sustained → no-op", i.event, null);
}

// COOLED_OFF / CLOSED → never emit (FSM owns decay + terminal).
eq("M.9 COOLED_OFF → no-op", deriveCanonicalPromotionIntent(snap({ currentState: "COOLED_OFF" })).event, null);
eq("M.10 CLOSED → no-op", deriveCanonicalPromotionIntent(snap({ currentState: "CLOSED" })).event, null);

console.log("\napplyHrRadarLifecycleEvent — Lane 1 FSM invariants");

// PITCHER_FADE is now reachable: watch/build → ready.
eq("F.1 PITCHER_FADE from watch → ready",
  applyHrRadarLifecycleEvent("watch", "PITCHER_FADE").nextState, "ready");
eq("F.2 PITCHER_FADE from build → ready",
  applyHrRadarLifecycleEvent("build", "PITCHER_FADE").nextState, "ready");
eq("F.3 PITCHER_FADE idempotent at ready",
  applyHrRadarLifecycleEvent("ready", "PITCHER_FADE").nextState, "ready");

// PROMOTE to ready (prob rail), then BARREL must NOT undo the floor — BARREL is
// idempotent at/above build, so the ready state is preserved.
{
  const promoted = applyHrRadarLifecycleEvent("watch", "PROMOTE", { promoteTo: "ready" });
  eq("F.4 PROMOTE watch→ready ok", promoted.nextState, "ready");
  const afterBarrel = applyHrRadarLifecycleEvent(promoted.nextState, "BARREL");
  eq("F.5 BARREL after PROMOTE stays ready (floor preserved)", afterBarrel.nextState, "ready");
}

// PROMOTE not-strictly-higher is rejected (the orchestrator rank-guards this,
// but the FSM must reject defensively).
{
  const r = applyHrRadarLifecycleEvent("ready", "PROMOTE", { promoteTo: "build" });
  eq("F.6 PROMOTE ready→build rejected", r.ok, false);
}

// Terminal lock still rejects prob-rail events.
eq("F.7 terminal cashed rejects PROMOTE",
  applyHrRadarLifecycleEvent("cashed", "PROMOTE", { promoteTo: "fire" }).ok, false);
eq("F.8 terminal expired rejects PITCHER_FADE",
  applyHrRadarLifecycleEvent("expired", "PITCHER_FADE").ok, false);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) { for (const f of failures) console.log(` - ${f}`); process.exit(1); }
process.exit(0);
