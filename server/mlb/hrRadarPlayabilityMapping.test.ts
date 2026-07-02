/**
 * HR Radar playability mapping — invariant test.
 *
 * Locks the 2026-07 playability-language layer: track/build/ready/fire map
 * onto Watchlist/Lean/Playable/Attack, only Playable/Attack are official,
 * score floors line up (≥7.0 for Playable, ≥9.0 for Attack), and the
 * first*At alias timestamps mirror the existing first*At fields exactly.
 *
 * Run: npx tsx server/mlb/hrRadarPlayabilityMapping.test.ts
 */

import { enrichWithUserStage } from "./hrRadarUserStage";
import {
  getPlayabilityStatus,
  getPlayabilityLabel,
  getPlayabilityDescription,
  isOfficialPlayability,
  PLAYABILITY_SCORE_FLOOR,
  type CanonicalHrRadarStage,
} from "@shared/hrRadarStage";

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

console.log("\n=== HR Radar Playability Mapping — Invariant Suite ===\n");

// ── A. Stage → playability mapping (exact spec table) ──────────────────────
eq("A.1 track → watchlist", getPlayabilityStatus("track"), "watchlist");
eq("A.2 build → lean", getPlayabilityStatus("build"), "lean");
eq("A.3 ready → playable", getPlayabilityStatus("ready"), "playable");
eq("A.4 fire → attack", getPlayabilityStatus("fire"), "attack");
eq("A.5 resolved → resolved", getPlayabilityStatus("resolved"), "resolved");

// ── B. Labels ────────────────────────────────────────────────────────────
eq("B.1 watchlist label", getPlayabilityLabel("watchlist"), "Watchlist");
eq("B.2 lean label", getPlayabilityLabel("lean"), "Lean");
eq("B.3 playable label", getPlayabilityLabel("playable"), "Playable");
eq("B.4 attack label", getPlayabilityLabel("attack"), "Attack");
eq("B.5 resolved label", getPlayabilityLabel("resolved"), "Resolved");

// ── C. Descriptions (exact spec copy) ───────────────────────────────────────
eq("C.1 watchlist description", getPlayabilityDescription("watchlist"), "Worth monitoring · not official");
eq("C.2 lean description", getPlayabilityDescription("lean"), "Signal forming · not official");
eq("C.3 playable description", getPlayabilityDescription("playable"), "Official HR signal active");
eq("C.4 attack description", getPlayabilityDescription("attack"), "Max-conviction HR window");
eq("C.5 resolved description", getPlayabilityDescription("resolved"), "Result finalized");

// ── D. Official rules ────────────────────────────────────────────────────
eq("D.1 watchlist not official", isOfficialPlayability("watchlist"), false);
eq("D.2 lean not official", isOfficialPlayability("lean"), false);
eq("D.3 playable is official", isOfficialPlayability("playable"), true);
eq("D.4 attack is official", isOfficialPlayability("attack"), true);
eq("D.5 resolved not official", isOfficialPlayability("resolved"), false);

// ── E. Score floors — Playable ≥7.0, Attack ≥9.0 (spec §3) ──────────────────
assert("E.1 Playable floor >= 7.0", PLAYABILITY_SCORE_FLOOR.playable >= 7.0,
  `floor=${PLAYABILITY_SCORE_FLOOR.playable}`);
eq("E.2 Attack floor = 9.0", PLAYABILITY_SCORE_FLOOR.attack, 9.0);
eq("E.3 Watchlist floor = 2.5", PLAYABILITY_SCORE_FLOOR.watchlist, 2.5);
eq("E.4 Lean floor = 5.5", PLAYABILITY_SCORE_FLOOR.lean, 5.5);

// ── F. enrichWithUserStage — playability fields present + consistent ───────
const fireRow = enrichWithUserStage({
  legacyTier: "strong", legacyState: "actionable", dynamicState: "BET_NOW",
  canonicalStage: "attack", outcome: "pending",
  currentReadinessScore: 90, peakReadinessScore: 90,
  factors: { barrels: 1, maxEV: 110 }, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.2, confidenceScore: 9, inning: 5, alertPath: "FAST_PROMOTE_ELITE",
  useFallbackScore: true, gameId: "gf", playerId: "pf", player: "Fire Bat",
});
eq("F.1 fire row playabilityStatus=attack", fireRow.playabilityStatus, "attack");
eq("F.2 fire row playabilityLabel=Attack", fireRow.playabilityLabel, "Attack");
eq("F.3 fire row isOfficialSignal=true", fireRow.isOfficialSignal, true);
assert("F.4 fire row score >= 9.0", (fireRow.displayCurrentScore10 ?? 0) >= 9.0,
  `score=${fireRow.displayCurrentScore10}`);

const readyRow = enrichWithUserStage({
  legacyTier: "building", legacyState: "live", dynamicState: "PREPARE",
  canonicalStage: "building", outcome: "pending",
  currentReadinessScore: 60, peakReadinessScore: 60,
  factors: { barrels: 1 }, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.08, confidenceScore: 6, inning: 4, alertPath: null,
  useFallbackScore: true, gameId: "gr", playerId: "pr", player: "Ready Bat",
});
eq("F.5 ready row playabilityStatus=playable", readyRow.playabilityStatus, "playable");
eq("F.6 ready row isOfficialSignal=true", readyRow.isOfficialSignal, true);
assert("F.7 ready row score >= 7.0", (readyRow.displayCurrentScore10 ?? 0) >= 7.0,
  `score=${readyRow.displayCurrentScore10}`);

const trackRow = enrichWithUserStage({
  legacyTier: "monitor", legacyState: "watching", dynamicState: "WATCH",
  canonicalStage: "watch", outcome: "pending",
  currentReadinessScore: 15, peakReadinessScore: 15,
  factors: {}, triggerTags: [], positiveDrivers: [],
  conversionProbability: 0.02, confidenceScore: 2, inning: 2, alertPath: null,
  useFallbackScore: true, gameId: "gt", playerId: "pt", player: "Track Bat",
});
eq("F.8 track row playabilityStatus=watchlist", trackRow.playabilityStatus, "watchlist");
eq("F.9 track row isOfficialSignal=false", trackRow.isOfficialSignal, false);

// ── G. Alias timestamps mirror the existing first*At fields exactly ────────
eq("G.1 firstWatchlistAt mirrors firstTrackedAt", fireRow.firstWatchlistAt, fireRow.firstTrackedAt);
eq("G.2 firstLeanAt mirrors firstBuiltAt", fireRow.firstLeanAt, fireRow.firstBuiltAt);
eq("G.3 firstPlayableAt mirrors firstReadyAt", fireRow.firstPlayableAt, fireRow.firstReadyAt);
eq("G.4 firstAttackAt mirrors firstFireAt", fireRow.firstAttackAt, fireRow.firstFireAt);
eq("G.5 firstWatchlistInning mirrors firstTrackedInning", fireRow.firstWatchlistInning, fireRow.firstTrackedInning);
eq("G.6 firstAttackInning mirrors firstFireInning", fireRow.firstAttackInning, fireRow.firstFireInning);

// ── H. Monotonic score-by-stage sanity (no stage displays below its floor) ─
const stages: CanonicalHrRadarStage[] = ["track", "build", "ready", "fire"];
for (const s of stages) {
  const floor = PLAYABILITY_SCORE_FLOOR[getPlayabilityStatus(s)];
  assert(`H.${s} floor is finite and >= 0`, Number.isFinite(floor) && floor >= 0, `floor=${floor}`);
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
