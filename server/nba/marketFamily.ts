import type { EngineOutput } from "./probabilityEngine";

export interface FamilyMember {
  market: string;
  direction: "OVER" | "UNDER";
  modelEdge: number;
  displayConfidence: number | null;
  engineOutput: EngineOutput;
}

export interface MarketFamily {
  familyId: string;
  playerId: number;
  playerName: string;
  gameId: string;
  direction: "OVER" | "UNDER";
  members: FamilyMember[];
  flagshipMarket: string;
  derivativeMarkets: string[];
}

export function computeFamilyId(playerId: number, gameId: string, direction: string): string {
  return `${playerId}_${gameId}_${direction}`;
}

export function groupIntoFamilies(
  signals: Array<{
    playerId: number;
    playerName: string;
    gameId: string;
    engineOutput: EngineOutput;
  }>,
): MarketFamily[] {
  const familyMap = new Map<string, {
    playerId: number;
    playerName: string;
    gameId: string;
    direction: "OVER" | "UNDER";
    members: FamilyMember[];
  }>();

  for (const s of signals) {
    const eo = s.engineOutput;
    if (eo.direction === "NO_SIGNAL" || eo.noSignal) continue;

    const fid = computeFamilyId(s.playerId, s.gameId, eo.direction);

    if (!familyMap.has(fid)) {
      familyMap.set(fid, {
        playerId: s.playerId,
        playerName: s.playerName,
        gameId: s.gameId,
        direction: eo.direction,
        members: [],
      });
    }

    familyMap.get(fid)!.members.push({
      market: eo.market,
      direction: eo.direction,
      modelEdge: eo.modelEdge,
      displayConfidence: eo.displayConfidence,
      engineOutput: eo,
    });
  }

  const families: MarketFamily[] = [];
  for (const [familyId, data] of familyMap) {
    data.members.sort((a, b) => b.modelEdge - a.modelEdge);

    const flagship = data.members[0].market;
    const derivatives = data.members.slice(1).map(m => m.market);

    families.push({
      familyId,
      playerId: data.playerId,
      playerName: data.playerName,
      gameId: data.gameId,
      direction: data.direction,
      members: data.members,
      flagshipMarket: flagship,
      derivativeMarkets: derivatives,
    });
  }

  return families;
}

export function computeFamilyPenaltyFactor(siblingRank: number): number {
  if (siblingRank <= 1) return 1.0;
  return 1 - Math.min(0.08 * (siblingRank - 1), 0.20);
}

export interface FamilySuppressedSignal {
  market: string;
  direction: "OVER" | "UNDER";
  displayConfidence: number | null;
  modelEdge: number;
  familyId: string;
  siblingCount: number;
  siblingRank: number;
  flagshipOrDerivative: "flagship" | "derivative";
  familyPenaltyFactor: number;
  suppressed: boolean;
  suppressionReason: string | null;
  engineOutput: EngineOutput;
}

export function applyFamilySuppression(families: MarketFamily[]): FamilySuppressedSignal[] {
  const results: FamilySuppressedSignal[] = [];

  for (const family of families) {
    const siblingCount = family.members.length;

    for (let i = 0; i < family.members.length; i++) {
      const member = family.members[i];
      const siblingRank = i + 1;
      const isFlag = siblingRank === 1;
      const penaltyFactor = computeFamilyPenaltyFactor(siblingRank);

      let suppressed = false;
      let suppressionReason: string | null = null;

      if (!isFlag) {
        const adjustedConf = member.displayConfidence != null
          ? 0.5 + (member.displayConfidence - 0.5) * penaltyFactor
          : null;
        const adjustedEdge = adjustedConf != null ? adjustedConf - 0.50 : 0;

        if (adjustedConf != null && adjustedConf < 0.64) {
          suppressed = true;
          suppressionReason = `derivative_confidence_${(adjustedConf * 100).toFixed(1)}_below_64`;
        }
        if (adjustedEdge < 0.04) {
          suppressed = true;
          suppressionReason = `derivative_edge_${(adjustedEdge * 100).toFixed(1)}_below_4`;
        }
      }

      results.push({
        market: member.market,
        direction: member.direction,
        displayConfidence: member.displayConfidence,
        modelEdge: member.modelEdge,
        familyId: family.familyId,
        siblingCount,
        siblingRank,
        flagshipOrDerivative: isFlag ? "flagship" : "derivative",
        familyPenaltyFactor: penaltyFactor,
        suppressed,
        suppressionReason,
        engineOutput: member.engineOutput,
      });
    }
  }

  return results;
}
