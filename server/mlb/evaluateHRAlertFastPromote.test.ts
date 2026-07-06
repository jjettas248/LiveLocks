/**
 * evaluateHRAlert FAST_PROMOTE corroboration — invariant test.
 *
 * Precision restructure (2026-07): the FAST_PROMOTE_* surface in
 * evaluateHRAlert.ts used to let several single-batted-ball events reach
 * `alertTier: "officialAlert"` (a graded "call") with no real corroboration —
 * including a genuine bug where FAST_PROMOTE_BARREL_PLUS's "second dangerous
 * contact" check was trivially satisfied by the SAME swing that made it a
 * barrel. This suite locks the fix: `countDistinctDangerousContacts` counts
 * genuinely distinct swings, and each affected FAST_PROMOTE branch now
 * requires real corroboration (a second distinct dangerous contact, a second
 * HR-shaped/missed-HR event, or strong pitcher/park context) before reaching
 * officialAlert — a lone qualifying event downgrades to Building instead.
 *
 * Run: npx tsx server/mlb/evaluateHRAlertFastPromote.test.ts
 */

import { evaluateHRAlert, countDistinctDangerousContacts, type HRAlertInput } from "./evaluateHRAlert";
import type { ClassifiedContact } from "./HRSignalBuilder";

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

console.log("\n=== evaluateHRAlert FAST_PROMOTE corroboration — Invariant Suite ===\n");

// ── countDistinctDangerousContacts — direct coverage ──────────────────────
console.log("countDistinctDangerousContacts — distinct-swing counting");

function contact(o: Partial<ClassifiedContact> = {}): ClassifiedContact {
  return {
    contactClass: "noiseContact",
    exitVelocity: null,
    launchAngle: null,
    distance: null,
    outcome: "out",
    isBarrel: false,
    dataQuality: "full",
    missingFields: [],
    ...o,
  };
}

eq("a single barrel swing (EV well above hard-hit floor) counts as ONE distinct danger, not two",
  countDistinctDangerousContacts([
    contact({ isBarrel: true, exitVelocity: 104, launchAngle: 27, distance: 410, outcome: "home_run" }),
  ]), 1);

eq("two genuinely separate dangerous swings count as two",
  countDistinctDangerousContacts([
    contact({ isBarrel: true, exitVelocity: 104, launchAngle: 27, distance: 410, outcome: "home_run" }),
    contact({ exitVelocity: 97, launchAngle: 22, distance: 340, outcome: "field_out" }),
  ]), 2);

eq("a non-dangerous contact (weak EV, not a barrel, not a deep flyout) contributes zero",
  countDistinctDangerousContacts([
    contact({ isBarrel: false, exitVelocity: 78, launchAngle: 10, distance: 120, outcome: "field_out" }),
  ]), 0);

eq("a deep-flyout-shaped out (EV<95, distance>=DEEP_FLY_DISTANCE, outcome=out) counts once",
  countDistinctDangerousContacts([
    contact({ isBarrel: false, exitVelocity: 90, launchAngle: 25, distance: 335, outcome: "out" }),
  ]), 1);

eq("mixed: one barrel + one weak contact = 1 distinct danger (weak one doesn't count)",
  countDistinctDangerousContacts([
    contact({ isBarrel: true, exitVelocity: 102, launchAngle: 28, distance: 400, outcome: "home_run" }),
    contact({ isBarrel: false, exitVelocity: 70, launchAngle: 5, distance: 90, outcome: "field_out" }),
  ]), 1);

// ── Full evaluateHRAlert() branch coverage ────────────────────────────────
console.log("\nevaluateHRAlert — FAST_PROMOTE branch corroboration");

function defaultFactors(o: Partial<HRAlertInput["factors"]> = {}): HRAlertInput["factors"] {
  return {
    avgEV: null, maxEV: null, avgLA: null,
    barrels: 0, hardHits: 0, deepFlyouts: 0, solidContactCount: 0,
    batSpeedScore: 0, pitcherFatigueBoost: 0, parkWindBoost: 0, platoonBoost: 0,
    hrShapedCount: 0, missedHrCount: 0, eliteHrCount: 0,
    qualifiedEVMean: null, maxDistance: null,
    contactClasses: [],
    batSpeedPowerScore: 0, batSpeedZ: 0, airDangerScore: 0,
    hitterPowerProfileScore: 0, hitterPowerProfileFlags: [],
    warningContactCount: 0, deadPopupCount: 0, airBallWarningCount: 0, batSpeedWarningCount: 0,
    maxXBA: null, avgXBA: null, batSpeedMph: null,
    ...o,
  } as HRAlertInput["factors"];
}

// Generous, realistic BATTER-side power context applied UNIFORMLY across
// every fixture below, so conversion probability clears the
// HR_CONVERSION_OFFICIAL_MIN (0.15) floor identically in both the
// "corroborated" and "uncorroborated" variant of each test — isolating the
// corroboration check as the only variable that differs between them.
// Deliberately does NOT touch pitchCount/timesThrough/era/parkFactor/wind —
// those drive `pitcherFavorable`/`envFavorable`, which are themselves valid
// corroborators for some branches under test, so leaving them at neutral
// defaults (pitcherFavorable=false, envFavorable=false) keeps the
// "uncorroborated" fixtures genuinely uncorroborated.
function baseInput(o: Partial<HRAlertInput> = {}): HRAlertInput {
  return {
    playerId: "test-player", playerName: "Test Slugger", teamAbbr: "TST", gameId: "test-game",
    hrBuildScore: 5, hrIntensity: "watch",
    factors: defaultFactors(),
    inning: 5,
    priorABResults: [],
    seasonHRRate: 0.09, barrelRate: 0.22, hardHitRate: 0.55, xSLG: 0.650,
    hrRateLast7: 0.18, hrRateLast15: 0.15, hrRateLast30: 0.12,
    battingOrderSlot: 4,
    ...o,
  };
}

// A single elite-shaped barrel, comfortably high EV/distance/qualifiedEVMean
// so the conversion-probability gate clears regardless of corroboration —
// isolating the corroboration check as the only variable under test.
const eliteBarrelContact = contact({
  isBarrel: true, exitVelocity: 105, launchAngle: 27, distance: 410, outcome: "home_run",
});
const secondDangerousContact = contact({
  isBarrel: false, exitVelocity: 97, launchAngle: 24, distance: 350, outcome: "field_out",
});

// FAST_PROMOTE_SINGLE_ELITE — one elite HR-shaped contact, no corroborator.
const singleEliteUncorroborated = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    eliteHrCount: 1, barrels: 1, hardHits: 1,
    qualifiedEVMean: 105, maxDistance: 410,
    contactClasses: [eliteBarrelContact],
  }),
}));
assert("FAST_PROMOTE_SINGLE_ELITE: one elite event alone does NOT reach officialAlert",
  singleEliteUncorroborated.alertTier !== "officialAlert",
  `alertTier=${singleEliteUncorroborated.alertTier} alertPath=${singleEliteUncorroborated.diagnostics.alertPath}`);

// Same elite event, now corroborated by a second HR-shaped contact.
const singleEliteCorroborated = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    eliteHrCount: 1, barrels: 1, hardHits: 1, hrShapedCount: 2,
    qualifiedEVMean: 105, maxDistance: 410,
    contactClasses: [eliteBarrelContact, secondDangerousContact],
  }),
}));
eq("FAST_PROMOTE_SINGLE_ELITE: corroborated by a second HR-shaped event → officialAlert",
  singleEliteCorroborated.alertTier, "officialAlert");

// FAST_PROMOTE_BARREL_XBA — barrel + high xBA, no corroborator.
const barrelXbaUncorroborated = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 1, maxXBA: 0.55,
    qualifiedEVMean: 100, maxDistance: 380,
    contactClasses: [eliteBarrelContact],
  }),
}));
assert("FAST_PROMOTE_BARREL_XBA: barrel + xBA alone does NOT reach officialAlert",
  barrelXbaUncorroborated.alertTier !== "officialAlert",
  `alertTier=${barrelXbaUncorroborated.alertTier} alertPath=${barrelXbaUncorroborated.diagnostics.alertPath}`);

// Codex review fix: missedHrCount is NOT a valid corroborator for this
// branch, because its base gate (barrels>=1 && maxXBA>=0.400) is not scoped
// to a contactClass — the SAME swing that's a barrel with high xBA can also
// independently be classified missedHrContact (common for near-miss
// barrels), so missedHrCount>=1 can be satisfied by that identical event,
// not a second one. Simulate exactly that: one contact, isBarrel+high xBA,
// AND factors.missedHrCount=1 (as if this one swing was classified
// missedHrContact) — must NOT reach officialAlert on missedHrCount alone.
const barrelXbaSameSwingMissedHr = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 1, maxXBA: 0.55, missedHrCount: 1,
    qualifiedEVMean: 100, maxDistance: 380,
    contactClasses: [eliteBarrelContact],
  }),
}));
assert("FAST_PROMOTE_BARREL_XBA: missedHrCount>=1 from the SAME swing does NOT corroborate",
  barrelXbaSameSwingMissedHr.alertTier !== "officialAlert",
  `alertTier=${barrelXbaSameSwingMissedHr.alertTier} alertPath=${barrelXbaSameSwingMissedHr.diagnostics.alertPath}`);

const barrelXbaCorroborated = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 1, maxXBA: 0.55, hrShapedCount: 2,
    qualifiedEVMean: 100, maxDistance: 380,
    contactClasses: [eliteBarrelContact, secondDangerousContact],
  }),
}));
eq("FAST_PROMOTE_BARREL_XBA: corroborated by a genuinely distinct second HR-shaped event → officialAlert",
  barrelXbaCorroborated.alertTier, "officialAlert");

// FAST_PROMOTE_EV_XBA — hard EV + high xBA, no barrel, no corroborator.
const evXbaUncorroborated = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    maxEV: 101, maxXBA: 0.60, qualifiedEVMean: 101, maxDistance: 370,
    contactClasses: [contact({ isBarrel: false, exitVelocity: 101, launchAngle: 12, distance: 370, outcome: "field_out" })],
  }),
}));
assert("FAST_PROMOTE_EV_XBA: EV+xBA alone (no barrel, no corroborator) does NOT reach officialAlert",
  evXbaUncorroborated.alertTier !== "officialAlert",
  `alertTier=${evXbaUncorroborated.alertTier} alertPath=${evXbaUncorroborated.diagnostics.alertPath}`);

const evXbaCorroborated = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    maxEV: 101, maxXBA: 0.60, hrShapedCount: 2, qualifiedEVMean: 101, maxDistance: 370,
    contactClasses: [
      contact({ isBarrel: false, exitVelocity: 101, launchAngle: 12, distance: 370, outcome: "field_out" }),
      secondDangerousContact,
    ],
  }),
}));
eq("FAST_PROMOTE_EV_XBA: corroborated by hrShapedCount>=2 → officialAlert",
  evXbaCorroborated.alertTier, "officialAlert");

// FAST_PROMOTE_BARREL_PLUS — the original bug: one barrel swing used to
// satisfy its own "second dangerous contact" check via the same event.
const barrelPlusSingleSwing = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 1, qualifiedEVMean: 105, maxDistance: 410,
    contactClasses: [eliteBarrelContact],
  }),
}));
assert("FAST_PROMOTE_BARREL_PLUS: a single barrel swing no longer self-satisfies corroboration",
  barrelPlusSingleSwing.alertTier !== "officialAlert",
  `alertTier=${barrelPlusSingleSwing.alertTier} alertPath=${barrelPlusSingleSwing.diagnostics.alertPath}`);

const barrelPlusTwoSwings = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 2, qualifiedEVMean: 105, maxDistance: 410,
    contactClasses: [eliteBarrelContact, secondDangerousContact],
  }),
}));
eq("FAST_PROMOTE_BARREL_PLUS: barrel + a genuinely distinct second dangerous contact → officialAlert",
  barrelPlusTwoSwings.alertTier, "officialAlert");

// FAST_PROMOTE_ELITE — now requires 3 signals: elite barrel (raised bar) +
// collapsing pitcher + a second distinct dangerous contact.
const eliteBarrelRaisedBar = contact({
  isBarrel: true, exitVelocity: 104, launchAngle: 26, distance: 398, outcome: "home_run",
});
const eliteTwoSignalsOnly = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 1, qualifiedEVMean: 104, maxDistance: 398,
    contactClasses: [eliteBarrelRaisedBar],
  }),
  isPitcherCollapsing: true,
}));
assert("FAST_PROMOTE_ELITE: elite barrel + collapsing pitcher alone (2 signals) no longer reaches officialAlert via this path",
  eliteTwoSignalsOnly.diagnostics.alertPath !== "FAST_PROMOTE_ELITE",
  `alertPath=${eliteTwoSignalsOnly.diagnostics.alertPath} alertTier=${eliteTwoSignalsOnly.alertTier}`);

const eliteThreeSignals = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, hardHits: 2, qualifiedEVMean: 104, maxDistance: 398,
    contactClasses: [eliteBarrelRaisedBar, secondDangerousContact],
  }),
  isPitcherCollapsing: true,
}));
eq("FAST_PROMOTE_ELITE: elite barrel + collapsing pitcher + second distinct dangerous contact (3 signals) → officialAlert",
  eliteThreeSignals.alertTier, "officialAlert");
eq("FAST_PROMOTE_ELITE: alertPath confirms the fast-fire path fired",
  eliteThreeSignals.diagnostics.alertPath, "FAST_PROMOTE_ELITE");

// FAST_PROMOTE_CONVICTION_BRIDGE — now requires totalHrShaped >= 2, not >= 1.
const bridgeOneShaped = evaluateHRAlert(baseInput({
  hrBuildScore: 9.0,
  factors: defaultFactors({
    hrShapedCount: 1, qualifiedEVMean: 100, maxDistance: 370,
    contactClasses: [contact({ isBarrel: false, exitVelocity: 100, launchAngle: 24, distance: 370, outcome: "field_out" })],
  }),
}));
assert("FAST_PROMOTE_CONVICTION_BRIDGE: totalHrShaped=1 no longer reaches this path",
  bridgeOneShaped.diagnostics.alertPath !== "FAST_PROMOTE_CONVICTION_BRIDGE",
  `alertPath=${bridgeOneShaped.diagnostics.alertPath} alertTier=${bridgeOneShaped.alertTier}`);

const bridgeTwoShaped = evaluateHRAlert(baseInput({
  hrBuildScore: 9.0,
  factors: defaultFactors({
    hrShapedCount: 2, qualifiedEVMean: 100, maxDistance: 370,
    contactClasses: [
      contact({ isBarrel: false, exitVelocity: 100, launchAngle: 24, distance: 370, outcome: "field_out" }),
      secondDangerousContact,
    ],
  }),
}));
eq("FAST_PROMOTE_CONVICTION_BRIDGE: totalHrShaped=2 reaches officialAlert",
  bridgeTwoShaped.alertTier, "officialAlert");

// FAST_PROMOTE_BARREL_BATSPEED — hygiene: floor raised 70→72mph, still capped
// at prepare (never officialAlert) either way.
const batSpeedBelowNewFloor = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, batSpeedMph: 71, qualifiedEVMean: 90, maxDistance: 300,
    contactClasses: [contact({ isBarrel: true, exitVelocity: 96, launchAngle: 26, distance: 300, outcome: "field_out" })],
  }),
}));
assert("FAST_PROMOTE_BARREL_BATSPEED: 71mph (below new 72mph floor) does not take this path",
  batSpeedBelowNewFloor.diagnostics.alertPath !== "FAST_PROMOTE_BARREL_BATSPEED",
  `alertPath=${batSpeedBelowNewFloor.diagnostics.alertPath}`);

const batSpeedAtNewFloor = evaluateHRAlert(baseInput({
  factors: defaultFactors({
    barrels: 1, batSpeedMph: 72, qualifiedEVMean: 90, maxDistance: 300,
    contactClasses: [contact({ isBarrel: true, exitVelocity: 96, launchAngle: 26, distance: 300, outcome: "field_out" })],
  }),
}));
eq("FAST_PROMOTE_BARREL_BATSPEED: 72mph (new floor) still only reaches prepare, never officialAlert",
  batSpeedAtNewFloor.alertTier, "prepare");

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
