import type { MLBMarket } from "./types";

export const MLB_MARKET_FAMILIES: Record<string, MLBMarket[]> = {
  contact: ["hits", "total_bases", "hrr"],
  power: ["home_runs", "total_bases"],
  pitcherK: ["pitcher_strikeouts", "pitcher_outs"],
  pitcherHA: ["hits_allowed", "walks_allowed", "hr_allowed"],
  batterK: ["batter_strikeouts"],
};

export interface FamilyResult {
  familyId: string;
  siblingCount: number;
  siblingRank: number;
  isFlagship: boolean;
  familyPenaltyFactor: number;
}

interface SignalForFamily {
  playerId: string;
  market: MLBMarket;
  side?: string;
  edge?: number;
  evPct?: number;
  signalScore: number;
  // MLB Live Edge safety-core (Stage A A5) — flagship selection is now driven
  // by candidate probability (engineProbability), never signalScore.
  engineProbability?: number;
  modelEdgePctPoints?: number | null;
}

function getMarketFamilies(market: MLBMarket): string[] {
  const families: string[] = [];
  for (const [familyId, markets] of Object.entries(MLB_MARKET_FAMILIES)) {
    if (markets.includes(market)) {
      families.push(familyId);
    }
  }
  return families;
}

export function applyFamilySuppression<T extends SignalForFamily>(
  signals: T[]
): (T & { familyResult: FamilyResult })[] {
  const playerGroups = new Map<string, T[]>();
  for (const sig of signals) {
    const existing = playerGroups.get(sig.playerId) ?? [];
    existing.push(sig);
    playerGroups.set(sig.playerId, existing);
  }

  const results: (T & { familyResult: FamilyResult })[] = [];

  for (const [_playerId, playerSignals] of Array.from(playerGroups.entries())) {
    const familyAssignments = new Map<string, FamilyResult>();

    for (const familyId of Object.keys(MLB_MARKET_FAMILIES)) {
      const familyMembers = playerSignals.filter((s: any) =>
        MLB_MARKET_FAMILIES[familyId].includes(s.market)
      );

      if (familyMembers.length <= 1) {
        for (const member of familyMembers) {
          const key = `${member.playerId}_${member.market}`;
          if (!familyAssignments.has(key)) {
            familyAssignments.set(key, {
              familyId,
              siblingCount: 1,
              siblingRank: 1,
              isFlagship: true,
              familyPenaltyFactor: 1.0,
            });
          }
        }
        continue;
      }

      // MLB Live Edge safety-core (Stage A A5) — flagship selection is
      // signalScore-free. The family flagship is the sibling with the highest
      // candidate probability (engineProbability); canonical no-vig model edge
      // (falling back to the legacy edge only when no-vig is not yet computed)
      // is the tiebreak. signalScore/evPct no longer choose the flagship.
      const sorted = [...familyMembers].sort((a, b) => {
        const pa = Number.isFinite(a.engineProbability as number) ? (a.engineProbability as number) : -Infinity;
        const pb = Number.isFinite(b.engineProbability as number) ? (b.engineProbability as number) : -Infinity;
        if (pa !== pb) return pb - pa;
        const ea = a.modelEdgePctPoints ?? (a.edge != null ? Math.abs(a.edge) : -Infinity);
        const eb = b.modelEdgePctPoints ?? (b.edge != null ? Math.abs(b.edge) : -Infinity);
        return eb - ea;
      });

      for (let i = 0; i < sorted.length; i++) {
        const rank = i + 1;
        let penalty = 1.0;
        if (rank === 2) penalty = 0.85;
        else if (rank >= 3) penalty = 0.70;

        const key = `${sorted[i].playerId}_${sorted[i].market}`;
        const existing = familyAssignments.get(key);

        if (existing) {
          if (penalty < existing.familyPenaltyFactor) {
            familyAssignments.set(key, {
              familyId,
              siblingCount: familyMembers.length,
              siblingRank: rank,
              isFlagship: rank === 1,
              familyPenaltyFactor: penalty,
            });
          }
        } else {
          familyAssignments.set(key, {
            familyId,
            siblingCount: familyMembers.length,
            siblingRank: rank,
            isFlagship: rank === 1,
            familyPenaltyFactor: penalty,
          });
        }
      }
    }

    for (const sig of playerSignals) {
      const key = `${sig.playerId}_${sig.market}`;
      const assignment = familyAssignments.get(key) ?? {
        familyId: "standalone",
        siblingCount: 1,
        siblingRank: 1,
        isFlagship: true,
        familyPenaltyFactor: 1.0,
      };

      results.push({
        ...sig,
        familyResult: assignment,
      });
    }
  }

  return results;
}

export function getConfidenceTierCap(
  isFlagship: boolean,
  flagshipTier: string | null
): string | null {
  if (isFlagship) return null;
  if (!flagshipTier) return null;

  const tierOrder = ["ELITE", "STRONG", "SOLID", "WATCHLIST", "NO_SIGNAL"];
  const flagshipIdx = tierOrder.indexOf(flagshipTier);
  if (flagshipIdx < 0 || flagshipIdx >= tierOrder.length - 1) return null;
  return tierOrder[flagshipIdx + 1];
}
