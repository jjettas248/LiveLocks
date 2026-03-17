import { pgTable, text, serial, numeric, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  subscriptionTier: text("subscription_tier"),
  playsUsed: integer("plays_used").notNull().default(0),
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
}

export interface CalculateProbabilityResponse {
  probability: number;
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
  gameDate: text("game_date").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  result: text("result"),
  finalStat: numeric("final_stat"),
  settledAt: timestamp("settled_at"),
  notificationSent: boolean("notification_sent").default(false),
  duplicateGuard: text("duplicate_guard").unique(),
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
