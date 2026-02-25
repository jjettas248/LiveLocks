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
// Reflects offseason roster changes: Fox to SAS (faster), Davis to DAL,
// Luka to LAL, Butler to GSW, SAC without Fox (slower), etc.
export const TEAM_PACE: Record<string, number> = {
  ATL: 103.4,
  BKN: 97.2,
  BOS: 98.8,
  CHA: 100.1,
  CHI: 97.6,
  CLE: 98.2,
  DAL: 100.5,  // Davis + new pieces, more methodical
  DEN: 100.8,
  DET: 101.2,  // young, uptempo squad
  GSW: 101.6,  // Butler fits Curry's pace
  HOU: 103.0,
  IND: 104.1,  // still fastest in league
  LAC: 98.4,
  LAL: 100.2,  // Luka pushes pace more than roster before
  MEM: 101.0,
  MIA: 97.8,
  MIL: 100.3,
  MIN: 98.5,
  NOP: 100.2,  // Flagg adds energy/transition
  NYK: 96.8,
  OKC: 100.7,
  ORL: 98.1,
  PHI: 99.0,
  PHX: 99.3,
  POR: 101.8,
  SAC: 100.4,  // down from 102.8 without Fox
  SAS: 102.8,  // Fox brings elite transition pace
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

export interface IStorage {
  getPlayers(): Promise<Player[]>;
  getPlayer(id: number): Promise<Player | undefined>;
  createPlayer(player: InsertPlayer): Promise<Player>;
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

  async getTeams(): Promise<string[]> {
    const records = await db.selectDistinct({ teamName: teamDefense.teamName }).from(teamDefense).orderBy(teamDefense.teamName);
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

    // Foul trouble minute reduction
    let remainingMinutes = avgMinutes - req.halftimeMinutes;
    if (req.halftimeFouls >= 4) {
      remainingMinutes *= 0.45;
    } else if (req.halftimeFouls >= 3) {
      remainingMinutes *= 0.7;
    }
    if (remainingMinutes < 0) remainingMinutes = 0;

    // Team pace: average pace of player's team vs opponent
    const playerTeamPace = TEAM_PACE[player.team] ?? LEAGUE_AVG_PACE;
    const opponentPace = TEAM_PACE[req.opponentTeam] ?? LEAGUE_AVG_PACE;
    const gamePaceAvg = (playerTeamPace + opponentPace) / 2;

    // If halftime score is provided, derive actual in-game pace
    let paceMultiplier = gamePaceAvg / LEAGUE_AVG_PACE;
    if (req.halftimeScore) {
      const scores = req.halftimeScore.split(/[- ]+/).map(Number);
      if (scores.length === 2 && !isNaN(scores[0]) && !isNaN(scores[1])) {
        const totalHalftimePoints = scores[0] + scores[1];
        // League average halftime combined score ~112pts
        const liveGamePaceMultiplier = totalHalftimePoints / 112;
        // Blend actual game pace (60%) with team historical pace (40%)
        paceMultiplier = liveGamePaceMultiplier * 0.6 + paceMultiplier * 0.4;
      }
    }
    // Clamp pace
    paceMultiplier = Math.max(0.78, Math.min(1.22, paceMultiplier));

    // Projected second-half stat
    const perMinuteStat = req.halftimeMinutes > 0 ? req.halftimeStat / req.halftimeMinutes : 0;
    const expectedSecondHalf = perMinuteStat * remainingMinutes * defenseMultiplier * paceMultiplier;
    const expectedTotal = req.halftimeStat + expectedSecondHalf;

    // Probability: sigmoid-style scaling
    const difference = expectedTotal - req.liveLine;
    // Scale factor depends on stat type — scoring props have more variance than defensive props
    let scaleFactor = 8;
    if (req.statType === "rebounds" || req.statType === "assists") scaleFactor = 10;
    if (req.statType === "steals" || req.statType === "blocks") scaleFactor = 15;
    if (req.statType.includes("_")) scaleFactor = 6; // combos have more variance

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
