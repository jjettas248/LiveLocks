import { db } from "./db";
import { todayET, daysAgoET } from "./utils/dateUtils";
import { resolveMlbGameSessionDate } from "./utils/mlbSessionDate";
import { decideHrRadarMatch, QUALIFYING_EVENT_TYPES } from "./validation/hrRadar/matchDecision";
import { traceMissedHr } from "./analytics/hrRadarMissTracer";
import { emitCalledHitLeadTime } from "./analytics/eventEmitters";
import { applyHrRadarResolvedStateFixup, inferCashedFromTierStatus, CALLED_HIT_OUTCOME_STATUSES, resolveFinalNoHrGrading, reachedHrMaxWindow, reachedFireCommitment, extractPeakConversionProbability, qualifiesForNearHrCredit, isContactInCommittedWindow } from "./mlb/hrRadarSection";
import { buildHrRadarDisplayContract, getRawCurrentReadinessScore10 } from "./mlb/hrRadarDisplayContract";
import type { HrRadarOutcomeStatus, HrRadarPeakContact } from "./mlb/hrRadarSection";
import type { PersistedHrRadarOutcomeStamp } from "./mlb/hrRadarOutcomeStamp";
import { classifyHrMaxWindowAtFinal } from "./mlb/hrMaxWindow";
import { isBarrel as isCanonicalBarrel } from "./mlb/statcastXBA";
import {
  HR_RADAR_GOLDMASTER_V1,
  enrichWithUserStage,
  buildValidationPayload,
  type HrRadarUserStage,
  type HrQualifyingSignalType,
} from "./mlb/hrRadarUserStage";
import { calculateRemainingMinutes } from "./minutesModel";
import type { HrRadarBadge, HrRadarDisplayGrade } from "@shared/hrRadarStage";
import { getPlayerUsage, getTeamDefenseMatchup, computeUsageAdjustment, computeDefenseMultiplier } from "./services/nbaStatsService";
import { getPlayoffRotationProfile, type PlayoffRotationProfile } from "./services/nbaRotationHistoryService";
import { classifyArchetype as classifyNBAArchetype, type NBAArchetype, VARIANCE_MULTIPLIERS, MINUTES_FRAGILITY_MULTIPLIERS, CORRELATION_DEFAULTS, COMBO_VARIANCE_EXTRA, isVolatileArchetype, isImpactedArchetype, isStableArchetype, getSafetyCeiling, getPlayoffSafetyCeiling, getPlayoffFragilityMultiplier } from "./nba/archetypes";
import { isUnderBiasCorrectionActive } from "./nba/directionalBias";
import { finalizeNbaProbability, NBA_CALIBRATION_VERSION, deriveFreshOdds } from "./nba/probabilityFinalizer";
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
  hrRadarOutcomeStamps,
  hrRadarSignalEvents,
  hrOutcomes,
  signalInteractions,
  railEvents,
  stripeEvents,
  batterRollingSnapshots,
  type BatterRollingSnapshot,
  type InsertBatterRollingSnapshot,
  pregamePowerRadarSignals,
  pregamePowerRadarBuilds,
  type PregamePowerRadarSignalRow,
  type InsertPregamePowerRadarSignal,
  type PregamePowerRadarBuildRow,
  type InsertPregamePowerRadarBuild,
  mlbMoundRadarSignals,
  mlbMoundRadarBuilds,
  type MlbMoundRadarSignalRow,
  type InsertMlbMoundRadarSignal,
  type MlbMoundRadarBuildRow,
  type InsertMlbMoundRadarBuild,
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
import { PREGAME_SEED_CAP, pregameSeedTierLabel } from "@shared/hrRadarConviction";
import { eq, and, asc, desc, isNull, isNotNull, sql, lt, lte, gte, inArray, ne } from "drizzle-orm";

const HIGH_VOLATILITY_TEAMS = new Set(["BKN", "WAS", "CHA", "POR", "UTA", "DET"]);

/**
 * Near-HR credit (2026-06) — derive the best near-HR-shaped contact a player
 * produced **within the committed window** (at/after the signal's
 * `signalInning`/`signalHalf`), for `called_near_hr` grading at game-final
 * reconciliation. Reads the per-contact window already persisted on
 * `diagnosticsSnapshot.contactClasses` (EV/LA/distance/barrel/inning/half),
 * falling back to the last-AB `contactSnapshot`. Contacts from an earlier
 * watch/build phase are filtered out so a pre-fire barrel cannot inflate a
 * later no-HR official pick (Codex review #25). Returns the FIRST in-window
 * contact that clears the credit bar (so `qualifiesForNearHrCredit` returns
 * true), else the window's peak metrics (for logging). Pure; null-safe.
 */
function extractAlertPeakContact(
  diagnosticsSnapshot: unknown,
  contactSnapshot: unknown,
  committedWindow: { signalInning?: number | null; signalHalf?: string | null },
): HrRadarPeakContact | null {
  const candidates: HrRadarPeakContact[] = [];
  const diag = diagnosticsSnapshot as any;
  const classes = Array.isArray(diag?.contactClasses) ? diag.contactClasses : [];
  for (const c of classes) {
    candidates.push({
      peakEv: typeof c?.exitVelocity === "number" ? c.exitVelocity : null,
      peakLaunchAngle: typeof c?.launchAngle === "number" ? c.launchAngle : null,
      peakDistance: typeof c?.distance === "number" ? c.distance : null,
      isBarrel: c?.isBarrel === true,
      inning: typeof c?.inning === "number" ? c.inning : null,
      half: typeof c?.half === "string" ? c.half : null,
    });
  }
  const snap = contactSnapshot as any;
  if (snap) {
    candidates.push({
      peakEv: typeof snap.ev === "number" ? snap.ev : null,
      peakLaunchAngle: typeof snap.la === "number" ? snap.la : null,
      peakDistance: typeof snap.distance === "number" ? snap.distance : null,
      isBarrel: snap.barrel === true,
      inning: typeof snap.inning === "number" ? snap.inning : null,
      half: typeof snap.half === "string" ? snap.half : null,
    });
  }
  // Committed-window scoping — drop contact from before the signal fired so
  // only danger squared up during the committed pick can earn credit.
  const inWindow = candidates.filter(c => isContactInCommittedWindow(c, committedWindow));
  if (inWindow.length === 0) return null;
  const qualifying = inWindow.find(c => qualifiesForNearHrCredit(c));
  if (qualifying) return qualifying;
  // None qualify — return the in-window peak purely for logging context.
  return inWindow.reduce((best, c) => ({
    peakEv: Math.max(best.peakEv ?? 0, c.peakEv ?? 0) || null,
    peakLaunchAngle: (c.peakDistance ?? 0) > (best.peakDistance ?? 0) ? c.peakLaunchAngle : best.peakLaunchAngle,
    peakDistance: Math.max(best.peakDistance ?? 0, c.peakDistance ?? 0) || null,
    isBarrel: (best.isBarrel === true) || (c.isBarrel === true),
  }), inWindow[0]);
}

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


export interface RailEventStats {
  rangeDays: number;
  impressions: number;
  primaryCtaClicks: number;
  alertsCtaClicks: number;
  upgradeModalOpens: number;
  primaryCtrPct: number;
  alertsCtrPct: number;
  upgradeConversionPct: number;
  exhaustedPrimaryClicks: number;
  perDay: Array<{
    date: string;
    impressions: number;
    primaryCtaClicks: number;
    alertsCtaClicks: number;
    upgradeModalOpens: number;
  }>;
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
  // Pass 2 — additive lifecycle helpers. Tier resolution and entitlement gates remain
  // owned by updateUserSubscription / setUserSubscriptionTier; these methods only persist
  // lifecycle metadata (status, source, trial timestamps, alerts channel state) and never
  // mutate subscriptionTier.
  updateSubscriptionLifecycle(userId: number, data: {
    subscriptionStatus?: string | null;
    subscriptionSource?: string | null;
    trialStartedAt?: Date | null;
    trialEndsAt?: Date | null;
    cancelAtPeriodEnd?: boolean | null;
    convertedToPaidAt?: Date | null;
    trialAbandonedAt?: Date | null;
  }): Promise<void>;
  markTrialConverted(userId: number, at: Date): Promise<void>;
  markTrialAbandoned(userId: number, at: Date): Promise<void>;
  updateUserAlertsChannelState(userId: number, data: {
    alertsChannelStatus?: string | null;
    telegramChatId?: string | null;
    telegramUsername?: string | null;
    telegramConnectedAt?: Date | null;
    telegramConnectionStatus?: string | null;
  }): Promise<void>;
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
  getPendingPlaysForGrading(limit?: number): Promise<PersistedPlay[]>;
  getAllSettledPlays(opts?: { sport?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]>;
  getPlaysInRange(opts?: { sport?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]>;
  getGradedPlaysForCalibration(opts: { sport?: string; market?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]>;
  settlePlay(id: string, result: string, finalStat: number | null, settledAt: Date): Promise<PersistedPlay | null>;
  getPlayStats(): Promise<PlayStats>;
  getRecentGradedSignals(limit: number): Promise<PersistedPlay[]>;
  recordSignalInteraction(data: { userId: number; signalId?: string; action: string; sport?: string; market?: string }): Promise<void>;
  recordRailEvent(data: { userId?: number | null; eventType: string; source?: string; exhausted?: boolean | null; playsUsedToday?: number | null; playsLimit?: number | null }): Promise<void>;
  getRailEventStats(rangeDays: number): Promise<RailEventStats>;
  cleanupOldPlays(): Promise<number>;
  cleanDuplicatePlays(): Promise<{ removed: number; remaining: number }>;
  cleanDuplicateAlerts(): Promise<{ removed: number; remaining: number }>;
  hasProcessedStripeEvent(eventId: string): Promise<boolean>;
  recordStripeEvent(eventId: string): Promise<void>;
  recordChurn(userId: number, previousTier: string | null): Promise<void>;
  getChurnedUsers(): Promise<Array<{ id: number; email: string; churnedAt: Date; churnedFromTier: string | null; createdAt: Date | null }>>;

  // Pass 6 — Read-only lifecycle reporting for the admin surface.
  // Aggregates over the nullable lifecycle columns added in Pass 2 plus the
  // pre-existing churn_tracking table. Pure read; never modifies state.
  getLifecycleMetrics(): Promise<{
    counts: {
      trialStartsLifetime: number;
      trialActive: number;
      trialDropoffLifetime: number;
      trialConvertedToPaidLifetime: number;
      paidChurnLifetime: number;
      cancelAtPeriodEnd: number;
    };
    rates: {
      trialConversionPct: number | null; // converted / starts, null if no starts
    };
    alertsChannelStatus: Record<string, number>;
    telegramConnectionStatus: Record<string, number>;
    subscriptionSource: Record<string, number>;
  }>;

  // Task #129 — point-in-time batter rolling stat snapshots.
  upsertBatterRollingSnapshot(snap: InsertBatterRollingSnapshot): Promise<void>;
  getBatterRollingSnapshot(playerId: string, sessionDate: string): Promise<BatterRollingSnapshot | null>;
  getBatterRollingSnapshotsForDateRange(from: string, to: string): Promise<BatterRollingSnapshot[]>;

  // ── MLB Pre-Game Power Radar (additive; never feeds ROI) ──────────────────
  upsertPregamePowerRadarSignal(row: InsertPregamePowerRadarSignal): Promise<void>;
  getPregamePowerRadarSignalsByDate(sessionDate: string): Promise<PregamePowerRadarSignalRow[]>;
  getPregamePowerRadarSignalsByGame(sessionDate: string, gameId: string): Promise<PregamePowerRadarSignalRow[]>;
  recordPregamePowerBuild(build: InsertPregamePowerRadarBuild): Promise<void>;
  getLatestPregamePowerBuild(sessionDate: string): Promise<PregamePowerRadarBuildRow | null>;

  // ── MLB Mound Radar (additive; never feeds ROI; sibling of Pre-Game Power Radar) ──
  upsertMlbMoundRadarSignal(row: InsertMlbMoundRadarSignal): Promise<void>;
  getMlbMoundRadarSignalsByDate(sessionDate: string): Promise<MlbMoundRadarSignalRow[]>;
  getMlbMoundRadarSignalsByGame(sessionDate: string, gameId: string): Promise<MlbMoundRadarSignalRow[]>;
  recordMlbMoundRadarBuild(build: InsertMlbMoundRadarBuild): Promise<void>;
  getLatestMlbMoundRadarBuild(sessionDate: string): Promise<MlbMoundRadarBuildRow | null>;
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

    // NBA Calibration v2 — finalizer with dampened modifier stacking, market
    // caps, elite gate, hard 82 ceiling, fragility subtraction. NEVER raises
    // probability. Conflict-survivor cap is applied at the route layer where
    // both sides of the family are visible. See server/nba/probabilityFinalizer.ts.
    const regularCeiling = getSafetyCeiling(nbaArchetype, isComboStat);
    const playoffCeiling = isPlayoffs ? getPlayoffSafetyCeiling(nbaArchetype, isComboStat) : regularCeiling;
    const appliedCeiling = isPlayoffs && isStableArchetype(nbaArchetype)
      ? playoffCeiling
      : Math.min(regularCeiling, playoffCeiling);

    const _projectionDeltaPct = req.liveLine && Math.abs(req.liveLine) > 0
      ? Math.abs(expectedTotal - req.liveLine) / Math.max(Math.abs(req.liveLine), 1)
      : 0;
    const _minutesCertainty = Math.max(0, Math.min(1, 1 - (Math.sqrt(Math.max(0, minVar)) / 8)));
    const _finalizerRawSide: "OVER" | "UNDER" = rawSide === "NO_SIGNAL" ? "OVER" : rawSide;
    // Real elite-gate inputs (no longer hardcoded):
    //   • freshOdds: derived from req.oddsAgeSec when available; treat odds
    //     older than 10 min as stale.
    //   • edgeFromGapOnly: when projection separation is < 4% the edge is
    //     dominated by the model/book gap rather than projection conviction
    //     — too thin to qualify as "elite".
    //   • conflictingSideSuppressed: stamped at the route layer post-batch.
    // Fail-closed: if oddsAgeSec is missing/unknown, freshOdds is FALSE.
    // Centralized in deriveFreshOdds so the engine, storage, and audit
    // script all share the exact same rule.
    const _oddsAgeSec = req.oddsAgeSec;
    const _freshOdds = deriveFreshOdds(_oddsAgeSec);
    const _edgeFromGapOnly = _projectionDeltaPct < 0.04;
    const _finalizer = finalizeNbaProbability(P_side_calibrated, {
      rawSide: _finalizerRawSide,
      market: req.statType,
      archetype: nbaArchetype,
      isCombo: isComboStat,
      fragilityScore,
      isPlayoffs,
      minutesCertainty: _minutesCertainty,
      projectionDeltaPct: _projectionDeltaPct,
      freshOdds: _freshOdds,
      edgeFromGapOnly: _edgeFromGapOnly,
      conflictingSideSuppressed: false,
    });
    const P_side_final = _finalizer.pSideFinal;
    const confidenceCeilingApplied = _finalizer.capApplied;
    const ceilingReason: string | null = _finalizer.capReason;
    if (_finalizer.capApplied) {
      calibrationTrack += `+nbaCalV2:${_finalizer.capReason ?? "capped"}`;
    }
    console.log(`[NBA_CALIBRATION_V2] player=${player.name} market=${req.statType} initialPct=${_finalizer.initialProbabilityPct.toFixed(1)} finalPct=${_finalizer.finalProbabilityPct.toFixed(1)} tier=${_finalizer.marketRiskTier} capReason=${_finalizer.capReason ?? "none"} eliteGate=${_finalizer.eliteGateApplied} hardCeiling=${_finalizer.highBucketCapped} fragPp=${_finalizer.fragilityDeltaPp.toFixed(2)} mods=${_finalizer.modifierStack.map(m => `${m.name}@${m.weight}=${m.appliedDeltaPp.toFixed(2)}`).join(",")}`);
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

    // ENGINE-AS-TRUTH: all post-engine playoff confidence guards removed
    // (high-bucket guard, fallback cap, role-truth eligibility gates).
    // These were "safety" clamps that masked calibration errors instead of
    // surfacing true engine logic. The engine's calibrated probability is
    // the source of truth for ALL game states (regular season, playoffs,
    // halftime, Q4). Calibration issues should be fixed in the engine
    // (archetypes, fragility, calibrate()), not papered over downstream.
    const playoffHighBucketGuardApplied = false;
    const playoffFallbackCapApplied = false;
    const playoffRoleGate70Applied = false;
    const playoffRoleGate80Applied = false;
    if (isPlayoffs && displayConfidence !== null) {
      const eligibility = canReachPlayoffHighConfidence({
        playoffRotationProfile,
        archetype: nbaArchetype,
        playoffDataFallbackUsed,
        playoffRotationFallbackUsed,
        isComboMarket: isComboStat,
      });
      if (process.env.DEBUG_NBA === "true") {
        console.log(`[NBA_PLAYOFF_ROLE_GATE_DIAG] player=${player.name} displayConfidence=${displayConfidence} can70=${eligibility.can70} can80=${eligibility.can80} reason=${eligibility.reason} (engine-as-truth: not enforced)`);
      }

      // ── NBA halftime confidence trace (DEBUG_NBA=true) ──────────────────
      // Captures every value that influences the halftime cap decision so we
      // can reconstruct exactly why a play landed at its final confidence.
      if (isHalftimeContext && process.env.DEBUG_NBA === "true") {
        console.log("[NBA_HT_CONFIDENCE_TRACE]", JSON.stringify({
          player: player.name,
          statType: req.statType,
          seasonPhase,
          archetype: nbaArchetype,
          liveLine: req.liveLine,
          halftimeStat: req.halftimeStat,
          expectedTotal: Math.round(expectedTotal * 100) / 100,
          finalMean: Math.round(finalMean * 100) / 100,
          rawSide: rawSide,
          recommendedSide,
          displayConfidenceAfterRoleGate:
            displayConfidence !== null ? Math.round(displayConfidence * 10) / 10 : null,
          eligibility,
          calibrationTrack,
          minutesPlayed,
          remainingMinutes: Math.round(remainingMinutes * 10) / 10,
          playoffRotationFallbackUsed,
          playoffDataFallbackUsed,
        }));
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

    // ── Unification: Playoff Rotation Truth Layer evidence ───────────────
    // Surface per-player role evidence so the halftime route (and any other
    // downstream consumer) can make role-aware decisions without re-fetching
    // the profile. The bucket below is the canonical role label that the
    // route's degraded-line tier-reduction uses to decide whether to demote
    // a play, half-demote it, or leave it intact.
    const _profCert = playoffRotationProfile?.playoffRoleCertainty ?? null;
    const _profRank = playoffRotationProfile?.rotationRankEstimate ?? null;
    const _profCloseTrust = playoffRotationProfile?.closeGameTrustScore ?? null;
    let playoffRoleBucket: "STARTER" | "CORE_ROTATION" | "FRINGE" | "NONE" = "NONE";
    // STARTER and CORE_ROTATION require REAL playoff logs. A
    // regular_season_fallback profile is degraded evidence (Game 1 / sparse)
    // and must not unlock the no-demotion / half-demotion paths in the
    // halftime route — otherwise we'd over-trust stale lines for players
    // whose playoff role is still unknown. Such cases stay FRINGE so the
    // route applies the full degraded-line demotion ladder.
    if (
      playoffRotationProfile &&
      playoffRotationProfile.dataSource === "playoffs"
    ) {
      const cert = _profCert ?? 0;
      const rank = _profRank ?? 99;
      const closeTrust = _profCloseTrust ?? 0;
      if (cert >= 0.65 && rank <= 5 && closeTrust >= 0.55) {
        playoffRoleBucket = "STARTER";
      } else if (cert >= 0.45 && rank <= 8) {
        playoffRoleBucket = "CORE_ROTATION";
      } else {
        playoffRoleBucket = "FRINGE";
      }
    } else if (
      playoffRotationProfile &&
      playoffRotationProfile.dataSource === "regular_season_fallback"
    ) {
      playoffRoleBucket = "FRINGE";
    }

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
      // Source provenance — surfaced unconditionally so callers (e.g. the
      // halftime route) can attach per-play `sourceProvenance` without
      // depending on the `debug` field which is gated by req.isDebug.
      rotationSource,
      projectionSource,
      playoffMode: isPlayoffs,
      playoffDataResolved: isPlayoffs && !playoffDataFallbackUsed && (!!nbaDefenseMatchup || !!nbaPlayerUsage),
      playoffDataFallbackUsed,
      playoffRotationFallbackUsed,
      playoffRotationDataSource: playoffRotationProfile?.dataSource ?? null,
      // Per-player playoff role evidence (Truth Layer unification with 2H alerts)
      playoffRoleBucket,
      playoffRoleCertainty: _profCert,
      closeGameTrustScore: _profCloseTrust,
      rotationRankEstimate: _profRank,
      playoffMinutesVariance: playoffRotationProfile?.playoffMinutesVariance ?? null,
      coachShortBenchIndex: playoffRotationProfile?.coachShortBenchIndex ?? null,
      coachStarRideIndex: playoffRotationProfile?.coachStarRideIndex ?? null,
      defenseMatchupResolved: !!nbaDefenseMatchup,
      playerUsageResolved: !!nbaPlayerUsage,
      // Surface playoff role-truth gate flags so downstream callers (e.g. the
      // NBA halftime route) can detect when displayConfidence has been pinned
      // by the gate. Without this signal, derived-line plays whose conviction
      // was clamped to the 68/74 cap appear identical to one another and the
      // user sees "every play is 68% / +19%" — adding the flag lets the route
      // suppress those double-degraded (derived line + pinned confidence)
      // entries instead of surfacing indistinguishable noise.
      playoffRoleGate70Applied,
      playoffRoleGate80Applied,
      playoffHighBucketGuardApplied,
      playoffFallbackCapApplied,
      // NBA Calibration v2 stamping — admin analytics keys off these.
      calibrationVersion: NBA_CALIBRATION_VERSION,
      finalizerCapReason: _finalizer.capReason,
      finalizerMarketRiskTier: _finalizer.marketRiskTier,
      finalizerEliteGateApplied: _finalizer.eliteGateApplied,
      finalizerHighBucketCapped: _finalizer.highBucketCapped,
      finalizerInitialPct: Math.round(_finalizer.initialProbabilityPct * 10) / 10,
      finalizerFinalPct: Math.round(_finalizer.finalProbabilityPct * 10) / 10,
      // Canonical contract field names so downstream consumers can read
      // the calibration-v2 result without depending on internal aliases.
      rawProbability: Math.round(_finalizer.initialProbabilityPct * 10) / 10,
      finalProbability: Math.round(_finalizer.finalProbabilityPct * 10) / 10,
      probabilityCapApplied: _finalizer.capApplied,
      conflictingSignalSuppressed: false,
      finalizerFragilityDeltaPp: Math.round(_finalizer.fragilityDeltaPp * 100) / 100,
      finalizerModifierStack: _finalizer.modifierStack.map(m => ({
        name: m.name,
        weight: m.weight,
        appliedDeltaPp: Math.round(m.appliedDeltaPp * 100) / 100,
      })),
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

  // ----- Pass 2 — additive lifecycle helpers (no entitlement / tier mutation) -----

  async updateSubscriptionLifecycle(userId: number, data: {
    subscriptionStatus?: string | null;
    subscriptionSource?: string | null;
    trialStartedAt?: Date | null;
    trialEndsAt?: Date | null;
    cancelAtPeriodEnd?: boolean | null;
    convertedToPaidAt?: Date | null;
    trialAbandonedAt?: Date | null;
  }): Promise<void> {
    const update: Record<string, any> = {};
    if (data.subscriptionStatus !== undefined) update.subscriptionStatus = data.subscriptionStatus;
    if (data.subscriptionSource !== undefined) update.subscriptionSource = data.subscriptionSource;
    if (data.trialStartedAt !== undefined) update.trialStartedAt = data.trialStartedAt;
    if (data.trialEndsAt !== undefined) update.trialEndsAt = data.trialEndsAt;
    if (data.cancelAtPeriodEnd !== undefined) update.cancelAtPeriodEnd = data.cancelAtPeriodEnd;
    if (data.convertedToPaidAt !== undefined) update.convertedToPaidAt = data.convertedToPaidAt;
    if (data.trialAbandonedAt !== undefined) update.trialAbandonedAt = data.trialAbandonedAt;
    if (Object.keys(update).length === 0) return;
    await db.update(users).set(update).where(eq(users.id, userId));
  }

  async markTrialConverted(userId: number, at: Date): Promise<void> {
    await db.update(users).set({
      convertedToPaidAt: at,
      subscriptionStatus: "active",
      trialAbandonedAt: null,
    }).where(eq(users.id, userId));
  }

  async markTrialAbandoned(userId: number, at: Date): Promise<void> {
    await db.update(users).set({
      trialAbandonedAt: at,
      subscriptionStatus: "canceled",
    }).where(eq(users.id, userId));
  }

  async updateUserAlertsChannelState(userId: number, data: {
    alertsChannelStatus?: string | null;
    telegramChatId?: string | null;
    telegramUsername?: string | null;
    telegramConnectedAt?: Date | null;
    telegramConnectionStatus?: string | null;
  }): Promise<void> {
    const update: Record<string, any> = {};
    if (data.alertsChannelStatus !== undefined) update.alertsChannelStatus = data.alertsChannelStatus;
    if (data.telegramChatId !== undefined) update.telegramChatId = data.telegramChatId;
    if (data.telegramUsername !== undefined) update.telegramUsername = data.telegramUsername;
    if (data.telegramConnectedAt !== undefined) update.telegramConnectedAt = data.telegramConnectedAt;
    if (data.telegramConnectionStatus !== undefined) update.telegramConnectionStatus = data.telegramConnectionStatus;
    if (Object.keys(update).length === 0) return;
    await db.update(users).set(update).where(eq(users.id, userId));
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
      // Lowered from 60 → 50 so Tier C halftime plays (edge ≥ 6, prob 44–56)
      // are recorded into the ledger. The route already curated topPlays via
      // its tiering logic; this filter only blocks rows with no directional
      // lean at all, never the curated set.
      if (directionalConf < 50) continue;

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
        // UPSERT atomic scoring bundle — when a higher signalScore wins, update
        // every field that describes the play's pricing/probability snapshot so
        // the row never contains a mix of old and new evaluation state.
        // Audit finding 2.3: prob/edge/bookImplied/odds previously stayed stale
        // while projection/signalScore advanced, corrupting downstream analytics.
        //
        // Sparse-write protection: only overwrite a field when the caller
        // provides a non-null value. This keeps richer prior data (e.g. when
        // the route safety-net writes a leaner payload than the orchestrator)
        // intact while still allowing the higher-score writer to update the
        // fields it does have. Core scoring fields (line, prob, signalScore,
        // confidenceTier) are always updated since they're the audit's primary
        // concern and any caller producing a higher signalScore must have them.
        const updateSet: Record<string, unknown> = {
          line: String(play.line),
          prob: String(play.prob),
          signalScore: play.signalScore != null ? String(play.signalScore) : null,
          confidenceTier: play.confidenceTier ?? null,
        };
        if (play.engineProb != null) updateSet.engineProb = String(play.engineProb);
        if (play.bookImplied != null) updateSet.bookImplied = String(play.bookImplied);
        if (play.edgeGap != null) updateSet.edgeGap = String(play.edgeGap);
        if (play.projection != null) updateSet.projection = String(play.projection);
        if (play.odds != null) updateSet.odds = String(play.odds);
        if (play.rawProbOver != null) updateSet.rawProbOver = String(play.rawProbOver);
        if (play.rawProbUnder != null) updateSet.rawProbUnder = String(play.rawProbUnder);
        if (play.finalProbOver != null) updateSet.finalProbOver = String(play.finalProbOver);
        if (play.finalProbUnder != null) updateSet.finalProbUnder = String(play.finalProbUnder);
        if (play.displayConfidence != null) updateSet.displayConfidence = String(play.displayConfidence);
        if (play.modelEdge != null) updateSet.modelEdge = String(play.modelEdge);
        if (play.mu != null) updateSet.mu = String(play.mu);
        if (play.sigma != null) updateSet.sigma = String(play.sigma);
        if (play.zScore != null) updateSet.zScore = String(play.zScore);
        if (play.hrBuildScore != null) updateSet.hrBuildScore = String(play.hrBuildScore);
        if (play.hrIntensity != null) updateSet.hrIntensity = play.hrIntensity;
        if (play.liveScore != null) updateSet.liveScore = play.liveScore;
        if (play.opportunityScore != null) updateSet.opportunityScore = play.opportunityScore;
        if (play.eventBoost != null) updateSet.eventBoost = play.eventBoost;
        if (play.inning != null) updateSet.inning = play.inning;
        if (play.abNumber != null) updateSet.abNumber = play.abNumber;
        if (play.pitchCount != null) updateSet.pitchCount = play.pitchCount;
        if (play.contactQualityScore != null) updateSet.contactQualityScore = String(play.contactQualityScore);
        await db.update(persistedPlays).set(updateSet).where(eq(persistedPlays.id, existing[0].id));
        console.log(`[PlayTracker] UPSERT — updated ${existing[0].id} with higher signalScore ${newScore} > ${oldScore} (${Object.keys(updateSet).length} fields)`);
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

  // Grader-only pending feed. The public getPlays() returns the NEWEST 500
  // pending plays (ordered desc, hard-capped at 500). That starves the grader
  // once the pending backlog exceeds 500: the window fills with today's
  // not-yet-final games while older, already-final gradeable plays sit beyond
  // the cutoff and never settle — which also freezes calibration, since
  // calibration reads only settled rows. This path orders OLDEST-first so the
  // grader always drains the backlog from the bottom, and lifts the cap so a
  // multi-day backlog can recover in a single cycle.
  async getPendingPlaysForGrading(limit = 5000): Promise<PersistedPlay[]> {
    return await db
      .select()
      .from(persistedPlays)
      .where(isNull(persistedPlays.result))
      .orderBy(asc(persistedPlays.timestamp))
      .limit(Math.max(1, Math.min(limit, 20000)));
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
    // Phase 9.1 — exclude "void" (DNP) plays from settled counts. They are
    // terminal but financially neutral and should not inflate hit-rate
    // denominators or bucket totals.
    const settled = rows.filter(r => r.result !== null && r.result !== "void");
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

  /**
   * Like getAllSettledPlays but WITHOUT the `result IS NOT NULL` filter, so it
   * returns settled AND pending plays in the window. Used by the buyer track
   * record so surfaced/pending counts are honest. Same canonKey dedup (keep the
   * highest signalScore per unique signal) for consistent "unique surfaced" math.
   */
  async getPlaysInRange(opts?: { sport?: string; startDate?: string; endDate?: string }): Promise<PersistedPlay[]> {
    const conds = [] as any[];
    if (opts?.sport) conds.push(sql`${persistedPlays.sport} = ${opts.sport}`);
    if (opts?.startDate) conds.push(sql`${persistedPlays.gameDate} >= ${opts.startDate}`);
    if (opts?.endDate) conds.push(sql`${persistedPlays.gameDate} <= ${opts.endDate}`);
    const rows = conds.length > 0
      ? await db.select().from(persistedPlays).where(and(...conds)).orderBy(desc(persistedPlays.timestamp))
      : await db.select().from(persistedPlays).orderBy(desc(persistedPlays.timestamp));

    const seen = new Map<string, PersistedPlay>();
    for (const row of rows) {
      const canonKey = `${row.playerId ?? row.playerName}|${row.market}|${row.direction}|${row.gameId}|${row.gameDate}`;
      const existing = seen.get(canonKey);
      if (!existing) {
        seen.set(canonKey, row);
      } else if (Number(row.signalScore ?? 0) > Number(existing.signalScore ?? 0)) {
        seen.set(canonKey, row);
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

  // Task #134 — Free user activation rail analytics.
  async recordRailEvent(data: { userId?: number | null; eventType: string; source?: string; exhausted?: boolean | null; playsUsedToday?: number | null; playsLimit?: number | null }): Promise<void> {
    await db.insert(railEvents).values({
      userId: data.userId ?? null,
      eventType: data.eventType,
      source: data.source ?? "free_activation_rail",
      exhausted: data.exhausted ?? null,
      playsUsedToday: data.playsUsedToday ?? null,
      playsLimit: data.playsLimit ?? null,
    });
  }

  async getRailEventStats(rangeDays: number): Promise<RailEventStats> {
    const days = Math.max(1, Math.min(90, Math.floor(rangeDays || 7)));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const rows = await db
      .select({
        eventType: railEvents.eventType,
        exhausted: railEvents.exhausted,
        createdAt: railEvents.createdAt,
      })
      .from(railEvents)
      .where(gte(railEvents.createdAt, cutoff));

    let impressions = 0;
    let primaryCtaClicks = 0;
    let alertsCtaClicks = 0;
    let upgradeModalOpens = 0;
    let exhaustedPrimaryClicks = 0;
    const perDayMap = new Map<string, { impressions: number; primaryCtaClicks: number; alertsCtaClicks: number; upgradeModalOpens: number }>();

    for (const r of rows) {
      const day = r.createdAt
        ? new Date(r.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
        : "unknown";
      if (!perDayMap.has(day)) {
        perDayMap.set(day, { impressions: 0, primaryCtaClicks: 0, alertsCtaClicks: 0, upgradeModalOpens: 0 });
      }
      const bucket = perDayMap.get(day)!;
      switch (r.eventType) {
        case "impression":
          impressions++;
          bucket.impressions++;
          break;
        case "primary_cta_click":
          primaryCtaClicks++;
          bucket.primaryCtaClicks++;
          if (r.exhausted) exhaustedPrimaryClicks++;
          break;
        case "alerts_cta_click":
          alertsCtaClicks++;
          bucket.alertsCtaClicks++;
          break;
        case "upgrade_modal_opened":
          upgradeModalOpens++;
          bucket.upgradeModalOpens++;
          break;
      }
    }

    const pct = (num: number, denom: number) => (denom > 0 ? Math.round((num / denom) * 1000) / 10 : 0);

    const perDay = Array.from(perDayMap.entries())
      .map(([date, b]) => ({ date, ...b }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    return {
      rangeDays: days,
      impressions,
      primaryCtaClicks,
      alertsCtaClicks,
      upgradeModalOpens,
      primaryCtrPct: pct(primaryCtaClicks, impressions),
      alertsCtrPct: pct(alertsCtaClicks, impressions),
      upgradeConversionPct: pct(upgradeModalOpens, impressions),
      exhaustedPrimaryClicks,
      perDay,
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

  /**
   * Recent per-AB contact events for a batch of players, since `sinceUtc`.
   * Used by the Pre-Game Power Radar's near-HR recent-form component to
   * retroactively classify prior-game contact quality (never the game
   * currently being scored — the caller enforces that boundary).
   */
  async getRecentContactEventsForPlayers(
    playerIds: string[],
    sinceUtc: Date,
  ): Promise<Array<{
    playerId: string;
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    isBarrel: boolean;
    result: string | null;
    timestamp: Date;
  }>> {
    if (playerIds.length === 0) return [];
    try {
      const rows = await db
        .select({
          playerId: contactEvents.playerId,
          exitVelocity: contactEvents.exitVelocity,
          launchAngle: contactEvents.launchAngle,
          distance: contactEvents.distance,
          isBarrel: contactEvents.isBarrel,
          result: contactEvents.result,
          timestamp: contactEvents.timestamp,
        })
        .from(contactEvents)
        .where(and(inArray(contactEvents.playerId, playerIds), gte(contactEvents.timestamp, sinceUtc)));
      return rows.map((r) => ({
        playerId: r.playerId,
        exitVelocity: r.exitVelocity != null ? Number(r.exitVelocity) : null,
        launchAngle: r.launchAngle != null ? Number(r.launchAngle) : null,
        distance: r.distance != null ? Number(r.distance) : null,
        isBarrel: r.isBarrel ?? false,
        result: r.result ?? null,
        timestamp: r.timestamp ?? new Date(),
      }));
    } catch (err: any) {
      console.warn(`[ContactEvent] getRecentContactEventsForPlayers failed: ${err.message}`);
      return [];
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

  // Phase 2 — per-game stat lines (slot + AB/H/TB/BB) for batting-order split
  // aggregation. Read-only; newest-first, capped to a season window.
  async getBatterOrderSplitRows(playerId: string, limit = 600): Promise<Array<{
    battingOrderSlot: number | null;
    ab: number | null;
    h: number | null;
    tb: number | null;
    bb: number | null;
  }>> {
    const rows = await db
      .select({
        battingOrderSlot: gamePlayerStats.battingOrderSlot,
        ab: gamePlayerStats.ab,
        h: gamePlayerStats.h,
        tb: gamePlayerStats.tb,
        bb: gamePlayerStats.bb,
      })
      .from(gamePlayerStats)
      .where(eq(gamePlayerStats.playerId, playerId))
      .orderBy(desc(gamePlayerStats.createdAt))
      .limit(limit);
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

  // ── Pass 6 — Lifecycle reporting (admin-only consumer) ────────────────
  async getLifecycleMetrics() {
    // Single round-trip aggregate over the lifecycle columns from Pass 2.
    // Defensive: counts use FILTER so missing/NULL values just contribute 0.
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE trial_started_at IS NOT NULL)::int AS trial_starts_lifetime,
        COUNT(*) FILTER (WHERE subscription_status = 'trialing')::int AS trial_active,
        COUNT(*) FILTER (WHERE trial_abandoned_at IS NOT NULL)::int AS trial_dropoff_lifetime,
        COUNT(*) FILTER (WHERE converted_to_paid_at IS NOT NULL)::int AS trial_converted_lifetime,
        COUNT(*) FILTER (WHERE churned_at IS NOT NULL)::int AS paid_churn_lifetime,
        COUNT(*) FILTER (WHERE cancel_at_period_end = TRUE)::int AS cancel_at_period_end
      FROM users
    `);
    const counts = result.rows[0] as {
      trial_starts_lifetime: number;
      trial_active: number;
      trial_dropoff_lifetime: number;
      trial_converted_lifetime: number;
      paid_churn_lifetime: number;
      cancel_at_period_end: number;
    };

    const distRows = async (column: string): Promise<Record<string, number>> => {
      const r = await db.execute(sql`
        SELECT COALESCE(${sql.raw(column)}, 'unknown') AS key, COUNT(*)::int AS n
        FROM users
        GROUP BY 1
      `);
      const out: Record<string, number> = {};
      for (const row of r.rows as Array<{ key: string; n: number }>) {
        out[row.key] = row.n;
      }
      return out;
    };

    const [alertsChannelStatus, telegramConnectionStatus, subscriptionSource] = await Promise.all([
      distRows("alerts_channel_status"),
      distRows("telegram_connection_status"),
      distRows("subscription_source"),
    ]);

    const trialStarts = counts.trial_starts_lifetime;
    const trialConverted = counts.trial_converted_lifetime;
    const trialConversionPct = trialStarts > 0
      ? Math.round((trialConverted / trialStarts) * 1000) / 10 // one decimal
      : null;

    return {
      counts: {
        trialStartsLifetime: counts.trial_starts_lifetime,
        trialActive: counts.trial_active,
        trialDropoffLifetime: counts.trial_dropoff_lifetime,
        trialConvertedToPaidLifetime: counts.trial_converted_lifetime,
        paidChurnLifetime: counts.paid_churn_lifetime,
        cancelAtPeriodEnd: counts.cancel_at_period_end,
      },
      rates: {
        trialConversionPct,
      },
      alertsChannelStatus,
      telegramConnectionStatus,
      subscriptionSource,
    };
  }

  // ── MLB Pre-Game Power Radar (additive; never feeds ROI) ──────────────────
  async upsertPregamePowerRadarSignal(row: InsertPregamePowerRadarSignal): Promise<void> {
    // Conflict on signalId (PK) — deterministic from sessionDate/gameId/batterId,
    // so this is idempotent across repeated builds.
    //
    // Graded truth is written ONCE by the shadow grader and must never be
    // clobbered by a later ungraded copy of the same signal: every snapshot
    // rebuild re-persists the full slate with outcomes=null / gradedAt=null /
    // status="active"|"locked", which used to wipe the day's pregame wins from
    // the DB (empty daily cashed log / record). Outcome-bearing fields therefore
    // merge instead of overwrite: a non-null incoming value wins, a null
    // incoming value preserves what the grader already stamped.
    await db
      .insert(pregamePowerRadarSignals)
      .values(row)
      .onConflictDoUpdate({
        target: pregamePowerRadarSignals.signalId,
        set: {
          buildId: row.buildId,
          gameStatus: row.gameStatus,
          firstPitchLockEligible: row.firstPitchLockEligible,
          pitcherId: row.pitcherId ?? null,
          pitcherName: row.pitcherName ?? null,
          battingOrderSlot: row.battingOrderSlot ?? null,
          primaryMarket: row.primaryMarket,
          marketTags: row.marketTags,
          marketScores: row.marketScores,
          score10: row.score10,
          tier: row.tier,
          drivers: row.drivers,
          warnings: row.warnings,
          diagnostics: row.diagnostics,
          lineupStatus: row.lineupStatus,
          weatherStatus: row.weatherStatus,
          // "graded" is terminal — a rebuild's "active"/"locked" never demotes it.
          status: sql`CASE WHEN ${pregamePowerRadarSignals.status} = 'graded' THEN ${pregamePowerRadarSignals.status} ELSE excluded.status END`,
          suppressed: row.suppressed,
          suppressedReasons: row.suppressedReasons,
          outcomes: sql`COALESCE(excluded.outcomes, ${pregamePowerRadarSignals.outcomes})`,
          everPubliclyFlagged: sql`${pregamePowerRadarSignals.everPubliclyFlagged} OR excluded.ever_publicly_flagged`,
          becameLiveReady: sql`${pregamePowerRadarSignals.becameLiveReady} OR excluded.became_live_ready`,
          becameLiveFire: sql`${pregamePowerRadarSignals.becameLiveFire} OR excluded.became_live_fire`,
          convertedLiveAt: sql`COALESCE(excluded.converted_live_at, ${pregamePowerRadarSignals.convertedLiveAt})`,
          // First lock time sticks — later rebuilds of a live game re-stamp it.
          lockedAt: sql`COALESCE(${pregamePowerRadarSignals.lockedAt}, excluded.locked_at)`,
          gradedAt: sql`COALESCE(excluded.graded_at, ${pregamePowerRadarSignals.gradedAt})`,
          updatedAt: new Date(),
        },
      });
  }

  async getPregamePowerRadarSignalsByDate(sessionDate: string): Promise<PregamePowerRadarSignalRow[]> {
    return db
      .select()
      .from(pregamePowerRadarSignals)
      .where(eq(pregamePowerRadarSignals.sessionDate, sessionDate));
  }

  async getPregamePowerRadarSignalsByGame(sessionDate: string, gameId: string): Promise<PregamePowerRadarSignalRow[]> {
    return db
      .select()
      .from(pregamePowerRadarSignals)
      .where(and(
        eq(pregamePowerRadarSignals.sessionDate, sessionDate),
        eq(pregamePowerRadarSignals.gameId, gameId),
      ));
  }

  async recordPregamePowerBuild(build: InsertPregamePowerRadarBuild): Promise<void> {
    await db
      .insert(pregamePowerRadarBuilds)
      .values(build)
      .onConflictDoUpdate({
        target: pregamePowerRadarBuilds.buildId,
        set: {
          completedAt: build.completedAt ?? null,
          gamesScanned: build.gamesScanned ?? 0,
          battersEvaluated: build.battersEvaluated ?? 0,
          lineupCoverage: build.lineupCoverage ?? null,
          weatherCoverage: build.weatherCoverage ?? null,
          batterCoverage: build.batterCoverage ?? null,
          pitcherCoverage: build.pitcherCoverage ?? null,
          signalsCreated: build.signalsCreated ?? 0,
          suppressedCount: build.suppressedCount ?? 0,
          status: build.status ?? "complete",
          error: build.error ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async getLatestPregamePowerBuild(sessionDate: string): Promise<PregamePowerRadarBuildRow | null> {
    const rows = await db
      .select()
      .from(pregamePowerRadarBuilds)
      .where(eq(pregamePowerRadarBuilds.sessionDate, sessionDate))
      .orderBy(desc(pregamePowerRadarBuilds.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async upsertMlbMoundRadarSignal(row: InsertMlbMoundRadarSignal): Promise<void> {
    // Mirrors upsertPregamePowerRadarSignal's merge discipline: outcome-bearing
    // fields merge (non-null incoming wins) rather than overwrite, so a later
    // ungraded rebuild can never clobber the grader's already-stamped truth.
    await db
      .insert(mlbMoundRadarSignals)
      .values(row)
      .onConflictDoUpdate({
        target: mlbMoundRadarSignals.signalId,
        set: {
          buildId: row.buildId,
          gameStatus: row.gameStatus,
          firstPitchLockEligible: row.firstPitchLockEligible,
          opposingLineupConfirmed: row.opposingLineupConfirmed ?? false,
          primaryMarket: row.primaryMarket,
          marketTags: row.marketTags,
          marketScores: row.marketScores,
          score10: row.score10,
          tier: row.tier,
          drivers: row.drivers,
          warnings: row.warnings,
          diagnostics: row.diagnostics,
          lineupStatus: row.lineupStatus,
          weatherStatus: row.weatherStatus,
          // "graded" is terminal — a rebuild's "active"/"locked" never demotes it.
          status: sql`CASE WHEN ${mlbMoundRadarSignals.status} = 'graded' THEN ${mlbMoundRadarSignals.status} ELSE excluded.status END`,
          suppressed: row.suppressed,
          suppressedReasons: row.suppressedReasons,
          outcomes: sql`COALESCE(excluded.outcomes, ${mlbMoundRadarSignals.outcomes})`,
          everPubliclyFlagged: sql`${mlbMoundRadarSignals.everPubliclyFlagged} OR excluded.ever_publicly_flagged`,
          becameLiveReady: sql`${mlbMoundRadarSignals.becameLiveReady} OR excluded.became_live_ready`,
          becameLiveFire: sql`${mlbMoundRadarSignals.becameLiveFire} OR excluded.became_live_fire`,
          convertedLiveAt: sql`COALESCE(excluded.converted_live_at, ${mlbMoundRadarSignals.convertedLiveAt})`,
          lockedAt: sql`COALESCE(${mlbMoundRadarSignals.lockedAt}, excluded.locked_at)`,
          gradedAt: sql`COALESCE(excluded.graded_at, ${mlbMoundRadarSignals.gradedAt})`,
          updatedAt: new Date(),
        },
      });
  }

  async getMlbMoundRadarSignalsByDate(sessionDate: string): Promise<MlbMoundRadarSignalRow[]> {
    return db
      .select()
      .from(mlbMoundRadarSignals)
      .where(eq(mlbMoundRadarSignals.sessionDate, sessionDate));
  }

  async getMlbMoundRadarSignalsByGame(sessionDate: string, gameId: string): Promise<MlbMoundRadarSignalRow[]> {
    return db
      .select()
      .from(mlbMoundRadarSignals)
      .where(and(
        eq(mlbMoundRadarSignals.sessionDate, sessionDate),
        eq(mlbMoundRadarSignals.gameId, gameId),
      ));
  }

  async recordMlbMoundRadarBuild(build: InsertMlbMoundRadarBuild): Promise<void> {
    await db
      .insert(mlbMoundRadarBuilds)
      .values(build)
      .onConflictDoUpdate({
        target: mlbMoundRadarBuilds.buildId,
        set: {
          completedAt: build.completedAt ?? null,
          gamesScanned: build.gamesScanned ?? 0,
          pitchersEvaluated: build.pitchersEvaluated ?? 0,
          starterCoverage: build.starterCoverage ?? null,
          weatherCoverage: build.weatherCoverage ?? null,
          pitcherCoverage: build.pitcherCoverage ?? null,
          lineupCoverage: build.lineupCoverage ?? null,
          signalsCreated: build.signalsCreated ?? 0,
          suppressedCount: build.suppressedCount ?? 0,
          status: build.status ?? "complete",
          error: build.error ?? null,
          updatedAt: new Date(),
        },
      });
  }

  async getLatestMlbMoundRadarBuild(sessionDate: string): Promise<MlbMoundRadarBuildRow | null> {
    const rows = await db
      .select()
      .from(mlbMoundRadarBuilds)
      .where(eq(mlbMoundRadarBuilds.sessionDate, sessionDate))
      .orderBy(desc(mlbMoundRadarBuilds.startedAt))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Task #129 — batter rolling stat snapshots ──────────────────────────
  async upsertBatterRollingSnapshot(snap: InsertBatterRollingSnapshot): Promise<void> {
    await db
      .insert(batterRollingSnapshots)
      .values(snap)
      .onConflictDoUpdate({
        target: [batterRollingSnapshots.playerId, batterRollingSnapshots.sessionDate],
        set: {
          playerName: snap.playerName ?? null,
          seasonHRRate: snap.seasonHRRate ?? null,
          hrRateLast30: snap.hrRateLast30 ?? null,
          barrelRate: snap.barrelRate ?? null,
          season: snap.season ?? null,
          isHotHitter: snap.isHotHitter ?? false,
          source: snap.source ?? "nightly_cron",
          updatedAt: new Date(),
        },
      });
  }

  async getBatterRollingSnapshot(playerId: string, sessionDate: string): Promise<BatterRollingSnapshot | null> {
    const rows = await db
      .select()
      .from(batterRollingSnapshots)
      .where(and(
        eq(batterRollingSnapshots.playerId, playerId),
        eq(batterRollingSnapshots.sessionDate, sessionDate),
      ))
      .limit(1);
    return rows[0] ?? null;
  }

  async getBatterRollingSnapshotsForDateRange(from: string, to: string): Promise<BatterRollingSnapshot[]> {
    return await db
      .select()
      .from(batterRollingSnapshots)
      .where(and(
        gte(batterRollingSnapshots.sessionDate, from),
        lte(batterRollingSnapshots.sessionDate, to),
      ));
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
    // Phase 1 — alert tier fields exposed for tiered called_hit derivation.
    // Populated from the matched alert row's persisted fields. Null on paths
    // that have no alert (early_hr_no_window, no-alert uncalled_hr, error).
    alertTier: string | null;
    alertConfidenceTier: string | null;
    alertSignalState: string | null;
    alertPath: string | null;
    alertPeakReadinessScore: number | null;
    // FIRE-only grading (2026-06) — peak calibrated HR-conversion probability
    // from the matched alert's diagnosticsSnapshot.scoreContract, so the win
    // side can apply the same `reachedFireCommitment` gate as the miss side.
    alertPeakConversionProbability: number | null;
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
            try {
              traceMissedHr({
                gameId: params.gameId, playerId: params.playerId,
                hrInning: params.hrInning, hrHalf: params.hrHalf,
                gradingStatus: "early_hr_no_window",
                gradingReason: "first-inning HR with no realistic pre-signal window",
              });
            } catch {}
            return {
              matched: false, matchedBeforeHr: false, isLateSignal: false,
              alertId: null, signalEventId: null,
              signalDetectedAt: null, signalInning: null, signalHalf: null,
              gradingStatus: "early_hr_no_window" as any,
              gradingReason: "first-inning HR with no realistic pre-signal window — exempt from uncalled-miss bucket",
              matchMethod: "none",
              alertTier: null, alertConfidenceTier: null, alertSignalState: null,
              alertPath: null, alertPeakReadinessScore: null, alertPeakConversionProbability: null,
            };
          }
        }
        try {
          traceMissedHr({
            gameId: params.gameId, playerId: params.playerId,
            hrInning: params.hrInning, hrHalf: params.hrHalf,
            gradingStatus: "uncalled_hr",
            gradingReason: "no canonical hr_radar_alert row exists for player/game",
          });
        } catch {}
        return {
          matched: false, matchedBeforeHr: false, isLateSignal: false,
          alertId: null, signalEventId: null,
          signalDetectedAt: null, signalInning: null, signalHalf: null,
          gradingStatus: "uncalled_hr",
          gradingReason: "no canonical hr_radar_alert row exists for player/game",
          matchMethod: "none",
          alertTier: null, alertConfidenceTier: null, alertSignalState: null,
          alertPath: null, alertPeakReadinessScore: null, alertPeakConversionProbability: null,
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

      // Recall / lead-time measurement taps (read-only, never throw).
      try {
        if (decision.gradingStatus === "called_hit" && hrEnd != null) {
          // Prefer the matched qualifying-event time (the true pre-HR signal
          // moment) over the alert-row timestamp, which can drift to/after
          // hrEnd. emitCalledHitLeadTime clamps a non-positive/inconsistent
          // lead to null so the hit still counts toward recall but is excluded
          // from the lead-time distribution.
          const sigMs = (lastQualifyingEvent?.detectedAt ?? decision.signalDetectedAt ?? alert.signalDetectedAt ?? alert.detectedAt)?.getTime?.();
          const lead = typeof sigMs === "number" && Number.isFinite(sigMs) ? hrEnd - sigMs : null;
          emitCalledHitLeadTime({
            signalId: `mlb:${params.gameId}:${params.playerId}:home_runs:OVER`,
            gameId: params.gameId, playerId: params.playerId,
            leadTimeMs: lead,
            alertPath: alert.alertPath ?? null,
          });
        } else if (decision.gradingStatus === "late_signal") {
          traceMissedHr({
            gameId: params.gameId, playerId: params.playerId,
            hrInning: params.hrInning, hrHalf: params.hrHalf,
            gradingStatus: "late_signal",
            gradingReason: decision.gradingReason,
            alertPath: alert.alertPath ?? null,
            alertSignalState: alert.signalState ?? null,
          });
        }

        // Precision instrumentation — terminal outcome for HR radar signals.
        // called_hit → cashed, called_miss → missed. (late_signal is a recall
        // miss handled by the tracer above, not a precision miss.) This
        // populates hr_radar_cashed/hr_radar_missed for the shadow rollups.
        if (decision.gradingStatus === "called_hit" || decision.gradingStatus === "called_miss") {
          const { emitHrRadarOutcome } = require("./analytics/eventEmitters");
          const peakScore10 = alert.peakReadinessScore != null
            ? Math.round((Number(alert.peakReadinessScore) / 10) * 10) / 10
            : null;
          emitHrRadarOutcome({
            signalId: `mlb:${params.gameId}:${params.playerId}:home_runs:OVER`,
            gameId: params.gameId, playerId: params.playerId,
            kind: decision.gradingStatus === "called_hit" ? "cashed" : "missed",
            signalPath: alert.alertPath ?? null,
            score10: peakScore10,
            finalStage: (alert as any).userStage ?? alert.signalState ?? null,
            gradingStatus: decision.gradingStatus,
          });
        }
      } catch {}

      // Phase 1 — enrich decision with the matched alert's persisted tier
      // fields so the grader can derive a tiered called_hit_* status.
      const peakRaw = (alert as any).peakReadinessScore;
      const peakNum = peakRaw == null ? null : Number(peakRaw);
      return {
        ...decision,
        alertTier: alert.alertTier ?? null,
        alertConfidenceTier: alert.confidenceTier ?? null,
        alertSignalState: alert.signalState ?? null,
        alertPath: alert.alertPath ?? null,
        alertPeakReadinessScore: Number.isFinite(peakNum as number) ? (peakNum as number) : null,
        alertPeakConversionProbability: extractPeakConversionProbability(alert.diagnosticsSnapshot),
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
        alertTier: null, alertConfidenceTier: null, alertSignalState: null,
        alertPath: null, alertPeakReadinessScore: null, alertPeakConversionProbability: null,
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
     * Task #140 — raw dynamic engine state from hrAlertEngine snapshot
     * (`HRAlertSnapshot.currentState`). Persisted into
     * `diagnosticsSnapshot.stageContract.dynamicState` so the user-facing
     * stage layer (`mapToUserStage`) and grading harness can read the
     * engine's authoritative state directly without re-deriving from
     * canonicalStage. NEVER overwrites canonicalStage; both fields live
     * in stageContract and represent independent signal paths.
     */
    dynamicState?: "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED" | null;
    /**
     * Lane 1.4 — consecutive ticks the dynamic state has supported promotion
     * (HRAlertSnapshot.consecutivePromoteTicks). Persisted into
     * `diagnosticsSnapshot.stageContract.consecutivePromoteTicks` so the
     * user-stage layer's ready→fire gate can require sustained conviction
     * without a DB schema change. Null when caller did not provide one.
     */
    consecutivePromoteTicks?: number | null;
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
    /**
     * Pregame seed (0–PREGAME_SEED_CAP) for presence-floor rows. When present,
     * the presence-only branch persists this as the initial/current/peak
     * readiness instead of coercing to 0, so a power threat shows a non-zero
     * pregame score. Bounded here defensively. Grading detection is still NOT
     * stamped from a seed — only real in-game contact qualifies a row.
     */
    presenceSeedScore?: number | null;
    // ── Phase 0 diagnostic persistence (2026-06). All optional/additive — make
    // a future miss diagnosable from the DB alone (model weakness vs missing
    // data). Stamped from the engine's HRAlertDiagnostics when available. ──
    rawPreCapScore?: number | null;        // readiness before any data-quality cap (null until the engine surfaces it)
    finalScore?: number | null;            // readiness after caps; defaults to readinessScore
    capReason?: string | null;             // which cap bound the score
    suppressionReason?: string | null;     // below_threshold_with_full_data | below_threshold_with_degraded_data | ...
    missingInputs?: string[] | null;       // missing_statcast | degraded_contact_data | missing_batter_power | missing_handedness_splits
    confidence?: number | null;            // 0..1 confidence given data completeness
    dataQualityFlags?: string[] | null;    // full | degraded | missing markers
    promotedAtMs?: number | null;          // epoch ms when first reaching an actionable tier
    alertSentAtMs?: number | null;         // epoch ms when an alert was actually dispatched
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
      // Task #140 — persist raw dynamic engine state (BET_NOW/PREPARE/etc.)
      // so the user-stage layer reads it directly. Null when caller did
      // not provide one (e.g. presence-only rows).
      dynamicState: data.dynamicState ?? null,
      // Lane 1.4 — sustained-conviction counter for the ready→fire gate.
      consecutivePromoteTicks: data.consecutivePromoteTicks ?? null,
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
      // Task #126 — presence-only rows carry no in-game engine readiness, but
      // a pregame seed (season power profile) may be supplied so the card
      // reflects the batter instead of a bare 0.0. Bound the seed defensively
      // to [0, PREGAME_SEED_CAP]; fall back to 0 when no seed is present. This
      // is a PREGAME prior only — it never stamps grading detection (see the
      // presence-only short-circuit below), so ROI / W-L / the presence-only→
      // called_miss matcher are unchanged.
      const seed = Number(data.presenceSeedScore);
      // eslint-disable-next-line no-param-reassign
      data.readinessScore = Number.isFinite(seed)
        ? Math.max(0, Math.min(PREGAME_SEED_CAP, seed))
        : 0;
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
        // write-once. Once a row has a non-null detection inning, the
        // UPDATE set() below intentionally never includes these fields.
        // If the current tick disagrees with the persisted detection
        // inning, log loudly so any future code that tries to mutate them
        // is caught immediately. We never overwrite an existing stamp.
        if (alert.detectedInning != null && data.inning !== alert.detectedInning) {
          console.log(
            `[HR_RADAR_DETECTION_LOCKED] gameId=${data.gameId} playerId=${data.playerId} ` +
            `persistedDetected=${alert.detectedLabel} (${alert.detectedHalf}${alert.detectedInning}) ` +
            `currentTick=${data.half === "top" ? "T" : "B"}${data.inning} — preserving original`
          );
        }

        // ── HR Radar Presence→Qualified Backfill ────────────────────────
        // When a row was originally created via the Presence Floor (Task
        // #126) it carries detectedInning=NULL / signalDetectedAt=NULL by
        // design — it's a "watching" row, not yet engine-qualified. If the
        // engine LATER escalates the same player into a real qualified
        // signal (this UPDATE is non-presence and we got past the early
        // short-circuit at L3308), we must stamp the detection truth on
        // its first qualifying tick. Without this, a player who genuinely
        // reaches BET_NOW with peak readiness 100 will still grade as
        // called_miss(presence-only) at HR resolution because Branch 0 of
        // decideHrRadarMatch sees both detectedInning and signalDetectedAt
        // as NULL. T003 immutability is preserved because this branch
        // only fires when alert.detectedInning IS null (first stamp), and
        // the guardrail above forbids overwriting a non-null value.
        const promoteFromPresence = alert.detectedInning == null;
        const promotionStampInning = persistInning;
        const promotionStampHalf = persistHalf;
        const promotionStampLabel = detectedLabel;
        const promotionStampAt = new Date();
        if (promoteFromPresence) {
          console.log(
            `[HR_RADAR_PROMOTION_FROM_PRESENCE] gameId=${data.gameId} playerId=${data.playerId} ` +
            `stampingDetected=${promotionStampLabel} signalAt=${promotionStampAt.toISOString()} ` +
            `(was presence-only, engine now qualified — canonicalStage=${data.canonicalStage ?? "?"} ` +
            `tier=${data.confidenceTier} readiness=${data.readinessScore})`
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
        // never decide what the user sees on the live board.
        //
        // ── Phase 4.5 — promoted-tier floor (HR-leak fix, 2026-04-30) ────
        // Validation against 2026-04-30 found that the dynamic engine cools
        // many FAST_PROMOTE batters back to WATCH between ticks (decay /
        // deriveState consecutive-decline behavior), which forced the live
        // tier from strong/building back to monitor and hid real engine
        // signals just before HRs landed (Melendez, M.Garcia, Frelick all
        // reached historicalBestStage=building then dropped to monitor).
        // Once the row has been promoted to building or strong in this
        // game, never drop the user-visible tier below "building" — a
        // transient cool-off should never erase a real call. The dynamic
        // engine state itself is preserved in stageContract.dynamicState
        // for audit/grading, so the matcher still sees ground truth.
        //
        // The floor predicate keys off stageContract.historicalBestStage
        // (the durable record of prior promotion) rather than alert.confidenceTier
        // alone, so rows that already decayed to monitor under the prior
        // buggy logic still get re-floored once historicalBestStage is set.
        const stageRankLocal: Record<string, number> = { closed: -1, watch: 0, cooling: 1, building: 1, attack: 2 };
        const prevDiag = (alert.diagnosticsSnapshot ?? {}) as Record<string, any>;
        const prevStageContract = (prevDiag.stageContract ?? {}) as Record<string, any>;
        const prevHistorical = prevStageContract.historicalBestStage ?? null;
        const prevCanonical = prevStageContract.currentCanonicalStage ?? null;
        const incomingCanonical = data.canonicalStage ?? null;
        // Compute newHistorical first so the floor can consult it via the
        // updated rank (a fresh promotion this tick should also count).
        const newHistorical =
          incomingCanonical && (!prevHistorical || stageRankLocal[incomingCanonical] > stageRankLocal[prevHistorical])
            ? incomingCanonical
            : prevHistorical ?? incomingCanonical;

        const tierOrder: Record<string, number> = { monitor: 0, building: 1, strong: 2 };
        const liveTier = (() => {
          if (!data.canonicalStage) {
            return tierOrder[data.confidenceTier] > tierOrder[alert.confidenceTier]
              ? data.confidenceTier
              : alert.confidenceTier;
          }
          const stageTier = data.confidenceTier; // already remapped from canonicalStage above
          // Closed is terminal: a game-over or hit-resolved row must reflect
          // its final canonical state. The floor never fires on closed ticks
          // even if newHistorical / alert.confidenceTier still record prior
          // promotion (they are durable max-history values, not current).
          if (data.canonicalStage === "closed") {
            return stageTier;
          }
          // Floor: if historicalBestStage reached building/attack at any
          // point this game, never drop user-visible tier below "building".
          const historicalReachedPromotion =
            newHistorical != null &&
            newHistorical !== "closed" &&
            stageRankLocal[newHistorical] >= stageRankLocal["building"];
          if (
            tierOrder[stageTier] < tierOrder["building"] &&
            (historicalReachedPromotion ||
             tierOrder[alert.confidenceTier ?? "monitor"] >= tierOrder["building"])
          ) {
            return "building" as typeof stageTier;
          }
          return stageTier;
        })();
        const mergedDiag = {
          ...(data.diagnosticsSnapshot as Record<string, unknown>),
          stageContract: {
            currentCanonicalStage: incomingCanonical,
            historicalBestStage: newHistorical,
            previousCanonicalStage: prevCanonical,
            // Task #140 — refresh raw dynamic engine state on every UPDATE.
            // Preserves prior value when caller does not pass a new one
            // (defensive — every live tick should pass it).
            dynamicState: data.dynamicState ?? prevStageContract.dynamicState ?? null,
            // Lane 1.4 — refresh sustained-conviction counter on every UPDATE.
            consecutivePromoteTicks:
              data.consecutivePromoteTicks ?? prevStageContract.consecutivePromoteTicks ?? null,
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
            // ── Phase 0 diagnostic persistence — these fields describe the
            // CURRENT tick's data-quality/gate state, so they must reflect the
            // incoming value (an explicit `null` CLEARS a stale gate reason).
            // We only preserve the prior value when the caller OMITS the field
            // entirely (`undefined`) — e.g. a presence-floor path that doesn't
            // evaluate suppression — never when it explicitly passes null.
            // Set-once timestamps (firstSeenAt/promotedAt/alertSentAt) are the
            // exception and stay first-stamp only.
            rawPreCapScore: data.rawPreCapScore !== undefined ? (data.rawPreCapScore != null ? String(data.rawPreCapScore) : null) : alert.rawPreCapScore,
            finalScore: String(data.finalScore ?? newScore),
            capReason: data.capReason !== undefined ? data.capReason : alert.capReason,
            suppressionReason: data.suppressionReason !== undefined ? data.suppressionReason : alert.suppressionReason,
            missingInputs: data.missingInputs !== undefined ? data.missingInputs : alert.missingInputs,
            confidence: data.confidence !== undefined ? (data.confidence != null ? String(data.confidence) : null) : alert.confidence,
            dataQualityFlags: data.dataQualityFlags !== undefined ? data.dataQualityFlags : alert.dataQualityFlags,
            promotedAt: alert.promotedAt ?? (data.promotedAtMs != null ? new Date(data.promotedAtMs) : null),
            alertSentAt: alert.alertSentAt ?? (data.alertSentAtMs != null ? new Date(data.alertSentAtMs) : null),
            // ── Presence→Qualified one-time backfill (see comment above) ──
            // These fields are only included when the row is being promoted
            // from presence-only to engine-qualified. T003 immutability is
            // preserved: this is a NULL→value first-stamp, never an
            // overwrite. After this update, alert.detectedInning is
            // non-null and the guardrail at L3322 prevents further changes.
            ...(promoteFromPresence
              ? {
                  detectedInning: promotionStampInning,
                  detectedHalf: promotionStampHalf,
                  detectedLabel: promotionStampLabel,
                  detectedAt: promotionStampAt,
                  signalDetectedAt: promotionStampAt,
                  signalInning: promotionStampInning,
                  signalHalf: promotionStampHalf,
                }
              : {}),
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
        // ── Phase 0 diagnostic persistence ──
        rawPreCapScore: data.rawPreCapScore != null ? String(data.rawPreCapScore) : null,
        finalScore: String(data.finalScore ?? data.readinessScore),
        capReason: data.capReason ?? null,
        suppressionReason: data.suppressionReason ?? null,
        missingInputs: data.missingInputs ?? null,
        confidence: data.confidence != null ? String(data.confidence) : null,
        dataQualityFlags: data.dataQualityFlags ?? null,
        firstSeenAt: detectedAtForRow,
        promotedAt: data.promotedAtMs != null ? new Date(data.promotedAtMs) : null,
        alertSentAt: data.alertSentAtMs != null ? new Date(data.alertSentAtMs) : null,
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
        // Phase 1 (3-tier ladder) — only HR-Max-Window signals are graded as
        // a counted win, symmetric with the miss side. A signal that preceded
        // the HR but never reached the actionable top tier (Watch/Building) is
        // stamped `uncalled_hr` (diagnostic, NOT a counted cash) rather than a
        // tiered called_hit. Otherwise derive the tiered called_hit status from
        // the matched alert's persisted tier fields.
        const reachedMax = reachedHrMaxWindow({
          alertTier: matchResult.alertTier,
          confidenceTier: matchResult.alertConfidenceTier,
          signalState: matchResult.alertSignalState,
        });
        // FIRE-only official record (2026-06) — symmetric with the miss side.
        // A pre-HR signal is a counted called_hit ONLY if it reached the FIRE
        // commitment (FAST_PROMOTE_ELITE path OR peak HR-conversion in the
        // BET_NOW band). A READY-only precursor that happened to precede the HR
        // is stamped `uncalled_hr` (diagnostic, not counted) so it cannot
        // inflate the official win count.
        const fireCommitted = reachedFireCommitment({
          alertPath: matchResult.alertPath,
          peakConversionProbability: matchResult.alertPeakConversionProbability,
        });
        const officialCall = reachedMax && fireCommitted;
        const tieredStatus = officialCall
          ? inferCashedFromTierStatus({
              alertTier: matchResult.alertTier,
              confidenceTier: matchResult.alertConfidenceTier,
              signalState: matchResult.alertSignalState,
            })
          : "uncalled_hr";
        const result = matchResult.alertId
          ? await db.update(hrRadarAlerts)
              .set({
                status: "hit",
                hitInning: hitInningNum,
                hitHalf: hitHalfVal,
                hitLabel: hitLabelVal,
                hitDetectedAt: hrEndTimeMs ? new Date(hrEndTimeMs) : nowDate,
                resolvedAt: nowDate,
                gradingStatus: tieredStatus,
                gradingReason: officialCall
                  ? matchResult.gradingReason
                  : `${matchResult.gradingReason} — ${reachedMax ? "READY-only (never reached FIRE commitment)" : "sub-actionable (Watch/Building)"} pre-HR signal; HR not credited as a called pick`,
                matchedBeforeHr: true,
                fallbackCreated: false,
                userVisible: officialCall,
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
          if (officialCall) {
            console.log(`[HR_RADAR_CALLED_HIT] playerId=${playerId} gameId=${gameId} signalLabel=${matchResult.signalHalf}${matchResult.signalInning ?? ""} hitLabel=${hitLabelVal} tieredStatus=${tieredStatus} alertTier=${matchResult.alertTier ?? "n/a"} reason="${matchResult.gradingReason}"`);
          } else {
            console.log(`[HR_RADAR_UNCALLED_HR] (${reachedMax ? "READY-only, not FIRE" : "sub-actionable"} pre-HR signal) playerId=${playerId} gameId=${gameId} hitLabel=${hitLabelVal} alertTier=${matchResult.alertTier ?? "n/a"} confTier=${matchResult.alertConfidenceTier ?? "n/a"} signalState=${matchResult.alertSignalState ?? "n/a"} alertPath=${matchResult.alertPath ?? "n/a"} peakConv=${matchResult.alertPeakConversionProbability ?? "null"} — not counted as a win`);
          }
          console.log(`[HR_LEDGER_GRADE] outcome=${tieredStatus} sessionDate=${today} gameId=${gameId} playerId=${playerId} signalInning=${matchResult.signalInning ?? "n/a"}${matchResult.signalHalf ?? ""} hitInning=${hitInningNum}${hitHalfVal} alertId=${matchResult.alertId} matchMethod=${matchResult.matchMethod}`);
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
          // Goldmaster Phase 9 — canonical alias. FIRE-only (2026-06): emit the
          // called-hit alias ONLY for an official FIRE-committed win, so the
          // signal-event stream agrees with gradingStatus. A READY-only /
          // sub-actionable HR is `uncalled_hr` and gets no called-hit alias.
          if (officialCall) {
            await this.appendHrRadarSignalEvent({
              sessionDate: today, gameId, playerId, team: "",
              alertId: matchResult.alertId,
              eventType: "resolved_called_hit",
              detectedAt: nowDate, inning: hitInningNum, half: hitHalfVal,
              source: "grader",
            } as InsertHrRadarSignalEvent);
          }
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
        // HR Radar Settlement Repair — Bug #5: presence-only rows (which the
        // matcher tags with the verbatim marker "[presence-only]" in the
        // gradingReason) must NOT surface as user-visible "called miss"
        // outcomes. The user reasonably remembers the batter sitting on the
        // HR board (presence floor surfaces power-threat batters who never
        // crossed PATH A-E) and a HR by them showing up as "we said miss"
        // is the symptom we're closing. Admin-only persistence preserved.
        const isPresenceOnly = String(matchResult.gradingReason ?? "").includes("[presence-only]");
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
            userVisible: !isPresenceOnly,
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
    // Phase 2 — orchestrator-known game-level AB index. When 0, the HR was
    // the first AB of the game ⇒ no realistic pre-call window for ANY player
    // in the game. Used to broaden the early-HR exemption beyond inning 1.
    atBatIndex?: number | null;
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
          // HR Radar Settlement Repair — Bug #3: if the live alert had
          // already crossed PATH A-E before the race fired (confidenceTier ∈
          // {strong, elite/actionable} OR signalState ∈ {actionable, fire}
          // OR alertTier="official_alert"), credit it as called_hit instead
          // of hiding behind late_signal. The race is between the matcher
          // and the qualifying-event write — penalizing the user for an
          // engine plumbing race produces the "I saw it on the Board but
          // it's gone" symptom.
          const e = existing[0] as any;
          // Phase 1 (3-tier ladder) — credit the race-rescued cash ONLY when
          // the alert reached the HR Max Window (actionable top tier). Bare
          // `prepare`/Building no longer qualifies as a counted win; it falls
          // through to the late_signal/diagnostic branch below. Symmetric with
          // the per-poll and reconcile cash paths.
          const wasQualified = reachedHrMaxWindow({
            alertTier: e.alertTier ?? null,
            confidenceTier: e.confidenceTier ?? null,
            signalState: e.signalState ?? null,
          });
          // FIRE-only official record (2026-06) — a race-rescued cash is only
          // counted when the alert reached the FIRE commitment; a READY-only
          // precursor falls through to the diagnostic uncalled_hr branch below.
          const fireCommitted = reachedFireCommitment({
            alertPath: e.alertPath ?? null,
            peakConversionProbability: extractPeakConversionProbability(e.diagnosticsSnapshot),
          });
          if (wasQualified && fireCommitted) {
            const tieredStatus = inferCashedFromTierStatus({
              alertTier: e.alertTier ?? null,
              confidenceTier: e.confidenceTier ?? null,
              signalState: e.signalState ?? null,
            });
            await db.update(hrRadarAlerts)
              .set({
                status: "hit",
                hitInning: data.inning,
                hitHalf: halfLabel,
                hitLabel: data.hitLabel,
                hitDetectedAt: nowDate,
                resolvedAt: nowDate,
                gradingStatus: tieredStatus,
                gradingReason: "ensure-fallback rescued: alert had crossed PATH A-E + reached FIRE commitment (qualified pre-HR) — race against qualifying-event write",
                matchedBeforeHr: true,
                fallbackCreated: false,
                userVisible: true,
                matchMethod: "post_hr_fallback",
              })
              .where(eq(hrRadarAlerts.id, existing[0].id));
            console.log(`[HR_RADAR_CALLED_HIT] (ensure-rescue) playerId=${data.playerId} gameId=${data.gameId} tieredStatus=${tieredStatus} confTier=${e.confidenceTier ?? null} signalState=${e.signalState ?? null} alertTier=${e.alertTier ?? null}`);
          } else {
            // Not a counted cash: the alert never crossed PATH A-E (sub-actionable)
            // OR it crossed but never reached the FIRE commitment (READY-only).
            // Keep admin-only behavior so the cashed bucket isn't polluted.
            await db.update(hrRadarAlerts)
              .set({
                status: "hit",
                hitInning: data.inning,
                hitHalf: halfLabel,
                hitLabel: data.hitLabel,
                hitDetectedAt: nowDate,
                resolvedAt: nowDate,
                gradingStatus: "late_signal",
                gradingReason: wasQualified
                  ? "ensure-fallback: alert crossed PATH A-E but never reached FIRE commitment (READY-only) — not a counted cash"
                  : "ensureHrRadarAlertHit fallback fired with live alert still present — race or post-HR signal",
                matchedBeforeHr: false,
                fallbackCreated: false,
                userVisible: false,
                matchMethod: "post_hr_fallback",
              })
              .where(eq(hrRadarAlerts.id, existing[0].id));
            console.log(`[HR_RADAR_LATE_SIGNAL] (ensure-fallback) playerId=${data.playerId} gameId=${data.gameId}`);
          }
        }
        return;
      }

      // ── Phase 2 — early-HR-insufficient-sample exemption ────────────────
      // The original exemption only fired for inning-1 HRs with no engine
      // activity. Phase 2 broadens it to ALSO cover the first AB of the game
      // (`atBatIndex === 0`) regardless of inning — same root cause: no
      // realistic pre-HR observation window. New rows write
      // `early_hr_insufficient_sample`; legacy `early_hr_no_window` rows are
      // still recognized by the deriver in `hrRadarSection.ts`.
      const isFirstInning = (data.inning ?? 0) <= 1;
      const isFirstGameAB = (data.atBatIndex ?? -1) === 0;
      let earlyExempt = false;
      if (isFirstInning || isFirstGameAB) {
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
        triggerTags: earlyExempt ? ["auto_graded", "early_hr_insufficient_sample"] : ["auto_graded"],
        summaryText: earlyExempt
          ? `HR confirmed ${data.hitLabel} (insufficient sample — no realistic pre-call window)`
          : `HR confirmed ${data.hitLabel} (uncalled — no pre-HR engine signal)`,
        status: "hit",
        hitInning: data.inning,
        hitHalf: halfLabel,
        hitLabel: data.hitLabel,
        hitDetectedAt: nowDate,
        resolvedAt: nowDate,
        // Phase 2 — write the new canonical token. Deriver continues to map
        // legacy `early_hr_no_window` rows to the same user-facing bucket.
        gradingStatus: earlyExempt ? "early_hr_insufficient_sample" : "uncalled_hr",
        gradingReason: earlyExempt
          ? "HR occurred before any realistic pre-signal window (first inning or first AB of game) — exempt from uncalled-miss bucket"
          : "no canonical hr_radar_alert existed at time of HR resolution — admin-only analytics row",
        matchedBeforeHr: false,
        fallbackCreated: true,
        userVisible: false,
        matchMethod: "post_hr_fallback",
        // Phase 0 — this admin-only row was first materialized at HR time (no
        // pre-HR signal existed). Stamping first_seen_at lets the backtest tell
        // a row-created-at-HR (late/uncalled) apart from a true full-miss (no
        // row at all). Purely additive — no grading/attribution change.
        firstSeenAt: nowDate,
        analyticsPersisted: false,
      });
      if (earlyExempt) {
        console.log(`[HR_RADAR_EARLY_HR_INSUFFICIENT_SAMPLE] (admin-only row created) playerId=${data.playerId} player=${data.playerName} gameId=${data.gameId} hitLabel=${data.hitLabel} firstInning=${isFirstInning} firstGameAB=${isFirstGameAB}`);
      } else {
        console.log(`[HR_RADAR_UNCALLED] (admin-only row created) playerId=${data.playerId} player=${data.playerName} gameId=${data.gameId} hitLabel=${data.hitLabel}`);
        // Phase 7 — structured miss-reason logging. ONE line per true uncalled
        // HR (skips early-exempt and late-signal branches; those have their
        // own paths). Best-effort field extraction from prior signal events
        // and contact snapshots — fields default to null/false rather than
        // throwing so the log never blocks finalization. Pure logging; no
        // behavior change.
        try {
          const priorEvents = await db.select().from(hrRadarSignalEvents)
            .where(and(
              eq(hrRadarSignalEvents.gameId, data.gameId),
              eq(hrRadarSignalEvents.playerId, data.playerId),
            ));
          // Bucket prior events by signalState. Engine emits `watch`, `lean`,
          // `strong`, `elite` plus alert-flow tokens; we collapse to the four
          // tiers the UI cares about for calibration.
          let priorWatchStateExists = false;
          let priorBuildStateExists = false;
          let priorReadyStateExists = false;
          let priorAttackStateExists = false;
          let priorContactEvents = 0;
          let maxPreHrScore: number | null = null;
          let lastBatterSnapshot: any = null;
          let lastPitcherSnapshot: any = null;
          let lastDrivers: any = null;
          for (const ev of priorEvents) {
            const s = String(ev.signalState ?? "").toLowerCase();
            if (s === "watch" || s === "watching") priorWatchStateExists = true;
            if (s === "lean" || s === "build" || s === "building") priorBuildStateExists = true;
            if (s === "strong" || s === "ready") priorReadyStateExists = true;
            if (s === "elite" || s === "actionable" || s === "fire" || s === "attack") priorAttackStateExists = true;
            if (ev.eventType === "contact" || ev.eventType === "barrel" || ev.eventType === "hard_hit") priorContactEvents += 1;
            const sc = ev.score != null ? Number(ev.score) : NaN;
            if (Number.isFinite(sc)) {
              if (maxPreHrScore == null || sc > maxPreHrScore) maxPreHrScore = sc;
            }
            if (ev.batterSnapshot) lastBatterSnapshot = ev.batterSnapshot;
            if (ev.pitcherSnapshot) lastPitcherSnapshot = ev.pitcherSnapshot;
            if (ev.drivers) lastDrivers = ev.drivers;
          }
          // Closest threshold the row missed — derived from maxPreHrScore vs
          // the canonical 30/55/75 ladder. "fire@75" means we got within
          // striking distance of the FIRE bucket; useful for calibration.
          let closestThresholdMissed: string | null = null;
          if (maxPreHrScore != null) {
            if (maxPreHrScore >= 75) closestThresholdMissed = "above_fire_threshold_but_no_alert";
            else if (maxPreHrScore >= 55) closestThresholdMissed = "ready@55";
            else if (maxPreHrScore >= 30) closestThresholdMissed = "build@30";
            else closestThresholdMissed = "below_build@30";
          }
          // Diagnostics shape varies by event source; probe a handful of
          // known keys and return null when absent.
          const driverObj = (lastDrivers ?? {}) as Record<string, any>;
          const batterObj = (lastBatterSnapshot ?? {}) as Record<string, any>;
          const pitcherObj = (lastPitcherSnapshot ?? {}) as Record<string, any>;
          const suppressionReasons =
            (Array.isArray(driverObj.suppressors) && driverObj.suppressors) ||
            (Array.isArray(driverObj.softVetoes) && driverObj.softVetoes) ||
            null;
          const hitterArchetype =
            (typeof batterObj.archetype === "string" && batterObj.archetype) ||
            (typeof batterObj.batterArchetype === "string" && batterObj.batterArchetype) ||
            null;
          const pitcherFade: number | null =
            typeof pitcherObj.pitcherFade === "number" ? pitcherObj.pitcherFade
            : typeof pitcherObj.pitcherVulnerability === "number" ? pitcherObj.pitcherVulnerability
            : null;
          const parkWeatherScore: number | null =
            typeof driverObj.parkWeatherScore === "number" ? driverObj.parkWeatherScore
            : typeof driverObj.parkWindBoost === "number" ? driverObj.parkWindBoost
            : null;
          console.log(`[HR_RADAR_MISS_REASON] ${JSON.stringify({
            playerId: data.playerId,
            player: data.playerName,
            team: data.team,
            gameId: data.gameId,
            inning: data.inning,
            half: halfLabel,
            atBatIndex: data.atBatIndex ?? null,
            pregameScore: 0,
            priorWatchStateExists,
            priorBuildStateExists,
            priorReadyStateExists,
            priorAttackStateExists,
            priorContactEvents,
            priorEventCount: priorEvents.length,
            maxPreHrScore,
            closestThresholdMissed,
            suppressionReasons: suppressionReasons || null,
            hitterArchetype,
            pitcherFade,
            parkWeatherScore,
          })}`);
        } catch (logErr: any) {
          // Never let calibration logging break grading.
          console.warn(`[HR_RADAR_MISS_REASON] log failed: ${logErr?.message ?? logErr}`);
        }
      }
      // Goldmaster Phase 9 — canonical resolved_* event for the ledger.
      try {
        await this.appendHrRadarSignalEvent({
          sessionDate: today, gameId: data.gameId, playerId: data.playerId, team: data.team,
          alertId,
          // Phase 2 — keep `resolved_early_window_hr` event type for ledger
          // continuity (event-type column is enum-like and consumed by
          // analytics jobs). The new gradingStatus token is independent.
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

  async reconcileHrRadarAlertsForGame(gameId: string, playerHrMap: Map<string, { inning: number; half: string }>, finalInning?: number | null): Promise<void> {
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
        // HR Radar Settlement Repair — Bug #4: skip alerts that already have
        // a hit stamp from per-poll grading (resolveHrRadarAlertAsHit). The
        // final reconciler runs at game-final without precise HR endTimes
        // and `playerHrMap` only carries each player's LAST HR inning, so
        // re-grading already-graded alerts can flip a true `late_signal` /
        // `called_miss` to false `called_hit`. Status is the canonical
        // gate (`live` ⇔ ungraded), but belt-and-suspenders we also skip
        // when hitInning is already populated.
        if (alert.hitInning != null) continue;
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
          //
          // HR Radar Settlement Repair — Bug #4: when reconcile is called
          // with a synthetic `half:"final"` and `inning:lastInning` (the
          // game-final wrapper at liveGameOrchestrator.reconcileHrRadarFinalGame),
          // ANY signal in the game would falsely qualify as "strictly before
          // HR" — halfOrd("final")=2 outranks both top(0) and bottom(1).
          // To avoid manufactured called_hit grades we treat a synthetic
          // `final` half as a hard inning-only test: the signal inning must
          // be STRICTLY less than the last-known inning (not equal). Real
          // hr_play data with concrete top/bottom halves keeps the original
          // semantic.
          const isSyntheticFinal = hrData.half === "final";
          const isPreHr = isSyntheticFinal
            ? (sigInn != null && sigInn < hrData.inning)
            : signalIsStrictlyBeforeHr(sigInn, sigHalf, hrData.inning, hrData.half);
          if (isPreHr) {
            // Phase 1 (3-tier ladder) — symmetric with the per-poll cash path:
            // only HR-Max-Window signals that preceded the HR are credited as a
            // counted win. Sub-actionable Watch/Building precursors are stamped
            // `uncalled_hr` (diagnostic, not counted).
            const reconcileReachedMax = reachedHrMaxWindow({
              alertTier: alert.alertTier,
              confidenceTier: alert.confidenceTier,
              signalState: alert.signalState,
            });
            // FIRE-only official record (2026-06) — symmetric with the miss
            // side and the per-poll cash path. Only a FIRE-committed pre-HR
            // signal is a counted win; a READY-only precursor is `uncalled_hr`.
            const reconcileFireCommitted = reachedFireCommitment({
              alertPath: alert.alertPath,
              peakConversionProbability: extractPeakConversionProbability(alert.diagnosticsSnapshot),
            });
            const reconcileOfficialCall = reconcileReachedMax && reconcileFireCommitted;
            const reconcileCashStatus = reconcileOfficialCall
              ? inferCashedFromTierStatus({
                  alertTier: alert.alertTier,
                  confidenceTier: alert.confidenceTier,
                  signalState: alert.signalState,
                })
              : "uncalled_hr";
            await db.update(hrRadarAlerts)
              .set({
                status: "hit",
                hitInning: hrData.inning,
                hitHalf: hrData.half,
                hitLabel,
                hitDetectedAt: nowDate,
                resolvedAt: nowDate,
                gradingStatus: reconcileCashStatus,
                gradingReason: reconcileOfficialCall
                  ? `reconcile: HR Max Window FIRE signal ${sigInn}/${sigHalf} strictly precedes HR ${hrData.inning}/${hrData.half}`
                  : `reconcile: ${reconcileReachedMax ? "READY-only (never reached FIRE commitment)" : "sub-actionable (Watch/Building)"} signal ${sigInn}/${sigHalf} precedes HR ${hrData.inning}/${hrData.half}; not credited as a called pick`,
                matchedBeforeHr: true,
                userVisible: reconcileOfficialCall,
                matchMethod: "direct_pre_hr_signal",
                signalDetectedAt: alert.signalDetectedAt ?? alert.detectedAt,
                signalInning: sigInn,
                signalHalf: sigHalf,
              })
              .where(eq(hrRadarAlerts.id, alert.id));
            if (reconcileOfficialCall) {
              console.log(`[HR_RADAR_CALLED_HIT] (reconcile) playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel} hitLabel=${hitLabel} tieredStatus=${reconcileCashStatus}`);
            } else {
              console.log(`[HR_RADAR_UNCALLED_HR] (reconcile, ${reconcileReachedMax ? "READY-only not FIRE" : "sub-actionable"}) playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel} hitLabel=${hitLabel} alertPath=${alert.alertPath ?? "n/a"} — not counted as a win`);
            }
            console.log(`[HR_LEDGER_GRADE] outcome=${reconcileCashStatus} (reconcile) sessionDate=${today} gameId=${gameId} playerId=${alert.playerId} signalInning=${sigInn ?? "n/a"}${sigHalf ?? ""} hitInning=${hrData.inning}${hrData.half} alertId=${alert.id}`);
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
          // ── Phase 1 (3-tier ladder) — honest miss grading ────────────────
          // Only alerts that reached the HR Max Window (the single actionable
          // top tier) are graded as a counted `called_miss`. Sub-actionable
          // Watch/Building rows — including presence-only floor rows — were
          // ambient context, never a pick, and are stamped `expired`
          // (→ "unresolved", excluded from the missed bucket / W/L ledger /
          // user-facing MISSED section). This is what collapses the inflated
          // "everything is a miss" wall into the genuinely actionable set.
          let finalGrade = resolveFinalNoHrGrading({
            alertTier: alert.alertTier,
            confidenceTier: alert.confidenceTier,
            signalState: alert.signalState,
          });
          // ── Phase 1 slice 3 — PA-bounded HR Max Window ───────────────────
          // A genuine HR Max Window miss only counts when the batter had the
          // window's worth of opportunity. If the actionable signal fired so
          // late that its PA window was cut short by game-end, resolve it to
          // `expired` (window lapsed, not counted) rather than a hard miss —
          // so "window closed" reflects a real window, not just game-over.
          let windowCutShort = false;
          if (finalGrade === "called_miss") {
            const windowClass = classifyHrMaxWindowAtFinal({
              signalInning: alert.signalInning ?? alert.detectedInning,
              finalInning: finalInning ?? null,
            });
            if (windowClass === "expired") {
              finalGrade = "expired";
              windowCutShort = true;
            }
          }
          // ── FIRE-only official grading (2026-06) ─────────────────────────
          // Only a row that reached the user-facing FIRE commitment counts as
          // a money `called_miss`. A row the alert-path engine surfaced as
          // `officialAlert` whose dynamic conviction never crossed the BET_NOW
          // band (and that did not take the FAST_PROMOTE_ELITE fire path) was
          // only user-stage READY — high-watch, not an official call — so it
          // expires instead of polluting the official HR record with a false
          // miss. peakConversionProbability is read from the persisted
          // diagnosticsSnapshot.scoreContract (no new write path). Going
          // forward only; historical rows are untouched.
          let readyOnlyNotFire = false;
          if (finalGrade === "called_miss") {
            const peakConv = extractPeakConversionProbability(alert.diagnosticsSnapshot);
            const fireCommitted = reachedFireCommitment({
              alertPath: alert.alertPath,
              peakConversionProbability: peakConv,
            });
            if (!fireCommitted) {
              finalGrade = "expired";
              readyOnlyNotFire = true;
              console.log(`[HR_RADAR_READY_NOT_FIRE] playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel ?? "presence"} alertPath=${alert.alertPath ?? "?"} peakConv=${peakConv ?? "null"} — READY-only no-HR row expired (not an official FIRE call), excluded from miss record`);
            }
          }
          // ── Near-HR credit ───────────────────────────────────────────────
          // A genuine HR-Max-Window pick that played out without an HR but whose
          // batter squared up an "almost HR" (barrel / warning-track / elite EV)
          // is credited as a `called_near_hr` win rather than a hard `called_miss`.
          // The radar is graded on calling the danger, not the binary HR/no-HR
          // coin flip. Peak contact is read from the per-contact window already
          // persisted on `diagnosticsSnapshot.contactClasses`, with the last-AB
          // `contactSnapshot` as a fallback — no schema change, no new write path.
          if (finalGrade === "called_miss") {
            const peakContact = extractAlertPeakContact(
              alert.diagnosticsSnapshot,
              alert.contactSnapshot,
              { signalInning: alert.signalInning ?? alert.detectedInning, signalHalf: alert.signalHalf ?? alert.detectedHalf },
            );
            if (peakContact && qualifiesForNearHrCredit(peakContact)) {
              await db.update(hrRadarAlerts)
                .set({
                  status: "hit",
                  resolvedAt: nowDate,
                  gradingStatus: "called_near_hr",
                  gradingReason: `reconcile: HR Max Window signal — no HR but squared up a near-HR (ev=${peakContact.peakEv ?? "?"} dist=${peakContact.peakDistance ?? "?"} la=${peakContact.peakLaunchAngle ?? "?"} barrel=${peakContact.isBarrel ?? false})`,
                  userVisible: true,
                  matchedBeforeHr: false,
                  matchMethod: "direct_pre_hr_signal",
                })
                .where(eq(hrRadarAlerts.id, alert.id));
              console.log(`[HR_RADAR_CASHED] (near-hr) playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel} outcomeStatus=called_near_hr ev=${peakContact.peakEv ?? "?"} dist=${peakContact.peakDistance ?? "?"} barrel=${peakContact.isBarrel ?? false}`);
              console.log(`[HR_LEDGER_GRADE] outcome=called_near_hr (reconcile) sessionDate=${today} gameId=${gameId} playerId=${alert.playerId} detectedLabel=${alert.detectedLabel} alertId=${alert.id}`);
              continue;
            }
          }
          if (finalGrade === "called_miss") {
            await db.update(hrRadarAlerts)
              .set({
                status: "miss",
                resolvedAt: nowDate,
                gradingStatus: "called_miss",
                gradingReason: "reconcile: HR Max Window signal — PA window played out without HR",
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
            // FIRE-only official record (2026-06) — the per-poll matcher emits
            // hr_radar_missed for called_miss, but this game-final reconcile path
            // (the normal no-HR settlement for a FIRE signal) did not, leaving
            // the analytics official split's fireMissed at 0 and inflating
            // fireHitRate. Emit here too so the FIRE record matches the ledger.
            // This block only runs for FIRE-committed rows (sub-FIRE settles as
            // `expired` above), and is disjoint from the per-poll path (that
            // resolves the row out of `live` before reconcile), so no double-count.
            try {
              const { emitHrRadarOutcome } = require("./analytics/eventEmitters");
              const peakScore10 = alert.peakReadinessScore != null
                ? Math.round((Number(alert.peakReadinessScore) / 10) * 10) / 10
                : null;
              emitHrRadarOutcome({
                signalId: `mlb:${gameId}:${alert.playerId}:home_runs:OVER`,
                gameId, playerId: alert.playerId,
                kind: "missed",
                signalPath: alert.alertPath ?? null,
                score10: peakScore10,
                finalStage: (alert as any).userStage ?? alert.signalState ?? null,
                gradingStatus: "called_miss",
              });
            } catch {}
          } else {
            // `expired` — either sub-actionable Watch/Building context (never a
            // pick) OR an HR Max Window signal whose PA window was cut short by
            // game-end. Admin-only; leaves the active set without polluting the
            // user-facing miss record / W/L ledger.
            const expiredReason = readyOnlyNotFire
              ? "reconcile: READY-only signal (never reached FIRE commitment / BET_NOW) — game ended without HR; high-watch context, not an official FIRE call"
              : windowCutShort
              ? "reconcile: HR Max Window signal fired too late — PA window cut short by game-end; not counted"
              : "reconcile: sub-actionable (Watch/Building) signal — game ended without HR; not a called pick";
            await db.update(hrRadarAlerts)
              .set({
                // status `expired` (not `miss`) so the raw `status === "miss"`
                // W/L counters (e.g. the HR Radar accuracy summary) exclude
                // these non-graded rows. `gradingStatus="expired"` already maps
                // to "unresolved" in deriveHrRadarOutcomeStatus, keeping the
                // canonical section/outcome path consistent.
                status: "expired",
                resolvedAt: nowDate,
                gradingStatus: "expired",
                gradingReason: expiredReason,
                userVisible: false,
                matchedBeforeHr: false,
                matchMethod: "direct_pre_hr_signal",
              })
              .where(eq(hrRadarAlerts.id, alert.id));
            console.log(`[HR_RADAR_INACTIVE] (reconcile) playerId=${alert.playerId} gameId=${gameId} detectedLabel=${alert.detectedLabel ?? "presence"} reason=${readyOnlyNotFire ? "ready_only_not_fire" : windowCutShort ? "hr_max_window_cut_short" : "sub_actionable_not_graded"} confTier=${alert.confidenceTier ?? "?"} signalState=${alert.signalState ?? "?"} alertTier=${alert.alertTier ?? "?"}`);
          }
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

      // ── Audit fix F2 — de-duplicate before archiving ─────────────────────
      // `collapseDuplicateHrRadarOutcomes` harmonizes duplicate alert rows
      // (propagating a hit) but never removes them, so without this every
      // player landed in the analytics table 2× as byte-identical rows. Pick
      // one canonical alert per (playerId): a graded HIT wins, otherwise the
      // row with the highest peak readiness. The other dupes are still flagged
      // analyticsPersisted so they never re-enter the archive.
      const num = (v: unknown): number => {
        const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
        return Number.isFinite(n) ? n : 0;
      };
      const byPlayer = new Map<string, typeof alerts>();
      for (const a of alerts) {
        const list = byPlayer.get(a.playerId) ?? ([] as typeof alerts);
        list.push(a);
        byPlayer.set(a.playerId, list);
      }
      const canonicalAlerts = Array.from(byPlayer.values()).map((dupes) => {
        if (dupes.length === 1) return dupes[0];
        const hit = dupes.find((d) => d.status === "hit");
        if (hit) return hit;
        return dupes.reduce((best, d) =>
          num(d.peakReadinessScore) > num(best.peakReadinessScore) ? d : best, dupes[0]);
      });

      // Idempotency guard — never insert a second analytics row for a key that
      // already exists (protects against a re-archive after a partial run).
      const existing = await db.select({
        gameId: hrRadarAnalytics.gameId,
        playerId: hrRadarAnalytics.playerId,
      }).from(hrRadarAnalytics).where(and(
        eq(hrRadarAnalytics.sessionDate, sessionDate),
        eq(hrRadarAnalytics.gameId, gameId),
      ));
      const existingKeys = new Set(existing.map((e) => `${e.gameId}_${e.playerId}`));

      for (const alert of canonicalAlerts) {
        if (!existingKeys.has(`${alert.gameId}_${alert.playerId}`)) {
          await db.insert(hrRadarAnalytics).values({
            sessionDate: alert.sessionDate,
            gameId: alert.gameId,
            playerId: alert.playerId,
            playerName: alert.playerName,
            team: alert.team,
            detectedLabel: alert.detectedLabel,
            hitLabel: alert.hitLabel,
            detectedScore: alert.initialReadinessScore,
            // Audit fix F1 — archive the real terminal readiness so the UI's
            // "Score" column reflects the live score instead of a stale 0.
            currentScore: alert.currentReadinessScore,
            peakScore: alert.peakReadinessScore,
            scoreIncreaseAmount: alert.scoreIncreaseAmount,
            result: alert.status,
            confidenceTier: alert.confidenceTier,
            triggerTags: alert.triggerTags,
          });
        }
      }

      // Flag *every* processed alert (canonical + collapsed dupes) as persisted.
      for (const alert of alerts) {
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
        .filter(r => r.status === "hit" && CALLED_HIT_OUTCOME_STATUSES.has(r.gradingStatus as any) && r.userVisible === true)
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
      const calledHits = hits.filter(h => CALLED_HIT_OUTCOME_STATUSES.has((h as any).gradingStatus));
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
    // ── Goldmaster v1 Phase 11 — additive sub-buckets. Existing fields above
    // are unchanged; these break the misses/uncalled categories down further
    // so the UI can answer "what kind of miss was it?" without re-querying.
    subBuckets: {
      missedOfficialSignals: number;
      lateSignals: number;
      uncalledHrs: number;
      earlyWindowHrs: number;
      expiredTracking: number;
    };
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
        subBuckets: {
          missedOfficialSignals: number;
          lateSignals: number;
          uncalledHrs: number;
          earlyWindowHrs: number;
          expiredTracking: number;
        };
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
        const calledHits = canonical.filter(r => CALLED_HIT_OUTCOME_STATUSES.has(r.gradingStatus as any)).length;
        const uncalledHits = canonical.filter(r => r.gradingStatus === "uncalled_hr" || r.gradingStatus === "late_signal").length;
        const misses = canonical.filter(r => r.gradingStatus === "called_miss").length;
        const totalGraded = calledHits + misses;
        const hitRate = totalGraded > 0 ? Math.round((calledHits / totalGraded) * 1000) / 10 : 0;

        // Goldmaster v1 Phase 11 — sub-bucket breakdown. Pure refinement
        // over the same canonical rows; never replaces the headline counts.
        const subBuckets = {
          missedOfficialSignals: canonical.filter(r => r.gradingStatus === "called_miss").length,
          lateSignals: canonical.filter(r => r.gradingStatus === "late_signal").length,
          uncalledHrs: canonical.filter(r => r.gradingStatus === "uncalled_hr").length,
          earlyWindowHrs: canonical.filter(r => r.gradingStatus === "early_window_hr" || r.gradingStatus === "early_hr_no_window" || r.gradingStatus === "early_hr_insufficient_sample").length,
          expiredTracking: canonical.filter(r => r.gradingStatus === "expired").length,
        };

        result.push({ sessionDate: date, calledHits, uncalledHits, misses, totalGraded, hitRate, subBuckets });
      }

      return result;
    } catch (err: any) {
      console.warn(`[HR_RADAR_GRADING_HISTORY] Failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Phase 5 — admin calibration view. Returns the most recent uncalled-HR
   * rows across the last `daysBack` sessions for engine review. Pulls
   * `uncalled_hr` and `early_hr_insufficient_sample` (Phase 2 token) plus the
   * legacy `early_hr_no_window` alias so older rows stay visible.
   *
   * Read-only and best-effort: derived fields (suppression reasons, archetype,
   * pitcherFade, parkWeather) are extracted from `diagnosticsSnapshot` when
   * present and returned as null when absent. Never throws.
   */
  async getUncalledHrReview(limit: number = 50, daysBack: number = 7): Promise<Array<{
    id: string;
    sessionDate: string;
    gameId: string;
    playerId: string;
    playerName: string;
    team: string;
    gradingStatus: string;
    hitInning: number | null;
    hitHalf: string | null;
    detectedInning: number | null;
    pregameScore: number | null;
    maxPreHrScore: number | null;
    hadPreHrRadarRow: boolean;
    hadPreHrContact: boolean;
    matchMethod: string | null;
    gradingReason: string | null;
    suppressionReasons: string[] | null;
    hitterArchetype: string | null;
    pitcherFade: number | null;
    parkWeatherScore: number | null;
    atBatIndex: number | null;
    resolvedAt: Date | null;
    // Review bucket taxonomy (diagnosticsSnapshot.hrReview) — additive, nullable
    // when the classifier has not stamped this row yet.
    reviewBucket: string | null;
    reviewReason: string | null;
    reviewDataQuality: string | null;
    reviewDataQualityReasons: string[] | null;
    preHrPeakStage: string | null;
    preHrPeakScore10: number | null;
    currentStage: string | null;
    currentScore10: number | null;
    completedAbsBeforeHr: number | null;
    hadPregameTargetTag: boolean | null;
    hadNearHrBeforeHr: boolean | null;
    hadHrCandidateContactBeforeHr: boolean | null;
    hadPitcherCollapseBeforeHr: boolean | null;
    signalBusHadPreHrRecord: boolean | null;
    lifecycleHadPreHrRecord: boolean | null;
    checkedSignalIds: string[] | null;
    classifierVersion: number | null;
  }>> {
    try {
      const cutoffStr = daysAgoET(daysBack);
      const rows = await db.select().from(hrRadarAlerts)
        .where(and(
          sql`${hrRadarAlerts.sessionDate} >= ${cutoffStr}`,
          sql`${hrRadarAlerts.gradingStatus} IN ('uncalled_hr','early_hr_insufficient_sample','early_hr_no_window')`,
        ))
        .orderBy(desc(hrRadarAlerts.resolvedAt), desc(hrRadarAlerts.detectedAt))
        .limit(Math.max(1, Math.min(500, limit)));

      return rows.map(r => {
        const diag = (r.diagnosticsSnapshot ?? {}) as Record<string, any>;
        const contact = (r.contactSnapshot ?? null) as Record<string, any> | null;
        // Best-effort extraction — diagnostics shape varies by code path so we
        // probe a handful of known keys before returning null. UI shows "—".
        const suppressors =
          (Array.isArray(diag.suppressors) && diag.suppressors) ||
          (Array.isArray(diag.suppressionReasons) && diag.suppressionReasons) ||
          (Array.isArray(diag.softVetoes) && diag.softVetoes) ||
          null;
        const archetype =
          (typeof diag.batterArchetype === "string" && diag.batterArchetype) ||
          (typeof diag.archetype === "string" && diag.archetype) ||
          null;
        const pitcherFade =
          (typeof diag.pitcherFade === "number" && diag.pitcherFade) ||
          (typeof diag.pitcherVulnerability === "number" && diag.pitcherVulnerability) ||
          null;
        const parkWeather =
          (typeof diag.parkWeatherScore === "number" && diag.parkWeatherScore) ||
          (typeof diag.parkWeather === "number" && diag.parkWeather) ||
          (typeof diag.parkWindBoost === "number" && diag.parkWindBoost) ||
          null;
        const atBatIndex: number | null =
          typeof diag.atBatIndex === "number" ? diag.atBatIndex
          : typeof diag.abIndex === "number" ? diag.abIndex
          : null;
        // hadPreHrContact: contactSnapshot has any tracked PA or hard-hit count.
        const hadPreHrContact =
          contact != null && (
            (typeof contact.plateAppearancesTracked === "number" && contact.plateAppearancesTracked > 0) ||
            (typeof contact.barrels === "number" && contact.barrels > 0) ||
            (typeof contact.hardHits === "number" && contact.hardHits > 0)
          );

        const hrReview = (diag.hrReview ?? null) as Record<string, any> | null;
        const reviewSnap = (hrReview?.snapshot ?? null) as Record<string, any> | null;
        const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const boolOrNull = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

        return {
          id: r.id,
          sessionDate: r.sessionDate,
          gameId: r.gameId,
          playerId: r.playerId,
          playerName: r.playerName,
          team: r.team,
          gradingStatus: r.gradingStatus,
          hitInning: r.hitInning ?? null,
          hitHalf: r.hitHalf ?? null,
          detectedInning: r.detectedInning ?? null,
          pregameScore: r.initialReadinessScore != null ? Number(r.initialReadinessScore) : null,
          maxPreHrScore: r.peakReadinessScore != null ? Number(r.peakReadinessScore) : null,
          hadPreHrRadarRow: !!r.matchedBeforeHr,
          hadPreHrContact,
          matchMethod: r.matchMethod ?? null,
          gradingReason: r.gradingReason ?? null,
          suppressionReasons: suppressors as string[] | null,
          hitterArchetype: archetype,
          pitcherFade: pitcherFade as number | null,
          parkWeatherScore: parkWeather as number | null,
          atBatIndex,
          resolvedAt: r.resolvedAt,
          reviewBucket: typeof hrReview?.bucket === "string" ? hrReview.bucket : null,
          reviewReason: typeof hrReview?.reason === "string" ? hrReview.reason : null,
          reviewDataQuality: typeof reviewSnap?.dataQuality === "string" ? reviewSnap.dataQuality : null,
          reviewDataQualityReasons: Array.isArray(reviewSnap?.dataQualityReasons) ? reviewSnap!.dataQualityReasons : null,
          preHrPeakStage: typeof reviewSnap?.preHrPeakStage === "string" ? reviewSnap.preHrPeakStage : null,
          preHrPeakScore10: numOrNull(reviewSnap?.preHrPeakScore10),
          currentStage: typeof reviewSnap?.currentStage === "string" ? reviewSnap.currentStage : null,
          currentScore10: numOrNull(reviewSnap?.currentScore10),
          completedAbsBeforeHr: numOrNull(reviewSnap?.completedAbsBeforeHr),
          hadPregameTargetTag: boolOrNull(reviewSnap?.hadPregameTargetTag),
          hadNearHrBeforeHr: boolOrNull(reviewSnap?.hadNearHrBeforeHr),
          hadHrCandidateContactBeforeHr: boolOrNull(reviewSnap?.hadHrCandidateContactBeforeHr),
          hadPitcherCollapseBeforeHr: boolOrNull(reviewSnap?.hadPitcherCollapseBeforeHr),
          signalBusHadPreHrRecord: boolOrNull(reviewSnap?.signalBusHadPreHrRecord),
          lifecycleHadPreHrRecord: boolOrNull(reviewSnap?.lifecycleHadPreHrRecord),
          checkedSignalIds: Array.isArray(reviewSnap?.checkedSignalIds) ? reviewSnap!.checkedSignalIds : null,
          classifierVersion: numOrNull(hrReview?.classifierVersion),
        };
      });
    } catch (err: any) {
      console.warn(`[HR_RADAR_UNCALLED_REVIEW] Failed: ${err.message}`);
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
          status: a.result === "hit" ? "hit" : a.result === "miss" ? "miss" : a.result === "void" ? "void" : "live",
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
          gradingStatus: a.result === "hit" ? "called_hit" : a.result === "miss" ? "called_miss" : a.result === "void" ? "voided_dnp" : "active",
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

  // ── Audit fix C4 — durable HR Radar outcome-stamp persistence ──────────────
  // Upsert a single stamp (first-write-wins via the unique (gameId, playerId)
  // index → onConflictDoNothing). Called fire-and-forget from the in-memory
  // stamp store; wrapped so a DB hiccup can never break runtime grading.
  async persistHrRadarOutcomeStamp(stamp: {
    gameId: string;
    playerId: string;
    outcomeStatus: string;
    resolvedAt: number;
    hitInning?: number | null;
    alertTier?: string | null;
    confidenceTier?: string | null;
    signalState?: string | null;
    source?: string | null;
    rawConversionProbability?: number | null;
  }): Promise<void> {
    try {
      await db.insert(hrRadarOutcomeStamps).values({
        gameId: stamp.gameId,
        playerId: stamp.playerId,
        outcomeStatus: stamp.outcomeStatus,
        hitInning: stamp.hitInning ?? null,
        alertTier: stamp.alertTier ?? null,
        confidenceTier: stamp.confidenceTier ?? null,
        signalState: stamp.signalState ?? null,
        source: stamp.source ?? null,
        rawConversionProbability: stamp.rawConversionProbability != null ? String(stamp.rawConversionProbability) : null,
        resolvedAt: new Date(stamp.resolvedAt),
      }).onConflictDoNothing();
    } catch (err: any) {
      console.warn(`[HR_RADAR_STAMP_PERSIST] failed game=${stamp.gameId} player=${stamp.playerId}: ${err.message}`);
    }
  }

  /**
   * Persist an HR review-bucket classification onto the alert's diagnostics
   * jsonb (`diagnosticsSnapshot.hrReview`). SAFE ADDITIVE / diagnostic-only:
   *   - never touches gradingStatus / userVisible / ROI / W-L fields
   *   - never throws (fire-and-forget from the grader)
   *   - no migration — reuses the existing diagnostics_snapshot column
   *
   * Fallback ladder: update latest hr_radar_alerts row for game+player; if no
   * such row exists (a true uncalled HR with no alert), log
   * `[HR_REVIEW_PERSIST_SKIPPED]` and return — we do NOT synthesize a W/L row.
   */
  async persistHrReviewClassification(
    gameId: string,
    playerId: string | number,
    payload: {
      bucket: string;
      reason: string;
      snapshot: Record<string, unknown>;
      classifiedAt: string;
      classifierVersion: number;
    },
  ): Promise<void> {
    try {
      const pid = String(playerId);
      const rows = await db.select().from(hrRadarAlerts)
        .where(and(
          eq(hrRadarAlerts.gameId, gameId),
          eq(hrRadarAlerts.playerId, pid),
        ))
        .orderBy(desc(hrRadarAlerts.detectedAt))
        .limit(1);
      const row = rows[0];
      if (!row) {
        console.log(`[HR_REVIEW_PERSIST_SKIPPED] gameId=${gameId} playerId=${pid} bucket=${payload.bucket} reason=no_alert_row`);
        return;
      }
      const prevDiag = (row.diagnosticsSnapshot ?? {}) as Record<string, unknown>;
      const mergedDiag = { ...prevDiag, hrReview: payload };
      await db.update(hrRadarAlerts)
        .set({ diagnosticsSnapshot: mergedDiag })
        .where(eq(hrRadarAlerts.id, row.id));
    } catch (err: any) {
      console.warn(`[HR_REVIEW_PERSIST] failed game=${gameId} player=${playerId}: ${err?.message ?? err}`);
    }
  }

  // Load recently-resolved stamps (default 21d) so the calibrator can hydrate
  // its working set at boot. Returns plain objects matching the in-memory shape.
  async loadRecentHrRadarOutcomeStamps(days: number = 21): Promise<PersistedHrRadarOutcomeStamp[]> {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const rows = await db.select().from(hrRadarOutcomeStamps)
        .where(gte(hrRadarOutcomeStamps.resolvedAt, cutoff));
      return rows.map((r) => ({
        gameId: r.gameId,
        playerId: r.playerId,
        outcomeStatus: r.outcomeStatus as HrRadarOutcomeStatus,
        resolvedAt: r.resolvedAt ? r.resolvedAt.getTime() : Date.now(),
        hitInning: r.hitInning ?? null,
        alertTier: r.alertTier ?? null,
        confidenceTier: r.confidenceTier ?? null,
        signalState: r.signalState ?? null,
        source: (r.source ?? undefined) as PersistedHrRadarOutcomeStamp["source"],
        rawConversionProbability: r.rawConversionProbability != null ? parseFloat(r.rawConversionProbability) : null,
      }));
    } catch (err: any) {
      console.warn(`[HR_RADAR_STAMP_HYDRATE] load failed: ${err.message}`);
      return [];
    }
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
      // Goldmaster v1 — additive Ready bucket. Populated when the FF is on
      // and an entry's userStage resolves to "ready". Always present (may be
      // empty) so client code can safely iterate.
      ready: HrRadarLadderEntry[];
    };
    counts: { attackNow: number; building: number; watch: number; cashed: number; dead: number; ready: number; total: number };
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
        .filter(r => CALLED_HIT_OUTCOME_STATUSES.has(r.gradingStatus as any) || r.status === "hit")
        .map(r => r.playerName)
    ));
    // Task #121 Step 4 — pull current inning per game (lazy dynamic import
    // to avoid circular: dataPullService imports storage indirectly). Used
    // by the urgency line so "expires after T8" / late-inning copy fires
    // based on game-state, not the (frozen) detection inning.
    const currentInningByGameId = new Map<string, number>();
    // Lifted to function scope so the live-context derivation below (Spec
    // Step 8) can also read box-score / contact-data caches without a
    // second import.
    let mlbGameCacheLocal: any = null;
    try {
      const mod = await import("./mlb/dataPullService");
      mlbGameCacheLocal = mod.mlbGameCache;
      const gameStates = (mlbGameCacheLocal?.gameState ?? {}) as Record<string, any>;
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
      // Goldmaster v1 — populated below from entries whose userStage === "ready".
      ready: [] as HrRadarLadderEntry[],
    };

    // Collapse duplicates by playerId|gameId so a single player only appears
    // in one section. Resolved final outcomes (cashed/dead) always supersede
    // pending active states for the same player|game; among active states,
    // attackNow > building > watch.
    const seen = new Map<string, { section: keyof typeof sections; entry: HrRadarLadderEntry }>();
    const sectionPriority: Record<keyof typeof sections, number> = {
      cashed: 0, dead: 1, attackNow: 2, ready: 3, building: 4, watch: 5,
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
        if (CALLED_HIT_OUTCOME_STATUSES.has(grading as any)) return "called_hit";
        switch (grading) {
          case "called_miss": return "miss";
          case "uncalled_hr": return "uncalled_hr";
          case "late_signal": return "late_signal";
          // Phase 4: split early-window HR from standard misses.
          case "early_hr_no_window":
          case "early_window_hr":
          case "early_hr_insufficient_sample":
            return "early_window_hr";
          default: return "pending";
        }
      })();

      // Determine target section. For LIVE rows we now bucket off the
      // canonical engine stage (Phase 2). Resolved rows go to cashed/dead by
      // outcome.
      //
      // Master Fix — "no plays" surfacing: legacy floors (tier+state+readiness)
      // are computed unconditionally and used to PROMOTE a card when the
      // canonical engine stage is "watch" or "cooling" but the engine signals
      // (state=actionable + score>=72, or state=live + score>=55) clearly
      // merit a higher bucket. This is strictly additive — promotion only,
      // never demotion — so high-conviction signals never get buried in the
      // (collapsed-by-default) Track section.
      //
      // HR HIT THIS INNING — keep card in pre-hit zone until next inning.
      // When hitInning === currentInning the player just hit THIS inning and
      // the card should visually linger in its zone (FIRE/READY/BUILD/TRACK)
      // so the user sees it hit. Next inning currentInning > hitInning and
      // the card naturally falls through to "cashed" as normal.
      let section: keyof typeof sections;
      let hitThisInning = false;
      if (currentStatus === "resolved") {
        if (outcome === "called_hit") {
          const gameCurrentInning = currentInningByGameId.get(r.gameId) ?? null;
          const hitInn = r.hitInning ?? null;
          if (hitInn != null && gameCurrentInning != null && hitInn === gameCurrentInning) {
            hitThisInning = true;
            // Route to the pre-hit zone using the tiered grading status.
            const gs = (grading ?? "") as string;
            section = gs === "called_hit_attack" ? "attackNow"
              : gs === "called_hit_ready" ? "ready"
              : gs === "called_hit_build" ? "building"
              : "watch";
          } else {
            section = "cashed";
          }
        } else {
          section = "dead";
        }
      } else {
        // Canonical-stage section (engine's authoritative view).
        const canonicalSection: keyof typeof sections | null = canonicalStage
          ? (canonicalStage === "attack" ? "attackNow"
            : canonicalStage === "building" ? "building"
            : "watch")
          : null;

        // Legacy-floor section computed from current signal state + readiness.
        const tier = (r.confidenceTier ?? "monitor").toLowerCase();
        const state = (r.signalState ?? "watching").toLowerCase();
        const readiness = parseFloat(String(r.currentReadinessScore ?? r.peakReadinessScore ?? 0)) || 0;
        const ATTACK_FLOOR = 72;
        const BUILDING_FLOOR = 55;
        let legacySection: keyof typeof sections;
        if ((tier === "strong" || state === "actionable") && readiness >= ATTACK_FLOOR) {
          legacySection = "attackNow";
        } else if ((tier === "building" || state === "live" || tier === "strong" || state === "actionable") && readiness >= BUILDING_FLOOR) {
          legacySection = "building";
        } else {
          legacySection = "watch";
        }

        if (canonicalSection) {
          // Take the higher-priority of (canonical, legacy). attackNow > building > watch.
          const liveRank: Record<string, number> = { attackNow: 0, building: 1, watch: 2 };
          if (liveRank[legacySection] < liveRank[canonicalSection]) {
            section = legacySection;
            console.log(`[HR_LADDER_PROMOTE] gameId=${r.gameId} playerId=${r.playerId} canonical=${canonicalSection} legacy=${legacySection} score=${readiness} state=${state} tier=${tier}`);
          } else {
            section = canonicalSection;
          }
        } else {
          section = legacySection;
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
      // Spec Step 8 — live context truth. Any of box-score AB/H/HR/TB > 0
      // OR cached contact events flips a row into "live" so we never paint
      // "Pregame only · 0 AB" for a player who already has live evidence.
      // mlbGameCacheLocal is captured from the lazy import above (best-effort
      // — falls back to the legacy plateAppearancesTracked > 0 rule when the
      // cache is empty).
      let boxScoreHasContact = false;
      try {
        const bs = (mlbGameCacheLocal?.gameBoxScore?.[r.gameId]?.byPlayerId?.[r.playerId]) as
          { ab?: number; hits?: number; hr?: number; tb?: number } | undefined;
        if (bs) {
          boxScoreHasContact =
            (Number(bs.ab ?? 0) > 0) ||
            (Number(bs.hits ?? 0) > 0) ||
            (Number(bs.hr ?? 0) > 0) ||
            (Number(bs.tb ?? 0) > 0);
        }
      } catch { /* best-effort */ }
      let contactEventsCount = 0;
      // Compact per-PA projection for the card's collapsed chip + inline
      // At-Bat Log expand. Additive, transport-only — mirrors the
      // /api/mlb/hr-radar-analyze priorABs shape (barrel/hard-hit derivation)
      // so the ladder card and analyze modal render identically. Capped to the
      // most recent 6 PAs to keep the ladder payload lean.
      let recentABs: Array<{
        abNumber: number;
        exitVelocity: number | null;
        launchAngle: number | null;
        distance: number | null;
        outcome: string;
        isBarrel: boolean;
        isHardHit: boolean;
        perABxBA: number | null;
        contactGrade: string | null;
      }> | undefined;
      try {
        const cd = (mlbGameCacheLocal?.contactData?.[r.gameId]?.byPlayerId?.[r.playerId]) as
          { priorABResults?: unknown[] } | undefined;
        if (cd && Array.isArray(cd.priorABResults)) {
          contactEventsCount = cd.priorABResults.length;
          const projected = cd.priorABResults.map((raw: any, idx: number) => ({
            abNumber: idx + 1,
            exitVelocity: raw?.exitVelocity ?? null,
            launchAngle: raw?.launchAngle ?? null,
            distance: raw?.distance ?? null,
            outcome: raw?.outcome ?? "unknown",
            isBarrel: isCanonicalBarrel(raw?.exitVelocity ?? null, raw?.launchAngle ?? null),
            isHardHit: (raw?.exitVelocity ?? 0) >= 95,
            perABxBA: raw?.perABxBA ?? null,
            contactGrade: raw?.contactGrade ?? null,
          }));
          if (projected.length > 0) recentABs = projected.slice(-6);
        }
      } catch { /* best-effort */ }
      const hasLiveABContext: boolean =
        abContextRow.hasLiveABContext === true ? true
          : boxScoreHasContact ? true
          : (contactEventsCount > 0) ? true
          : (plateAppearancesTracked != null && plateAppearancesTracked > 0);
      if (process.env.DEBUG_HR_RADAR_LIVE_CONTEXT === "true") {
        const gameStatus = (mlbGameCacheLocal?.gameState?.[r.gameId]?.status) ?? null;
        console.log(`[HR_RADAR_LIVE_CONTEXT] gameId=${r.gameId} playerId=${r.playerId} gameStatus=${gameStatus ?? "?"} pat=${plateAppearancesTracked ?? 0} boxAB=${boxScoreHasContact} contactEvents=${contactEventsCount} contextMode=${hasLiveABContext ? "live" : "pregame"}`);
      }

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
      const pitcherHrVulnerability = typeof diag.pitcherHrVulnerability === "number" ? diag.pitcherHrVulnerability : null;

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

      // ── Pregame seed (presence-floor rows) — additive, display-only. ───────
      // Surface the seeded /10 score, its "why" drivers, and a display-only
      // lifted tier label. Read from diagnosticsSnapshot.pregameSeed (stamped
      // at row creation). All optional — absent on real/legacy rows.
      const pregameSeedDiag = (diag.pregameSeed ?? null) as
        | { seedScore?: number; drivers?: string[] }
        | null;
      const pregameSeedScore10: number | null =
        pregameSeedDiag && typeof pregameSeedDiag.seedScore === "number"
          ? Math.round(Math.max(0, Math.min(100, pregameSeedDiag.seedScore))) / 10
          : null;
      const pregameDrivers: string[] = Array.isArray(pregameSeedDiag?.drivers)
        ? pregameSeedDiag!.drivers.slice(0, 4)
        : [];
      // Only lift the tier for still-live, pre-contact seed rows — once real
      // contact arrives the canonical tier takes over.
      const pregameSeedTier: string | null =
        currentStatus === "live" && isPregameOnlyEntry
          ? pregameSeedTierLabel(pregameSeedScore10)
          : null;

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

      // ── Goldmaster v1 — additive user-facing stage enrichment ─────────────
      // Pure layer over existing canonical state. Never overwrites the
      // legacy currentStage / readiness scores. When the FF is off the
      // enrichment is still attached but the routes/UI may choose to ignore
      // the new fields.
      const factorsForEnrichment = (diag.factors ?? r.contactSnapshot ?? {}) as Record<string, any>;
      const enrichment = enrichWithUserStage({
        legacyTier: r.confidenceTier,
        legacyState: r.signalState,
        dynamicState: stageContractRow.dynamicState ?? null,
        canonicalStage,
        outcome,
        initialReadinessScore,
        currentReadinessScore,
        peakReadinessScore,
        initialSignalScore10,
        currentSignalScore10,
        peakSignalScore10,
        factors: factorsForEnrichment,
        triggerTags: r.triggerTags ?? [],
        positiveDrivers: (diag.positiveDrivers ?? []) as string[],
        conversionProbability: conversionProbability ?? null,
        confidenceScore: typeof diag?.confidenceScore === "number" ? diag.confidenceScore : null,
        inning: r.signalInning ?? r.detectedInning ?? null,
        detectedAt: r.detectedAt ?? null,
        detectedInning: r.detectedInning ?? null,
        signalDetectedAt: r.signalDetectedAt ?? null,
        signalInning: r.signalInning ?? null,
        hitDetectedAt: r.hitDetectedAt ?? null,
        resolvedAt: r.resolvedAt ?? null,
        hitInning: r.hitInning ?? null,
        userReasons: liveContactReasons,
        adminReasons,
        alertPath: r.alertPath ?? null,
        useFallbackScore: true,
        gameId: r.gameId,
        playerId: r.playerId,
        player: r.playerName,
      });
      // Phase 12 — emit a single-line validation log per row when the FF is
      // on AND a debug env opts in. Never noisy in production by default.
      if (HR_RADAR_GOLDMASTER_V1 && process.env.DEBUG_HR_RADAR_V1 === "true") {
        const v1 = buildValidationPayload({
          player: r.playerName,
          oldStage: currentStage,
          enrichment,
        });
        console.log("[HR_RADAR_V1_TRACE]", JSON.stringify(v1));
      }

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
        recentABs,
        userReasons: liveContactReasons,
        adminReasons,
        // Goldmaster v1 enrichment (additive — never replaces a legacy field).
        userStage: enrichment.userStage,
        stageLabel: enrichment.stageLabel,
        stageDescription: enrichment.stageDescription,
        qualifyingSignals: enrichment.qualifyingSignals,
        badges: enrichment.badges,
        cleanReasons: enrichment.cleanReasons,
        officialSignalStage: enrichment.officialSignalStage,
        officialSignalAt: enrichment.officialSignalAt,
        officialSignalInning: enrichment.officialSignalInning,
        firstTrackedAt: enrichment.firstTrackedAt,
        firstTrackedInning: enrichment.firstTrackedInning,
        firstBuiltAt: enrichment.firstBuiltAt,
        firstBuiltInning: enrichment.firstBuiltInning,
        firstReadyAt: enrichment.firstReadyAt,
        firstReadyInning: enrichment.firstReadyInning,
        firstFireAt: enrichment.firstFireAt,
        firstFireInning: enrichment.firstFireInning,
        hrOccurredAt: enrichment.hrOccurredAt,
        hrOccurredInning: enrichment.hrOccurredInning,
        debugReasons: enrichment.debugReasons,
        enginePath: enrichment.enginePath,
        summary,
        // Canonical 0-100 readiness fields (INTERNAL — admin/debug + harness).
        initialReadinessScore,
        currentReadinessScore,
        peakReadinessScore,
        buildScore,
        conversionProbability,
        pitcherHrVulnerability,
        // ── Goldmaster RESTORE — 10-point USER-FACING signal score (0.0-10.0)
        initialSignalScore10,
        currentSignalScore10,
        peakSignalScore10,
        // Conviction-aware DISPLAY scores — capped to engine's actual
        // conviction ceiling for the alertPath (see hrRadarConviction.ts).
        // These are what the user-facing card should render as headline.
        displayInitialScore10: enrichment.displayInitialScore10,
        displayCurrentScore10: enrichment.displayCurrentScore10,
        displayPeakScore10: enrichment.displayPeakScore10,
        displayGrade: enrichment.displayGrade,
        displayCap10: enrichment.displayCap10,
        displayCapBadgeLabel: enrichment.displayCapBadgeLabel,
        displayCapReason: enrichment.displayCapReason,
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
        pregameSeedScore10,
        pregameDrivers,
        pregameSeedTier,
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

      // ── HR Radar Master Fix Step 1+2 — canonical lifecycle/section/outcome.
      // Pure additive enrichment + resolved-state fixup. The legacy `section`
      // bucket already routes resolved rows to cashed/dead correctly; this is
      // defense-in-depth that ALSO surfaces the canonical fields on the wire
      // so clients can group by them per Spec Step 16.
      const fixed = applyHrRadarResolvedStateFixup(
        { ...entry, hr: r.status === "hit" ? 1 : 0, hrCount: r.status === "hit" ? 1 : 0 },
        { gameId: r.gameId, playerId: r.playerId },
      );
      // Canonical-only enrichment — never overwrites legacy `entry.section`
      // (the ladder bucket key) or legacy `entry.outcomeStatus` (DB grading).
      entry.lifecycleState = fixed.lifecycleState;
      entry.canonicalOutcomeStatus = fixed.canonicalOutcomeStatus;
      // `active` is an additive boolean — false for resolved/diagnostic.
      entry.active = (fixed as any).canonicalActive ?? fixed.active;

      const existing = seen.get(key);
      if (!existing || sectionPriority[section] < sectionPriority[existing.section]) {
        seen.set(key, { section, entry });
      }
    }

    for (const { section, entry } of Array.from(seen.values())) {
      // ── Goldmaster v1 — promote live entries whose user-stage resolves to
      // "ready" into the additive Ready bucket. The legacy `building` /
      // `watch` / `attackNow` buckets are still populated for everyone whose
      // user-stage maps elsewhere, so existing consumers continue to work.
      // Resolved (cashed/dead) and fire-tier entries always stay in their
      // legacy bucket — fire is rendered out of attackNow with the new label.
      if (HR_RADAR_GOLDMASTER_V1 && entry.currentStatus === "live" && entry.userStage === "ready") {
        sections.ready.push(entry);
      } else {
        sections[section].push(entry);
      }
    }

    // ── HR Radar display contract (presentation-only). Stamp AFTER final
    // bucketing — a live `userStage === "ready"` row is re-routed into
    // sections.ready above, so its tier-banded action score must be computed
    // against the section it actually ended up in. Never touches grading.
    const LIVE_SECTION_KEYS = ["attackNow", "ready", "building", "watch"] as const;
    for (const sectionKey of LIVE_SECTION_KEYS) {
      for (const entry of sections[sectionKey]) {
        Object.assign(entry, buildHrRadarDisplayContract(entry, sectionKey));
      }
    }

    // Within sections, order by CURRENT readiness desc (never peak — peak was
    // the old "backwards" bug). cashed by hit time desc; dead by resolved desc.
    const sortKeyCurrent = (e: HrRadarLadderEntry): number =>
      e.displayReadinessScore10 ?? getRawCurrentReadinessScore10(e) ?? 0;
    sections.cashed.sort((a, b) => (b.hitDetectedAt?.getTime() ?? 0) - (a.hitDetectedAt?.getTime() ?? 0));
    sections.attackNow.sort((a, b) => sortKeyCurrent(b) - sortKeyCurrent(a));
    sections.ready.sort((a, b) => sortKeyCurrent(b) - sortKeyCurrent(a));
    sections.building.sort((a, b) => sortKeyCurrent(b) - sortKeyCurrent(a));
    sections.watch.sort((a, b) => sortKeyCurrent(b) - sortKeyCurrent(a));
    sections.dead.sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0));

    const counts = {
      attackNow: sections.attackNow.length,
      building: sections.building.length,
      watch: sections.watch.length,
      cashed: sections.cashed.length,
      dead: sections.dead.length,
      ready: sections.ready.length,
      total: seen.size,
    };

    console.log(`[HR_DECISION_LADDER_COUNTS] sessionDate=${targetDate} attackNow=${counts.attackNow} building=${counts.building} watch=${counts.watch} ready=${counts.ready} cashed=${counts.cashed} dead=${counts.dead} total=${counts.total} v1=${HR_RADAR_GOLDMASTER_V1}`);

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
    // Raw engine identifier codes (FSM / prob-rail promotion reasons) are bare
    // lowercase snake_case / colon-joined tokens with no spaces — e.g.
    // "prob_rail:bet_now_attack_sustained", "dynamic_bet_now_build",
    // "pitcher_fade_vuln_30", "betnow_attack_sustained_contact_driver". They are
    // observability codes, never user copy, so they must stay admin-only. The
    // curated KNOWN_GOOD_TAGS (which humanizeHrRadarTag maps to real product
    // language) are exempt.
    const RAW_IDENTIFIER_RE = /^[a-z][a-z0-9]*([_:][a-z0-9]+)+$/;
    const KNOWN_GOOD_TAGS = new Set([
      "hot_hitter", "barrel_streak", "hard_contact", "pitcher_fade",
      "pitcher_fatigue", "bvp_advantage", "park_boost", "wind_out",
      "lineup_protection", "due_up_soon", "high_xba_zone", "ev_uptick",
    ]);
    const looksLikeJargon = (s: string): boolean => {
      const t = s.trim();
      if (ENGINE_JARGON_PREFIX_RE.test(t) || ENGINE_JARGON_TOKEN_RE.test(t)) return true;
      // Bare engine identifier code that isn't a curated good tag → jargon.
      if (RAW_IDENTIFIER_RE.test(t) && !KNOWN_GOOD_TAGS.has(t)) return true;
      return false;
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
  /** Stamped by the route layer once the game is Final (additive). Lets the client
   * hide live-only CTAs/timing even if the row briefly sat in a live section. */
  isGameFinal?: boolean;
  /**
   * Compact per-PA projection (additive, transport-only) for the card's
   * collapsed chip + inline At-Bat Log expand. Mirrors the
   * /api/mlb/hr-radar-analyze priorABs shape. Capped to the most recent 6 PAs.
   * Optional — absent on pregame/legacy rows.
   */
  recentABs?: Array<{
    abNumber: number;
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: string;
    isBarrel: boolean;
    isHardHit: boolean;
    perABxBA: number | null;
    contactGrade: string | null;
  }>;
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
  /** Pitcher HR vulnerability score (0-100). Higher = pitcher more vulnerable. Admin/debug only. */
  pitcherHrVulnerability: number | null;

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
  // ── Conviction-aware DISPLAY scores (additive, never replace signal*10). ───
  // For rows whose alertPath the engine intentionally locks at WATCH (e.g.
  // PATH_F_BLOCKED_BRIDGE, capped at confidenceScore=6), these mirror the
  // signal*10 fields capped to the engine's actual conviction ceiling.
  // Frontends should render `displayCurrentScore10` as the headline /10 so
  // the displayed number matches the section the engine assigned the row.
  // The raw signal*10 fields remain unchanged for admin/debug surfaces.
  // See `shared/hrRadarConviction.ts`.
  displayInitialScore10: number | null;
  displayCurrentScore10: number | null;
  displayPeakScore10: number | null;
  /**
   * Server-computed letter grade (stage × displayCurrentScore10) — mirrors
   * MLB props' `displayGrade`. Null for resolved rows. Read verbatim on the
   * client; never re-derived from stage alone.
   */
  displayGrade: HrRadarDisplayGrade | null;
  /** /10 ceiling applied (null when no cap was applied). */
  displayCap10: number | null;
  /** Pill label for capped rows (null when uncapped). */
  displayCapBadgeLabel: string | null;
  /** One-sentence why-capped explanation for the modal/tooltip. */
  displayCapReason: string | null;
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

  // ── Pregame seed (presence-floor rows) — additive, display-only. ───────────
  /** Pregame seed score on the user-facing 0.0-10.0 scale (null for non-seed rows). */
  pregameSeedScore10?: number | null;
  /** Top pregame "why" drivers (e.g. "Hitter park", "Elite xISO", "Slot 2"). */
  pregameDrivers?: string[];
  /** Display-only lifted tier label from the seed ("LEAN"/"WATCH"); null = no lift. */
  pregameSeedTier?: string | null;

  // ── Pre-Game Power Radar bridge (additive, display-only; stamped in the
  // ladder route from the separate Pre-Game Power Radar — NOT the seed above). ─
  /** True when this live row matched a current non-suppressed pre-game target. */
  pregamePowerTarget?: boolean;
  /** Pre-Game Power tier: "watch"|"strong"|"elite"|"nuclear". */
  pregamePowerTier?: string | null;
  /** Pre-Game Power 0.0–10.0 score. */
  pregamePowerScore10?: number | null;
  /** Pre-Game Power primary market: "home_runs"|"total_bases". */
  pregamePowerMarket?: string | null;

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
  // ── HR Radar Master Fix — canonical lifecycle / section / outcome
  // (additive; never replaces the legacy currentStage / outcome / outcomeStatus
  // fields above). Spec: lifecycleState ∈
  //   pregame|watch|build|ready|attack|cashed|missed|late_signal|uncalled_hr|inactive
  // Spec: section ∈
  //   attack|ready|build|watch|cashed|missed|diagnostic|inactive
  // Spec: canonicalOutcomeStatus ∈
  //   active|called_hit|called_miss|uncalled_hr|late_signal|unresolved
  // active=false marks resolved/diagnostic rows so clients never paint them
  // inside an active section bucket.
  lifecycleState?: string;
  section?: string;
  canonicalOutcomeStatus?: string;
  active?: boolean;
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

  // ── Goldmaster v1 — additive user-facing stage layer. ──────────────────────
  // All fields below are pure surfacing — they are derived from the same row
  // data above and never replace any legacy field. Frontends gate on the
  // presence of `userStage` to opt into the new copy/labels.
  /** "track" | "build" | "ready" | "fire" | "resolved" — user-facing ladder. */
  userStage: HrRadarUserStage;
  /** Capitalized label e.g. "Track" / "Build" / "Ready" / "Fire" / "Resolved". */
  stageLabel: string;
  /** Plain-English description for the user-facing stage. */
  stageDescription: string;
  /** Qualifying signals derived from existing diagnostic snapshot. */
  qualifyingSignals: HrQualifyingSignalType[];
  /** Canonical badge set (shared/hrRadarStage.ts) — rendered verbatim by UI. */
  badges: HrRadarBadge[];
  /** Alias of userReasons — explicit "clean" channel for the new UI. */
  cleanReasons: string[];
  /** Additive grading shadow: FIRE-only official stage (null unless committed). */
  officialSignalStage: "fire" | null;
  officialSignalAt: string | null;
  officialSignalInning: number | null;
  /** Write-once user-stage timestamps (in-memory; not persisted yet). */
  firstTrackedAt: string | null;
  firstTrackedInning: number | null;
  firstBuiltAt: string | null;
  firstBuiltInning: number | null;
  firstReadyAt: string | null;
  firstReadyInning: number | null;
  firstFireAt: string | null;
  firstFireInning: number | null;
  /** When the HR landed (ISO + inning), null while live/pending. */
  hrOccurredAt: string | null;
  hrOccurredInning: number | null;
  /** Hidden debug surface — admin-only. */
  debugReasons: string[];
  enginePath: string | null;

  // ── HR Radar display contract (presentation-only; see hrRadarDisplayContract.ts).
  // Stamped after final bucketing. All optional + additive — never replace any
  // legacy field, never affect grading/qualification/W-L.
  /** True calibrated HR probability as a whole percent. Never tier-capped. */
  displayHrChancePct?: number | null;
  /** Raw current readiness on the 0-10 scale (NOT path/section-capped). */
  displayReadinessScore10?: number | null;
  /** Tier-banded actionability score on the 0-10 scale. */
  displayActionScore10?: number | null;
  /** Tier-banded actionability as a whole percent (drives the window bar). */
  displayActionPct?: number | null;
  /** Friendly live tier. */
  displayStageLabel?: "TOP WINDOW" | "ALMOST" | "WATCHING";
  displayStageSubLabel?: string;
  /** First user-safe reason (humanized). */
  displayPrimaryReason?: string | null;
  /** Why a lower-tier card is not yet a top-window play (null for TOP WINDOW). */
  displayWhyNotTopWindow?: string | null;
  /** Display-only: derived from officialSignalStage. Not a grading write. */
  displayRecordEligible?: boolean;
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
    if (CALLED_HIT_OUTCOME_STATUSES.has(grading as any)) {
      totals.calledHit++; ensureTier(tier).calledHit++; ensureInning(inning).calledHit++;
    } else {
      switch (grading) {
        case "called_miss": totals.calledMiss++; ensureTier(tier).calledMiss++; ensureInning(inning).calledMiss++; break;
        case "uncalled_hr": totals.uncalledHr++; ensureTier(tier).uncalledHr++; ensureInning(inning).uncalledHr++; break;
        case "late_signal": totals.lateSignal++; ensureTier(tier).lateSignal++; ensureInning(inning).lateSignal++; break;
        default:            totals.activeOrUnresolved++;
      }
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
