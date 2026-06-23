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

const normName = (v: unknown): string =>
  String(v ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const normTeam = (v: unknown): string => String(v ?? "").toLowerCase().trim();

export interface PregameSignalLookup {
  found: boolean;
  tier: PregamePowerSignal["tier"] | null;
  score10: number | null;
  tags: string[];
  matchMethod: "mlbam" | "espn" | "batterId" | "name_team" | "none";
}

/**
 * SAFE ADDITIVE read-only lookup — used by the HR review classifier to answer
 * "did the pregame power radar tag this batter today?".
 *
 * Uses the game's Eastern Time date (`gameDateET`), NOT a server/local date, so
 * late-night games still match the snapshot they were built under. Identity
 * resolution order: MLBAM id → ESPN id → batterId → normalized name+team → none.
 * No-op (`found:false`) when the snapshot is for a different date or empty.
 */
export function getPregameSignalFor(input: {
  gameDateET: string;
  gameId: string;
  batterId?: string | number | null;
  mlbamId?: string | number | null;
  espnId?: string | number | null;
  playerName?: string | null;
  teamAbbr?: string | null;
}): PregameSignalLookup {
  const none: PregameSignalLookup = {
    found: false,
    tier: null,
    score10: null,
    tags: [],
    matchMethod: "none",
  };

  const snap = getSnapshotForDate(input.gameDateET);
  if (!snap) return none;

  const hit = (
    signal: PregamePowerSignal,
    method: PregameSignalLookup["matchMethod"],
  ): PregameSignalLookup => ({
    found: true,
    tier: signal.tier,
    score10: typeof signal.score10 === "number" ? signal.score10 : null,
    tags: Array.isArray(signal.drivers)
      ? signal.drivers.map((d: any) => String(d?.label ?? d?.key ?? d)).filter(Boolean)
      : [],
    matchMethod: method,
  });

  // 1) MLBAM id → direct keyed lookup (the store key uses batterId === MLBAM id).
  const mlbam = input.mlbamId != null ? String(input.mlbamId) : null;
  if (mlbam) {
    const direct = snap.signals.get(`${input.gameDateET}_${input.gameId}_${mlbam}`);
    if (direct) return hit(direct, "mlbam");
  }

  const signals = Array.from(snap.signals.values()).filter((s) => s.gameId === input.gameId);

  // 2) ESPN id — not stored on the pregame signal; only resolvable if a future
  //    field is added. Tolerated as a no-op today (falls through).
  const espn = input.espnId != null ? String(input.espnId) : null;
  if (espn) {
    const byEspn = signals.find((s) => String((s as any).espnId ?? "") === espn);
    if (byEspn) return hit(byEspn, "espn");
  }

  // 3) batterId.
  const bid = input.batterId != null ? String(input.batterId) : null;
  if (bid) {
    const byId = signals.find((s) => String(s.batterId) === bid);
    if (byId) return hit(byId, "batterId");
  }

  // 4) normalized name + team.
  const name = normName(input.playerName);
  const team = normTeam(input.teamAbbr);
  if (name) {
    const byNameTeam = signals.find(
      (s) => normName(s.batterName) === name && (!team || normTeam(s.team) === team),
    );
    if (byNameTeam) return hit(byNameTeam, "name_team");
  }

  return none;
}

/** Test-only reset. */
export function _resetForTests(): void {
  latestSnapshot = null;
}
