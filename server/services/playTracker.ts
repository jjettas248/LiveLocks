// ── Play Tracker ──────────────────────────────────────────────────────────────
// On user "save play" action, persists the full signal snapshot to the database.
// On game Final detection, auto-grades each tracked play as WIN, LOSS, or PUSH.
// Grading is delegated to gradePersistedPlays.ts (existing canonical path).
//
// Phase 9: trackPlay is guarded — will refuse to persist if:
//   - sportsbook is null or empty (no market source)
//   - line is not a finite number (not a canonical line)

import type { IStorage } from "../storage";
import { gradePersistedPlays } from "./gradePersistedPlays";
import { nanoid } from "nanoid";

export interface TrackableSignal {
  gameId: string;
  playerId?: string | null;
  playerName: string;
  team?: string | null;
  sport: "nba" | "ncaab" | "mlb";
  market: string;
  direction: "over" | "under" | "cover" | "fade";
  line: number;
  projection: number;
  probability: number;
  edge: number;
  sportsbook: string | null;
  derivedLine: boolean;
  createdAt: number;
}

export async function trackPlay(
  signal: TrackableSignal,
  storage: IStorage
): Promise<{ id: string; isDuplicate: boolean }> {
  // Phase 9 validation: reject plays with missing or non-canonical data
  if (!signal.sportsbook || signal.sportsbook.trim() === "") {
    console.warn(`[PlayTracker] REJECTED — missing sportsbook for ${signal.playerName} ${signal.market}. Play not persisted.`);
    return { id: "", isDuplicate: true };
  }
  if (!Number.isFinite(signal.line)) {
    console.warn(`[PlayTracker] REJECTED — non-finite line (${signal.line}) for ${signal.playerName} ${signal.market}. Play not persisted.`);
    return { id: "", isDuplicate: true };
  }

  const today = new Date().toISOString().slice(0, 10);
  const id = nanoid(16);

  const duplicateGuard = [
    signal.playerId ?? signal.playerName,
    signal.market,
    String(signal.line),
    signal.direction,
    signal.gameId,
    today,
  ].join("|");

  const result = await storage.recordPlay({
    id,
    gameId: signal.gameId,
    playerId: signal.playerId ?? undefined,
    playerName: signal.playerName,
    team: signal.team ?? undefined,
    sport: signal.sport,
    market: signal.market,
    direction: signal.direction,
    line: signal.line,
    prob: signal.probability,
    engineProb: signal.probability,
    bookImplied: undefined,
    edgeGap: signal.edge,
    projection: signal.projection,
    sportsbook: signal.sportsbook,
    derivedLine: signal.derivedLine,
    gameDate: today,
    timestamp: new Date(signal.createdAt),
    duplicateGuard,
  });

  if (!result.isDuplicate) {
    console.log(`[PlayTracker] Tracked play ${id} — ${signal.playerName} ${signal.market} ${signal.direction} ${signal.line} (${signal.sport}) sportsbook=${signal.sportsbook}`);
  }

  return result;
}

export async function gradeTrackedPlays(
  storage: IStorage
): Promise<{ settled: number; failed: number; skipped: number }> {
  const result = await gradePersistedPlays(storage);
  if (result.settled > 0) {
    console.log(`[PlayTracker] Auto-graded ${result.settled} plays`);
  }
  return result;
}
