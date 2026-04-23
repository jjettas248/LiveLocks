import { db } from "./db";
import { todayET, daysAgoET } from "./utils/dateUtils";
import { resolveMlbGameSessionDate } from "./utils/mlbSessionDate";
import { decideHrRadarMatch, QUALIFYING_EVENT_TYPES } from "./validation/hrRadar/matchDecision";
import { calculateRemainingMinutes } from "./minutesModel";
import { getPlayerUsage, getTeamDefenseMatchup, computeUsageAdjustment, computeDefenseMultiplier } from "./services/nbaStatsService";
import { getPlayoffRotationProfile, type PlayoffRotationProfile } from "./services/nbaRotationHistoryService";
import { classifyArchetype as classifyNBAArchetype, type NBAArchetype, VARIANCE_MULTIPLIERS, MINUTES_FRAGILITY_MULTIPLIERS, CORRELATION_DEFAULTS, COMBO_VARIANCE_EXTRA, isVolatileArchetype, isImpactedArchetype, isStableArchetype, getSafetyCeiling, getPlayoffSafetyCeiling, getPlayoffFragilityMultiplier } from "./nba/archetypes";
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
  hrOutcomes,
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

// ── Phase 4: Competitive playoff context detector ─────────────────────────
// Returns true when in-game / pregame signals suggest a non-blowout path.
// Used to gate close-game minute extension boosts so we don't reward
// star/starter logic in already-decided games.
export function isCompetitivePlayoffMinuteContext(args: {
  seasonPhase: "early" | "mid" | "late" | "playoffs";
  liveScoreDiff?: number | null;
  pregameSpread?: number | null;
  quarter?: number | null;
  minutesRemaining?: number | null;
}): boolean {
  if (args.seasonPhase !== "playoffs") return false;
  if (args.liveScoreDiff != null) {
    return Math.abs(args.liveScoreDiff) <= 12;
  }
  if (args.pregameSpread != null) {
    return Math.abs(args.pregameSpread) <= 8;
  }
  // Default to true when we have no context (don't punish unknowns).
  return true;
}

// ── Phase 7: Playoff high-confidence eligibility gate ─────────────────────
// Decides whether a play is allowed to display 70+/80+ confidence based on
// real playoff role evidence. The reason string is appended to calibration
// track so analytics can show exactly why a play was capped.
export function canReachPlayoffHighConfidence(args: {
  playoffRotationProfile: PlayoffRotationProfile | null;
  archetype: NBAArchetype;
  playoffDataFallbackUsed: boolean;
  playoffRotationFallbackUsed: boolean;
  isComboMarket: boolean;
}): { can70: boolean; can80: boolean; reason: string } {
  const p = args.playoffRotationProfile;

  // Hard fail: no rotation data at all → cannot reach 70+
  if (!p || p.dataSource === "none") {
    return { can70: false, can80: false, reason: "no_rotation_data" };
  }

  // Rotation fallback to regular season → cap below elite tier.
  // Game-1 grace: stable_star with very high RS role certainty + low rank can
  // still reach 70 (but not 80) so legit superstars (Jokic, LeBron, SGA) are
  // not hard-capped at 68 in Round 1 Game 1 just because no playoff log exists
  // yet. 80+ still requires real playoff data — no exception.
  if (args.playoffRotationFallbackUsed || p.dataSource === "regular_season_fallback") {
    const rsRoleCert = p.playoffRoleCertainty ?? 0;
    const rsRank = p.rotationRankEstimate ?? 99;
    const rsClose = p.closeGameTrustScore ?? 0;
    const game1Grace =
      args.archetype === "stable_star" &&
      !args.isComboMarket &&
      rsRoleCert >= 0.82 &&
      rsRank <= 2 &&
      rsClose >= 0.65;
    if (game1Grace) {
      return { can70: true, can80: false, reason: "rotation_rs_fallback_game1_grace" };
    }
    return { can70: false, can80: false, reason: "rotation_rs_fallback" };
  }

  // Usage/defense fell back to regular season → no 80+
  if (args.playoffDataFallbackUsed) {
    const can70Soft = (p.playoffRoleCertainty ?? 0) >= 0.70 && (p.rotationRankEstimate ?? 99) <= 4;
    return { can70: can70Soft, can80: false, reason: "playoff_data_rs_fallback" };
  }

  const roleCert = p.playoffRoleCertainty ?? 0;
  const rank = p.rotationRankEstimate ?? 99;
  const closeTrust = p.closeGameTrustScore ?? 0;
  const variance = p.playoffMinutesVariance ?? 999;

  // 70+ requirements
  const comboBumpRole = args.isComboMarket ? 0.06 : 0;
  const can70 =
    roleCert >= (0.62 + comboBumpRole) &&
    rank <= (args.isComboMarket ? 6 : 7) &&
    closeTrust >= 0.50 &&
    variance < 35;

  // 80+ requirements (much stricter)
  const stableArchetype = args.archetype === "stable_star" || args.archetype === "stable_starter";
  const comboBump80 = args.isComboMarket ? 0.05 : 0;
  const can80 =
    can70 &&
    stableArchetype &&
    roleCert >= (0.78 + comboBump80) &&
    rank <= 3 &&
    closeTrust >= 0.65 &&
    variance < 25;

  let reason = "ok";
  if (!can80 && !can70) reason = "weak_role";
  else if (!can80) reason = `cap80(role=${roleCert.toFixed(2)},rank=${rank},trust=${closeTrust.toFixed(2)},arch=${args.archetype})`;

  return { can70, can80, reason };
}

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

    if (process.env.DEBUG_NBA === "true") {
      console.log("[NBA_PLAYOFF_PHASE]", {
        gameDate: d.toISOString().slice(0, 10),
        seasonPhase,
        isPlayoffs: seasonPhase === "playoffs",
        playoffsStart: playoffsStart.toISOString().slice(0, 10),
      });
    }

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
    // Local helper accessor (declared via function decl below the class is not
    // valid here, so reference module-level helper). See bottom of file.
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
    // ─── Phase 3: Playoff rotation truth profile (non-blocking) ─────────────
    // Real playoff role evidence used by the minutes model and the
    // high-confidence eligibility gate. Fallback to null on any error so the
    // pipeline degrades gracefully to the existing behavior.
    let playoffRotationProfile: PlayoffRotationProfile | null = null;
    let playoffRotationFallbackUsed = false;
    if (isPlayoffs) {
      playoffRotationProfile = await getPlayoffRotationProfile({
        playerId: player.id,
        playerName: player.name,
        teamAbbr: player.team,
        opponentAbbr: req.opponentTeam,
        gameDate: req.gameDate,
        gameId: req.gameId,
      }).catch(() => null);
      playoffRotationFallbackUsed =
        playoffRotationProfile == null ||
        playoffRotationProfile.dataSource !== "playoffs";
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
      playoffRotationProfile,
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
      // Playoff calibration recovery: stable rotation pieces get a much
      // gentler shrink (or none for stable_star single markets) — they were
      // being over-compressed and squeezed out of the high-confidence
      // bucket. Volatile / impacted archetypes still shrink hard.
      const isStable = isStableArchetype(nbaArchetype);
      const baseShrink = isStable
        ? (isComboStat ? 0.80 : 0.90)
        : (isComboStat ? 0.72 : 0.82);
      let archetypePenalty = 1.0;
      switch (nbaArchetype) {
        case "stable_star":      archetypePenalty = 1.10; break;
        case "stable_starter":   archetypePenalty = 1.05; break;
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

    // Safety ceiling — playoff-aware resolution.
    //   • Stable archetypes in playoffs: use the playoff ceiling directly so
    //     stable stars / starters can exceed the regular-season cap.
    //   • Volatile / impacted: take the MORE conservative (lower) of the
    //     two — playoff mode never relaxes their caps.
    //   • Non-playoff: regular-season ceiling.
    const regularCeiling = getSafetyCeiling(nbaArchetype, isComboStat);
    const playoffCeiling = isPlayoffs ? getPlayoffSafetyCeiling(nbaArchetype, isComboStat) : regularCeiling;
    const appliedCeiling = isPlayoffs && isStableArchetype(nbaArchetype)
      ? playoffCeiling
      : Math.min(regularCeiling, playoffCeiling);
    let P_side_final = Math.min(P_side_calibrated, appliedCeiling);
    let confidenceCeilingApplied = P_side_calibrated > appliedCeiling;
    const isPlayoffCap = isPlayoffs && appliedCeiling !== regularCeiling;
    let ceilingReason = confidenceCeilingApplied
      ? `${nbaArchetype}_${isComboStat ? "combo" : "single"}_cap_${appliedCeiling}${isPlayoffCap ? "_playoff" : ""}`
      : null;
    if (isPlayoffCap) {
      calibrationTrack += `+playoff_cap_${appliedCeiling}`;
    }
    // Backwards-compat for existing diagnostics field name.
    const ceiling = appliedCeiling;

    if (process.env.DEBUG_NBA === "true") {
      console.log("[NBA_PROB_TRACE]", {
        player: player.name,
        market: req.statType,
        seasonPhase,
        archetype: nbaArchetype,
        rawProb: Math.round(P_side_raw * 10000) / 10000,
        fragilityScore: Math.round(fragilityScore * 1000) / 1000,
        fragilityPenalty: Math.round(fragilityPenalty * 1000) / 1000,
        postFragilityProb: Math.round(P_side_fragile * 10000) / 10000,
        calibrationTrack,
        postCalibrationProb: Math.round(P_side_calibrated * 10000) / 10000,
      });
      console.log("[NBA_CEILING_TRACE]", {
        player: player.name,
        market: req.statType,
        archetype: nbaArchetype,
        regularCeiling,
        playoffCeiling,
        appliedCeiling,
        confidenceCeilingApplied,
        finalProb: Math.round(P_side_final * 10000) / 10000,
      });
    }

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
    let playoffRoleGate70Applied = false;
    let playoffRoleGate80Applied = false;
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
      // ── Phase 7: Playoff role-truth eligibility gate ────────────────────
      // Refuse 70+/80+ unless real playoff role evidence supports it.
      // Stops generic minute heuristics from graduating uncertain plays.
      const eligibility = canReachPlayoffHighConfidence({
        playoffRotationProfile,
        archetype: nbaArchetype,
        playoffDataFallbackUsed,
        playoffRotationFallbackUsed,
        isComboMarket: isComboStat,
      });
      if (!eligibility.can80 && displayConfidence >= 80) {
        const cap = isComboStat ? 70 : 74;
        if (displayConfidence > cap) {
          displayConfidence = cap;
          calibrationTrack += `+playoff_role_gate_80:${eligibility.reason}`;
          playoffRoleGate80Applied = true;
          console.log(`[NBA_PLAYOFF_ROLE_GATE] player=${player.name} cap80→${cap} reason=${eligibility.reason}`);
        }
      }
      if (!eligibility.can70 && displayConfidence >= 70) {
        const cap = 68;
        if (displayConfidence > cap) {
          displayConfidence = cap;
          calibrationTrack += `+playoff_role_gate_70:${eligibility.reason}`;
          playoffRoleGate70Applied = true;
          console.log(`[NBA_PLAYOFF_ROLE_GATE] player=${player.name} cap70→${cap} reason=${eligibility.reason}`);
        }
      }

      // ── Phase 8: Persist rotation profile snapshot into calibrationTrack ─
      // Encoded as compact tags so analytics can bucket plays without a schema
      // change. Format: +rotsnap:rank=N,cert=NN,ctrust=NN,sbench=NN,starride=NN
      if (playoffRotationProfile) {
        const p = playoffRotationProfile;
        const enc = (v: number | null | undefined) =>
          v == null || !Number.isFinite(v) ? "na" : String(Math.round(v));
        const enc01 = (v: number | null | undefined) =>
          v == null || !Number.isFinite(v) ? "na" : String(Math.round(v * 100));
        calibrationTrack += `+rotsnap:rank=${enc(p.rotationRankEstimate)},cert=${enc01(p.playoffRoleCertainty)},ctrust=${enc01(p.closeGameTrustScore)},sbench=${enc01(p.coachShortBenchIndex)},starride=${enc01(p.coachStarRideIndex)},src=${p.dataSource ?? "none"}`;
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
    gradingStatus: "called_hit" | "called_miss" | "uncalled_hr" | "late_signal";
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
        // ── Phase 5 — early-HR exemption ─────────────────────────────────
        // If the HR happened in the 1st inning AND no qualifying signal
        // event exists for this player/game prior to hrEnd, the engine had
        // no realistic pre-call window. Classify separately as
        // `early_hr_no_window` so this does NOT pollute the uncalled-miss
        // bucket. Admin reporting still sees it; coverage rate excludes it.
        const isFirstInning = (params.hrInning ?? 0) <= 1;
        if (isFirstInning) {
          // Confirm there are also no signal events for this player/game
          // within the entire match window — i.e. no engine activity at all.
          const earlyEventConditions = [
            eq(hrRadarSignalEvents.gameId, params.gameId),
            eq(hrRadarSignalEvents.playerId, params.playerId),
          ];
          if (hrEnd) earlyEventConditions.push(lt(hrRadarSignalEvents.detectedAt, new Date(hrEnd)));
          const earlyEvents = await db.select().from(hrRadarSignalEvents)
            .where(and(...earlyEventConditions))
            .limit(1);
          if (earlyEvents.length === 0) {
            console.log(`[HR_RADAR_EARLY_HR_NO_WINDOW] playerId=${params.playerId} gameId=${params.gameId} hrInning=${params.hrInning}${params.hrHalf} — exempt from uncalled-miss bucket`);
            return {
              matched: false, matchedBeforeHr: false, isLateSignal: false,
              alertId: null, signalEventId: null,
              signalDetectedAt: null, signalInning: null, signalHalf: null,
              gradingStatus: "early_hr_no_window" as any,
              gradingReason: "first-inning HR with no realistic pre-signal window — exempt from uncalled-miss bucket",
              matchMethod: "none",
            };
          }
        }
        return {
          matched: false, matchedBeforeHr: false, isLateSignal: false,
          alertId: null, signalEventId: null,
          signalDetectedAt: null, signalInning: null, signalHalf: null,
          gradingStatus: "uncalled_hr",
          gradingReason: "no canonical hr_radar_alert row exists for player/game",
          matchMethod: "none",
        };
      }

      // ── Goldmaster Detection Ledger Phase 5 (RC5) ─────────────────────
      // A called_hit is ONLY valid when an actual qualifying signal event
      // (qualified_detected / promoted_building / promoted_attack /
      // stage_building / stage_attack / escalated) exists strictly before
      // the HR endTime. The previous fallback that accepted "alert row
      // exists with detectedAt < hrEnd" was too permissive — watch-only
      // rows or row drift could be miscredited as called hits. The
      // canonical contract is now: NO qualifying event ⇒ NOT a called hit.
      const eventConditions = [
        eq(hrRadarSignalEvents.gameId, params.gameId),
        eq(hrRadarSignalEvents.playerId, params.playerId),
        inArray(hrRadarSignalEvents.eventType, QUALIFYING_EVENT_TYPES),
      ];
      // STRICT pre-HR: signal must occur strictly BEFORE the HR endTime. No grace window.
      if (hrEnd) eventConditions.push(lt(hrRadarSignalEvents.detectedAt, new Date(hrEnd)));
      const qualifyingEvents = await db.select().from(hrRadarSignalEvents)
        .where(and(...eventConditions))
        .orderBy(desc(hrRadarSignalEvents.detectedAt))
        .limit(1);
      const lastQualifyingEvent = qualifyingEvents[0] ?? null;

      const decision = decideHrRadarMatch({
        alert: {
          id: alert.id,
          signalDetectedAt: alert.signalDetectedAt ?? null,
          detectedAt: alert.detectedAt,
          signalInning: alert.signalInning ?? null,
          signalHalf: alert.signalHalf ?? null,
          detectedInning: alert.detectedInning ?? null,
          detectedHalf: alert.detectedHalf ?? null,
        },
        lastQualifyingEvent: lastQualifyingEvent
          ? {
              id: lastQualifyingEvent.id ?? null,
              eventType: lastQualifyingEvent.eventType,
              detectedAt: lastQualifyingEvent.detectedAt,
              inning: lastQualifyingEvent.inning ?? null,
              half: lastQualifyingEvent.half ?? null,
            }
          : null,
        hrEnd,
      });

      const sigMsLog = (alert.signalDetectedAt ?? alert.detectedAt).getTime();
      if (decision.gradingStatus === "called_hit" && lastQualifyingEvent && alert.detectedInning != null) {
        console.log(`[HR_RADAR_MATCH_RESULT] called_hit player=${params.playerId} game=${params.gameId} alertId=${alert.id} qualifyingEvent=${lastQualifyingEvent.eventType} signalAt=${new Date(lastQualifyingEvent.detectedAt).toISOString()} hrEndAt=${hrEnd ? new Date(hrEnd).toISOString() : "n/a"}`);
      } else if (decision.gradingStatus === "called_hit") {
        console.log(`[HR_RADAR_MATCH_RESULT] called_hit (timestamp-rescue) player=${params.playerId} game=${params.gameId} alertId=${alert.id} signalAt=${new Date(sigMsLog).toISOString()} hrEndAt=${hrEnd ? new Date(hrEnd).toISOString() : "n/a"} deltaMs=${hrEnd != null ? hrEnd - sigMsLog : "n/a"}`);
      } else if (decision.gradingStatus === "called_miss") {
        console.log(`[HR_RADAR_MATCH_RESULT] called_miss (presence-only) player=${params.playerId} game=${params.gameId} alertId=${alert.id} hrEndAt=${hrEnd ? new Date(hrEnd).toISOString() : "n/a"} reason="${decision.gradingReason}"`);
      } else {
        console.log(`[HR_RADAR_MATCH_RESULT] late_signal player=${params.playerId} game=${params.gameId} alertId=${alert.id} signalAt=${new Date(sigMsLog).toISOString()} hrEndAt=${hrEnd ? new Date(hrEnd).toISOString() : "n/a"}`);
      }

      return decision;
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
    // Canonical HR score contract (Phase 3) — explicit per-domain fields.
    // Persisted into diagnosticsSnapshot.scoreContract for traceability.
    buildScore?: number | null;
    conversionProbabilityRaw?: number | null;
    conversionProbability?: number | null;
    peakConversionProbability?: number | null;
    /**
     * Canonical user-facing HR Radar stage (Goldmaster Phase 1–4).
     * Comes from mapDynamicStateToStage(hrDynSnap.currentState). When provided,
     * overrides the legacy sticky bestTier behavior for live stage truth.
     * Persisted into diagnosticsSnapshot.stageContract.currentCanonicalStage
     * AND mapped onto the legacy `confidenceTier` column so the existing
     * board/ladder code keeps working without any schema migration.
     */
    canonicalStage?: "watch" | "building" | "attack" | "cooling" | "closed" | null;
    /**
     * Dynamic readiness score (0–100) from hrAlertEngine snapshot.
     * When provided, this is used as the live `readinessScore` instead of raw
     * hrBuildScore so progression is engine-driven, not formation-driven.
     */
    dynamicReadinessScore?: number | null;
    /**
     * Earliest in-memory detection inning from the engine snapshot
     * (`HRAlertSnapshot.detectedInning`). When provided AND earlier than
     * `data.inning`, the CREATE branch uses these to stamp the row's
     * `detectedInning/detectedHalf/detectedLabel/detectedAt` so the persisted
     * row reflects when the engine first noticed the player, not the inning
     * persistence finally fired. Once the row exists these are NEVER used
     * — UPDATE branch leaves detection fields immutable.
     */
    firstDetectedInning?: number | null;
    firstDetectedHalf?: "top" | "bottom" | null;
    firstDetectedAtMs?: number | null;
    /**
     * AB context (Goldmaster Phase 1, 3, 7). Number of plate appearances the
     * orchestrator has actually observed for this player in this game; used to
     * separate "pregame-only signal (0 AB)" from "live AB-confirmed signal"
     * in the user-facing card.
     */
    plateAppearancesTracked?: number | null;
    /**
     * True when at least one live AB contact event has been logged for the
     * player in this game. Pregame-context-only rows must set this to false.
     */
    hasLiveABContext?: boolean | null;
    /**
     * Task #126 — HR Presence Floor. When true the row is created strictly
     * to surface a power-threat batter on the HR radar. Such rows:
     *   - never stamp detectedInning / detectedHalf / detectedLabel
     *   - never stamp signalDetectedAt / signalInning / signalHalf
     *   - bypass the "no dynamic readiness ⇒ refuse to persist" guard
     *   - never emit qualifying signal_event rows (canonicalStage forced
     *     to "watch" so stage / qualified_detected branches never fire)
     *   - never UPDATE an existing live row (so a real PATH A–E row is
     *     never downgraded by a later presence-floor pass)
     * Their sole purpose is to convert future HRs by such batters from
     * `uncalled_hr` (no row existed) into `called_miss` (presence-only —
     * never crossed PATH A-E threshold) — never into `called_hit`.
     */
    isPresenceOnly?: boolean;
  }): Promise<HrRadarAlert | null> {
    // Embed canonical score contract into diagnosticsSnapshot so consumers
    // can read explicit per-domain values without DB schema changes.
    const scoreContract = {
      buildScore: data.buildScore ?? null,
      readinessScore: data.readinessScore,
      conversionProbabilityRaw: data.conversionProbabilityRaw ?? null,
      conversionProbability: data.conversionProbability ?? null,
      peakConversionProbability: data.peakConversionProbability ?? null,
    };
    // ── AB context (Goldmaster Phase 1, 3, 7) ──────────────────────────────
    const abContext = {
      plateAppearancesTracked: data.plateAppearancesTracked ?? null,
      hasLiveABContext: data.hasLiveABContext ?? null,
    };
    // ── Canonical stage contract (Goldmaster Phase 1–4) ────────────────────
    // currentCanonicalStage is the live engine truth (drives the user-facing
    // ladder). historicalBestStage is the audit-only sticky max (kept for
    // diagnostics; NEVER used to decide which section a player appears in).
    const stageRank: Record<string, number> = { closed: -1, watch: 0, cooling: 1, building: 1, attack: 2 };
    const baseDiagInit = (data.diagnosticsSnapshot ?? {}) as Record<string, unknown>;
    const incomingStage = data.canonicalStage ?? null;
    const stageContract: Record<string, unknown> = {
      currentCanonicalStage: incomingStage,
      historicalBestStage: incomingStage,
    };
    // Map canonical stage -> legacy confidenceTier so the rest of the system
    // (ladder, board) keeps working without schema changes. attack→strong,
    // building→building, watch/cooling→monitor.
    if (incomingStage) {
      const tierFromStage =
        incomingStage === "attack"
          ? "strong"
          : incomingStage === "building"
          ? "building"
          : "monitor";
      // eslint-disable-next-line no-param-reassign
      data.confidenceTier = tierFromStage as any;
    }
    data.diagnosticsSnapshot = { ...baseDiagInit, scoreContract, stageContract, abContext };
    // ── Goldmaster Phase 1 — single canonical 0-100 wire scale ─────────────
    // The caller's contract is: `dynamicReadinessScore` (when provided) is on
    // the canonical 0-100 readiness scale; `readinessScore` alone (the legacy
    // path) is on the 0-10 build-score scale. Use the PRESENCE of
    // dynamicReadinessScore as the scale discriminator. Do NOT use a value
    // threshold (e.g. "<=10") because legitimate canonical scores can land
    // anywhere in [0,100] including the low band.
    if (data.dynamicReadinessScore != null && Number.isFinite(data.dynamicReadinessScore)) {
      // eslint-disable-next-line no-param-reassign
      data.readinessScore = data.dynamicReadinessScore;
    } else if (data.isPresenceOnly) {
      // Task #126 — presence-only rows intentionally have no engine
      // readiness. Coerce to the floor (0) so storage invariants stay
      // happy without falsely advertising any heat.
      // eslint-disable-next-line no-param-reassign
      data.readinessScore = 0;
    } else {
      // ── Goldmaster Detection Ledger Phase 2 (RC1) ─────────────────────
      // The persisted live row MUST be driven by the dynamic HR alert
      // engine snapshot — not by the raw build/formation score. When no
      // dynamic readiness is available we refuse to write the row so the
      // ladder can never display (or grade) a fake readiness.
      console.warn(
        `[HR_RADAR_NO_DYNAMIC_READINESS] gameId=${data.gameId} playerId=${data.playerId} ` +
        `buildScoreOnly=${data.readinessScore} — refusing to persist as readiness truth`
      );
      return null;
    }
    try {
      const today = resolveMlbGameSessionDate(data.gameId);
      // ── Earliest-truth detection backfill (T002) ──────────────────────────
      // Prefer engine's earliest in-memory detection over current tick when
      // available AND strictly earlier. This stamps the row with when we
      // FIRST noticed the player, not when persistence finally fired.
      // ── Goldmaster Detection Ledger Phase 3 (RC3) ─────────────────────
      // Use the engine's first-detection truth when EITHER the inning is
      // earlier OR the inning is equal AND the timestamp is earlier than
      // the current persistence tick. The same-inning earlier-timestamp
      // case (e.g. detected B3 12:01:05, persisted B3 12:01:42) was being
      // missed by the inning-only comparison.
      const currentPersistMs = Date.now();
      const useFirstDetected =
        data.firstDetectedInning != null &&
        (
          data.firstDetectedInning < data.inning ||
          (
            data.firstDetectedInning === data.inning &&
            data.firstDetectedAtMs != null &&
            data.firstDetectedAtMs < currentPersistMs
          )
        );
      const persistInning = useFirstDetected ? data.firstDetectedInning! : data.inning;
      const persistHalf = useFirstDetected
        ? (data.firstDetectedHalf ?? data.half)
        : data.half;
      const halfLabel = persistHalf === "top" ? "T" : "B";
      const detectedLabel = `${halfLabel}${persistInning}`;
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

        // Task #126 — presence-only passes must NEVER mutate an existing
        // live row. A real PATH A–E row already exists; downgrading it to
        // monitor/0-readiness via a presence pass would be a regression.
        if (data.isPresenceOnly) {
          return alert;
        }

        // ── T003 immutability guardrail ──────────────────────────────────
        // detectedInning / detectedHalf / detectedLabel / detectedAt are
        // write-once at CREATE. The UPDATE set() below intentionally never
        // includes these fields. If the current tick disagrees with the
        // persisted detection inning, log loudly so any future code that
        // tries to mutate them is caught immediately. We never overwrite.
        if (alert.detectedInning != null && data.inning !== alert.detectedInning) {
          console.log(
            `[HR_RADAR_DETECTION_LOCKED] gameId=${data.gameId} playerId=${data.playerId} ` +
            `persistedDetected=${alert.detectedLabel} (${alert.detectedHalf}${alert.detectedInning}) ` +
            `currentTick=${data.half === "top" ? "T" : "B"}${data.inning} — preserving original`
          );
        }

        const prevScore = parseFloat(alert.currentReadinessScore ?? "0");
        const newScore = data.readinessScore;
        const prevPeak = parseFloat(alert.peakReadinessScore ?? "0");
        const peak = Math.max(prevPeak, newScore);
        const increased = newScore > prevScore;
        const increaseAmt = increased ? Math.round((newScore - prevScore) * 10) / 10 : null;
        const increaseLabel = increased ? `+${increaseAmt} in ${detectedLabel}` : alert.scoreIncreaseLabel;

        // ── Phase 4 — sticky-tier confusion fix ──────────────────────────
        // Live tier MUST follow the canonical engine stage (Phase 1–2). The
        // legacy sticky `bestTier` rule (max historical tier) is preserved
        // ONLY as audit data on stageContract.historicalBestStage; it must
        // never decide what the user sees on the live board. If the engine
        // has cooled the player off, the board cools off with it.
        const tierOrder: Record<string, number> = { monitor: 0, building: 1, strong: 2 };
        const liveTier = data.canonicalStage
          ? data.confidenceTier // already remapped from canonicalStage above
          : (tierOrder[data.confidenceTier] > tierOrder[alert.confidenceTier]
              ? data.confidenceTier
              : alert.confidenceTier);

        // Update stageContract: keep currentCanonicalStage live, but bump
        // historicalBestStage upward only when the new stage outranks it.
        const stageRankLocal: Record<string, number> = { closed: -1, watch: 0, cooling: 1, building: 1, attack: 2 };
        const prevDiag = (alert.diagnosticsSnapshot ?? {}) as Record<string, any>;
        const prevStageContract = (prevDiag.stageContract ?? {}) as Record<string, any>;
        const prevHistorical = prevStageContract.historicalBestStage ?? null;
        const prevCanonical = prevStageContract.currentCanonicalStage ?? null;
        const incomingCanonical = data.canonicalStage ?? null;
        const newHistorical =
          incomingCanonical && (!prevHistorical || stageRankLocal[incomingCanonical] > stageRankLocal[prevHistorical])
            ? incomingCanonical
            : prevHistorical ?? incomingCanonical;
        const mergedDiag = {
          ...(data.diagnosticsSnapshot as Record<string, unknown>),
          stageContract: {
            currentCanonicalStage: incomingCanonical,
            historicalBestStage: newHistorical,
            previousCanonicalStage: prevCanonical,
          },
        };

        await db.update(hrRadarAlerts)
          .set({
            currentReadinessScore: String(newScore),
            peakReadinessScore: String(peak),
            scoreIncreased: increased || alert.scoreIncreased,
            scoreIncreaseAmount: increaseAmt != null ? String(increaseAmt) : alert.scoreIncreaseAmount,
            scoreIncreaseInning: increased ? data.inning : alert.scoreIncreaseInning,
            scoreIncreaseHalf: increased ? data.half : alert.scoreIncreaseHalf,
            scoreIncreaseLabel: increaseLabel,
            confidenceTier: liveTier,
            signalState: data.signalState,
            triggerTags: data.triggerTags,
            summaryText: data.summaryText ?? alert.summaryText,
            contactSnapshot: data.contactSnapshot ?? alert.contactSnapshot,
            alertPath: data.alertPath ?? alert.alertPath,
            alertTier: data.alertTier ?? alert.alertTier,
            diagnosticsSnapshot: mergedDiag,
          })
          .where(eq(hrRadarAlerts.id, alert.id));

        // ── Phase 3 — auto-advance / auto-escalation ledger ──────────────
        // If the canonical stage changed at all (advance OR retreat), append
        // a stage_* event so the alert dispatch system has clean transition
        // points to fire on. Stage events are independent of score deltas.
        if (incomingCanonical && incomingCanonical !== prevCanonical) {
          const advanced = !prevCanonical
            ? incomingCanonical !== "watch" && incomingCanonical !== "closed"
            : stageRankLocal[incomingCanonical] > stageRankLocal[prevCanonical];
          const eventType = `stage_${incomingCanonical}`;
          console.log(
            `[HR_RADAR_STAGE_TRANSITION] playerId=${data.playerId} gameId=${data.gameId} ` +
            `${prevCanonical ?? "(new)"} -> ${incomingCanonical} ` +
            `${advanced ? "(advance)" : "(lateral/retreat)"} readiness=${newScore}`
          );
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
            alertId: alert.id,
            eventType,
            signalState: data.signalState,
            score: String(newScore),
            confidenceTier: liveTier,
            triggerTags: (data.triggerTags ?? []) as any,
            drivers: mergedDiag as any,
            detectedAt: new Date(),
            inning: data.inning,
            half: data.half,
            source: "engine",
          } as InsertHrRadarSignalEvent);
        }

        if (increased) {
          console.log(`[HR_RADAR_SCORE_INCREASE] playerId=${data.playerId} previousScore=${prevScore} newScore=${newScore} increaseAmount=${increaseAmt} increaseLabel=${increaseLabel}`);
          // Append escalation event so the strict matcher has chronological proof of pre-HR signal evolution
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
            alertId: alert.id,
            eventType: liveTier !== alert.confidenceTier ? "escalated" : "escalated",
            signalState: data.signalState,
            score: String(newScore),
            confidenceTier: liveTier,
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
            // Goldmaster Phase 9 — canonical "cooled_off" alias for the
            // downgrade event so downstream ledger consumers can key off the
            // canonical name without parsing legacy types.
            await this.appendHrRadarSignalEvent({
              sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
              alertId: alert.id,
              eventType: "cooled_off",
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
      // ── T001 diagnostic: persist gap visibility ───────────────────────────
      // Surface when persistence finally fired in a later inning than the
      // engine's first in-memory detection. Used to quantify the drift the
      // T002 backfill is now correcting.
      if (useFirstDetected) {
        console.log(
          `[HR_RADAR_PERSIST_GAP] gameId=${data.gameId} playerId=${data.playerId} ` +
          `engineFirstDetected=${data.firstDetectedHalf === "bottom" ? "B" : "T"}${data.firstDetectedInning} ` +
          `currentTick=${data.half === "top" ? "T" : "B"}${data.inning} ` +
          `→ stamping detectedLabel=${detectedLabel} (backfilled from engine)`
        );
      }
      const detectedAtForRow =
        useFirstDetected && data.firstDetectedAtMs != null
          ? new Date(data.firstDetectedAtMs)
          : nowDate;
      // Task #126 — presence-only rows leave the detection truth fields
      // NULL so the matcher's Branch 0 short-circuits to called_miss
      // instead of timestamp-rescuing them to called_hit.
      const isPresence = !!data.isPresenceOnly;
      const insertResult = await db.insert(hrRadarAlerts).values({
        id: alertId,
        sessionDate: today,
        gameId: data.gameId,
        playerId: data.playerId,
        playerName: data.playerName,
        team: data.team,
        opponent: data.opponent ?? null,
        detectedAt: detectedAtForRow,
        detectedInning: isPresence ? null : persistInning,
        detectedHalf: isPresence ? null : persistHalf,
        detectedLabel: isPresence ? null : detectedLabel,
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
        signalDetectedAt: isPresence ? null : detectedAtForRow,
        signalInning: isPresence ? null : persistInning,
        signalHalf: isPresence ? null : persistHalf,
        analyticsPersisted: false,
      }).onConflictDoNothing();
      if ((insertResult as any).rowCount === 0) {
        console.log(`[HR_RADAR_ALERT_UPSERT] RACE_DEDUP — alert already exists for sessionDate=${today} gameId=${data.gameId} playerId=${data.playerId}`);
        const raceExisting = await db.select().from(hrRadarAlerts)
          .where(eq(hrRadarAlerts.id, alertId)).limit(1);
        return raceExisting[0] ?? null;
      }

      console.log(`[HR_RADAR_ALERT_UPSERT] CREATE sessionDate=${today} gameId=${data.gameId} playerId=${data.playerId} detectedLabel=${isPresence ? "(presence-only)" : detectedLabel} initialReadinessScore=${data.readinessScore} canonicalStage=${data.canonicalStage ?? "(none)"}${isPresence ? " presenceOnly=true" : ""}`);
      // ── Goldmaster Detection Ledger Phase 4 (RC2) ─────────────────────
      // The CREATE-time ledger events MUST mirror the persisted row's
      // earliest-truth detection (detectedAtForRow / persistInning /
      // persistHalf). Writing nowDate / data.inning / data.half here was
      // letting the event ledger drift from the row, breaking the matcher
      // and making history appear to contradict the row.
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
        detectedAt: detectedAtForRow,
        inning: persistInning,
        half: persistHalf,
        source: "engine",
      } as InsertHrRadarSignalEvent);
      // Phase 3 — also emit the initial canonical stage as a transition event
      // so dispatch keys cleanly off stage_* events regardless of whether the
      // alert is brand new or being upgraded.
      // Goldmaster Phase 9 — emit canonical detection event when this is the
      // first time we've seen the player. `detected_watch` fires for every
      // new alert so the ledger has a single canonical "first sighting" type.
      await this.appendHrRadarSignalEvent({
        sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
        alertId,
        eventType: "detected_watch",
        signalState: data.signalState,
        score: String(data.readinessScore),
        confidenceTier: data.confidenceTier,
        triggerTags: data.triggerTags as any,
        drivers: data.diagnosticsSnapshot as any,
        detectedAt: detectedAtForRow,
        inning: persistInning,
        half: persistHalf,
        source: "engine",
      } as InsertHrRadarSignalEvent);
      if (data.canonicalStage && data.canonicalStage !== "watch") {
        await this.appendHrRadarSignalEvent({
          sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
          alertId,
          eventType: `stage_${data.canonicalStage}`,
          signalState: data.signalState,
          score: String(data.readinessScore),
          confidenceTier: data.confidenceTier,
          triggerTags: data.triggerTags as any,
          drivers: data.diagnosticsSnapshot as any,
          detectedAt: detectedAtForRow,
          inning: persistInning,
          half: persistHalf,
          source: "engine",
        } as InsertHrRadarSignalEvent);
        // ── Goldmaster Detection Ledger Phase 9 ─────────────────────────
        // When the alert is created already at a qualifying stage (building
        // or attack), also emit the canonical `qualified_detected` event so
        // the strict matcher has a clean qualifying-event marker without
        // having to interpret stage_* aliases.
        await this.appendHrRadarSignalEvent({
          sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
          alertId,
          eventType: "qualified_detected",
          signalState: data.signalState,
          score: String(data.readinessScore),
          confidenceTier: data.confidenceTier,
          triggerTags: data.triggerTags as any,
          drivers: data.diagnosticsSnapshot as any,
          detectedAt: detectedAtForRow,
          inning: persistInning,
          half: persistHalf,
          source: "engine",
        } as InsertHrRadarSignalEvent);
      }
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

      // Task #121 Step 2 — auditable signal-vs-hit timing trace.
      if (process.env.DEBUG_HR_RADAR === "true") {
        const sigIso = matchResult.signalDetectedAt ? new Date(matchResult.signalDetectedAt).toISOString() : "null";
        const hitIso = hrEndTimeMs ? new Date(hrEndTimeMs).toISOString() : "null";
        const grade = matchResult.matched && matchResult.matchedBeforeHr ? "called_hit"
          : matchResult.matched && matchResult.isLateSignal ? "late_signal"
          : matchResult.matched ? "matched_other"
          : "uncalled_hr";
        console.log(`[HR_GRADE_TRACE] playerId=${playerId} gameId=${gameId} signalAt=${sigIso} hitAt=${hitIso} signalLabel=${matchResult.signalHalf ?? ""}${matchResult.signalInning ?? ""} hitLabel=${hitLabelVal} matchMethod=${matchResult.matchMethod ?? "none"} grade=${grade}`);
      }

      if (matchResult.matched && matchResult.matchedBeforeHr) {
        // ── T005 leak-detection guardrail ────────────────────────────────
        // The matcher claims this alert preceded the HR. If the persisted
        // signalDetectedAt is somehow AT OR AFTER hrEndTimeMs, that's a
        // contradiction — the alert is being credited as called_hit despite
        // being late. Log loudly so we can trace it; do not block the write
        // (the matcher is authoritative) but make the leak visible.
        const sigMs = matchResult.signalDetectedAt
          ? new Date(matchResult.signalDetectedAt).getTime()
          : null;
        if (hrEndTimeMs && sigMs != null && sigMs >= hrEndTimeMs) {
          console.warn(
            `[HR_RADAR_LATE_SIGNAL_LEAK] playerId=${playerId} gameId=${gameId} ` +
            `signalAt=${new Date(sigMs).toISOString()} >= hrEndAt=${new Date(hrEndTimeMs).toISOString()} ` +
            `but matcher returned matchedBeforeHr=true. matchMethod=${matchResult.matchMethod}`
          );
        }
        // ── Goldmaster Detection Ledger Phase 6 (RC4) ────────────────────
        // Resolve ONLY the exact matched alert row by primary key. The old
        // sessionDate/gameId/playerId/status='live' update could mutate
        // unrelated live rows (e.g. a fresh row created after the matched
        // one). matchResult.alertId is the canonical row to grade.
        const result = matchResult.alertId
          ? await db.update(hrRadarAlerts)
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
                eq(hrRadarAlerts.id, matchResult.alertId),
                eq(hrRadarAlerts.status, "live"),
              ))
          : { rowCount: 0 } as any;
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
          // Goldmaster Phase 9 — canonical alias.
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId, playerId, team: "",
            alertId: matchResult.alertId,
            eventType: "resolved_called_hit",
            detectedAt: nowDate, inning: hitInningNum, half: hitHalfVal,
            source: "grader",
          } as InsertHrRadarSignalEvent);
        }
        return count;
      }

      // Late signal: alert exists but signal arrived at/after HR completed
      if (matchResult.matched && matchResult.isLateSignal) {
        // ── Goldmaster Detection Ledger Phase 6 (RC4) ──────────────────
        // Same exact-alertId constraint as called_hit above.
        const result = matchResult.alertId
          ? await db.update(hrRadarAlerts)
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
                eq(hrRadarAlerts.id, matchResult.alertId),
                eq(hrRadarAlerts.status, "live"),
              ))
          : { rowCount: 0 } as any;
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
          // Goldmaster Phase 9 — canonical alias.
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId, playerId, team: "",
            alertId: matchResult.alertId,
            eventType: "resolved_late_signal",
            detectedAt: nowDate, inning: hitInningNum, half: hitHalfVal,
            source: "grader",
          } as InsertHrRadarSignalEvent);
        }
        return count;
      }

      // Task #126 — presence-only resolution. The matcher returned
      // called_miss because the row never crossed PATH A-E. Mark the row
      // as resolved (status=hit so HR is recorded) with gradingStatus
      // called_miss + presence-only reason. userVisible=true so the user
      // sees a "Called miss" outcome in the dead bucket instead of a
      // hidden admin-only "Uncalled HR" row.
      if (matchResult.matched && matchResult.gradingStatus === "called_miss" && matchResult.alertId) {
        const result = await db.update(hrRadarAlerts)
          .set({
            status: "hit",
            hitInning: hitInningNum,
            hitHalf: hitHalfVal,
            hitLabel: hitLabelVal,
            hitDetectedAt: hrEndTimeMs ? new Date(hrEndTimeMs) : nowDate,
            resolvedAt: nowDate,
            gradingStatus: "called_miss",
            gradingReason: matchResult.gradingReason,
            matchedBeforeHr: false,
            fallbackCreated: false,
            userVisible: true,
            matchMethod: matchResult.matchMethod,
          })
          .where(and(
            eq(hrRadarAlerts.id, matchResult.alertId),
            eq(hrRadarAlerts.status, "live"),
          ));
        const count = (result as any).rowCount ?? 0;
        if (count > 0) {
          console.log(`[HR_RADAR_PRESENCE_MISS] playerId=${playerId} gameId=${gameId} hitLabel=${hitLabelVal} reason="${matchResult.gradingReason}"`);
          console.log(`[HR_LEDGER_GRADE] outcome=called_miss sessionDate=${today} gameId=${gameId} playerId=${playerId} hitInning=${hitInningNum}${hitHalfVal} alertId=${matchResult.alertId} matchMethod=${matchResult.matchMethod} reason=presence_only`);
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId, playerId, team: "",
            alertId: matchResult.alertId,
            eventType: "resolved_called_miss",
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

      // ── Phase 5 — early-HR exemption ───────────────────────────────────
      // 1st-inning HRs with no engine activity in the game get classified as
      // `early_hr_no_window` (separate bucket) instead of polluting uncalled.
      const isFirstInning = (data.inning ?? 0) <= 1;
      let earlyExempt = false;
      if (isFirstInning) {
        const earlySignals = await db.select().from(hrRadarSignalEvents)
          .where(and(
            eq(hrRadarSignalEvents.gameId, data.gameId),
            eq(hrRadarSignalEvents.playerId, data.playerId),
          ))
          .limit(1);
        if (earlySignals.length === 0) earlyExempt = true;
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
        triggerTags: earlyExempt ? ["auto_graded", "early_hr_no_window"] : ["auto_graded"],
        summaryText: earlyExempt
          ? `HR confirmed ${data.hitLabel} (early-inning HR — no realistic pre-call window)`
          : `HR confirmed ${data.hitLabel} (uncalled — no pre-HR engine signal)`,
        status: "hit",
        hitInning: data.inning,
        hitHalf: halfLabel,
        hitLabel: data.hitLabel,
        hitDetectedAt: nowDate,
        resolvedAt: nowDate,
        gradingStatus: earlyExempt ? "early_hr_no_window" : "uncalled_hr",
        gradingReason: earlyExempt
          ? "first-inning HR with no realistic pre-signal window — exempt from uncalled-miss bucket"
          : "no canonical hr_radar_alert existed at time of HR resolution — admin-only analytics row",
        matchedBeforeHr: false,
        fallbackCreated: true,
        userVisible: false,
        matchMethod: "post_hr_fallback",
        analyticsPersisted: false,
      });
      if (earlyExempt) {
        console.log(`[HR_RADAR_EARLY_HR_NO_WINDOW] (admin-only row created) playerId=${data.playerId} player=${data.playerName} gameId=${data.gameId} hitLabel=${data.hitLabel}`);
      } else {
        console.log(`[HR_RADAR_UNCALLED] (admin-only row created) playerId=${data.playerId} player=${data.playerName} gameId=${data.gameId} hitLabel=${data.hitLabel}`);
      }
      // Goldmaster Phase 9 — canonical resolved_* event for the ledger.
      try {
        await this.appendHrRadarSignalEvent({
          sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
          alertId,
          eventType: earlyExempt ? "resolved_early_window_hr" : "resolved_uncalled_hr",
          detectedAt: nowDate,
          inning: data.inning,
          half: halfLabel,
          source: "grader",
        } as InsertHrRadarSignalEvent);
      } catch { /* non-fatal */ }
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
        // Goldmaster Phase 9 — canonical resolved_miss alias.
        try {
          const resolvedRows = await db.select({ id: hrRadarAlerts.id })
            .from(hrRadarAlerts)
            .where(and(
              eq(hrRadarAlerts.sessionDate, today),
              eq(hrRadarAlerts.gameId, gameId),
              eq(hrRadarAlerts.playerId, playerId),
            ))
            .limit(1);
          if (resolvedRows.length > 0) {
            await this.appendHrRadarSignalEvent({
              sessionDate: today, gameId, playerId, team: "",
              alertId: resolvedRows[0].id,
              eventType: "resolved_miss",
              detectedAt: new Date(),
              inning: 0, half: "F",
              source: "grader",
            } as InsertHrRadarSignalEvent);
          }
        } catch { /* non-fatal */ }
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
          // Task #122: the primary called-vs-late grading happens in
          // matchHrRadarAlertToHrEvent (which has the HR endTime) and now
          // includes a timestamp-rescue branch. The reconcile fallback only
          // runs at game-final and lacks the HR endTime, so it stays on the
          // existing inning/half comparison.
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
          // Goldmaster Phase 9 — canonical resolved_miss alias.
          await this.appendHrRadarSignalEvent({
            sessionDate: today, gameId, playerId: alert.playerId, team: alert.team ?? "",
            alertId: alert.id,
            eventType: "resolved_miss",
            detectedAt: nowDate,
            inning: 0, half: "F",
            source: "grader",
          } as InsertHrRadarSignalEvent);
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
  /**
   * Task #121 Step 1 — restart hydration source.
   * Returns the frozen detection-timing fields for every persisted alert in
   * a game so the orchestrator can re-seed the in-memory engine state after
   * a process boot. Read-only; never modifies any row.
   */
  async getHrRadarDetectionsForGame(gameId: string): Promise<Array<{
    playerId: string;
    playerName: string;
    detectedInning: number | null;
    detectedHalf: string | null;
    detectedAt: Date | null;
  }>> {
    const rows = await db.select({
      playerId: hrRadarAlerts.playerId,
      playerName: hrRadarAlerts.playerName,
      detectedInning: hrRadarAlerts.detectedInning,
      detectedHalf: hrRadarAlerts.detectedHalf,
      detectedAt: hrRadarAlerts.signalDetectedAt,
      fallbackDetectedAt: hrRadarAlerts.detectedAt,
    }).from(hrRadarAlerts).where(eq(hrRadarAlerts.gameId, gameId));
    return rows.map(r => ({
      playerId: r.playerId,
      playerName: r.playerName,
      detectedInning: r.detectedInning ?? null,
      detectedHalf: r.detectedHalf ?? null,
      detectedAt: r.detectedAt ?? r.fallbackDetectedAt ?? null,
    }));
  }

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

    // Task #121 Step 5 — pre-fetch Statcast (OnlyHomers) for batters with a
    // resolved called_hit on this session date, so the cashed cards can render
    // EV / distance / launch angle / pitch type without a per-card lookup.
    const cashedNames = Array.from(new Set(
      rows
        .filter(r => r.gradingStatus === "called_hit" || r.status === "hit")
        .map(r => r.playerName)
    ));
    // Task #121 Step 4 — pull current inning per game (lazy dynamic import
    // to avoid circular: dataPullService imports storage indirectly). Used
    // by the urgency line so "expires after T8" / late-inning copy fires
    // based on game-state, not the (frozen) detection inning.
    const currentInningByGameId = new Map<string, number>();
    try {
      const { mlbGameCache } = await import("./mlb/dataPullService");
      const gameStates = (mlbGameCache?.gameState ?? {}) as Record<string, any>;
      for (const gid of Object.keys(gameStates)) {
        const inn = gameStates[gid]?.inning;
        if (typeof inn === "number" && inn > 0) currentInningByGameId.set(gid, inn);
      }
    } catch {
      // best-effort — urgency falls back to detected inning if missing.
    }

    const ohStatsByName = new Map<string, { ev: number | null; la: number | null; dist: number | null; pitch: string | null }>();
    if (cashedNames.length > 0) {
      try {
        const ohRows = await db.select().from(hrOutcomes)
          .where(and(
            inArray(hrOutcomes.batterName, cashedNames),
            eq(hrOutcomes.gameDate, targetDate),
          ));
        for (const oh of ohRows) {
          if (ohStatsByName.has(oh.batterName)) continue;
          ohStatsByName.set(oh.batterName, {
            ev: oh.exitVelocity != null ? parseFloat(String(oh.exitVelocity)) : null,
            la: oh.launchAngle != null ? parseFloat(String(oh.launchAngle)) : null,
            dist: oh.distance != null ? parseFloat(String(oh.distance)) : null,
            pitch: oh.pitchType ?? null,
          });
        }
      } catch (err: any) {
        console.warn(`[HR_RADAR_LADDER] OnlyHomers stat hydration failed: ${err.message}`);
      }
    }

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

      // ── Goldmaster Phase 1, 2 — canonical stage + status + outcome ────────
      const diag = (r.diagnosticsSnapshot ?? {}) as Record<string, any>;
      const stageContractRow = (diag.stageContract ?? {}) as Record<string, any>;
      const abContextRow = (diag.abContext ?? {}) as Record<string, any>;

      const canonicalStage: HrRadarStageLabel | null = (() => {
        const s = stageContractRow.currentCanonicalStage;
        if (s === "watch" || s === "building" || s === "attack" || s === "cooling" || s === "closed") return s;
        return null;
      })();

      // currentStatus: resolved iff the row is no longer live (status==="hit"
      // or grading produced a final outcome). Otherwise live.
      const isResolved = r.status === "hit" || (grading !== "active" && grading != null);
      const currentStatus: "live" | "resolved" = isResolved ? "resolved" : "live";

      // outcome: map DB grading → canonical user-facing outcome label.
      const outcome: HrRadarOutcomeLabel = (() => {
        if (currentStatus === "live") return "pending";
        switch (grading) {
          case "called_hit": return "called_hit";
          case "called_miss": return "miss";
          case "uncalled_hr": return "uncalled_hr";
          case "late_signal": return "late_signal";
          // Phase 4: split early-window HR from standard misses.
          case "early_hr_no_window":
          case "early_window_hr":
            return "early_window_hr";
          default: return "pending";
        }
      })();

      // Determine target section. For LIVE rows we now bucket off the
      // canonical engine stage (Phase 2). Resolved rows go to cashed/dead by
      // outcome.
      let section: keyof typeof sections;
      if (currentStatus === "resolved") {
        section = outcome === "called_hit" ? "cashed" : "dead";
      } else if (canonicalStage) {
        // Canonical stage drives live bucketing. Cooling demotes to watch
        // (we don't want to keep advertising "Attack" after the engine cooled).
        section =
          canonicalStage === "attack" ? "attackNow"
          : canonicalStage === "building" ? "building"
          : "watch";
      } else {
        // Legacy fallback: row was created before canonical stage was wired.
        // Use the previous tier+readiness floors so old rows still bucket
        // sensibly.
        const tier = (r.confidenceTier ?? "monitor").toLowerCase();
        const state = (r.signalState ?? "watching").toLowerCase();
        const readiness = parseFloat(String(r.currentReadinessScore ?? r.peakReadinessScore ?? 0)) || 0;
        const ATTACK_FLOOR = 72;
        const BUILDING_FLOOR = 55;
        if ((tier === "strong" || state === "actionable") && readiness >= ATTACK_FLOOR) {
          section = "attackNow";
        } else if ((tier === "building" || state === "live" || tier === "strong" || state === "actionable") && readiness >= BUILDING_FLOOR) {
          section = "building";
        } else {
          section = "watch";
        }
      }

      // currentStage label always reflects what the user should see — for
      // resolved rows we lock it to the canonical stage at resolution time
      // (or "closed" if missing).
      const currentStage: HrRadarStageLabel = (() => {
        if (currentStatus === "resolved") {
          return outcome === "called_hit" ? "closed"
            : outcome === "miss" || outcome === "uncalled_hr" || outcome === "early_window_hr" || outcome === "late_signal" ? "closed"
            : "closed";
        }
        if (canonicalStage) return canonicalStage;
        // Fallback for legacy live rows
        return section === "attackNow" ? "attack" : section === "building" ? "building" : "watch";
      })();

      const plateAppearancesTracked: number | null =
        typeof abContextRow.plateAppearancesTracked === "number" ? abContextRow.plateAppearancesTracked : null;
      const hasLiveABContext: boolean =
        abContextRow.hasLiveABContext === true ? true
          : (plateAppearancesTracked != null && plateAppearancesTracked > 0);

      // Build user-facing reasons (humanized, jargon stripped) and admin
      // reasons (raw engine strings preserved for debug view).
      const { userReasons, adminReasons } = this.buildHrRadarReasonSets(r, {
        plateAppearancesTracked,
        hasLiveABContext,
      });
      // Plain-English summary appropriate for the current stage/outcome
      // (Goldmaster Phase 5 + 6).
      const summary = this.buildHrRadarSummary({
        currentStage,
        currentStatus,
        outcome,
        plateAppearancesTracked,
        hasLiveABContext,
        detectedInning: r.signalInning ?? r.detectedInning ?? null,
        detectedHalf: r.signalHalf ?? r.detectedHalf ?? null,
        hitInning: r.hitInning ?? null,
        hitHalf: r.hitHalf ?? null,
      });

      // ── Goldmaster Phase 1 — canonical 0-100 wire scale numbers ────────────
      // The CREATE/UPDATE write path normalizes all readiness columns to the
      // canonical 0-100 scale (see createOrUpdateHrRadarAlert L2820-2829).
      // Therefore parsing them here yields true 0-100 numbers — never divide
      // by 10 in the response. Engine raw build score and conversion
      // probability are surfaced separately for admin/debug ONLY.
      const initialReadinessScore = r.initialReadinessScore != null ? parseFloat(r.initialReadinessScore) : null;
      const currentReadinessScore = r.currentReadinessScore != null ? parseFloat(r.currentReadinessScore) : null;
      const peakReadinessScore = r.peakReadinessScore != null ? parseFloat(r.peakReadinessScore) : null;
      const scoreContractRow = (diag.scoreContract ?? {}) as Record<string, any>;
      const buildScore = typeof scoreContractRow.buildScore === "number" ? scoreContractRow.buildScore : null;
      const conversionProbability = typeof scoreContractRow.conversionProbability === "number"
        ? scoreContractRow.conversionProbability
        : (typeof scoreContractRow.conversionProbabilityRaw === "number" ? scoreContractRow.conversionProbabilityRaw : null);

      // ── Goldmaster Phase 4-7 — canonical stage drives explanation copy ─────
      // stageExplanation = the same copy buildHrRadarSummary returns for live
      // rows. headlineReason = first user-safe reason (or null if none).
      // supportingReasons = up to 3 additional user-safe reasons. Pregame-only
      // (zero-AB / no live context) rows produce a pregame headline and no
      // contact-derived reasons (those reasons would imply live AB evidence
      // that doesn't exist yet).
      const isPregameOnlyEntry = !hasLiveABContext && (plateAppearancesTracked ?? 0) === 0;
      const liveContactReasons = isPregameOnlyEntry ? [] : userReasons;
      const headlineReason: string | null =
        currentStatus === "live" && isPregameOnlyEntry
          ? "Pregame context only — no live at-bats yet"
          : (liveContactReasons[0] ?? null);
      const supportingReasons: string[] = liveContactReasons
        .slice(headlineReason && headlineReason === liveContactReasons[0] ? 1 : 0, 4)
        .slice(0, 3);
      const stageExplanation: string = summary;

      // ── Goldmaster RESTORE Phase 1+2 — 10-point user-facing score + heating-up meter
      // Internal storage stays on canonical 0-100 (audit-friendly). The wire
      // additionally exposes a 0.0-10.0 score with one decimal as the
      // user-facing primary number, plus heating-up momentum metadata
      // derived from initial → current → peak deltas. The 0-100 fields
      // remain available for admin/debug + harness invariants.
      // Map canonical 0-100 readiness → user-facing 0.0-10.0 with one decimal.
      // Math.round(n)/10 yields exactly one decimal (e.g. 67.4 → 6.7), avoiding
      // floating-point artifacts of n/10 then *10/10 patterns.
      const round1 = (n: number | null): number | null =>
        n == null ? null : Math.round(Math.max(0, Math.min(100, n))) / 10;
      const initialSignalScore10 = round1(initialReadinessScore);
      const currentSignalScore10 = round1(currentReadinessScore);
      const peakSignalScore10 = round1(peakReadinessScore);
      const deltaFromInitial10 =
        currentSignalScore10 != null && initialSignalScore10 != null
          ? Math.round((currentSignalScore10 - initialSignalScore10) * 10) / 10
          : null;
      const deltaFromPeak10 =
        currentSignalScore10 != null && peakSignalScore10 != null
          ? Math.round((currentSignalScore10 - peakSignalScore10) * 10) / 10
          : null;
      // Momentum heuristics on the 10-point scale.
      // - heating_up: current is at/near peak AND meaningfully above initial.
      // - cooling_off: current is meaningfully below peak after a real climb.
      // - holding_strong: current is at/near peak but climb from initial is small.
      // - flat: insufficient movement either way.
      let momentumLabel: "heating_up" | "holding_strong" | "cooling_off" | "flat" = "flat";
      let isHeatingUp = false;
      let isCoolingOff = false;
      if (
        currentSignalScore10 != null &&
        peakSignalScore10 != null &&
        initialSignalScore10 != null &&
        currentStatus === "live"
      ) {
        const climb = currentSignalScore10 - initialSignalScore10;
        const dropFromPeak = peakSignalScore10 - currentSignalScore10;
        const peakClimb = peakSignalScore10 - initialSignalScore10;
        if (dropFromPeak <= 0.4 && climb >= 0.5) {
          momentumLabel = "heating_up";
          isHeatingUp = true;
        } else if (dropFromPeak >= 1.0 && peakClimb >= 0.5) {
          momentumLabel = "cooling_off";
          isCoolingOff = true;
        } else if (dropFromPeak <= 0.4 && currentSignalScore10 >= 6.0) {
          momentumLabel = "holding_strong";
        } else {
          momentumLabel = "flat";
        }
      }

      // Task #121 Step 4 — surface remaining-PA + current inning so the live
      // card can render an urgency line ("~N PA left", "expires after T8").
      const hrConvDiag = (diag.hrConversion ?? {}) as Record<string, any>;
      const remainingPAExpectation: number | null =
        typeof hrConvDiag.expectedRemainingPA === "number" ? hrConvDiag.expectedRemainingPA : null;
      const currentInning: number | null = currentInningByGameId.get(r.gameId) ?? null;
      const ohStats = ohStatsByName.get(r.playerName) ?? null;
      const onlyHomersVerified = ohStats != null;

      const entry: HrRadarLadderEntry = {
        playerId: r.playerId,
        playerName: r.playerName,
        team: r.team,
        gameId: r.gameId,
        currentStage,
        currentStatus,
        outcome,
        plateAppearancesTracked,
        hasLiveABContext,
        userReasons: liveContactReasons,
        adminReasons,
        summary,
        // Canonical 0-100 readiness fields (INTERNAL — admin/debug + harness).
        initialReadinessScore,
        currentReadinessScore,
        peakReadinessScore,
        buildScore,
        conversionProbability,
        // ── Goldmaster RESTORE — 10-point USER-FACING signal score (0.0-10.0)
        initialSignalScore10,
        currentSignalScore10,
        peakSignalScore10,
        deltaFromInitial10,
        deltaFromPeak10,
        isHeatingUp,
        isCoolingOff,
        momentumLabel,
        // Frozen detection vs HR-event truth (distinct fields, never overloaded).
        detectedLabel: r.detectedLabel ?? null,
        hitLabel: r.hitLabel ?? null,
        // Canonical stage-driven copy.
        stageExplanation,
        headlineReason,
        supportingReasons,
        state: r.signalState ?? null,
        confidenceTier: r.confidenceTier ?? null,
        peakScore: peakReadinessScore,
        signalStrengthScore: currentReadinessScore,
        whyNowReasons: liveContactReasons,
        nextAbEstimate: isPregameOnlyEntry ? null : this.buildNextAbEstimate(r),
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
        // Task #121 Step 4+5 — urgency + Statcast surfacing.
        remainingPAExpectation,
        currentInning,
        onlyHomersVerified,
        ohExitVelocity: ohStats?.ev ?? null,
        ohLaunchAngle: ohStats?.la ?? null,
        ohDistance: ohStats?.dist ?? null,
        ohPitchType: ohStats?.pitch ?? null,
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

  /**
   * Goldmaster Phase 6 — translate engine internals into product language.
   * Returns:
   *  - userReasons: strings safe for default user view (PATH_*, raw debug
   *    abbreviations, internal state machine labels stripped).
   *  - adminReasons: full raw strings preserved for admin/debug rendering.
   */
  public buildHrRadarReasonSets(
    r: HrRadarAlert,
    ctx: { plateAppearancesTracked: number | null; hasLiveABContext: boolean },
  ): { userReasons: string[]; adminReasons: string[] } {
    const tags = (r.triggerTags ?? []).filter(t => typeof t === "string" && t.length > 0);

    // Pattern that flags a string as raw engine jargon. Anchored cases catch
    // tag-style strings starting with engine prefixes; unanchored token cases
    // catch inline debug tokens that leak inside otherwise human-looking
    // sentences (e.g. "LEI ESCALATION:HrShaped1 Score9.99 Lei").
    const ENGINE_JARGON_PREFIX_RE = /^(PATH[_ ]?[A-Z0-9_]+|WATCH:|BUILD:|FORM:|FORMATION|PRE[_ ]HR[_ ]DANGER|LEI[_ ]?[A-Z]+|LEI\b)/i;
    const ENGINE_JARGON_TOKEN_RE = /(HrShaped\d*|BsZ[-+]?\d|Danger\d|Profile\d|Score\d+(\.\d+)?|Conv\s+\d+%|PATH[_ ]?[A-Z0-9_]+|LEI ESCALATION)/i;
    const looksLikeJargon = (s: string): boolean => {
      const t = s.trim();
      return ENGINE_JARGON_PREFIX_RE.test(t) || ENGINE_JARGON_TOKEN_RE.test(t);
    };

    const userReasons: string[] = [];
    const adminReasons: string[] = [];

    for (const t of tags.slice(0, 6)) {
      const human = this.humanizeHrRadarTag(t);
      adminReasons.push(t);
      if (!looksLikeJargon(t) && !looksLikeJargon(human)) {
        userReasons.push(human);
      }
    }

    // summaryText: keep on admin side always; only promote to user side if
    // it doesn't read like debug output.
    if (r.summaryText) {
      adminReasons.push(r.summaryText);
      if (!looksLikeJargon(r.summaryText) && userReasons.length < 5) {
        // Strip any inline engine tokens that slipped into a summary string.
        const cleaned = r.summaryText
          .replace(/PATH[_ ]?[A-Z0-9_]+:?\s*[A-Za-z+]+/g, "")
          .replace(/Score\d+(\.\d+)?/g, "")
          .replace(/Conv\s+\d+%/g, "")
          .replace(/\s{2,}/g, " ")
          .trim();
        if (cleaned.length > 0 && !looksLikeJargon(cleaned)) userReasons.push(cleaned);
      }
    }

    if (r.scoreIncreased && r.scoreIncreaseLabel) {
      const label = `Signal climbed in ${r.scoreIncreaseLabel}`;
      adminReasons.push(`scoreClimb=${r.scoreIncreaseLabel}`);
      if (userReasons.length < 5) userReasons.push(label);
    }

    // 0-AB rows: explicit pregame indicator so the user never thinks live
    // contact has been confirmed when it hasn't.
    if (!ctx.hasLiveABContext && (ctx.plateAppearancesTracked ?? 0) === 0) {
      userReasons.unshift("No at-bats yet — pregame form, matchup, and park context only");
    }

    return {
      userReasons: Array.from(new Set(userReasons)).slice(0, 5),
      adminReasons: Array.from(new Set(adminReasons)).slice(0, 8),
    };
  }

  /**
   * Goldmaster Phase 5 + 6 — single plain-English summary appropriate for the
   * row's current stage/outcome. Live rows describe what the engine sees;
   * resolved rows describe what actually happened. They MUST never blend.
   */
  public buildHrRadarSummary(p: {
    currentStage: HrRadarStageLabel;
    currentStatus: "live" | "resolved";
    outcome: HrRadarOutcomeLabel;
    plateAppearancesTracked: number | null;
    hasLiveABContext: boolean;
    detectedInning: number | null;
    detectedHalf: string | null;
    hitInning: number | null;
    hitHalf: string | null;
  }): string {
    const fmtInning = (inn: number | null, half: string | null): string | null => {
      if (inn == null) return null;
      const h = (half ?? "").toLowerCase();
      const prefix = h.startsWith("t") || h === "top" ? "T" : h.startsWith("b") || h === "bottom" ? "B" : "";
      return prefix ? `${prefix}${inn}` : `inning ${inn}`;
    };
    const detected = fmtInning(p.detectedInning, p.detectedHalf);
    const hit = fmtInning(p.hitInning, p.hitHalf);

    if (p.currentStatus === "resolved") {
      switch (p.outcome) {
        case "called_hit":
          return `HR confirmed${hit ? ` ${hit}` : ""}${detected ? ` after a called signal at ${detected}` : ""}.`;
        case "miss":
          return `Signal was tracked${detected ? ` from ${detected}` : ""} and did not convert before the window closed.`;
        case "early_window_hr":
          return `HR occurred${hit ? ` ${hit}` : " in the 1st inning"} before a realistic pre-signal window existed.`;
        case "uncalled_hr":
          return `HR occurred${hit ? ` ${hit}` : ""} without a qualifying pre-HR engine signal.`;
        case "late_signal":
          return `Engine signal arrived after the HR had already happened${hit ? ` (${hit})` : ""}.`;
        case "expired":
          return `Signal expired without converting${detected ? ` (tracked from ${detected})` : ""}.`;
        default:
          return `Signal resolved${detected ? ` (tracked from ${detected})` : ""}.`;
      }
    }

    // Live mode — describe the current stage in product language only.
    if (!p.hasLiveABContext && (p.plateAppearancesTracked ?? 0) === 0) {
      return "No at-bats yet. Tracking pregame power profile, matchup, and park context. Live contact data will appear after the first plate appearance.";
    }
    switch (p.currentStage) {
      case "watch":
        return "Tracking. Pattern is forming but not yet at the building threshold.";
      case "building":
        return "The HR pattern is building. One more quality contact or worsening pitcher context could move this into Attack.";
      case "attack":
        return "Attack window is open. Repeated dangerous contact plus favorable context are now aligned.";
      case "cooling":
        return "Engine is cooling off. Watching for fresh contact to re-engage the signal.";
      case "closed":
        return "Signal has closed for this game.";
      default:
        return "Tracking.";
    }
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

  public buildNextAbEstimate(r: HrRadarAlert): string | null {
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

/**
 * Goldmaster canonical HR Radar entity — Phase 1 of the entity-model fix.
 * `currentStage` is the live engine stage; `outcome` is the final grading
 * result. They MUST never be merged into a single ambiguous "state" field.
 */
export type HrRadarStageLabel = "watch" | "building" | "attack" | "cooling" | "closed";
export type HrRadarOutcomeLabel =
  | "pending"
  | "called_hit"
  | "miss"
  | "early_window_hr"
  | "uncalled_hr"
  | "late_signal"
  | "expired";

export interface HrRadarLadderEntry {
  playerId: string;
  playerName: string;
  team: string;
  gameId: string;
  /** Live engine stage (Goldmaster Phase 1, 2). Source of truth for live rows. */
  currentStage: HrRadarStageLabel;
  /** "live" while game/alert is still active, "resolved" once outcome is final. */
  currentStatus: "live" | "resolved";
  /** Final grading outcome. "pending" while currentStatus === "live". */
  outcome: HrRadarOutcomeLabel;
  /** Number of plate appearances actually observed by the engine. 0 = pregame-only. */
  plateAppearancesTracked: number | null;
  /** True iff at least one live AB contact has been logged for this player/game. */
  hasLiveABContext: boolean;
  /** Plain-English reasons for users (engine jargon stripped). */
  userReasons: string[];
  /** Raw engine diagnostic strings — admin/debug view only, never default user view. */
  adminReasons: string[];
  /** One-sentence plain-English summary appropriate for the current stage/outcome. */
  summary: string;

  // ── Goldmaster Phase 1 — canonical 0-100 wire scale. ───────────────────────
  /** Initial readiness on the canonical 0-100 scale (write-once at create). */
  initialReadinessScore: number | null;
  /** Current readiness on the canonical 0-100 scale (updated each tick). */
  currentReadinessScore: number | null;
  /** Peak readiness on the canonical 0-100 scale (monotonic). */
  peakReadinessScore: number | null;
  /** Engine raw build score (0-10). Admin/debug only — never blend with readiness. */
  buildScore: number | null;
  /** Calibrated conversion probability (0-1). Admin/debug only. */
  conversionProbability: number | null;

  // ── Goldmaster RESTORE — 10-point USER-FACING signal score (0.0-10.0). ─────
  /** Initial signal score on the user-facing 0.0-10.0 scale (one decimal). */
  initialSignalScore10: number | null;
  /** Current signal score on the user-facing 0.0-10.0 scale (one decimal). */
  currentSignalScore10: number | null;
  /** Peak signal score on the user-facing 0.0-10.0 scale (one decimal). */
  peakSignalScore10: number | null;
  /** Current minus initial on the 10-point scale (positive = climbing). */
  deltaFromInitial10: number | null;
  /** Current minus peak on the 10-point scale (negative or zero). */
  deltaFromPeak10: number | null;
  /** True iff the signal is at/near peak with a meaningful climb from initial. */
  isHeatingUp: boolean;
  /** True iff the signal has dropped meaningfully from a real peak. */
  isCoolingOff: boolean;
  /** User-facing momentum bucket. */
  momentumLabel: "heating_up" | "holding_strong" | "cooling_off" | "flat";

  // ── Goldmaster Phase 2+3 — frozen detection vs HR-event truth. ─────────────
  /** Frozen first-detection inning label (e.g. "T3"). Never overwritten. */
  detectedLabel: string | null;
  /** Inning the actual HR landed in (null until HR confirmed). */
  hitLabel: string | null;

  // ── Goldmaster Phase 4-7 — canonical stage drives copy. ────────────────────
  /** Plain-English explanation derived from canonical stage + AB context. */
  stageExplanation: string;
  /** Single most important user-facing reason ("why now") for live rows. */
  headlineReason: string | null;
  /** Up to 3 short supporting reasons rendered as bullets under the headline. */
  supportingReasons: string[];

  // ── Legacy fields preserved for backwards compat. ──────────────────────────
  /** @deprecated use currentStage. Internal signal state string. */
  state: string | null;
  /** @deprecated use currentStage. Internal confidence tier string. */
  confidenceTier: string | null;
  /** @deprecated use peakReadinessScore (canonical 0-100). Mirrors peakReadinessScore. */
  peakScore: number | null;
  /** @deprecated use currentReadinessScore (canonical 0-100). Mirrors currentReadinessScore. */
  signalStrengthScore: number | null;
  /** @deprecated use userReasons (default) or adminReasons (debug). */
  whyNowReasons: string[];
  nextAbEstimate: string | null;
  detectedInning: number | null;
  detectedHalf: string | null;
  hitInning: number | null;
  hitHalf: string | null;
  /** Raw grading status string from DB. Use `outcome` for user-facing labels. */
  outcomeStatus: string; // active | called_hit | called_miss | uncalled_hr | late_signal | early_hr_no_window
  userVisible: boolean;
  signalDetectedAt: Date | null;
  hitDetectedAt: Date | null;
  resolvedAt: Date | null;
  alertPath: string | null;
  // Task #121 Step 4 — remaining plate-appearance expectation (engine).
  remainingPAExpectation: number | null;
  // Task #121 Step 4 — live game-state inning (NOT detection inning) for
  // late-inning urgency copy on the card.
  currentInning: number | null;
  // Task #121 Step 5 — Statcast verification + stats from OnlyHomers.
  onlyHomersVerified: boolean;
  ohExitVelocity: number | null;
  ohLaunchAngle: number | null;
  ohDistance: number | null;
  ohPitchType: string | null;
}

export const storage = new DatabaseStorage();

// Phase 8: Detection coverage analytics — added as a prototype patch on the
// DatabaseStorage instance so we don't reshuffle the giant class body. Returns
// counts of canonical outcomes bucketed by tier and inning over the last
// `daysBack` session dates.
export interface HrRadarCoverageMetrics {
  daysBack: number;
  totals: {
    activeOrUnresolved: number;
    calledHit: number;
    calledMiss: number;
    uncalledHr: number;
    lateSignal: number;
    postHrFallback: number;
  };
  byTier: Record<string, { calledHit: number; calledMiss: number; uncalledHr: number; lateSignal: number }>;
  byInning: Record<number, { calledHit: number; calledMiss: number; uncalledHr: number; lateSignal: number }>;
  detectionRate: number; // calledHit / (calledHit + uncalledHr + lateSignal)
  hitRate: number;       // calledHit / (calledHit + calledMiss)
}

(DatabaseStorage.prototype as any).getHrRadarCoverageMetrics = async function (daysBack: number = 7): Promise<HrRadarCoverageMetrics> {
  const cutoff = daysAgoET(Math.max(0, Math.min(60, Math.floor(daysBack))));
  const rows = await db.select().from(hrRadarAlerts)
    .where(gte(hrRadarAlerts.sessionDate, cutoff));

  const totals = { activeOrUnresolved: 0, calledHit: 0, calledMiss: 0, uncalledHr: 0, lateSignal: 0, postHrFallback: 0 };
  const byTier: Record<string, { calledHit: number; calledMiss: number; uncalledHr: number; lateSignal: number }> = {};
  const byInning: Record<number, { calledHit: number; calledMiss: number; uncalledHr: number; lateSignal: number }> = {};
  const ensureTier = (t: string) => byTier[t] ??= { calledHit: 0, calledMiss: 0, uncalledHr: 0, lateSignal: 0 };
  const ensureInning = (n: number) => byInning[n] ??= { calledHit: 0, calledMiss: 0, uncalledHr: 0, lateSignal: 0 };

  for (const r of rows) {
    const grading = r.gradingStatus ?? "active";
    const tier = (r.confidenceTier ?? "monitor").toLowerCase();
    const inning = r.signalInning ?? r.detectedInning ?? r.hitInning ?? 0;
    if ((r as any).fallbackCreated) totals.postHrFallback++;
    switch (grading) {
      case "called_hit":  totals.calledHit++; ensureTier(tier).calledHit++; ensureInning(inning).calledHit++; break;
      case "called_miss": totals.calledMiss++; ensureTier(tier).calledMiss++; ensureInning(inning).calledMiss++; break;
      case "uncalled_hr": totals.uncalledHr++; ensureTier(tier).uncalledHr++; ensureInning(inning).uncalledHr++; break;
      case "late_signal": totals.lateSignal++; ensureTier(tier).lateSignal++; ensureInning(inning).lateSignal++; break;
      default:            totals.activeOrUnresolved++;
    }
  }

  const detectionDenom = totals.calledHit + totals.uncalledHr + totals.lateSignal;
  const hitDenom = totals.calledHit + totals.calledMiss;
  return {
    daysBack,
    totals,
    byTier,
    byInning,
    detectionRate: detectionDenom > 0 ? Math.round((totals.calledHit / detectionDenom) * 10000) / 10000 : 0,
    hitRate: hitDenom > 0 ? Math.round((totals.calledHit / hitDenom) * 10000) / 10000 : 0,
  };
};
