// Pre-Game Power Radar — runtime service (cache + smart rebuild).
//
// Runtime source of truth = latest in-memory snapshot. Rebuild lazily on
// request when stale (TTL 10 min normally; 2 min within 2h of first pitch).
// The DB fallback path is wired in Phase 2 via `setDbFallback`.

import { todayET } from "../../utils/dateUtils";
import { buildPregamePowerRadar } from "./buildPregamePowerRadar";
import {
  getSnapshot,
  snapshotAgeMs,
  type PregamePowerSnapshot,
} from "./pregamePowerRadarStore";

const TTL_NORMAL_MS = 10 * 60 * 1000;
const TTL_NEAR_FIRST_PITCH_MS = 2 * 60 * 1000;

/** Optional DB-fallback loader, wired in Phase 2. */
export type DbFallbackLoader = (
  sessionDate: string,
) => Promise<PregamePowerSnapshot | null>;
let dbFallback: DbFallbackLoader | null = null;
export function setDbFallback(loader: DbFallbackLoader): void {
  dbFallback = loader;
}

function nearFirstPitch(snapshot: PregamePowerSnapshot | null): boolean {
  if (!snapshot) return false;
  const now = Date.now();
  for (const s of Array.from(snapshot.signals.values())) {
    if (!s.startsAt) continue;
    const t = Date.parse(s.startsAt);
    if (Number.isFinite(t) && t - now < 2 * 60 * 60 * 1000 && t - now > 0) return true;
  }
  return false;
}

export interface ResolvedSnapshot {
  snapshot: PregamePowerSnapshot | null;
  source: "memory" | "rebuilt" | "db_fallback";
}

/**
 * Return the current snapshot, rebuilding when stale or for a different date.
 * Never throws — on rebuild failure returns the stale snapshot (or DB fallback).
 */
export async function getRadarSnapshot(): Promise<ResolvedSnapshot> {
  const sessionDate = todayET();
  let snapshot = getSnapshot();

  const wrongDate = !!snapshot && snapshot.sessionDate !== sessionDate;
  const ttl = nearFirstPitch(snapshot) ? TTL_NEAR_FIRST_PITCH_MS : TTL_NORMAL_MS;
  const stale = !snapshot || wrongDate || snapshotAgeMs() > ttl;

  if (!stale && snapshot) {
    return { snapshot, source: "memory" };
  }

  const rebuilt = await buildPregamePowerRadar();
  if (rebuilt) return { snapshot: rebuilt, source: "rebuilt" };

  // Rebuild failed/skipped — prefer the existing in-memory snapshot if it
  // matches today, else attempt DB fallback.
  snapshot = getSnapshot();
  if (snapshot && snapshot.sessionDate === sessionDate) {
    return { snapshot, source: "memory" };
  }
  if (dbFallback) {
    try {
      const fromDb = await dbFallback(sessionDate);
      if (fromDb) return { snapshot: fromDb, source: "db_fallback" };
    } catch {
      /* never throw into runtime */
    }
  }
  return { snapshot, source: "memory" };
}
