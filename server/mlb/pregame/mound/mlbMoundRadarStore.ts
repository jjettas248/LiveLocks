// In-memory canonical store for the Mound Radar.
//
// Mirrors pregamePowerRadar/pregamePowerRadarStore.ts's role — runtime source
// of truth = latest in-memory build snapshot, DB is the durable fallback.
// Keyed by pitcherId rather than batterId.

import type { MoundSignal } from "./types";

export interface MoundRadarSnapshot {
  buildId: string;
  sessionDate: string;
  generatedAt: string;
  builtAtMs: number;
  gamesScanned: number;
  pitchersEvaluated: number;
  signals: Map<string, MoundSignal>;
  coverage: {
    starterCoverage: number;
    weatherCoverage: number;
    pitcherCoverage: number;
    lineupCoverage: number;
  };
}

let latestSnapshot: MoundRadarSnapshot | null = null;

export function setMoundSnapshot(snapshot: MoundRadarSnapshot): void {
  latestSnapshot = snapshot;
}

export function getMoundSnapshot(): MoundRadarSnapshot | null {
  return latestSnapshot;
}

export function getMoundSnapshotForDate(sessionDate: string): MoundRadarSnapshot | null {
  if (latestSnapshot && latestSnapshot.sessionDate === sessionDate) return latestSnapshot;
  return null;
}

export function moundSnapshotAgeMs(): number {
  if (!latestSnapshot) return Infinity;
  return Date.now() - latestSnapshot.builtAtMs;
}

/** All signals from the current snapshot (includes suppressed). */
export function allMoundSignals(): MoundSignal[] {
  if (!latestSnapshot) return [];
  return Array.from(latestSnapshot.signals.values());
}

/** Test-only reset. */
export function _resetMoundStoreForTests(): void {
  latestSnapshot = null;
}
