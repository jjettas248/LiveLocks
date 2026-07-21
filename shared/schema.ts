import { pgTable, text, serial, numeric, integer, timestamp, boolean, index, primaryKey, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  subscriptionTier: text("subscription_tier"),
  playsUsed: integer("plays_used").notNull().default(0),
  playsUsedToday: integer("plays_used_today").notNull().default(0),
  playsResetDate: text("plays_reset_date"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  createdAt: timestamp("created_at").defaultNow(),
  pushSubscription: text("push_subscription"),
  pushAlerts: boolean("push_alerts").notNull().default(false),
  phoneNumber: text("phone_number"),
  smsAlerts: boolean("sms_alerts").notNull().default(false),
  smsConsent: boolean("sms_consent").notNull().default(false),
  isNewProUser: boolean("is_new_pro_user").default(false),
  requiresRefresh: boolean("requires_refresh").default(false),
  upgradedAt: text("upgraded_at"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  originalEmail: text("original_email"),
  normalizedEmail: text("normalized_email").unique(),
  signupFingerprint: text("signup_fingerprint"),
  verificationLastSentAt: timestamp("verification_last_sent_at"),
  sentWelcome: boolean("sent_welcome").notNull().default(false),
  sentWalkthrough: boolean("sent_walkthrough").notNull().default(false),
  sentDay3: boolean("sent_day3").notNull().default(false),
  sentWinback: boolean("sent_winback").notNull().default(false),
  sentWall: boolean("sent_wall").notNull().default(false),
  sentProWelcome: boolean("sent_pro_welcome").notNull().default(false),
  sentAllSportsWelcome: boolean("sent_all_sports_welcome").notNull().default(false),
  unlockedGameIdsToday: text("unlocked_game_ids_today").notNull().default("[]"),
  churnedAt: timestamp("churned_at"),
  churnedFromTier: text("churned_from_tier"),
  resetPasswordToken: text("reset_password_token"),
  resetPasswordExpiry: timestamp("reset_password_expiry"),
  hasCompletedOnboarding: boolean("has_completed_onboarding").notNull().default(false),
  sportFocus: text("sport_focus"),
  // Lifecycle (Pass 2 — additive only; nullable; does NOT reinterpret subscriptionTier).
  // Allowed values are documented for callers but not enforced at the DB layer to keep
  // existing code paths safe if a value is unset.
  //   subscriptionStatus: "free" | "trialing" | "active" | "canceled" | "past_due" | null
  //   subscriptionSource: "trial" | "direct_paid" | "admin" | null
  //   alertsChannelStatus: "unavailable" | "available_not_connected" | "connected" | null
  subscriptionStatus: text("subscription_status"),
  subscriptionSource: text("subscription_source"),
  trialStartedAt: timestamp("trial_started_at"),
  trialEndsAt: timestamp("trial_ends_at"),
  convertedToPaidAt: timestamp("converted_to_paid_at"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end"),
  trialAbandonedAt: timestamp("trial_abandoned_at"),
  alertsChannelStatus: text("alerts_channel_status"),
  telegramChatId: text("telegram_chat_id"),
  telegramUsername: text("telegram_username"),
  telegramConnectedAt: timestamp("telegram_connected_at"),
  telegramConnectionStatus: text("telegram_connection_status"),
  lastLoginAt: timestamp("last_login_at"),
});

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertUserEmailPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  team: text("team").notNull(),
  position: text("position").notNull(),
  avgMinutes: numeric("avg_minutes").notNull(),
  avgFouls: numeric("avg_fouls").notNull(),
  espnAthleteId: integer("espn_athlete_id"),
  // Season stats — synced from NBA.com + NBaStuffer + ESPN
  ppg: numeric("ppg"),
  rpg: numeric("rpg"),
  apg: numeric("apg"),
  spg: numeric("spg"),
  bpg: numeric("bpg"),
  tpg: numeric("tpg"),
  usageRate: numeric("usage_rate"),
  offRating: numeric("off_rating"),
  tsPct: numeric("ts_pct"),
  // Second-half season averages (NBA.com GameSegment=Second+Half)
  h2ppg: numeric("h2ppg"),
  h2rpg: numeric("h2rpg"),
  h2apg: numeric("h2apg"),
  h2spg: numeric("h2spg"),
  h2bpg: numeric("h2bpg"),
  h2tpg: numeric("h2tpg"),
  h2avgMinutes: numeric("h2_avg_minutes"),
  statsUpdatedAt: timestamp("stats_updated_at"),
  projectedMinutes: numeric("projected_minutes"),
  projectionSource: text("projection_source"),
  projectionUpdatedAt: timestamp("projection_updated_at"),
});

export const teamDefense = pgTable("team_defense", {
  id: serial("id").primaryKey(),
  teamName: text("team_name").notNull(),
  position: text("position").notNull(),
  defRating: numeric("def_rating").notNull(),
});

export const parlayPicks = pgTable("parlay_picks", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  playerId: integer("player_id").notNull(),
  statType: text("stat_type").notNull(),
  line: numeric("line").notNull(),
  sportsbook: text("sportsbook").notNull(),
  probability: numeric("probability").notNull(),
  oddsAmerican: integer("odds_american"),
  gameId: text("game_id"),
  addedAt: timestamp("added_at").defaultNow(),
});

export const insertPlayerSchema = createInsertSchema(players).omit({ id: true });
export const insertTeamDefenseSchema = createInsertSchema(teamDefense).omit({ id: true });
export const insertParlayPickSchema = createInsertSchema(parlayPicks).omit({ id: true, addedAt: true });

export type Player = typeof players.$inferSelect;
export type InsertPlayer = z.infer<typeof insertPlayerSchema>;
export type TeamDefense = typeof teamDefense.$inferSelect;
export type InsertTeamDefense = z.infer<typeof insertTeamDefenseSchema>;
export type ParlayPick = typeof parlayPicks.$inferSelect;
export type InsertParlayPick = z.infer<typeof insertParlayPickSchema>;

export const calculateProbabilitySchema = z.object({
  playerId: z.coerce.number(),
  opponentTeam: z.string(),
  halftimeMinutes: z.coerce.number(),
  halftimeFouls: z.coerce.number(),
  halftimeStat: z.coerce.number(),
  liveLine: z.coerce.number(),
  statType: z.string(),
  halftimeScore: z.string().optional(),
  gameId: z.string().optional(),
  gameSpread: z.coerce.number().optional(),
  gameTotalLine: z.coerce.number().optional(),
  // Any-point calculator fields
  currentPeriod: z.coerce.number().min(0).max(4).optional(),
  gameClock: z.string().optional(),
  // Live shooting efficiency (current game)
  liveFgm: z.coerce.number().optional(),
  liveFga: z.coerce.number().optional(),
  liveFtm: z.coerce.number().optional(),
  liveFta: z.coerce.number().optional(),
  liveFg3m: z.coerce.number().optional(),
  liveFg3a: z.coerce.number().optional(),
  direction: z.enum(["OVER", "UNDER"]).optional(),
  isDebug: z.boolean().optional(),
  bookOdds: z.coerce.number().optional(),
  gameDate: z.string().optional(),
  // NBA Calibration v2 — odds freshness signal for the elite gate. When the
  // book line is stale (>10min) the gate refuses to award elite conviction.
  oddsAgeSec: z.coerce.number().optional(),
});

export type CalculateProbabilityRequest = z.infer<typeof calculateProbabilitySchema>;

export interface CalcDebug {
  projection: number;
  line: number;
  edge: number;
  seasonPerMin: number | null;
  observedPerMin: number;
  observedWeight: number;
  seasonWeight: number;
  remainingMinutes: number;
  paceMultiplier: number;
  defenseMultiplier: number;
  shootingModifier: number;
  contextModifier: number;
  probabilityCalibrated: number;
  expectedRemainingMinutes?: number;
  closingProbability?: number;
  minutesConfidence?: "low" | "medium" | "high";
  projectedMinutes?: number | null;
  projectionSource?: string;
  volatilityFiltered?: boolean;
  usageUnderPenaltyApplied?: boolean;
  comboVariancePenaltyApplied?: boolean;
  effectiveMinutesBase?: number;
  rotationSource?: "projected" | "season_avg";
  noSignal?: boolean;
  seasonPhase?: "early" | "mid" | "late" | "playoffs";
  lateSeasonPenaltyApplied?: boolean;
  playoffBoostApplied?: boolean;
  teamVolatilityPenaltyApplied?: boolean;
  usageMultiplier?: number;
  archetype?: "superstar" | "primary" | "role" | "rotation" | "volatile" | "stable_star" | "stable_starter" | "volatile_starter" | "bench_microwave" | "low_minute_big" | "lineup_impacted" | "role_uncertain";
  overConfidence?: number;
  underConfidence?: number;
  displayConfidence?: number | null;
  recommendedSide?: "OVER" | "UNDER" | "NO_SIGNAL";
  warnings?: string[];
  // ── Playoff diagnostics (PHASE 6) ──────────────────────────────────────
  playoffMode?: boolean;
  playoffDataRequested?: boolean;
  playoffDataResolved?: boolean;
  playoffDataFallbackUsed?: boolean;
  playoffCalibrationApplied?: boolean;
  playoffMinutesAdjustmentApplied?: boolean;
  playoffCeilingApplied?: boolean;
  playoffCeilingValue?: number | null;
  regularCeilingValue?: number;
  playoffHighBucketGuardApplied?: boolean;
  playoffFallbackCapApplied?: boolean;
  seasonPhaseResolvedFrom?: "gameDate" | "systemDate";
}

export interface CalculateProbabilityResponse {
  probability: number;
  edge: number;
  expectedTotal: number;
  projectedSecondHalfMinutes: number;
  defenseMultiplier: number;
  paceMultiplier: number;
  paceLabel: string;
  teamPace: number;
  opponentPace: number;
  gameMinutesRemaining?: number;
  inSecondHalf?: boolean;
  baselineSource?: "h2" | "fullGame";
  noSignal?: boolean;
  recommendedSide?: "OVER" | "UNDER" | "NO_SIGNAL";
  displayConfidence?: number | null;
  overConfidence?: number;
  underConfidence?: number;
  warnings?: string[];
  debug?: CalcDebug;
}

export interface LiveGame {
  id: string;
  homeTeam: string;
  homeTeamAbbr: string;
  homeScore: number;
  awayTeam: string;
  awayTeamAbbr: string;
  awayScore: number;
  status: string;
  period: number;
  clock: string;
  startTime?: string; // ISO timestamp, only present for Scheduled games
}

export interface LivePlayerStat {
  playerId: number | null;
  playerName: string;
  teamAbbr: string;
  gameId?: string;
  minutes: string;
  points: number;
  rebounds: number;
  assists: number;
  steals: number;
  blocks: number;
  fouls: number;
  threes: number;
  fgm?: number;
  fga?: number;
  ftm?: number;
  fta?: number;
  fg3m?: number;
  fg3a?: number;
}

export interface InjuryPlayer {
  playerId: string;
  playerName: string;
  team: string;
  status: string;
  type: string;
  detail: string;
}

export interface OddsLine {
  sportsbook: string;
  line: number;
  overOdds: number;
  underOdds: number;
  openLine?: number;       // First line seen this session (proxy for opening line)
  lineMovement?: number;   // current - openLine: negative = dropped, positive = rose
  edgeEstimate?: number;   // rough win-prob shift (%) per direction vs open
}

export interface ParlayPickInput {
  playerId: number;
  playerName: string;
  playerTeam: string;
  statType: string;
  line: number;
  probability: number;
  betDirection: "over" | "under";
  sportsbook: string;
  oddsAmerican: number;
  gameId?: string;
  isEstimated?: boolean;
  type?: "live" | "pre_game";
  confidenceTier?: string;
}

export interface ParlayResult {
  picks: ParlayPickInput[];
  combinedProbability: number;
  correlationAdjustedProbability: number;
  impliedAmericanOdds: number;
  correlations: CorrelationNote[];
}

export interface CorrelationNote {
  pick1: string;
  pick2: string;
  type: "positive" | "negative" | "neutral";
  multiplier: number;
  explanation: string;
}

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  slateResetHour: integer("slate_reset_hour").notNull().default(6),
  slateResetMinute: integer("slate_reset_minute").notNull().default(0),
});

export const feedback = pgTable("feedback", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertFeedbackSchema = createInsertSchema(feedback).omit({ id: true, createdAt: true });
export type Feedback = typeof feedback.$inferSelect;
export type InsertFeedback = z.infer<typeof insertFeedbackSchema>;

export const halftimePlayAlerts = pgTable("halftime_play_alerts", {
  id: serial("id").primaryKey(),
  gameId: text("game_id").notNull(),
  gameDate: text("game_date").notNull(),
  playerId: integer("player_id").notNull(),
  playerName: text("player_name").notNull(),
  team: text("team").notNull(),
  opponent: text("opponent").notNull(),
  statType: text("stat_type").notNull(),
  halftimeStat: numeric("halftime_stat").notNull(),
  line: numeric("line").notNull(),
  probability: numeric("probability").notNull(),
  betDirection: text("bet_direction").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const playResults = pgTable("play_results", {
  id: serial("id").primaryKey(),
  alertId: integer("alert_id").notNull(),
  actualStat: numeric("actual_stat").notNull(),
  hit: boolean("hit").notNull(),
  resolvedAt: timestamp("resolved_at").defaultNow(),
});

export const insertHalftimePlayAlertSchema = createInsertSchema(halftimePlayAlerts).omit({ id: true, createdAt: true });
export const insertPlayResultSchema = createInsertSchema(playResults).omit({ id: true, resolvedAt: true });

export type HalftimePlayAlert = typeof halftimePlayAlerts.$inferSelect;
export type InsertHalftimePlayAlert = z.infer<typeof insertHalftimePlayAlertSchema>;
export type PlayResult = typeof playResults.$inferSelect;
export type InsertPlayResult = z.infer<typeof insertPlayResultSchema>;

export interface BucketStat {
  label: string;
  min: number;
  max: number;
  total: number;
  hits: number;
  winRate: number;
  roi: number;
  expectedWinRate: number;
  actualWinRate: number;
  calibrationError: number;
}

export interface AnalyticsSummary {
  buckets: BucketStat[];
  totalPlays: number;
  overallWinRate: number;
}

export interface PlayAlertWithResult extends HalftimePlayAlert {
  actualStat: string | null;
  hit: boolean | null;
  resolvedAt: Date | null;
}

// ── Persistent plays table ─────────────────────────────────────────────────────
export const persistedPlays = pgTable("persisted_plays", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id"),
  playerName: text("player_name").notNull(),
  team: text("team"),
  sport: text("sport").notNull().default("nba"),
  market: text("market").notNull(),
  direction: text("direction").notNull(),
  line: numeric("line").notNull(),
  prob: numeric("prob").notNull(),
  engineProb: numeric("engine_prob"),
  bookImplied: numeric("book_implied"),
  edgeGap: numeric("edge_gap"),
  engineVersion: text("engine_version"),
  projection: numeric("projection"),
  sportsbook: text("sportsbook"),
  derivedLine: boolean("derived_line"),
  gameDate: text("game_date").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  result: text("result"),
  finalStat: numeric("final_stat"),
  settledAt: timestamp("settled_at"),
  notificationSent: boolean("notification_sent").default(false),
  duplicateGuard: text("duplicate_guard").unique(),
  archetype: text("archetype"),
  fragilityScore: numeric("fragility_score"),
  familyId: text("family_id"),
  siblingCount: integer("sibling_count"),
  siblingRank: integer("sibling_rank"),
  flagshipOrDerivative: text("flagship_or_derivative"),
  familyPenaltyFactor: numeric("family_penalty_factor"),
  calibrationTrack: text("calibration_track"),
  confidenceCeilingApplied: boolean("confidence_ceiling_applied"),
  ceilingReason: text("ceiling_reason"),
  rawProbOver: numeric("raw_prob_over"),
  rawProbUnder: numeric("raw_prob_under"),
  modelEdge: numeric("model_edge"),
  minutesExpected: numeric("minutes_expected"),
  minutesVariance: numeric("minutes_variance"),
  marketType: text("market_type"),
  finalProbOver: numeric("final_prob_over"),
  finalProbUnder: numeric("final_prob_under"),
  displayConfidence: numeric("display_confidence"),
  playerVolatilityScore: numeric("player_volatility_score"),
  comboCovarianceEstimate: numeric("combo_covariance_estimate"),
  fragilityPenalty: numeric("fragility_penalty"),
  fragilityReasons: text("fragility_reasons"),
  mu: numeric("mu"),
  sigma: numeric("sigma"),
  zScore: numeric("z_score"),
  hrBuildScore: numeric("hr_build_score"),
  hrIntensity: text("hr_intensity"),
  signalScore: numeric("signal_score"),
  opportunityScore: numeric("opportunity_score"),
  liveScore: numeric("live_score"),
  eventBoost: numeric("event_boost"),
  odds: numeric("odds"),
  stake: numeric("stake").default("1"),
  payout: numeric("payout"),
  inning: integer("inning"),
  abNumber: integer("ab_number"),
  pitchCount: integer("pitch_count"),
  contactQualityScore: numeric("contact_quality_score"),
  confidenceTier: text("confidence_tier"),
}, (table) => ({
  gameDateIdx: index("persisted_plays_game_date_idx").on(table.gameDate),
  resultIdx: index("persisted_plays_result_idx").on(table.result),
  sportIdx: index("persisted_plays_sport_idx").on(table.sport),
}));

export const insertPersistedPlaySchema = createInsertSchema(persistedPlays).omit({ createdAt: true });
export type PersistedPlay = typeof persistedPlays.$inferSelect;
export type InsertPersistedPlay = z.infer<typeof insertPersistedPlaySchema>;

// ── Sent-alerts dedup table ───────────────────────────────────────────────────
export const sentAlerts = pgTable(
  "sent_alerts",
  {
    id:          serial("id").primaryKey(),
    fingerprint: text("fingerprint").notNull().unique(),
    userId:      integer("user_id").references(() => users.id),
    sentAt:      timestamp("sent_at").defaultNow(),
  },
  (t) => ({ fingerprintIdx: index("idx_sent_alerts_fingerprint").on(t.fingerprint, t.userId) })
);

export const contactEvents = pgTable("contact_events", {
  id: serial("id").primaryKey(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  gameId: text("game_id").notNull(),
  inning: integer("inning"),
  exitVelocity: numeric("exit_velocity"),
  launchAngle: numeric("launch_angle"),
  distance: numeric("distance"),
  batSpeed: numeric("bat_speed"),
  result: text("result"),
  pitchType: text("pitch_type"),
  pitchSpeed: numeric("pitch_speed"),
  isBarrel: boolean("is_barrel").default(false),
  eventFingerprint: text("event_fingerprint").unique(),
  timestamp: timestamp("timestamp").defaultNow(),
}, (table) => ({
  playerGameIdx: index("contact_events_player_game_idx").on(table.playerId, table.gameId),
  gameIdx: index("contact_events_game_idx").on(table.gameId),
}));

export const insertContactEventSchema = createInsertSchema(contactEvents).omit({ id: true, timestamp: true });
export type ContactEvent = typeof contactEvents.$inferSelect;
export type InsertContactEvent = z.infer<typeof insertContactEventSchema>;

export const gamePlayerStats = pgTable("game_player_stats", {
  id: serial("id").primaryKey(),
  gameId: text("game_id").notNull(),
  gamePk: text("game_pk"),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  teamAbbr: text("team_abbr"),
  teamSide: text("team_side"),
  battingOrderSlot: integer("batting_order_slot"),
  ab: integer("ab").default(0),
  h: integer("h").default(0),
  tb: integer("tb").default(0),
  r: integer("r").default(0),
  rbi: integer("rbi").default(0),
  bb: integer("bb").default(0),
  k: integer("k").default(0),
  sb: integer("sb").default(0),
  abResults: text("ab_results"),
  gameDate: text("game_date"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  gamePlayerIdx: uniqueIndex("game_player_stats_game_player_idx").on(table.gameId, table.playerId),
  gameIdx: index("game_player_stats_game_idx").on(table.gameId),
  playerIdx: index("game_player_stats_player_idx").on(table.playerId),
  dateIdx: index("game_player_stats_date_idx").on(table.gameDate),
}));

export const insertGamePlayerStatsSchema = createInsertSchema(gamePlayerStats).omit({ id: true, createdAt: true });
export type GamePlayerStat = typeof gamePlayerStats.$inferSelect;

// Task #129 — point-in-time snapshot of the batter rolling stats that were
// effectively live at end-of-slate on `sessionDate`. Used by the presence-
// floor backtest harness so historical replay reflects the values the floor
// pass would actually have seen, not whatever the season-to-date number
// happens to be at script run time.
export const batterRollingSnapshots = pgTable("batter_rolling_snapshots", {
  id: serial("id").primaryKey(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name"),
  sessionDate: text("session_date").notNull(),
  season: integer("season"),
  seasonHRRate: numeric("season_hr_rate"),
  hrRateLast30: numeric("hr_rate_last_30"),
  barrelRate: numeric("barrel_rate"),
  isHotHitter: boolean("is_hot_hitter").notNull().default(false),
  source: text("source").notNull().default("nightly_cron"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  dedupIdx: uniqueIndex("batter_rolling_snapshots_dedup_idx").on(table.playerId, table.sessionDate),
  dateIdx: index("batter_rolling_snapshots_session_date_idx").on(table.sessionDate),
}));

export const insertBatterRollingSnapshotSchema = createInsertSchema(batterRollingSnapshots).omit({ id: true, createdAt: true, updatedAt: true });
export type BatterRollingSnapshot = typeof batterRollingSnapshots.$inferSelect;
export type InsertBatterRollingSnapshot = z.infer<typeof insertBatterRollingSnapshotSchema>;
export type InsertGamePlayerStat = z.infer<typeof insertGamePlayerStatsSchema>;

export const persistedAlerts = pgTable("persisted_alerts", {
  id: serial("id").primaryKey(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  teamAbbr: text("team_abbr"),
  gameId: text("game_id").notNull(),
  alertType: text("alert_type").notNull(),
  triggerReason: text("trigger_reason"),
  hrBuildScore: numeric("hr_build_score"),
  hrIntensity: text("hr_intensity"),
  inning: integer("inning"),
  factors: text("factors"),
  outcome: text("outcome"),
  resolvedAt: timestamp("resolved_at"),
  hitInning: integer("hit_inning"),
  hitHalf: text("hit_half"),
  hitPaNumber: integer("hit_pa_number"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  gameIdx: index("persisted_alerts_game_idx").on(table.gameId),
  playerGameIdx: index("persisted_alerts_player_game_idx").on(table.playerId, table.gameId),
  createdIdx: index("persisted_alerts_created_idx").on(table.createdAt),
}));

export const insertPersistedAlertSchema = createInsertSchema(persistedAlerts).omit({ id: true, createdAt: true });
export type PersistedAlert = typeof persistedAlerts.$inferSelect;
export type InsertPersistedAlert = z.infer<typeof insertPersistedAlertSchema>;

export const hrRadarAlerts = pgTable("hr_radar_alerts", {
  id: text("id").primaryKey(),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  team: text("team").notNull(),
  opponent: text("opponent"),

  detectedAt: timestamp("detected_at").notNull(),
  detectedInning: integer("detected_inning"),
  detectedHalf: text("detected_half"),
  detectedLabel: text("detected_label"),

  initialReadinessScore: numeric("initial_readiness_score"),
  currentReadinessScore: numeric("current_readiness_score"),
  peakReadinessScore: numeric("peak_readiness_score"),

  scoreIncreased: boolean("score_increased").notNull().default(false),
  scoreIncreaseAmount: numeric("score_increase_amount"),
  scoreIncreaseInning: integer("score_increase_inning"),
  scoreIncreaseHalf: text("score_increase_half"),
  scoreIncreaseLabel: text("score_increase_label"),

  confidenceTier: text("confidence_tier").notNull().default("monitor"),
  signalState: text("signal_state").notNull().default("live"),
  triggerTags: text("trigger_tags").array().notNull().default([]),
  summaryText: text("summary_text"),

  contactSnapshot: jsonb("contact_snapshot"),

  alertPath: text("alert_path"),
  alertTier: text("alert_tier"),
  diagnosticsSnapshot: jsonb("diagnostics_snapshot"),

  status: text("status").notNull().default("live"),
  hitInning: integer("hit_inning"),
  hitHalf: text("hit_half"),
  hitLabel: text("hit_label"),
  resolvedAt: timestamp("resolved_at"),

  // Explicit grading truth model — separates called hits from uncalled/late HRs
  gradingStatus: text("grading_status").notNull().default("active"), // active | called_hit | called_miss | uncalled_hr | late_signal
  gradingReason: text("grading_reason"),
  matchedBeforeHr: boolean("matched_before_hr").notNull().default(false),
  fallbackCreated: boolean("fallback_created").notNull().default(false),
  userVisible: boolean("user_visible").notNull().default(true),
  matchMethod: text("match_method"), // direct_pre_hr_signal | post_hr_fallback | player_game_only | none

  // Preserved separately from hit timing — never overwrite signal inning with hit inning
  signalDetectedAt: timestamp("signal_detected_at"),
  signalInning: integer("signal_inning"),
  signalHalf: text("signal_half"),
  hitDetectedAt: timestamp("hit_detected_at"),

  // ── Phase 0 diagnostic persistence (2026-06) — make future misses
  // diagnosable from the DB alone, separating model weakness from missing
  // data. All nullable/additive; absent on legacy rows. ──
  rawPreCapScore: numeric("raw_pre_cap_score"),      // readiness before any data-quality cap
  finalScore: numeric("final_score"),                 // readiness after caps/suppression
  capReason: text("cap_reason"),                      // which cap bound the score, if any
  suppressionReason: text("suppression_reason"),      // below_threshold_with_full_data | below_threshold_with_degraded_data | ...
  missingInputs: text("missing_inputs").array(),      // missing_statcast | degraded_contact_data | missing_batter_power | missing_handedness_splits
  confidence: numeric("confidence"),                  // 0..1 confidence given data completeness
  dataQualityFlags: text("data_quality_flags").array(), // full | degraded | missing markers
  firstSeenAt: timestamp("first_seen_at"),            // first time this candidate entered the radar
  promotedAt: timestamp("promoted_at"),               // first time it reached an actionable tier
  alertSentAt: timestamp("alert_sent_at"),            // when an alert was actually dispatched

  analyticsPersisted: boolean("analytics_persisted").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  sessionIdx: index("hr_radar_alerts_session_idx").on(table.sessionDate),
  gameIdx: index("hr_radar_alerts_game_idx").on(table.gameId),
  playerGameSessionIdx: uniqueIndex("hr_radar_alerts_player_game_session_idx").on(table.sessionDate, table.gameId, table.playerId),
  statusIdx: index("hr_radar_alerts_status_idx").on(table.status),
  gradingStatusIdx: index("hr_radar_alerts_grading_status_idx").on(table.gradingStatus),
  userVisibleIdx: index("hr_radar_alerts_user_visible_idx").on(table.userVisible),
}));

export const hrRadarSignalEvents = pgTable("hr_radar_signal_events", {
  id: serial("id").primaryKey(),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  team: text("team").notNull(),
  alertId: text("alert_id"),
  eventType: text("event_type").notNull(), // created | escalated | downgraded | suppressed | resolved_hit | resolved_miss | uncalled_hr | late_signal
  signalState: text("signal_state"),       // watch | lean | strong | elite | live | watching | actionable
  score: numeric("score"),
  confidenceTier: text("confidence_tier"),
  triggerTags: jsonb("trigger_tags"),
  drivers: jsonb("drivers"),
  detectedAt: timestamp("detected_at").notNull(),
  inning: integer("inning"),
  half: text("half"),
  outs: integer("outs"),
  pitchNumber: integer("pitch_number"),
  plateAppearanceId: text("plate_appearance_id"),
  batterSnapshot: jsonb("batter_snapshot"),
  pitcherSnapshot: jsonb("pitcher_snapshot"),
  source: text("source").notNull().default("engine"), // engine | grader | admin
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  sessionIdx: index("hr_radar_signal_events_session_idx").on(table.sessionDate),
  gameIdx: index("hr_radar_signal_events_game_idx").on(table.gameId),
  playerGameIdx: index("hr_radar_signal_events_player_game_idx").on(table.gameId, table.playerId),
  alertIdx: index("hr_radar_signal_events_alert_idx").on(table.alertId),
  detectedAtIdx: index("hr_radar_signal_events_detected_at_idx").on(table.detectedAt),
}));

export const insertHrRadarSignalEventSchema = createInsertSchema(hrRadarSignalEvents).omit({ id: true, createdAt: true });
export type HrRadarSignalEvent = typeof hrRadarSignalEvents.$inferSelect;
export type InsertHrRadarSignalEvent = z.infer<typeof insertHrRadarSignalEventSchema>;

export const insertHrRadarAlertSchema = createInsertSchema(hrRadarAlerts).omit({ createdAt: true });
export type HrRadarAlert = typeof hrRadarAlerts.$inferSelect;
export type InsertHrRadarAlert = z.infer<typeof insertHrRadarAlertSchema>;

export const hrRadarAnalytics = pgTable("hr_radar_analytics", {
  id: serial("id").primaryKey(),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  team: text("team").notNull(),
  detectedLabel: text("detected_label"),
  hitLabel: text("hit_label"),
  detectedScore: numeric("detected_score"),
  // Audit fix F1 — the live/final readiness score at archive time. Previously
  // the UI's "Score" column read `detectedScore` (= initialReadinessScore,
  // stamped 0 at creation), so it was universally 0.0. `currentScore` carries
  // the real terminal readiness so the column is no longer dead.
  currentScore: numeric("current_score"),
  peakScore: numeric("peak_score"),
  scoreIncreaseAmount: numeric("score_increase_amount"),
  result: text("result").notNull(),
  confidenceTier: text("confidence_tier").notNull(),
  triggerTags: text("trigger_tags").array().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  sessionIdx: index("hr_radar_analytics_session_idx").on(table.sessionDate),
  resultIdx: index("hr_radar_analytics_result_idx").on(table.result),
  playerIdx: index("hr_radar_analytics_player_idx").on(table.playerId),
}));

export const insertHrRadarAnalyticsSchema = createInsertSchema(hrRadarAnalytics).omit({ id: true, createdAt: true });
export type HrRadarAnalyticsRecord = typeof hrRadarAnalytics.$inferSelect;
export type InsertHrRadarAnalyticsRecord = z.infer<typeof insertHrRadarAnalyticsSchema>;

// Audit fix C4 — durable HR Radar outcome stamps. The empirical calibrator
// (server/analytics/hrRadarIntelligence.ts) reads settled (predicted-prob →
// observed-outcome) pairs to remap the static table. Those pairs lived only in
// an in-memory Map that reset on every process restart, so the per-bin sample
// never accumulated enough to override the static table. This table persists
// each stamp so the calibrator can hydrate its working set at boot. One row per
// (gameId, playerId), first-write-wins (mirrors the in-memory store).
export const hrRadarOutcomeStamps = pgTable("hr_radar_outcome_stamps", {
  id: serial("id").primaryKey(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  outcomeStatus: text("outcome_status").notNull(),
  hitInning: integer("hit_inning"),
  alertTier: text("alert_tier"),
  confidenceTier: text("confidence_tier"),
  signalState: text("signal_state"),
  source: text("source"),
  rawConversionProbability: numeric("raw_conversion_probability"),
  resolvedAt: timestamp("resolved_at").defaultNow(),
}, (table) => ({
  gamePlayerIdx: uniqueIndex("hr_radar_outcome_stamps_game_player_idx").on(table.gameId, table.playerId),
  resolvedIdx: index("hr_radar_outcome_stamps_resolved_idx").on(table.resolvedAt),
}));

export type HrRadarOutcomeStampRow = typeof hrRadarOutcomeStamps.$inferSelect;

export const signalInteractions = pgTable("signal_interactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  signalId: text("signal_id"),
  action: text("action").notNull(),
  sport: text("sport"),
  market: text("market"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userIdx: index("signal_interactions_user_idx").on(table.userId),
  signalIdx: index("signal_interactions_signal_idx").on(table.signalId),
}));

export const insertSignalInteractionSchema = createInsertSchema(signalInteractions).omit({ id: true, createdAt: true });
export type SignalInteraction = typeof signalInteractions.$inferSelect;
export type InsertSignalInteraction = z.infer<typeof insertSignalInteractionSchema>;

// Task #134 — Free user activation rail analytics.
// Tracks impressions, CTA clicks, and upgrade-modal opens that originate
// from the FreeActivationRail / PublicProofStrip surface so we can compute
// rail → upgrade conversion rate.
export const railEvents = pgTable("rail_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  eventType: text("event_type").notNull(), // 'impression' | 'primary_cta_click' | 'alerts_cta_click' | 'upgrade_modal_opened'
  source: text("source").notNull().default("free_activation_rail"),
  exhausted: boolean("exhausted"),
  playsUsedToday: integer("plays_used_today"),
  playsLimit: integer("plays_limit"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  eventTypeIdx: index("rail_events_event_type_idx").on(table.eventType),
  createdAtIdx: index("rail_events_created_at_idx").on(table.createdAt),
}));

export const insertRailEventSchema = createInsertSchema(railEvents).omit({ id: true, createdAt: true });
export const railEventClientSchema = z.object({
  eventType: z.enum(["impression", "primary_cta_click", "alerts_cta_click", "upgrade_modal_opened"]),
  exhausted: z.boolean().optional(),
  playsUsedToday: z.number().int().min(0).optional(),
  playsLimit: z.number().int().min(0).optional(),
});
export type RailEvent = typeof railEvents.$inferSelect;
export type InsertRailEvent = z.infer<typeof insertRailEventSchema>;
export type RailEventClientPayload = z.infer<typeof railEventClientSchema>;

export const hrOutcomes = pgTable("hr_outcomes", {
  id: serial("id").primaryKey(),
  season: integer("season").notNull().default(2026),
  gameDate: text("game_date").notNull(),
  batterName: text("batter_name").notNull(),
  batterTeam: text("batter_team").notNull(),
  batterMlbId: text("batter_mlb_id"),
  hrNumber: integer("hr_number").notNull().default(1),
  runnersOnBase: integer("runners_on_base").notNull().default(0),
  inning: integer("inning"),
  outs: integer("outs"),
  launchAngle: numeric("launch_angle"),
  exitVelocity: numeric("exit_velocity"),
  distance: numeric("distance"),
  pitchType: text("pitch_type"),
  pitcherName: text("pitcher_name"),
  ballpark: text("ballpark"),
  source: text("source").notNull().default("onlyhomers"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  seasonIdx: index("hr_outcomes_season_idx").on(table.season),
  dateIdx: index("hr_outcomes_date_idx").on(table.gameDate),
  batterIdx: index("hr_outcomes_batter_idx").on(table.batterName),
  pitcherIdx: index("hr_outcomes_pitcher_idx").on(table.pitcherName),
  ballparkIdx: index("hr_outcomes_ballpark_idx").on(table.ballpark),
  dedupIdx: uniqueIndex("hr_outcomes_dedup_idx").on(table.season, table.gameDate, table.batterName, table.hrNumber),
}));

export type HrOutcome = typeof hrOutcomes.$inferSelect;

export const hrHotHitters = pgTable("hr_hot_hitters", {
  id: serial("id").primaryKey(),
  playerName: text("player_name").notNull(),
  team: text("team").notNull(),
  hrCount: integer("hr_count").notNull(),
  period: text("period").notNull(),
  snapshotDate: text("snapshot_date").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  dedupIdx: uniqueIndex("hr_hot_hitters_dedup_idx").on(table.playerName, table.period, table.snapshotDate),
}));

export type HrHotHitter = typeof hrHotHitters.$inferSelect;

export const hrBallparkFactors = pgTable("hr_ballpark_factors", {
  id: serial("id").primaryKey(),
  season: integer("season").notNull().default(2026),
  ballpark: text("ballpark").notNull(),
  hrCount: integer("hr_count").notNull().default(0),
  snapshotDate: text("snapshot_date").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  dedupIdx: uniqueIndex("hr_ballpark_factors_dedup_idx").on(table.season, table.ballpark, table.snapshotDate),
}));

export type HrBallparkFactor = typeof hrBallparkFactors.$inferSelect;

// ── Attribution / conversion tracking (Twitter + general UTM) ────────────
// Strictly additive. Two new tables; existing `users` table is not modified.
// First-touch wins (visit dedupe at write time; user-attribution write is
// best-effort and only inserted if a row for that user does not yet exist).

export const attributionVisits = pgTable("attribution_visits", {
  id: serial("id").primaryKey(),
  visitorId: text("visitor_id").notNull(),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  ref: text("ref"),
  landingPath: text("landing_path"),
  refererHost: text("referer_host"),
  userAgentHash: text("user_agent_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  visitorIdx: index("attribution_visits_visitor_idx").on(table.visitorId),
  sourceIdx: index("attribution_visits_source_idx").on(table.utmSource),
  createdAtIdx: index("attribution_visits_created_at_idx").on(table.createdAt),
}));

export const insertAttributionVisitSchema = createInsertSchema(attributionVisits).omit({
  id: true,
  createdAt: true,
});
export type InsertAttributionVisit = z.infer<typeof insertAttributionVisitSchema>;
export type AttributionVisit = typeof attributionVisits.$inferSelect;

export const userAttribution = pgTable("user_attribution", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique(),
  visitorId: text("visitor_id"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  ref: text("ref"),
  landingPath: text("landing_path"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  userIdx: uniqueIndex("user_attribution_user_idx").on(table.userId),
  sourceIdx: index("user_attribution_source_idx").on(table.utmSource),
}));

export const insertUserAttributionSchema = createInsertSchema(userAttribution).omit({
  id: true,
  createdAt: true,
});
export type InsertUserAttribution = z.infer<typeof insertUserAttributionSchema>;
export type UserAttribution = typeof userAttribution.$inferSelect;

export interface PlayStats {
  buckets: {
    "60-69": { total: number; hits: number; misses: number; winRate: number };
    "70-79": { total: number; hits: number; misses: number; winRate: number };
    "80-89": { total: number; hits: number; misses: number; winRate: number };
    "90+":   { total: number; hits: number; misses: number; winRate: number };
  };
  totalSettled: number;
  totalPending: number;
  allTimeRecord: { hits: number; misses: number; pushes: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// MLB Pre-Game Power Radar — durable snapshots (additive; never feeds ROI).
//
// Stores ALL evaluated batter rows (public + suppressed + admin-only) so admin
// diagnostics and backtesting are complete. Public endpoints filter at read.
// Unique identity is (sessionDate, gameId, batterId) — NOT primaryMarket.
// ─────────────────────────────────────────────────────────────────────────────
export const pregamePowerRadarSignals = pgTable("pregame_power_radar_signals", {
  signalId: text("signal_id").primaryKey(),
  buildId: text("build_id").notNull(),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  gameDate: text("game_date").notNull(),
  startsAt: text("starts_at"),
  gameStatus: text("game_status").notNull().default("unknown"),
  firstPitchLockEligible: boolean("first_pitch_lock_eligible").notNull().default(false),
  batterId: text("batter_id").notNull(),
  batterName: text("batter_name").notNull(),
  team: text("team").notNull(),
  opponent: text("opponent").notNull(),
  pitcherId: text("pitcher_id"),
  pitcherName: text("pitcher_name"),
  battingOrderSlot: integer("batting_order_slot"),
  primaryMarket: text("primary_market").notNull(),
  marketTags: jsonb("market_tags").notNull().default([]),
  marketScores: jsonb("market_scores").notNull().default({}),
  score10: numeric("score_10").notNull(),
  tier: text("tier").notNull(),
  drivers: jsonb("drivers").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  diagnostics: jsonb("diagnostics").notNull().default({}),
  lineupStatus: text("lineup_status").notNull(),
  weatherStatus: text("weather_status").notNull(),
  hasMarketLine: boolean("has_market_line").notNull().default(false),
  isOfficialPlay: boolean("is_official_play").notNull().default(false),
  isPregameTarget: boolean("is_pregame_target").notNull().default(true),
  status: text("status").notNull().default("active"),
  suppressed: boolean("suppressed").notNull().default(false),
  suppressedReasons: jsonb("suppressed_reasons").notNull().default([]),
  outcomes: jsonb("outcomes"),
  everPubliclyFlagged: boolean("ever_publicly_flagged").notNull().default(false),
  becameLiveReady: boolean("became_live_ready").notNull().default(false),
  becameLiveFire: boolean("became_live_fire").notNull().default(false),
  convertedLiveAt: timestamp("converted_live_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  lockedAt: timestamp("locked_at"),
  gradedAt: timestamp("graded_at"),
}, (table) => ({
  uniqueIdx: uniqueIndex("pregame_power_radar_signals_unique_idx").on(table.sessionDate, table.gameId, table.batterId),
  dateIdx: index("pregame_power_radar_signals_session_date_idx").on(table.sessionDate),
  buildIdx: index("pregame_power_radar_signals_build_idx").on(table.buildId),
}));

export const insertPregamePowerRadarSignalSchema = createInsertSchema(pregamePowerRadarSignals).omit({ createdAt: true, updatedAt: true });
export type PregamePowerRadarSignalRow = typeof pregamePowerRadarSignals.$inferSelect;
export type InsertPregamePowerRadarSignal = z.infer<typeof insertPregamePowerRadarSignalSchema>;

// Durable build manifest — required for DB fallback + latest-build lookup.
export const pregamePowerRadarBuilds = pgTable("pregame_power_radar_builds", {
  buildId: text("build_id").primaryKey(),
  sessionDate: text("session_date").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  gamesScanned: integer("games_scanned").notNull().default(0),
  battersEvaluated: integer("batters_evaluated").notNull().default(0),
  lineupCoverage: numeric("lineup_coverage"),
  weatherCoverage: numeric("weather_coverage"),
  batterCoverage: numeric("batter_coverage"),
  pitcherCoverage: numeric("pitcher_coverage"),
  signalsCreated: integer("signals_created").notNull().default(0),
  suppressedCount: integer("suppressed_count").notNull().default(0),
  status: text("status").notNull().default("complete"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  dateIdx: index("pregame_power_radar_builds_session_date_idx").on(table.sessionDate),
}));

export const insertPregamePowerRadarBuildSchema = createInsertSchema(pregamePowerRadarBuilds).omit({ createdAt: true, updatedAt: true });
export type PregamePowerRadarBuildRow = typeof pregamePowerRadarBuilds.$inferSelect;
export type InsertPregamePowerRadarBuild = z.infer<typeof insertPregamePowerRadarBuildSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MLB Mound Radar — durable snapshots (additive; never feeds ROI).
//
// Sibling of pregame_power_radar_signals/builds above, pitcher-typed. NOT a
// reuse/extension of the Plate tables — Plate's unique identity is hard-typed
// to batterId and must not be repurposed for pitchers.
//
// Unique identity is (sessionDate, gameId, pitcherId) — NOT primaryMarket.
// ─────────────────────────────────────────────────────────────────────────────
export const mlbMoundRadarSignals = pgTable("mlb_mound_radar_signals", {
  signalId: text("signal_id").primaryKey(),
  buildId: text("build_id").notNull(),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  gameDate: text("game_date").notNull(),
  startsAt: text("starts_at"),
  gameStatus: text("game_status").notNull().default("unknown"),
  firstPitchLockEligible: boolean("first_pitch_lock_eligible").notNull().default(false),
  pitcherId: text("pitcher_id").notNull(),
  pitcherName: text("pitcher_name").notNull(),
  team: text("team").notNull(),
  opponent: text("opponent").notNull(),
  opposingLineupConfirmed: boolean("opposing_lineup_confirmed").notNull().default(false),
  primaryMarket: text("primary_market").notNull(),
  marketTags: jsonb("market_tags").notNull().default([]),
  marketScores: jsonb("market_scores").notNull().default({}),
  score10: numeric("score_10").notNull(),
  tier: text("tier").notNull(),
  drivers: jsonb("drivers").notNull().default([]),
  warnings: jsonb("warnings").notNull().default([]),
  diagnostics: jsonb("diagnostics").notNull().default({}),
  lineupStatus: text("lineup_status").notNull(),
  weatherStatus: text("weather_status").notNull(),
  hasMarketLine: boolean("has_market_line").notNull().default(false),
  isOfficialPlay: boolean("is_official_play").notNull().default(false),
  isPregameTarget: boolean("is_pregame_target").notNull().default(true),
  status: text("status").notNull().default("active"),
  suppressed: boolean("suppressed").notNull().default(false),
  suppressedReasons: jsonb("suppressed_reasons").notNull().default([]),
  outcomes: jsonb("outcomes"),
  everPubliclyFlagged: boolean("ever_publicly_flagged").notNull().default(false),
  // Fade-track analog of everPubliclyFlagged above — wasPubliclyFlaggedMound's
  // tierEligible check structurally excludes "track" tier, so a Fade
  // Candidate signal needs its own durable flag. Same SQL-level OR-upsert
  // discipline as everPubliclyFlagged (see storage.ts) so it survives a
  // server restart even if the in-memory carry-forward chain is lost.
  everPubliclyFlaggedFade: boolean("ever_publicly_flagged_fade").notNull().default(false),
  // Stamped once at build time (moundDirection.ts) — "fade" | "follow" | null.
  // Dedicated column (not embedded in diagnostics) because diagnostics is
  // wholesale-overwritten on every upsert with no merge logic; a value that
  // must survive an intervening rebuild needs its own sticky-upsert column
  // (see storage.ts's CASE-based upsert — once "fade" is set, it can never
  // be overwritten by a later rebuild's differently-recomputed direction).
  moundDirection: text("mound_direction"),
  becameLiveReady: boolean("became_live_ready").notNull().default(false),
  becameLiveFire: boolean("became_live_fire").notNull().default(false),
  convertedLiveAt: timestamp("converted_live_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  lockedAt: timestamp("locked_at"),
  gradedAt: timestamp("graded_at"),
}, (table) => ({
  uniqueIdx: uniqueIndex("mlb_mound_radar_signals_unique_idx").on(table.sessionDate, table.gameId, table.pitcherId),
  dateIdx: index("mlb_mound_radar_signals_session_date_idx").on(table.sessionDate),
  buildIdx: index("mlb_mound_radar_signals_build_idx").on(table.buildId),
}));

export const insertMlbMoundRadarSignalSchema = createInsertSchema(mlbMoundRadarSignals).omit({ createdAt: true, updatedAt: true });
export type MlbMoundRadarSignalRow = typeof mlbMoundRadarSignals.$inferSelect;
export type InsertMlbMoundRadarSignal = z.infer<typeof insertMlbMoundRadarSignalSchema>;

// Durable build manifest — required for DB fallback + latest-build lookup.
export const mlbMoundRadarBuilds = pgTable("mlb_mound_radar_builds", {
  buildId: text("build_id").primaryKey(),
  sessionDate: text("session_date").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  gamesScanned: integer("games_scanned").notNull().default(0),
  pitchersEvaluated: integer("pitchers_evaluated").notNull().default(0),
  starterCoverage: numeric("starter_coverage"),
  weatherCoverage: numeric("weather_coverage"),
  pitcherCoverage: numeric("pitcher_coverage"),
  lineupCoverage: numeric("lineup_coverage"),
  signalsCreated: integer("signals_created").notNull().default(0),
  suppressedCount: integer("suppressed_count").notNull().default(0),
  status: text("status").notNull().default("complete"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  dateIdx: index("mlb_mound_radar_builds_session_date_idx").on(table.sessionDate),
}));

export const insertMlbMoundRadarBuildSchema = createInsertSchema(mlbMoundRadarBuilds).omit({ createdAt: true, updatedAt: true });
export type MlbMoundRadarBuildRow = typeof mlbMoundRadarBuilds.$inferSelect;
export type InsertMlbMoundRadarBuild = z.infer<typeof insertMlbMoundRadarBuildSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — PR 1 (additive, inert, no runtime call sites yet).
//
// Five tables backing a fully additive shadow/research track for a challenger
// HR model. None of these are read or written by any code path yet — the
// champion engine (HRSignalBuilder, hrConversionModel, evaluateHRAlert,
// hrAlertEngine, hrRadarUserStage, hrRadarCanonicalStore, hrRadarStateMachine,
// hrRadarDecisionView) is completely unaware of this cluster and must stay
// that way until an explicitly-approved canary phase. See
// server/mlb/hrRadarResearch/ for the Zod contracts these columns are
// validated against (by later PRs — no validation call site exists yet), and
// server/dbMigrations/hrRadarResearchPersistence.ts for the idempotent boot
// bootstrap that mirrors these definitions column-for-column.
//
// Deliberately no FK constraints anywhere in this cluster — matches the
// existing hr_radar_alerts/hr_radar_signal_events/hr_radar_analytics/
// hr_radar_outcome_stamps cluster above, which correlates purely via plain
// text gameId/playerId/sessionDate columns. Avoids insert-ordering and
// cascade friction for research data that may be pruned/backfilled later.
// ─────────────────────────────────────────────────────────────────────────────

// Immutable per-batter feature + champion-output snapshot, one row per
// evaluated batter per evaluation epoch. `evaluationEpochId` is shared by
// every batter evaluated from the same game-state event (a completed PA, a
// pitching change, etc.) so ranking groups by epoch, not by evaluationAt —
// writes for the same epoch can land milliseconds apart. `sourceRevision`
// lets a reprocessed upstream event with corrected data produce a new,
// auditable row instead of being silently swallowed by a conflict-ignore
// insert. Uniqueness is enforced on the 4-column composite below, not on a
// separately-maintained hash column.
export const hrRadarEvaluationSnapshots = pgTable("hr_radar_evaluation_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  evaluationEpochId: text("evaluation_epoch_id").notNull(),
  sourceRevision: integer("source_revision").notNull().default(0),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  team: text("team").notNull(),
  opponent: text("opponent"),
  evaluationAt: timestamp("evaluation_at").notNull(),
  sourceEventAt: timestamp("source_event_at"),
  sourceEventId: text("source_event_id"),
  triggerType: text("trigger_type").notNull(),
  playSequence: integer("play_sequence"),
  plateAppearanceId: text("plate_appearance_id"),
  inning: integer("inning"),
  half: text("half"),
  outs: integer("outs"),
  currentPitcherId: text("current_pitcher_id"),
  battingOrderSlot: integer("batting_order_slot"),
  eligible: boolean("eligible").notNull().default(true),
  // Controlled vocabulary (see hrEligibilityContract.ts), e.g.
  // "already_homered_this_game" — a scope-qualified exclusion, not a claim
  // that second-HR probability is zero. See predictionTargetScope below.
  exclusionReason: text("exclusion_reason"),
  // Names the prediction target explicitly: HR Radar predicts a player's
  // FIRST home run of the game for the standard live market. Excluding a
  // batter who already homered is only valid under this named scope.
  predictionTargetScope: text("prediction_target_scope").notNull().default("first_hr_of_game"),
  // Versions the raw-input envelope independently of feature_version, so a
  // feature-builder bug can be fixed and features re-derived from preserved
  // raw inputs without pretending historical live state can be reconstructed
  // from derived numbers alone.
  inputContractVersion: text("input_contract_version").notNull(),
  rawInputs: jsonb("raw_inputs").notNull(),
  featureVersion: text("feature_version").notNull(),
  featureHash: text("feature_hash").notNull(),
  // Renamed from a plain "features" column — this is the derived vector, not
  // the raw preserved inputs above.
  derivedFeatures: jsonb("derived_features").notNull(),
  // Per-leaf presence/quality mirror of derivedFeatures (see
  // hrFeatureAvailabilityVectorV1Schema).
  availability: jsonb("availability").notNull(),
  // Per-feature-family source/freshness timestamps (see
  // hrFeatureFreshnessVectorV1Schema) — distinct from `availability`, which
  // is presence/quality, not recency.
  featureFreshness: jsonb("feature_freshness").notNull(),
  statsAsOf: timestamp("stats_as_of").notNull(),
  // Whether the champion engine produced ANY output for this batter at this
  // epoch. When false, every champion_* field below is meaningless and must
  // NEVER be read downstream as zero probability or a Watch stage.
  championEvaluated: boolean("champion_evaluated").notNull().default(false),
  championExclusionReason: text("champion_exclusion_reason"),
  championVersionSource: text("champion_version_source"),
  championModelVersion: text("champion_model_version"),
  championRawProbability: numeric("champion_raw_probability"),
  championCalibratedProbability: numeric("champion_calibrated_probability"),
  championBuildScore: numeric("champion_build_score"),
  championReadinessScore: numeric("champion_readiness_score"),
  championAlertPath: text("champion_alert_path"),
  championAlertTier: text("champion_alert_tier"),
  championStage: text("champion_stage"),
  championUserVisible: boolean("champion_user_visible").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  epochUniqueIdx: uniqueIndex("hr_radar_eval_snapshots_epoch_unique_idx").on(
    table.evaluationEpochId, table.playerId, table.featureVersion, table.sourceRevision,
  ),
  epochIdx: index("hr_radar_eval_snapshots_epoch_idx").on(table.evaluationEpochId),
  sessionGameEvalIdx: index("hr_radar_eval_snapshots_session_game_eval_idx").on(
    table.sessionDate, table.gameId, table.evaluationAt,
  ),
  gamePlayerEvalIdx: index("hr_radar_eval_snapshots_game_player_eval_idx").on(
    table.gameId, table.playerId, table.evaluationAt,
  ),
  featureVersionEvalIdx: index("hr_radar_eval_snapshots_feature_version_eval_idx").on(
    table.featureVersion, table.evaluationAt,
  ),
  // Supports an anti-join against hr_radar_evaluation_labels (LEFT JOIN ...
  // WHERE label.snapshot_id IS NULL) to find eligible-but-unlabeled rows.
  // NOT a partial index — Postgres cannot predicate an index on one table by
  // the absence of a row in a different table.
  eligibleUnlabeledLookupIdx: index("hr_radar_eval_snapshots_eligible_unlabeled_lookup_idx").on(
    table.eligible, table.sessionDate, table.snapshotId,
  ),
}));

export const insertHrRadarEvaluationSnapshotSchema = createInsertSchema(hrRadarEvaluationSnapshots).omit({ createdAt: true });
export type HrRadarEvaluationSnapshot = typeof hrRadarEvaluationSnapshots.$inferSelect;
export type InsertHrRadarEvaluationSnapshot = z.infer<typeof insertHrRadarEvaluationSnapshotSchema>;

// One label row per (snapshotId, labelVersion) — append-only. A corrected
// label adds a new versioned row rather than overwriting history, so the
// label ledger stays genuinely auditable. `labelDisposition` gates what may
// enter model metrics: only "resolved" rows may. `nextPaOccurred`/
// `secondPaOccurred` disambiguate a censored (no further PA observed)
// short-horizon outcome from a true negative — hrNextPa/hrNextTwoPa are null
// exactly when the corresponding PA never occurred. hrRemainderGame is NOT
// censored by the same rule: false is a fully valid, fully resolved outcome
// when the game ends or the player is removed without a further HR.
export const hrRadarEvaluationLabels = pgTable("hr_radar_evaluation_labels", {
  snapshotId: text("snapshot_id").notNull(),
  labelVersion: text("label_version").notNull(),
  labelDisposition: text("label_disposition").notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolutionReason: text("resolution_reason"),
  hrRemainderGame: boolean("hr_remainder_game"),
  hrNextPa: boolean("hr_next_pa"),
  nextPaOccurred: boolean("next_pa_occurred"),
  hrNextTwoPa: boolean("hr_next_two_pa"),
  secondPaOccurred: boolean("second_pa_occurred"),
  remainingPaObserved: integer("remaining_pa_observed"),
  nextPaId: text("next_pa_id"),
  secondPaId: text("second_pa_id"),
  hrEventId: text("hr_event_id"),
  hrPlaySequence: integer("hr_play_sequence"),
  hrAt: timestamp("hr_at"),
  hrInning: integer("hr_inning"),
  hrPaOrdinal: integer("hr_pa_ordinal"),
  labelSource: text("label_source").notNull().default("engine"),
  dataQuality: text("data_quality"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.snapshotId, table.labelVersion] }),
  dispositionIdx: index("hr_radar_eval_labels_disposition_idx").on(table.labelDisposition),
  resolvedAtIdx: index("hr_radar_eval_labels_resolved_at_idx").on(table.resolvedAt),
  snapshotIdx: index("hr_radar_eval_labels_snapshot_idx").on(table.snapshotId),
}));

export const insertHrRadarEvaluationLabelSchema = createInsertSchema(hrRadarEvaluationLabels).omit({ createdAt: true });
export type HrRadarEvaluationLabel = typeof hrRadarEvaluationLabels.$inferSelect;
export type InsertHrRadarEvaluationLabel = z.infer<typeof insertHrRadarEvaluationLabelSchema>;

// One row per (snapshotId, modelVersion) — probability + rank ONLY. Proposed
// stage/policy live in hrRadarShadowDecisions below (a model's probabilities
// are expensive to produce once; multiple policies must be testable against
// the same probabilities without duplicating this row).
export const hrRadarShadowPredictions = pgTable("hr_radar_shadow_predictions", {
  id: serial("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  modelVersion: text("model_version").notNull(),
  probNextPa: numeric("prob_next_pa"),
  probNextTwoPa: numeric("prob_next_two_pa"),
  probRemainderGame: numeric("prob_remainder_game"),
  baselineOnlyProb: numeric("baseline_only_prob"),
  liveLift: numeric("live_lift"),
  rankInGame: integer("rank_in_game"),
  inferenceDurationMs: integer("inference_duration_ms"),
  errorState: text("error_state"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  snapshotModelUniqueIdx: uniqueIndex("hr_radar_shadow_predictions_snapshot_model_unique_idx").on(
    table.snapshotId, table.modelVersion,
  ),
  modelVersionIdx: index("hr_radar_shadow_predictions_model_version_idx").on(table.modelVersion),
  snapshotIdx: index("hr_radar_shadow_predictions_snapshot_idx").on(table.snapshotId),
}));

export const insertHrRadarShadowPredictionSchema = createInsertSchema(hrRadarShadowPredictions).omit({ id: true, createdAt: true });
export type HrRadarShadowPrediction = typeof hrRadarShadowPredictions.$inferSelect;
export type InsertHrRadarShadowPrediction = z.infer<typeof insertHrRadarShadowPredictionSchema>;

// One row per (snapshotId, modelVersion, policyVersion) — the policy's
// proposed stage for a given model's prediction. Split out from
// hrRadarShadowPredictions so multiple policy versions can be evaluated
// against one model's probabilities. `previousProposedStage` and
// `stageTransitioned` let later evaluation count the FIRST proposed-Fire
// transition per (gameId, playerId, modelVersion, policyVersion) — joined
// back to hrRadarEvaluationSnapshots via snapshotId — rather than every
// snapshot that merely remains Fire, which would inflate sample size and
// precision.
export const hrRadarShadowDecisions = pgTable("hr_radar_shadow_decisions", {
  id: serial("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  modelVersion: text("model_version").notNull(),
  policyVersion: text("policy_version").notNull(),
  proposedStage: text("proposed_stage"),
  previousProposedStage: text("previous_proposed_stage"),
  stageTransitioned: boolean("stage_transitioned").notNull().default(false),
  topDrivers: jsonb("top_drivers"),
  artifactChecksum: text("artifact_checksum"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  snapshotModelPolicyUniqueIdx: uniqueIndex("hr_radar_shadow_decisions_snapshot_model_policy_unique_idx").on(
    table.snapshotId, table.modelVersion, table.policyVersion,
  ),
  modelPolicyIdx: index("hr_radar_shadow_decisions_model_policy_idx").on(table.modelVersion, table.policyVersion),
  snapshotIdx: index("hr_radar_shadow_decisions_snapshot_idx").on(table.snapshotId),
  stageTransitionIdx: index("hr_radar_shadow_decisions_stage_transition_idx").on(
    table.proposedStage, table.stageTransitioned,
  ),
}));

export const insertHrRadarShadowDecisionSchema = createInsertSchema(hrRadarShadowDecisions).omit({ id: true, createdAt: true });
export type HrRadarShadowDecision = typeof hrRadarShadowDecisions.$inferSelect;
export type InsertHrRadarShadowDecision = z.infer<typeof insertHrRadarShadowDecisionSchema>;

// Immutable model metadata / lifecycle registry.
export const hrRadarModelRegistry = pgTable("hr_radar_model_registry", {
  modelVersion: text("model_version").primaryKey(),
  modelType: text("model_type").notNull(),
  featureVersion: text("feature_version").notNull(),
  trainingWindowStart: text("training_window_start"),
  trainingWindowEnd: text("training_window_end"),
  calibrationWindowStart: text("calibration_window_start"),
  calibrationWindowEnd: text("calibration_window_end"),
  holdoutWindowStart: text("holdout_window_start"),
  holdoutWindowEnd: text("holdout_window_end"),
  artifactPath: text("artifact_path"),
  artifactChecksum: text("artifact_checksum"),
  metrics: jsonb("metrics"),
  status: text("status").notNull().default("candidate"),
  activatedAt: timestamp("activated_at"),
  retiredAt: timestamp("retired_at"),
  retirementReason: text("retirement_reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  statusIdx: index("hr_radar_model_registry_status_idx").on(table.status),
  featureVersionIdx: index("hr_radar_model_registry_feature_version_idx").on(table.featureVersion),
}));

export const insertHrRadarModelRegistrySchema = createInsertSchema(hrRadarModelRegistry).omit({ createdAt: true });
export type HrRadarModelRegistryRow = typeof hrRadarModelRegistry.$inferSelect;
export type InsertHrRadarModelRegistry = z.infer<typeof insertHrRadarModelRegistrySchema>;
