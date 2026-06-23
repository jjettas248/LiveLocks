// Pre-Game Power Radar → live ladder bridge invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/liveBridge.test.ts

import { buildPregamePowerTargetMap, bridgeKey } from "./liveBridge";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<PregamePowerSignal>): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-06-23:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-06-23", gameId: "g1", gameDate: "2026-06-23", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    },
    ...over,
  };
}

// ── Key format ────────────────────────────────────────────────────────────────
ok(bridgeKey("g1", "b1") === "g1:b1", "bridgeKey is `${gameId}:${batterId}`");

// ── Public target included ────────────────────────────────────────────────────
const m1 = buildPregamePowerTargetMap([sig({})]);
ok(m1.has("g1:b1"), "public target present in map");
ok(m1.get("g1:b1")!.tier === "strong" && m1.get("g1:b1")!.score10 === 7 && m1.get("g1:b1")!.primaryMarket === "home_runs", "target ref carries tier/score/market");

// ── Suppressed target excluded ────────────────────────────────────────────────
const m2 = buildPregamePowerTargetMap([sig({ suppressed: true })]);
ok(!m2.has("g1:b1"), "suppressed target excluded");

// ── Distinct game/batter produce distinct keys ────────────────────────────────
const m3 = buildPregamePowerTargetMap([
  sig({ signalId: "a", gameId: "g1", batterId: "b1" }),
  sig({ signalId: "b", gameId: "g2", batterId: "b1" }),
  sig({ signalId: "c", gameId: "g1", batterId: "b2" }),
]);
ok(m3.size === 3, "distinct (game,batter) → distinct keys");

// ── Higher score wins on key collision ────────────────────────────────────────
const m4 = buildPregamePowerTargetMap([
  sig({ signalId: "lo", score10: 6.1, tier: "strong" }),
  sig({ signalId: "hi", score10: 8.0, tier: "elite" }),
]);
ok(m4.get("g1:b1")!.score10 === 8.0 && m4.get("g1:b1")!.tier === "elite", "higher score wins collision");

// ── A live ladder row (gameId + playerId) joins on the same key ───────────────
const map = buildPregamePowerTargetMap([sig({ gameId: "401580", batterId: "660271" })]);
const liveRow = { gameId: "401580", playerId: "660271" };
ok(map.has(bridgeKey(liveRow.gameId, liveRow.playerId)), "live ladder row joins by gameId+playerId");

console.log(`\nliveBridge.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
