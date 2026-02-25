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
    const avgFouls = Number(player.avgFouls);

    // Heuristic for foul trouble
    // If player has 3 or more fouls by half, their second half minutes will be reduced
    let remainingMinutes = avgMinutes - req.halftimeMinutes;
    if (req.halftimeFouls >= 3) {
      remainingMinutes *= 0.7; // 30% reduction if 3 fouls at half
    }
    if (req.halftimeFouls >= 4) {
      remainingMinutes *= 0.5; // 50% reduction if 4 fouls at half
    }
    if (remainingMinutes < 0) remainingMinutes = 0;

    // Projected second half stats
    const perMinuteStat = req.halftimeMinutes > 0 ? (req.halftimeStat / req.halftimeMinutes) : 0;
    
    // Pace calculation
    let paceMultiplier = 1.0;
    if (req.halftimeScore) {
      const scores = req.halftimeScore.split(/[- ]+/).map(Number);
      if (scores.length === 2 && !isNaN(scores[0]) && !isNaN(scores[1])) {
        const totalPoints = scores[0] + scores[1];
        // Average NBA halftime score is roughly 110-115 total points (220-230 game total)
        // We'll use 112 as a baseline for "average pace"
        paceMultiplier = totalPoints / 112;
        // Clamp pace multiplier to reasonable bounds (0.8 to 1.2)
        paceMultiplier = Math.max(0.8, Math.min(1.2, paceMultiplier));
      }
    }

    let expectedSecondHalf = perMinuteStat * remainingMinutes * defenseMultiplier * paceMultiplier;

    const expectedTotal = req.halftimeStat + expectedSecondHalf;

    // Simple probability heuristic based on how far the expected total is from the line
    // If expected total exactly equals line, prob is 50%
    // Roughly 5% change per unit of stat difference (depends on the stat, but we keep it simple here)
    const difference = expectedTotal - req.liveLine;
    let probability = 50 + (difference * 10);
    
    // Clamp between 1 and 99
    if (probability > 99) probability = 99;
    if (probability < 1) probability = 1;

    return {
      probability: Math.round(probability),
      expectedTotal: Math.round(expectedTotal * 10) / 10,
      projectedSecondHalfMinutes: Math.round(remainingMinutes * 10) / 10,
      defenseMultiplier: Math.round(defenseMultiplier * 100) / 100,
    };
  }
}

export const storage = new DatabaseStorage();
