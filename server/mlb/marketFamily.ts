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

      const sorted = [...familyMembers].sort((a, b) => {
        const aIsBatterOver = a.side === "OVER" && !["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(a.market);
        const bIsBatterOver = b.side === "OVER" && !["pitcher_strikeouts", "pitcher_outs", "hits_allowed", "walks_allowed", "hr_allowed"].includes(b.market);
        if (aIsBatterOver || bIsBatterOver) {
          return (b.signalScore ?? 0) - (a.signalScore ?? 0);
        }
        return Math.abs(b.edge ?? b.evPct ?? 0) - Math.abs(a.edge ?? a.evPct ?? 0);
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
