import { db } from "./db";
import {
  players,
  teamDefense,
  users,
  feedback,
  type Player,
  type InsertPlayer,
  type TeamDefense,
  type InsertTeamDefense,
  type User,
  type InsertUser,
  type Feedback,
  type CalculateProbabilityRequest,
  type CalculateProbabilityResponse,
} from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";

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
  getUserById(id: number): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUserByStripeCustomerId(customerId: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  incrementPlaysUsed(userId: number): Promise<void>;
  updateUserSubscription(userId: number, tier: string, stripeCustomerId: string, stripeSubscriptionId: string): Promise<void>;
  updateUserStripeCustomer(userId: number, stripeCustomerId: string): Promise<void>;
  getAllUsers(): Promise<Omit<User, "passwordHash">[]>;
  setUserSubscriptionTier(userId: number, tier: string | null): Promise<void>;
  resetUserPlays(userId: number): Promise<void>;
  deleteUser(userId: number): Promise<void>;
  createFeedback(userId: number, message: string): Promise<Feedback>;
  getAllFeedback(): Promise<(Feedback & { userEmail: string | null })[]>;
  updateUserAlerts(userId: number, data: { pushSubscription?: string | null; pushAlerts?: boolean; phoneNumber?: string | null; smsAlerts?: boolean; smsConsent?: boolean }): Promise<void>;
  getUserByPhoneNumber(phone: string): Promise<User | undefined>;
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
    const minutesPlayed = req.halftimeMinutes;

    // ─── Any-point remaining minutes calculation ────────────────────────────
    // Determines how many minutes the player is expected to play from now.
    // Handles any game state: pregame, Q1, Q2, halftime, Q3, Q4.
    function parseGameClock(clock: string | undefined): number | null {
      if (!clock) return null;
      const parts = clock.split(":");
      if (parts.length === 2) {
        const m = parseInt(parts[0], 10);
        const s = parseInt(parts[1], 10);
        if (!isNaN(m) && !isNaN(s)) return m + s / 60;
      }
      const f = parseFloat(clock);
      return isNaN(f) ? null : f;
    }

    const clockMins = parseGameClock(req.gameClock) ?? 12;
    // currentPeriod: 0=pregame, 1=Q1, 2=Q2, 3=Q3, 4=Q4
    // If not provided, assume halftime (periods 3 remaining = Q3+Q4 = 24 min)
    const currentPeriod = req.currentPeriod ?? 3;
    const periodsFullyRemaining = Math.max(0, 4 - currentPeriod);
    const gameMinutesRemaining = periodsFullyRemaining * 12 + (currentPeriod >= 1 && currentPeriod <= 4 ? clockMins : 0);

    // Player's expected remaining minutes = fraction of game left × season avg
    // But subtract any "excess" minutes already played vs expectation
    const gameFraction = gameMinutesRemaining / 48;
    const expectedMinutesFromHere = avgMinutes * gameFraction;
    let remainingMinutes = Math.max(0, expectedMinutesFromHere);

    // ─── Foul trouble minute reduction ─────────────────────────────────────
    if (req.halftimeFouls >= 4) remainingMinutes *= 0.45;
    else if (req.halftimeFouls >= 3) remainingMinutes *= 0.70;

    // ─── Team pace ─────────────────────────────────────────────────────────
    const playerTeamPace = TEAM_PACE[player.team] ?? LEAGUE_AVG_PACE;
    const opponentPace   = TEAM_PACE[req.opponentTeam] ?? LEAGUE_AVG_PACE;
    const gamePaceAvg    = (playerTeamPace + opponentPace) / 2;

    let paceMultiplier = gamePaceAvg / LEAGUE_AVG_PACE;

    // ─── Game total line (O/U) refines pace multiplier ─────────────────────
    const EXPECTED_GAME_TOTAL = 228;
    if (req.gameTotalLine && req.gameTotalLine > 0) {
      const totalBasedPace = req.gameTotalLine / EXPECTED_GAME_TOTAL;
      paceMultiplier = totalBasedPace * 0.5 + paceMultiplier * 0.5;
    }

    const currentScore = req.halftimeScore;
    if (currentScore) {
      const scores = currentScore.split(/[- ]+/).map(Number);
      if (scores.length === 2 && !isNaN(scores[0]) && !isNaN(scores[1])) {
        const scoreTotal = scores[0] + scores[1];
        // Scale live score to full-game pace using elapsed game time
        const elapsedMins = 48 - gameMinutesRemaining;
        const impliedFullGame = elapsedMins > 0 ? (scoreTotal / elapsedMins) * 48 : EXPECTED_GAME_TOTAL;
        const impliedRef = req.gameTotalLine ? req.gameTotalLine : EXPECTED_GAME_TOTAL;
        const livePaceMultiplier = impliedFullGame / impliedRef;
        paceMultiplier = livePaceMultiplier * 0.6 + paceMultiplier * 0.4;
      }
    }
    paceMultiplier = Math.max(0.78, Math.min(1.22, paceMultiplier));

    // ─── Game spread → garbage-time minute reduction ────────────────────────
    let spreadMinuteReduction = 1.0;
    const absSpread = req.gameSpread !== undefined ? Math.abs(req.gameSpread) : 0;
    if (absSpread > 0) {
      if (absSpread >= 20 && usageRate >= 0.25) {
        spreadMinuteReduction = 0.82;
      } else if (absSpread >= 15 && usageRate >= 0.25) {
        spreadMinuteReduction = 0.90;
      } else if (absSpread >= 15 && usageRate >= 0.20) {
        spreadMinuteReduction = 0.95;
      }
    }
    // Q4 late-game blowout: heavy star-sit risk when score is lopsided
    if (currentPeriod === 4 && clockMins < 4 && absSpread > 12) {
      spreadMinuteReduction = Math.min(spreadMinuteReduction, 0.70);
    }
    remainingMinutes *= spreadMinuteReduction;

    // ─── Personal minutes budget cap ────────────────────────────────────────
    // A player cannot play more remaining minutes than the gap between their
    // season average and what they've already logged. This prevents inflated
    // probabilities late in games (e.g. Kawhi at 29 min of 32.7 avg can
    // only project ~3.7 more minutes, not 16.8 based on clock alone).
    if (minutesPlayed > 0 && avgMinutes > 0) {
      const minutesBudgetRemaining = Math.max(0, avgMinutes - minutesPlayed);
      remainingMinutes = Math.min(remainingMinutes, minutesBudgetRemaining);
    }

    // ─── H2 baseline selection ──────────────────────────────────────────────
    // In Q3/Q4 use the actual season second-half averages if available.
    // These are more accurate than extrapolating full-game rates to the H2.
    const inSecondHalf = currentPeriod >= 3;
    const h2Min = player.h2avgMinutes ? Number(player.h2avgMinutes) : null;
    const useH2 = inSecondHalf && h2Min !== null && h2Min > 3;
    const baselineSource: "h2" | "fullGame" = useH2 ? "h2" : "fullGame";

    // Per-minute rates from the appropriate baseline
    const baseMin = useH2 ? h2Min! : avgMinutes;
    function getPerMin(full: string | null | undefined, h2: string | null | undefined): number | null {
      const base = useH2 ? h2 : full;
      if (!base || baseMin <= 0) return null;
      return Number(base) / baseMin;
    }

    const ptsPerMin = getPerMin(player.ppg, player.h2ppg);
    const rebPerMin = getPerMin(player.rpg, player.h2rpg);
    const astPerMin = getPerMin(player.apg, player.h2apg);
    const stlPerMin = getPerMin(player.spg, player.h2spg);
    const blkPerMin = getPerMin(player.bpg, player.h2bpg);
    const tpmPerMin = getPerMin((player as any).tpg, (player as any).h2tpg);

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
    // Prefer NBA.com offRating (more reliable) over computed pts/usage ratio.
    // NBA avg offRating ≈ 110; normalize so 110 → 1.0.
    const efficiencyIndex = player.offRating
      ? Math.max(0.70, Math.min(1.30, Number(player.offRating) / 110))
      : (ptsPerMin && usageRate > 0)
        ? Math.max(0.70, Math.min(1.30, (ptsPerMin / usageRate) / 1.0))
        : 1.0;

    // ─── Live shooting efficiency modifier ──────────────────────────────────
    // Blends current-game shooting % against season baseline to adjust the
    // expected output for points, threes, and combo props.
    // Season baselines: NBA avg FG% ~46%, FT% ~77%, 3P% ~36%
    const SEASON_FG_PCT  = Number(player.tsPct ?? 0) > 0 ? Number(player.tsPct) / 1.12 : 0.46;
    const SEASON_3P_PCT  = 0.36;
    const SEASON_FT_PCT  = 0.77;

    let shootingModifier = 1.0;
    const liveFga  = req.liveFga  ?? 0;
    const liveFgm  = req.liveFgm  ?? 0;
    const liveFta  = req.liveFta  ?? 0;
    const liveFtm  = req.liveFtm  ?? 0;
    const liveFg3a = req.liveFg3a ?? 0;
    const liveFg3m = req.liveFg3m ?? 0;

    if ((req.statType === "points" || req.statType.startsWith("pts")) && minutesPlayed >= 4) {
      // Blend live FG% into season FG%; weight grows with attempts (max 50% live weight at 8+ FGA)
      const fgWeight = Math.min(0.50, liveFga / 16);
      const liveFgPct = liveFga > 0 ? liveFgm / liveFga : SEASON_FG_PCT;
      const blendedFgPct = liveFgPct * fgWeight + SEASON_FG_PCT * (1 - fgWeight);
      const fgMod = SEASON_FG_PCT > 0 ? blendedFgPct / SEASON_FG_PCT : 1.0;

      // Same for FT%
      const ftWeight = Math.min(0.40, liveFta / 10);
      const liveFtPct = liveFta > 0 ? liveFtm / liveFta : SEASON_FT_PCT;
      const blendedFtPct = liveFtPct * ftWeight + SEASON_FT_PCT * (1 - ftWeight);
      const ftMod = SEASON_FT_PCT > 0 ? blendedFtPct / SEASON_FT_PCT : 1.0;

      shootingModifier = fgMod * 0.65 + ftMod * 0.35;
      shootingModifier = Math.max(0.75, Math.min(1.25, shootingModifier));
    } else if (req.statType === "threes" && minutesPlayed >= 4) {
      const fg3Weight = Math.min(0.55, liveFg3a / 8);
      const live3pPct = liveFg3a > 0 ? liveFg3m / liveFg3a : SEASON_3P_PCT;
      const blended3pPct = live3pPct * fg3Weight + SEASON_3P_PCT * (1 - fg3Weight);
      const threeMod = SEASON_3P_PCT > 0 ? blended3pPct / SEASON_3P_PCT : 1.0;
      shootingModifier = Math.max(0.70, Math.min(1.30, threeMod));
    }

    // ─── Usage-weighted blend of observed vs season per-minute rate ────────
    const seasonPerMin = seasonComponentPerMin();
    const observedPerMin = minutesPlayed > 0
      ? req.halftimeStat / minutesPlayed
      : 0;

    let observedW: number;
    let seasonW: number;
    if (!seasonPerMin) {
      observedW = 1.0; seasonW = 0.0;
    } else if (minutesPlayed < 5) {
      if (usageRate >= 0.28)      { observedW = 0.30; seasonW = 0.70; }
      else if (usageRate >= 0.22) { observedW = 0.40; seasonW = 0.60; }
      else                        { observedW = 0.50; seasonW = 0.50; }
    } else {
      if (usageRate >= 0.28)      { observedW = 0.60; seasonW = 0.40; }
      else if (usageRate >= 0.22) { observedW = 0.70; seasonW = 0.30; }
      else                        { observedW = 0.78; seasonW = 0.22; }
    }

    const blendedPerMin = observedPerMin * observedW + (seasonPerMin ?? 0) * seasonW;

    const expectedFromHere = blendedPerMin * remainingMinutes * defenseMultiplier * paceMultiplier * shootingModifier;
    const expectedTotal    = req.halftimeStat + expectedFromHere;

    // ─── Probability via sigmoid-style formula ─────────────────────────────
    const difference = expectedTotal - req.liveLine;

    const usageNorm = usageRate / 0.22;
    let scaleFactor: number;
    if (req.statType === "steals" || req.statType === "blocks" || req.statType === "stl_blk") {
      scaleFactor = 14 * usageNorm * efficiencyIndex;
    } else if (req.statType === "threes") {
      scaleFactor = 12 * usageNorm * efficiencyIndex;
    } else if (req.statType === "rebounds" || req.statType === "assists") {
      scaleFactor = 10 * usageNorm * efficiencyIndex;
    } else if (req.statType.includes("_")) {
      scaleFactor = 5.5 * usageNorm * efficiencyIndex;
    } else {
      scaleFactor = 8 * usageNorm * efficiencyIndex;
    }
    scaleFactor = Math.max(4, Math.min(20, scaleFactor));

    let probability = 50 + difference * scaleFactor;
    probability = Math.max(2, Math.min(98, probability));

    console.log(`[calc] ${player.name}: period=${currentPeriod} clock=${req.gameClock ?? "n/a"} gameMinLeft=${gameMinutesRemaining.toFixed(1)} remainMin=${remainingMinutes.toFixed(1)} baseline=${baselineSource} usageRate=${usageRate.toFixed(3)} effIdx=${efficiencyIndex.toFixed(3)} prob=${probability.toFixed(1)}%`);

    return {
      probability: Math.round(probability * 10) / 10,
      expectedTotal: Math.round(expectedTotal * 10) / 10,
      projectedSecondHalfMinutes: Math.round(remainingMinutes * 10) / 10,
      defenseMultiplier: Math.round(defenseMultiplier * 100) / 100,
      paceMultiplier: Math.round(paceMultiplier * 100) / 100,
      paceLabel: getPaceLabel(gamePaceAvg),
      teamPace: Math.round(playerTeamPace * 10) / 10,
      opponentPace: Math.round(opponentPace * 10) / 10,
      gameMinutesRemaining: Math.round(gameMinutesRemaining * 10) / 10,
      inSecondHalf,
      baselineSource,
    };
  }

  async getUserById(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async getUserByStripeCustomerId(customerId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.stripeCustomerId, customerId));
    return user;
  }

  async createUser(user: InsertUser): Promise<User> {
    const [newUser] = await db.insert(users).values(user).returning();
    return newUser;
  }

  async incrementPlaysUsed(userId: number): Promise<void> {
    const user = await this.getUserById(userId);
    if (user) {
      await db.update(users).set({ playsUsed: user.playsUsed + 1 }).where(eq(users.id, userId));
    }
  }

  async updateUserSubscription(userId: number, tier: string, stripeCustomerId: string, stripeSubscriptionId: string): Promise<void> {
    await db.update(users).set({ subscriptionTier: tier, stripeCustomerId, stripeSubscriptionId }).where(eq(users.id, userId));
  }

  async updateUserStripeCustomer(userId: number, stripeCustomerId: string): Promise<void> {
    await db.update(users).set({ stripeCustomerId }).where(eq(users.id, userId));
  }

  async getAllUsers(): Promise<Omit<User, "passwordHash">[]> {
    const rows = await db.select().from(users).orderBy(desc(users.createdAt));
    return rows.map(({ passwordHash: _ph, ...rest }) => rest);
  }

  async setUserSubscriptionTier(userId: number, tier: string | null): Promise<void> {
    await db.update(users).set({ subscriptionTier: tier }).where(eq(users.id, userId));
  }

  async resetUserPlays(userId: number): Promise<void> {
    await db.update(users).set({ playsUsed: 0 }).where(eq(users.id, userId));
  }

  async deleteUser(userId: number): Promise<void> {
    await db.delete(users).where(eq(users.id, userId));
  }

  async createFeedback(userId: number, message: string): Promise<Feedback> {
    const [row] = await db.insert(feedback).values({ userId, message }).returning();
    return row;
  }

  async getAllFeedback(): Promise<(Feedback & { userEmail: string | null })[]> {
    const rows = await db
      .select({
        id: feedback.id,
        userId: feedback.userId,
        message: feedback.message,
        createdAt: feedback.createdAt,
        userEmail: users.email,
      })
      .from(feedback)
      .leftJoin(users, eq(feedback.userId, users.id))
      .orderBy(desc(feedback.createdAt));
    return rows;
  }

  async updateUserAlerts(userId: number, data: { pushSubscription?: string | null; pushAlerts?: boolean; phoneNumber?: string | null; smsAlerts?: boolean; smsConsent?: boolean }): Promise<void> {
    const update: Record<string, any> = {};
    if (data.pushSubscription !== undefined) update.pushSubscription = data.pushSubscription;
    if (data.pushAlerts !== undefined) update.pushAlerts = data.pushAlerts;
    if (data.phoneNumber !== undefined) update.phoneNumber = data.phoneNumber;
    if (data.smsAlerts !== undefined) update.smsAlerts = data.smsAlerts;
    if (data.smsConsent !== undefined) update.smsConsent = data.smsConsent;
    if (Object.keys(update).length > 0) {
      await db.update(users).set(update).where(eq(users.id, userId));
    }
  }

  async getUserByPhoneNumber(phone: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone));
    return user;
  }
}

export const storage = new DatabaseStorage();
