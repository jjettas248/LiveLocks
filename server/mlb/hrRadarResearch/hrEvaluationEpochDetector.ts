// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — deterministic evaluation-epoch detector (PR 2).
//
// Picks AT MOST ONE HrTriggerType per orchestrator tick so every batter
// evaluated from the same game-state event shares one evaluationEpochId
// (hrEvaluationEpochId.ts). Pure, in-memory — reuses the orchestrator's own
// existing detectStateChange() diff output rather than re-deriving game-state
// change detection. Returns null when nothing in the controlled vocabulary
// applies (heartbeat-refresh ticks, zero-diff ticks) — this is what satisfies
// "no epochs for unchanged polling ticks."
//
// Structural (not nominal) types below intentionally mirror the shapes of
// GameStateCache/BattingOrderEntry (dataPullService.ts) and StateChangeTrigger
// (liveGameOrchestrator.ts) without importing them, so this module stays a
// leaf dependency the orchestrator can import without any risk of a cycle,
// and stays trivially unit-testable with plain object literals.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import type { HrTriggerType } from "./hrTriggerContract";

export interface HrEpochBattingOrderEntry {
  playerId: string;
  playerName: string;
  team: string;
  slot: number;
}

export interface HrEpochGameStateSlice {
  inning: number;
  isTopInning: boolean;
  pitchCount: number;
  totalPlays: number;
  battingOrder: HrEpochBattingOrderEntry[];
  homeScore?: number | null;
  awayScore?: number | null;
  pitcherInGame?: { playerId: string } | null;
}

export interface HrEpochWeatherRoofSignal {
  roofTypeRaw: string | null;
  weatherConditionRaw: string | null;
  isIndoors: boolean;
}

export interface HrEpochDetectionContext {
  gameId: string;
  prevState: HrEpochGameStateSlice | null; // null ⇒ first-ever poll for this game
  newState: HrEpochGameStateSlice;
  // detectStateChange(...) output for this tick, [] when prevState is null.
  stateChangeTriggers: readonly string[];
  newWeatherRoofSignal: HrEpochWeatherRoofSignal | null;
}

export interface HrDetectedEpoch {
  triggerType: HrTriggerType;
  sourceEventId: string;
  sourceEventAt: string | null;
  playSequence: number | null;
  // Batters this exact tick's diff found no longer in the lineup (computed
  // from the SAME diffBattingOrder() call used to decide triggerType, before
  // this function's own memory update below overwrites the "last known"
  // batting order). Capture must read this instead of re-deriving "removed"
  // later via getLastKnownBattingOrder(), which by then reflects the NEW
  // lineup, not the one this epoch was actually detected against.
  removedBatters: HrEpochBattingOrderEntry[];
}

export interface HrBattingOrderDiff {
  added: HrEpochBattingOrderEntry[];
  removed: HrEpochBattingOrderEntry[];
  substituted: { slot: number; oldPlayerId: string; newPlayerId: string }[];
}

export function diffBattingOrder(
  prev: HrEpochBattingOrderEntry[] | null,
  next: HrEpochBattingOrderEntry[],
): HrBattingOrderDiff {
  const prevList = prev ?? [];
  const prevByPlayer = new Map(prevList.map((b) => [b.playerId, b]));
  const nextByPlayer = new Map(next.map((b) => [b.playerId, b]));
  const prevBySlot = new Map(prevList.map((b) => [b.slot, b]));
  const nextBySlot = new Map(next.map((b) => [b.slot, b]));

  const added = next.filter((b) => !prevByPlayer.has(b.playerId));
  const removed = prevList.filter((b) => !nextByPlayer.has(b.playerId));

  const substituted: HrBattingOrderDiff["substituted"] = [];
  for (const [slot, nextEntry] of Array.from(nextBySlot.entries())) {
    const prevEntry = prevBySlot.get(slot);
    if (prevEntry && prevEntry.playerId !== nextEntry.playerId) {
      substituted.push({ slot, oldPlayerId: prevEntry.playerId, newPlayerId: nextEntry.playerId });
    }
  }

  return { added, removed, substituted };
}

// ── Per-game memory (weather/roof + last-known batting order) ──────────────
// Module-private — released via clearHrEpochDetectorStateForGame at game-final
// so memory doesn't grow across a season.
const _lastWeatherRoofSignal = new Map<string, HrEpochWeatherRoofSignal>();
const _lastKnownBattingOrder = new Map<string, HrEpochBattingOrderEntry[]>();

export function getLastKnownBattingOrder(gameId: string): HrEpochBattingOrderEntry[] | null {
  return _lastKnownBattingOrder.get(gameId) ?? null;
}

export function clearHrEpochDetectorStateForGame(gameId: string): void {
  _lastWeatherRoofSignal.delete(gameId);
  _lastKnownBattingOrder.delete(gameId);
}

function weatherRoofSignalsDiffer(
  a: HrEpochWeatherRoofSignal | undefined,
  b: HrEpochWeatherRoofSignal | null,
): boolean {
  if (!b) return false;
  if (!a) return true;
  return a.roofTypeRaw !== b.roofTypeRaw
    || a.weatherConditionRaw !== b.weatherConditionRaw
    || a.isIndoors !== b.isIndoors;
}

/**
 * Detect at most one evaluation epoch for this tick. Always updates the
 * module-private "last known" memory for this game before returning, so the
 * next tick's diff is against this tick's state regardless of whether an
 * epoch fired.
 */
export function detectHrEvaluationEpoch(ctx: HrEpochDetectionContext): HrDetectedEpoch | null {
  const { gameId, prevState, newState, stateChangeTriggers, newWeatherRoofSignal } = ctx;
  const triggers = new Set(stateChangeTriggers);

  const orderDiff = diffBattingOrder(
    prevState ? prevState.battingOrder : getLastKnownBattingOrder(gameId),
    newState.battingOrder,
  );

  let detected: Omit<HrDetectedEpoch, "removedBatters"> | null = null;

  if (orderDiff.removed.length > 0) {
    detected = {
      triggerType: "lineup_removal",
      sourceEventId: `lineup:${sha256Json(newState.battingOrder.map((b) => b.playerId))}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (orderDiff.substituted.length > 0) {
    detected = {
      triggerType: "lineup_substitution",
      sourceEventId: `lineup:${sha256Json(newState.battingOrder.map((b) => b.playerId))}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (triggers.has("pitcher_change")) {
    detected = {
      triggerType: "pitching_change",
      sourceEventId: `pitcher:${prevState?.pitcherInGame?.playerId ?? "none"}->${newState.pitcherInGame?.playerId ?? "none"}:${newState.totalPlays ?? 0}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (
    prevState != null
    && (prevState.inning !== newState.inning || prevState.isTopInning !== newState.isTopInning)
  ) {
    detected = {
      triggerType: "inning_half_transition",
      sourceEventId: `${newState.inning}-${newState.isTopInning ? "top" : "bot"}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (triggers.has("ab_completed")) {
    detected = {
      triggerType: "pa_complete",
      sourceEventId: `pa:${newState.totalPlays ?? 0}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (weatherRoofSignalsDiffer(_lastWeatherRoofSignal.get(gameId), newWeatherRoofSignal)) {
    detected = {
      triggerType: "weather_roof_change",
      sourceEventId: `weather:${sha256Json(newWeatherRoofSignal)}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (triggers.has("pitch_count_threshold") || triggers.has("tto_shift")) {
    detected = {
      triggerType: "pitcher_state_change",
      sourceEventId: `pitcherstate:${newState.pitcherInGame?.playerId ?? "none"}:${newState.pitchCount}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  } else if (prevState === null && newState.battingOrder.length > 0) {
    detected = {
      triggerType: "live_state_entry_with_lineup",
      sourceEventId: `entry:${gameId}`,
      sourceEventAt: null,
      playSequence: newState.totalPlays ?? null,
    };
  }

  if (newWeatherRoofSignal) _lastWeatherRoofSignal.set(gameId, newWeatherRoofSignal);
  _lastKnownBattingOrder.set(gameId, newState.battingOrder);

  return detected ? { ...detected, removedBatters: orderDiff.removed } : null;
}

function sha256Json(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
