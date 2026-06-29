// Pre-Game Power Radar — v2 SHADOW leakage guard invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/math/leakageGuard.test.ts

import {
  isLiveOnlyFeatureName,
  isPredictionBeforeFirstPitch,
  assertPregameFeatureAllowed,
  filterLeakyFeatures,
  buildLeakageWarnings,
  PregameLeakageError,
} from "./leakageGuard";
import type { FeatureProvenance } from "./mathTypes";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Live-only feature names are rejected ──────────────────────────────────────
for (const name of [
  "currentGameEV", "current_game_launch_angle", "currentGameBarrel", "currentGameHardHit",
  "currentPitchCount", "currentCount", "currentBaseOut", "currentInning",
  "livePitcherDeterioration", "liveCommandDecay", "liveWind", "currentGameSpray",
  "currentGameStatcast",
]) {
  ok(isLiveOnlyFeatureName(name), `live-only rejected: ${name}`);
}

// ── Season / pre-first-pitch features are allowed ─────────────────────────────
for (const name of [
  "xISO", "seasonBarrelRate", "hrPer9VsHand", "battingOrderSlot", "parkHrFactor",
  "forecastWindSpeed", "rolling30HrPerPa", "batSpeedSeason",
]) {
  ok(!isLiveOnlyFeatureName(name), `pregame allowed: ${name}`);
}

// ── assertPregameFeatureAllowed throws only on live-only names ────────────────
let threw = false;
try { assertPregameFeatureAllowed("currentGameBarrel"); } catch (e) { threw = e instanceof PregameLeakageError; }
ok(threw, "assert throws on live-only feature");
let threw2 = false;
try { assertPregameFeatureAllowed("xISO"); } catch { threw2 = true; }
ok(!threw2, "assert does not throw on season feature");

// ── Prediction-before-first-pitch window ──────────────────────────────────────
ok(isPredictionBeforeFirstPitch("2026-06-26T22:00:00Z", "2026-06-26T23:05:00Z"), "pred before FP → true");
ok(!isPredictionBeforeFirstPitch("2026-06-26T23:30:00Z", "2026-06-26T23:05:00Z"), "pred after FP → false");
ok(!isPredictionBeforeFirstPitch(null, "2026-06-26T23:05:00Z"), "missing pred ts → false");
ok(!isPredictionBeforeFirstPitch("2026-06-26T22:00:00Z", undefined), "missing FP ts → false");

// ── filterLeakyFeatures partitions; never throws on partial input ─────────────
const features: FeatureProvenance[] = [
  { name: "xISO", phase: "season" },
  { name: "currentGameBarrel", phase: "live" },
  { name: "parkHrFactor", phase: "pregame" },
  { name: "someStat", phase: "live" }, // live by phase even if name is clean
];
const { allowed, rejected } = filterLeakyFeatures(features);
ok(allowed.length === 2, `2 allowed (got ${allowed.length})`);
ok(rejected.length === 2, `2 rejected (got ${rejected.length})`);
ok(filterLeakyFeatures(null).allowed.length === 0, "null input → empty allowed (no throw)");
ok(filterLeakyFeatures(undefined).rejected.length === 0, "undefined input → empty rejected (no throw)");

// ── buildLeakageWarnings: warnings, not exceptions ────────────────────────────
const w1 = buildLeakageWarnings({
  predictionGeneratedAtISO: "2026-06-26T22:00:00Z",
  firstPitchTimeISO: "2026-06-26T23:05:00Z",
  features: [{ name: "xISO", phase: "season" }],
});
ok(w1.length === 0, `clean row → no warnings (got ${JSON.stringify(w1)})`);

const w2 = buildLeakageWarnings({ predictionGeneratedAtISO: null, firstPitchTimeISO: null, features: null });
ok(w2.includes("missing_or_invalid_prediction_timestamp"), "missing pred ts warning");
ok(w2.includes("missing_or_invalid_first_pitch_timestamp"), "missing FP ts warning");

const w3 = buildLeakageWarnings({
  predictionGeneratedAtISO: "2026-06-26T23:30:00Z",
  firstPitchTimeISO: "2026-06-26T23:05:00Z",
  features: [{ name: "currentGameEV", phase: "live" }],
});
ok(w3.includes("prediction_locked_after_first_pitch"), "post-first-pitch lock warning");
ok(w3.some((x) => x.startsWith("live_only_feature:")), "live-only feature warning");

const w4 = buildLeakageWarnings({
  predictionGeneratedAtISO: "2026-06-26T22:00:00Z",
  firstPitchTimeISO: "2026-06-26T23:05:00Z",
  features: [{ name: "xISO", phase: "season", valueTimestamp: "2026-06-27T01:00:00Z" }],
});
ok(w4.some((x) => x.startsWith("feature_timestamp_after_first_pitch:")), "feature ts after FP warning");

console.log(`\nleakageGuard.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
