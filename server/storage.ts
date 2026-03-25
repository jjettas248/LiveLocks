import { db } from "./db";
import { calculateRemainingMinutes } from "./minutesModel";
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
  type CalcDebug,
  type HalftimePlayAlert,
  type InsertHalftimePlayAlert,
  type AnalyticsSummary,
  type PlayAlertWithResult,
  type PersistedPlay,
  type PlayStats,
} from "@shared/schema";
import { eq, and, desc, isNull, sql, lt, lte, inArray, ne } from "drizzle-orm";

const HIGH_VOLATILITY_TEAMS = new Set(["BKN", "WAS", "CHA", "POR", "UTA", "DET"]);

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
  tryConsumeGamePlayToday(userId: number, gameId: string): Promise<{ allowed: boolean; alreadyUnlocked: boolean; playsUsedToday: number }>;
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
    engineProb?: number; bookImplied?: number; edgeGap?: number;
    gameDate: string; timestamp: Date;
    duplicateGuard: string;
  }): Promise<{ id: string; isDuplicate: boolean }>;
  getPlays(opts: { sport?: string; limit?: number; settled?: string; date?: string }): Promise<{ plays: PersistedPlay[]; total: number }>;
  getGradedPlaysForCalibration(opts: { sport?: string; market?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]>;
  settlePlay(id: string, result: string, finalStat: number | null, settledAt: Date): Promise<PersistedPlay | null>;
  getPlayStats(): Promise<PlayStats>;
  cleanupOldPlays(): Promise<number>;
  cleanDuplicatePlays(): Promise<{ removed: number; remaining: number }>;
  cleanDuplicateAlerts(): Promise<{ removed: number; remaining: number }>;
}

// ─── Usage compression for blowout games ──────────────────────────────────
function usageCompressionMultiplier(scoreDiff: number): number {
  const abs = Math.abs(scoreDiff);
  if (abs >= 25) return 0.65;
  if (abs >= 20) return 0.72;
  if (abs >= 15) return 0.82;
  if (abs >= 10) return 0.92;
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
  archetype: "superstar" | "primary" | "role" | "rotation" | "volatile";
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

  getSeasonPhase(gameDate?: string | Date): "early" | "mid" | "late" | "playoffs" {
    const d = gameDate ? new Date(gameDate) : new Date();
    const month = d.getMonth() + 1;
    if (month >= 10 && month <= 12) return "early";
    if (month >= 1 && month <= 2) return "mid";
    if (month >= 3 && month <= 4) return "late";
    return "playoffs";
  }

  async calculateProbability(req: CalculateProbabilityRequest): Promise<CalculateProbabilityResponse & { impliedProbability: number }> {
    const seasonPhase = this.getSeasonPhase(req.gameDate);

    const player = await this.getPlayer(req.playerId);
    if (!player) throw new Error("Player not found");

    const defense = await this.getTeamDefense(req.opponentTeam, player.position);
    const defenseMultiplier = defense ? Number(defense.defRating) : 1.0;

    const avgMinutes = Number(player.avgMinutes);
    const usageRate = player.usageRate ? Number(player.usageRate) : 0.22;
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
    // Clamp tightened at halftime: [0.92, 1.08] (was [0.90, 1.12]) to prevent
    // compounded multipliers from driving systematic UNDER bias.
    const rawContextModifier = defenseMultiplier * paceMultiplier * shootingModifier;
    const suppressionRaw = rawContextModifier; // alias for trace log
    const contextClamp = isHalftimeContext ? { lo: 0.92, hi: 1.08 } : { lo: 0.88, hi: 1.18 };
    const contextModifier = Math.max(contextClamp.lo, Math.min(contextClamp.hi, rawContextModifier));

    const baselinePPM = 2.1;
    const livePPM = estimatePossessionsPerMinute(currentPeriod, parsedScoreDiff);
    const tempoMultiplier = livePPM / baselinePPM;
    const usageMultiplier = usageCompressionMultiplier(parsedScoreDiff);
    let expectedFromHere = blendedPerMin * remainingMinutes * contextModifier * tempoMultiplier * usageMultiplier;

    // ─── Overtime probability boost (Step 3) ──────────────────────────────
    if (hasScoreData && currentPeriod === 4 && clockMins <= 2.0 && Math.abs(parsedScoreDiff) <= 3) {
      if (parsedScoreDiff === 0 && clockMins <= 1.0) {
        expectedFromHere *= 1.05;
      } else {
        expectedFromHere *= 1.03;
      }
    }

    let expectedTotal = req.halftimeStat + expectedFromHere;

    // ─── Halftime total regression ────────────────────────────────────────
    // When a player has 16+ minutes in the first half, apply a mild regression-to-mean
    // multiplier on expectedTotal. Changed from 0.92 → 0.96 to match halftimeRegressionFactor
    // adjustment and reduce compounded UNDER suppression for starters (who nearly always
    // play 20+ minutes in H1, causing this to fire on almost every halftime play).
    if (minutesPlayed >= 16 && isHalftimeContext) {
      expectedTotal *= 0.96;
    }

    // ─── Market anchoring ─────────────────────────────────────────────────
    const marketMean = req.liveLine + 0.5;
    const finalMean = 0.65 * expectedTotal + 0.35 * marketMean;
    const edge = finalMean - req.liveLine;

    // ─── Probability pipeline ─────────────────────────────────────────────
    // Step 1 — Edge → raw probability via interpolation
    const edgeContext: "halftime" | "live" = isHalftimeContext ? "halftime" : "live";
    let probability = edgeToProbability(edge, req.statType, edgeContext);

    // DIRECTION CONTRACT: strict > 50 / < 50 rule.
    // probability === 50 maps to "UNDER" here only for calibration arithmetic;
    // it will produce recommendedSide="NO_SIGNAL" and be excluded from all signals.
    const direction = probability > 50 ? "OVER" : "UNDER";

    // [HT_SUPPRESSION_TRACE] — halftime-only trace of suppression multipliers
    // Fires only in halftime context so live-signal noise is not added.
    // suppressionRaw = defenseMultiplier * paceMultiplier * shootingModifier (before clamp)
    // suppressionClamped = contextModifier (after [0.92, 1.08] clamp)
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
      });
    }

    // Step 2 — Calibration lookup (directional confidence only)
    const confidence = direction === "OVER" ? probability : 100 - probability;
    const calibrated = calibrateProbability(confidence);
    probability = direction === "OVER" ? calibrated : 100 - calibrated;

    // Step 3 — Penalties
    // Step 3a — Combo variance filter
    let comboVariancePenaltyApplied = false;
    if (req.statType.includes("+") || req.statType.includes("_")) {
      probability *= 0.96;
      probability = Math.max(2, Math.min(98, probability));
      comboVariancePenaltyApplied = true;
    }

    // Step 3b — Bench volatility filter
    const effectiveMinutesBase = freshProjectedMinutes ?? avgMinutes;
    const rotationSource: "projected" | "season_avg" =
      freshProjectedMinutes !== null ? "projected" : "season_avg";
    let volatilityFiltered = false;
    if (effectiveMinutesBase < 26) {
      probability = Math.max(2, Math.min(98, probability * 0.94));
      volatilityFiltered = true;
    }

    // Step 4 — Season volatility adjustments
    const isLowRolePlayer = effectiveMinutesBase < 28;
    const isBenchVolatile = (freshProjectedMinutes ?? avgMinutes) < 24 && minutesPlayed < 12;
    const isComboStat = req.statType.includes("+") || req.statType.includes("_");
    let lateSeasonPenaltyApplied = false;

    if (seasonPhase === "late" && direction === "UNDER") {
      if (isLowRolePlayer) {
        probability *= 0.94;
        lateSeasonPenaltyApplied = true;
      }
      if (isComboStat) {
        probability *= 0.95;
        lateSeasonPenaltyApplied = true;
      }
      if (isBenchVolatile) {
        probability *= 0.92;
        lateSeasonPenaltyApplied = true;
      }
      probability = Math.max(2, Math.min(98, probability));
    }

    // Step 4b — Tank-team late-season penalty
    let teamVolatilityPenaltyApplied = false;
    if (seasonPhase === "late" && HIGH_VOLATILITY_TEAMS.has(player.team)) {
      probability *= 0.96;
      probability = Math.max(2, Math.min(98, probability));
      teamVolatilityPenaltyApplied = true;
    }

    // Step 5 — Playoff boost
    let playoffBoostApplied = false;
    if (seasonPhase === "playoffs") {
      probability *= 1.03;
      probability = Math.max(2, Math.min(98, probability));
      playoffBoostApplied = true;
    }

    // Step 6 — Probability expansion
    probability = 50 + (probability - 50) * 1.65;

    // ─── Archetype classification ─────────────────────────────────────────
    type Archetype = "superstar" | "primary" | "role" | "rotation" | "volatile";
    function classifyArchetype(mins: number): Archetype {
      if (mins >= 32) return "superstar";
      if (mins >= 26) return "primary";
      if (mins >= 20) return "role";
      if (mins >= 15) return "rotation";
      return "volatile";
    }
    const archetype = classifyArchetype(avgMinutes);

    // Filter D — Final clamp
    probability = Math.max(2, Math.min(98, probability));

    // ─── Directional semantics ─────────────────────────────────────────────
    // "probability" is a raw directional lean (0-100, OVER likelihood).
    // Never use it directly as display confidence. All UI and routing uses displayConfidence.
    const overLeanProbability = probability;

    const overConfidence = overLeanProbability;
    const underConfidence = 100 - overLeanProbability;

    const recommendedSide: "OVER" | "UNDER" | "NO_SIGNAL" =
      overLeanProbability > 50 ? "OVER" :
      overLeanProbability < 50 ? "UNDER" :
      "NO_SIGNAL";

    const displayConfidence: number | null =
      recommendedSide === "NO_SIGNAL" ? null :
      recommendedSide === "OVER" ? overConfidence :
      underConfidence;

    // ─── Integrity guard ───────────────────────────────────────────────────
    const warnings: string[] = [];
    if (recommendedSide === "OVER" && expectedTotal <= req.liveLine) {
      warnings.push("direction_projection_mismatch");
    }
    if (recommendedSide === "UNDER" && expectedTotal >= req.liveLine) {
      warnings.push("direction_projection_mismatch");
    }
    const hasProjectionMismatch = warnings.includes("direction_projection_mismatch");

    // Edge sanity check using real odds — use displayConfidence for symmetric OVER/UNDER comparison.
    // probability (OVER-lean, 0-100) would make all UNDER signals fail the gate since prob < 50.
    // displayConfidence is always the winning-side confidence (>= 50 for both directions).
    const sportsbookImplied = americanOddsToProb(req.bookOdds ?? -110) * 100;
    const edgeVsBook = (displayConfidence !== null ? displayConfidence : Math.abs(probability - 50) + 50) - sportsbookImplied;

    const MIN_DISPLAY_CONFIDENCE = 55;
    const noSignal = edgeVsBook < 3
      || (displayConfidence !== null && displayConfidence < MIN_DISPLAY_CONFIDENCE)
      || hasProjectionMismatch;

    let usageUnderPenaltyApplied = false;

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
      const finalProbability = Math.round(probability * 10) / 10;
      calcLogEntries.push({
        player: player.name,
        statType: req.statType,
        line: req.liveLine,
        probability: finalProbability,
        direction,
        bookOdds: req.bookOdds ?? null,
        bookImplied: Math.round(sportsbookImplied * 10) / 10,
        edgeRaw: Math.round(edge * 100) / 100,
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
    };

    return {
      probability: finalProbability,
      impliedProbability: finalProbability,
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

  async incrementPlaysUsedToday(userId: number): Promise<void> {
    await db.update(users)
      .set({ playsUsedToday: sql`${users.playsUsedToday} + 1` })
      .where(eq(users.id, userId));
  }

  async tryConsumePlayToday(userId: number): Promise<{ allowed: boolean; playsUsedToday: number }> {
    const today = new Date().toISOString().slice(0, 10);
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

  async tryConsumeGamePlayToday(userId: number, gameId: string): Promise<{ allowed: boolean; alreadyUnlocked: boolean; playsUsedToday: number }> {
    const today = new Date().toISOString().slice(0, 10);
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
        AND plays_used_today < 3
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
    return { allowed: false, alreadyUnlocked, playsUsedToday: user?.playsUsedToday ?? 3 };
  }

  async resetDailyPlaysIfNeeded(userId: number): Promise<User | undefined> {
    const user = await this.getUserById(userId);
    if (!user) return undefined;
    const today = new Date().toISOString().slice(0, 10);
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
    const today = new Date().toISOString().slice(0, 10);
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

  async getGradedPlaysForCalibration(opts: { sport?: string; market?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]> {
    const conds = [sql`${persistedPlays.result} IS NOT NULL`];
    if (opts.sport) conds.push(sql`${persistedPlays.sport} = ${opts.sport}`);
    if (opts.market) conds.push(sql`${persistedPlays.market} = ${opts.market}`);
    if (opts.startDate) conds.push(sql`${persistedPlays.gameDate} >= ${opts.startDate}`);
    if (opts.endDate) conds.push(sql`${persistedPlays.gameDate} <= ${opts.endDate}`);
    return await db
      .select()
      .from(persistedPlays)
      .where(and(...conds))
      .orderBy(desc(persistedPlays.timestamp));
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
