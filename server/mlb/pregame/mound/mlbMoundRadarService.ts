// Mound Radar — runtime service (cache + smart rebuild).
//
// Mirrors pregamePowerRadar/pregamePowerRadarService.ts: same TTL scheme
// (10 min normal, 2 min within 2h of first pitch), same DB-fallback wiring,
// same "never serve a wrong-slate snapshot" discipline.

import { slateDateET } from "../../../utils/dateUtils";
import { buildMlbMoundRadar } from "./buildMlbMoundRadar";
import {
  getMoundSnapshot,
  setMoundSnapshot,
  moundSnapshotAgeMs,
  type MoundRadarSnapshot,
} from "./mlbMoundRadarStore";

const TTL_NORMAL_MS = 10 * 60 * 1000;
const TTL_NEAR_FIRST_PITCH_MS = 2 * 60 * 1000;

export type MoundDbFallbackLoader = (
  sessionDate: string,
) => Promise<MoundRadarSnapshot | null>;
let dbFallback: MoundDbFallbackLoader | null = null;
export function setMoundDbFallback(loader: MoundDbFallbackLoader): void {
  dbFallback = loader;
}

function nearFirstPitch(snapshot: MoundRadarSnapshot | null): boolean {
  if (!snapshot) return false;
  const now = Date.now();
  for (const s of Array.from(snapshot.signals.values())) {
    if (!s.startsAt) continue;
    const t = Date.parse(s.startsAt);
    if (Number.isFinite(t) && t - now < 2 * 60 * 60 * 1000 && t - now > 0) return true;
  }
  return false;
}

export interface ResolvedMoundSnapshot {
  snapshot: MoundRadarSnapshot | null;
  source: "memory" | "rebuilt" | "db_fallback";
}

/**
 * Return the current snapshot, rebuilding when stale or for a different date.
 * Never throws — on rebuild failure returns the stale snapshot (or DB fallback).
 */
export async function getMoundRadarSnapshot(): Promise<ResolvedMoundSnapshot> {
  const sessionDate = slateDateET();
  let snapshot = getMoundSnapshot();

  const wrongDate = !!snapshot && snapshot.sessionDate !== sessionDate;
  const ttl = nearFirstPitch(snapshot) ? TTL_NEAR_FIRST_PITCH_MS : TTL_NORMAL_MS;
  const stale = !snapshot || wrongDate || moundSnapshotAgeMs() > ttl;

  if (!stale && snapshot) {
    return { snapshot, source: "memory" };
  }

  const rebuilt = await buildMlbMoundRadar();
  if (rebuilt) return { snapshot: rebuilt, source: "rebuilt" };

  snapshot = getMoundSnapshot();
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
  return { snapshot: null, source: "memory" };
}

let backgroundRefreshInFlight = false;

/** Non-blocking accessor for hot paths — never awaits a rebuild. */
export function peekMoundRadarSnapshot(): MoundRadarSnapshot | null {
  const sessionDate = slateDateET();
  const snapshot = getMoundSnapshot();
  const wrongDate = !!snapshot && snapshot.sessionDate !== sessionDate;
  const ttl = nearFirstPitch(snapshot) ? TTL_NEAR_FIRST_PITCH_MS : TTL_NORMAL_MS;
  const stale = !snapshot || wrongDate || moundSnapshotAgeMs() > ttl;

  if (stale && !backgroundRefreshInFlight) {
    backgroundRefreshInFlight = true;
    void getMoundRadarSnapshot()
      .then((r) => {
        if (r.snapshot) setMoundSnapshot(r.snapshot);
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
