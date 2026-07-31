// ── LiveLocks MLB Flagship Program — Recommendation Episode Contract ──────
// The single frozen record every OFFICIAL MLB recommendation (Plate, Mound,
// Live Edge) produces. An episode is a point-in-time capture: once created,
// its recommendation fields (side, line, price, sportsbook, probability,
// projection, model/contract version, ...) are frozen for the life of the
// record. Only the small, explicit set of lifecycle fields in
// MLB_EPISODE_MUTABLE_FIELDS may change after creation.
//
// This is deliberately a NEW, product-agnostic contract — it does not reuse
// or extend `persisted_plays` (mutable, upsert-in-place "current best" row,
// shared cross-sport with NBA/NCAAB, no frozen-price discipline) or
// CanonicalSignal (live-only, 0-100 display probability, no captured odds
// provenance). Wiring Plate/Mound/Live Edge to actually emit rows into this
// contract is later-phase work — see CLAUDE.md once updated.
//
// Hard rules:
//   1. Fields in MLB_EPISODE_FROZEN_FIELDS MUST NOT change after creation.
//      applyMlbEpisodeLifecycleEvent throws MlbEpisodeMutationError if asked to.
//   2. Only MLB_EPISODE_MUTABLE_FIELDS may be patched post-creation.
//   3. status transitions follow MLB_EPISODE_STATUS_TRANSITIONS; "expired" and
//      "settled" are terminal (no outgoing transition, no further patches at all).
//   4. settlementResult may only be set (non-null) together with status
//      transitioning to "settled", and a settled episode can never be
//      re-settled — settlement is single-write, graded against the exact
//      side/line/price captured at creation.

export type MlbSport = "MLB";

export const MLB_RECOMMENDATION_PRODUCTS = ["plate", "mound", "live_edge"] as const;
export type MlbRecommendationProduct = (typeof MLB_RECOMMENDATION_PRODUCTS)[number];

// The only three books MLB Live Edge/Plate/Mound are permitted to quote from
// (server/oddsService.ts MLB_PROP_BOOKMAKERS). A generic provider label like
// "odds_api" is NOT a sportsbook and must never satisfy this type — see
// server/mlb/episodes/mlbOfficialRecommendationFirewall.ts, which rejects any
// value outside this set.
export const MLB_APPROVED_SPORTSBOOKS = ["draftkings", "fanduel", "hardrockbet"] as const;
export type MlbApprovedSportsbook = (typeof MLB_APPROVED_SPORTSBOOKS)[number];

export type MlbRecommendedSide = "OVER" | "UNDER";

// Only real, provider-fetched sportsbook prices may back an official episode.
// There is deliberately no "model" | "estimated" | "synthetic" member here — a
// research/shadow row simply never becomes an MlbRecommendationEpisode; it
// stays in its own product-specific research table (see persistence audit).
export type MlbEpisodeSourceType = "sportsbook";

export const MLB_EPISODE_DATA_QUALITY = ["complete", "partial", "degraded"] as const;
export type MlbEpisodeDataQuality = (typeof MLB_EPISODE_DATA_QUALITY)[number];

export const MLB_EPISODE_STATUSES = ["created", "surfaced", "locked", "expired", "settled"] as const;
export type MlbEpisodeStatus = (typeof MLB_EPISODE_STATUSES)[number];

// Product-facing conviction/progression state — orthogonal to `status` (which
// is record bookkeeping, not user-facing). Live Edge walks
// monitoring -> ready -> fire; Plate and Mound are single-shot pregame
// recommendations, so "recommended" covers both a Follow and a Fade alike —
// the recommended side itself lives in `recommendedSide`, not here.
// cashed/missed/push/void mirror `settlementResult` once settled, so a
// terminal episode's lifecycleStatus and settlementResult always agree.
export const MLB_LIFECYCLE_STATUSES = [
  "monitoring", "ready", "fire", "recommended", "cashed", "missed", "push", "void", "expired",
] as const;
export type MlbLifecycleStatus = (typeof MLB_LIFECYCLE_STATUSES)[number];

export const MLB_SETTLEMENT_RESULTS = ["cashed", "missed", "push", "void"] as const;
export type MlbSettlementResult = (typeof MLB_SETTLEMENT_RESULTS)[number];

export interface MlbRecommendationEpisode {
  // Identity — frozen ------------------------------------------------------
  episodeId: string;
  sport: MlbSport;
  product: MlbRecommendationProduct;
  gameId: string;
  playerId: string;
  playerName: string;
  market: string;
  recommendedSide: MlbRecommendedSide;

  // Captured market state — frozen -----------------------------------------
  line: number;
  americanOdds: number;
  sportsbook: MlbApprovedSportsbook;
  oddsFetchedAt: string;              // ISO 8601 — the provider's REAL fetch timestamp
  recommendationCreatedAt: string;    // ISO 8601

  // Model output — frozen ---------------------------------------------------
  modelVersion: string;
  contractVersion: string;
  projection: number;

  // 0..1 fractional probability of the outcome named by `recommendedSide`.
  // Distinct from CanonicalSignal.displayProbability (0-100, live-only) —
  // this is the statistically-scaled value the measurement contract's
  // Brier/log-loss/calibration math is defined against.
  modelProbability: number;

  setupGrade: string;

  // Downstream-only: model probability vs de-vigged market probability.
  // Never an engine input (see CLAUDE.md "Engine probability remains
  // independent"). Null until a de-vigged market probability is available.
  sportsbookEdge: number | null;

  dataQuality: MlbEpisodeDataQuality;
  sourceType: MlbEpisodeSourceType;
  isOfficial: true;

  // Optional, additive: inning/game-phase label for Live Edge episodes
  // ("pregame" | "1st" | ... ), null for single-shot pregame products. Exists
  // so the measurement contract can break performance down by game phase
  // without a later schema change.
  gamePhase: string | null;

  // Lifecycle — MUTABLE, ONLY through applyMlbEpisodeLifecycleEvent ---------
  surfacedAt: string | null;
  expiresAt: string | null;
  lifecycleStatus: MlbLifecycleStatus;
  status: MlbEpisodeStatus;
  settlementResult: MlbSettlementResult | null;
  settledAt: string | null;
}

export const MLB_EPISODE_MUTABLE_FIELDS = [
  "surfacedAt", "expiresAt", "lifecycleStatus", "status", "settlementResult", "settledAt",
] as const satisfies readonly (keyof MlbRecommendationEpisode)[];
export type MlbEpisodeMutableField = (typeof MLB_EPISODE_MUTABLE_FIELDS)[number];

const MUTABLE_FIELD_SET: ReadonlySet<string> = new Set(MLB_EPISODE_MUTABLE_FIELDS);

// Every other key on the interface is frozen. Declared as a positive list
// (not "everything not mutable") so a newly-added field defaults to FROZEN
// unless explicitly opted into MLB_EPISODE_MUTABLE_FIELDS above — fail safe.
export const MLB_EPISODE_FROZEN_FIELDS = [
  "episodeId", "sport", "product", "gameId", "playerId", "playerName", "market",
  "recommendedSide", "line", "americanOdds", "sportsbook", "oddsFetchedAt",
  "recommendationCreatedAt", "modelVersion", "contractVersion", "projection",
  "modelProbability", "setupGrade", "sportsbookEdge", "dataQuality", "sourceType",
  "isOfficial", "gamePhase",
] as const satisfies readonly (keyof MlbRecommendationEpisode)[];
export type MlbEpisodeFrozenField = (typeof MLB_EPISODE_FROZEN_FIELDS)[number];

export const MLB_EPISODE_STATUS_TRANSITIONS: Record<MlbEpisodeStatus, MlbEpisodeStatus[]> = {
  created:  ["surfaced", "locked", "expired"],
  surfaced: ["locked", "expired", "settled"],
  locked:   ["settled", "expired"],
  expired:  [],
  settled:  [],
};

export function isTerminalMlbEpisodeStatus(status: MlbEpisodeStatus): boolean {
  return status === "expired" || status === "settled";
}

export class MlbEpisodeMutationError extends Error {
  constructor(public readonly attemptedFields: string[]) {
    super(
      `Attempted to mutate frozen MlbRecommendationEpisode field(s): ${attemptedFields.join(", ")}. ` +
      `Only ${MLB_EPISODE_MUTABLE_FIELDS.join(", ")} may change after creation.`,
    );
    this.name = "MlbEpisodeMutationError";
  }
}

export class MlbEpisodeTransitionError extends Error {
  constructor(public readonly from: MlbEpisodeStatus, public readonly to: MlbEpisodeStatus) {
    super(`Invalid MlbRecommendationEpisode status transition: ${from} -> ${to}`);
    this.name = "MlbEpisodeTransitionError";
  }
}

export class MlbEpisodeTerminalError extends Error {
  constructor(public readonly status: MlbEpisodeStatus) {
    super(`MlbRecommendationEpisode is terminal (status="${status}") and cannot receive further lifecycle events.`);
    this.name = "MlbEpisodeTerminalError";
  }
}

/**
 * The sole mutator for a frozen episode. Returns a NEW object; never mutates
 * `episode` in place. Throws:
 *   - MlbEpisodeMutationError if `patch` touches any frozen field
 *   - MlbEpisodeTerminalError if the episode is already expired/settled
 *   - MlbEpisodeTransitionError if `patch.status` names an illegal transition
 */
export function applyMlbEpisodeLifecycleEvent(
  episode: MlbRecommendationEpisode,
  patch: Partial<Pick<MlbRecommendationEpisode, MlbEpisodeMutableField>>,
): MlbRecommendationEpisode {
  const attemptedFrozen = Object.keys(patch).filter((key) => !MUTABLE_FIELD_SET.has(key));
  if (attemptedFrozen.length > 0) {
    throw new MlbEpisodeMutationError(attemptedFrozen);
  }
  if (isTerminalMlbEpisodeStatus(episode.status)) {
    throw new MlbEpisodeTerminalError(episode.status);
  }
  if (patch.status && patch.status !== episode.status) {
    const allowed = MLB_EPISODE_STATUS_TRANSITIONS[episode.status];
    if (!allowed.includes(patch.status)) {
      throw new MlbEpisodeTransitionError(episode.status, patch.status);
    }
  }
  return { ...episode, ...patch };
}

/**
 * Grades an episode against the EXACT side/line/price it was created with —
 * there is no other input to this function that could disagree with what was
 * shown to the user. Rejects settling an already-terminal episode (via
 * applyMlbEpisodeLifecycleEvent) and rejects a settlementResult outside
 * MLB_SETTLEMENT_RESULTS.
 */
export function settleMlbRecommendationEpisode(
  episode: MlbRecommendationEpisode,
  settlementResult: MlbSettlementResult,
  settledAt: string,
): MlbRecommendationEpisode {
  if (!MLB_SETTLEMENT_RESULTS.includes(settlementResult)) {
    throw new RangeError(`Invalid settlementResult: ${String(settlementResult)}`);
  }
  const settlementLifecycle: MlbLifecycleStatus = settlementResult;
  return applyMlbEpisodeLifecycleEvent(episode, {
    status: "settled",
    settlementResult,
    settledAt,
    lifecycleStatus: settlementLifecycle,
  });
}
