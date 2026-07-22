// HR Radar research evaluation-epoch detector — invariants.
//
// Run: npx tsx server/mlb/hrRadarResearch/hrEvaluationEpochDetector.test.ts

import {
  detectHrEvaluationEpoch,
  diffBattingOrder,
  getLastKnownBattingOrder,
  clearHrEpochDetectorStateForGame,
  type HrEpochGameStateSlice,
  type HrEpochBattingOrderEntry,
} from "./hrEvaluationEpochDetector";
import { deriveEvaluationEpochId } from "./hrEvaluationEpochId";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function lineup(ids: string[]): HrEpochBattingOrderEntry[] {
  return ids.map((id, i) => ({ playerId: id, playerName: `P${id}`, team: "NYY", slot: i + 1 }));
}

function baseState(overrides: Partial<HrEpochGameStateSlice> = {}): HrEpochGameStateSlice {
  return {
    inning: 3,
    isTopInning: true,
    pitchCount: 40,
    totalPlays: 10,
    battingOrder: lineup(["1", "2", "3"]),
    homeScore: 1,
    awayScore: 0,
    pitcherInGame: { playerId: "p1" },
    ...overrides,
  };
}

// ── diffBattingOrder ─────────────────────────────────────────────────────────
{
  const prev = lineup(["1", "2", "3"]);
  const next = lineup(["1", "2", "3"]);
  const diff = diffBattingOrder(prev, next);
  ok(diff.added.length === 0 && diff.removed.length === 0 && diff.substituted.length === 0, "identical lineups diff to no changes");
}
{
  const prev = lineup(["1", "2", "3"]);
  const next = [{ playerId: "1", playerName: "P1", team: "NYY", slot: 1 }, { playerId: "9", playerName: "P9", team: "NYY", slot: 2 }, { playerId: "3", playerName: "P3", team: "NYY", slot: 3 }];
  const diff = diffBattingOrder(prev, next);
  ok(diff.substituted.length === 1 && diff.substituted[0].oldPlayerId === "2" && diff.substituted[0].newPlayerId === "9", "same-slot playerId swap detected as substitution");
}
{
  const prev = lineup(["1", "2", "3"]);
  const next = lineup(["1", "3"]);
  const diff = diffBattingOrder(prev, next);
  ok(diff.removed.length === 1 && diff.removed[0].playerId === "2", "batter dropped from lineup detected as removal");
}

// ── No epoch for unchanged / heartbeat ticks ────────────────────────────────
{
  clearHrEpochDetectorStateForGame("gameA");
  const prev = baseState();
  detectHrEvaluationEpoch({ gameId: "gameA", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: null });
  const detected = detectHrEvaluationEpoch({
    gameId: "gameA", prevState: prev, newState: baseState(), stateChangeTriggers: [], newWeatherRoofSignal: null,
  });
  ok(detected === null, "zero-diff tick (identical state, no triggers) detects no epoch");
}
{
  clearHrEpochDetectorStateForGame("gameHeartbeat");
  const prev = baseState();
  detectHrEvaluationEpoch({ gameId: "gameHeartbeat", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: null });
  const detected = detectHrEvaluationEpoch({
    gameId: "gameHeartbeat", prevState: prev, newState: baseState(), stateChangeTriggers: ["heartbeat_refresh"], newWeatherRoofSignal: null,
  });
  ok(detected === null, "heartbeat_refresh-only trigger detects no epoch");
}

// ── First-poll entry ─────────────────────────────────────────────────────────
{
  clearHrEpochDetectorStateForGame("gameEntry");
  const detected = detectHrEvaluationEpoch({
    gameId: "gameEntry", prevState: null, newState: baseState(), stateChangeTriggers: [], newWeatherRoofSignal: null,
  });
  ok(detected?.triggerType === "live_state_entry_with_lineup", "first poll with a non-empty lineup fires live_state_entry_with_lineup");
}

// ── Priority order: lineup_removal beats everything ─────────────────────────
{
  clearHrEpochDetectorStateForGame("gamePriority1");
  const prev = baseState({ pitcherInGame: { playerId: "p1" } });
  detectHrEvaluationEpoch({ gameId: "gamePriority1", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: null });
  const next = baseState({ battingOrder: lineup(["1", "3"]), pitcherInGame: { playerId: "p2" }, inning: 4 });
  const detected = detectHrEvaluationEpoch({
    gameId: "gamePriority1", prevState: prev, newState: next, stateChangeTriggers: ["pitcher_change"], newWeatherRoofSignal: null,
  });
  ok(detected?.triggerType === "lineup_removal", "lineup removal takes priority over a simultaneous pitching change");
}

// ── Priority order: pitching_change beats inning_half_transition ────────────
{
  clearHrEpochDetectorStateForGame("gamePriority2");
  const prev = baseState({ pitcherInGame: { playerId: "p1" }, inning: 3, isTopInning: true });
  detectHrEvaluationEpoch({ gameId: "gamePriority2", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: null });
  const next = baseState({ pitcherInGame: { playerId: "p2" }, inning: 3, isTopInning: false });
  const detected = detectHrEvaluationEpoch({
    gameId: "gamePriority2", prevState: prev, newState: next, stateChangeTriggers: ["pitcher_change"], newWeatherRoofSignal: null,
  });
  ok(detected?.triggerType === "pitching_change", "pitching change takes priority over a simultaneous inning-half transition");
}

// ── pa_complete is scoped per-tick, not conflated across two different PAs ──
{
  clearHrEpochDetectorStateForGame("gamePa");
  const prev = baseState({ totalPlays: 10 });
  detectHrEvaluationEpoch({ gameId: "gamePa", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: null });
  const afterFirstPa = baseState({ totalPlays: 11 });
  const first = detectHrEvaluationEpoch({
    gameId: "gamePa", prevState: prev, newState: afterFirstPa, stateChangeTriggers: ["ab_completed"], newWeatherRoofSignal: null,
  });
  const afterSecondPa = baseState({ totalPlays: 12 });
  const second = detectHrEvaluationEpoch({
    gameId: "gamePa", prevState: afterFirstPa, newState: afterSecondPa, stateChangeTriggers: ["ab_completed"], newWeatherRoofSignal: null,
  });
  ok(first?.triggerType === "pa_complete" && second?.triggerType === "pa_complete", "two consecutive completed PAs both fire pa_complete");
  ok(first?.sourceEventId !== second?.sourceEventId, "two distinct PAs get distinct sourceEventIds — not conflated into one epoch");
}

// ── weather/roof material change ────────────────────────────────────────────
{
  clearHrEpochDetectorStateForGame("gameWeather");
  const prev = baseState();
  detectHrEvaluationEpoch({
    gameId: "gameWeather", prevState: null, newState: prev, stateChangeTriggers: [],
    newWeatherRoofSignal: { roofTypeRaw: "Retractable Roof", weatherConditionRaw: "Roof Closed", isIndoors: true },
  });
  const detected = detectHrEvaluationEpoch({
    gameId: "gameWeather", prevState: prev, newState: baseState(), stateChangeTriggers: [],
    newWeatherRoofSignal: { roofTypeRaw: "Retractable Roof", weatherConditionRaw: "Roof Open", isIndoors: false },
  });
  ok(detected?.triggerType === "weather_roof_change", "roof state flipping open detects weather_roof_change");
}
{
  clearHrEpochDetectorStateForGame("gameWeatherSame");
  const prev = baseState();
  const signal = { roofTypeRaw: "Open Air", weatherConditionRaw: "Clear", isIndoors: false };
  detectHrEvaluationEpoch({ gameId: "gameWeatherSame", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: signal });
  const detected = detectHrEvaluationEpoch({
    gameId: "gameWeatherSame", prevState: prev, newState: baseState(), stateChangeTriggers: [], newWeatherRoofSignal: { ...signal },
  });
  ok(detected === null, "identical weather/roof signal detects no epoch");
}

// ── pitcher_state_change from pitch-count threshold / TTO shift ─────────────
{
  clearHrEpochDetectorStateForGame("gamePitcherState");
  const prev = baseState();
  detectHrEvaluationEpoch({ gameId: "gamePitcherState", prevState: null, newState: prev, stateChangeTriggers: [], newWeatherRoofSignal: null });
  const detected = detectHrEvaluationEpoch({
    gameId: "gamePitcherState", prevState: prev, newState: baseState({ pitchCount: 65 }), stateChangeTriggers: ["pitch_count_threshold"], newWeatherRoofSignal: null,
  });
  ok(detected?.triggerType === "pitcher_state_change", "pitch-count threshold crossing detects pitcher_state_change");
}

// ── Shared epoch identity — same detected epoch → same evaluationEpochId ───
{
  const a = deriveEvaluationEpochId("gameX", "pa_complete", "pa:10", 0);
  const b = deriveEvaluationEpochId("gameX", "pa_complete", "pa:10", 0);
  ok(a === b, "identical epoch inputs derive the identical evaluationEpochId (deterministic, no monotonic counter)");
  const c = deriveEvaluationEpochId("gameX", "pa_complete", "pa:11", 0);
  ok(a !== c, "a different sourceEventId derives a different evaluationEpochId");
  const d = deriveEvaluationEpochId("gameX", "pa_complete", "pa:10", 1);
  ok(a !== d, "a different sourceRevision derives a different evaluationEpochId");
}

// ── getLastKnownBattingOrder tracks state across ticks even with no epoch ──
{
  clearHrEpochDetectorStateForGame("gameMemory");
  detectHrEvaluationEpoch({
    gameId: "gameMemory", prevState: null, newState: baseState({ battingOrder: lineup(["1", "2", "3"]) }),
    stateChangeTriggers: [], newWeatherRoofSignal: null,
  });
  ok(getLastKnownBattingOrder("gameMemory")?.length === 3, "last-known batting order is remembered after a tick");
  clearHrEpochDetectorStateForGame("gameMemory");
  ok(getLastKnownBattingOrder("gameMemory") === null, "clearHrEpochDetectorStateForGame releases per-game memory");
}

console.log(`hrEvaluationEpochDetector.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
