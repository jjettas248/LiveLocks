// HR Radar — the additive, versioned consumer decision contract.
//
// Single authoritative shape for "what should Quick Decide / Full Ladder show
// and let the user do right now." The server builds this once
// (server/mlb/hrRadarDecisionView.ts) from the canonical ladder; both client
// views read it verbatim for classification, actions, and every displayed
// count — neither view (nor any future client) re-derives stage, action
// eligibility, or a count from raw ladder sections. `entries` is the single
// copy of each row's consumer fields; `groups` hold only `entryId`
// references into `entries` — never a second full-object copy.
//
// Pure types + a Zod schema for the contract fields + a tiny empty-view
// builder. No I/O, no engine math.
//
// The Zod schema below validates the DECISION-VIEW CONTRACT (version,
// status, groups, counts, and every per-entry field except `source`) so the
// server and client can never silently drift on required/nullable fields or
// the allowed `liveStage`/`resultType`/`status` values. `source` (the
// embedded full ladder row) is intentionally left as `z.unknown()` —
// `HrRadarLadderEntry` is a ~130-field interface defined server-side only
// (server/storage.ts) with no existing shared Zod schema of its own; giving
// it one is a larger, unrelated refactor, and a real Zod object schema for
// it would just be `z.any()` in practice. The contract fields here are what
// must never drift; `source` stays passthrough.

import { z } from "zod";

export const HR_RADAR_DECISION_VIEW_VERSION = "hr-radar-decision-v1" as const;

/** Live (not yet resolved) canonical stage. `null` once a row is resolved. */
export type HrRadarLiveStage = "fire" | "ready" | "build" | "watch" | null;

/**
 * Resolved-row result classification. Deliberately only two consumer-facing
 * buckets — `signal_hit` (HR after an official Fire call) and
 * `official_miss` (an official Fire call that resolved without an HR).
 * Everything else resolved (uncalled HR, early-window HR, late signal,
 * insufficient-sample, non-Fire-tier cashes) is `model_review` — admin-only,
 * and structurally CANNOT leak into the two public buckets through an
 * incomplete "else it's a miss" branch, because there is no such branch.
 */
export type HrRadarResultType = "signal_hit" | "official_miss" | "model_review" | null;

export type HrRadarConsumerAction = "take_now" | "watch_next_ab" | "none";

/**
 * One row's consumer contract. `TSource` is the embedded full ladder row
 * (server/storage.ts's `HrRadarLadderEntry` on the server; the client's own
 * mirrored type on the client) — kept generic here so this module stays
 * free of a dependency on that ~130-field interface.
 */
export interface HrRadarConsumerEntry<TSource = unknown> {
  /** `${gameId}:${playerId}` — stable identity, one entry per player+game. */
  entryId: string;
  /** The full embedded ladder row — presentation detail lives here. */
  source: TSource;
  liveStage: HrRadarLiveStage;
  resultType: HrRadarResultType;
  consumerAction: HrRadarConsumerAction;
  isResolved: boolean;
  /** Frozen-history proof this row reached Fire before resolving (or, for a
   *  live row, that it IS at Fire right now). Never guessed from a coarser
   *  signal when the evidence is ambiguous — see the server builder. */
  hasFireCommitment: boolean;
  /** True only when `liveStage === "fire"` AND the row carries valid
   *  player+game identity for the bet-slip payload. */
  canAddToSlip: boolean;
  /** True only when `liveStage === "ready"`. */
  canWatchNextAb: boolean;
  /** What the engine is waiting on to promote this row, or null (Fire /
   *  resolved rows have nothing left to promote toward). */
  promotionRequirement: string | null;
}

export interface HrRadarDecisionViewGroups {
  /** Fire only. */
  takeNow: string[];
  /** Ready only. */
  watchNextAb: string[];
  build: string[];
  watch: string[];
  /** Live game, no plate appearance tracked yet. */
  waitingForFirstAb: string[];
  /** Fire-tier cashes only. */
  signalHits: string[];
  /** Fire-tier no-HR resolutions only. */
  officialMisses: string[];
  /** Admin-only diagnostic bucket: uncalled HR, early-window HR, late
   *  signal, non-Fire-tier cashes/misses — never surfaced as a consumer
   *  Signal Hit or Missed result. */
  modelReview: string[];
}

export interface HrRadarDecisionViewCounts {
  takeNow: number;
  watchNextAb: number;
  build: number;
  watch: number;
  /** `= build + watch`. */
  forming: number;
  waitingForFirstAb: number;
  /** `= takeNow + watchNextAb + build + watch`, deduped, final-game excluded. */
  liveTracked: number;
  fireHitsToday: number;
  fireMissesToday: number;
  modelReview: number;
}

export interface HrRadarDecisionView<TSource = unknown> {
  version: typeof HR_RADAR_DECISION_VIEW_VERSION;
  /** "ok" = genuinely evaluated (an empty view means genuinely nothing is
   *  live). "degraded" = the server could not build a fresh view right now
   *  — the client must NOT render a degraded empty view as "0 activity". */
  status: "ok" | "degraded";
  errorCode?: string;
  sessionDate: string;
  /** ISO timestamp, or null when `status === "degraded"`. */
  generatedAt: string | null;
  entries: Record<string, HrRadarConsumerEntry<TSource>>;
  groups: HrRadarDecisionViewGroups;
  counts: HrRadarDecisionViewCounts;
}

// ── Zod schema for the contract fields (excludes `source`, see header). ─────

export const hrRadarLiveStageSchema = z.enum(["fire", "ready", "build", "watch"]).nullable();
export const hrRadarResultTypeSchema = z.enum(["signal_hit", "official_miss", "model_review"]).nullable();
export const hrRadarConsumerActionSchema = z.enum(["take_now", "watch_next_ab", "none"]);

export const hrRadarConsumerEntryContractSchema = z.object({
  entryId: z.string().min(1),
  liveStage: hrRadarLiveStageSchema,
  resultType: hrRadarResultTypeSchema,
  consumerAction: hrRadarConsumerActionSchema,
  isResolved: z.boolean(),
  hasFireCommitment: z.boolean(),
  canAddToSlip: z.boolean(),
  canWatchNextAb: z.boolean(),
  promotionRequirement: z.string().nullable(),
});

export const hrRadarDecisionViewGroupsSchema = z.object({
  takeNow: z.array(z.string()),
  watchNextAb: z.array(z.string()),
  build: z.array(z.string()),
  watch: z.array(z.string()),
  waitingForFirstAb: z.array(z.string()),
  signalHits: z.array(z.string()),
  officialMisses: z.array(z.string()),
  modelReview: z.array(z.string()),
});

export const hrRadarDecisionViewCountsSchema = z.object({
  takeNow: z.number().int().nonnegative(),
  watchNextAb: z.number().int().nonnegative(),
  build: z.number().int().nonnegative(),
  watch: z.number().int().nonnegative(),
  forming: z.number().int().nonnegative(),
  waitingForFirstAb: z.number().int().nonnegative(),
  liveTracked: z.number().int().nonnegative(),
  fireHitsToday: z.number().int().nonnegative(),
  fireMissesToday: z.number().int().nonnegative(),
  modelReview: z.number().int().nonnegative(),
});

export const hrRadarDecisionViewSchema = z.object({
  version: z.literal(HR_RADAR_DECISION_VIEW_VERSION),
  status: z.enum(["ok", "degraded"]),
  errorCode: z.string().optional(),
  sessionDate: z.string(),
  generatedAt: z.string().nullable(),
  entries: z.record(z.string(), hrRadarConsumerEntryContractSchema.extend({ source: z.unknown() })),
  groups: hrRadarDecisionViewGroupsSchema,
  counts: hrRadarDecisionViewCountsSchema,
});

export function emptyHrRadarDecisionViewGroups(): HrRadarDecisionViewGroups {
  return {
    takeNow: [],
    watchNextAb: [],
    build: [],
    watch: [],
    waitingForFirstAb: [],
    signalHits: [],
    officialMisses: [],
    modelReview: [],
  };
}

export function emptyHrRadarDecisionViewCounts(): HrRadarDecisionViewCounts {
  return {
    takeNow: 0,
    watchNextAb: 0,
    build: 0,
    watch: 0,
    forming: 0,
    waitingForFirstAb: 0,
    liveTracked: 0,
    fireHitsToday: 0,
    fireMissesToday: 0,
    modelReview: 0,
  };
}

/**
 * Build a `status: "degraded"` shell — used when the server failed to build
 * a fresh decision view. Every array/count is empty, but `status` tells the
 * client this is "we don't know right now", not "genuinely nothing live".
 */
export function degradedHrRadarDecisionView(sessionDate: string, errorCode: string): HrRadarDecisionView<never> {
  return {
    version: HR_RADAR_DECISION_VIEW_VERSION,
    status: "degraded",
    errorCode,
    sessionDate,
    generatedAt: null,
    entries: {},
    groups: emptyHrRadarDecisionViewGroups(),
    counts: emptyHrRadarDecisionViewCounts(),
  };
}
