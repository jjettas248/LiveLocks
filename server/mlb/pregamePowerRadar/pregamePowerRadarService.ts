// Pre-Game Power Radar — runtime service (cache + smart rebuild).
//
// Runtime source of truth = latest in-memory snapshot. Rebuild lazily on
// request when stale (TTL 10 min normally; 2 min within 2h of first pitch).
// The DB fallback path is wired in Phase 2 via `setDbFallback`.

import { getMlbSlateDateET } from "../gameDiscoveryService";
import { buildPregamePowerRadar } from "./buildPregamePowerRadar";
import {
  getSnapshot,
  setSnapshot,
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
  const sessionDate = getMlbSlateDateET();
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

let backgroundRefreshInFlight = false;

/**
 * Non-blocking accessor for hot paths (e.g. the live HR ladder bridge).
 *
 * Returns the current same-date in-memory snapshot immediately (or null when
 * absent / from a prior date) and NEVER awaits a rebuild. When the snapshot is
 * stale/missing it kicks a single guarded background `getRadarSnapshot()` —
 * which performs the TTL rebuild AND DB fallback — and persists the resolved
 * result via `setSnapshot`, so subsequent peeks converge to the same snapshot
 * the public Pre-Game endpoints serve (typically within one client poll). Hot
 * callers thus reflect the service-resolved snapshot without paying the
 * network-heavy rebuild cost inline.
 */
export function peekRadarSnapshot(): PregamePowerSnapshot | null {
  const sessionDate = getMlbSlateDateET();
  const snapshot = getSnapshot();
  const wrongDate = !!snapshot && snapshot.sessionDate !== sessionDate;
  const ttl = nearFirstPitch(snapshot) ? TTL_NEAR_FIRST_PITCH_MS : TTL_NORMAL_MS;
  const stale = !snapshot || wrongDate || snapshotAgeMs() > ttl;

  if (stale && !backgroundRefreshInFlight) {
    backgroundRefreshInFlight = true;
    void getRadarSnapshot()
      .then((r) => {
        // Persist the resolved snapshot (incl. db_fallback) as runtime truth so
        // the next peek converges. Rebuilds already call setSnapshot internally;
        // this also captures the db_fallback branch, which does not.
        if (r.snapshot) setSnapshot(r.snapshot);
      })
      .catch(() => {
        /* never throw into runtime */
      })
      .finally(() => {
        backgroundRefreshInFlight = false;
      });
  }

  return wrongDate ? null : snapshot;
}
