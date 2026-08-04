// ── LiveLocks Phase 1, Batch B — CanonicalSignal Contract ─────────────
// The single transport object every post-normalization consumer reads.
// UI, alerts, analytics, and (in Batch C) LiveSignalBus all read this.
//
// Hard rules locked by user spec:
//   1. lifecycleState ⊥ signalTier — neither is inferred from the other.
//   2. After SignalBus registration, the immutable fields below MUST NOT
//      be mutated. The mutation guard validates this.
//   3. Lifecycle engine may only mutate: lifecycleState, lifecycleHistory,
//      surfacedAt, updatedAt, expiresAt, gradingLink, suppressionReason,
//      expirationReason. NEVER probability/edge/projection/drivers.

import type { SignalDriver } from "./signalDrivers";

// ── Vocabularies ──────────────────────────────────────────────────────
// `nfl` is a CONTRACT-ONLY member (PR2, migration plan C3). It exists so the
// type system can carry NFL through shared contracts; NFL is NOT operational —
// there is no NFL ingestion, provider adapter, projection/calibration/signal
// logic, entitlement, or route yet (later PRs). No tier grants NFL access, and
// every existing MLB/NBA/NCAAB behavior is preserved exactly.
export type Sport = "mlb" | "nba" | "ncaab" | "nfl";

export type LifecycleState =
  | "watch"   // surfaced but not yet bettable; building evidence
  | "build"   // gaining traction, evidence strengthening
  | "strong"  // bettable, high-confidence
  | "elite"   // top-tier, highest-confidence
  | "cashed"  // graded a winner (terminal)
  | "missed"  // graded a loser (terminal)
  | "expired" // surfaced but never resolved before window closed (terminal)
  ;

export type LifecycleEventKind =
  | "created"
  | "upgraded"
  | "downgraded"
  | "cashed"
  | "missed"
  | "expired"
  | "suppressed";

export interface LifecycleHistoryEntry {
  at: number;                // unix ms
  from: LifecycleState | null;
  to: LifecycleState;
  event: LifecycleEventKind;
  reason?: string;           // human-readable
  by?: string;               // "engine" | "grader" | "ttl-sweeper" | "admin"
}

// ── Canonical Signal ──────────────────────────────────────────────────
export interface CanonicalSignal {
  // Identity ---------------------------------------------------------
  signalId: string;          // stable: `${sport}:${gameId}:${actorKey}:${market}:${side}`
  sport: Sport;
  gameId: string;
  actorId: string;           // playerId or teamId
  actorName: string;
  market: string;
  side: "OVER" | "UNDER";

  // Engine math (IMMUTABLE post-bus) --------------------------------
  displayProbability: number;       // 0..100
  overProbability: number | null;
  underProbability: number | null;
  edge: number | null;
  projection: number | null;
  bookLine: number | null;

  // Tiering — orthogonal to lifecycle (IMMUTABLE post-bus) ----------
  signalTier: "watch" | "lean" | "strong" | "elite";
  signalScore: number;

  // Executability (IMMUTABLE post-bus) ------------------------------
  // Whether the signal is a live, priceable wager RIGHT NOW. Distinct from
  // signalTier (raw conviction) and lifecycleState (progression). Optional on
  // the shared cross-sport contract so NBA/NCAAB builders/fixtures need not
  // change; MLB always stamps it explicitly (toCanonicalFromMlb). Consumers
  // (UI, alerts, analytics) MUST test `isBettable === true` so a missing/legacy
  // value fails safe (treated as not-bettable).
  isBettable?: boolean;

  // Explainability (IMMUTABLE post-bus) -----------------------------
  drivers: SignalDriver[];
  triggerSummary: string | null;

  // Lifecycle (MUTABLE by lifecycle engine ONLY) --------------------
  lifecycleState: LifecycleState;
  lifecycleHistory: LifecycleHistoryEntry[];
  // Freshness — managed by SignalBus (Batch C). engineGeneratedAt is the
  // engine's authoritative cycle timestamp; surfacedAt is when the bus
  // first registered the signal; updatedAt is the bus's last observation;
  // expiresAt is when the bus will sweep this signal stale.
  engineGeneratedAt: number;
  surfacedAt: number;
  updatedAt: number;
  expiresAt: number | null;
  suppressionReason?: string | null;
  expirationReason?: string | null;

  // Cross-system linkage --------------------------------------------
  gradingLink?: {
    persistedPlayId?: string | null;
    gradedAt?: number | null;
    outcome?: "win" | "loss" | "push" | "void" | null;
  };

  // Source pointer — opaque pointer back to the sport-specific object
  // for debugging / admin replay. Consumers MUST NOT read into this for
  // any user-facing rendering decision.
  sourceRef?: {
    kind: "mlbSignal" | "hrRadar" | "nbaSignal";
    pointer: string;         // e.g. mlbEdgeCache key + array index
  };
}

// Set of fields the mutation guard must protect post-bus.
export const IMMUTABLE_FIELDS: ReadonlyArray<keyof CanonicalSignal> = [
  "signalId",
  "sport",
  "gameId",
  "actorId",
  "market",
  "side",
  "displayProbability",
  "overProbability",
  "underProbability",
  "edge",
  "projection",
  "bookLine",
  "signalTier",
  "signalScore",
  "isBettable",
  "drivers",
  "triggerSummary",
];

// Allowed transitions. Keys are FROM states; values are valid TO states.
// Terminal states (cashed/missed/expired) have no outgoing edges.
//
// HR Radar Settlement Repair — Bug #2: `cashed` is reachable from EVERY
// non-terminal state. A HR is terminal evidence — it can land while a
// presence-floor card is still in `watch` or while a partial-cred batter
// sits in `build`. Previously `watch → cashed` was rejected as invalid,
// silently dropping bus.cashSignal calls (see [LL_LIFECYCLE_INVALID_TRANSITION]
// in production logs) and stranding the card in its live tier.
export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  watch:   ["build", "strong", "elite", "cashed", "missed", "expired"],
  build:   ["strong", "elite", "watch", "cashed", "missed", "expired"],
  strong:  ["elite", "build", "cashed", "missed", "expired"],
  elite:   ["strong", "cashed", "missed", "expired"],
  cashed:  [],
  missed:  [],
  expired: [],
};

export function isTerminalLifecycle(s: LifecycleState): boolean {
  return s === "cashed" || s === "missed" || s === "expired";
}
