// ── MLB Odds Provenance — Zod validation + reader-driven freshness ───────
// Wraps the existing isMLBSnapshotFresh (server/oddsService.ts) rather than
// re-deriving its TTL thresholds, so the two can never drift apart. This
// module has no I/O of its own — callers already hold a cache read; this
// just validates/classifies it.

import { z } from "zod";
import { isMLBSnapshotFresh, type MlbGameStatus } from "../oddsService";
import { MLB_APPROVED_SPORTSBOOKS, type MlbApprovedSportsbook } from "@shared/mlbRecommendationEpisode";
import type { MlbOddsContext, MlbOddsFreshness, MlbOddsProvenance } from "@shared/mlbOddsProvenance";

export const mlbApprovedSportsbookSchema = z.enum(MLB_APPROVED_SPORTSBOOKS);

export const mlbOddsProvenanceSchema = z.object({
  eventId: z.string().min(1),
  playerId: z.string().min(1).nullable(),
  market: z.string().min(1),
  side: z.enum(["OVER", "UNDER"]),
  line: z.number().finite(),
  americanOdds: z.number().finite().refine((v) => Math.abs(v) >= 100, {
    message: "American odds must have magnitude >= 100",
  }),
  sportsbook: mlbApprovedSportsbookSchema,
  fetchedAt: z.string().min(1),
  sourceType: z.literal("sportsbook"),
  context: z.enum(["pregame", "live"]),
  freshness: z.enum(["fresh", "stale", "immutable", "unknown"]),
  expiresAt: z.string().nullable(),
});

/**
 * Reader-driven freshness classification. `gameStatus` MUST be the caller's
 * CURRENT read of game state, never a value stored at odds-fetch time — a
 * pregame quote that goes stale the instant the game goes live is exactly
 * the case this guards against (see CLAUDE.md 3.2b: "the cached writer's
 * historical isLive value" must never determine freshness).
 */
export function classifyMlbOddsFreshness(gameStatus: MlbGameStatus, ageMs: number): MlbOddsFreshness {
  if (gameStatus === "final") return "immutable";
  if (gameStatus === "unknown") return "unknown";
  return isMLBSnapshotFresh(gameStatus, ageMs) ? "fresh" : "stale";
}

export function buildMlbOddsProvenance(input: {
  eventId: string;
  playerId: string | null;
  market: string;
  side: "OVER" | "UNDER";
  line: number;
  americanOdds: number;
  sportsbook: MlbApprovedSportsbook;
  fetchedAt: string;
  context: MlbOddsContext;
  currentGameStatus: MlbGameStatus;
  now: Date;
  expiresAt?: string | null;
}): MlbOddsProvenance {
  const ageMs = input.now.getTime() - new Date(input.fetchedAt).getTime();
  return {
    eventId: input.eventId,
    playerId: input.playerId,
    market: input.market,
    side: input.side,
    line: input.line,
    americanOdds: input.americanOdds,
    sportsbook: input.sportsbook,
    fetchedAt: input.fetchedAt,
    sourceType: "sportsbook",
    context: input.context,
    freshness: classifyMlbOddsFreshness(input.currentGameStatus, ageMs),
    expiresAt: input.expiresAt ?? null,
  };
}
