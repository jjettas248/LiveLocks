/**
 * HR Radar late-game barrel promotion — invariant test.
 *
 * Locks the 2026-07 tightening of `late_game_power_build` from inning>=6 to
 * inning>=7 && PA>=3 (with the spec's EV/LA/distance bands), and the
 * "Late-game HR-shaped contact" driver string it now attaches.
 *
 * Fixture: Amed Rosario — 110.9 mph / 18° LA / 361 ft barrel in the top of
 * the 8th (AB#4), HR in the bottom of the 9th. Before this fix the radar
 * never promoted him past Track; the qualifying-signal thresholds below are
 * drawn directly from that contact.
 *
 * Run: npx tsx server/mlb/hrRadarLateGamePromotion.test.ts
 */

import {
  deriveQualifyingSignals,
  deriveSuggestedUserStageFromSignals,
  QUALIFYING_SIGNAL_DRIVER_LABEL,
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

console.log("\n=== HR Radar Late-Game Barrel Promotion — Invariant Suite ===\n");

// ── A. Amed Rosario fixture: inning=8 (T8), PA=4, barrel 110.9/18/361 ──────
const rosarioSignals = deriveQualifyingSignals({
  factors: { barrels: 1, maxEV: 110.9, maxLA: 18, maxDistance: 361 },
  triggerTags: [],
  inning: 8,
  positiveDrivers: [],
  conversionProbability: null,
  paCount: 4,
});
assert("A.1 Rosario fixture yields late_game_power_build",
  rosarioSignals.includes("late_game_power_build"), rosarioSignals.join(","));
eq("A.2 Rosario fixture suggested stage >= ready (Playable)",
  deriveSuggestedUserStageFromSignals({ qualifyingSignals: rosarioSignals }), "ready");

const rosarioRow = enrichWithUserStage({
  legacyTier: "monitor", legacyState: "watching", dynamicState: "WATCH",
  canonicalStage: "watch", outcome: "pending",
  currentReadinessScore: 20, peakReadinessScore: 20,
  factors: { barrels: 1, maxEV: 110.9, maxLA: 18, maxDistance: 361 },
  triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.05, confidenceScore: 3, inning: 8, alertPath: null,
  useFallbackScore: true, paCount: 4,
  detectedAt: "2026-06-15T02:10:00.000Z", detectedInning: 8,
  signalDetectedAt: "2026-06-15T02:10:00.000Z", signalInning: 8,
  gameId: "g-rosario", playerId: "p-rosario", player: "Amed Rosario",
});
eq("A.3 Rosario row userStage=ready (Playable)", rosarioRow.userStage, "ready");
eq("A.4 Rosario row playabilityStatus=playable", rosarioRow.playabilityStatus, "playable");
assert("A.5 Rosario row firstPlayableAt stamped (before a later hrOccurredAt)",
  rosarioRow.firstPlayableAt != null, `firstPlayableAt=${rosarioRow.firstPlayableAt}`);
assert("A.6 Rosario row carries the late-game driver",
  rosarioRow.cleanReasons.includes("Late-game HR-shaped contact"), rosarioRow.cleanReasons.join(","));

// ── B. Driver label mapping ─────────────────────────────────────────────────
eq("B.1 late_game_power_build driver label",
  QUALIFYING_SIGNAL_DRIVER_LABEL.late_game_power_build, "Late-game HR-shaped contact");

// ── C. Old inning>=6 threshold alone no longer auto-promotes (tightened) ───
const inning6Only = deriveQualifyingSignals({
  factors: { barrels: 0, hardHits: 0, deepFlyouts: 0, maxEV: 93, avgEV: 93, maxLA: 20, maxDistance: 300 },
  triggerTags: [],
  inning: 6,
  positiveDrivers: [],
  conversionProbability: null,
  paCount: 3,
});
assert("C.1 inning=6 + soft contact (no barrel/band match) no longer flags late_game_power_build",
  !inning6Only.includes("late_game_power_build"), inning6Only.join(","));

// ── D. inning>=7 without PA>=3 does not qualify when paCount is known ──────
const lowPaCount = deriveQualifyingSignals({
  factors: { barrels: 1, maxEV: 110, maxLA: 20, maxDistance: 350 },
  triggerTags: [],
  inning: 7,
  positiveDrivers: [],
  conversionProbability: null,
  paCount: 2,
});
assert("D.1 inning=7 + PA=2 (barrel) does not qualify — PA gate enforced",
  !lowPaCount.includes("late_game_power_build"), lowPaCount.join(","));

// ── E. PA data absent — inning>=7 tightening still applies as a no-op-safe floor ──
const paAbsent = deriveQualifyingSignals({
  factors: { barrels: 1, maxEV: 110, maxLA: 20, maxDistance: 350 },
  triggerTags: [],
  inning: 7,
  positiveDrivers: [],
  conversionProbability: null,
  paCount: null,
});
assert("E.1 inning=7 + barrel + paCount absent still qualifies (PA gate is a no-op when unknown)",
  paAbsent.includes("late_game_power_build"), paAbsent.join(","));

// ── F. EV/LA band conditions (spec-exact) ───────────────────────────────────
const bandA = deriveQualifyingSignals({
  factors: { barrels: 0, maxEV: 106, maxLA: 20, maxDistance: 300 },
  inning: 7, paCount: 3, triggerTags: [], positiveDrivers: [], conversionProbability: null,
});
assert("F.1 EV>=105 && LA in [12,32] band qualifies", bandA.includes("late_game_power_build"), bandA.join(","));

const bandB = deriveQualifyingSignals({
  factors: { barrels: 0, maxEV: 101, maxLA: 25, maxDistance: 345 },
  inning: 7, paCount: 3, triggerTags: [], positiveDrivers: [], conversionProbability: null,
});
assert("F.2 EV>=100 && LA in [18,35] && distance>=340 band qualifies", bandB.includes("late_game_power_build"), bandB.join(","));

const bandMiss = deriveQualifyingSignals({
  factors: { barrels: 0, maxEV: 101, maxLA: 25, maxDistance: 300 },
  inning: 7, paCount: 3, triggerTags: [], positiveDrivers: [], conversionProbability: null,
});
assert("F.3 EV>=100/LA-ok but distance<340 does NOT qualify (distance gate enforced)",
  !bandMiss.includes("late_game_power_build"), bandMiss.join(","));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
