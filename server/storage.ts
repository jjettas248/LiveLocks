import { db } from "./db";
import {
  players,
  teamDefense,
  users,
  feedback,
  appSettings,
  halftimePlayAlerts,
  playResults,
  persistedPlays,
  type Player,
  type InsertPlayer,
  type TeamDefense,
  type InsertTeamDefense,
  type User,
  type InsertUser,
  type Feedback,
  type CalculateProbabilityRequest,
  type CalculateProbabilityResponse,
  type HalftimePlayAlert,
  type InsertHalftimePlayAlert,
  type AnalyticsSummary,
  type PlayAlertWithResult,
  type PersistedPlay,
  type PlayStats,
} from "@shared/schema";
import { eq, and, desc, isNull, sql, lt, lte, inArray } from "drizzle-orm";

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
  upsertTeamDefense(teamName: string, position: string, defRating: string): Promise<void>;
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
  clearNewProFlag(userId: number): Promise<void>;
  clearRequiresRefresh(userId: number): Promise<void>;
  setUpgradedAt(userId: number, upgradedAt: string): Promise<void>;
  getUserByPhoneNumber(phone: string): Promise<User | undefined>;
  savePlayAlerts(plays: any[]): Promise<void>;
  getUnresolvedAlerts(): Promise<HalftimePlayAlert[]>;
  savePlayResult(alertId: number, actualStat: number, hit: boolean): Promise<void>;
  getAnalyticsSummary(): Promise<AnalyticsSummary>;
  getRecentPlayAlerts(limit?: number): Promise<PlayAlertWithResult[]>;
  getAppSettings(): Promise<{ slateResetHour: number; slateResetMinute: number }>;
  saveAppSettings(hour: number, minute: number): Promise<void>;
  recordPlay(play: {
    id: string; gameId: string; playerId?: string; playerName: string; team?: string;
    sport: string; market: string; direction: string; line: number; prob: number;
    engineProb?: number; bookImplied?: number; edgeGap?: number;
    gameDate: string; timestamp: Date;
    duplicateGuard: string;
  }): Promise<{ id: string; isDuplicate: boolean }>;
  getPlays(opts: { sport?: string; limit?: number; settled?: string; date?: string }): Promise<{ plays: PersistedPlay[]; total: number }>;
  settlePlay(id: string, result: string, finalStat: number | null, settledAt: Date): Promise<PersistedPlay | null>;
  getPlayStats(): Promise<PlayStats>;
  cleanupOldPlays(): Promise<number>;
  cleanDuplicatePlays(): Promise<{ removed: number; remaining: number }>;
  cleanDuplicateAlerts(): Promise<{ removed: number; remaining: number }>;
}

// Module-level in-flight Set prevents concurrent race conditions in savePlayAlerts.
// Two simultaneous requests can both pass the select-before-insert check and both insert,
// creating a duplicate. This Set blocks the second attempt before it hits the DB.
const _alertsInFlight = new Set<string>();

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

  async upsertTeamDefense(teamName: string, position: string, defRating: string): Promise<void> {
    const existing = await this.getTeamDefense(teamName, position);
    if (existing) {
      await db
        .update(teamDefense)
        .set({ defRating })
        .where(and(eq(teamDefense.teamName, teamName), eq(teamDefense.position, position)));
    } else {
      await db.insert(teamDefense).values({ teamName, position, defRating });
    }
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

    // halftime context: ≥22 min remaining means we are at or before halftime.
    // Used by pace cap, shooting modifier weights, scale factors, and rotation check.
    const isHalftimeContext = gameMinutesRemaining >= 22;

    // ─── H2 baseline flag (declared early — needed for minute projection below) ─
    const inSecondHalf = currentPeriod >= 3;
    const h2Min = player.h2avgMinutes ? Number(player.h2avgMinutes) : null;
    const useH2 = inSecondHalf && h2Min !== null && h2Min > 3;

    // Player's expected remaining minutes = fraction of game left × season avg (or H2 avg)
    // When H2 baselines are active use h2avgMinutes as the base (not full-game / 2)
    // so that the per-minute rate and the time projection share the same denominator.
    const minuteBase = useH2 ? h2Min! : avgMinutes;
    const minuteGameFraction = useH2 ? gameMinutesRemaining / 24 : gameMinutesRemaining / 48;
    const expectedMinutesFromHere = minuteBase * minuteGameFraction;
    let remainingMinutes = Math.max(0, expectedMinutesFromHere);

    // ─── Foul trouble minute reduction ─────────────────────────────────────
    if (req.halftimeFouls >= 4) remainingMinutes *= 0.45;
    else if (req.halftimeFouls >= 3) remainingMinutes *= 0.70;

    // ─── Situational rotation check (halftime context only) ─────────────────
    // Compare actual H1 minutes played to what was expected. If a player
    // played <75% of their expected H1 minutes they are in a reduced rotation
    // tonight (foul trouble already handled above, so this catches: coach's
    // doghouse, injury management, matchup-based sits, tanking lineups).
    // In that case cap projected H2 minutes at 110% of their actual H1 minutes
    // rather than the full season-average projection.
    if (isHalftimeContext && minutesPlayed >= 3) {
      const expectedH1Minutes = avgMinutes * (12 / 48); // season avg prorated to 1 half
      const rotationRatio = minutesPlayed / Math.max(expectedH1Minutes, 1);
      if (rotationRatio < 0.75) {
        const cappedH2 = minutesPlayed * 1.1;
        if (cappedH2 < remainingMinutes) {
          console.log(`[calc] ${player.name}: rotation cap applied — H1 played ${minutesPlayed.toFixed(1)} min vs expected ${expectedH1Minutes.toFixed(1)} (${(rotationRatio * 100).toFixed(0)}%) → capping H2 at ${cappedH2.toFixed(1)} min`);
          remainingMinutes = cappedH2;
        }
      }
    }

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
    // At halftime (full 2H remaining) cap the pace multiplier lower — the H1 observed
    // rate already embeds H1 pace, so applying a full live-score-derived multiplier on
    // top double-counts it. Cap at 1.12 instead of 1.22 when ≥22 min remain.
    const halfTimePaceCap = gameMinutesRemaining >= 22 ? 1.12 : 1.22;
    paceMultiplier = Math.max(0.78, Math.min(halfTimePaceCap, paceMultiplier));

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

    // ─── H2 baseline selection ──────────────────────────────────────────────
    // inSecondHalf / h2Min / useH2 are declared earlier (needed for minute projection).
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
    // NBA.com offRating (from Advanced sync) — normalize so 110 (avg) → 1.0.
    // If offRating is unavailable, default to 1.0 (neutral).
    // The previous fallback formula (ptsPerMin / usageRate) always clamped to
    // 1.30 for any decent scorer, artificially inflating every signal.
    const efficiencyIndex = player.offRating
      ? Math.max(0.70, Math.min(1.30, Number(player.offRating) / 110))
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

    // At halftime the FGA sample is small (~8-12 attempts). Cap live weights so a hot
    // or cold first half can't spike the modifier to its maximum before regression.
    const maxFgWeight  = isHalftimeContext ? 0.25 : 0.50;
    const maxFg3Weight = isHalftimeContext ? 0.25 : 0.55;

    if ((req.statType === "points" || req.statType.startsWith("pts")) && minutesPlayed >= 4) {
      // Blend live FG% into season FG%; weight grows with attempts (max varies by context)
      const fgWeight = Math.min(maxFgWeight, liveFga / 16);
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
      const fg3Weight = Math.min(maxFg3Weight, liveFg3a / 8);
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

    // Usage-weight blend: HIGH-usage stars get MORE weight on observed because
    // their H1 rates are more sample-stable and usage-consistent. LOW-usage bench
    // players have noisier H1 numbers and must regress harder toward their season mean.
    // This was previously inverted (bench players got 0.78 observed weight — wrong).
    //
    // Additionally, in halftime context (≥22 min remaining) we apply a regression
    // multiplier to further reduce the observed weight — H1 hot streaks mean-revert.
    let observedW: number;
    let seasonW: number;
    if (!seasonPerMin) {
      observedW = 1.0; seasonW = 0.0;
    } else if (minutesPlayed < 5) {
      if (usageRate >= 0.28)      { observedW = 0.35; seasonW = 0.65; }
      else if (usageRate >= 0.22) { observedW = 0.25; seasonW = 0.75; }
      else                        { observedW = 0.15; seasonW = 0.85; }
    } else {
      if (usageRate >= 0.28)      { observedW = 0.65; seasonW = 0.35; }
      else if (usageRate >= 0.22) { observedW = 0.55; seasonW = 0.45; }
      else                        { observedW = 0.45; seasonW = 0.55; }
    }

    // Halftime regression: observed rate in a single half is high-variance.
    // Pull 8% more weight toward season baseline when the full 2H is still ahead.
    // 0.92 (vs the former 0.85) avoids collapsing genuine H1 signals toward 50%.
    if (isHalftimeContext && seasonPerMin) {
      const regressionFactor = 0.92;
      observedW = observedW * regressionFactor;
      seasonW   = 1 - observedW;
    }

    const blendedPerMin = observedPerMin * observedW + (seasonPerMin ?? 0) * seasonW;

    const expectedFromHere = blendedPerMin * remainingMinutes * defenseMultiplier * paceMultiplier * shootingModifier;
    const expectedTotal    = req.halftimeStat + expectedFromHere;

    // ─── Probability via sigmoid-style formula ─────────────────────────────
    const difference = expectedTotal - req.liveLine;

    const usageNorm = usageRate / 0.22;
    // Scale factors calibrated for halftime context (24 min remaining) vs. live Q3/Q4.
    // Halftime base factors are reduced because there is much more uncertainty in
    // projecting 2 full quarters than the final minutes of a live quarter.
    // Live context uses the original (higher) factors.
    let scaleFactor: number;
    if (req.statType === "steals" || req.statType === "blocks" || req.statType === "stl_blk") {
      scaleFactor = isHalftimeContext ? 10 : 14;
    } else if (req.statType === "threes") {
      scaleFactor = isHalftimeContext ? 9 : 12;
    } else if (req.statType === "rebounds" || req.statType === "assists") {
      scaleFactor = isHalftimeContext ? 7.5 : 10;
    } else if (req.statType.includes("_")) {
      scaleFactor = isHalftimeContext ? 4.0 : 5.5;
    } else {
      scaleFactor = isHalftimeContext ? 6 : 8;
    }
    scaleFactor = scaleFactor * usageNorm * efficiencyIndex;
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
    await db.update(users).set({
      subscriptionTier: tier,
      stripeCustomerId,
      stripeSubscriptionId,
      isNewProUser: true,
      requiresRefresh: true,
      upgradedAt: new Date().toISOString(),
    }).where(eq(users.id, userId));
  }

  async clearNewProFlag(userId: number): Promise<void> {
    await db.update(users).set({ isNewProUser: false, requiresRefresh: false }).where(eq(users.id, userId));
  }

  async clearRequiresRefresh(userId: number): Promise<void> {
    await db.update(users).set({ requiresRefresh: false }).where(eq(users.id, userId));
  }

  async setUpgradedAt(userId: number, upgradedAt: string): Promise<void> {
    await db.update(users).set({ upgradedAt, isNewProUser: true, requiresRefresh: true }).where(eq(users.id, userId));
  }

  async updateUserStripeCustomer(userId: number, stripeCustomerId: string): Promise<void> {
    await db.update(users).set({ stripeCustomerId }).where(eq(users.id, userId));
  }

  async getAllUsers(): Promise<Omit<User, "passwordHash">[]> {
    const rows = await db.select().from(users).orderBy(desc(users.createdAt));
    return rows.map(({ passwordHash: _ph, ...rest }) => rest);
  }

  async setUserSubscriptionTier(userId: number, tier: string | null): Promise<void> {
    await db.update(users).set({ subscriptionTier: tier, requiresRefresh: true }).where(eq(users.id, userId));
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

  async savePlayAlerts(plays: any[]): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    for (const play of plays) {
      const prob = Number(play.probability);
      const directionalConf = play.betDirection === "over" ? prob : 100 - prob;
      if (directionalConf < 60) continue;

      // Composite key for dedup — matches the DB-level check below
      const dedupeKey = `${play.gameId ?? ""}|${play.playerId ?? 0}|${play.statType}|${play.betDirection}|${today}`;

      // Step 1: In-flight lock prevents concurrent requests from both passing the DB check
      if (_alertsInFlight.has(dedupeKey)) continue;
      _alertsInFlight.add(dedupeKey);

      try {
        // Step 2: DB-level check (handles cross-process or post-restart duplicates)
        const existing = await db
          .select({ id: halftimePlayAlerts.id })
          .from(halftimePlayAlerts)
          .where(
            and(
              eq(halftimePlayAlerts.gameId, String(play.gameId ?? "")),
              eq(halftimePlayAlerts.playerId, Number(play.playerId ?? 0)),
              eq(halftimePlayAlerts.statType, String(play.statType ?? "")),
              eq(halftimePlayAlerts.betDirection, String(play.betDirection ?? "")),
              eq(halftimePlayAlerts.gameDate, today)
            )
          )
          .limit(1);
        if (existing.length > 0) continue;

        await db.insert(halftimePlayAlerts).values({
          gameId: play.gameId,
          gameDate: today,
          playerId: play.playerId,
          playerName: play.playerName,
          team: play.team,
          opponent: play.opponent,
          statType: play.statType,
          halftimeStat: String(play.halftimeStat),
          line: String(play.line),
          probability: String(prob),
          betDirection: play.betDirection,
        });
      } catch {
        // skip individual insert errors silently (handles any constraint violations)
      } finally {
        // Keep key in Set for the lifetime of this server process (today's guard)
        // On next day the key changes, naturally resetting the guard
      }
    }
  }

  async cleanDuplicateAlerts(): Promise<{ removed: number; remaining: number }> {
    const rows = await db
      .select()
      .from(halftimePlayAlerts)
      .orderBy(desc(halftimePlayAlerts.createdAt));

    const seen = new Map<string, number>(); // key → first id seen
    const toDelete: number[] = [];

    for (const row of rows) {
      const key = `${row.gameId}|${row.playerId}|${row.statType}|${row.betDirection}|${row.gameDate}`;
      if (seen.has(key)) {
        toDelete.push(row.id);
      } else {
        seen.set(key, row.id);
        // Populate in-flight Set so new inserts are blocked going forward
        _alertsInFlight.add(key);
      }
    }

    if (toDelete.length > 0) {
      console.log("[CLEAN] Deleting", toDelete.length, "duplicate halftime alerts");
      // Remove orphaned play_results first, then alerts
      await db.delete(playResults).where(inArray(playResults.alertId, toDelete));
      await db.delete(halftimePlayAlerts).where(inArray(halftimePlayAlerts.id, toDelete));
    }

    return { removed: toDelete.length, remaining: rows.length - toDelete.length };
  }

  async getUnresolvedAlerts(): Promise<HalftimePlayAlert[]> {
    const rows = await db
      .select({ alert: halftimePlayAlerts })
      .from(halftimePlayAlerts)
      .leftJoin(playResults, eq(playResults.alertId, halftimePlayAlerts.id))
      .where(isNull(playResults.id));
    return rows.map((r) => r.alert);
  }

  async savePlayResult(alertId: number, actualStat: number, hit: boolean): Promise<void> {
    await db.insert(playResults).values({
      alertId,
      actualStat: String(actualStat),
      hit,
    }).onConflictDoNothing();
  }

  async getAnalyticsSummary(): Promise<AnalyticsSummary> {
    const rows = await db
      .select({
        probability: halftimePlayAlerts.probability,
        betDirection: halftimePlayAlerts.betDirection,
        hit: playResults.hit,
      })
      .from(halftimePlayAlerts)
      .innerJoin(playResults, eq(playResults.alertId, halftimePlayAlerts.id));

    const BUCKETS = [
      { label: "60-69%", min: 60, max: 69.99 },
      { label: "70-79%", min: 70, max: 79.99 },
      { label: "80-89%", min: 80, max: 89.99 },
      { label: "90%+",   min: 90, max: 100 },
    ];

    const buckets = BUCKETS.map(({ label, min, max }) => {
      const inBucket = rows.filter((r) => {
        const prob = Number(r.probability);
        const conf = r.betDirection === "over" ? prob : 100 - prob;
        return conf >= min && conf <= max;
      });
      const hits = inBucket.filter((r) => r.hit === true).length;
      const total = inBucket.length;
      const winRate = total > 0 ? (hits / total) * 100 : 0;
      const roi = total > 0 ? ((hits * 90.91 - (total - hits) * 100) / total) : 0;
      return { label, min, max, total, hits, winRate: Math.round(winRate * 10) / 10, roi: Math.round(roi * 10) / 10 };
    });

    const totalResolved = rows.length;
    const totalHits = rows.filter((r) => r.hit === true).length;
    const overallWinRate = totalResolved > 0 ? Math.round((totalHits / totalResolved) * 1000) / 10 : 0;

    return { buckets, totalPlays: totalResolved, overallWinRate };
  }

  async getRecentPlayAlerts(limit = 100): Promise<PlayAlertWithResult[]> {
    const rows = await db
      .select({
        id: halftimePlayAlerts.id,
        gameId: halftimePlayAlerts.gameId,
        gameDate: halftimePlayAlerts.gameDate,
        playerId: halftimePlayAlerts.playerId,
        playerName: halftimePlayAlerts.playerName,
        team: halftimePlayAlerts.team,
        opponent: halftimePlayAlerts.opponent,
        statType: halftimePlayAlerts.statType,
        halftimeStat: halftimePlayAlerts.halftimeStat,
        line: halftimePlayAlerts.line,
        probability: halftimePlayAlerts.probability,
        betDirection: halftimePlayAlerts.betDirection,
        createdAt: halftimePlayAlerts.createdAt,
        actualStat: playResults.actualStat,
        hit: playResults.hit,
        resolvedAt: playResults.resolvedAt,
      })
      .from(halftimePlayAlerts)
      .leftJoin(playResults, eq(playResults.alertId, halftimePlayAlerts.id))
      .orderBy(desc(halftimePlayAlerts.createdAt))
      .limit(limit);
    return rows as PlayAlertWithResult[];
  }

  async getAppSettings(): Promise<{ slateResetHour: number; slateResetMinute: number }> {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
    if (row) return { slateResetHour: row.slateResetHour, slateResetMinute: row.slateResetMinute };
    return { slateResetHour: 6, slateResetMinute: 0 };
  }

  async saveAppSettings(hour: number, minute: number): Promise<void> {
    const [existing] = await db.select().from(appSettings).where(eq(appSettings.id, 1));
    if (existing) {
      await db.update(appSettings).set({ slateResetHour: hour, slateResetMinute: minute }).where(eq(appSettings.id, 1));
    } else {
      await db.insert(appSettings).values({ id: 1, slateResetHour: hour, slateResetMinute: minute });
    }
  }

  async recordPlay(play: {
    id: string; gameId: string; playerId?: string; playerName: string; team?: string;
    sport: string; market: string; direction: string; line: number; prob: number;
    engineProb?: number; bookImplied?: number; edgeGap?: number;
    gameDate: string; timestamp: Date; duplicateGuard: string;
  }): Promise<{ id: string; isDuplicate: boolean }> {
    const existing = await db
      .select({ id: persistedPlays.id })
      .from(persistedPlays)
      .where(eq(persistedPlays.duplicateGuard, play.duplicateGuard))
      .limit(1);
    if (existing.length > 0) return { id: existing[0].id, isDuplicate: true };
    await db.insert(persistedPlays).values({
      id: play.id,
      gameId: play.gameId,
      playerId: play.playerId ?? null,
      playerName: play.playerName,
      team: play.team ?? null,
      sport: play.sport,
      market: play.market,
      direction: play.direction,
      line: String(play.line),
      prob: String(play.prob),
      engineProb: play.engineProb != null ? String(play.engineProb) : null,
      bookImplied: play.bookImplied != null ? String(play.bookImplied) : null,
      edgeGap: play.edgeGap != null ? String(play.edgeGap) : null,
      gameDate: play.gameDate,
      timestamp: play.timestamp,
      duplicateGuard: play.duplicateGuard,
    });
    return { id: play.id, isDuplicate: false };
  }

  async getPlays(opts: { sport?: string; limit?: number; settled?: string; date?: string }): Promise<{ plays: PersistedPlay[]; total: number }> {
    const limit = Math.min(opts.limit ?? 100, 500);
    let query = db.select().from(persistedPlays).$dynamic();
    const conditions = [];
    if (opts.sport && opts.sport !== "all") conditions.push(eq(persistedPlays.sport, opts.sport));
    if (opts.date) conditions.push(eq(persistedPlays.gameDate, opts.date));
    if (opts.settled === "pending") conditions.push(isNull(persistedPlays.result));
    if (opts.settled === "settled") conditions.push(sql`${persistedPlays.result} IS NOT NULL`);
    if (conditions.length > 0) query = query.where(and(...conditions));
    const rows = await query.orderBy(desc(persistedPlays.timestamp)).limit(limit);
    return { plays: rows, total: rows.length };
  }

  async settlePlay(id: string, result: string, finalStat: number | null, settledAt: Date): Promise<PersistedPlay | null> {
    const [updated] = await db
      .update(persistedPlays)
      .set({ result, finalStat: finalStat != null ? String(finalStat) : null, settledAt })
      .where(eq(persistedPlays.id, id))
      .returning();
    return updated ?? null;
  }

  async getPlayStats(): Promise<PlayStats> {
    const rows = await db.select().from(persistedPlays);
    const settled = rows.filter(r => r.result !== null);
    const pending = rows.filter(r => r.result === null);

    const makeBucket = (min: number, max: number) => {
      const inBucket = settled.filter(r => {
        const prob = Number(r.prob);
        return prob >= min && prob <= max;
      });
      const hits = inBucket.filter(r => r.result === "hit").length;
      const misses = inBucket.filter(r => r.result === "miss").length;
      const total = inBucket.length;
      return { total, hits, misses, winRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0 };
    };

    const allHits = settled.filter(r => r.result === "hit").length;
    const allMisses = settled.filter(r => r.result === "miss").length;
    const allPushes = settled.filter(r => r.result === "push").length;

    return {
      buckets: {
        "60-69": makeBucket(60, 69.99),
        "70-79": makeBucket(70, 79.99),
        "80-89": makeBucket(80, 89.99),
        "90+":   makeBucket(90, 100),
      },
      totalSettled: settled.length,
      totalPending: pending.length,
      allTimeRecord: { hits: allHits, misses: allMisses, pushes: allPushes },
    };
  }

  async cleanupOldPlays(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const deleted = await db
      .delete(persistedPlays)
      .where(and(
        sql`${persistedPlays.result} IS NOT NULL`,
        lte(persistedPlays.settledAt, cutoff),
      ))
      .returning({ id: persistedPlays.id });
    return deleted.length;
  }

  async cleanDuplicatePlays(): Promise<{ removed: number; remaining: number }> {
    const rows = await db
      .select()
      .from(persistedPlays)
      .orderBy(desc(persistedPlays.timestamp));

    const seen = new Map<string, { id: string; prob: number }>();
    const toDelete: string[] = [];

    for (const play of rows) {
      const key = play.duplicateGuard ??
        `${play.playerId ?? play.playerName}|${play.market}|${play.line}|${play.direction}|${play.gameId ?? ""}|${play.gameDate}`;

      if (seen.has(key)) {
        const existing = seen.get(key)!;
        const currentProb = Number(play.prob);
        if (currentProb > existing.prob) {
          toDelete.push(existing.id);
          seen.set(key, { id: play.id, prob: currentProb });
        } else {
          toDelete.push(play.id);
        }
      } else {
        seen.set(key, { id: play.id, prob: Number(play.prob) });
      }
    }

    if (toDelete.length > 0) {
      console.log("[CLEAN] Deleting", toDelete.length, "duplicate plays");
      await db.delete(persistedPlays).where(inArray(persistedPlays.id, toDelete));
    }

    return { removed: toDelete.length, remaining: rows.length - toDelete.length };
  }
}

export const storage = new DatabaseStorage();
