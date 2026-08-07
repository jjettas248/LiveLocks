// ── LiveLocks MLB Live Edge safety-core — Stage B: All-Lane Prediction Ledger ──
// A NEW, PRIVATE, append-only research contract that records EVERY MLB Live
// Edge prediction the finalizer produces — official, watch, AND shadow — at the
// moment it is emitted, exactly as the model saw it, and later grades each one
// against the real final outcome. Its sole purpose is to build the honest
// predicted-probability-vs-actual-outcome dataset the Stage C offline
// calibrator needs. Nothing is promoted; nothing is surfaced.
//
// Why a NEW contract (not persisted_plays, not CanonicalSignal, not
// MlbRecommendationEpisode):
//   * persisted_plays / ROI / public W-L are OFFICIAL-only, mutable, upsert-in-
//     place, cross-sport. Stage B must capture watch/shadow too, immutably, and
//     must never touch those tables.
//   * MlbRecommendationEpisode (shared/mlbRecommendationEpisode.ts) is
//     `isOfficial: true` by construction — it is the official product ledger.
//     Stage B is deliberately broader (all lanes) and lower-stakes (research).
//   * CanonicalSignal is live-only display transport.
//
// HARD CONTRACT (do not violate — the isolation IS the feature):
//   1. WRITE-ONLY to the Stage B ledger store. A prediction row MUST NEVER be
//      written to persisted_plays, ROI, W/L, the shadow-qualification store, or
//      any public/official surface.
//   2. This contract is DOWNSTREAM of the engine. It MUST NEVER be imported as
//      an INPUT to probability/edge/lane/tier computation. Capturing a value
//      here can never change what the engine emitted (measurement, not feedback
//      — mirrors CLAUDE.md "Engine probability remains independent").
//   3. `signalScore` is captured for RESEARCH ONLY and carries NO authority — it
//      never ranks, qualifies, promotes, or tiers a prediction (Stage A already
//      stripped that authority; the ledger merely records it as a feature).
//   4. Fields in MLB_LANE_PREDICTION_FROZEN_FIELDS are frozen at capture and can
//      never change; only MLB_LANE_PREDICTION_MUTABLE_FIELDS (the small
//      settlement surface) may be written, and only via
//      applyMlbLanePredictionLifecycleEvent.
//   5. Settlement is SINGLE-WRITE and graded against the EXACT frozen side/line
//      captured at emission. A settled/void/expired row is terminal.
//
// Pure, no I/O. Shared client/server so both the capture builder and any admin
// read surface speak one shape.

export type MlbLedgerSport = "MLB";

// The three production lanes Stage A's mlbProductionLane.ts resolves. Stage B
// captures ALL of them — the whole point is to compare calibration across lanes
// (does an official `hits` prediction calibrate better than a shadow
// `total_bases` one?).
export const MLB_PREDICTION_LANES = ["official", "watch", "shadow"] as const;
export type MlbPredictionLane = (typeof MLB_PREDICTION_LANES)[number];

export type MlbLedgerSide = "OVER" | "UNDER";

// raw_provisional = uncalibrated engine probability; outcome_calibrated = a real
// Stage-C calibrator produced it. Mirrors mlbProductionLane.ProbabilitySemantics
// so the ledger and the lane speak the same vocabulary.
export const MLB_LEDGER_PROBABILITY_SEMANTICS = ["raw_provisional", "outcome_calibrated"] as const;
export type MlbLedgerProbabilitySemantics = (typeof MLB_LEDGER_PROBABILITY_SEMANTICS)[number];

export const MLB_LEDGER_STATUSES = ["captured", "settled", "void", "expired"] as const;
export type MlbLedgerStatus = (typeof MLB_LEDGER_STATUSES)[number];

// cashed/missed/push are the real graded outcomes; void = the prediction could
// not be graded through no fault of the model (postponed game, player DNP,
// market zeroed) and is excluded from calibration denominators, exactly like a
// pushed bet is excluded from a hit rate.
export const MLB_LEDGER_SETTLEMENT_RESULTS = ["cashed", "missed", "push", "void"] as const;
export type MlbLedgerSettlementResult = (typeof MLB_LEDGER_SETTLEMENT_RESULTS)[number];

// Why a row could not (yet) be graded, or why it voided. Closed union so a new
// reason must be declared here, never invented at a call site.
export const MLB_LEDGER_VOID_REASONS = [
  "game_postponed",
  "game_suspended",
  "player_did_not_appear",
  "market_voided",
  "line_unresolvable",
] as const;
export type MlbLedgerVoidReason = (typeof MLB_LEDGER_VOID_REASONS)[number];

export const MLB_PREDICTION_LEDGER_CONTRACT_VERSION = "mlb_prediction_ledger_v1";

export interface MlbLanePrediction {
  // ── Identity — frozen ───────────────────────────────────────────────────
  // Unique per CAPTURE (the ledger is append-only; the same logical signal can
  // be captured many times across a game as its inputs evolve). `signalId` is
  // the stable canonical grouping key (${sport}:${gameId}:${actorId}:${market}:${side}).
  predictionId: string;
  signalId: string;
  sport: MlbLedgerSport;
  gameId: string;
  playerId: string;
  playerName: string;
  market: string;
  side: MlbLedgerSide;
  lane: MlbPredictionLane;

  // ── Captured market state — frozen ──────────────────────────────────────
  line: number;
  // Both sides captured so a no-vig probability can be reconstructed offline
  // without re-fetching odds. The recommended side's price is `sideOdds`.
  overOdds: number | null;
  underOdds: number | null;
  sideOdds: number | null;
  sportsbook: string | null;
  oddsFetchedAt: string | null; // ISO 8601 — the provider's REAL source timestamp
  oddsAgeMs: number | null;
  capturedAt: string;           // ISO 8601 — when this row was emitted
  inning: number | null;
  gamePhase: string | null;     // "pregame" | "1st" | ... | "extra"; null if unknown
  // The live stat value at capture time (context only — grading uses the FINAL
  // stat, never this). Distinct from `finalStat` below.
  statAtCapture: number | null;

  // ── Model output — frozen (this is the prediction being measured) ────────
  // 0..100 percentage-point probability of the outcome named by `side`. Kept in
  // the engine's native 0..100 scale; the calibrator converts to 0..1 itself.
  candidateProbabilityPct: number;
  // Calibrated probability (0..100) or null when no compatible calibrator exists.
  // NEVER an identity copy of candidate — null means uncalibrated (Stage A rule).
  calibratedProbabilityPct: number | null;
  probabilitySemantics: MlbLedgerProbabilitySemantics;
  // Canonical Stage-A no-vig model edge in percentage points (candidate-side
  // prob − no-vig book prob), or null when no-vig was unavailable.
  modelEdgePctPoints: number | null;
  noVigBookProbability: number | null;
  edgeVersion: string | null;
  finalizedTier: string | null;
  modelMethod: string | null;
  dataQuality: string | null;
  baseEligible: boolean | null;
  // Diagnostic-only research feature. NO authority (see hard rule 3).
  signalScore: number | null;
  // The lane's actionability reasons at capture (why official/watch/shadow).
  laneReasons: string[];

  // ── Provenance / versions — frozen ──────────────────────────────────────
  finalizerVersion: string | null;
  laneVersion: string | null;
  goldmasterVersion: string | null;
  contractVersion: string;

  // ── Settlement — MUTABLE, ONLY via applyMlbLanePredictionLifecycleEvent ──
  status: MlbLedgerStatus;
  settlementResult: MlbLedgerSettlementResult | null;
  finalStat: number | null;       // the real final outcome value used to grade
  settledAt: string | null;       // ISO 8601
  voidReason: MlbLedgerVoidReason | null;
}

export const MLB_LANE_PREDICTION_MUTABLE_FIELDS = [
  "status", "settlementResult", "finalStat", "settledAt", "voidReason",
] as const satisfies readonly (keyof MlbLanePrediction)[];
export type MlbLanePredictionMutableField = (typeof MLB_LANE_PREDICTION_MUTABLE_FIELDS)[number];

const MUTABLE_FIELD_SET: ReadonlySet<string> = new Set(MLB_LANE_PREDICTION_MUTABLE_FIELDS);

// Positive frozen list (not "everything not mutable") so a newly-added field
// defaults to FROZEN unless explicitly opted into the mutable set — fail safe,
// same discipline as MlbRecommendationEpisode.
export const MLB_LANE_PREDICTION_FROZEN_FIELDS = [
  "predictionId", "signalId", "sport", "gameId", "playerId", "playerName", "market",
  "side", "lane", "line", "overOdds", "underOdds", "sideOdds", "sportsbook",
  "oddsFetchedAt", "oddsAgeMs", "capturedAt", "inning", "gamePhase", "statAtCapture",
  "candidateProbabilityPct", "calibratedProbabilityPct", "probabilitySemantics",
  "modelEdgePctPoints", "noVigBookProbability", "edgeVersion", "finalizedTier",
  "modelMethod", "dataQuality", "baseEligible", "signalScore", "laneReasons",
  "finalizerVersion", "laneVersion", "goldmasterVersion", "contractVersion",
] as const satisfies readonly (keyof MlbLanePrediction)[];
export type MlbLanePredictionFrozenField = (typeof MLB_LANE_PREDICTION_FROZEN_FIELDS)[number];

export const MLB_LANE_PREDICTION_STATUS_TRANSITIONS: Record<MlbLedgerStatus, MlbLedgerStatus[]> = {
  captured: ["settled", "void", "expired"],
  settled: [],
  void: [],
  expired: [],
};

export function isTerminalMlbLedgerStatus(status: MlbLedgerStatus): boolean {
  return status === "settled" || status === "void" || status === "expired";
}

export class MlbLanePredictionMutationError extends Error {
  constructor(public readonly attemptedFields: string[]) {
    super(
      `Attempted to mutate frozen MlbLanePrediction field(s): ${attemptedFields.join(", ")}. ` +
      `Only ${MLB_LANE_PREDICTION_MUTABLE_FIELDS.join(", ")} may change after capture.`,
    );
    this.name = "MlbLanePredictionMutationError";
  }
}

export class MlbLanePredictionTransitionError extends Error {
  constructor(public readonly from: MlbLedgerStatus, public readonly to: MlbLedgerStatus) {
    super(`Invalid MlbLanePrediction status transition: ${from} -> ${to}`);
    this.name = "MlbLanePredictionTransitionError";
  }
}

export class MlbLanePredictionTerminalError extends Error {
  constructor(public readonly status: MlbLedgerStatus) {
    super(`MlbLanePrediction is terminal (status="${status}") and cannot receive further lifecycle events.`);
    this.name = "MlbLanePredictionTerminalError";
  }
}

/**
 * The sole mutator for a captured prediction. Returns a NEW object; never
 * mutates `prediction` in place. Throws:
 *   - MlbLanePredictionMutationError if `patch` touches any frozen field
 *   - MlbLanePredictionTerminalError if the row is already terminal
 *   - MlbLanePredictionTransitionError if `patch.status` is an illegal transition
 */
export function applyMlbLanePredictionLifecycleEvent(
  prediction: MlbLanePrediction,
  patch: Partial<Pick<MlbLanePrediction, MlbLanePredictionMutableField>>,
): MlbLanePrediction {
  const attemptedFrozen = Object.keys(patch).filter((key) => !MUTABLE_FIELD_SET.has(key));
  if (attemptedFrozen.length > 0) {
    throw new MlbLanePredictionMutationError(attemptedFrozen);
  }
  if (isTerminalMlbLedgerStatus(prediction.status)) {
    throw new MlbLanePredictionTerminalError(prediction.status);
  }
  if (patch.status && patch.status !== prediction.status) {
    const allowed = MLB_LANE_PREDICTION_STATUS_TRANSITIONS[prediction.status];
    if (!allowed.includes(patch.status)) {
      throw new MlbLanePredictionTransitionError(prediction.status, patch.status);
    }
  }
  return { ...prediction, ...patch };
}

/**
 * Pure outcome grader. Grades a frozen side/line against a resolved final stat.
 *   OVER : cashed if final > line, push if final === line, missed if final < line
 *   UNDER: cashed if final < line, push if final === line, missed if final > line
 * A push happens only on an integer line whose final stat lands exactly on it.
 * Throws on a non-finite input rather than guessing — callers resolve the final
 * stat first and void when it is unknown.
 */
export function gradeMlbLanePredictionOutcome(
  side: MlbLedgerSide,
  line: number,
  finalStat: number,
): Exclude<MlbLedgerSettlementResult, "void"> {
  if (!Number.isFinite(line) || !Number.isFinite(finalStat)) {
    throw new RangeError(`gradeMlbLanePredictionOutcome requires finite line/finalStat (line=${line}, finalStat=${finalStat})`);
  }
  if (finalStat === line) return "push";
  const over = finalStat > line;
  if (side === "OVER") return over ? "cashed" : "missed";
  return over ? "missed" : "cashed";
}

/**
 * Settles a captured prediction against its OWN frozen side/line and the real
 * final stat — single-write, terminal-safe. There is no other input that could
 * disagree with what the model emitted. Rejects settling a terminal row (via
 * applyMlbLanePredictionLifecycleEvent).
 */
export function settleMlbLanePrediction(
  prediction: MlbLanePrediction,
  finalStat: number,
  settledAt: string,
): MlbLanePrediction {
  const result = gradeMlbLanePredictionOutcome(prediction.side, prediction.line, finalStat);
  return applyMlbLanePredictionLifecycleEvent(prediction, {
    status: "settled",
    settlementResult: result,
    finalStat,
    settledAt,
    voidReason: null,
  });
}

/**
 * Voids a captured prediction that cannot be graded through no fault of the
 * model (postponed/suspended game, player DNP, market voided/unresolvable).
 * Single-write, terminal-safe. Voided rows are excluded from calibration
 * denominators (like a push is excluded from a hit rate).
 */
export function voidMlbLanePrediction(
  prediction: MlbLanePrediction,
  voidReason: MlbLedgerVoidReason,
  settledAt: string,
): MlbLanePrediction {
  return applyMlbLanePredictionLifecycleEvent(prediction, {
    status: "void",
    settlementResult: "void",
    voidReason,
    settledAt,
  });
}
