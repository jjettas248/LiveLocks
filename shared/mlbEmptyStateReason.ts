// ── MLB Empty-State Reason Contract ───────────────────────────────────────
// Replaces ambiguous "no plays right now" responses with an explicit,
// user-safe reason code so the client can render something honest instead of
// a generic spinner or — worse — a fabricated recommendation. See CLAUDE.md
// "No synthetic official plays": an empty state is always preferred to a
// manufactured one.

export const MLB_EMPTY_REASONS = [
  "PREGAME_NOT_OPEN",
  "GAME_NOT_STARTED",
  "NO_MARKETS_POSTED",
  "NO_QUALIFIED_SETUPS",
  "ODDS_STALE",
  "PROVIDER_DEGRADED",
  "ENGINE_WARMING",
  "BETWEEN_EVENTS",
  "GAME_FINAL",
] as const;
export type MlbEmptyReason = (typeof MLB_EMPTY_REASONS)[number];

export type MlbFeedHealth = "healthy" | "degraded" | "down";

export interface MlbEmptyStateResponse {
  reason: MlbEmptyReason;
  message: string;                     // user-safe explanation
  lastSuccessfulUpdate: string | null;  // ISO 8601
  nextExpectedUpdate: string | null;    // ISO 8601, when known
  feedHealth: MlbFeedHealth;
}

// Default user-safe copy per reason. Callers may override `message` (e.g. to
// name a specific sportsbook outage) but every reason has a safe fallback so
// a route can never emit a reason code with no explanation.
export const MLB_EMPTY_REASON_MESSAGES: Record<MlbEmptyReason, string> = {
  PREGAME_NOT_OPEN: "Today's slate hasn't opened for pregame targeting yet.",
  GAME_NOT_STARTED: "This game hasn't started yet.",
  NO_MARKETS_POSTED: "No sportsbook has posted a line for this market yet.",
  NO_QUALIFIED_SETUPS: "No matchup currently clears our qualification bar.",
  ODDS_STALE: "The latest sportsbook price is too old to recommend a play on.",
  PROVIDER_DEGRADED: "Our odds provider is temporarily degraded.",
  ENGINE_WARMING: "The engine is still gathering data for this slate.",
  BETWEEN_EVENTS: "No qualifying event has occurred since the last update.",
  GAME_FINAL: "This game is final.",
};

export function buildMlbEmptyStateResponse(
  reason: MlbEmptyReason,
  opts: {
    message?: string;
    lastSuccessfulUpdate?: string | null;
    nextExpectedUpdate?: string | null;
    feedHealth?: MlbFeedHealth;
  } = {},
): MlbEmptyStateResponse {
  return {
    reason,
    message: opts.message ?? MLB_EMPTY_REASON_MESSAGES[reason],
    lastSuccessfulUpdate: opts.lastSuccessfulUpdate ?? null,
    nextExpectedUpdate: opts.nextExpectedUpdate ?? null,
    feedHealth: opts.feedHealth ?? "healthy",
  };
}
