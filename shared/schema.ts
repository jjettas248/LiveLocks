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
  // ── MLB Live Edge Trust Recovery (Phase 4) — additive, nullable, official-
  // episode provenance columns. Populated ONLY at first insert for the sport
  // that supplies them (currently MLB); left null for every existing row and
  // for sports that don't populate them. No backfill, no fabrication.
  // Existing columns reused where their semantics are exactly identical:
  //   - `prob` already serves as finalProbability (the final recommended-
  //     side calibrated probability MLB has always written here).
  //   - `odds` already serves as sideOdds (the recommended-side American
  //     odds) — MLB simply did not populate it before this recovery.
  //   - `engineVersion`/`calibrationTrack` already exist as generic columns;
  //     MLB now populates them too.
  // `timestamp` is NOT reused for firstPublicAt — it is populated from
  // signal.createdAt (engineGeneratedAt, i.e. engine-computation time), not
  // the instant the row actually won insertion into persisted_plays. Those
  // are frequently the same tick but are not proven identical, so
  // firstPublicAt gets its own column below, set via the database's own
  // clock (`now()`) inside the atomic INSERT, and is never touched again —
  // engineGeneratedAt (`timestamp`) is preserved unchanged alongside it.
  // Genuinely new concepts get their own column below.
  officialEpisodeKey: text("official_episode_key").unique(),
  firstPublicAt: timestamp("first_public_at"),
  oddsSourceUpdatedAt: timestamp("odds_source_updated_at"),
  oddsFetchedAt: timestamp("odds_fetched_at"),
  rawProbability: numeric("raw_probability"),
  calibrationVersion: text("calibration_version"),
  inputSnapshotHash: text("input_snapshot_hash"),
  officialEligibilityVersion: text("official_eligibility_version"),
  officialEligibilityReasons: text("official_eligibility_reasons"),
  dataQuality: text("data_quality"),
  currentStatKnown: boolean("current_stat_known"),
  // ── MLB Live Edge safety-core (Stage A part 2) — canonical no-vig edge +
  // lane provenance. Additive, nullable, MLB-populated only. The legacy
  // `edge_gap` column is deliberately LEFT NULL for new MLB rows (it previously
  // carried the invalid evPct = probability - 50); canonical model edge now
  // lives in `model_edge` (percentage points) and is tagged with `edge_version`
  // so analytics can segregate legacy-invalid rows from canonical no-vig rows.
  // No backfill of historical rows.
  edgeVersion: text("edge_version"),
  noVigBookProbability: numeric("no_vig_book_probability"),
  probabilitySemantics: text("probability_semantics"),
  lane: text("lane"),
  // ── PR2 (Pregame Targets contract layer, §10) — additive, nullable official-
  // target SNAPSHOT-LINEAGE provenance columns. These carry which pregame
  // product surface produced an official target and the ids of the two frozen
  // snapshots behind it (the line-BLIND projection core vs the line-decision
  // layer), plus the target tier and role certainty. Populated ONLY by the
  // future Pregame Targets products (PR3+); left null for every existing row and
  // for every product that does not emit them. No backfill, no fabrication, and
  // NO existing column is rewritten (additive only — migration principle #1).
  surface: text("surface"),
  projectionSnapshotId: text("projection_snapshot_id"),
  decisionSnapshotId: text("decision_snapshot_id"),
  targetTier: text("target_tier"),
  roleCertainty: numeric("role_certainty"),
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
  // Durable HR count straight from the MLB Stats API boxscore's batting
  // stats — independent of abResults, which is sourced from the in-memory
  // mlbGameCache.contactData at snapshot time and can be null/incomplete
  // (e.g. after a restart) even for a batter with a full, official box-score
  // line. Plate HR V2's labeler needs a canonical HR count that can't go
  // silently wrong just because live contact-data hydration was missed.
  // Deliberately NO .default(0), unlike its siblings above: this column is
  // added after rows already exist, so ADD COLUMN with a default would
  // backfill every pre-existing row to a *confirmed* 0 — indistinguishable
  // from a real, verified zero-HR game. NULL on an old row honestly means
  // "predates HR tracking, unknown," not "confirmed no home run." New writes
  // (server/mlb/liveGameOrchestrator.ts) always supply an explicit number.
  hr: integer("hr"),
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
  // Same durability discipline as everPubliclyFlagged above: suppressedReasons
  // is recomputed fresh from live-refetched data (weather, season stats) on
  // every rebuild, so the Attack Environment gate's suppression reason could
  // otherwise silently drop on a later rebuild. OR'd forward by
  // carryForwardGradedState so the shadow-elimination analytics never
  // misclassify a genuinely-suppressed candidate as retained after a restart.
  everAttackEnvironmentSuppressed: boolean("ever_attack_environment_suppressed").notNull().default(false),
  // score10 snapshot from the FIRST time everAttackEnvironmentSuppressed
  // became true — never overwritten again once set. Null until suppressed.
  attackEnvironmentSuppressedScore10: numeric("attack_environment_suppressed_score_10"),
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

// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — research foundation (PR 1).
//
// New, additive tables backing a future statistical HR-probability shadow
// model (`plate_hr_probability_v2_shadow`), built on top of the existing
// server/mlb/pregamePowerRadar/math/ shadow engine. Zero production
// authority — nothing on any public/user-facing route reads these tables.
// The champion (plate_jul20_restored_v1) and existing challenger
// (plate_current_shadow_v1) are untouched by this addition.
//
// One row per (session_date, game_id, batter_id, feature_version) —
// mutable-until-locked (see plateHrV2ForwardCapture.ts / storage.ts's
// upsertPlateHrV2FeatureSnapshot), not full per-build history. Becomes
// immutable the instant first pitch occurs (lockedAt), so every historical
// training observation is provably "what was knowable immediately before
// first pitch."
// ─────────────────────────────────────────────────────────────────────────────
export const plateHrV2FeatureSnapshots = pgTable("plate_hr_v2_feature_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  sessionDate: text("session_date").notNull(),
  gameId: text("game_id").notNull(),
  batterId: text("batter_id").notNull(),
  batterName: text("batter_name").notNull(),
  team: text("team").notNull(),
  opponent: text("opponent"),
  pitcherId: text("pitcher_id"),
  pitcherName: text("pitcher_name"),
  battingOrderSlot: integer("batting_order_slot"),
  buildId: text("build_id").notNull(),
  firstCapturedAt: timestamp("first_captured_at").notNull(),
  lastCapturedAt: timestamp("last_captured_at").notNull(),
  captureRevision: integer("capture_revision").notNull().default(1),
  firstPitchTime: timestamp("first_pitch_time"),
  firstPitchLockEligible: boolean("first_pitch_lock_eligible").notNull().default(false),
  gameStatus: text("game_status").notNull().default("unknown"),
  // Canonical-training-observation fields (correction 3): the training row is
  // the latest valid snapshot after lineup-posted + starter-resolved, locked
  // immutably at first pitch.
  predictionAsOf: timestamp("prediction_as_of").notNull(),
  secondsToFirstPitch: integer("seconds_to_first_pitch"),
  lineupConfirmedAt: timestamp("lineup_confirmed_at"),
  starterConfirmed: boolean("starter_confirmed").notNull().default(false),
  lockedAt: timestamp("locked_at"),
  inputContractVersion: text("input_contract_version").notNull(),
  rawInputs: jsonb("raw_inputs").notNull(),
  featureVersion: text("feature_version").notNull(),
  featureHash: text("feature_hash").notNull(),
  derivedFeatures: jsonb("derived_features").notNull(),
  availability: jsonb("availability").notNull(),
  featureFreshness: jsonb("feature_freshness").notNull(),
  leakageWarnings: jsonb("leakage_warnings").notNull().default([]),
  // Pointer, not a copy, into plateHrV2SufficientStats below (correction 2) —
  // a player's season-to-date evidence is stored once per day, not
  // duplicated into every game-day row that references it.
  sufficientStatsRef: text("sufficient_stats_ref"),
  // Read-only copies for a later PR's champion-vs-V2 comparison — see
  // plateHrV2TrainingFeatureGuard.ts: these must never be readable as part of
  // the feature vector a training matrix flattens.
  championModelVersion: text("champion_model_version"),
  championScore10: numeric("champion_score_10"),
  championTier: text("champion_tier"),
  championSuppressed: boolean("champion_suppressed"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  sessionGameBatterIdx: index("plate_hr_v2_feature_snapshots_session_game_batter_idx").on(
    table.sessionDate, table.gameId, table.batterId,
  ),
  sessionDateIdx: index("plate_hr_v2_feature_snapshots_session_date_idx").on(table.sessionDate),
  featureVersionIdx: index("plate_hr_v2_feature_snapshots_feature_version_idx").on(table.featureVersion),
  gameStatusIdx: index("plate_hr_v2_feature_snapshots_game_status_idx").on(table.gameStatus),
  lockedAtIdx: index("plate_hr_v2_feature_snapshots_locked_at_idx").on(table.lockedAt),
}));

export const insertPlateHrV2FeatureSnapshotSchema = createInsertSchema(plateHrV2FeatureSnapshots).omit({ createdAt: true, updatedAt: true });
export type PlateHrV2FeatureSnapshotRow = typeof plateHrV2FeatureSnapshots.$inferSelect;
export type InsertPlateHrV2FeatureSnapshot = z.infer<typeof insertPlateHrV2FeatureSnapshotSchema>;

// One label row per (snapshotId, labelVersion) — append-only. Whole-game
// label rule (see plateHrV2LabelContract.ts), deliberately different from HR
// Radar Research's next-PA censoring rule: hitHrToday is unconditional on PA
// count once the game is final; "no_pa_recorded" is the one exclusion.
export const plateHrV2Labels = pgTable("plate_hr_v2_labels", {
  snapshotId: text("snapshot_id").notNull(),
  labelVersion: text("label_version").notNull(),
  labelDisposition: text("label_disposition").notNull(),
  resolvedAt: timestamp("resolved_at"),
  resolutionReason: text("resolution_reason"),
  hitHrToday: boolean("hit_hr_today"),
  paCountObserved: integer("pa_count_observed"),
  hrCountToday: integer("hr_count_today"),
  hrEventId: text("hr_event_id"),
  hrInning: integer("hr_inning"),
  hrHalf: text("hr_half"),
  hrPlateAppearanceNumber: integer("hr_plate_appearance_number"),
  hrFirstAb: boolean("hr_first_ab"),
  labelSource: text("label_source").notNull().default("engine"),
  dataQuality: text("data_quality"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.snapshotId, table.labelVersion] }),
  dispositionIdx: index("plate_hr_v2_labels_disposition_idx").on(table.labelDisposition),
  resolvedAtIdx: index("plate_hr_v2_labels_resolved_at_idx").on(table.resolvedAt),
  snapshotIdx: index("plate_hr_v2_labels_snapshot_idx").on(table.snapshotId),
}));

export const insertPlateHrV2LabelSchema = createInsertSchema(plateHrV2Labels).omit({ createdAt: true });
export type PlateHrV2LabelRow = typeof plateHrV2Labels.$inferSelect;
export type InsertPlateHrV2Label = z.infer<typeof insertPlateHrV2LabelSchema>;

// Immutable model metadata / lifecycle registry — a later PR's artifact
// loader parses against plateHrV2ModelArtifactContract.ts before evaluating
// V2. Includes `standardization` (feature means/stddevs), which
// hrRadarModelRegistry above does not have — see that contract's header for
// why.
export const plateHrV2ModelRegistry = pgTable("plate_hr_v2_model_registry", {
  modelVersion: text("model_version").primaryKey(),
  modelType: text("model_type").notNull(),
  featureVersion: text("feature_version").notNull(),
  trainingWindowStart: text("training_window_start"),
  trainingWindowEnd: text("training_window_end"),
  holdoutWindowStart: text("holdout_window_start"),
  holdoutWindowEnd: text("holdout_window_end"),
  artifactPath: text("artifact_path"),
  artifactChecksum: text("artifact_checksum"),
  // PR2: the full PlateHrV2ModelArtifact JSON body, stored inline. Railway's
  // container filesystem is ephemeral across deploys, so artifactPath (a
  // local file path) cannot durably hold the artifact — every other V2 table
  // already stores its full payload as jsonb directly in Postgres, and this
  // table is PR1's own creation for exactly this purpose. artifactPath stays
  // reserved for a future external-storage backend if an artifact ever grows
  // large enough to be worth moving out of Postgres.
  artifactBody: jsonb("artifact_body"),
  standardization: jsonb("standardization"),
  metrics: jsonb("metrics"),
  status: text("status").notNull().default("candidate"),
  activatedAt: timestamp("activated_at"),
  retiredAt: timestamp("retired_at"),
  retirementReason: text("retirement_reason"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  statusIdx: index("plate_hr_v2_model_registry_status_idx").on(table.status),
  featureVersionIdx: index("plate_hr_v2_model_registry_feature_version_idx").on(table.featureVersion),
}));

export const insertPlateHrV2ModelRegistrySchema = createInsertSchema(plateHrV2ModelRegistry).omit({ createdAt: true });
export type PlateHrV2ModelRegistryRow = typeof plateHrV2ModelRegistry.$inferSelect;
export type InsertPlateHrV2ModelRegistry = z.infer<typeof insertPlateHrV2ModelRegistrySchema>;

// The "separate historical aggregate/archive layer" (correction 2) — one row
// per (entityType, entityId, asOfDate), so a player's season-to-date
// evidence is stored once per day rather than duplicated into every
// game-day feature snapshot that references it (see
// plateHrV2SufficientStats.ts).
export const plateHrV2SufficientStats = pgTable("plate_hr_v2_sufficient_stats", {
  statsId: text("stats_id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  asOfDate: text("as_of_date").notNull(),
  pitchesSeen: integer("pitches_seen").notNull().default(0),
  swings: integer("swings").notNull().default(0),
  whiffs: integer("whiffs").notNull().default(0),
  calledStrikes: integer("called_strikes").notNull().default(0),
  balls: integer("balls").notNull().default(0),
  zoneSwings: integer("zone_swings"),
  zoneTakes: integer("zone_takes"),
  chaseSwings: integer("chase_swings"),
  chaseTakes: integer("chase_takes"),
  zoneDataAvailable: boolean("zone_data_available").notNull().default(false),
  paCount: integer("pa_count").notNull().default(0),
  strikeouts: integer("strikeouts").notNull().default(0),
  walks: integer("walks").notNull().default(0),
  battedBallEvents: integer("batted_ball_events").notNull().default(0),
  pitchFamilyStats: jsonb("pitch_family_stats").notNull().default({}),
  // §5a (PR4): exact-pitch grain-typed counts × opponent hand, keyed
  // `${hand}:${code}`. Additive — retained 3-family block above for fallback.
  pitchTypeStats: jsonb("pitch_type_stats").notNull().default({}),
  evPercentiles: jsonb("ev_percentiles").notNull().default({}),
  laPercentiles: jsonb("la_percentiles").notNull().default({}),
  pulledBip: integer("pulled_bip").notNull().default(0),
  sprayClassifiedBip: integer("spray_classified_bip").notNull().default(0),
  sourceRowCount: integer("source_row_count").notNull().default(0),
  computedAt: timestamp("computed_at").notNull().defaultNow(),
}, (table) => ({
  entityDateIdx: index("plate_hr_v2_sufficient_stats_entity_date_idx").on(
    table.entityType, table.entityId, table.asOfDate,
  ),
  asOfDateIdx: index("plate_hr_v2_sufficient_stats_as_of_date_idx").on(table.asOfDate),
}));

export const insertPlateHrV2SufficientStatsSchema = createInsertSchema(plateHrV2SufficientStats).omit({ computedAt: true });
export type PlateHrV2SufficientStatsRow = typeof plateHrV2SufficientStats.$inferSelect;
export type InsertPlateHrV2SufficientStats = z.infer<typeof insertPlateHrV2SufficientStatsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Plate HR V2 — two-layer, APPEND-ONLY point-in-time snapshots (plan §7.1, PR1).
//
// Immutability = append-only with unique keys, NOT rebuild-in-place. Two layers:
//
//   plate_hr_v2_source_evidence   — one row per provider fetch of an entity's
//     evidence, shared/referenced by id (never duplicated into each batter row).
//   plate_hr_v2_prediction_snapshots — one row per (batter-game, moment); a late
//     lineup/probable/weather change creates a NEW row (new prediction_as_of),
//     the prior one is retained. Composite uniqueness
//     (game_pk, batter_id, feature_version, prediction_as_of).
//
// Point-in-time eligibility is evidenceKind-specific and lives in
// server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2Snapshots.ts (pure).
// Nothing writes these tables yet — forward capture is wired in PR3.
// ─────────────────────────────────────────────────────────────────────────────
export const plateHrV2SourceEvidence = pgTable("plate_hr_v2_source_evidence", {
  sourceSnapshotId: text("source_snapshot_id").primaryKey(),
  provider: text("provider").notNull(),
  entityId: text("entity_id").notNull(),
  // batter | pitcher | game | venue
  entityType: text("entity_type").notNull(),
  // historical_stat | lineup | probable | weather_forecast | park
  evidenceKind: text("evidence_kind").notNull(),
  // Latest game/date the underlying data actually covers (historical_stat only).
  dataThroughAt: timestamp("data_through_at"),
  // Verified time the evidence could have been known. NULLABLE (PR4.3): a
  // provenance-incomplete source has honestly null timestamps — never a
  // substituted capture moment — and is always training-INELIGIBLE.
  availableAt: timestamp("available_at"),
  // fetched_at | provider_published_at | provider_issued_at | verified_as_of | unverified
  availabilitySource: text("availability_source").notNull(),
  // The time the evidence DESCRIBES (weather forecast game time — may be future).
  validForAt: timestamp("valid_for_at"),
  // True when fetched after the prediction moment (excluded unless verified as-of).
  reconstructed: boolean("reconstructed").notNull().default(false),
  // PR4.3: true when the real fetch time / cutoff was unavailable → ineligible.
  provenanceIncomplete: boolean("provenance_incomplete").notNull().default(false),
  fetchedAt: timestamp("fetched_at"),
  schemaVersion: text("schema_version").notNull(),
  contentHash: text("content_hash").notNull(),
  payloadRef: text("payload_ref"),
  // Immutable authorized payload this row hashes over (zone fields stripped).
  // Self-contained, content-addressed — never a pointer to a mutable row.
  // NULLABLE (PR4.2 #3): a null payload (e.g. a legacy row) is training-INELIGIBLE
  // and never certified as `{}`; every new write supplies a verified non-null payload.
  authorizedPayload: jsonb("authorized_payload"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  entityIdx: index("plate_hr_v2_source_evidence_entity_idx").on(table.entityType, table.entityId),
  kindIdx: index("plate_hr_v2_source_evidence_kind_idx").on(table.evidenceKind),
  availableAtIdx: index("plate_hr_v2_source_evidence_available_at_idx").on(table.availableAt),
}));

export const insertPlateHrV2SourceEvidenceSchema = createInsertSchema(plateHrV2SourceEvidence).omit({ createdAt: true });
export type PlateHrV2SourceEvidenceRow = typeof plateHrV2SourceEvidence.$inferSelect;
export type InsertPlateHrV2SourceEvidence = z.infer<typeof insertPlateHrV2SourceEvidenceSchema>;

export const plateHrV2PredictionSnapshots = pgTable("plate_hr_v2_prediction_snapshots", {
  predictionSnapshotId: text("prediction_snapshot_id").primaryKey(),
  gamePk: text("game_pk").notNull(),
  batterId: text("batter_id").notNull(),
  featureVersion: text("feature_version").notNull(),
  predictionAsOf: timestamp("prediction_as_of").notNull(),
  firstPitchTime: timestamp("first_pitch_time"),
  // Ids into plate_hr_v2_source_evidence — referenced, never duplicated.
  sourceSnapshotIds: jsonb("source_snapshot_ids").notNull().default([]),
  derivedFeatures: jsonb("derived_features").notNull(),
  contentHash: text("content_hash").notNull(),
  // Authority is assigned at TRAINING-READ time via deterministic latest-≤-first-
  // pitch selection (PR4.3); the writer always persists false.
  authoritative: boolean("authoritative").notNull().default(false),
  // Cached result of the write-time eligibility check (the training reader
  // RECOMPUTES; this is a cross-check, not the authority). Nullable until resolved.
  trainingEligible: boolean("training_eligible"),
  // PR4.3: write-time block reasons persisted for observability/audit.
  trainingBlockReasons: jsonb("training_block_reasons").notNull().default([]),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // Append-only revisions: a distinct prediction_as_of is a distinct row.
  identityIdx: uniqueIndex("plate_hr_v2_prediction_snapshots_identity_idx").on(
    table.gamePk, table.batterId, table.featureVersion, table.predictionAsOf,
  ),
  gameBatterIdx: index("plate_hr_v2_prediction_snapshots_game_batter_idx").on(table.gamePk, table.batterId),
  predictionAsOfIdx: index("plate_hr_v2_prediction_snapshots_prediction_as_of_idx").on(table.predictionAsOf),
}));

export const insertPlateHrV2PredictionSnapshotSchema = createInsertSchema(plateHrV2PredictionSnapshots).omit({ createdAt: true });
export type PlateHrV2PredictionSnapshotRow = typeof plateHrV2PredictionSnapshots.$inferSelect;
export type InsertPlateHrV2PredictionSnapshot = z.infer<typeof insertPlateHrV2PredictionSnapshotSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MLB Recommendation Episode — MLB Flagship Program Phase 1 foundation. The
// single frozen record an OFFICIAL MLB recommendation (Plate, Mound, or Live
// Edge) produces. See shared/mlbRecommendationEpisode.ts for the full
// contract, the frozen/mutable field split, and the guarded mutator
// (applyMlbEpisodeLifecycleEvent) that is the real enforcement surface.
//
// This is a NEW table, not a reuse of persistedPlays — persistedPlays
// upserts "current best signalScore wins" in place and is shared cross-sport
// with NBA/NCAAB, with no frozen-price discipline (see Phase 1 persistence
// audit). episode_id is the primary key and creation is INSERT-only
// (server/storage.ts's createMlbRecommendationEpisode never upserts), so a
// re-create attempt fails on the key rather than silently overwriting a
// frozen row. Every subsequent write is a column-scoped UPDATE limited to
// the mutable columns below (surfaced_at/expires_at/lifecycle_status/
// status/settlement_result/settled_at) — frozen columns are never named in
// any UPDATE ... SET clause anywhere in this codebase.
// ─────────────────────────────────────────────────────────────────────────────
export const mlbRecommendationEpisodes = pgTable("mlb_recommendation_episodes", {
  episodeId: text("episode_id").primaryKey(),
  sport: text("sport").notNull().default("MLB"),
  product: text("product").notNull(),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  market: text("market").notNull(),
  recommendedSide: text("recommended_side").notNull(),
  line: numeric("line").notNull(),
  americanOdds: integer("american_odds").notNull(),
  sportsbook: text("sportsbook").notNull(),
  oddsFetchedAt: timestamp("odds_fetched_at").notNull(),
  recommendationCreatedAt: timestamp("recommendation_created_at").notNull(),
  modelVersion: text("model_version").notNull(),
  contractVersion: text("contract_version").notNull(),
  projection: numeric("projection").notNull(),
  modelProbability: numeric("model_probability").notNull(),
  setupGrade: text("setup_grade").notNull(),
  sportsbookEdge: numeric("sportsbook_edge"),
  dataQuality: text("data_quality").notNull(),
  sourceType: text("source_type").notNull().default("sportsbook"),
  isOfficial: boolean("is_official").notNull().default(true),
  // Additive, nullable: inning/game-phase label for Live Edge episodes
  // ("pregame" | "1st" | ...), null for single-shot pregame products.
  gamePhase: text("game_phase"),
  // Lifecycle — MUTABLE, only via server/storage.ts's
  // applyMlbEpisodeLifecycleEvent/settleMlbRecommendationEpisode.
  surfacedAt: timestamp("surfaced_at"),
  expiresAt: timestamp("expires_at"),
  lifecycleStatus: text("lifecycle_status").notNull(),
  status: text("status").notNull().default("created"),
  settlementResult: text("settlement_result"),
  settledAt: timestamp("settled_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  gameIdIdx: index("mlb_recommendation_episodes_game_id_idx").on(table.gameId),
  playerIdIdx: index("mlb_recommendation_episodes_player_id_idx").on(table.playerId),
  productStatusIdx: index("mlb_recommendation_episodes_product_status_idx").on(table.product, table.status),
  createdAtIdx: index("mlb_recommendation_episodes_created_at_idx").on(table.recommendationCreatedAt),
  statusIdx: index("mlb_recommendation_episodes_status_idx").on(table.status),
  modelVersionIdx: index("mlb_recommendation_episodes_model_version_idx").on(table.modelVersion),
}));

export const insertMlbRecommendationEpisodeSchema = createInsertSchema(mlbRecommendationEpisodes).omit({ createdAt: true, updatedAt: true });
export type MlbRecommendationEpisodeRow = typeof mlbRecommendationEpisodes.$inferSelect;
export type InsertMlbRecommendationEpisode = z.infer<typeof insertMlbRecommendationEpisodeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MLB Live Edge Stage B — all-lane prediction ledger (research-only).
// APPEND-ONLY, PRIVATE. One row per CAPTURE of a finalized Live Edge prediction
// in ANY lane (official/watch/shadow) — see shared/mlbPredictionLedger.ts for the
// frozen contract + settlement rules. This table is NEVER persisted_plays, ROI,
// or a public/official surface; it exists solely to feed a future Stage C
// offline calibrator. The frozen capture columns are immutable after insert;
// only the small settlement surface (status/settlement_result/final_stat/
// settled_at/void_reason) is ever updated, and only through storage's guarded
// settle/void methods. `prediction_id` is the PK (unique per capture); a
// re-insert of the same id is a no-op (onConflictDoNothing), never an overwrite.
// ─────────────────────────────────────────────────────────────────────────────
export const mlbLanePredictions = pgTable("mlb_lane_predictions", {
  // Identity — frozen
  predictionId: text("prediction_id").primaryKey(),
  signalId: text("signal_id").notNull(),
  sport: text("sport").notNull().default("MLB"),
  gameId: text("game_id").notNull(),
  playerId: text("player_id").notNull(),
  playerName: text("player_name").notNull(),
  market: text("market").notNull(),
  side: text("side").notNull(),
  lane: text("lane").notNull(),
  // Captured market state — frozen
  line: numeric("line").notNull(),
  overOdds: integer("over_odds"),
  underOdds: integer("under_odds"),
  sideOdds: integer("side_odds"),
  sportsbook: text("sportsbook"),
  oddsFetchedAt: timestamp("odds_fetched_at"),
  oddsAgeMs: integer("odds_age_ms"),
  capturedAt: timestamp("captured_at").notNull(),
  inning: integer("inning"),
  gamePhase: text("game_phase"),
  statAtCapture: numeric("stat_at_capture"),
  // Model output — frozen (the prediction being measured)
  candidateProbabilityPct: numeric("candidate_probability_pct").notNull(),
  calibratedProbabilityPct: numeric("calibrated_probability_pct"),
  probabilitySemantics: text("probability_semantics").notNull(),
  modelEdgePctPoints: numeric("model_edge_pct_points"),
  noVigBookProbability: numeric("no_vig_book_probability"),
  edgeVersion: text("edge_version"),
  finalizedTier: text("finalized_tier"),
  modelMethod: text("model_method"),
  dataQuality: text("data_quality"),
  baseEligible: boolean("base_eligible"),
  // Diagnostic-only research feature — NO authority (see contract hard rule 3).
  signalScore: numeric("signal_score"),
  laneReasons: jsonb("lane_reasons"),
  // Provenance / versions — frozen
  finalizerVersion: text("finalizer_version"),
  laneVersion: text("lane_version"),
  goldmasterVersion: text("goldmaster_version"),
  contractVersion: text("contract_version").notNull(),
  // Settlement — MUTABLE, only via storage's guarded settle/void methods.
  status: text("status").notNull().default("captured"),
  settlementResult: text("settlement_result"),
  finalStat: numeric("final_stat"),
  settledAt: timestamp("settled_at"),
  voidReason: text("void_reason"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  gameIdIdx: index("mlb_lane_predictions_game_id_idx").on(table.gameId),
  signalIdIdx: index("mlb_lane_predictions_signal_id_idx").on(table.signalId),
  statusIdx: index("mlb_lane_predictions_status_idx").on(table.status),
  laneIdx: index("mlb_lane_predictions_lane_idx").on(table.lane),
  // The settlement sweep scans captured rows oldest-first — composite keeps that
  // query index-only.
  statusCapturedAtIdx: index("mlb_lane_predictions_status_captured_at_idx").on(table.status, table.capturedAt),
}));

export const insertMlbLanePredictionSchema = createInsertSchema(mlbLanePredictions).omit({ createdAt: true, updatedAt: true });
export type MlbLanePredictionRow = typeof mlbLanePredictions.$inferSelect;
export type InsertMlbLanePrediction = z.infer<typeof insertMlbLanePredictionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MLB Live Edge Stage C — offline calibration artifacts (research-only).
// APPEND-ONLY history of fitted raw→calibrated mappings (one row per segment per
// fit run). See shared/mlbCalibration.ts for the artifact contract. Producing a
// row NEVER promotes it — nothing in the live engine reads these until an
// explicit, human-reviewed promotion step exists. `artifact` holds the full
// MlbCalibrationArtifact (bins + fitStats); the flattened columns are for
// admin queries. `artifact_id` = `${segment}:${builtAtMs}` (PK); a re-insert is
// a no-op (onConflictDoNothing).
// ─────────────────────────────────────────────────────────────────────────────
export const mlbCalibrationArtifacts = pgTable("mlb_calibration_artifacts", {
  artifactId: text("artifact_id").primaryKey(),
  segment: text("segment").notNull(),
  method: text("method").notNull(),
  builtAt: timestamp("built_at").notNull(),
  sampleSize: integer("sample_size").notNull(),
  distinctSlateDates: integer("distinct_slate_dates").notNull(),
  rawBrier: numeric("raw_brier"),
  calibratedBrier: numeric("calibrated_brier"),
  rawEcePct: numeric("raw_ece_pct"),
  calibratedEcePct: numeric("calibrated_ece_pct"),
  basePositiveRate: numeric("base_positive_rate"),
  // In-sample promotion-gate result at fit time (always fail-closed here since
  // held-out evidence is absent). Informational for admins; NEVER auto-promotes.
  promotionReady: boolean("promotion_ready").notNull().default(false),
  promotionReasons: jsonb("promotion_reasons"),
  // The full MlbCalibrationArtifact (bins + fitStats).
  artifact: jsonb("artifact").notNull(),
  ledgerContractVersion: text("ledger_contract_version").notNull(),
  artifactVersion: text("artifact_version").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  segmentIdx: index("mlb_calibration_artifacts_segment_idx").on(table.segment),
  builtAtIdx: index("mlb_calibration_artifacts_built_at_idx").on(table.builtAt),
  segmentBuiltAtIdx: index("mlb_calibration_artifacts_segment_built_at_idx").on(table.segment, table.builtAt),
}));

export const insertMlbCalibrationArtifactSchema = createInsertSchema(mlbCalibrationArtifacts).omit({ createdAt: true });
export type MlbCalibrationArtifactRow = typeof mlbCalibrationArtifacts.$inferSelect;
export type InsertMlbCalibrationArtifact = z.infer<typeof insertMlbCalibrationArtifactSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MLB Live Edge Stage C PR3 — active (promoted) calibrator registry.
// The durable source of truth for which calibrator (if any) is CURRENTLY live
// for a segment. One row per segment (PK). A promotion upserts this row; a
// deactivation flips `active` false and stamps a reason — the row is KEPT for
// audit, never deleted. `artifact` holds the full MlbCalibrationArtifact so the
// in-memory hot-path registry can load a segment's mapping without a join.
// A row here changes engine output ONLY when MLB_CALIBRATION_PROMOTION_ENABLED
// is on (default off) — see server/mlb/productionPolicy.ts.
// ─────────────────────────────────────────────────────────────────────────────
export const mlbActiveCalibrators = pgTable("mlb_active_calibrators", {
  segment: text("segment").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  artifact: jsonb("artifact").notNull(),
  active: boolean("active").notNull().default(true),
  activatedAt: timestamp("activated_at").notNull(),
  activatedBy: text("activated_by").notNull(),
  promotionEvidence: jsonb("promotion_evidence"),
  deactivatedAt: timestamp("deactivated_at"),
  deactivationReason: text("deactivation_reason"),
  ledgerContractVersion: text("ledger_contract_version").notNull(),
  artifactVersion: text("artifact_version").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  activeIdx: index("mlb_active_calibrators_active_idx").on(table.active),
}));

export const insertMlbActiveCalibratorSchema = createInsertSchema(mlbActiveCalibrators).omit({ createdAt: true, updatedAt: true });
export type MlbActiveCalibratorRow = typeof mlbActiveCalibrators.$inferSelect;
export type InsertMlbActiveCalibrator = z.infer<typeof insertMlbActiveCalibratorSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Mound Radar V2 (Flagship Program Phase 2) — shadow prediction capture.
// One row per (snapshotId, market) — a pitcher's frozen shadow snapshot
// produces TWO rows (pitcher_strikeouts, pitcher_outs), never one blended
// row, so each market can be graded and measured independently. Research/
// shadow only: this table is never read by buildMlbMoundRadar.ts's public
// response, moundOutcomeAttribution.ts's settlement, or any official
// recommendation path — see server/mlb/pregame/mound/v2/ for the isolation
// discipline this table exists under.
//
// prediction_id = `${snapshotId}:${market}` is the natural composite primary
// key — creation is INSERT-only (server/storage.ts's
// createMoundV2ShadowPrediction never upserts), so a repeated evaluation of
// the exact same frozen snapshot+market is a harmless no-op (ON CONFLICT DO
// NOTHING), not a duplicate row and not a silently-overwritten one. Grading
// is a separate, column-scoped UPDATE (settlement_status/final_result/
// final_stat_value/graded_at only) that never touches the frozen prediction
// fields above it.
// ─────────────────────────────────────────────────────────────────────────────
export const moundV2ShadowPredictions = pgTable("mound_v2_shadow_predictions", {
  predictionId: text("prediction_id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  gameId: text("game_id").notNull(),
  // MLB Stats API gamePk — a DIFFERENT id space than gameId (the ESPN event
  // id). Captured from the pregame build's already-resolved value (zero
  // extra network calls) specifically so a later active reconciliation pass
  // (Correction 3) has a real, durable way to call syncGameBoxScore for this
  // exact game — gameId alone cannot be used to re-derive it after the fact.
  // Null only for legacy rows captured before this column existed.
  gamePk: text("game_pk"),
  pitcherId: text("pitcher_id").notNull(),
  pitcherName: text("pitcher_name").notNull(),
  market: text("market").notNull(),

  // Frozen market state — never rewritten after creation.
  frozenLine: numeric("frozen_line"),
  frozenOverPrice: integer("frozen_over_price"),
  frozenUnderPrice: integer("frozen_under_price"),
  sportsbook: text("sportsbook"),
  oddsFetchedAt: timestamp("odds_fetched_at"),
  // Real scheduled first-pitch time (frozen input's own scheduledGameTime) —
  // distinct from evaluationTimestamp (when the pregame build ran, always
  // BEFORE first pitch). Used by reconciliation (Correction 3) to gate "is
  // this game plausibly over yet" without guessing off build time. Null only
  // for legacy rows captured before this column existed OR when the
  // schedule genuinely never supplied a start time.
  scheduledGameTime: timestamp("scheduled_game_time"),

  evaluationTimestamp: timestamp("evaluation_timestamp").notNull(),

  // V1's own output for the same candidate, captured for side-by-side comparison.
  v1Score10: numeric("v1_score_10"),
  v1Tier: text("v1_tier"),
  setupGrade: text("setup_grade"),
  // V1's own frozen recommended side ("OVER"|"UNDER"|null — derived from
  // moundDirection at the same evaluation moment). Additive; rows captured
  // before this column existed have it null AND carry the pre-bump
  // contractVersion ("mound_frozen_input_v1") — moundV2ComparisonStats.ts
  // uses contractVersion, not this column's nullness alone, to distinguish
  // "V1 genuinely had no recommendation" from "this row predates capture".
  v1RecommendedSide: text("v1_recommended_side"),
  // (Final Pre-Push Integrity Pass) Whether v1RecommendedSide represents a
  // genuinely publicly-qualified V1 recommendation (everPubliclyFlagged /
  // everPubliclyFlaggedFade, captured AFTER carryForwardMoundGradedState has
  // pinned moundDirection for this build — see buildMlbMoundRadar.ts) —
  // "recommended" | "not_recommended". A generic model lean that was never
  // shown to users is "not_recommended" with v1RecommendedSide null, never
  // silently counted as a real V1 wager. Rows captured before this column
  // existed have it null; moundV2ComparisonStats.ts treats null the same as
  // "unknown, exclude from paired comparison", never as "not_recommended".
  v1QualificationStatus: text("v1_qualification_status"),

  // V2's real distributional output.
  v2ExpectedValue: numeric("v2_expected_value").notNull(),
  v2OverProbability: numeric("v2_over_probability").notNull(),
  v2UnderProbability: numeric("v2_under_probability").notNull(),
  v2PushProbability: numeric("v2_push_probability").notNull(),

  // V2's own versioned MODEL-policy verdict (Mound V2 purity pass; renamed
  // from v2DecisionPolicy/v2Qualified/v2DecisionSide/v2QualificationReason
  // — the OLD names ambiguously combined the model decision with sportsbook
  // executability in one concept). DISTINCT from the raw probabilities
  // above. "V2's implied side" (whichever of over/under has higher
  // probability) is NOT a decision policy; this is the qualify-or-abstain
  // verdict from moundV2ModelPolicy.ts, computed from ONLY the model's own
  // probabilities + data-quality/lineup-status — NEVER price, sportsbook
  // identity, or odds freshness (that module's input type structurally has
  // no such field). v2ModelSide is null whenever v2ModelQualified is false
  // — an explicit, reasoned abstention, never a forced pick.
  v2ModelPolicyVersion: text("v2_model_policy_version"),
  v2ModelSide: text("v2_model_side"),
  v2ModelQualified: boolean("v2_model_qualified"),
  v2ModelQualificationReason: text("v2_model_qualification_reason"),

  // SEPARATE, downstream-of-the-model sportsbook EXECUTABILITY verdict
  // (moundV2Executability.ts) — whether v2ModelSide (if any) has a real,
  // fresh, provenanced price to trade against. Reads the model's OWN
  // already-decided side; never feeds back into v2ModelSide/v2ModelQualified
  // above. v2Executable is false (never null-as-true) whenever the price is
  // missing, unprovenanced, or stale, or the model itself abstained.
  //
  // ATOMICITY (Final Line-Provenance and V1 Purity Correction): sportsbook/
  // line/price/fetchedAt below are ALWAYS written together from the SAME
  // atomic MoundV2ExecutableOffer object (moundV2Executability.ts) in one
  // INSERT — never populated from separately-sourced variables, so they can
  // never independently mismatch. v2ExecutableLine is a NEW column added in
  // this correction; a prior version of this contract had no line column at
  // all for the executable offer, forcing a reader to cross-reference
  // frozen_line (a DIFFERENT part of the row, sourced from the model's own
  // line-conditioned-probability input) to know which line an executable
  // price belonged to — exactly the kind of separately-selected-fields risk
  // this column removes.
  v2ExecutabilityPolicyVersion: text("v2_executability_policy_version"),
  v2Executable: boolean("v2_executable"),
  v2ExecutableSportsbook: text("v2_executable_sportsbook"),
  v2ExecutableLine: numeric("v2_executable_line"),
  v2ExecutablePrice: integer("v2_executable_price"),
  v2ExecutableFetchedAt: timestamp("v2_executable_fetched_at"),
  v2ExecutabilityFailureReason: text("v2_executability_failure_reason"),

  productionModelVersion: text("production_model_version").notNull(),
  v2ModelVersion: text("v2_model_version").notNull(),
  contractVersion: text("contract_version").notNull(),
  featureHash: text("feature_hash").notNull(),

  dataQuality: text("data_quality").notNull(),
  lineupStatus: text("lineup_status").notNull(),

  shadowLatencyMs: numeric("shadow_latency_ms"),
  shadowFailureReason: text("shadow_failure_reason"),

  // Grading — MUTABLE, only via server/storage.ts's gradeMoundV2ShadowPrediction.
  settlementStatus: text("settlement_status").notNull().default("pending"),
  finalResult: text("final_result"),
  finalStatValue: numeric("final_stat_value"),
  // Why a "void" settlement happened (Part 5's computeMoundV2GradingDecision
  // already derives this internally — "game_cancelled" | "pitcher_no_appearance"
  // — but previously discarded it after deciding; persisted so a diagnostic
  // report can distinguish the two without re-deriving them (Correction 3).
  // Null for "pending"/"graded" rows.
  voidReason: text("void_reason"),
  gradedAt: timestamp("graded_at"),

  // Reconciliation bookkeeping (Correction 3) — MUTABLE, only via
  // server/storage.ts's recordMoundV2ShadowReconciliationAttempt. Tracks the
  // bounded backstop pass that re-checks stuck "pending" rows a normal
  // passive grading tick never saw a fresh box score for. Never touched for
  // rows that have already graded/voided.
  reconciliationAttemptCount: integer("reconciliation_attempt_count").notNull().default(0),
  lastReconciliationAttemptAt: timestamp("last_reconciliation_attempt_at"),
  lastReconciliationFailureReason: text("last_reconciliation_failure_reason"),

  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  snapshotIdx: index("mound_v2_shadow_predictions_snapshot_idx").on(table.snapshotId),
  gamePitcherIdx: index("mound_v2_shadow_predictions_game_pitcher_idx").on(table.gameId, table.pitcherId),
  settlementStatusIdx: index("mound_v2_shadow_predictions_settlement_status_idx").on(table.settlementStatus),
  evaluationTimestampIdx: index("mound_v2_shadow_predictions_evaluation_timestamp_idx").on(table.evaluationTimestamp),
  marketVersionIdx: index("mound_v2_shadow_predictions_market_version_idx").on(table.market, table.v2ModelVersion),
}));

export const insertMoundV2ShadowPredictionSchema = createInsertSchema(moundV2ShadowPredictions).omit({ createdAt: true });
export type MoundV2ShadowPredictionRow = typeof moundV2ShadowPredictions.$inferSelect;
export type InsertMoundV2ShadowPrediction = z.infer<typeof insertMoundV2ShadowPredictionSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Mound Radar V2 (Final Pre-Push Integrity Pass) — durable shadow-evaluation
// outbox. One row per frozen snapshot (snapshot_id is UNIQUE — idempotent
// enqueue, ON CONFLICT DO NOTHING). This table, NOT an in-memory queue, is
// what makes V2 evaluation safe to move out of buildMlbMoundRadar.ts's
// publication-critical path: the production build's ONLY synchronous
// obligation is one bounded INSERT into this table (the "durable handoff").
// A separate worker tick (moundV2ShadowWorker.ts) claims pending rows with
// `FOR UPDATE SKIP LOCKED` (safe under concurrent worker ticks), runs the
// actual V2 evaluation + persistence, and marks the row completed/failed —
// entirely outside V1's request/build timeline. A crash or restart at ANY
// point loses nothing: an enqueued-but-unclaimed row is still `pending`;
// a claimed-but-never-completed row's lease (claimed_at) simply expires and
// becomes reclaimable again (see MOUND_V2_SHADOW_JOB_LEASE_MS in
// moundV2ShadowJobQueue.ts).
// ─────────────────────────────────────────────────────────────────────────────
export const moundV2ShadowJobs = pgTable("mound_v2_shadow_jobs", {
  jobId: text("job_id").primaryKey(),
  /** Idempotency key — one job per frozen snapshot, ever. A repeated enqueue attempt (e.g. a retried build tick) is a harmless no-op. */
  snapshotId: text("snapshot_id").notNull().unique(),
  gameId: text("game_id").notNull(),
  pitcherId: text("pitcher_id").notNull(),
  signalId: text("signal_id").notNull(),
  /** The full EvaluateMoundV2ShadowArgs, JSON-serialized (Dates as ISO strings) — everything the worker needs to run evaluateMoundV2Shadow() from scratch, with nothing re-derived from possibly-changed live state. */
  payload: jsonb("payload").notNull(),
  /** pending -> in_progress -> completed, or -> dead_letter after MAX_ATTEMPTS failures. Never any other transition. */
  status: text("status").notNull().default("pending"),
  enqueuedAt: timestamp("enqueued_at").notNull().defaultNow(),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptedAt: timestamp("last_attempted_at"),
  lastFailureReason: text("last_failure_reason"),
  /** Lease fields — a worker claims a batch by stamping these; an expired (stale) lease on a still-in_progress row makes it reclaimable by a later tick, recovering from a worker crash mid-processing. claimedBy is an opaque instance/tick identifier for observability only — the real mutual exclusion is the atomic UPDATE...WHERE...RETURNING claim, not this column. */
  claimedAt: timestamp("claimed_at"),
  claimedBy: text("claimed_by"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  statusIdx: index("mound_v2_shadow_jobs_status_idx").on(table.status),
  enqueuedAtIdx: index("mound_v2_shadow_jobs_enqueued_at_idx").on(table.enqueuedAt),
  gamePitcherIdx: index("mound_v2_shadow_jobs_game_pitcher_idx").on(table.gameId, table.pitcherId),
}));

export const insertMoundV2ShadowJobSchema = createInsertSchema(moundV2ShadowJobs).omit({ createdAt: true });
export type MoundV2ShadowJobRow = typeof moundV2ShadowJobs.$inferSelect;
export type InsertMoundV2ShadowJob = z.infer<typeof insertMoundV2ShadowJobSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Pregame Targets — temporal data foundation (PR1). Three ADDITIVE tables that
// underpin as-of feature reconstruction; no existing table is touched. Nothing
// writes to these yet (no build loop until a later PR) — the schema + bootstrap
// exist so the foundation is durable and testable now. See
// docs/pregame-targets/ and server/pregameTargets/.
// ─────────────────────────────────────────────────────────────────────────────

/** Immutable raw provider snapshot, captured with its known-at (arrival) instant. */
export const pregameRawSourceSnapshots = pgTable("pregame_raw_source_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  sport: text("sport").notNull(),
  /** Provider/source family, e.g. "nba_stats_playergamelog". */
  sourceKind: text("source_kind").notNull(),
  /** CAPTURE key (semantic key + observation instant) — distinct per accepted
   *  observation, so an A→B→A recurrence yields distinct captures. Part of the
   *  inherited content-identity unique index. */
  sourceKey: text("source_key").notNull(),
  /** STABLE semantic source identity (sport|provider|kind|entity|season|seasonType|
   *  sourceVersion), constant across every observation of the same request. Drives
   *  lineage/head selection — NOT capture identity. Nullable (additive). */
  semanticSourceKey: text("semantic_source_key"),
  // Absolute instants — timezone-aware so a round trip can never shift them and
  // change the knownAt <= predictionAt cutoff (Postgres `timestamptz`).
  /** Event time — when the underlying facts became true. */
  validAt: timestamp("valid_at", { withTimezone: true }).notNull(),
  /** Observation time — when this payload was fetched / could be known. */
  knownAt: timestamp("known_at", { withTimezone: true }).notNull(),
  /** Source-published/finalized instant IF the provider exposes one; NULL = explicitly
   *  unknown (playergamelog exposes none). Persisted so "unknown" is a durable fact. */
  sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
  /** Version of the rule that produced `knownAt` (audit metadata; e.g. nba_gamelog_knownAt_v1). */
  knownAtPolicyVersion: text("known_at_policy_version"),
  /** Correction lineage: the immediately-prior immutable snapshot for the SAME semantic
   *  source identity that this one supersedes; NULL for a first capture. Set by storage
   *  under the ingest transaction/lock — never caller-chosen. Prior rows are never
   *  updated/deleted/repointed, so corrections form a deterministic chain. */
  supersedesSnapshotId: text("supersedes_snapshot_id"),
  /** Raw response, stored verbatim and never mutated (a correction is a new row). */
  payload: jsonb("payload").notNull(),
  /** Content hash of the payload — dedupe / idempotent capture. */
  contentHash: text("content_hash").notNull(),
  /** Immutable ingestion instant (row is INSERT-only, never updated) — the canonical `ingestedAt`. */
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  sportKindIdx: index("pregame_raw_source_snapshots_sport_kind_idx").on(table.sport, table.sourceKind),
  knownAtIdx: index("pregame_raw_source_snapshots_known_at_idx").on(table.knownAt),
  sourceKeyIdx: index("pregame_raw_source_snapshots_source_key_idx").on(table.sourceKey),
  supersedesIdx: index("pregame_raw_source_snapshots_supersedes_idx").on(table.supersedesSnapshotId),
  // Head selection: latest observation for a semantic identity (ORDER BY known_at DESC).
  semanticHeadIdx: index("pregame_raw_source_snapshots_semantic_head_idx").on(table.semanticSourceKey, table.knownAt),
  // Uniqueness is scoped to the REQUESTED SOURCE, not the payload alone: two
  // different source_key requests can legitimately return the same payload
  // (commonly an empty response), and each is a distinct capture. Only a genuine
  // re-fetch of the SAME source with an unchanged payload dedupes.
  sourceContentIdx: uniqueIndex("pregame_raw_source_snapshots_source_content_uidx").on(
    table.sourceKind,
    table.sourceKey,
    table.contentHash,
  ),
}));

export const insertPregameRawSourceSnapshotSchema = createInsertSchema(pregameRawSourceSnapshots).omit({ createdAt: true });
export type PregameRawSourceSnapshotRow = typeof pregameRawSourceSnapshots.$inferSelect;
export type InsertPregameRawSourceSnapshot = z.infer<typeof insertPregameRawSourceSnapshotSchema>;

/** A single as-of feature reading (persisted AsOfFeatureRow). Append-only. */
export const pregameFeatureSnapshots = pgTable("pregame_feature_snapshots", {
  featureRowId: text("feature_row_id").primaryKey(),
  sport: text("sport").notNull(),
  entityCanonicalId: text("entity_canonical_id").notNull(),
  entityKind: text("entity_kind").notNull(),
  featureKey: text("feature_key").notNull(),
  featureVersion: text("feature_version").notNull(),
  season: integer("season").notNull(),
  // Timezone-aware absolute instants (see raw-snapshot note above).
  validAt: timestamp("valid_at", { withTimezone: true }).notNull(),
  knownAt: timestamp("known_at", { withTimezone: true }).notNull(),
  /** observed | observed_zero | not_applicable | missing | stale | disagreement | imputed */
  state: text("state").notNull(),
  /** Finite reading for value-bearing states; NULL otherwise (never 0-for-missing). */
  value: numeric("value"),
  /** Raw source snapshot id this reading was derived from. */
  sourceId: text("source_id").notNull(),
  /** Canonical game ids that contributed (provenance / self-update guard). */
  derivedFromGameIds: jsonb("derived_from_game_ids"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  // Primary as-of read path: by entity+feature, most-recent knownAt <= predictionAt.
  entityFeatureKnownAtIdx: index("pregame_feature_snapshots_entity_feature_known_at_idx").on(
    table.entityCanonicalId,
    table.featureKey,
    table.knownAt,
  ),
  sportFeatureIdx: index("pregame_feature_snapshots_sport_feature_idx").on(table.sport, table.featureKey),
  seasonIdx: index("pregame_feature_snapshots_season_idx").on(table.season),
}));

export const insertPregameFeatureSnapshotSchema = createInsertSchema(pregameFeatureSnapshots).omit({ createdAt: true });
export type PregameFeatureSnapshotRow = typeof pregameFeatureSnapshots.$inferSelect;
export type InsertPregameFeatureSnapshot = z.infer<typeof insertPregameFeatureSnapshotSchema>;

/** Posterior sufficient-statistics state, one per entity+feature+version. */
export const pregamePosteriorStates = pgTable("pregame_posterior_states", {
  posteriorId: text("posterior_id").primaryKey(),
  sport: text("sport").notNull(),
  entityCanonicalId: text("entity_canonical_id").notNull(),
  featureKey: text("feature_key").notNull(),
  featureVersion: text("feature_version").notNull(),
  stateVersion: integer("state_version").notNull(),
  /** Record<season, SeasonSufficientStats> — the per-season sufficient stats. */
  bySeason: jsonb("by_season").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  entityFeatureVersionUidx: uniqueIndex("pregame_posterior_states_entity_feature_version_uidx").on(
    table.entityCanonicalId,
    table.featureKey,
    table.featureVersion,
  ),
  sportFeatureIdx: index("pregame_posterior_states_sport_feature_idx").on(table.sport, table.featureKey),
}));

export const insertPregamePosteriorStateSchema = createInsertSchema(pregamePosteriorStates).omit({ createdAt: true });
export type PregamePosteriorStateRow = typeof pregamePosteriorStates.$inferSelect;
export type InsertPregamePosteriorState = z.infer<typeof insertPregamePosteriorStateSchema>;
