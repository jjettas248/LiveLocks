import { db } from "./db";
import {
  players,
  teamDefense,
  type Player,
  type InsertPlayer,
  type TeamDefense,
  type InsertTeamDefense,
  type CalculateProbabilityRequest,
  type CalculateProbabilityResponse,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

// 2025-26 NBA team pace (possessions per 48 minutes)
export const TEAM_PACE: Record<string, number> = {
  ATL: 103.4,
  BKN: 97.2,
  BOS: 98.8,
  CHA: 100.1,
  CHI: 97.6,
  CLE: 98.2,
  DAL: 100.5,
  DEN: 100.8,
  DET: 101.2,
  GSW: 101.6,
  HOU: 103.0,
  IND: 104.1,
  LAC: 98.4,
  LAL: 100.2,
  MEM: 101.0,
  MIA: 97.8,
  MIL: 100.3,
  MIN: 98.5,
  NOP: 100.2,
  NYK: 96.8,
  OKC: 100.7,
  ORL: 98.1,
  PHI: 99.0,
  PHX: 99.3,
  POR: 101.8,
  SAC: 100.4,
  SAS: 102.8,
  TOR: 101.2,
  UTA: 101.5,
  WAS: 100.0,
};

const LEAGUE_AVG_PACE = 99.5;

function getPaceLabel(pace: number): string {
  if (pace >= 102) return "Fast";
  if (pace >= 100) return "Above Avg";
  if (pace >= 98) return "Average";
  if (pace >= 96) return "Slow";
  return "Very Slow";
}

// Map stat type to the relevant season average field on the player
function getSeasonStatForType(player: Player, statType: string): number | null {
  switch (statType) {
    case "points": return player.ppg ? Number(player.ppg) : null;
    case "rebounds": return player.rpg ? Number(player.rpg) : null;
    case "assists": return player.apg ? Number(player.apg) : null;
    case "steals": return player.spg ? Number(player.spg) : null;
    case "blocks": return player.bpg ? Number(player.bpg) : null;
    case "pts_reb_ast":
      if (player.ppg && player.rpg && player.apg)
        return Number(player.ppg) + Number(player.rpg) + Number(player.apg);
      return null;
    case "pts_reb":
      if (player.ppg && player.rpg) return Number(player.ppg) + Number(player.rpg);
      return null;
    case "pts_ast":
      if (player.ppg && player.apg) return Number(player.ppg) + Number(player.apg);
      return null;
    case "reb_ast":
      if (player.rpg && player.apg) return Number(player.rpg) + Number(player.apg);
      return null;
    case "stl_blk":
      if (player.spg && player.bpg) return Number(player.spg) + Number(player.bpg);
      return null;
    default: return null;
  }
}

export interface IStorage {
  getPlayers(): Promise<Player[]>;
  getPlayer(id: number): Promise<Player | undefined>;
  createPlayer(player: InsertPlayer): Promise<Player>;
  updatePlayerStats(id: number, stats: Partial<InsertPlayer>): Promise<void>;
  getTeams(): Promise<string[]>;
  getTeamDefense(teamName: string, position: string): Promise<TeamDefense | undefined>;
  createTeamDefense(defense: InsertTeamDefense): Promise<TeamDefense>;
  calculateProbability(req: CalculateProbabilityRequest): Promise<CalculateProbabilityResponse>;
}

export class DatabaseStorage implements IStorage {
  async getPlayers(): Promise<Player[]> {
    return await db.select().from(players).orderBy(players.name);
  }

  async getPlayer(id: number): Promise<Player | undefined> {
    const [player] = await db.select().from(players).where(eq(players.id, id));
    return player;
  }

  async createPlayer(player: InsertPlayer): Promise<Player> {
    const [newPlayer] = await db.insert(players).values(player).returning();
    return newPlayer;
  }

  async updatePlayerStats(id: number, stats: Partial<InsertPlayer>): Promise<void> {
    await db.update(players).set(stats).where(eq(players.id, id));
  }

  async getTeams(): Promise<string[]> {
    const records = await db
      .selectDistinct({ teamName: teamDefense.teamName })
      .from(teamDefense)
      .orderBy(teamDefense.teamName);
    return records.map((r) => r.teamName);
  }

  async getTeamDefense(teamName: string, position: string): Promise<TeamDefense | undefined> {
    const [defense] = await db
      .select()
      .from(teamDefense)
      .where(and(eq(teamDefense.teamName, teamName), eq(teamDefense.position, position)));
    return defense;
  }

  async createTeamDefense(defense: InsertTeamDefense): Promise<TeamDefense> {
    const [newDefense] = await db.insert(teamDefense).values(defense).returning();
    return newDefense;
  }

  async calculateProbability(req: CalculateProbabilityRequest): Promise<CalculateProbabilityResponse> {
    const player = await this.getPlayer(req.playerId);
    if (!player) throw new Error("Player not found");

    const defense = await this.getTeamDefense(req.opponentTeam, player.position);
    const defenseMultiplier = defense ? Number(defense.defRating) : 1.0;

    const avgMinutes = Number(player.avgMinutes);
    const usageRate = player.usageRate ? Number(player.usageRate) : 0.22;

    // Foul trouble minute reduction
    let remainingMinutes = avgMinutes - req.halftimeMinutes;
    if (req.halftimeFouls >= 4) {
      remainingMinutes *= 0.45;
    } else if (req.halftimeFouls >= 3) {
      remainingMinutes *= 0.7;
    }
    if (remainingMinutes < 0) remainingMinutes = 0;

    // Team pace
    const playerTeamPace = TEAM_PACE[player.team] ?? LEAGUE_AVG_PACE;
    const opponentPace = TEAM_PACE[req.opponentTeam] ?? LEAGUE_AVG_PACE;
    const gamePaceAvg = (playerTeamPace + opponentPace) / 2;

    let paceMultiplier = gamePaceAvg / LEAGUE_AVG_PACE;
    if (req.halftimeScore) {
      const scores = req.halftimeScore.split(/[- ]+/).map(Number);
      if (scores.length === 2 && !isNaN(scores[0]) && !isNaN(scores[1])) {
        const totalHalftimePoints = scores[0] + scores[1];
        const liveGamePaceMultiplier = totalHalftimePoints / 112;
        paceMultiplier = liveGamePaceMultiplier * 0.6 + paceMultiplier * 0.4;
      }
    }
    paceMultiplier = Math.max(0.78, Math.min(1.22, paceMultiplier));

    // Per-minute rate: blend observed halftime rate (70%) with season rate (30%)
    // Season-based rate anchors the projection, reducing hot/cold game noise
    const observedPerMin = req.halftimeMinutes > 0
      ? req.halftimeStat / req.halftimeMinutes
      : 0;

    const seasonStat = getSeasonStatForType(player, req.statType);
    const seasonPerMin = seasonStat && avgMinutes > 0
      ? seasonStat / avgMinutes
      : null;

    let perMinuteStat: number;
    if (seasonPerMin !== null && req.halftimeMinutes >= 5) {
      // Enough sample: blend 70% observed, 30% season baseline
      perMinuteStat = observedPerMin * 0.7 + seasonPerMin * 0.3;
    } else if (seasonPerMin !== null) {
      // Small halftime sample: lean more on season baseline
      perMinuteStat = observedPerMin * 0.4 + seasonPerMin * 0.6;
    } else {
      perMinuteStat = observedPerMin;
    }

    const expectedSecondHalf = perMinuteStat * remainingMinutes * defenseMultiplier * paceMultiplier;
    const expectedTotal = req.halftimeStat + expectedSecondHalf;

    // Probability via sigmoid-style formula
    const difference = expectedTotal - req.liveLine;

    // Scale factor: higher usage = more certainty (tighter spread), affects variance
    const usageAdjust = usageRate / 0.22; // normalize around league avg
    let scaleFactor = 8 * usageAdjust;
    if (req.statType === "rebounds" || req.statType === "assists") scaleFactor = 10 * usageAdjust;
    if (req.statType === "steals" || req.statType === "blocks") scaleFactor = 15 * usageAdjust;
    if (req.statType.includes("_")) scaleFactor = 6 * usageAdjust;
    scaleFactor = Math.max(4, Math.min(20, scaleFactor));

    let probability = 50 + difference * scaleFactor;
    probability = Math.max(2, Math.min(98, probability));

    return {
      probability: Math.round(probability * 10) / 10,
      expectedTotal: Math.round(expectedTotal * 10) / 10,
      projectedSecondHalfMinutes: Math.round(remainingMinutes * 10) / 10,
      defenseMultiplier: Math.round(defenseMultiplier * 100) / 100,
      paceMultiplier: Math.round(paceMultiplier * 100) / 100,
      paceLabel: getPaceLabel(gamePaceAvg),
      teamPace: Math.round(playerTeamPace * 10) / 10,
      opponentPace: Math.round(opponentPace * 10) / 10,
    };
  }
}

export const storage = new DatabaseStorage();
