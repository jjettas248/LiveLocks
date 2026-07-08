// LiveLocks — HR Radar "Best Contacts of the Day" pure selector.
//
// Selection only — no scoring math. Ranks already-computed HR Radar signals
// (computeHrRadarSignalComposite's 0-100 total + deriveHrConfidenceTier,
// server/mlb/signalScore.ts) and slices the top N, restricted to the
// Attack+Ready ("HR Max Window") tier so still-accumulating Lean/Watchlist
// evidence never gets "promoted." Shared between the client spotlight
// (client/src/components/mlb/hr-radar/HrRadarBestContactsSpotlight.tsx) and
// the admin HR Board Studio live-content path (server/growth/hrBoardStudioCore.ts)
// so both read one implementation.

import { isHrMaxWindowStage, type CanonicalHrRadarStage } from "./hrRadarStage";

export interface BestContactCandidate {
  playerId: string;
  gameId: string;
  playerName: string;
  team: string | null;
  /** track|build|ready|fire|resolved — the one canonical stage vocabulary. */
  userStage: CanonicalHrRadarStage | string | null | undefined;
  /** 0-100 composite (computeHrRadarSignalComposite's `total`, persisted verbatim). */
  currentReadinessScore: number | null;
  /** ELITE/STRONG/SOLID/WATCHLIST/NO_SIGNAL, from deriveHrConfidenceTier. */
  confidenceTier: string | null;
}

const TIER_RANK: Record<string, number> = {
  ELITE: 4,
  STRONG: 3,
  SOLID: 2,
  WATCHLIST: 1,
  NO_SIGNAL: 0,
};

function isEligibleStage(stage: CanonicalHrRadarStage | string | null | undefined): boolean {
  return isHrMaxWindowStage(stage as CanonicalHrRadarStage);
}

/**
 * PURE selection — no scoring, no lifecycle derivation. Filters to Attack+Ready
 * (isHrMaxWindowStage), sorts by the existing composite score desc with
 * confidenceTier as tiebreak, slices top N. Deterministic (playerName
 * tiebreak) so output doesn't jitter between identical polls.
 */
export function selectBestContacts<T extends BestContactCandidate>(
  candidates: T[],
  limit = 5,
): T[] {
  const eligible = candidates.filter((c) => isEligibleStage(c.userStage));
  return [...eligible]
    .sort((a, b) => {
      const sa = a.currentReadinessScore ?? 0;
      const sb = b.currentReadinessScore ?? 0;
      if (sb !== sa) return sb - sa;
      const ta = TIER_RANK[(a.confidenceTier ?? "").toUpperCase()] ?? 0;
      const tb = TIER_RANK[(b.confidenceTier ?? "").toUpperCase()] ?? 0;
      if (tb !== ta) return tb - ta;
      return (a.playerName ?? "").localeCompare(b.playerName ?? "");
    })
    .slice(0, limit);
}
