// Mound Radar — best-odds display helpers.
//
// PURELY presentation-layer math: turns a raw getMLBPlayerOdds() result into
// a MoundMarketEdgeContext for the card UI. Never fetches odds itself, never
// mutates score10/tier/drivers. Duplicated locally (not imported from
// pregamePowerRadar/oddsDisplay.ts) per this module's isolation convention —
// no shared logic with the Plate board.

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
