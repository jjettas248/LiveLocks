// Mound Radar — best-odds display helpers.
//
// PURELY presentation-layer math: turns a raw getMLBPlayerOdds() result into
// a MoundMarketEdgeContext for the card UI. Never fetches odds itself, never
// mutates score10/tier/drivers. Duplicated locally (not imported from
// pregamePowerRadar/oddsDisplay.ts) per this module's isolation convention —
// no shared logic with the Plate board.
//
// PRICE-PURITY BOUNDARY (Mound V2 purity pass; verified by exhaustive
// call-path trace in the Final Line-Provenance and V1 Purity Correction —
// see moundV1PriceInvariance.test.ts): pickBestOverBook/
// buildMoundMarketEdgeContext below select a book by its PRICE. This is
// PROVEN (not merely claimed) to never reach V1's projection, baseball
// setup grade (score10/tier), confidence, recommended side (moundDirection),
// qualification (everPubliclyFlagged/everPubliclyFlaggedFade), sorting, or
// suppression — composeMoundScore/computeMoundDirection/
// wasPubliclyFlaggedMound(Fade) structurally accept no price parameter at
// all, confirmed by direct call and by a structural source-grep proving
// scoring.ts/moundDirection.ts never reference marketEdgeContext/kLineValue/
// pickBestOverBook. K Line Value (kLineValue.ts) is genuinely display-only —
// its return value is written to the signal for the client card only, never
// persisted, never re-derived into score10/tier.
//
// ONE genuine, narrowly-scoped exception exists and is NOT fixed here (out
// of scope for a narrow correction pass that must not redesign V1's
// completed settlement/grading system): moundOutcomeAttribution.ts's
// deriveMoundMarketOutcome grades a pitcher's final stat against
// marketEdgeContext.line (frozen via evaluationSnapshot.ts's postedLine) for
// the per-card "Cashed"/"Missed" settlement badge (MoundOutcome.marketOutcome).
// Using price to choose which book's line to SETTLE against is an explicitly
// permitted category (display/executability/settlement/captured-price
// analytics) — but the specific line-selection mechanism there is still the
// price-driven pickBestOverBook, not the price-independent
// selectCanonicalMoundV2Line below. It does not affect score10/tier/
// moundDirection/qualification/sorting/suppression or the season-baseline
// win/loss record (moundCalibrationStats.ts) — confirmed by direct trace.
//
// It must NEVER be used to choose which LINE a probability model evaluates
// against: if two books post different lines, letting the best OVER PRICE
// decide which book's line gets used means a pure price movement (no
// baseball change at all) can silently swap in a different line, which
// changes line-conditioned probabilities, recommended side, and
// qualification — an indirect price-contamination path even though no price
// value is ever fed into the math itself. selectCanonicalMoundV2Line below
// is the price-independent alternative Mound V2's model evaluation uses
// instead — see moundV2LineSelection.test.ts for the no-systematic-bias
// proof (median + fixed sportsbook-priority tie-break, never lowest/highest
// numeric value).

import type { MoundMarketEdgeContext } from "./types";
import { rankBook } from "../../../odds/oddsConfig";

interface RawBookLine {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
}

export function pickBestOverBook(
  books: Record<string, RawBookLine>,
): { book: string; line: number; odds: number } | null {
  let best: { book: string; line: number; odds: number } | null = null;
  for (const [book, snap] of Object.entries(books)) {
    if (book.startsWith("_")) continue;
    if (snap.overOdds == null || !isFinite(snap.overOdds)) continue;
    if (!best || snap.overOdds > best.odds) {
      best = { book, line: snap.line, odds: snap.overOdds };
    }
  }
  return best;
}

export interface MoundV2CanonicalLineSelection {
  line: number;
  /** Every book observed offering exactly this line — sorted for determinism. Downstream executability lookup is restricted to these books; it can never reach for a book offering a DIFFERENT line just because its price is better. */
  booksAtLine: string[];
}

// PREVIOUS DESIGN (superseded — directionally biased): a "mode line,
// lowest-numeric-value tie-break" rule. That tie-break is price-independent
// (it never reads a price field) but is NOT neutral: when every book posts a
// distinct line (a 3-way tie at count=1 each, e.g. 5.5/6.5/7.5), "lowest
// wins" always selects the easiest-to-clear line, which systematically
// inflates OVER qualification rate whenever books genuinely disagree on the
// number — a real, structural directional bias, just one that happens not to
// be mediated by price. Fixed below by using the MEDIAN (a rule with no
// inherent high/low preference) and, only for the rare case where an even
// vote count has no single offered median value, a tie-break based on
// SPORTSBOOK IDENTITY (a fixed, pre-existing preference ranking with no
// relationship to whether that book's numbers run high or low) rather than
// the line's own numeric value. See moundV2LineSelection.test.ts for the
// no-systematic-bias proof.

/**
 * Chooses the line Mound V2's model evaluates against — a NEUTRAL consensus
 * rule using ONLY each book's posted `line` field, never `overOdds`/
 * `underOdds` or anything price-derived:
 *
 *   1. One vote per approved sportsbook (books is keyed by sportsbook name,
 *      so a single book can structurally never contribute more than one
 *      vote — there is no way for the same key to appear twice).
 *   2. Sort the voting books' own (line, book) pairs ascending by line,
 *      breaking line-value ties by sportsbook priority (rankBook) purely so
 *      the ORDERING itself is deterministic regardless of object-key
 *      iteration order — this does not by itself decide any line.
 *   3. An ODD vote count has a true middle element that IS a real offered
 *      line — return it directly, no tie-break of any kind needed.
 *   4. An EVEN vote count's two middle candidates may already agree (no
 *      ambiguity — use that shared value) or may genuinely disagree (no
 *      single line is "the median" — e.g. 2 books at 5.5 and 6.5, where 6.0
 *      was never offered by anyone). Only in that disagreement case, break
 *      the tie using PREFERRED_BOOKS_BY_SPORT.mlb's own fixed, pre-existing
 *      book-priority order (server/odds/oddsConfig.ts's rankBook) — take the
 *      higher-priority book's OWN line. This is an identity-based decision,
 *      never a magnitude-based one: it is not "prefer the higher/lower
 *      number", it is "prefer this specific book's number", and which book
 *      ranks higher has no relationship to whether that book's own lines run
 *      high or low, so it introduces no systematic OVER/UNDER skew.
 *
 * Returns null when there is no book with a finite posted line at all.
 */
export function selectCanonicalMoundV2Line(
  books: Record<string, RawBookLine> | null | undefined,
): MoundV2CanonicalLineSelection | null {
  if (!books) return null;
  const votes: Array<{ book: string; line: number }> = [];
  for (const [book, snap] of Object.entries(books)) {
    if (book.startsWith("_")) continue;
    if (snap.line == null || !isFinite(snap.line)) continue;
    votes.push({ book, line: snap.line });
  }
  if (votes.length === 0) return null;

  votes.sort((a, b) => a.line - b.line || rankBook("mlb", a.book) - rankBook("mlb", b.book));
  const n = votes.length;
  let medianLine: number;
  if (n % 2 === 1) {
    medianLine = votes[(n - 1) / 2].line;
  } else {
    const lower = votes[n / 2 - 1];
    const upper = votes[n / 2];
    if (lower.line === upper.line) {
      medianLine = lower.line;
    } else {
      medianLine = rankBook("mlb", lower.book) <= rankBook("mlb", upper.book) ? lower.line : upper.line;
    }
  }

  const booksAtLine = votes.filter((v) => v.line === medianLine).map((v) => v.book).sort();
  return { line: medianLine, booksAtLine };
}

export interface MoundV2ExecutablePriceAtLine {
  sportsbook: string;
  overPrice: number;
  /** Same-book paired discipline (see pairedUnderOddsForBook) — null when that specific book has no valid under price, never cross-substituted from a different book. */
  underPrice: number | null;
}

/**
 * Given a line ALREADY chosen independently of price (selectCanonicalMoundV2Line),
 * finds the best EXECUTABLE over price among ONLY the books that actually
 * posted that exact line, plus that same book's own under price. Price
 * comparison here is legitimate — it can only ever choose WHICH BOOK's price
 * is used for a line that was already fixed; it can never change which line
 * that is, because books offering a different line are excluded from
 * consideration entirely before any price is compared.
 *
 * Returns null when no book posted a valid over price at exactly this line.
 */
export function selectExecutablePriceAtLine(
  books: Record<string, RawBookLine> | null | undefined,
  line: number,
): MoundV2ExecutablePriceAtLine | null {
  if (!books) return null;
  let best: { sportsbook: string; overPrice: number } | null = null;
  for (const [book, snap] of Object.entries(books)) {
    if (book.startsWith("_")) continue;
    if (snap.line !== line) continue;
    if (snap.overOdds == null || !isFinite(snap.overOdds)) continue;
    if (!best || snap.overOdds > best.overPrice) {
      best = { sportsbook: book, overPrice: snap.overOdds };
    }
  }
  if (!best) return null;
  return { sportsbook: best.sportsbook, overPrice: best.overPrice, underPrice: pairedUnderOddsForBook(books, best.sportsbook) };
}

/**
 * Given the SAME book pickBestOverBook already chose for the OVER side,
 * returns THAT book's own UNDER price — never independently re-shopped
 * across other books.
 *
 * A prior version of this file had a pickBestUnderBook that scanned ALL
 * books for the single best UNDER price, called independently of
 * pickBestOverBook. That let the frozen market snapshot combine an OVER
 * price from one book with an UNDER price from a DIFFERENT book — or even
 * a different LINE, since books do not always post identical lines for the
 * same prop. FrozenMoundMarketQuote has exactly one line/sportsbook/
 * fetchedAt shared by both prices, so that mismatch would have silently
 * mislabeled the UNDER price's true line/book. This function makes that
 * impossible by construction: both prices always come from the exact same
 * RawBookLine entry (same book, same line, same fetch cycle).
 *
 * Returns null (never fabricated or cross-substituted from a different
 * book) when the chosen book didn't post a valid UNDER price at all.
 */
export function pairedUnderOddsForBook(
  books: Record<string, RawBookLine> | null | undefined,
  sportsbook: string | null | undefined,
): number | null {
  if (!books || !sportsbook || sportsbook.startsWith("_")) return null;
  const entry = books[sportsbook];
  if (!entry || entry.underOdds == null || !isFinite(entry.underOdds)) return null;
  return entry.underOdds;
}

export function americanToImpliedProbability(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return -odds / (-odds + 100);
}

/**
 * Build a MoundMarketEdgeContext from a raw getMLBPlayerOdds() result.
 * Returns null on any missing/malformed data — never fabricated.
 */
export function buildMoundMarketEdgeContext(
  oddsResult: Record<string, RawBookLine> | null | undefined,
  fetchedAt: number,
): MoundMarketEdgeContext | null {
  if (!oddsResult) return null;
  const best = pickBestOverBook(oddsResult);
  if (!best) return null;

  return {
    line: best.line,
    odds: best.odds,
    impliedProbability: Math.round(americanToImpliedProbability(best.odds) * 1000) / 1000,
    sportsbook: best.book,
    oddsUpdatedAt: new Date(fetchedAt).toISOString(),
  };
}
