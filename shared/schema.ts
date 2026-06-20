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
