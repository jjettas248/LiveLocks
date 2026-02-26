import { pgTable, text, serial, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const players = pgTable("players", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  team: text("team").notNull(),
  position: text("position").notNull(),
  avgMinutes: numeric("avg_minutes").notNull(),
  avgFouls: numeric("avg_fouls").notNull(),
  // Season stats — synced from BallDontLie API
  ppg: numeric("ppg"),
  rpg: numeric("rpg"),
  apg: numeric("apg"),
  spg: numeric("spg"),
  bpg: numeric("bpg"),
  tpg: numeric("tpg"),
  usageRate: numeric("usage_rate"),
  statsUpdatedAt: timestamp("stats_updated_at"),
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
});

export type CalculateProbabilityRequest = z.infer<typeof calculateProbabilitySchema>;

export interface CalculateProbabilityResponse {
  probability: number;
  expectedTotal: number;
  projectedSecondHalfMinutes: number;
  defenseMultiplier: number;
  paceMultiplier: number;
  paceLabel: string;
  teamPace: number;
  opponentPace: number;
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
