import { db } from "./db";
import { todayET, daysAgoET } from "./utils/dateUtils";
import { resolveMlbGameSessionDate } from "./utils/mlbSessionDate";
import { calculateRemainingMinutes } from "./minutesModel";
import { getPlayerUsage, getTeamDefenseMatchup, computeUsageAdjustment, computeDefenseMultiplier } from "./services/nbaStatsService";
import { classifyArchetype as classifyNBAArchetype, type NBAArchetype, VARIANCE_MULTIPLIERS, MINUTES_FRAGILITY_MULTIPLIERS, CORRELATION_DEFAULTS, COMBO_VARIANCE_EXTRA, isVolatileArchetype, isImpactedArchetype, getSafetyCeiling, getPlayoffSafetyCeiling, getPlayoffFragilityMultiplier } from "./nba/archetypes";
import { isUnderBiasCorrectionActive } from "./nba/directionalBias";
import {
  players,
  teamDefense,
  users,
  feedback,
  appSettings,
  halftimePlayAlerts,
  playResults,
  persistedPlays,
  contactEvents,
  gamePlayerStats,
  persistedAlerts,
  hrRadarAlerts,
  hrRadarAnalytics,
  hrRadarSignalEvents,
  signalInteractions,
  stripeEvents,
  type Player,
  type InsertPlayer,
  type TeamDefense,
  type InsertTeamDefense,
  type User,
  type InsertUser,
  type Feedback,
  type CalculateProbabilityRequest,
  type CalculateProbabilityResponse,
  type CalcDebug,
  type HalftimePlayAlert,
  type InsertHalftimePlayAlert,
  type AnalyticsSummary,
  type PlayAlertWithResult,
  type PersistedPlay,
  type PlayStats,
  type HrRadarAlert,
  type HrRadarAnalyticsRecord,
  type HrRadarSignalEvent,
  type InsertHrRadarSignalEvent,
} from "@shared/schema";
import { eq, and, desc, isNull, isNotNull, sql, lt, lte, gte, inArray, ne } from "drizzle-orm";

const HIGH_VOLATILITY_TEAMS = new Set(["BKN", "WAS", "CHA", "POR", "UTA", "DET"]);

// ─── Normal CDF (standard normal) ───────────────────────────────────────────
function phiCDF(z: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

// ─── Stat sigma floors (v2 engine) ──────────────────────────────────────────
const STAT_SIGMA_FLOORS_V2: Record<string, number> = {
  points: 3.0,
  rebounds: 2.0,
  assists: 1.8,
  steals: 0.8,
  blocks: 0.8,
  threes: 1.2,
};

function getDefaultCorrelation(
  a: string, b: string,
  defaults: { rho_PR: number; rho_PA: number; rho_RA: number },
): number {
  const pair = [a, b].sort().join(",");
  const map: Record<string, number> = {
    "assists,points": defaults.rho_PA,
    "points,rebounds": defaults.rho_PR,
    "assists,rebounds": defaults.rho_RA,
  };
  return map[pair] ?? 0;
}

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
  findPlayerByEspnId(espnAthleteId: number): Promise<Player | undefined>;
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
  incrementPlaysUsedToday(userId: number): Promise<void>;
  tryConsumePlayToday(userId: number): Promise<{ allowed: boolean; playsUsedToday: number }>;
  tryConsumeGamePlayToday(userId: number, gameId: string, limit?: number): Promise<{ allowed: boolean; alreadyUnlocked: boolean; playsUsedToday: number }>;
  resetDailyPlaysIfNeeded(userId: number): Promise<User | undefined>;
  isGameUnlockedToday(userId: number, gameId: string): Promise<boolean>;
  markGameUnlockedToday(userId: number, gameId: string): Promise<void>;
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
  getUserByNormalizedEmail(normalizedEmail: string): Promise<User | undefined>;
  getUserByVerificationToken(token: string): Promise<User | undefined>;
  getUserByResetToken(token: string): Promise<User | undefined>;
  updateUser(userId: number, data: Partial<User>): Promise<void>;
  updateUserEmailFlags(userId: number, flags: Partial<Pick<User, "sentWelcome" | "sentWalkthrough" | "sentDay3" | "sentWinback" | "sentWall" | "sentProWelcome" | "sentAllSportsWelcome">>): Promise<void>;
  countUnverifiedByFingerprint(fingerprint: string): Promise<number>;
  deleteUnverifiedOlderThan(cutoff: Date): Promise<number>;
  savePlayAlerts(plays: any[]): Promise<void>;
  getUnresolvedAlerts(): Promise<HalftimePlayAlert[]>;
  savePlayResult(alertId: number, actualStat: number, hit: boolean): Promise<void>;
  getAnalyticsSummary(range?: "today" | "yesterday" | "7d" | "30d" | "all"): Promise<AnalyticsSummary>;
  getRecentPlayAlerts(limit?: number): Promise<PlayAlertWithResult[]>;
  getAppSettings(): Promise<{ slateResetHour: number; slateResetMinute: number }>;
  saveAppSettings(hour: number, minute: number): Promise<void>;
  recordPlay(play: {
    id: string; gameId: string; playerId?: string; playerName: string; team?: string;
    sport: string; market: string; direction: string; line: number; prob: number;
    engineProb?: number; bookImplied?: number; edgeGap?: number; engineVersion?: string;
    projection?: number; sportsbook?: string | null; derivedLine?: boolean;
    gameDate: string; timestamp: Date; duplicateGuard: string;
    archetype?: string; fragilityScore?: number; fragilityPenalty?: number;
    fragilityReasons?: string; familyId?: string;
    siblingCount?: number; siblingRank?: number; flagshipOrDerivative?: string;
    familyPenaltyFactor?: number; calibrationTrack?: string;
    confidenceCeilingApplied?: boolean; ceilingReason?: string;
    rawProbOver?: number; rawProbUnder?: number;
    finalProbOver?: number; finalProbUnder?: number;
    displayConfidence?: number; modelEdge?: number;
    minutesExpected?: number; minutesVariance?: number;
    marketType?: string; playerVolatilityScore?: number;
    comboCovarianceEstimate?: number | null;
    mu?: number; sigma?: number; zScore?: number;
    hrBuildScore?: number | null;
    hrIntensity?: string | null;
    signalScore?: string | number;
    opportunityScore?: string;
    liveScore?: string;
    eventBoost?: string;
    odds?: number;
    stake?: number;
    confidenceTier?: string;
    inning?: number;
    abNumber?: number;
    pitchCount?: number;
    contactQualityScore?: number;
  }): Promise<{ id: string; isDuplicate: boolean }>;
  getPlays(opts: { sport?: string; limit?: number; settled?: string; date?: string }): Promise<{ plays: PersistedPlay[]; total: number }>;
  getAllSettledPlays(opts?: { sport?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]>;
  getGradedPlaysForCalibration(opts: { sport?: string; market?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]>;
  settlePlay(id: string, result: string, finalStat: number | null, settledAt: Date): Promise<PersistedPlay | null>;
  getPlayStats(): Promise<PlayStats>;
  getRecentGradedSignals(limit: number): Promise<PersistedPlay[]>;
  recordSignalInteraction(data: { userId: number; signalId?: string; action: string; sport?: string; market?: string }): Promise<void>;
  cleanupOldPlays(): Promise<number>;
  cleanDuplicatePlays(): Promise<{ removed: number; remaining: number }>;
  cleanDuplicateAlerts(): Promise<{ removed: number; remaining: number }>;
  hasProcessedStripeEvent(eventId: string): Promise<boolean>;
  recordStripeEvent(eventId: string): Promise<void>;
  recordChurn(userId: number, previousTier: string | null): Promise<void>;
  getChurnedUsers(): Promise<Array<{ id: number; email: string; churnedAt: Date; churnedFromTier: string | null; createdAt: Date | null }>>;
}

// ─── Usage compression for blowout games ──────────────────────────────────
function usageCompressionMultiplier(scoreDiff: number): number {
  const abs = Math.abs(scoreDiff);
  if (abs >= 25) return 0.78;
  if (abs >= 20) return 0.82;
  if (abs >= 15) return 0.88;
  return 1.0;
}

// ─── Possession-based tempo model ─────────────────────────────────────────
function estimatePossessionsPerMinute(period: number, scoreDiff: number): number {
  let ppm = 2.1;
  if (period === 4 && Math.abs(scoreDiff) <= 8) ppm = 1.7;
  if (period === 4 && Math.abs(scoreDiff) >= 15) ppm = 1.5;
  return ppm;
}

// ─── American odds → implied probability ──────────────────────────────────
function americanOddsToProb(odds: number): number {
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100);
  return 100 / (odds + 100);
}

// ─── Calibrated probability lookup ─────────────────────────────────────────
// Replaces the old linear formula (50 + diff × scaleFactor) with an interpolated
// edge→probability table derived from historical hit-rate buckets.
const HALFTIME_EDGE_BUCKETS: Array<[number, number]> = [
  [0.5, 0.52], [1.0, 0.54], [1.5, 0.56], [2.0, 0.58], [2.5, 0.60],
  [3.0, 0.62], [3.5, 0.64], [4.0, 0.66], [5.0, 0.69], [6.0, 0.72],
];
const LIVE_CONTEXT_LIFT = 0.015;

function edgeToProbability(
  edge: number,
  _statType: string,
  context: "halftime" | "live",
): number {
  const absEdge = Math.abs(edge);
  if (absEdge < 0.01) return 50;

  let prob: number;
  const buckets = HALFTIME_EDGE_BUCKETS;
  if (absEdge <= buckets[0][0]) {
    prob = 0.50 + (absEdge / buckets[0][0]) * (buckets[0][1] - 0.50);
  } else if (absEdge >= buckets[buckets.length - 1][0]) {
    const last = buckets[buckets.length - 1];
    const prev = buckets[buckets.length - 2];
    const slope = (last[1] - prev[1]) / (last[0] - prev[0]);
    prob = last[1] + slope * (absEdge - last[0]);
  } else {
    let lo = buckets[0], hi = buckets[1];
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i][0] >= absEdge) { hi = buckets[i]; lo = buckets[i - 1]; break; }
    }
    const t = (absEdge - lo[0]) / (hi[0] - lo[0]);
    prob = lo[1] + t * (hi[1] - lo[1]);
  }

  if (context === "live") prob += LIVE_CONTEXT_LIFT;

  const pctOver = prob * 100;
  const pct = edge >= 0 ? pctOver : 100 - pctOver;
  return Math.max(2, Math.min(98, Math.round(pct * 10) / 10));
}

// ─── Calibration lookup (directional confidence → deflated confidence) ────
function calibrateProbability(p: number): number {
  if (p >= 90) return 72;
  if (p >= 85) return 69;
  if (p >= 80) return 66;
  if (p >= 75) return 63;
  if (p >= 70) return 60;
  if (p >= 65) return 58;
  if (p >= 60) return 56;
  return p;
}

// ─── In-memory calc log (max 500 entries) ─────────────────────────────────
interface CalcLogEntry {
  player: string;
  statType: string;
  line: number;
  probability: number;
  direction: string;
  bookOdds: number | null;
  bookImplied: number | null;
  edgeRaw: number;
  edgeVsBook: number;
  archetype: string;
  avgMinutes: number;
  recommendedSide: "OVER" | "UNDER" | "NO_SIGNAL";
  displayConfidence: number | null;
  warnings: string[];
  noSignal: boolean;
  gameDate: string | null;
  timestamp: Date;
}
export const calcLogEntries: CalcLogEntry[] = [];

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

  async findPlayerByEspnId(espnAthleteId: number): Promise<Player | undefined> {
    const [player] = await db.select().from(players).where(eq(players.espnAthleteId, espnAthleteId));
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

  // ── NBA Season Context (season-aware, replaces month-only logic) ──────────
  // The old month-based helper bucketed every Mar–Apr game into "late", which
  // caused April playoff games to never reach the playoff calibration branch.
  // This helper uses explicit NBA calendar windows (regular season ends ~Apr 10,
  // playoffs begin shortly after) so the engine routes correctly.
  getNbaSeasonContext(gameDate?: string | Date): {
    seasonPhase: "early" | "mid" | "late" | "playoffs";
    isPlayoffs: boolean;
    isLateSeason: boolean;
    seasonKey: string;
  } {
    const d = gameDate ? new Date(gameDate) : new Date();
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;

    // NBA season starts in October. seasonStartYear is the calendar year of the Oct tip-off.
    const seasonStartYear = m >= 10 ? y : y - 1;

    // Conservative fixed windows. Playoffs cutover at Apr 10 of the season-end year.
    const lateSeasonStart = new Date(Date.UTC(seasonStartYear + 1, 2, 1)); // Mar 1
    const playoffsStart = new Date(Date.UTC(seasonStartYear + 1, 3, 10)); // Apr 10

    let seasonPhase: "early" | "mid" | "late" | "playoffs";
    if (d >= playoffsStart) seasonPhase = "playoffs";
    else if (d >= lateSeasonStart) seasonPhase = "late";
    else if (m >= 10 && m <= 12) seasonPhase = "early";
    else seasonPhase = "mid"; // Jan–Feb

    return {
      seasonPhase,
      isPlayoffs: seasonPhase === "playoffs",
      isLateSeason: seasonPhase === "late",
      seasonKey: `${seasonStartYear}-${String(seasonStartYear + 1).slice(2)}`,
    };
  }

  // Backward-compatible accessor. Delegates to getNbaSeasonContext so any other
  // call sites stay correct without reverting to the old month-only buckets.
  getSeasonPhase(gameDate?: string | Date): "early" | "mid" | "late" | "playoffs" {
    return this.getNbaSeasonContext(gameDate).seasonPhase;
  }

  async calculateProbability(req: CalculateProbabilityRequest): Promise<CalculateProbabilityResponse & { impliedProbability: number }> {
    const seasonContext = this.getNbaSeasonContext(req.gameDate);
    const seasonPhase = seasonContext.seasonPhase;
    const isPlayoffs = seasonContext.isPlayoffs;
    const seasonType: "Regular Season" | "Playoffs" = isPlayoffs ? "Playoffs" : "Regular Season";

    const player = await this.getPlayer(req.playerId);
    if (!player) throw new Error("Player not found");

    const defense = await this.getTeamDefense(req.opponentTeam, player.position);
    const dbDefenseMultiplier = defense ? Number(defense.defRating) : 1.0;

    // ─── NBA Stats API: enriched defense matchup + usage (non-blocking) ─────
    // For playoff games, request playoff-specific data first. If empty, fall
    // back to regular-season data and tag a diagnostic so calibration knows
    // it's working from regular-season context (and downgrades accordingly).
    let playoffDataFallbackUsed = false;
    let nbaDefenseMatchup: Awaited<ReturnType<typeof getTeamDefenseMatchup>> | null = null;
    let nbaPlayerUsage: Awaited<ReturnType<typeof getPlayerUsage>> | null = null;

    if (isPlayoffs) {
      const [defPlayoffs, usagePlayoffs] = await Promise.all([
        getTeamDefenseMatchup(req.opponentTeam, "Playoffs").catch(() => null),
        getPlayerUsage(player.name, String(player.id), "Playoffs").catch(() => null),
      ]);

      const defResolved = defPlayoffs && defPlayoffs.source === "nba_stats" && defPlayoffs.defRating != null;
      const usageResolved = usagePlayoffs && usagePlayoffs.source === "nba_stats" && usagePlayoffs.usageRate != null;

      if (defResolved && usageResolved) {
        nbaDefenseMatchup = defPlayoffs;
        nbaPlayerUsage = usagePlayoffs;
      } else {
        // Fall back to regular-season for any unresolved leg
        const [defRS, usageRS] = await Promise.all([
          defResolved ? Promise.resolve(defPlayoffs) : getTeamDefenseMatchup(req.opponentTeam, "Regular Season").catch(() => null),
          usageResolved ? Promise.resolve(usagePlayoffs) : getPlayerUsage(player.name, String(player.id), "Regular Season").catch(() => null),
        ]);
        nbaDefenseMatchup = defRS;
        nbaPlayerUsage = usageRS;
        playoffDataFallbackUsed = !defResolved || !usageResolved;
      }
    } else {
      const [defRS, usageRS] = await Promise.all([
        getTeamDefenseMatchup(req.opponentTeam, "Regular Season").catch(() => null),
        getPlayerUsage(player.name, String(player.id), "Regular Season").catch(() => null),
      ]);
      nbaDefenseMatchup = defRS;
      nbaPlayerUsage = usageRS;
    }
    const nbaDefMultiplier = nbaDefenseMatchup ? computeDefenseMultiplier(nbaDefenseMatchup, player.position ?? undefined) : dbDefenseMultiplier;
    const defenseMultiplier = nbaDefenseMatchup
      ? nbaDefMultiplier * 0.6 + dbDefenseMultiplier * 0.4
      : dbDefenseMultiplier;

    const avgMinutes = Number(player.avgMinutes);
    const usageRate = nbaPlayerUsage?.usageRate != null
      ? nbaPlayerUsage.usageRate / 100
      : player.usageRate ? Number(player.usageRate) : 0.22;
    const nbaUsageAdjustment = nbaPlayerUsage ? computeUsageAdjustment(nbaPlayerUsage) : 1.0;
    const minutesPlayed = req.halftimeMinutes;

    // ─── Projected minutes (staleness guard: discard if > 24 h old) ─────────
    const PROJECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const projectionAge = player.projectionUpdatedAt
      ? Date.now() - new Date(player.projectionUpdatedAt).getTime()
      : Infinity;
    const freshProjectedMinutes: number | null =
      player.projectedMinutes != null && projectionAge <= PROJECTION_MAX_AGE_MS
        ? Number(player.projectedMinutes)
        : null;
    const projectionSource: string = freshProjectedMinutes !== null
      ? (player.projectionSource ?? "projected")
      : "season_avg";

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

    // ─── Parse score diff (needed for minutes model + overtime boost) ──────
    const currentScore = req.halftimeScore;
    let parsedScoreDiff = 0;
    let hasScoreData = false;
    if (currentScore) {
      const sc = currentScore.split(/[- ]+/).map(Number);
      if (sc.length === 2 && !isNaN(sc[0]) && !isNaN(sc[1])) {
        parsedScoreDiff = sc[1] - sc[0];
        hasScoreData = true;
      }
    }

    // ─── Predictive minutes model ───────────────────────────────────────────
    const minutesResult = calculateRemainingMinutes({
      playerId: req.playerId,
      currentPeriod,
      clockMins,
      minutesPlayed,
      foulCount: req.halftimeFouls,
      scoreDiff: hasScoreData ? parsedScoreDiff : undefined,
      usageRate,
      avgMinutes,
      h2avgMinutes: h2Min ?? undefined,
      missingStarterCount: 0,
      projectedMinutes: freshProjectedMinutes,
      seasonPhase,
    });
    const remainingMinutes = minutesResult.expectedRemainingMinutes;

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

    if (currentScore) {
      const scores = currentScore.split(/[- ]+/).map(Number);
      if (scores.length === 2 && !isNaN(scores[0]) && !isNaN(scores[1])) {
        const scoreTotal = scores[0] + scores[1];
        const elapsedMins = 48 - gameMinutesRemaining;
        const impliedFullGame = elapsedMins > 0 ? (scoreTotal / elapsedMins) * 48 : EXPECTED_GAME_TOTAL;
        const impliedRef = req.gameTotalLine ? req.gameTotalLine : EXPECTED_GAME_TOTAL;
        const livePaceMultiplier = impliedFullGame / impliedRef;
        paceMultiplier = livePaceMultiplier * 0.35 + paceMultiplier * 0.65;
      }
    }
    const halfTimePaceCap = gameMinutesRemaining >= 22 ? 1.10 : 1.18;
    paceMultiplier = Math.max(0.78, Math.min(halfTimePaceCap, paceMultiplier));

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
    // Pull 4% more weight toward season baseline when the full 2H is still ahead.
    // Changed from 0.92 → 0.96 to reduce compounded UNDER suppression.
    if (isHalftimeContext && seasonPerMin) {
      const halftimeRegressionFactor = 0.96;
      observedW = observedW * halftimeRegressionFactor;
      seasonW   = 1 - observedW;
    }

    const blendedPerMin = observedPerMin * observedW + (seasonPerMin ?? 0) * seasonW;

    // ─── Context modifier cap (Step 5) ────────────────────────────────────
    // Combine defense, pace, and shooting into a single clamped modifier.
    // Halftime clamp widened to [0.90, 1.12] (was [0.92, 1.08]) to allow
    // stronger over-indicators to lift projections and reduce UNDER skew.
    const rawContextModifier = defenseMultiplier * paceMultiplier * shootingModifier;
    const suppressionRaw = rawContextModifier; // alias for trace log
    const contextClamp = isHalftimeContext ? { lo: 0.90, hi: 1.12 } : { lo: 0.88, hi: 1.18 };
    const contextModifier = Math.max(contextClamp.lo, Math.min(contextClamp.hi, rawContextModifier));

    const baselinePPM = 2.1;
    const livePPM = estimatePossessionsPerMinute(currentPeriod, parsedScoreDiff);
    const tempoMultiplier = livePPM / baselinePPM;
    const usageMultiplier = usageCompressionMultiplier(parsedScoreDiff);
    // Apply NBA Stats usage adjustment (clamped to [0.92, 1.08] to prevent overcorrection)
    const clampedNbaUsage = Math.max(0.92, Math.min(1.08, nbaUsageAdjustment));
    let expectedFromHere = blendedPerMin * remainingMinutes * contextModifier * tempoMultiplier * usageMultiplier * clampedNbaUsage;

    // ─── Overtime probability boost (Step 3) ──────────────────────────────
    if (hasScoreData && currentPeriod === 4 && clockMins <= 2.0 && Math.abs(parsedScoreDiff) <= 3) {
      if (parsedScoreDiff === 0 && clockMins <= 1.0) {
        expectedFromHere *= 1.05;
      } else {
        expectedFromHere *= 1.03;
      }
    }

    let expectedTotal = req.halftimeStat + expectedFromHere;

    // ─── Halftime total regression (REMOVED) ─────────────────────────────
    // Previously applied expectedTotal *= 0.96 for 16+ min players at halftime.
    // This double-dipped with the halftimeRegressionFactor (0.96) already applied
    // to observedW above, creating systematic UNDER bias for starters.

    // ─── Market anchoring ─────────────────────────────────────────────────
    const marketMean = req.liveLine + 0.5;
    const finalMean = 0.65 * expectedTotal + 0.35 * marketMean;
    const edge = finalMean - req.liveLine;

    // ─── NEW: Distribution-based probability engine (v2) ─────────────────
    // Uses normal CDF instead of bucket interpolation. No post-calibration expansion.
    const isComboStat = req.statType.includes("_") || req.statType.includes("+");

    // Archetype classification (new 7-level system)
    const effectiveMinutesBase = freshProjectedMinutes ?? avgMinutes;
    const rotationSource: "projected" | "season_avg" =
      freshProjectedMinutes !== null ? "projected" : "season_avg";
    const nbaArchetype = classifyNBAArchetype({
      avgMinutes,
      recentMinutesVariance: 0,
      seasonMinutesVariance: 0,
      isStarter: avgMinutes >= 25,
      usageRate,
      position: player.position ?? undefined,
      lineupDisrupted: false,
    });
    const archetype = nbaArchetype;

    // Variance computation for the distribution
    const varianceMultiplier = VARIANCE_MULTIPLIERS[nbaArchetype];
    const minutesFragility = MINUTES_FRAGILITY_MULTIPLIERS[nbaArchetype];

    // Per-minute variance rate (estimated from stat type)
    function estimateVarianceRate(statType: string): number {
      switch (statType) {
        case "points":   return 0.45;
        case "rebounds":  return 0.18;
        case "assists":   return 0.15;
        case "steals":    return 0.06;
        case "blocks":    return 0.06;
        case "threes":    return 0.10;
        default:          return 0.30;
      }
    }

    // Compute sigma for the stat distribution
    const minVar = (minutesFragility * 2.5) ** 2;
    let sigma: number;
    if (isComboStat) {
      // Combo variance with covariance
      const components: string[] = [];
      if (req.statType.includes("pts")) components.push("points");
      if (req.statType.includes("reb")) components.push("rebounds");
      if (req.statType.includes("ast")) components.push("assists");
      if (req.statType.includes("stl")) components.push("steals");
      if (req.statType.includes("blk")) components.push("blocks");

      let totalVariance = 0;
      const componentSigmas: Record<string, number> = {};
      for (const comp of components) {
        const vRate = estimateVarianceRate(comp);
        const rate = comp === "points" ? (ptsPerMin ?? 0) :
                     comp === "rebounds" ? (rebPerMin ?? 0) :
                     comp === "assists" ? (astPerMin ?? 0) :
                     comp === "steals" ? (stlPerMin ?? 0) :
                     comp === "blocks" ? (blkPerMin ?? 0) : 0;
        const rawVar = remainingMinutes * vRate + (rate * rate) * minVar;
        const adjVar = rawVar * varianceMultiplier;
        const floor = (STAT_SIGMA_FLOORS_V2[comp] ?? 1.0) ** 2;
        const finalVar = Math.max(adjVar, floor);
        totalVariance += finalVar;
        componentSigmas[comp] = Math.sqrt(finalVar);
      }

      // Add covariance terms
      const correlations = CORRELATION_DEFAULTS[nbaArchetype];
      const covExtra = COMBO_VARIANCE_EXTRA[nbaArchetype];
      for (let i = 0; i < components.length; i++) {
        for (let j = i + 1; j < components.length; j++) {
          const a = components[i], b = components[j];
          const rho = getDefaultCorrelation(a, b, correlations);
          totalVariance += 2 * rho * componentSigmas[a] * componentSigmas[b];
        }
      }
      totalVariance *= covExtra;

      // Combo inflation factors
      const comboInflation = req.statType === "pts_reb" ? 1.05 :
                             req.statType === "pts_ast" ? 1.08 :
                             req.statType === "reb_ast" ? 1.08 :
                             req.statType === "pts_reb_ast" ? 1.12 : 1.0;
      totalVariance *= comboInflation;

      sigma = Math.sqrt(Math.max(totalVariance, 4.0));
    } else {
      // Single-stat variance
      const vRate = estimateVarianceRate(req.statType);
      const rate = seasonPerMin ?? 0;
      const rawVar = remainingMinutes * vRate + (rate * rate) * minVar;
      const adjVar = rawVar * varianceMultiplier;
      const floor = (STAT_SIGMA_FLOORS_V2[req.statType] ?? 1.0) ** 2;
      sigma = Math.sqrt(Math.max(adjVar, floor));
    }

    // Normal CDF probability
    const threshold = req.liveLine + 0.5;
    const z = (finalMean - threshold) / sigma;
    const P_over_raw = phiCDF(z);
    const P_under_raw = 1 - P_over_raw;

    // Side selection with epsilon guard
    const epsilon = isComboStat ? 0.60 : 0.35;
    const separation = Math.abs(finalMean - req.liveLine);

    let rawSide: "OVER" | "UNDER" | "NO_SIGNAL";
    let P_side_raw: number;

    if (finalMean > req.liveLine && separation >= epsilon) {
      rawSide = "OVER";
      P_side_raw = P_over_raw;
    } else if (finalMean < req.liveLine && separation >= epsilon) {
      rawSide = "UNDER";
      P_side_raw = P_under_raw;
    } else {
      rawSide = "NO_SIGNAL";
      P_side_raw = Math.max(P_over_raw, P_under_raw);
    }

    const direction = rawSide === "NO_SIGNAL" ? "UNDER" : rawSide;

    const modelEdgeRaw = P_side_raw - 0.50;
    let preCalibrationNoSignal = false;
    if (modelEdgeRaw < 0.04 && rawSide !== "NO_SIGNAL") {
      preCalibrationNoSignal = true;
    }

    // [HT_SUPPRESSION_TRACE]
    if (isHalftimeContext && process.env.DEBUG_PIPELINE === "true") {
      console.log("[HT_SUPPRESSION_TRACE]", {
        player: player.name,
        market: req.statType,
        baseProjection: Math.round(blendedPerMin * remainingMinutes * 100) / 100,
        paceMultiplier: Math.round(paceMultiplier * 1000) / 1000,
        defenseMultiplier: Math.round(defenseMultiplier * 1000) / 1000,
        shootingModifier: Math.round(shootingModifier * 1000) / 1000,
        suppressionRaw: Math.round(suppressionRaw * 1000) / 1000,
        suppressionClamped: Math.round(contextModifier * 1000) / 1000,
        finalProjection: Math.round(expectedTotal * 100) / 100,
        line: req.liveLine,
        direction,
        edge: Math.round(edge * 100) / 100,
        sigma: Math.round(sigma * 100) / 100,
        z: Math.round(z * 1000) / 1000,
        P_over_raw: Math.round(P_over_raw * 10000) / 10000,
        archetype: nbaArchetype,
      });
    }

    // Fragility penalty
    const isBlowout = Math.abs(parsedScoreDiff) > 15;
    let fragilityScore = Math.max(0, Math.min(1,
      0.25 * (effectiveMinutesBase < 20 ? 0.8 : effectiveMinutesBase < 26 ? 0.4 : 0.1) +
      0.20 * (avgMinutes < 22 ? 0.6 : 0.1) +
      0.20 * 0.1 +
      0.15 * (isBlowout ? 0.7 : 0.0) +
      0.10 * 0.0 +
      0.10 * (seasonPhase === "late" ? 0.4 : 0.0)
    ));
    // Playoff-aware fragility: stars stay steady (mult ~0.98), bench/role/
    // impacted players become more fragile in playoff contexts. Multiplier
    // table lives in nba/archetypes.ts.
    if (isPlayoffs) {
      fragilityScore = Math.min(1, fragilityScore * getPlayoffFragilityMultiplier(nbaArchetype));
    }
    const fragilityPenalty = 0.45 * fragilityScore;
    const P_side_fragile = 0.5 + (P_side_raw - 0.5) * (1 - fragilityPenalty);

    // Calibration (split by single/combo, archetype)
    const calibrationShrink = isComboStat ? 0.78 : 0.88;
    let P_side_calibrated = 0.5 + (P_side_fragile - 0.5) * calibrationShrink;
    let calibrationTrack = isComboStat ? "combo_0.78" : "single_0.88";

    if (isVolatileArchetype(nbaArchetype) || isImpactedArchetype(nbaArchetype)) {
      P_side_calibrated = 0.5 + (P_side_calibrated - 0.5) * 0.90;
      calibrationTrack += "+volatile_0.90";
    }

    // Directional bias correction
    const underBiasActive = isUnderBiasCorrectionActive();
    if (rawSide === "UNDER" && underBiasActive) {
      P_side_calibrated = 0.5 + (P_side_calibrated - 0.5) * 0.92;
      calibrationTrack += "+under_bias_0.92";
    }

    // ── Playoff calibration branch (PHASE 2) ───────────────────────────────
    // Apply an additional shrink toward 0.5 for playoff games. Combo markets
    // shrink harder than single markets; volatile/impacted archetypes get an
    // extra penalty layered on top. This is the primary mechanism for stopping
    // the 80–100 confidence bucket from being overclaimed in playoffs.
    if (isPlayoffs) {
      const baseShrink = isComboStat ? 0.72 : 0.82;
      let archetypePenalty = 1.0;
      switch (nbaArchetype) {
        case "volatile_starter": archetypePenalty = 0.95; break;
        case "bench_microwave":  archetypePenalty = 0.90; break;
        case "low_minute_big":   archetypePenalty = 0.92; break;
        case "lineup_impacted":  archetypePenalty = 0.88; break;
        case "role_uncertain":   archetypePenalty = 0.85; break;
      }
      const shrunk = 0.5 + (P_side_calibrated - 0.5) * baseShrink * archetypePenalty;
      P_side_calibrated = Math.max(0.02, Math.min(0.98, shrunk));
      calibrationTrack += `+playoff_shrink_${baseShrink.toFixed(2)}x${archetypePenalty.toFixed(2)}`;
    }

    // Safety ceiling — playoff ceiling overlaid on top of regular-season ceiling.
    // We always take the more conservative (lower) of the two so playoff mode
    // can never raise the cap above what regular-season would allow.
    const regularCeiling = getSafetyCeiling(nbaArchetype, isComboStat);
    const playoffCeiling = isPlayoffs ? getPlayoffSafetyCeiling(nbaArchetype, isComboStat) : regularCeiling;
    const appliedCeiling = Math.min(regularCeiling, playoffCeiling);
    let P_side_final = Math.min(P_side_calibrated, appliedCeiling);
    let confidenceCeilingApplied = P_side_calibrated > appliedCeiling;
    let ceilingReason = confidenceCeilingApplied
      ? `${nbaArchetype}_${isComboStat ? "combo" : "single"}_cap_${appliedCeiling}${isPlayoffs && appliedCeiling < regularCeiling ? "_playoff" : ""}`
      : null;
    if (isPlayoffs && appliedCeiling < regularCeiling) {
      calibrationTrack += `+playoff_cap_${appliedCeiling}`;
    }
    // Backwards-compat for existing diagnostics field name.
    const ceiling = appliedCeiling;

    // Convert to percentage scale for compatibility
    let probability = rawSide === "OVER"
      ? P_side_final * 100
      : (1 - P_side_final) * 100;

    probability = Math.max(2, Math.min(98, probability));

    // Directional semantics
    const overLeanProbability = probability;
    const overConfidence = overLeanProbability;
    const underConfidence = 100 - overLeanProbability;

    const recommendedSide: "OVER" | "UNDER" | "NO_SIGNAL" =
      rawSide === "NO_SIGNAL" ? "NO_SIGNAL" :
      overLeanProbability > 50 ? "OVER" :
      overLeanProbability < 50 ? "UNDER" :
      "NO_SIGNAL";

    let displayConfidence: number | null =
      recommendedSide === "NO_SIGNAL" ? null :
      recommendedSide === "OVER" ? overConfidence :
      underConfidence;

    // ── Playoff anti-overconfidence guards (PHASE 8) ───────────────────────
    // Guard 1: in playoffs, only stable_star is allowed to display ≥80
    //   confidence. Everyone else gets clamped to a tier-appropriate cap so
    //   bench/volatile/role-uncertain plays can't claim elite status.
    // Guard 2: if we had to fall back to regular-season data inside a playoff
    //   game, refuse to surface elite-tier confidence regardless of archetype.
    let playoffHighBucketGuardApplied = false;
    let playoffFallbackCapApplied = false;
    if (isPlayoffs && displayConfidence !== null) {
      if (displayConfidence >= 80 && nbaArchetype !== "stable_star") {
        const cap = isComboStat ? 68 : 74;
        if (displayConfidence > cap) {
          displayConfidence = cap;
          calibrationTrack += "+playoff_high_bucket_guard";
          playoffHighBucketGuardApplied = true;
        }
      }
      if (playoffDataFallbackUsed) {
        const cap = 72;
        if (displayConfidence > cap) {
          displayConfidence = cap;
          calibrationTrack += "+playoff_fallback_cap";
          playoffFallbackCapApplied = true;
        }
      }
    }

    // Integrity guard
    const warnings: string[] = [];
    if (recommendedSide === "OVER" && expectedTotal <= req.liveLine) {
      warnings.push("direction_projection_mismatch");
    }
    if (recommendedSide === "UNDER" && expectedTotal >= req.liveLine) {
      warnings.push("direction_projection_mismatch");
    }
    const hasProjectionMismatch = warnings.includes("direction_projection_mismatch");

    const sportsbookImplied = americanOddsToProb(req.bookOdds ?? -110) * 100;
    const edgeVsBook = (displayConfidence !== null ? displayConfidence : Math.abs(probability - 50) + 50) - sportsbookImplied;

    const MIN_DISPLAY_CONFIDENCE = 58;
    const modelEdgeFinal = displayConfidence !== null ? (displayConfidence - 50) : 0;
    const noSignal = rawSide === "NO_SIGNAL"
      || preCalibrationNoSignal
      || (displayConfidence !== null && displayConfidence < MIN_DISPLAY_CONFIDENCE)
      || modelEdgeFinal < 4
      || hasProjectionMismatch;

    let usageUnderPenaltyApplied = false;
    let comboVariancePenaltyApplied = isComboStat;
    let volatilityFiltered = isVolatileArchetype(nbaArchetype);
    let lateSeasonPenaltyApplied = seasonPhase === "late" && fragilityScore > 0.2;
    let teamVolatilityPenaltyApplied = seasonPhase === "late" && HIGH_VOLATILITY_TEAMS.has(player.team);
    // Legacy flag retained for downstream analytics. Now true whenever the
    // playoff calibration branch executed (regardless of guard activation).
    let playoffBoostApplied = isPlayoffs;

    // ── Playoff diagnostics log (PHASE 6) ──────────────────────────────────
    if (isPlayoffs) {
      console.log("[NBA_PLAYOFF_ENGINE]", JSON.stringify({
        player: player.name,
        gameId: req.gameId,
        market: req.statType,
        seasonPhase,
        archetype: nbaArchetype,
        projection: Math.round(expectedTotal * 10) / 10,
        line: req.liveLine,
        finalProbOver: Math.round((rawSide === "OVER" ? P_side_final : 1 - P_side_final) * 10000) / 10000,
        finalProbUnder: Math.round((rawSide === "UNDER" ? P_side_final : 1 - P_side_final) * 10000) / 10000,
        displayConfidence: displayConfidence !== null ? Math.round(displayConfidence * 10) / 10 : null,
        regularCeiling,
        playoffCeiling,
        appliedCeiling,
        calibrationTrack,
        playoffDataFallbackUsed,
        playoffHighBucketGuardApplied,
        playoffFallbackCapApplied,
      }));
    }

    if (process.env.DEBUG_PIPELINE === "true" || noSignal) {
      console.log(
        `[calc] ${player.name}: period=${currentPeriod} remainMin=${remainingMinutes.toFixed(1)} ` +
        `proj=${expectedTotal.toFixed(1)} line=${req.liveLine} side=${recommendedSide} ` +
        `overConf=${overConfidence.toFixed(1)} underConf=${underConfidence.toFixed(1)} ` +
        `dispConf=${displayConfidence?.toFixed(1) ?? "null"} edgeVsBook=${edgeVsBook.toFixed(1)} ` +
        `archetype=${archetype} noSignal=${noSignal} warnings=${warnings.join(",") || "none"}`
      );
    }

    // ─── In-memory calc log ───────────────────────────────────────────────
    // CALC LOG CONTRACT (STRICT — DO NOT VIOLATE):
    // - Only push final, post-calibration values (probability, edge, direction).
    //   Never store raw, pre-calibration, or intermediate values.
    // - Excluded plays (produce zero side effects — must NOT appear in calcLogEntries):
    //     • noSignal === true: edgeVsBook < 3, displayConfidence < 55, or projection mismatch
    //     • recommendedSide === "NO_SIGNAL": probability === 50, zero-edge
    //   Both conditions are checked so that all "skipped" plays are excluded, matching the
    //   skip behavior of the production signal evaluation path in routes.ts.
    // - Audit endpoints must treat calcLogEntries as the single source of truth and must
    //   never reimplement signal evaluation logic.
    if (!noSignal && recommendedSide !== "NO_SIGNAL") {
      // finalProbability: post-calibration, post-penalty, post-clamp probability.
      // finalEdge: |finalProbability - 50| — the final gating edge used in routes.ts.
      // direction: derived from recommendedSide (post-calibration) not the early `direction`
      //   variable, so it reflects the same classification as allSignals/allPlays in routes.ts.
      const finalProbability = Math.round(probability * 10) / 10;
      const finalEdge = Math.round(Math.abs(finalProbability - 50) * 10) / 10;
      // Explicit finite guard: NaN would cause NaN > 50 === false in recommendedSide ternary,
      // which resolves to "NO_SIGNAL" and is already excluded above — but this guard makes
      // the exclusion explicit so the logging contract is self-evident in isolation.
      if (Number.isFinite(finalProbability)) calcLogEntries.push({
        player: player.name,
        statType: req.statType,
        line: req.liveLine,
        probability: finalProbability,
        direction: recommendedSide as "OVER" | "UNDER",
        bookOdds: req.bookOdds ?? null,
        bookImplied: Math.round(sportsbookImplied * 10) / 10,
        edgeRaw: finalEdge,
        edgeVsBook: Math.round(edgeVsBook * 10) / 10,
        archetype,
        avgMinutes,
        recommendedSide,
        displayConfidence: displayConfidence !== null ? Math.round(displayConfidence * 10) / 10 : null,
        warnings,
        noSignal,
        gameDate: req.gameDate ?? null,
        timestamp: new Date(),
      });
      if (calcLogEntries.length > 500) {
        calcLogEntries.splice(0, calcLogEntries.length - 500);
      }
    }

    const debug: CalcDebug = {
      projection: Math.round(expectedTotal * 10) / 10,
      line: req.liveLine,
      edge: Math.round(edge * 100) / 100,
      seasonPerMin: seasonPerMin ? Math.round(seasonPerMin * 1000) / 1000 : null,
      observedPerMin: Math.round(observedPerMin * 1000) / 1000,
      observedWeight: Math.round(observedW * 100) / 100,
      seasonWeight: Math.round(seasonW * 100) / 100,
      remainingMinutes: Math.round(remainingMinutes * 10) / 10,
      paceMultiplier: Math.round(paceMultiplier * 100) / 100,
      defenseMultiplier: Math.round(defenseMultiplier * 100) / 100,
      shootingModifier: Math.round(shootingModifier * 100) / 100,
      contextModifier: Math.round(contextModifier * 100) / 100,
      probabilityCalibrated: probability,
      expectedRemainingMinutes: minutesResult.expectedRemainingMinutes,
      closingProbability: minutesResult.closingProbability,
      minutesConfidence: minutesResult.minutesConfidence,
      projectedMinutes: freshProjectedMinutes,
      projectionSource,
      volatilityFiltered,
      usageUnderPenaltyApplied,
      comboVariancePenaltyApplied,
      effectiveMinutesBase,
      rotationSource,
      noSignal,
      seasonPhase,
      lateSeasonPenaltyApplied,
      playoffBoostApplied,
      teamVolatilityPenaltyApplied,
      usageMultiplier: Math.round(usageMultiplier * 1000) / 1000,
      archetype,
      overConfidence: Math.round(overConfidence * 10) / 10,
      underConfidence: Math.round(underConfidence * 10) / 10,
      displayConfidence: displayConfidence !== null ? Math.round(displayConfidence * 10) / 10 : null,
      recommendedSide,
      warnings,
      // ── Playoff diagnostics (PHASE 6) ──────────────────────────────────
      playoffMode: isPlayoffs,
      playoffDataRequested: isPlayoffs,
      playoffDataResolved: isPlayoffs && !playoffDataFallbackUsed && (!!nbaDefenseMatchup || !!nbaPlayerUsage),
      playoffDataFallbackUsed: isPlayoffs && playoffDataFallbackUsed,
      playoffCalibrationApplied: isPlayoffs,
      playoffMinutesAdjustmentApplied: isPlayoffs,
      playoffCeilingApplied: isPlayoffs && appliedCeiling < regularCeiling,
      playoffCeilingValue: isPlayoffs ? appliedCeiling : null,
      regularCeilingValue: regularCeiling,
      playoffHighBucketGuardApplied,
      playoffFallbackCapApplied,
      seasonPhaseResolvedFrom: req.gameDate ? "gameDate" : "systemDate",
    };

    const engineDiagnostics = {
      archetype,
      fragilityScore: Math.round(fragilityScore * 1000) / 1000,
      fragilityPenalty: Math.round(fragilityPenalty * 1000) / 1000,
      calibrationTrack,
      confidenceCeilingApplied,
      ceilingReason,
      rawProbOver: Math.round(P_over_raw * 10000) / 10000,
      rawProbUnder: Math.round(P_under_raw * 10000) / 10000,
      finalProbOver: Math.round((rawSide === "OVER" ? P_side_final : 1 - P_side_final) * 10000) / 10000,
      finalProbUnder: Math.round((rawSide === "UNDER" ? P_side_final : 1 - P_side_final) * 10000) / 10000,
      displayConfidence: displayConfidence !== null ? Math.round(displayConfidence * 10) / 10 : null,
      modelEdge: Math.round(modelEdgeFinal * 100) / 100,
      minutesExpected: Math.round(remainingMinutes * 10) / 10,
      minutesVariance: Math.round(minVar * 100) / 100,
      marketType: isComboStat ? "combo" : "single",
      playerVolatilityScore: Math.round(fragilityScore * 1000) / 1000,
      engineVersion: "v2_cdf",
      mu: Math.round(finalMean * 100) / 100,
      sigma: Math.round(sigma * 100) / 100,
      zScore: Math.round(z * 1000) / 1000,
    };

    if (!noSignal && (req as any).sport === "nba") {
      console.log("[ENGINE_OUTPUT]", JSON.stringify({
        player: (req as any).playerName,
        gameId: req.gameId,
        market: req.statType,
        marketType: isComboStat ? "combo" : "single",
        side: recommendedSide,
        projection: Math.round(expectedTotal * 10) / 10,
        line: req.liveLine,
        rawProbabilityOver: engineDiagnostics.rawProbOver,
        rawProbabilityUnder: engineDiagnostics.rawProbUnder,
        finalProbabilityOver: engineDiagnostics.finalProbOver,
        finalProbabilityUnder: engineDiagnostics.finalProbUnder,
        displayConfidence: engineDiagnostics.displayConfidence,
        modelEdge: engineDiagnostics.modelEdge,
        archetype,
        minutesExpected: engineDiagnostics.minutesExpected,
        minutesVariance: engineDiagnostics.minutesVariance,
        playerVolatilityScore: engineDiagnostics.playerVolatilityScore,
        fragilityScore: engineDiagnostics.fragilityScore,
        calibrationTrack,
        confidenceCeilingApplied,
        engineVersion: "v2_cdf",
      }));
    }

    return {
      probability: Math.round(probability * 10) / 10,
      impliedProbability: Math.round(probability * 10) / 10,
      overConfidence: Math.round(overConfidence * 10) / 10,
      underConfidence: Math.round(underConfidence * 10) / 10,
      displayConfidence: displayConfidence !== null ? Math.round(displayConfidence * 10) / 10 : null,
      recommendedSide,
      warnings,
      edge: Math.round(edgeVsBook * 10) / 10,
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
      noSignal,
      debug: req.isDebug ? debug : undefined,
      ...(engineDiagnostics ? { engineDiagnostics } : {}),
    } as any;
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

  async incrementPlaysUsedToday(userId: number): Promise<void> {
    await db.update(users)
      .set({ playsUsedToday: sql`${users.playsUsedToday} + 1` })
      .where(eq(users.id, userId));
  }

  async tryConsumePlayToday(userId: number): Promise<{ allowed: boolean; playsUsedToday: number }> {
    const today = todayET();
    const result = await db.execute(sql`
      UPDATE users
      SET plays_used_today = plays_used_today + 1
      WHERE id = ${userId}
        AND plays_used_today < 3
        AND plays_reset_date = ${today}
      RETURNING plays_used_today
    `);
    if (result.rows.length > 0) {
      return { allowed: true, playsUsedToday: result.rows[0].plays_used_today as number };
    }
    const user = await this.getUserById(userId);
    return { allowed: false, playsUsedToday: user?.playsUsedToday ?? 3 };
  }

  async tryConsumeGamePlayToday(userId: number, gameId: string, limit: number = 3): Promise<{ allowed: boolean; alreadyUnlocked: boolean; playsUsedToday: number }> {
    const today = todayET();
    const result = await db.execute(sql`
      UPDATE users
      SET
        plays_used_today = plays_used_today + 1,
        unlocked_game_ids_today = (
          SELECT jsonb_agg(elem)::text
          FROM (
            SELECT jsonb_array_elements_text(unlocked_game_ids_today::jsonb) AS elem
            UNION ALL
            SELECT ${gameId}::text
          ) sub
        )
      WHERE id = ${userId}
        AND plays_used_today < ${limit}
        AND plays_reset_date = ${today}
        AND NOT (unlocked_game_ids_today::jsonb @> to_jsonb(${gameId}::text))
      RETURNING plays_used_today
    `);
    if (result.rows.length > 0) {
      return { allowed: true, alreadyUnlocked: false, playsUsedToday: result.rows[0].plays_used_today as number };
    }
    const user = await this.getUserById(userId);
    const alreadyUnlocked = user ? (() => {
      try { return (JSON.parse(user.unlockedGameIdsToday ?? "[]") as string[]).includes(gameId); } catch { return false; }
    })() : false;
    return { allowed: false, alreadyUnlocked, playsUsedToday: user?.playsUsedToday ?? limit };
  }

  async resetDailyPlaysIfNeeded(userId: number): Promise<User | undefined> {
    const user = await this.getUserById(userId);
    if (!user) return undefined;
    const today = todayET();
    if (user.playsResetDate !== today) {
      await db.update(users).set({ playsUsedToday: 0, playsResetDate: today, unlockedGameIdsToday: "[]" }).where(eq(users.id, userId));
      return { ...user, playsUsedToday: 0, playsResetDate: today, unlockedGameIdsToday: "[]" };
    }
    return user;
  }

  async isGameUnlockedToday(userId: number, gameId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    if (!user) return false;
    try {
      const ids: string[] = JSON.parse(user.unlockedGameIdsToday ?? "[]");
      return ids.includes(gameId);
    } catch {
      return false;
    }
  }

  async markGameUnlockedToday(userId: number, gameId: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) return;
    try {
      const ids: string[] = JSON.parse(user.unlockedGameIdsToday ?? "[]");
      if (!ids.includes(gameId)) {
        ids.push(gameId);
        await db.update(users).set({ unlockedGameIdsToday: JSON.stringify(ids) }).where(eq(users.id, userId));
      }
    } catch {
      await db.update(users).set({ unlockedGameIdsToday: JSON.stringify([gameId]) }).where(eq(users.id, userId));
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
    const today = todayET();
    await db.update(users).set({ playsUsed: 0, playsUsedToday: 0, playsResetDate: today }).where(eq(users.id, userId));
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

  async getUserByNormalizedEmail(normalizedEmail: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.normalizedEmail, normalizedEmail));
    return user;
  }

  async getUserByVerificationToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.emailVerificationToken, token));
    return user;
  }

  async getUserByResetToken(token: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.resetPasswordToken, token));
    return user;
  }

  async updateUser(userId: number, data: Partial<User>): Promise<void> {
    await db.update(users).set(data).where(eq(users.id, userId));
  }

  async updateUserEmailFlags(userId: number, flags: Partial<Pick<User, "sentWelcome" | "sentWalkthrough" | "sentDay3" | "sentWinback" | "sentWall" | "sentProWelcome" | "sentAllSportsWelcome">>): Promise<void> {
    if (Object.keys(flags).length === 0) return;
    await db.update(users).set(flags).where(eq(users.id, userId));
  }

  async countUnverifiedByFingerprint(fingerprint: string): Promise<number> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.signupFingerprint, fingerprint), eq(users.emailVerified, false)));
    return rows.length;
  }

  async deleteUnverifiedOlderThan(cutoff: Date): Promise<number> {
    // Strategy: hard-delete unverified users older than the cutoff.
    // The only FK referencing users.id is sent_alerts.user_id; since unverified
    // users cannot access plays (blocked by requirePlayAccess), they will not have
    // meaningful dependent rows. We delete sent_alerts rows first to satisfy FK constraints,
    // then delete the user rows.
    const unverified = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.emailVerified, false), lte(users.createdAt, cutoff)));

    if (unverified.length === 0) return 0;

    const ids = unverified.map(u => u.id);
    const { sentAlerts } = await import("@shared/schema");
    await db.delete(sentAlerts).where(inArray(sentAlerts.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
    return ids.length;
  }

  async savePlayAlerts(plays: any[]): Promise<void> {
    const today = todayET();
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

  async getAnalyticsSummary(range?: "today" | "yesterday" | "7d" | "30d" | "all"): Promise<AnalyticsSummary> {
    let dateFilter: ReturnType<typeof sql> | null = null;
    const effectiveRange = range ?? "all";
    if (effectiveRange === "today") {
      dateFilter = sql`${halftimePlayAlerts.gameDate} = CURRENT_DATE::text`;
    } else if (effectiveRange === "yesterday") {
      dateFilter = sql`${halftimePlayAlerts.gameDate} = (CURRENT_DATE - INTERVAL '1 day')::date::text`;
    } else if (effectiveRange === "7d") {
      dateFilter = sql`${halftimePlayAlerts.gameDate} >= (CURRENT_DATE - INTERVAL '7 days')::date::text`;
    } else if (effectiveRange === "30d") {
      dateFilter = sql`${halftimePlayAlerts.gameDate} >= (CURRENT_DATE - INTERVAL '30 days')::date::text`;
    }

    let query = db
      .select({
        probability: halftimePlayAlerts.probability,
        betDirection: halftimePlayAlerts.betDirection,
        hit: playResults.hit,
      })
      .from(halftimePlayAlerts)
      .innerJoin(playResults, eq(playResults.alertId, halftimePlayAlerts.id));

    if (dateFilter) {
      query = query.where(dateFilter) as typeof query;
    }

    const rows = await query;

    const BUCKETS = [
      { label: "60-69%", min: 60, max: 69.99, expectedWinRate: 64.5 },
      { label: "70-79%", min: 70, max: 79.99, expectedWinRate: 74.5 },
      { label: "80-89%", min: 80, max: 89.99, expectedWinRate: 84.5 },
      { label: "90%+",   min: 90, max: 100,   expectedWinRate: 92 },
    ];

    const buckets = BUCKETS.map(({ label, min, max, expectedWinRate }) => {
      const inBucket = rows.filter((r) => {
        const prob = Number(r.probability);
        const conf = r.betDirection === "over" ? prob : 100 - prob;
        return conf >= min && conf <= max;
      });
      const hits = inBucket.filter((r) => r.hit === true).length;
      const total = inBucket.length;
      const winRate = total > 0 ? (hits / total) * 100 : 0;
      const roi = total > 0 ? ((hits * 90.91 - (total - hits) * 100) / total) : 0;
      const actualWinRate = Math.round(winRate * 10) / 10;
      const calibrationError = Math.round((actualWinRate - expectedWinRate) * 10) / 10;
      return { label, min, max, total, hits, winRate: actualWinRate, roi: Math.round(roi * 10) / 10, expectedWinRate, actualWinRate, calibrationError };
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
    engineProb?: number; bookImplied?: number; edgeGap?: number; engineVersion?: string;
    projection?: number; sportsbook?: string | null; derivedLine?: boolean;
    gameDate: string; timestamp: Date; duplicateGuard: string;
    archetype?: string; fragilityScore?: number; fragilityPenalty?: number;
    fragilityReasons?: string; familyId?: string;
    siblingCount?: number; siblingRank?: number; flagshipOrDerivative?: string;
    familyPenaltyFactor?: number; calibrationTrack?: string;
    confidenceCeilingApplied?: boolean; ceilingReason?: string;
    rawProbOver?: number; rawProbUnder?: number;
    finalProbOver?: number; finalProbUnder?: number;
    displayConfidence?: number; modelEdge?: number;
    minutesExpected?: number; minutesVariance?: number;
    marketType?: string; playerVolatilityScore?: number;
    comboCovarianceEstimate?: number | null;
    mu?: number; sigma?: number; zScore?: number;
    hrBuildScore?: number | null;
    hrIntensity?: string | null;
    signalScore?: string | number;
    opportunityScore?: string;
    liveScore?: string;
    eventBoost?: string;
    odds?: number;
    stake?: number;
    confidenceTier?: string;
    inning?: number;
    abNumber?: number;
    pitchCount?: number;
    contactQualityScore?: number;
  }): Promise<{ id: string; isDuplicate: boolean }> {
    const existing = await db
      .select({ id: persistedPlays.id, signalScore: persistedPlays.signalScore })
      .from(persistedPlays)
      .where(eq(persistedPlays.duplicateGuard, play.duplicateGuard))
      .limit(1);
    if (existing.length > 0) {
      const oldScore = Number(existing[0].signalScore ?? 0);
      const newScore = Number(play.signalScore ?? 0);
      if (newScore > oldScore) {
        await db.update(persistedPlays).set({
          line: String(play.line),
          prob: String(play.prob),
          engineProb: play.engineProb != null ? String(play.engineProb) : undefined,
          edgeGap: play.edgeGap != null ? String(play.edgeGap) : undefined,
          projection: play.projection != null ? String(play.projection) : undefined,
          signalScore: play.signalScore != null ? String(play.signalScore) : undefined,
          confidenceTier: play.confidenceTier ?? undefined,
          liveScore: play.liveScore ?? undefined,
          opportunityScore: play.opportunityScore ?? undefined,
          eventBoost: play.eventBoost ?? undefined,
          inning: play.inning ?? undefined,
          abNumber: play.abNumber ?? undefined,
        }).where(eq(persistedPlays.id, existing[0].id));
        console.log(`[PlayTracker] UPSERT — updated ${existing[0].id} with higher signalScore ${newScore} > ${oldScore}`);
      }
      return { id: existing[0].id, isDuplicate: true };
    }
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
      engineVersion: play.engineVersion ?? null,
      projection: play.projection != null ? String(play.projection) : null,
      sportsbook: play.sportsbook ?? null,
      derivedLine: play.derivedLine ?? null,
      gameDate: play.gameDate,
      timestamp: play.timestamp,
      duplicateGuard: play.duplicateGuard,
      archetype: play.archetype ?? null,
      fragilityScore: play.fragilityScore != null ? String(play.fragilityScore) : null,
      familyId: play.familyId ?? null,
      siblingCount: play.siblingCount ?? null,
      siblingRank: play.siblingRank ?? null,
      flagshipOrDerivative: play.flagshipOrDerivative ?? null,
      familyPenaltyFactor: play.familyPenaltyFactor != null ? String(play.familyPenaltyFactor) : null,
      calibrationTrack: play.calibrationTrack ?? null,
      confidenceCeilingApplied: play.confidenceCeilingApplied ?? null,
      ceilingReason: play.ceilingReason ?? null,
      rawProbOver: play.rawProbOver != null ? String(play.rawProbOver) : null,
      rawProbUnder: play.rawProbUnder != null ? String(play.rawProbUnder) : null,
      modelEdge: play.modelEdge != null ? String(play.modelEdge) : null,
      minutesExpected: play.minutesExpected != null ? String(play.minutesExpected) : null,
      minutesVariance: play.minutesVariance != null ? String(play.minutesVariance) : null,
      marketType: play.marketType ?? null,
      finalProbOver: play.finalProbOver != null ? String(play.finalProbOver) : null,
      finalProbUnder: play.finalProbUnder != null ? String(play.finalProbUnder) : null,
      displayConfidence: play.displayConfidence != null ? String(play.displayConfidence) : null,
      playerVolatilityScore: play.playerVolatilityScore != null ? String(play.playerVolatilityScore) : null,
      comboCovarianceEstimate: play.comboCovarianceEstimate != null ? String(play.comboCovarianceEstimate) : null,
      fragilityPenalty: play.fragilityPenalty != null ? String(play.fragilityPenalty) : null,
      fragilityReasons: play.fragilityReasons ?? null,
      mu: play.mu != null ? String(play.mu) : null,
      sigma: play.sigma != null ? String(play.sigma) : null,
      zScore: play.zScore != null ? String(play.zScore) : null,
      hrBuildScore: play.hrBuildScore != null ? String(play.hrBuildScore) : null,
      hrIntensity: play.hrIntensity ?? null,
      signalScore: play.signalScore != null ? String(play.signalScore) : null,
      opportunityScore: play.opportunityScore ?? null,
      liveScore: play.liveScore ?? null,
      eventBoost: play.eventBoost ?? null,
      odds: play.odds != null ? String(play.odds) : null,
      stake: play.stake != null ? String(play.stake) : "1",
      confidenceTier: play.confidenceTier ?? null,
      inning: play.inning ?? null,
      abNumber: play.abNumber ?? null,
      pitchCount: play.pitchCount ?? null,
      contactQualityScore: play.contactQualityScore != null ? String(play.contactQualityScore) : null,
    }).onConflictDoNothing({ target: persistedPlays.duplicateGuard });
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

  async getGradedPlaysForCalibration(opts: { sport?: string; market?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]> {
    const conds = [sql`${persistedPlays.result} IS NOT NULL`];
    if (opts.sport) conds.push(sql`${persistedPlays.sport} = ${opts.sport}`);
    if (opts.market) conds.push(sql`${persistedPlays.market} = ${opts.market}`);
    if (opts.startDate) conds.push(sql`${persistedPlays.gameDate} >= ${opts.startDate}`);
    if (opts.endDate) conds.push(sql`${persistedPlays.gameDate} <= ${opts.endDate}`);
    const rows = await db
      .select()
      .from(persistedPlays)
      .where(and(...conds))
      .orderBy(desc(persistedPlays.timestamp));

    const seen = new Map<string, PersistedPlay>();
    for (const row of rows) {
      const canonKey = `${row.playerId ?? row.playerName}|${row.market}|${row.direction}|${row.gameId}|${row.gameDate}`;
      const existing = seen.get(canonKey);
      if (!existing) {
        seen.set(canonKey, row);
      } else {
        const existingScore = Number(existing.signalScore ?? 0);
        const rowScore = Number(row.signalScore ?? 0);
        if (rowScore > existingScore) {
          seen.set(canonKey, row);
        }
      }
    }
    return Array.from(seen.values());
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

  async getAllSettledPlays(opts?: { sport?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]> {
    const conds = [sql`${persistedPlays.result} IS NOT NULL`];
    if (opts?.sport) conds.push(sql`${persistedPlays.sport} = ${opts.sport}`);
    if (opts?.startDate) conds.push(sql`${persistedPlays.gameDate} >= ${opts.startDate}`);
    if (opts?.endDate) conds.push(sql`${persistedPlays.gameDate} <= ${opts.endDate}`);
    const rows = await db
      .select()
      .from(persistedPlays)
      .where(and(...conds))
      .orderBy(desc(persistedPlays.timestamp));

    const seen = new Map<string, PersistedPlay>();
    for (const row of rows) {
      const canonKey = `${row.playerId ?? row.playerName}|${row.market}|${row.direction}|${row.gameId}|${row.gameDate}`;
      if (!seen.has(canonKey)) {
        seen.set(canonKey, row);
      } else {
        const existing = seen.get(canonKey)!;
        if (Number(row.signalScore ?? 0) > Number(existing.signalScore ?? 0)) {
          seen.set(canonKey, row);
        }
      }
    }
    return Array.from(seen.values());
  }

  async getRecentGradedSignals(limit: number): Promise<PersistedPlay[]> {
    return await db
      .select()
      .from(persistedPlays)
      .where(sql`${persistedPlays.result} IS NOT NULL AND ${persistedPlays.result} != 'pending'`)
      .orderBy(desc(persistedPlays.settledAt))
      .limit(limit);
  }

  async recordSignalInteraction(data: { userId: number; signalId?: string; action: string; sport?: string; market?: string }): Promise<void> {
    await db.insert(signalInteractions).values({
      userId: data.userId,
      signalId: data.signalId ?? null,
      action: data.action,
      sport: data.sport ?? null,
      market: data.market ?? null,
    });
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

    const seen = new Map<string, { id: string; score: number }>();
    const toDelete: string[] = [];

    for (const play of rows) {
      const key = `${play.playerId ?? play.playerName}|${play.market}|${play.direction}|${play.gameId ?? ""}|${play.gameDate}`;

      if (seen.has(key)) {
        const existing = seen.get(key)!;
        const currentScore = Number(play.signalScore ?? play.prob ?? 0);
        if (currentScore > existing.score) {
          toDelete.push(existing.id);
          seen.set(key, { id: play.id, score: currentScore });
        } else {
          toDelete.push(play.id);
        }
      } else {
        seen.set(key, { id: play.id, score: Number(play.signalScore ?? play.prob ?? 0) });
      }
    }

    if (toDelete.length > 0) {
      console.log("[CLEAN] Deleting", toDelete.length, "duplicate plays (canonical key dedup, keeping highest signalScore)");
      await db.delete(persistedPlays).where(inArray(persistedPlays.id, toDelete));
    }

    return { removed: toDelete.length, remaining: rows.length - toDelete.length };
  }

  async hasProcessedStripeEvent(eventId: string): Promise<boolean> {
    const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.id, eventId)).limit(1);
    return rows.length > 0;
  }

  async recordStripeEvent(eventId: string): Promise<void> {
    await db.insert(stripeEvents).values({ id: eventId }).onConflictDoNothing();
  }

  async recordChurn(userId: number, previousTier: string | null): Promise<void> {
    await db.update(users).set({
      churnedAt: new Date(),
      churnedFromTier: previousTier,
    }).where(eq(users.id, userId));
  }

  async insertContactEvent(event: {
    playerId: string;
    playerName: string;
    gameId: string;
    inning?: number | null;
    exitVelocity?: number | null;
    launchAngle?: number | null;
    distance?: number | null;
    batSpeed?: number | null;
    result?: string | null;
    pitchType?: string | null;
    pitchSpeed?: number | null;
    isBarrel?: boolean;
    eventFingerprint: string;
  }): Promise<void> {
    try {
      await db.insert(contactEvents).values({
        playerId: event.playerId,
        playerName: event.playerName,
        gameId: event.gameId,
        inning: event.inning ?? null,
        exitVelocity: event.exitVelocity != null ? String(event.exitVelocity) : null,
        launchAngle: event.launchAngle != null ? String(event.launchAngle) : null,
        distance: event.distance != null ? String(event.distance) : null,
        batSpeed: event.batSpeed != null ? String(event.batSpeed) : null,
        result: event.result ?? null,
        pitchType: event.pitchType ?? null,
        pitchSpeed: event.pitchSpeed != null ? String(event.pitchSpeed) : null,
        isBarrel: event.isBarrel ?? false,
        eventFingerprint: event.eventFingerprint,
      }).onConflictDoNothing({ target: contactEvents.eventFingerprint });
    } catch (err: any) {
      console.warn(`[ContactEvent] insert failed: ${err.message}`);
    }
  }

  async persistGamePlayerStats(stats: Array<{
    gameId: string;
    gamePk?: string | null;
    playerId: string;
    playerName: string;
    teamAbbr?: string | null;
    teamSide?: string | null;
    battingOrderSlot?: number | null;
    ab?: number;
    h?: number;
    tb?: number;
    r?: number;
    rbi?: number;
    bb?: number;
    k?: number;
    sb?: number;
    abResults?: string | null;
    gameDate?: string | null;
  }>): Promise<void> {
    if (stats.length === 0) return;
    try {
      for (const s of stats) {
        await db.insert(gamePlayerStats).values({
          gameId: s.gameId,
          gamePk: s.gamePk ?? null,
          playerId: s.playerId,
          playerName: s.playerName,
          teamAbbr: s.teamAbbr ?? null,
          teamSide: s.teamSide ?? null,
          battingOrderSlot: s.battingOrderSlot ?? null,
          ab: s.ab ?? 0,
          h: s.h ?? 0,
          tb: s.tb ?? 0,
          r: s.r ?? 0,
          rbi: s.rbi ?? 0,
          bb: s.bb ?? 0,
          k: s.k ?? 0,
          sb: s.sb ?? 0,
          abResults: s.abResults ?? null,
          gameDate: s.gameDate ?? null,
        }).onConflictDoNothing();
      }
      console.log(`[GamePlayerStats] Persisted ${stats.length} player stats for game ${stats[0]?.gameId}`);
    } catch (err: any) {
      console.warn(`[GamePlayerStats] persist failed: ${err.message}`);
    }
  }

  async getGamePlayerStats(gameId: string): Promise<Array<{
    playerId: string;
    playerName: string;
    teamAbbr: string | null;
    teamSide: string | null;
    battingOrderSlot: number | null;
    ab: number | null;
    h: number | null;
    tb: number | null;
    r: number | null;
    rbi: number | null;
    bb: number | null;
    k: number | null;
    sb: number | null;
    abResults: string | null;
    gameDate: string | null;
  }>> {
    const rows = await db.select().from(gamePlayerStats).where(eq(gamePlayerStats.gameId, gameId));
    return rows;
  }

  async getPlayerHistory(playerId: string, limit = 10): Promise<Array<{
    gameId: string;
    playerName: string;
    teamAbbr: string | null;
    ab: number | null;
    h: number | null;
    tb: number | null;
    k: number | null;
    abResults: string | null;
    gameDate: string | null;
  }>> {
    const rows = await db.select().from(gamePlayerStats)
      .where(eq(gamePlayerStats.playerId, playerId))
      .orderBy(desc(gamePlayerStats.createdAt))
      .limit(limit);
    return rows;
  }

  async insertAlert(alert: {
    playerId: string;
    playerName: string;
    teamAbbr?: string | null;
    gameId: string;
    alertType: string;
    triggerReason?: string | null;
    hrBuildScore?: number | null;
    hrIntensity?: string | null;
    inning?: number | null;
    factors?: string | null;
  }): Promise<void> {
    try {
      await db.insert(persistedAlerts).values({
        playerId: alert.playerId,
        playerName: alert.playerName,
        teamAbbr: alert.teamAbbr ?? null,
        gameId: alert.gameId,
        alertType: alert.alertType,
        triggerReason: alert.triggerReason ?? null,
        hrBuildScore: alert.hrBuildScore != null ? String(alert.hrBuildScore) : null,
        hrIntensity: alert.hrIntensity ?? null,
        inning: alert.inning ?? null,
        factors: alert.factors ?? null,
      });
      console.log(`[HR_ALERT] Persisted alert: ${alert.playerName} (${alert.alertType}) score=${alert.hrBuildScore} game=${alert.gameId}`);
    } catch (err: any) {
      console.warn(`[HR_ALERT] Failed to persist alert: ${err.message}`);
    }
  }

  async getRecentAlerts(minutesBack = 30): Promise<Array<{
    id: number;
    playerId: string;
    playerName: string;
    teamAbbr: string | null;
    gameId: string;
    alertType: string;
    triggerReason: string | null;
    hrBuildScore: string | null;
    hrIntensity: string | null;
    inning: number | null;
    factors: string | null;
    outcome: string | null;
    createdAt: Date | null;
  }>> {
    const cutoff = new Date(Date.now() - minutesBack * 60 * 1000);
    const rows = await db.select().from(persistedAlerts)
      .where(gte(persistedAlerts.createdAt, cutoff))
      .orderBy(desc(persistedAlerts.createdAt))
      .limit(50);
    return rows;
  }

  async gradeAlertsForPlayer(playerId: string, gameId: string, outcome: string): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const result = await db.update(persistedAlerts)
        .set({ outcome, resolvedAt: new Date() })
        .where(
          and(
            eq(persistedAlerts.playerId, playerId),
            eq(persistedAlerts.gameId, gameId),
            isNull(persistedAlerts.outcome),
            gte(persistedAlerts.createdAt, cutoff),
          )
        );
      const count = (result as any).rowCount ?? 0;
      if (count > 0) {
        console.log(`[HR_ALERT_GRADE] Graded ${count} alert(s) for player=${playerId} game=${gameId} outcome=${outcome}`);
      }
      return count;
    } catch (err: any) {
      console.warn(`[HR_ALERT_GRADE] Failed: ${err.message}`);
      return 0;
    }
  }

  async resolveAlertAsHit(playerId: string, gameId: string, hitInningNum: number, hitHalfVal: string, hitPaNum: number, hrEndTimeMs?: number | null): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
      // Razor-sharp grading: an alert is only credited if it was created BEFORE
      // the HR play actually completed. Alerts created after the HR's endTime
      // were responding to box-score lag — not predicting — so they should not
      // be marked as HIT (they will reconcile as NO_HR at game end).
      const conditions = [
        eq(persistedAlerts.playerId, playerId),
        eq(persistedAlerts.gameId, gameId),
        isNull(persistedAlerts.outcome),
        gte(persistedAlerts.createdAt, cutoff),
      ];
      if (hrEndTimeMs && Number.isFinite(hrEndTimeMs)) {
        conditions.push(lt(persistedAlerts.createdAt, new Date(hrEndTimeMs)));
      }
      const result = await db.update(persistedAlerts)
        .set({
          outcome: "HR",
          resolvedAt: new Date(),
          hitInning: hitInningNum,
          hitHalf: hitHalfVal,
          hitPaNumber: hitPaNum,
        })
        .where(and(...conditions));
      const count = (result as any).rowCount ?? 0;
      if (count > 0) {
        console.log(`[HR_RADAR_ALERT_HIT] Resolved ${count} alert(s) as HIT for player=${playerId} game=${gameId} inning=${hitInningNum} half=${hitHalfVal}${hrEndTimeMs ? ` cutoffEndTime=${new Date(hrEndTimeMs).toISOString()}` : ""}`);
      } else if (hrEndTimeMs) {
        console.log(`[HR_RADAR_ALERT_LATE] No pre-HR alert to credit for player=${playerId} game=${gameId} hitLabel=${hitHalfVal}${hitInningNum} (any open alerts were created after HR endTime ${new Date(hrEndTimeMs).toISOString()})`);
      }
      return count;
    } catch (err: any) {
      console.warn(`[HR_RADAR_ALERT_HIT] Failed: ${err.message}`);
      return 0;
    }
  }

  async resolveAlertAsMiss(playerId: string, gameId: string): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const result = await db.update(persistedAlerts)
        .set({ outcome: "NO_HR", resolvedAt: new Date() })
        .where(
          and(
            eq(persistedAlerts.playerId, playerId),
            eq(persistedAlerts.gameId, gameId),
            isNull(persistedAlerts.outcome),
            gte(persistedAlerts.createdAt, cutoff),
          )
        );
      const count = (result as any).rowCount ?? 0;
      return count;
    } catch (err: any) {
      console.warn(`[HR_RADAR_ALERT_MISS] Failed: ${err.message}`);
      return 0;
    }
  }

  async reconcileAlertsForGame(gameId: string): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const result = await db.update(persistedAlerts)
        .set({ outcome: "NO_HR", resolvedAt: new Date() })
        .where(
          and(
            eq(persistedAlerts.gameId, gameId),
            isNull(persistedAlerts.outcome),
            gte(persistedAlerts.createdAt, cutoff),
          )
        );
      const count = (result as any).rowCount ?? 0;
      if (count > 0) {
        console.log(`[HR_RADAR_RECONCILE] Bulk-resolved ${count} remaining alert(s) as MISS for game=${gameId}`);
      }
      return count;
    } catch (err: any) {
      console.warn(`[HR_RADAR_RECONCILE] Failed: ${err.message}`);
      return 0;
    }
  }

  async getGradedAlerts(hoursBack = 12): Promise<Array<{
    id: number;
    playerId: string;
    playerName: string;
    teamAbbr: string | null;
    gameId: string;
    alertType: string;
    triggerReason: string | null;
    hrBuildScore: string | null;
    hrIntensity: string | null;
    inning: number | null;
    factors: string | null;
    outcome: string | null;
    resolvedAt: Date | null;
    hitInning: number | null;
    hitHalf: string | null;
    hitPaNumber: number | null;
    createdAt: Date | null;
  }>> {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const rows = await db.select().from(persistedAlerts)
      .where(
        and(
          isNotNull(persistedAlerts.outcome),
          gte(persistedAlerts.createdAt, cutoff),
        )
      )
      .orderBy(desc(persistedAlerts.resolvedAt))
      .limit(100);
    return rows;
  }

  async getAlertConversionStats(): Promise<{
    totalAlerts: number;
    totalHR: number;
    totalNoHR: number;
    totalPending: number;
    conversionRate: number;
    alertTypeBreakdown: Record<string, { total: number; hr: number; rate: number }>;
  }> {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await db.select().from(persistedAlerts)
        .where(gte(persistedAlerts.createdAt, cutoff));

      const totalAlerts = rows.length;
      const totalHR = rows.filter(r => r.outcome === "HR").length;
      const totalNoHR = rows.filter(r => r.outcome === "NO_HR").length;
      const totalPending = rows.filter(r => r.outcome === null).length;
      const conversionRate = totalHR + totalNoHR > 0 ? (totalHR / (totalHR + totalNoHR)) * 100 : 0;

      const alertTypeBreakdown: Record<string, { total: number; hr: number; rate: number }> = {};
      for (const row of rows) {
        const type = row.alertType;
        if (!alertTypeBreakdown[type]) alertTypeBreakdown[type] = { total: 0, hr: 0, rate: 0 };
        alertTypeBreakdown[type].total++;
        if (row.outcome === "HR") alertTypeBreakdown[type].hr++;
      }
      for (const key of Object.keys(alertTypeBreakdown)) {
        const b = alertTypeBreakdown[key];
        const graded = rows.filter(r => r.alertType === key && r.outcome !== null).length;
        b.rate = graded > 0 ? (b.hr / graded) * 100 : 0;
      }

      return { totalAlerts, totalHR, totalNoHR, totalPending, conversionRate, alertTypeBreakdown };
    } catch (err: any) {
      console.warn(`[HR_ALERT_STATS] Failed: ${err.message}`);
      return { totalAlerts: 0, totalHR: 0, totalNoHR: 0, totalPending: 0, conversionRate: 0, alertTypeBreakdown: {} };
    }
  }

  async getChurnedUsers(): Promise<Array<{ id: number; email: string; churnedAt: Date; churnedFromTier: string | null; createdAt: Date | null }>> {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        churnedAt: users.churnedAt,
        churnedFromTier: users.churnedFromTier,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(isNotNull(users.churnedAt))
      .orderBy(desc(users.churnedAt));
    return rows as Array<{ id: number; email: string; churnedAt: Date; churnedFromTier: string | null; createdAt: Date | null }>;
  }

  async appendHrRadarSignalEvent(event: InsertHrRadarSignalEvent): Promise<HrRadarSignalEvent | null> {
    try {
      const inserted = await db.insert(hrRadarSignalEvents).values(event).returning();
      const row = inserted[0] ?? null;
      if (row) {
        console.log(`[HR_RADAR_SIGNAL_EVENT] type=${row.eventType} game=${row.gameId} player=${row.playerId} inning=${row.inning ?? "n/a"}${row.half ?? ""} score=${row.score ?? "n/a"} alertId=${row.alertId ?? "n/a"}`);
        console.log(`[HR_LEDGER_WRITE] sessionDate=${row.sessionDate} gameId=${row.gameId} playerId=${row.playerId} eventType=${row.eventType} score=${row.score ?? "n/a"} tier=${row.confidenceTier ?? "n/a"} inning=${row.inning ?? "n/a"}${row.half ?? ""} source=${row.source ?? "n/a"} alertId=${row.alertId ?? "n/a"}`);
      }
      return row;
    } catch (err: any) {
      console.warn(`[HR_RADAR_SIGNAL_EVENT] Failed: ${err.message}`);
      console.warn(`[HR_LEDGER_WRITE] FAILED gameId=${(event as any)?.gameId ?? "n/a"} playerId=${(event as any)?.playerId ?? "n/a"} eventType=${(event as any)?.eventType ?? "n/a"} err=${err.message}`);
      return null;
    }
  }

  /**
   * Strict matcher: returns whether a qualifying HR radar signal event exists for
   * this player/game BEFORE the HR completed. Used by the orchestrator to decide
   * called_hit vs uncalled_hr vs late_signal.
   */
  async matchHrRadarAlertToHrEvent(params: {
    playerId: string;
    gameId: string;
    hrEndTimeMs: number | null;
    hrInning: number;
    hrHalf: string;
  }): Promise<{
    matched: boolean;
    matchedBeforeHr: boolean;
    isLateSignal: boolean;
    alertId: string | null;
    signalEventId: number | null;
    signalDetectedAt: Date | null;
    signalInning: number | null;
    signalHalf: string | null;
    gradingStatus: "called_hit" | "uncalled_hr" | "late_signal";
    gradingReason: string;
    matchMethod: "direct_pre_hr_signal" | "post_hr_fallback" | "player_game_only" | "none";
  }> {
    const today = resolveMlbGameSessionDate(params.gameId);
    console.log(`[HR_LEDGER_MATCH] gameId=${params.gameId} playerId=${params.playerId} sessionDate=${today} hrInning=${params.hrInning}${params.hrHalf} hrEndTimeMs=${params.hrEndTimeMs ?? "n/a"}`);
    const hrEnd = (params.hrEndTimeMs && Number.isFinite(params.hrEndTimeMs)) ? params.hrEndTimeMs : null;
    try {
      const alertRows = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.sessionDate, today),
          eq(hrRadarAlerts.gameId, params.gameId),
          eq(hrRadarAlerts.playerId, params.playerId),
        ))
        .limit(1);
      const alert = alertRows[0] ?? null;

      if (!alert) {
        return {
          matched: false, matchedBeforeHr: false, isLateSignal: false,
          alertId: null, signalEventId: null,
          signalDetectedAt: null, signalInning: null, signalHalf: null,
          gradingStatus: "uncalled_hr",
          gradingReason: "no canonical hr_radar_alert row exists for player/game",
          matchMethod: "none",
        };
      }

      const signalDetectedMs = alert.signalDetectedAt?.getTime() ?? alert.detectedAt.getTime();
      const eventConditions = [
        eq(hrRadarSignalEvents.gameId, params.gameId),
        eq(hrRadarSignalEvents.playerId, params.playerId),
      ];
      // STRICT pre-HR: signal must occur strictly BEFORE the HR endTime. No grace window.
      if (hrEnd) eventConditions.push(lt(hrRadarSignalEvents.detectedAt, new Date(hrEnd)));
      const qualifyingEvents = await db.select().from(hrRadarSignalEvents)
        .where(and(...eventConditions))
        .orderBy(desc(hrRadarSignalEvents.detectedAt))
        .limit(1);
      const lastQualifyingEvent = qualifyingEvents[0] ?? null;

      const alertBeforeHr = hrEnd ? signalDetectedMs < hrEnd : true;

      if (lastQualifyingEvent || alertBeforeHr) {
        console.log(`[HR_RADAR_MATCH_RESULT] called_hit player=${params.playerId} game=${params.gameId} alertId=${alert.id} signalAt=${new Date(lastQualifyingEvent?.detectedAt ?? signalDetectedMs).toISOString()} hrEndAt=${hrEnd ? new Date(hrEnd).toISOString() : "n/a"}`);
        return {
          matched: true, matchedBeforeHr: true, isLateSignal: false,
          alertId: alert.id,
          signalEventId: lastQualifyingEvent?.id ?? null,
          signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt ?? lastQualifyingEvent?.detectedAt,
          // Preserve the ORIGINAL inning the alert was first called in. The
          // alert may have escalated through several innings before the HR
          // landed; users should see when we first called it, not the most
          // recent escalation event.
          signalInning: alert.signalInning ?? alert.detectedInning ?? lastQualifyingEvent?.inning,
          signalHalf: alert.signalHalf ?? alert.detectedHalf ?? lastQualifyingEvent?.half,
          gradingStatus: "called_hit",
          gradingReason: lastQualifyingEvent
            ? `qualifying signal event ${lastQualifyingEvent.eventType} at ${new Date(lastQualifyingEvent.detectedAt).toISOString()} strictly preceded HR endTime`
            : `canonical alert detectedAt ${new Date(signalDetectedMs).toISOString()} strictly preceded HR endTime`,
          matchMethod: "direct_pre_hr_signal",
        };
      }
      console.log(`[HR_RADAR_MATCH_RESULT] late_signal player=${params.playerId} game=${params.gameId} alertId=${alert.id} signalAt=${new Date(signalDetectedMs).toISOString()} hrEndAt=${hrEnd ? new Date(hrEnd).toISOString() : "n/a"}`);

      // Alert exists but its signalDetectedAt is at or after HR end → late signal
      return {
        matched: true, matchedBeforeHr: false, isLateSignal: true,
        alertId: alert.id,
        signalEventId: null,
        signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt,
        signalInning: alert.signalInning ?? alert.detectedInning,
        signalHalf: alert.signalHalf ?? alert.detectedHalf,
        gradingStatus: "late_signal",
        gradingReason: `signal detectedAt ${new Date(signalDetectedMs).toISOString()} occurred at or after HR endTime ${hrEnd ? new Date(hrEnd).toISOString() : "(unknown)"}`,
        matchMethod: "post_hr_fallback",
      };
    } catch (err: any) {
      console.warn(`[HR_RADAR_MATCH_RESULT] Failed: ${err.message}`);
      return {
        matched: false, matchedBeforeHr: false, isLateSignal: false,
        alertId: null, signalEventId: null,
        signalDetectedAt: null, signalInning: null, signalHalf: null,
        gradingStatus: "uncalled_hr",
        gradingReason: `matcher error: ${err.message}`,
        matchMethod: "none",
      };
    }
  }

  async createOrUpdateHrRadarAlert(data: {
    gameId: string;
    playerId: string;
    playerName: string;
    team: string;
    opponent?: string | null;
    inning: number;
    half: "top" | "bottom";
    readinessScore: number;
    confidenceTier: "monitor" | "building" | "strong";
    signalState: "live" | "watching" | "actionable";
    triggerTags: string[];
    summaryText?: string | null;
    contactSnapshot?: { ev: number | null; la: number | null; distance: number | null; hardHit: boolean; barrel: boolean } | null;
    alertPath?: string | null;
    alertTier?: string | null;
    diagnosticsSnapshot?: Record<string, unknown> | null;
  }): Promise<HrRadarAlert | null> {
    try {
      const today = resolveMlbGameSessionDate(data.gameId);
      const halfLabel = data.half === "top" ? "T" : "B";
      const detectedLabel = `${halfLabel}${data.inning}`;
      const existing = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.sessionDate, today),
          eq(hrRadarAlerts.gameId, data.gameId),
          eq(hrRadarAlerts.playerId, data.playerId),
        ))
        .limit(1);

      if (existing.length > 0) {
        const alert = existing[0];
        if (alert.status !== "live") return alert;

        const prevScore = parseFloat(alert.currentReadinessScore ?? "0");
        const newScore = data.readinessScore;
        const prevPeak = parseFloat(alert.peakReadinessScore ?? "0");
        const peak = Math.max(prevPeak, newScore);
        const increased = newScore > prevScore;
        const increaseAmt = increased ? Math.round((newScore - prevScore) * 10) / 10 : null;
        const increaseLabel = increased ? `+${increaseAmt} in ${detectedLabel}` : alert.scoreIncreaseLabel;

        const tierOrder: Record<string, number> = { monitor: 0, building: 1, strong: 2 };
        const bestTier = tierOrder[data.confidenceTier] > tierOrder[alert.confidenceTier] ? data.confidenceTier : alert.confidenceTier;

        await db.update(hrRadarAlerts)
          .set({
            currentReadinessScore: String(newScore),
            peakReadinessScore: String(peak),
            scoreIncreased: increased || alert.scoreIncreased,
            scoreIncreaseAmount: increaseAmt != null ? String(increaseAmt) : alert.scoreIncreaseAmount,
            scoreIncreaseInning: increased ? data.inning : alert.scoreIncreaseInning,
            scoreIncreaseHalf: increased ? data.half : alert.scoreIncreaseHalf,
            scoreIncreaseLabel: increaseLabel,
            confidenceTier: bestTier,
            signalState: data.signalState,
            triggerTags: data.triggerTags,
            summaryText: data.summaryText ?? alert.summaryText,
            contactSnapshot: data.contactSnapshot ?? alert.contactSnapshot,
            alertPath: data.alertPath ?? alert.alertPath,
            alertTier: data.alertTier ?? alert.alertTier,
            diagnosticsSnapshot: data.diagnosticsSnapshot ?? alert.diagnosticsSnapshot,
          })
          .where(eq(hrRadarAlerts.id, alert.id));

        if (increased) {
          console.log(`[HR_RADAR_SCORE_INCREASE] playerId=${data.playerId} previousScore=${prevScore} newScore=${newScore} increaseAmount=${increaseAmt} increaseLabel=${increaseLabel}`);
          // Append escalation event so the strict matcher has chronological proof of pre-HR signal evolution
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
            alertId: alert.id,
            eventType: bestTier !== alert.confidenceTier ? "escalated" : "escalated",
            signalState: data.signalState,
            score: String(newScore),
            confidenceTier: bestTier,
            triggerTags: data.triggerTags as any,
            drivers: data.diagnosticsSnapshot as any,
            detectedAt: new Date(),
            inning: data.inning,
            half: data.half,
            source: "engine",
          } as InsertHrRadarSignalEvent);
        } else {
          // Downgrade tracking: append a chronological 'downgraded' event when the
          // current evaluation drops the score by ≥5 vs prior tick (sticky stored
          // tier means we don't visibly downgrade, but the ledger still records
          // the dip for decision-ladder ranking + audit trail).
          const decreased = prevScore - newScore >= 5;
          if (decreased) {
            console.log(`[HR_RADAR_SCORE_DOWNGRADE] playerId=${data.playerId} previousScore=${prevScore} newScore=${newScore} drop=${(prevScore - newScore).toFixed(1)} inning=${data.inning}${halfLabel}`);
            await this.appendHrRadarSignalEvent({
              sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
              alertId: alert.id,
              eventType: "downgraded",
              signalState: data.signalState,
              score: String(newScore),
              confidenceTier: data.confidenceTier,
              triggerTags: data.triggerTags as any,
              drivers: data.diagnosticsSnapshot as any,
              detectedAt: new Date(),
              inning: data.inning,
              half: data.half,
              source: "engine",
            } as InsertHrRadarSignalEvent);
          }
        }
        console.log(`[HR_RADAR_ALERT_UPSERT] UPDATE sessionDate=${today} gameId=${data.gameId} playerId=${data.playerId} detectedLabel=${alert.detectedLabel} currentReadinessScore=${newScore}`);

        const updated = await db.select().from(hrRadarAlerts)
          .where(eq(hrRadarAlerts.id, alert.id)).limit(1);
        return updated[0] ?? null;
      }

      const alertId = `${today}_${data.gameId}_${data.playerId}`;
      const nowDate = new Date();
      const insertResult = await db.insert(hrRadarAlerts).values({
        id: alertId,
        sessionDate: today,
        gameId: data.gameId,
        playerId: data.playerId,
        playerName: data.playerName,
        team: data.team,
        opponent: data.opponent ?? null,
        detectedAt: nowDate,
        detectedInning: data.inning,
        detectedHalf: data.half,
        detectedLabel,
        initialReadinessScore: String(data.readinessScore),
        currentReadinessScore: String(data.readinessScore),
        peakReadinessScore: String(data.readinessScore),
        scoreIncreased: false,
        confidenceTier: data.confidenceTier,
        signalState: data.signalState,
        triggerTags: data.triggerTags,
        summaryText: data.summaryText ?? null,
        contactSnapshot: data.contactSnapshot ?? null,
        alertPath: data.alertPath ?? null,
        alertTier: data.alertTier ?? null,
        diagnosticsSnapshot: data.diagnosticsSnapshot ?? null,
        status: "live",
        gradingStatus: "active",
        userVisible: true,
        matchedBeforeHr: false,
        fallbackCreated: false,
        signalDetectedAt: nowDate,
        signalInning: data.inning,
        signalHalf: data.half,
        analyticsPersisted: false,
      }).onConflictDoNothing();
      if ((insertResult as any).rowCount === 0) {
        console.log(`[HR_RADAR_ALERT_UPSERT] RACE_DEDUP — alert already exists for sessionDate=${today} gameId=${data.gameId} playerId=${data.playerId}`);
        const raceExisting = await db.select().from(hrRadarAlerts)
          .where(eq(hrRadarAlerts.id, alertId)).limit(1);
        return raceExisting[0] ?? null;
      }

      console.log(`[HR_RADAR_ALERT_UPSERT] CREATE sessionDate=${today} gameId=${data.gameId} playerId=${data.playerId} detectedLabel=${detectedLabel} initialReadinessScore=${data.readinessScore}`);
      // Append creation event to chronological history so strict matcher has proof
      await this.appendHrRadarSignalEvent({
        sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
        alertId,
        eventType: "created",
        signalState: data.signalState,
        score: String(data.readinessScore),
        confidenceTier: data.confidenceTier,
        triggerTags: data.triggerTags as any,
        drivers: data.diagnosticsSnapshot as any,
        detectedAt: nowDate,
        inning: data.inning,
        half: data.half,
        source: "engine",
      } as InsertHrRadarSignalEvent);
      const inserted = await db.select().from(hrRadarAlerts)
        .where(eq(hrRadarAlerts.id, alertId)).limit(1);
      return inserted[0] ?? null;
    } catch (err: any) {
      console.warn(`[HR_RADAR_ALERT_UPSERT] Failed: ${err.message}`);
      return null;
    }
  }

  async resolveHrRadarAlertAsHit(playerId: string, gameId: string, hitInningNum: number, hitHalfVal: string, hitLabelVal: string, hrEndTimeMs?: number | null): Promise<number> {
    try {
      const today = resolveMlbGameSessionDate(gameId);
      const matchResult = await this.matchHrRadarAlertToHrEvent({
        playerId, gameId,
        hrEndTimeMs: hrEndTimeMs ?? null,
        hrInning: hitInningNum,
        hrHalf: hitHalfVal,
      });
      const nowDate = new Date();

      if (matchResult.matched && matchResult.matchedBeforeHr) {
        const result = await db.update(hrRadarAlerts)
          .set({
            status: "hit",
            hitInning: hitInningNum,
            hitHalf: hitHalfVal,
            hitLabel: hitLabelVal,
            hitDetectedAt: hrEndTimeMs ? new Date(hrEndTimeMs) : nowDate,
            resolvedAt: nowDate,
            gradingStatus: "called_hit",
            gradingReason: matchResult.gradingReason,
            matchedBeforeHr: true,
            fallbackCreated: false,
            userVisible: true,
            matchMethod: matchResult.matchMethod,
            signalDetectedAt: matchResult.signalDetectedAt ?? nowDate,
            signalInning: matchResult.signalInning,
            signalHalf: matchResult.signalHalf,
          })
          .where(and(
            eq(hrRadarAlerts.sessionDate, today),
            eq(hrRadarAlerts.gameId, gameId),
            eq(hrRadarAlerts.playerId, playerId),
            eq(hrRadarAlerts.status, "live"),
          ));
        const count = (result as any).rowCount ?? 0;
        if (count > 0) {
          console.log(`[HR_RADAR_CALLED_HIT] playerId=${playerId} gameId=${gameId} signalLabel=${matchResult.signalHalf}${matchResult.signalInning ?? ""} hitLabel=${hitLabelVal} reason="${matchResult.gradingReason}"`);
          console.log(`[HR_LEDGER_GRADE] outcome=called_hit sessionDate=${today} gameId=${gameId} playerId=${playerId} signalInning=${matchResult.signalInning ?? "n/a"}${matchResult.signalHalf ?? ""} hitInning=${hitInningNum}${hitHalfVal} alertId=${matchResult.alertId} matchMethod=${matchResult.matchMethod}`);
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId, playerId,
            team: "",
            alertId: matchResult.alertId,
            eventType: "resolved_hit",
            detectedAt: nowDate,
            inning: hitInningNum,
            half: hitHalfVal,
            source: "grader",
          } as InsertHrRadarSignalEvent);
        }
        return count;
      }

      // Late signal: alert exists but signal arrived at/after HR completed
      if (matchResult.matched && matchResult.isLateSignal) {
        const result = await db.update(hrRadarAlerts)
          .set({
            status: "hit",
            hitInning: hitInningNum,
            hitHalf: hitHalfVal,
            hitLabel: hitLabelVal,
            hitDetectedAt: hrEndTimeMs ? new Date(hrEndTimeMs) : nowDate,
            resolvedAt: nowDate,
            gradingStatus: "late_signal",
            gradingReason: matchResult.gradingReason,
            matchedBeforeHr: false,
            fallbackCreated: false,
            userVisible: false,
            matchMethod: matchResult.matchMethod,
          })
          .where(and(
            eq(hrRadarAlerts.sessionDate, today),
            eq(hrRadarAlerts.gameId, gameId),
            eq(hrRadarAlerts.playerId, playerId),
            eq(hrRadarAlerts.status, "live"),
          ));
        const count = (result as any).rowCount ?? 0;
        if (count > 0) {
          console.log(`[HR_RADAR_LATE_SIGNAL] playerId=${playerId} gameId=${gameId} hitLabel=${hitLabelVal} reason="${matchResult.gradingReason}"`);
          console.log(`[HR_LEDGER_LATE] sessionDate=${today} gameId=${gameId} playerId=${playerId} signalInning=${matchResult.signalInning ?? "n/a"}${matchResult.signalHalf ?? ""} hitInning=${hitInningNum}${hitHalfVal} alertId=${matchResult.alertId}`);
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId, playerId, team: "",
            alertId: matchResult.alertId,
            eventType: "late_signal",
            detectedAt: nowDate,
            inning: hitInningNum, half: hitHalfVal,
            source: "grader",
          } as InsertHrRadarSignalEvent);
        }
        return count;
      }

      // No qualifying alert at all
      console.log(`[HR_RADAR_UNCALLED] playerId=${playerId} gameId=${gameId} hitLabel=${hitLabelVal} hrEndTimeMs=${hrEndTimeMs ?? "n/a"} reason="${matchResult.gradingReason}" — no called signal, will write admin-only uncalled_hr row`);
      console.log(`[HR_LEDGER_UNCALLED] sessionDate=${today} gameId=${gameId} playerId=${playerId} hitInning=${hitInningNum}${hitHalfVal} reason="${matchResult.gradingReason}"`);
      return 0;
    } catch (err: any) {
      console.warn(`[HR_RADAR_ALERT_HIT] Failed: ${err.message}`);
      return 0;
    }
  }

  async ensureHrRadarAlertHit(data: {
    gameId: string;
    playerId: string;
    playerName: string;
    team: string;
    inning: number;
    half: "top" | "bottom";
    hitLabel: string;
  }): Promise<void> {
    try {
      const today = resolveMlbGameSessionDate(data.gameId);
      const existing = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.sessionDate, today),
          eq(hrRadarAlerts.gameId, data.gameId),
          eq(hrRadarAlerts.playerId, data.playerId),
        ))
        .limit(1);

      const nowDate = new Date();
      const halfLabel = data.half === "top" ? "T" : "B";

      if (existing.length > 0) {
        if (existing[0].status === "live") {
          // Race: a live alert exists but resolveHrRadarAlertAsHit didn't match before HR endTime.
          // Treat as late_signal (admin-only, never user-visible Cashed).
          await db.update(hrRadarAlerts)
            .set({
              status: "hit",
              hitInning: data.inning,
              hitHalf: halfLabel,
              hitLabel: data.hitLabel,
              hitDetectedAt: nowDate,
              resolvedAt: nowDate,
              gradingStatus: "late_signal",
              gradingReason: "ensureHrRadarAlertHit fallback fired with live alert still present — race or post-HR signal",
              matchedBeforeHr: false,
              fallbackCreated: false,
              userVisible: false,
              matchMethod: "post_hr_fallback",
            })
            .where(eq(hrRadarAlerts.id, existing[0].id));
          console.log(`[HR_RADAR_LATE_SIGNAL] (ensure-fallback) playerId=${data.playerId} gameId=${data.gameId}`);
        }
        return;
      }

      const alertId = `${today}_${data.gameId}_${data.playerId}`;
      await db.insert(hrRadarAlerts).values({
        id: alertId,
        sessionDate: today,
        gameId: data.gameId,
        playerId: data.playerId,
        playerName: data.playerName,
        team: data.team,
        opponent: null,
        detectedAt: nowDate,
        detectedInning: null,
        detectedHalf: null,
        detectedLabel: null,
        initialReadinessScore: "0",
        currentReadinessScore: "0",
        peakReadinessScore: "0",
        scoreIncreased: false,
        confidenceTier: "monitor",
        signalState: "live",
        triggerTags: ["auto_graded"],
        summaryText: `HR confirmed ${data.hitLabel} (uncalled — no pre-HR engine signal)`,
        status: "hit",
        hitInning: data.inning,
        hitHalf: halfLabel,
        hitLabel: data.hitLabel,
        hitDetectedAt: nowDate,
        resolvedAt: nowDate,
        gradingStatus: "uncalled_hr",
        gradingReason: "no canonical hr_radar_alert existed at time of HR resolution — admin-only analytics row",
        matchedBeforeHr: false,
        fallbackCreated: true,
        userVisible: false,
        matchMethod: "post_hr_fallback",
        analyticsPersisted: false,
      });
      console.log(`[HR_RADAR_UNCALLED] (admin-only row created) playerId=${data.playerId} player=${data.playerName} gameId=${data.gameId} hitLabel=${data.hitLabel}`);
    } catch (err: any) {
      if (err.message?.includes("duplicate key")) return;
      console.warn(`[HR_RADAR_ENSURE_HIT] Failed: ${err.message}`);
    }
  }

  async resolveHrRadarAlertAsMiss(playerId: string, gameId: string): Promise<number> {
    try {
      const today = resolveMlbGameSessionDate(gameId);
      const result = await db.update(hrRadarAlerts)
        .set({
          status: "miss",
          resolvedAt: new Date(),
          gradingStatus: "called_miss",
          gradingReason: "game ended without HR for this called signal",
          userVisible: true,
          matchedBeforeHr: false,
          matchMethod: "direct_pre_hr_signal",
        })
        .where(and(
          eq(hrRadarAlerts.sessionDate, today),
          eq(hrRadarAlerts.gameId, gameId),
          eq(hrRadarAlerts.playerId, playerId),
          eq(hrRadarAlerts.status, "live"),
        ));
      const count = (result as any).rowCount ?? 0;
      if (count > 0) {
        console.log(`[HR_RADAR_ALERT_MISS] playerId=${playerId} gameId=${gameId}`);
      }
      return count;
    } catch (err: any) {
      console.warn(`[HR_RADAR_ALERT_MISS] Failed: ${err.message}`);
      return 0;
    }
  }

  async reconcileHrRadarAlertsForGame(gameId: string, playerHrMap: Map<string, { inning: number; half: string }>): Promise<void> {
    try {
      const today = resolveMlbGameSessionDate(gameId);
      const liveAlerts = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.sessionDate, today),
          eq(hrRadarAlerts.gameId, gameId),
          eq(hrRadarAlerts.status, "live"),
        ));

      // Strict pre-HR test using inning/half ordering when reconcile has no precise hrEndTimeMs.
      // Half order within an inning: top (0) < bottom (1). "F"/unknown treated as last.
      const halfOrd = (h: string | null | undefined): number => {
        if (h === "top" || h === "T") return 0;
        if (h === "bottom" || h === "B") return 1;
        return 2;
      };
      const signalIsStrictlyBeforeHr = (sigInning: number | null | undefined, sigHalf: string | null | undefined, hrInn: number, hrHalf: string): boolean => {
        if (sigInning == null) return false;
        if (sigInning < hrInn) return true;
        if (sigInning > hrInn) return false;
        return halfOrd(sigHalf) < halfOrd(hrHalf);
      };

      for (const alert of liveAlerts) {
        const hrData = playerHrMap.get(alert.playerId);
        const nowDate = new Date();
        if (hrData) {
          const hitHalf = hrData.half === "top" ? "T" : hrData.half === "bottom" ? "B" : "F";
          const hitLabel = hitHalf === "F" ? "Final" : `${hitHalf}${hrData.inning}`;
          const sigInn = alert.signalInning ?? alert.detectedInning;
          const sigHalf = alert.signalHalf ?? alert.detectedHalf;
          const isPreHr = signalIsStrictlyBeforeHr(sigInn, sigHalf, hrData.inning, hrData.half);
          if (isPreHr) {
            await db.update(hrRadarAlerts)
              .set({
                status: "hit",
                hitInning: hrData.inning,
                hitHalf: hrData.half,
                hitLabel,
                hitDetectedAt: nowDate,
                resolvedAt: nowDate,
                gradingStatus: "called_hit",
                gradingReason: `reconcile: signal ${sigInn}/${sigHalf} strictly precedes HR ${hrData.inning}/${hrData.half}`,
                matchedBeforeHr: true,
                userVisible: true,
                matchMethod: "direct_pre_hr_signal",
                signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt,
                signalInning: sigInn,
                signalHalf: sigHalf,
              })
              .where(eq(hrRadarAlerts.id, alert.id));
            console.log(`[HR_RADAR_CALLED_HIT] (reconcile) playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel} hitLabel=${hitLabel}`);
            console.log(`[HR_LEDGER_GRADE] outcome=called_hit (reconcile) sessionDate=${today} gameId=${gameId} playerId=${alert.playerId} signalInning=${sigInn ?? "n/a"}${sigHalf ?? ""} hitInning=${hrData.inning}${hrData.half} alertId=${alert.id}`);
          } else {
            // Signal occurred at or after HR — late_signal, admin-only.
            await db.update(hrRadarAlerts)
              .set({
                status: "hit",
                hitInning: hrData.inning,
                hitHalf: hrData.half,
                hitLabel,
                hitDetectedAt: nowDate,
                resolvedAt: nowDate,
                gradingStatus: "late_signal",
                gradingReason: `reconcile: signal ${sigInn}/${sigHalf} not strictly before HR ${hrData.inning}/${hrData.half}`,
                matchedBeforeHr: false,
                userVisible: false,
                matchMethod: "post_hr_fallback",
                signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt,
                signalInning: sigInn,
                signalHalf: sigHalf,
              })
              .where(eq(hrRadarAlerts.id, alert.id));
            console.log(`[HR_RADAR_LATE_SIGNAL] (reconcile) playerId=${alert.playerId} gameId=${gameId} sig=${sigInn}/${sigHalf} hr=${hrData.inning}/${hrData.half}`);
            console.log(`[HR_LEDGER_LATE] (reconcile) sessionDate=${today} gameId=${gameId} playerId=${alert.playerId} signalInning=${sigInn ?? "n/a"}${sigHalf ?? ""} hitInning=${hrData.inning}${hrData.half} alertId=${alert.id}`);
          }
        } else {
          await db.update(hrRadarAlerts)
            .set({
              status: "miss",
              resolvedAt: nowDate,
              gradingStatus: "called_miss",
              gradingReason: "reconcile: game ended without HR for this called signal",
              userVisible: true,
              matchedBeforeHr: false,
              matchMethod: "direct_pre_hr_signal",
            })
            .where(eq(hrRadarAlerts.id, alert.id));
          console.log(`[HR_RADAR_ALERT_MISS] playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel}`);
          console.log(`[HR_LEDGER_GRADE] outcome=called_miss (reconcile) sessionDate=${today} gameId=${gameId} playerId=${alert.playerId} detectedLabel=${alert.detectedLabel} alertId=${alert.id}`);
        }
      }

      await this.collapseDuplicateHrRadarOutcomes(gameId, today);
      await this.archiveDailyHrRadarOutcomesToAnalytics(gameId, today);
    } catch (err: any) {
      console.warn(`[HR_RADAR_RECONCILE] Failed for game=${gameId}: ${err.message}`);
    }
  }

  async collapseDuplicateHrRadarOutcomes(gameId: string, sessionDate: string): Promise<void> {
    try {
      const alerts = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.sessionDate, sessionDate),
          eq(hrRadarAlerts.gameId, gameId),
        ));

      const byPlayer = new Map<string, HrRadarAlert[]>();
      for (const a of alerts) {
        const list = byPlayer.get(a.playerId) || [];
        list.push(a);
        byPlayer.set(a.playerId, list);
      }

      for (const [pid, dupes] of Array.from(byPlayer.entries())) {
        if (dupes.length <= 1) continue;

        const hasHit = dupes.find((d: HrRadarAlert) => d.status === "hit");
        const canonical = hasHit ?? dupes[0];

        if (hasHit) {
          for (const d of dupes) {
            if (d.id !== canonical.id && d.status === "miss") {
              await db.update(hrRadarAlerts)
                .set({ status: "hit", hitInning: hasHit.hitInning, hitHalf: hasHit.hitHalf, hitLabel: hasHit.hitLabel, resolvedAt: hasHit.resolvedAt })
                .where(eq(hrRadarAlerts.id, d.id));
            }
          }
        }
        console.log(`[HR_RADAR_DEDUPE_COLLAPSE] sessionDate=${sessionDate} gameId=${gameId} playerId=${pid} duplicateCount=${dupes.length} finalStatus=${canonical.status}`);
      }
    } catch (err: any) {
      console.warn(`[HR_RADAR_DEDUPE_COLLAPSE] Failed: ${err.message}`);
    }
  }

  async archiveDailyHrRadarOutcomesToAnalytics(gameId: string, sessionDate: string): Promise<void> {
    try {
      const alerts = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.sessionDate, sessionDate),
          eq(hrRadarAlerts.gameId, gameId),
          ne(hrRadarAlerts.status, "live"),
          eq(hrRadarAlerts.analyticsPersisted, false),
        ));

      for (const alert of alerts) {
        await db.insert(hrRadarAnalytics).values({
          sessionDate: alert.sessionDate,
          gameId: alert.gameId,
          playerId: alert.playerId,
          playerName: alert.playerName,
          team: alert.team,
          detectedLabel: alert.detectedLabel,
          hitLabel: alert.hitLabel,
          detectedScore: alert.initialReadinessScore,
          peakScore: alert.peakReadinessScore,
          scoreIncreaseAmount: alert.scoreIncreaseAmount,
          result: alert.status,
          confidenceTier: alert.confidenceTier,
          triggerTags: alert.triggerTags,
        });

        await db.update(hrRadarAlerts)
          .set({ analyticsPersisted: true })
          .where(eq(hrRadarAlerts.id, alert.id));
      }

      if (alerts.length > 0) {
        const hits = alerts.filter(a => a.status === "hit").length;
        const misses = alerts.filter(a => a.status === "miss").length;
        console.log(`[HR_RADAR_ANALYTICS_ARCHIVE] sessionDate=${sessionDate} totalCalls=${alerts.length} hits=${hits} misses=${misses}`);
      }
    } catch (err: any) {
      console.warn(`[HR_RADAR_ANALYTICS_ARCHIVE] Failed: ${err.message}`);
    }
  }

  async getCanonicalHrRadarOutcomes(sessionDate?: string): Promise<{
    hits: Array<{
      sessionDate: string;
      gameId: string;
      playerId: string;
      playerName: string;
      team: string;
      finalStatus: "hit";
      detectedLabel: string | null;
      hitLabel: string | null;
      hitInning: number | null;
      hitHalf: string | null;
      detectedScore: number | null;
      peakScore: number | null;
      triggerTags: string[];
      resolvedAt: Date | null;
      alertPath: string | null;
      conversionPct: number | null;
      // Explicit grading truth model exposed to UI (Step 8/10 of HR ledger spec)
      gradingStatus: string;
      gradingReason: string | null;
      matchedBeforeHr: boolean;
      fallbackCreated: boolean;
      userVisible: boolean;
      signalDetectedAt: Date | null;
      signalInning: number | null;
      signalHalf: string | null;
      hitDetectedAt: Date | null;
    }>;
    misses: Array<{
      sessionDate: string;
      gameId: string;
      playerId: string;
      playerName: string;
      team: string;
      finalStatus: "miss";
      detectedLabel: string | null;
      hitLabel: string | null;
      detectedScore: number | null;
      peakScore: number | null;
      triggerTags: string[];
      resolvedAt: Date | null;
      alertPath: string | null;
      conversionPct: number | null;
    }>;
    summary: { wins: number; losses: number; totalGraded: number; hitRate: number };
  }> {
    const targetDate = sessionDate ?? todayET();
    try {
      const allRows = await db.select().from(hrRadarAlerts)
        .where(eq(hrRadarAlerts.sessionDate, targetDate))
        .orderBy(desc(hrRadarAlerts.resolvedAt));

      const rawRowCount = allRows.length;
      const gradedRows = allRows.filter(r => r.status === "hit" || r.status === "miss");

      const canonicalMap = new Map<string, typeof gradedRows[0]>();
      for (const row of gradedRows) {
        const key = `${row.sessionDate}|${row.gameId}|${row.playerId}`;
        const existing = canonicalMap.get(key);
        if (!existing) {
          canonicalMap.set(key, row);
        } else {
          console.log(`[HR_RADAR_DUPLICATE_COLLAPSE] sessionDate=${row.sessionDate} gameId=${row.gameId} playerId=${row.playerId} duplicateRowCount=2 finalStatus=${row.status === "hit" || existing.status === "hit" ? "hit" : "miss"}`);
          if (row.status === "hit" && existing.status !== "hit") {
            canonicalMap.set(key, row);
          }
        }
      }

      const canonicalRows = Array.from(canonicalMap.values());
      const extractConvPct = (row: typeof canonicalRows[0]): number | null => {
        const diag = row.diagnosticsSnapshot as any;
        if (!diag?.hrConversion) return null;
        return diag.hrConversion.calibratedProbability ?? diag.hrConversion.hrConversionProbability ?? null;
      };

      // User-facing Cashed: only true called hits. Uncalled HR / late signal stay admin-only.
      const hits = canonicalRows
        .filter(r => r.status === "hit" && r.gradingStatus === "called_hit" && r.userVisible === true)
        .map(r => ({
          sessionDate: r.sessionDate,
          gameId: r.gameId,
          playerId: r.playerId,
          playerName: r.playerName,
          team: r.team,
          finalStatus: "hit" as const,
          detectedLabel: r.detectedLabel,
          hitLabel: r.hitLabel,
          hitInning: r.hitInning,
          hitHalf: r.hitHalf,
          detectedScore: r.initialReadinessScore ? parseFloat(r.initialReadinessScore) : null,
          peakScore: r.peakReadinessScore ? parseFloat(r.peakReadinessScore) : null,
          triggerTags: r.triggerTags ?? [],
          resolvedAt: r.resolvedAt,
          alertPath: r.alertPath ?? null,
          conversionPct: extractConvPct(r),
          // Explicit grading truth model exposed to UI
          gradingStatus: r.gradingStatus,
          gradingReason: r.gradingReason,
          matchedBeforeHr: r.matchedBeforeHr,
          fallbackCreated: r.fallbackCreated,
          userVisible: r.userVisible,
          signalDetectedAt: r.signalDetectedAt,
          signalInning: r.signalInning,
          signalHalf: r.signalHalf,
          hitDetectedAt: r.hitDetectedAt,
        }));

      const misses = canonicalRows
        .filter(r => r.status === "miss")
        .map(r => ({
          sessionDate: r.sessionDate,
          gameId: r.gameId,
          playerId: r.playerId,
          playerName: r.playerName,
          team: r.team,
          finalStatus: "miss" as const,
          detectedLabel: r.detectedLabel,
          hitLabel: r.hitLabel,
          detectedScore: r.initialReadinessScore ? parseFloat(r.initialReadinessScore) : null,
          peakScore: r.peakReadinessScore ? parseFloat(r.peakReadinessScore) : null,
          triggerTags: r.triggerTags ?? [],
          resolvedAt: r.resolvedAt,
          alertPath: r.alertPath ?? null,
          conversionPct: extractConvPct(r),
        }));

      // Use authoritative gradingStatus column instead of legacy triggerTags heuristic.
      const calledHits = hits.filter(h => (h as any).gradingStatus === "called_hit");
      const calledMisses = misses;
      const totalGraded = calledHits.length + calledMisses.length;
      const hitRate = totalGraded > 0 ? Math.round((calledHits.length / totalGraded) * 1000) / 10 : 0;

      const rawHitCount = gradedRows.filter(r => r.status === "hit").length;
      const rawMissCount = gradedRows.filter(r => r.status === "miss").length;
      if (rawHitCount !== hits.length || rawMissCount !== misses.length) {
        console.log(`[HR_RADAR_SUMMARY_MISMATCH] sessionDate=${targetDate} rawHitCount=${rawHitCount} rawMissCount=${rawMissCount} canonicalHitCount=${hits.length} canonicalMissCount=${misses.length}`);
      }

      console.log(`[HR_RADAR_CANONICAL_OUTCOME_BUILD] sessionDate=${targetDate} rawRowCount=${rawRowCount} canonicalRowCount=${canonicalRows.length} hitCount=${hits.length} missCount=${misses.length}`);

      return {
        hits,
        misses,
        summary: { wins: calledHits.length, losses: calledMisses.length, totalGraded, hitRate },
      };
    } catch (err: any) {
      console.warn(`[HR_RADAR_CANONICAL_OUTCOME_BUILD] Failed: ${err.message}`);
      return { hits: [], misses: [], summary: { wins: 0, losses: 0, totalGraded: 0, hitRate: 0 } };
    }
  }

  async getHrRadarGradingHistory(days: number = 14): Promise<Array<{
    sessionDate: string;
    calledHits: number;
    uncalledHits: number;
    misses: number;
    totalGraded: number;
    hitRate: number;
  }>> {
    try {
      const cutoffStr = daysAgoET(days);

      const allRows = await db.select().from(hrRadarAlerts)
        .where(sql`${hrRadarAlerts.sessionDate} >= ${cutoffStr}`)
        .orderBy(desc(hrRadarAlerts.sessionDate));

      const byDate = new Map<string, typeof allRows>();
      for (const row of allRows) {
        if (row.status !== "hit" && row.status !== "miss") continue;
        const existing = byDate.get(row.sessionDate) ?? [];
        existing.push(row);
        byDate.set(row.sessionDate, existing);
      }

      const result: Array<{
        sessionDate: string;
        calledHits: number;
        uncalledHits: number;
        misses: number;
        totalGraded: number;
        hitRate: number;
      }> = [];

      for (const [date, rows] of Array.from(byDate.entries()).sort((a, b) => b[0].localeCompare(a[0]))) {
        const canonicalMap = new Map<string, typeof rows[0]>();
        for (const row of rows) {
          const key = `${row.sessionDate}|${row.gameId}|${row.playerId}`;
          const existing = canonicalMap.get(key);
          if (!existing) {
            canonicalMap.set(key, row);
          } else if (row.status === "hit" && existing.status !== "hit") {
            canonicalMap.set(key, row);
          }
        }

        const canonical = Array.from(canonicalMap.values());
        const calledHits = canonical.filter(r => r.gradingStatus === "called_hit").length;
        const uncalledHits = canonical.filter(r => r.gradingStatus === "uncalled_hr" || r.gradingStatus === "late_signal").length;
        const misses = canonical.filter(r => r.gradingStatus === "called_miss").length;
        const totalGraded = calledHits + misses;
        const hitRate = totalGraded > 0 ? Math.round((calledHits / totalGraded) * 1000) / 10 : 0;

        result.push({ sessionDate: date, calledHits, uncalledHits, misses, totalGraded, hitRate });
      }

      return result;
    } catch (err: any) {
      console.warn(`[HR_RADAR_GRADING_HISTORY] Failed: ${err.message}`);
      return [];
    }
  }

  async getTodayHrRadarBoard(): Promise<HrRadarAlert[]> {
    const today = todayET();
    return db.select().from(hrRadarAlerts)
      .where(eq(hrRadarAlerts.sessionDate, today))
      .orderBy(desc(hrRadarAlerts.detectedAt));
  }

  async getTodayHrRadarBoardForSession(sessionDate: string): Promise<HrRadarAlert[]> {
    return db.select().from(hrRadarAlerts)
      .where(eq(hrRadarAlerts.sessionDate, sessionDate))
      .orderBy(desc(hrRadarAlerts.detectedAt));
  }

  async getHrRadarAlertForAnalyze(playerId: string, gameId: string): Promise<HrRadarAlert | null> {
    const today = todayET();
    const todayRows = await db.select().from(hrRadarAlerts)
      .where(and(
        eq(hrRadarAlerts.sessionDate, today),
        eq(hrRadarAlerts.gameId, gameId),
        eq(hrRadarAlerts.playerId, playerId),
      ))
      .limit(1);
    if (todayRows[0]) return todayRows[0];
    // Fallback: latest matching row regardless of session date — supports historical analyze.
    const anyRows = await db.select().from(hrRadarAlerts)
      .where(and(
        eq(hrRadarAlerts.gameId, gameId),
        eq(hrRadarAlerts.playerId, playerId),
      ))
      .orderBy(desc(hrRadarAlerts.detectedAt))
      .limit(1);
    return anyRows[0] ?? null;
  }

  async getHrRadarAnalyzeSource(playerId: string, gameId: string): Promise<{
    source: "live_alert" | "historical_alert" | "graded_hit" | "graded_miss" | "analytics_fallback";
    alert: any;
  } | null> {
    const today = todayET();
    // 1. today's live alert
    const todayRows = await db.select().from(hrRadarAlerts)
      .where(and(
        eq(hrRadarAlerts.sessionDate, today),
        eq(hrRadarAlerts.gameId, gameId),
        eq(hrRadarAlerts.playerId, playerId),
      ))
      .limit(1);
    if (todayRows[0]) return { source: "live_alert", alert: todayRows[0] };

    // 2. latest alert any session
    const anyRows = await db.select().from(hrRadarAlerts)
      .where(and(
        eq(hrRadarAlerts.gameId, gameId),
        eq(hrRadarAlerts.playerId, playerId),
      ))
      .orderBy(desc(hrRadarAlerts.detectedAt))
      .limit(1);
    if (anyRows[0]) {
      const r = anyRows[0];
      const source = r.status === "hit" ? "graded_hit" : r.status === "miss" ? "graded_miss" : "historical_alert";
      return { source, alert: r };
    }

    // 3. analytics fallback (synthesize an alert-shaped object)
    try {
      const analyticsRows = await db.select().from(hrRadarAnalytics)
        .where(and(
          eq(hrRadarAnalytics.gameId, gameId),
          eq(hrRadarAnalytics.playerId, playerId),
        ))
        .orderBy(desc(hrRadarAnalytics.createdAt))
        .limit(1);
      const a = analyticsRows[0];
      if (a) {
        const synthAlert = {
          id: `analytics-${a.id}`,
          sessionDate: a.sessionDate,
          gameId: a.gameId,
          playerId: a.playerId,
          playerName: a.playerName,
          team: a.team,
          status: a.result === "hit" ? "hit" : a.result === "miss" ? "miss" : "live",
          detectedLabel: a.detectedLabel ?? null,
          detectedInning: null,
          detectedHalf: null,
          hitLabel: a.hitLabel ?? null,
          hitInning: null,
          hitHalf: null,
          initialReadinessScore: a.detectedScore ?? "0",
          currentReadinessScore: a.peakScore ?? a.detectedScore ?? "0",
          peakReadinessScore: a.peakScore ?? a.detectedScore ?? "0",
          confidenceTier: a.confidenceTier,
          signalState: null,
          triggerTags: a.triggerTags ?? [],
          summaryText: null,
          alertPath: null,
          conversionPct: null,
          gradingStatus: a.result === "hit" ? "called_hit" : a.result === "miss" ? "called_miss" : "active",
          gradingReason: "analytics_fallback",
          matchedBeforeHr: null,
          fallbackCreated: false,
          userVisible: true,
          signalDetectedAt: a.createdAt,
          signalInning: null,
          signalHalf: null,
          hitDetectedAt: null,
          detectedAt: a.createdAt ?? new Date(),
          resolvedAt: null,
          scoreIncreased: false,
          scoreIncreaseLabel: null,
        };
        return { source: "analytics_fallback", alert: synthAlert };
      }
    } catch {}
    return null;
  }

  async getHrRadarAnalytics(filters?: {
    sessionDate?: string;
    playerId?: string;
    team?: string;
    result?: string;
    confidenceTier?: string;
    limit?: number;
  }): Promise<HrRadarAnalyticsRecord[]> {
    const conditions = [];
    if (filters?.sessionDate) conditions.push(eq(hrRadarAnalytics.sessionDate, filters.sessionDate));
    if (filters?.playerId) conditions.push(eq(hrRadarAnalytics.playerId, filters.playerId));
    if (filters?.team) conditions.push(eq(hrRadarAnalytics.team, filters.team));
    if (filters?.result) conditions.push(eq(hrRadarAnalytics.result, filters.result));
    if (filters?.confidenceTier) conditions.push(eq(hrRadarAnalytics.confidenceTier, filters.confidenceTier));

    const query = db.select().from(hrRadarAnalytics);
    const rows = conditions.length > 0
      ? await query.where(and(...conditions)).orderBy(desc(hrRadarAnalytics.createdAt)).limit(filters?.limit ?? 200)
      : await query.orderBy(desc(hrRadarAnalytics.createdAt)).limit(filters?.limit ?? 200);
    return rows;
  }

  // ── HR Radar Decision Ladder (Step 11–18 of HR ledger spec) ──
  // Bins today's HR-radar alerts into a 5-section ladder for the user-facing
  // decision UI: attackNow / building / watch / cashed / dead.
  async getHrRadarLadder(sessionDate?: string): Promise<{
    sessionDate: string;
    sections: {
      attackNow: HrRadarLadderEntry[];
      building: HrRadarLadderEntry[];
      watch: HrRadarLadderEntry[];
      cashed: HrRadarLadderEntry[];
      dead: HrRadarLadderEntry[];
    };
    counts: { attackNow: number; building: number; watch: number; cashed: number; dead: number; total: number };
  }> {
    const targetDate = sessionDate ?? todayET();
    const rows = await db.select().from(hrRadarAlerts)
      .where(eq(hrRadarAlerts.sessionDate, targetDate))
      .orderBy(desc(hrRadarAlerts.peakReadinessScore));

    const sections = {
      attackNow: [] as HrRadarLadderEntry[],
      building: [] as HrRadarLadderEntry[],
      watch: [] as HrRadarLadderEntry[],
      cashed: [] as HrRadarLadderEntry[],
      dead: [] as HrRadarLadderEntry[],
    };

    // Collapse duplicates by playerId|gameId so a single player only appears
    // in one section. Resolved final outcomes (cashed/dead) always supersede
    // pending active states for the same player|game; among active states,
    // attackNow > building > watch.
    const seen = new Map<string, { section: keyof typeof sections; entry: HrRadarLadderEntry }>();
    const sectionPriority: Record<keyof typeof sections, number> = {
      cashed: 0, dead: 1, attackNow: 2, building: 3, watch: 4,
    };

    for (const r of rows) {
      const grading = r.gradingStatus ?? "active";
      // Hidden/admin-only rows must never reach the user-facing ladder for ACTIVE
      // states. Resolved outcomes (uncalled_hr, late_signal, called_miss,
      // called_hit) are always shown so users get a complete picture of what
      // happened in the session — they're labeled with their outcome badge in
      // the Dead/Missed section.
      if (r.userVisible === false && grading === "active") continue;

      const key = `${r.gameId}|${r.playerId}`;

      // Determine target section
      let section: keyof typeof sections;
      if (grading === "called_hit") {
        section = "cashed";
      } else if (grading === "called_miss" || grading === "uncalled_hr" || grading === "late_signal") {
        section = "dead";
      } else {
        // Active rows — classify using the actual values written by
        // liveGameOrchestrator: confidenceTier ∈ {monitor,building,strong},
        // signalState ∈ {watching,live,actionable}.
        const tier = (r.confidenceTier ?? "monitor").toLowerCase();
        const state = (r.signalState ?? "watching").toLowerCase();
        if (tier === "strong" || state === "actionable") {
          section = "attackNow";
        } else if (tier === "building" || state === "live") {
          section = "building";
        } else {
          section = "watch";
        }
      }

      const whyNowReasons = this.buildHrRadarWhyNow(r);
      const entry: HrRadarLadderEntry = {
        playerId: r.playerId,
        playerName: r.playerName,
        team: r.team,
        gameId: r.gameId,
        state: r.signalState ?? null,
        confidenceTier: r.confidenceTier ?? null,
        peakScore: r.peakReadinessScore ? parseFloat(r.peakReadinessScore) : null,
        signalStrengthScore: r.currentReadinessScore ? parseFloat(r.currentReadinessScore) : null,
        whyNowReasons,
        nextAbEstimate: this.buildNextAbEstimate(r),
        detectedInning: r.signalInning ?? r.detectedInning ?? null,
        detectedHalf: r.signalHalf ?? r.detectedHalf ?? null,
        hitInning: r.hitInning ?? null,
        hitHalf: r.hitHalf ?? null,
        outcomeStatus: grading,
        userVisible: r.userVisible ?? true,
        signalDetectedAt: r.signalDetectedAt ?? r.detectedAt ?? null,
        hitDetectedAt: r.hitDetectedAt ?? null,
        resolvedAt: r.resolvedAt ?? null,
        alertPath: r.alertPath ?? null,
      };

      const existing = seen.get(key);
      if (!existing || sectionPriority[section] < sectionPriority[existing.section]) {
        seen.set(key, { section, entry });
      }
    }

    for (const { section, entry } of Array.from(seen.values())) {
      sections[section].push(entry);
    }

    // Within sections, order by priority signal: cashed by hit time desc; everyone else by peak score desc
    sections.cashed.sort((a, b) => (b.hitDetectedAt?.getTime() ?? 0) - (a.hitDetectedAt?.getTime() ?? 0));
    sections.attackNow.sort((a, b) => (b.signalStrengthScore ?? 0) - (a.signalStrengthScore ?? 0));
    sections.building.sort((a, b) => (b.peakScore ?? 0) - (a.peakScore ?? 0));
    sections.watch.sort((a, b) => (b.peakScore ?? 0) - (a.peakScore ?? 0));
    sections.dead.sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0));

    const counts = {
      attackNow: sections.attackNow.length,
      building: sections.building.length,
      watch: sections.watch.length,
      cashed: sections.cashed.length,
      dead: sections.dead.length,
      total: seen.size,
    };

    console.log(`[HR_DECISION_LADDER_COUNTS] sessionDate=${targetDate} attackNow=${counts.attackNow} building=${counts.building} watch=${counts.watch} cashed=${counts.cashed} dead=${counts.dead} total=${counts.total}`);

    return { sessionDate: targetDate, sections, counts };
  }

  private buildHrRadarWhyNow(r: HrRadarAlert): string[] {
    const reasons: string[] = [];
    const tags = (r.triggerTags ?? []).filter(t => typeof t === "string" && t.length > 0);
    for (const t of tags.slice(0, 4)) {
      reasons.push(this.humanizeHrRadarTag(t));
    }
    if (r.scoreIncreased && r.scoreIncreaseLabel && reasons.length < 5) {
      reasons.push(`Score climbed in ${r.scoreIncreaseLabel}`);
    }
    if (r.summaryText && reasons.length < 5) {
      reasons.push(r.summaryText);
    }
    return reasons;
  }

  private humanizeHrRadarTag(tag: string): string {
    const map: Record<string, string> = {
      hot_hitter: "Hot hitter (recent HR streak)",
      barrel_streak: "Barrel-rate streak",
      hard_contact: "Hard-contact uptick",
      pitcher_fade: "Pitcher fading (fastball velo down)",
      pitcher_fatigue: "Pitcher fatigue building",
      bvp_advantage: "Strong BvP history",
      park_boost: "Park HR boost",
      wind_out: "Wind blowing out",
      lineup_protection: "Lineup protection upgraded",
      due_up_soon: "Due up next inning",
      high_xba_zone: "Pitcher in high-xBA zone",
      ev_uptick: "Exit velocity climbing",
    };
    return map[tag] ?? tag.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }

  private buildNextAbEstimate(r: HrRadarAlert): string | null {
    // Active alerts only — graded ones don't need an ETA.
    const grading = r.gradingStatus ?? "active";
    if (grading !== "active") return null;
    const inning = r.detectedInning;
    const half = (r.detectedHalf ?? "").toLowerCase();
    if (inning == null) return null;
    const halfText = half.startsWith("t") || half === "top" ? "Top" : half.startsWith("b") || half === "bottom" ? "Bot" : null;
    if (halfText) return `Watching ${halfText} ${inning}`;
    return `Watching inning ${inning}`;
  }
}

export interface HrRadarLadderEntry {
  playerId: string;
  playerName: string;
  team: string;
  gameId: string;
  state: string | null;
  confidenceTier: string | null;
  peakScore: number | null;
  signalStrengthScore: number | null;
  whyNowReasons: string[];
  nextAbEstimate: string | null;
  detectedInning: number | null;
  detectedHalf: string | null;
  hitInning: number | null;
  hitHalf: string | null;
  outcomeStatus: string; // active | called_hit | called_miss | uncalled_hr | late_signal
  userVisible: boolean;
  signalDetectedAt: Date | null;
  hitDetectedAt: Date | null;
  resolvedAt: Date | null;
  alertPath: string | null;
}

export const storage = new DatabaseStorage();
