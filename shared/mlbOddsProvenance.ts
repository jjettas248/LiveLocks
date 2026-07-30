// ── MLB Odds Provenance Contract ──────────────────────────────────────────
// The transport shape every MLB odds read must carry when it might back an
// official recommendation: not just a price, but where it came from, when it
// was actually fetched from the provider, and how fresh it is RIGHT NOW.
//
// Freshness is a function of the READER's current game state, never a value
// baked in at write time — see classifyMlbOddsFreshness in
// server/odds/mlbOddsProvenanceContract.ts. A snapshot's own historical
// isLive flag must never be what decides whether it's fresh today.

import type { MlbApprovedSportsbook, MlbRecommendedSide } from "./mlbRecommendationEpisode";

export type MlbOddsContext = "pregame" | "live";

// "immutable"  = game is final; nothing fresher will ever arrive (always fresh).
// "unknown"    = the reader could not determine current game state; freshness
//                can never be confirmed in this state, so it must never back
//                an official play (fail closed, mirrors isMLBSnapshotFresh).
export type MlbOddsFreshness = "fresh" | "stale" | "immutable" | "unknown";

export interface MlbOddsProvenance {
  eventId: string;
  playerId: string | null;   // null for game-level (non-player) markets
  market: string;
  side: MlbRecommendedSide;
  line: number;
  americanOdds: number;
  sportsbook: MlbApprovedSportsbook;
  fetchedAt: string;         // ISO 8601 — the provider's real fetch timestamp, never Date.now() at read time
  sourceType: "sportsbook";
  context: MlbOddsContext;
  freshness: MlbOddsFreshness;
  expiresAt: string | null;
}
