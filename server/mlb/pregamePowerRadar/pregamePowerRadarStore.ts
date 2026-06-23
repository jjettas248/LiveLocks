// In-memory canonical store for the Pre-Game Power Radar.
//
// Runtime source of truth = latest in-memory build snapshot. Durable history is
// the DB (Phase 2); when memory is empty the API falls back to the latest DB
// build. Keyed by `${sessionDate}_${gameId}_${batterId}`.

import type { PregamePowerSignal } from "./types";

export interface PregamePowerSnapshot {
  buildId: string;
  sessionDate: string;
  generatedAt: string;
  builtAtMs: number;
  gamesScanned: number;
  battersEvaluated: number;
  signals: Map<string, PregamePowerSignal>;
  coverage: {
    lineupCoverage: number;
    weatherCoverage: number;
    batterCoverage: number;
    pitcherCoverage: number;
  };
}

let latestSnapshot: PregamePowerSnapshot | null = null;

export function setSnapshot(snapshot: PregamePowerSnapshot): void {
  latestSnapshot = snapshot;
}

export function getSnapshot(): PregamePowerSnapshot | null {
  return latestSnapshot;
}

export function getSnapshotForDate(sessionDate: string): PregamePowerSnapshot | null {
  if (latestSnapshot && latestSnapshot.sessionDate === sessionDate) return latestSnapshot;
  return null;
}

export function snapshotAgeMs(): number {
  if (!latestSnapshot) return Infinity;
  return Date.now() - latestSnapshot.builtAtMs;
}

/** All signals from the current snapshot (includes suppressed). */
export function allSignals(): PregamePowerSignal[] {
  if (!latestSnapshot) return [];
  return Array.from(latestSnapshot.signals.values());
}

/** Test-only reset. */
export function _resetForTests(): void {
  latestSnapshot = null;
}
