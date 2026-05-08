import type { HrRadarOutcomeStatus } from "./hrRadarSection";

export interface HrRadarOutcomeStampMeta {
  hitInning?: number | null;
  alertTier?: string | null;
  confidenceTier?: string | null;
  signalState?: string | null;
  source?: "play_feed" | "box_score_fallback" | "engine_close";
}

export interface HrRadarOutcomeStamp extends HrRadarOutcomeStampMeta {
  outcomeStatus: HrRadarOutcomeStatus;
  resolvedAt: number;
}

const HR_OUTCOME_STAMPS = new Map<string, HrRadarOutcomeStamp>();

function key(gameId: string | number | null | undefined, playerId: string | number | null | undefined): string {
  return `${gameId ?? ""}_${playerId ?? ""}`;
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
  };
  HR_OUTCOME_STAMPS.set(k, stamp);
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
