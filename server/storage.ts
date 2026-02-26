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

    // ─── Foul trouble minute reduction ─────────────────────────────────────
    let remainingMinutes = avgMinutes - req.halftimeMinutes;
    if (req.halftimeFouls >= 4) remainingMinutes *= 0.45;
    else if (req.halftimeFouls >= 3) remainingMinutes *= 0.70;
    if (remainingMinutes < 0) remainingMinutes = 0;

    // ─── Team pace ─────────────────────────────────────────────────────────
    const playerTeamPace = TEAM_PACE[player.team] ?? LEAGUE_AVG_PACE;
    const opponentPace   = TEAM_PACE[req.opponentTeam] ?? LEAGUE_AVG_PACE;
    const gamePaceAvg    = (playerTeamPace + opponentPace) / 2;

    let paceMultiplier = gamePaceAvg / LEAGUE_AVG_PACE;

    // ─── Game total line (O/U) refines pace multiplier ─────────────────────
    // If a game O/U is set, use it as a baseline for expected full-game scoring.
    // A typical NBA game total baseline is ~228 pts (≈114 pts/team).
    // We compare the expected total to the live halftime pace.
    const EXPECTED_GAME_TOTAL = 228;
    if (req.gameTotalLine && req.gameTotalLine > 0) {
      const totalBasedPace = req.gameTotalLine / EXPECTED_GAME_TOTAL;
      // Blend total-based pace with team history pace (50/50)
      paceMultiplier = totalBasedPace * 0.5 + paceMultiplier * 0.5;
    }

    if (req.halftimeScore) {
      const scores = req.halftimeScore.split(/[- ]+/).map(Number);
      if (scores.length === 2 && !isNaN(scores[0]) && !isNaN(scores[1])) {
        const halftimeTotal = scores[0] + scores[1];
        // If game total line is available, compare live pace to implied O/U half
        const impliedHalf = req.gameTotalLine ? req.gameTotalLine / 2 : 112;
        const livePaceMultiplier = halftimeTotal / impliedHalf;
        paceMultiplier = livePaceMultiplier * 0.6 + paceMultiplier * 0.4;
      }
    }
    paceMultiplier = Math.max(0.78, Math.min(1.22, paceMultiplier));

    // ─── Game spread → garbage-time minute reduction ────────────────────────
    // A large spread (>15) means a blowout is likely — stars may sit late.
    // We reduce remaining minutes for high-usage players when spread is wide.
    let spreadMinuteReduction = 1.0;
    if (req.gameSpread !== undefined && req.gameSpread !== 0) {
      const absSpread = Math.abs(req.gameSpread);
      if (absSpread >= 20 && usageRate >= 0.25) {
        spreadMinuteReduction = 0.82; // severe blowout risk: 18% reduction for stars
      } else if (absSpread >= 15 && usageRate >= 0.25) {
        spreadMinuteReduction = 0.90; // significant blowout risk: 10% reduction for stars
      } else if (absSpread >= 15 && usageRate >= 0.20) {
        spreadMinuteReduction = 0.95; // modest risk for average-usage players
      }
    }
    remainingMinutes *= spreadMinuteReduction;

    // ─── Advanced per-minute components from season stats ──────────────────
    // Build per-minute rates for every stat dimension individually so combo
    // stats are summed from their components rather than averaged together.
    const ptsPerMin = player.ppg && avgMinutes > 0 ? Number(player.ppg) / avgMinutes : null;
    const rebPerMin = player.rpg && avgMinutes > 0 ? Number(player.rpg) / avgMinutes : null;
    const astPerMin = player.apg && avgMinutes > 0 ? Number(player.apg) / avgMinutes : null;
    const stlPerMin = player.spg && avgMinutes > 0 ? Number(player.spg) / avgMinutes : null;
    const blkPerMin = player.bpg && avgMinutes > 0 ? Number(player.bpg) / avgMinutes : null;
    const tpmPerMin = (player as any).tpg && avgMinutes > 0 ? Number((player as any).tpg) / avgMinutes : null;

    // Composite season per-minute for the requested stat type
    function seasonComponentPerMin(): number | null {
      switch (req.statType) {
        case "points":      return ptsPerMin;
        case "rebounds":    return rebPerMin;
        case "assists":     return astPerMin;
        case "steals":      return stlPerMin;
        case "blocks":      return blkPerMin;
        case "threes":      return tpmPerMin;
        case "pts_reb_ast": return (ptsPerMin && rebPerMin && astPerMin) ? ptsPerMin + rebPerMin + astPerMin : null;
        case "pts_reb":     return (ptsPerMin && rebPerMin) ? ptsPerMin + rebPerMin : null;
        case "pts_ast":     return (ptsPerMin && astPerMin) ? ptsPerMin + astPerMin : null;
        case "reb_ast":     return (rebPerMin && astPerMin) ? rebPerMin + astPerMin : null;
        case "stl_blk":     return (stlPerMin && blkPerMin) ? stlPerMin + blkPerMin : null;
        default:            return null;
      }
    }

    // ─── Efficiency index ───────────────────────────────────────────────────
    // Points-per-usage-possession: high-efficiency players have more stable
    // outputs → tighter probability distribution (higher scale factor).
    // Normalized so that a league-average player (≈1.0 pts/possession) = 1.0.
    // ptsPerMin / usageRate gives ~pts-per-possession-opportunity per minute.
    const efficiencyIndex = (ptsPerMin && usageRate > 0)
      ? Math.max(0.70, Math.min(1.30, (ptsPerMin / usageRate) / 1.0))
      : 1.0;

    // ─── Usage-weighted blend of observed vs season per-minute rate ────────
    // Higher usage = more predictable player = season baseline matters more.
    // Lower usage = volatile role player = what we saw in H1 matters more.
    const seasonPerMin = seasonComponentPerMin();
    const observedPerMin = req.halftimeMinutes > 0
      ? req.halftimeStat / req.halftimeMinutes
      : 0;

    let observedW: number;
    let seasonW: number;
    if (!seasonPerMin) {
      // No season data: rely entirely on halftime observation
      observedW = 1.0; seasonW = 0.0;
    } else if (req.halftimeMinutes < 5) {
      // Tiny halftime sample — lean heavily on season baseline
      if (usageRate >= 0.28)      { observedW = 0.30; seasonW = 0.70; }
      else if (usageRate >= 0.22) { observedW = 0.40; seasonW = 0.60; }
      else                        { observedW = 0.50; seasonW = 0.50; }
    } else {
      // Adequate halftime sample — blend, still usage-adjusted
      if (usageRate >= 0.28)      { observedW = 0.60; seasonW = 0.40; }
      else if (usageRate >= 0.22) { observedW = 0.70; seasonW = 0.30; }
      else                        { observedW = 0.78; seasonW = 0.22; }
    }

    const blendedPerMin = observedPerMin * observedW + (seasonPerMin ?? 0) * seasonW;

    const expectedSecondHalf = blendedPerMin * remainingMinutes * defenseMultiplier * paceMultiplier;
    const expectedTotal      = req.halftimeStat + expectedSecondHalf;

    // ─── Probability via sigmoid-style formula ─────────────────────────────
    const difference = expectedTotal - req.liveLine;

    // Scale factor = how steep the sigmoid is = how certain we are.
    // Driven by: stat type (defensive stats are rare/volatile → wider),
    //            usage (higher = tighter), and efficiency (higher = tighter).
    const usageNorm = usageRate / 0.22; // 1.0 = league average
    let scaleFactor: number;
    if (req.statType === "steals" || req.statType === "blocks" || req.statType === "stl_blk") {
      scaleFactor = 14 * usageNorm * efficiencyIndex; // rare events: widest spread
    } else if (req.statType === "threes") {
      scaleFactor = 12 * usageNorm * efficiencyIndex; // 3PM: volatile, high variance per-game
    } else if (req.statType === "rebounds" || req.statType === "assists") {
      scaleFactor = 10 * usageNorm * efficiencyIndex;
    } else if (req.statType.includes("_")) {
      scaleFactor = 5.5 * usageNorm * efficiencyIndex; // combo stats: summed → wider dist
    } else {
      scaleFactor = 8 * usageNorm * efficiencyIndex;   // single stats: points
    }
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
