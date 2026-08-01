// Pre-Game Power Radar — PR0 Elite-ISO display-suppression isolation invariants.
//
// Proves the `power_iso` ("Elite Isolated Power") change is DISPLAY-ONLY:
//   • the internal PowerDriver is still produced and STILL COUNTED for
//     qualification (countPositiveDrivers / wasPubliclyFlaggedPregame);
//   • the serialized response (buildResponse) EXCLUDES it from the surfaced card;
//   • no other driver is removed and the input signal is never mutated.
//
// Run: npx tsx server/mlb/pregamePowerRadar/eliteIsoDisplaySuppression.test.ts

import { buildResponse, wasPubliclyFlaggedPregame, isPublicPregameSignal, type CoverageCounters } from "./diagnostics";
import { countPositiveDrivers, driverKeysForUniverse, JUL20_POSITIVE_DRIVER_KEYS } from "./modelVersions/plateDriverUniverse";
import { isDisplaySuppressedDriverKey } from "@shared/plateDisplaySuppression";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<PregamePowerSignal> = {}): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [
      { key: "power_iso", label: "Elite Isolated Power", direction: "positive" },
      { key: "pv_hr9", label: "Pitcher Yields HR vs RHB", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
}

const counters: CoverageCounters = {
  gamesScanned: 1, battersEvaluated: 1, lineupCoverage: 1,
  weatherCoverage: 1, batterCoverage: 1, pitcherCoverage: 1,
};

// ── Baseline: qualification observes power_iso (it IS a JUL20 driver) ──────────
ok(JUL20_POSITIVE_DRIVER_KEYS.has("power_iso"), "power_iso is a counted JUL20 qualifying driver");
ok(isDisplaySuppressedDriverKey("power_iso"), "power_iso is display-suppressed");
ok(!isDisplaySuppressedDriverKey("pv_hr9"), "pv_hr9 is NOT display-suppressed");

const s = sig();
const jul20 = driverKeysForUniverse("jul20_restored");

// Qualification snapshot taken from the ORIGINAL signal (unchanged by display).
const countBefore = countPositiveDrivers(s.drivers, jul20);
const publicBefore = isPublicPregameSignal(s);
const flaggedBefore = wasPubliclyFlaggedPregame(s);
ok(countBefore === 2, `original positiveDriverCount counts power_iso (got ${countBefore}, want 2)`);
ok(publicBefore === true, "signal is public before serialization");

// ── Serialize (public path) ───────────────────────────────────────────────────
const resp = buildResponse("2026-07-01", "b", "", "cache", [s], counters, /*includeSuppressed*/ false);
ok(resp.signals.length === 1, "signal survives serialization (still public)");
const outDrivers = resp.signals[0].drivers;

ok(!outDrivers.some((d) => d.key === "power_iso"), "serialized output EXCLUDES power_iso");
ok(outDrivers.some((d) => d.key === "pv_hr9"), "serialized output KEEPS pv_hr9 (no other driver removed)");
ok(outDrivers.length === 1, `exactly one driver removed (got ${outDrivers.length} remaining, want 1)`);

// ── Input never mutated; qualification byte-identical ─────────────────────────
ok(s.drivers.length === 2 && s.drivers.some((d) => d.key === "power_iso"),
  "input signal is NOT mutated (power_iso still present internally)");
ok(countPositiveDrivers(s.drivers, jul20) === countBefore, "positiveDriverCount unchanged after serialization");
ok(isPublicPregameSignal(s) === publicBefore, "publication unchanged after serialization");
ok(wasPubliclyFlaggedPregame(s) === flaggedBefore, "wasPubliclyFlaggedPregame unchanged after serialization");

// ── Admin path (includeSuppressed) also strips display-suppressed keys ─────────
const adminResp = buildResponse("2026-07-01", "b", "", "cache", [s], counters, /*includeSuppressed*/ true);
ok(!adminResp.signals[0].drivers.some((d) => d.key === "power_iso"), "admin serialization also excludes power_iso");

// ── Signals with no suppressed key pass through by reference (no needless clone) ─
const clean = sig({ drivers: [
  { key: "pv_hr9", label: "Pitcher Yields HR vs RHB", direction: "positive" },
  { key: "power_barrel", label: "High Barrel Rate", direction: "positive" },
] });
const cleanResp = buildResponse("2026-07-01", "b", "", "cache", [clean], counters, false);
ok(cleanResp.signals[0] === clean, "signal without a suppressed driver is returned by reference (not cloned)");

console.log(`\nElite-ISO display suppression: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
