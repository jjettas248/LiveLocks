// ── MLB Live Edge — Odds Probability Math (no-vig, strict pairing) ──────────
// The SINGLE MLB-owned module for turning sportsbook American odds into
// implied and de-vigged (no-vig) probabilities, and for computing canonical
// model edge in percentage points.
//
// Hard invariants (fail-closed):
//   1. Odds are used ONLY after the engine has finalized its true-outcome
//      probability. Nothing here ever feeds back into the engine's estimate —
//      this is a downstream, price-relative comparison layer.
//   2. A no-vig two-way probability may be computed ONLY from a matched pair:
//      SAME sportsbook, SAME game, SAME player, SAME market, EXACT same line,
//      SAME period, within a bounded fresh observation window, with BOTH sides
//      present. Never pair across books or lines. A missing/stale/one-sided
//      quote yields `null` (no-vig unavailable) → the candidate is
//      non-actionable, never rescued by a raw single-side implied.
//   3. Edge is percentage points (calibrated/candidate side prob − no-vig side
//      prob). It is NOT expected value and NOT `probability − 50`.
//
// Pure, no I/O.

import { isMLBSnapshotFresh, type MlbGameStatus } from "../oddsService";

export const MLB_EDGE_VERSION = "novig_v1" as const;

/**
 * A two-sided price quote guaranteed by construction to come from ONE
 * sportsbook at ONE exact line for ONE player/market/period. `resolveBookLine`
 * in the orchestrator already returns over/under from a single cached book
 * entry at a single line; this shape carries that provenance forward so the
 * same-book/same-line invariant is explicit and re-asserted here rather than
 * assumed.
 */
export interface PairedTwoSidedQuote {
  book: string | null;
  line: number | null;
  overOdds: number | null;
  underOdds: number | null;
  // The real provider source timestamp for this quote (ms epoch). Never a
  // fetch/engine time when a real source timestamp exists.
  sourceTimestamp: number | null;
  // Age of the observation in ms, used with game status for the freshness gate.
  ageMs: number | null;
}

export type NoVigUnavailableReason =
  | "missing_over_odds"
  | "missing_under_odds"
  | "invalid_over_odds"
  | "invalid_under_odds"
  | "missing_line"
  | "missing_book"
  | "missing_source_timestamp"
  | "stale_observation";

export interface NoVigResult {
  pOverNoVig: number; // 0..100
  pUnderNoVig: number; // 0..100
  pOverRawImplied: number; // 0..100 (single-side, vig-inflated — diagnostic only)
  pUnderRawImplied: number; // 0..100
  book: string;
  line: number;
  edgeVersion: typeof MLB_EDGE_VERSION;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Valid American odds are ≤ -100 or ≥ +100. */
export function isValidAmericanOdds(v: unknown): v is number {
  return isFiniteNumber(v) && (v <= -100 || v >= 100);
}

/** American odds → raw implied probability in 0..100 (includes vig). */
export function americanToImpliedPct(odds: number): number {
  if (odds < 0) return (-odds / (-odds + 100)) * 100;
  return (100 / (odds + 100)) * 100;
}

/**
 * De-vigs a matched two-sided quote. Returns null (with a reason) unless every
 * pairing/freshness invariant holds. `gameStatus` drives the freshness window
 * via the shared isMLBSnapshotFresh (pregame 2min / live 30s / final immutable
 * / unknown never-fresh) so this module and the odds cache can't drift apart.
 */
export function noVigTwoWay(
  quote: PairedTwoSidedQuote,
  gameStatus: MlbGameStatus,
): { ok: true; result: NoVigResult } | { ok: false; reason: NoVigUnavailableReason } {
  if (!quote.book || quote.book.trim() === "") return { ok: false, reason: "missing_book" };
  if (!isFiniteNumber(quote.line)) return { ok: false, reason: "missing_line" };
  if (quote.overOdds == null) return { ok: false, reason: "missing_over_odds" };
  if (quote.underOdds == null) return { ok: false, reason: "missing_under_odds" };
  if (!isValidAmericanOdds(quote.overOdds)) return { ok: false, reason: "invalid_over_odds" };
  if (!isValidAmericanOdds(quote.underOdds)) return { ok: false, reason: "invalid_under_odds" };
  if (quote.sourceTimestamp == null) return { ok: false, reason: "missing_source_timestamp" };
  // Both sides come from the same cached book entry (single ageMs), so one
  // freshness check covers the pair. A missing age is treated as unknown/stale.
  if (quote.ageMs == null || !isMLBSnapshotFresh(gameStatus, quote.ageMs)) {
    return { ok: false, reason: "stale_observation" };
  }

  const qOver = americanToImpliedPct(quote.overOdds);
  const qUnder = americanToImpliedPct(quote.underOdds);
  const overround = qOver + qUnder;
  if (!(overround > 0)) return { ok: false, reason: "invalid_over_odds" };

  return {
    ok: true,
    result: {
      pOverNoVig: (qOver / overround) * 100,
      pUnderNoVig: (qUnder / overround) * 100,
      pOverRawImplied: qOver,
      pUnderRawImplied: qUnder,
      book: quote.book,
      line: quote.line,
      edgeVersion: MLB_EDGE_VERSION,
    },
  };
}

/**
 * Canonical model edge in percentage points: candidate-side probability minus
 * the no-vig book probability for the SAME side. Both inputs are 0..100.
 * Returns null if either input is not finite (edge unavailable ⇒ non-actionable
 * by policy).
 */
export function modelEdgePctPoints(candidateProbPct: number | null, noVigSidePct: number | null): number | null {
  if (!isFiniteNumber(candidateProbPct) || !isFiniteNumber(noVigSidePct)) return null;
  return Math.round((candidateProbPct - noVigSidePct) * 100) / 100;
}

/** Picks the no-vig probability for the recommended side from a NoVigResult. */
export function noVigForSide(result: NoVigResult, side: "OVER" | "UNDER"): number {
  return side === "OVER" ? result.pOverNoVig : result.pUnderNoVig;
}

/** Picks the raw single-side implied (diagnostic) for the recommended side. */
export function rawImpliedForSide(result: NoVigResult, side: "OVER" | "UNDER"): number {
  return side === "OVER" ? result.pOverRawImplied : result.pUnderRawImplied;
}
