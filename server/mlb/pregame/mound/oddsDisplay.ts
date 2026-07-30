// Mound Radar — best-odds display helpers.
//
// PURELY presentation-layer math: turns a raw getMLBPlayerOdds() result into
// a MoundMarketEdgeContext for the card UI. Never fetches odds itself, never
// mutates score10/tier/drivers. Duplicated locally (not imported from
// pregamePowerRadar/oddsDisplay.ts) per this module's isolation convention —
// no shared logic with the Plate board.
//
// PRICE-PURITY BOUNDARY (Mound V2 purity pass): pickBestOverBook/
// buildMoundMarketEdgeContext below select a book by its PRICE — that is
// legitimate ONLY for V1's own display purposes (the card UI, K Line Value —
// see kLineValue.ts's own "display-only, weight 0 on score10" header) where
// "show the user the best price available" is the actual point. It must
// NEVER be used to choose which LINE a probability model evaluates against:
// if two books post different lines, letting the best OVER PRICE decide
// which book's line gets used means a pure price movement (no baseball
// change at all) can silently swap in a different line, which changes
// line-conditioned probabilities, recommended side, and qualification — an
// indirect price-contamination path even though no price value is ever fed
// into the math itself. selectCanonicalMoundV2Line below is the
// price-independent alternative Mound V2's model evaluation uses instead —
// see moundV2LineSelection.test.ts for the price-invariance proof.

import type { MoundMarketEdgeContext } from "./types";

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

/**
 * Chooses the line Mound V2's model evaluates against — the MODE (most
 * commonly posted) line across every book offering this market, tie-broken
 * by the strictly LOWEST numeric line value. Uses ONLY each book's posted
 * `line` field — never `overOdds`/`underOdds` or anything price-derived —
 * so which sportsbook currently has the juiciest price can never determine
 * which line gets modeled. Deterministic regardless of object key iteration
 * order (the tie-break compares line VALUES, not encounter order).
 *
 * Returns null when there is no book with a finite posted line at all.
 */
export function selectCanonicalMoundV2Line(
  books: Record<string, RawBookLine> | null | undefined,
): MoundV2CanonicalLineSelection | null {
  if (!books) return null;
  const byLine = new Map<number, string[]>();
  for (const [book, snap] of Object.entries(books)) {
    if (book.startsWith("_")) continue;
    if (snap.line == null || !isFinite(snap.line)) continue;
    const arr = byLine.get(snap.line);
    if (arr) arr.push(book); else byLine.set(snap.line, [book]);
  }
  if (byLine.size === 0) return null;

  let bestLine: number | null = null;
  let bestCount = -1;
  for (const [line, bookList] of Array.from(byLine.entries())) {
    const isMoreBooks = bookList.length > bestCount;
    const isTiedButLower = bookList.length === bestCount && (bestLine == null || line < bestLine);
    if (isMoreBooks || isTiedButLower) {
      bestLine = line;
      bestCount = bookList.length;
    }
  }
  return { line: bestLine as number, booksAtLine: (byLine.get(bestLine as number) as string[]).slice().sort() };
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
