import type { HrRadarOutcomeStatus } from "./hrRadarSection";

export interface HrRadarOutcomeStampMeta {
  hitInning?: number | null;
  alertTier?: string | null;
  confidenceTier?: string | null;
  signalState?: string | null;
  source?: "play_feed" | "box_score_fallback" | "engine_close";
  rawConversionProbability?: number | null;
}

export interface HrRadarOutcomeStamp extends HrRadarOutcomeStampMeta {
  outcomeStatus: HrRadarOutcomeStatus;
  resolvedAt: number;
}

const HR_OUTCOME_STAMPS = new Map<string, HrRadarOutcomeStamp>();

function key(gameId: string | number | null | undefined, playerId: string | number | null | undefined): string {
  return `${gameId ?? ""}_${playerId ?? ""}`;
}

// Audit fix C4 — durable persistence is injected (not imported) so this module
// stays dependency-free for unit tests and never throws when no DB is wired.
// `index.ts` registers a persister that fire-and-forgets a DB upsert; tests
// register nothing and run purely in-memory.
export type PersistedHrRadarOutcomeStamp = HrRadarOutcomeStamp & { gameId: string; playerId: string };
let _persister: ((stamp: PersistedHrRadarOutcomeStamp) => void) | null = null;

export function setHrRadarOutcomeStampPersister(fn: ((stamp: PersistedHrRadarOutcomeStamp) => void) | null): void {
  _persister = fn;
}

/**
 * Seed the in-memory store from durable rows at boot. First-write-wins: an
 * already-present (gameId, playerId) is never overwritten. Returns the count
 * actually added.
 */
export function hydrateHrRadarOutcomeStamps(rows: PersistedHrRadarOutcomeStamp[]): number {
  let added = 0;
  for (const r of rows) {
    const k = key(r.gameId, r.playerId);
    if (HR_OUTCOME_STAMPS.has(k)) continue;
    HR_OUTCOME_STAMPS.set(k, {
      outcomeStatus: r.outcomeStatus,
      resolvedAt: r.resolvedAt,
      hitInning: r.hitInning ?? null,
      alertTier: r.alertTier ?? null,
      confidenceTier: r.confidenceTier ?? null,
      signalState: r.signalState ?? null,
      source: r.source,
      rawConversionProbability: r.rawConversionProbability ?? null,
    });
    added++;
  }
  return added;
}

export function stampHrRadarOutcome(
  gameId: string | number,
  playerId: string | number,
  outcomeStatus: HrRadarOutcomeStatus,
  meta?: HrRadarOutcomeStampMeta,
): HrRadarOutcomeStamp {
  const k = key(gameId, playerId);
  const existing = HR_OUTCOME_STAMPS.get(k);
  if (existing) return existing;
  const stamp: HrRadarOutcomeStamp = {
    outcomeStatus,
    resolvedAt: Date.now(),
    hitInning: meta?.hitInning ?? null,
    alertTier: meta?.alertTier ?? null,
    confidenceTier: meta?.confidenceTier ?? null,
    signalState: meta?.signalState ?? null,
    source: meta?.source,
    rawConversionProbability: meta?.rawConversionProbability ?? null,
  };
  HR_OUTCOME_STAMPS.set(k, stamp);
  if (_persister) {
    try { _persister({ ...stamp, gameId: String(gameId), playerId: String(playerId) }); } catch { /* never break runtime */ }
  }
  console.log(
    `[HR_RADAR_CASHED] gameId=${gameId} playerId=${playerId} outcomeStatus=${outcomeStatus} ` +
    `inning=${stamp.hitInning ?? "?"} alertTier=${stamp.alertTier ?? "?"} ` +
    `confidenceTier=${stamp.confidenceTier ?? "?"} signalState=${stamp.signalState ?? "?"} ` +
    `source=${stamp.source ?? "engine_close"}`,
  );
  return stamp;
}

export function getHrRadarOutcomeStamp(
  gameId: string | number | null | undefined,
  playerId: string | number | null | undefined,
): HrRadarOutcomeStamp | null {
  if (gameId == null || playerId == null) return null;
  return HR_OUTCOME_STAMPS.get(key(gameId, playerId)) ?? null;
}

export function clearHrRadarOutcomeStampsForGame(gameId: string | number): number {
  let dropped = 0;
  const prefix = `${gameId}_`;
  for (const k of Array.from(HR_OUTCOME_STAMPS.keys())) {
    if (k.startsWith(prefix)) {
      HR_OUTCOME_STAMPS.delete(k);
      dropped++;
    }
  }
  return dropped;
}

export function _resetHrRadarOutcomeStampsForTests(): void {
  HR_OUTCOME_STAMPS.clear();
}

export function _hrRadarOutcomeStampSize(): number {
  return HR_OUTCOME_STAMPS.size;
}

export function _getAllHrRadarOutcomeStamps(): HrRadarOutcomeStamp[] {
  return Array.from(HR_OUTCOME_STAMPS.values());
}
