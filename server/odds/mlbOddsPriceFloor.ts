// ── MLB Live Edge — active-polling price floor ────────────────────────────────
// Pure, I/O-free. Decides whether a market/side is worth spending Odds API
// quota to keep refreshed.
//
// The rule is SIDE-SPECIFIC. We are not asking "does either side of this
// market have odds of -200 or better?" — we are asking "is the side LiveLocks
// is actually evaluating available at -200 or better?".
//
//   OVER:  DK -225 | FD -210 | HRB -215
//   UNDER: FD +175
//   evaluated side = OVER  ->  best OVER price is -210  ->  NOT pollable.
//
// The +175 on the opposite side must never rescue the OVER. A market we would
// never recommend at that price does not deserve routine provider spend.
//
// Approved books are DraftKings / FanDuel / Hard Rock Bet only, sourced from
// the canonical getPreferredBooks("mlb") list rather than a duplicate constant.

import { getPreferredBooks } from "./oddsConfig";

/** American odds floor for routine active refresh. -200 is eligible, -201 is not. */
export const MLB_ACTIVE_POLL_PRICE_FLOOR = -200;

export type EvaluatedSide = "OVER" | "UNDER";

export interface ApprovedBookPrice {
  book: string;
  line: number;
  overOdds: number | null;
  underOdds: number | null;
}

export type PriceFloorReason =
  | "eligible"
  | "below_floor"
  | "discovery";

export interface PriceFloorVerdict {
  eligible: boolean;
  /** Best approved-book American price ON THE EVALUATED SIDE. Null = unseen. */
  bestPrice: number | null;
  reason: PriceFloorReason;
  side: EvaluatedSide;
}

/** True when this book is one of the three approved MLB Live Edge books. */
export function isApprovedBook(bookKey: string): boolean {
  return getPreferredBooks("mlb").includes(bookKey);
}

/**
 * Best (highest / least negative) American price across approved books for the
 * evaluated side only.
 *
 *   OVER  -> max(DK.overOdds,  FD.overOdds,  HRB.overOdds)
 *   UNDER -> max(DK.underOdds, FD.underOdds, HRB.underOdds)
 *
 * Returns null when no approved book quotes that side (unseen pricing).
 */
export function bestApprovedPriceForSide(
  books: readonly ApprovedBookPrice[] | null | undefined,
  side: EvaluatedSide,
): number | null {
  if (!books || books.length === 0) return null;
  let best: number | null = null;
  for (const b of books) {
    if (!isApprovedBook(b.book)) continue;
    const price = side === "OVER" ? b.overOdds : b.underOdds;
    if (price === null || price === undefined || !Number.isFinite(price)) continue;
    if (best === null || price > best) best = price;
  }
  return best;
}

/**
 * Is this market/side eligible for routine active sportsbook refresh?
 *
 * Unknown pricing (null) is eligible — a market we have never priced gets one
 * discovery request so the system is never starved into permanent blindness.
 * That is the ONLY case where an unpriced market spends quota.
 */
export function isPriceEligible(bestPriceForSide: number | null): boolean {
  if (bestPriceForSide === null) return true;
  return bestPriceForSide >= MLB_ACTIVE_POLL_PRICE_FLOOR;
}

/** Full verdict, including why. */
export function evaluatePriceFloor(
  books: readonly ApprovedBookPrice[] | null | undefined,
  side: EvaluatedSide,
): PriceFloorVerdict {
  const bestPrice = bestApprovedPriceForSide(books, side);
  if (bestPrice === null) {
    return { eligible: true, bestPrice: null, reason: "discovery", side };
  }
  return {
    eligible: bestPrice >= MLB_ACTIVE_POLL_PRICE_FLOOR,
    bestPrice,
    reason: bestPrice >= MLB_ACTIVE_POLL_PRICE_FLOOR ? "eligible" : "below_floor",
    side,
  };
}

// ── Evaluated-side memory ────────────────────────────────────────────────────
// The floor is side-specific, so it needs to know which side the engine is
// actually evaluating for a given (eventId, market, player). The orchestrator
// stamps that at the end of each engine cycle; before any signal exists we
// default to OVER, which is the side every batter market and HR Radar row is
// evaluated on. Pitcher UNDER markets get their real side as soon as the first
// cycle produces a signal for them.
//
// Bounded: entries expire, and the map is swept when it grows past a cap.

interface SideMemoryEntry {
  side: EvaluatedSide;
  ts: number;
}

const evaluatedSides = new Map<string, SideMemoryEntry>();
const SIDE_MEMORY_TTL_MS = 6 * 60 * 60 * 1000; // one game
const SIDE_MEMORY_MAX = 5000;

function sideKey(eventId: string, market: string, playerName: string): string {
  return `${eventId}|${market}|${playerName.toLowerCase().trim()}`;
}

export function recordEvaluatedSide(
  eventId: string,
  market: string,
  playerName: string,
  side: EvaluatedSide,
): void {
  if (evaluatedSides.size > SIDE_MEMORY_MAX) {
    const cutoff = Date.now() - SIDE_MEMORY_TTL_MS;
    for (const [k, v] of Array.from(evaluatedSides.entries())) {
      if (v.ts < cutoff) evaluatedSides.delete(k);
    }
  }
  evaluatedSides.set(sideKey(eventId, market, playerName), { side, ts: Date.now() });
}

/**
 * Side the engine is evaluating for this player/market. Defaults to OVER when
 * nothing has been stamped yet — batter markets and HR Radar are always
 * evaluated OVER, so this is the correct cold-start assumption.
 */
export function getEvaluatedSide(
  eventId: string,
  market: string,
  playerName: string,
): EvaluatedSide {
  const entry = evaluatedSides.get(sideKey(eventId, market, playerName));
  if (!entry) return "OVER";
  if (Date.now() - entry.ts > SIDE_MEMORY_TTL_MS) {
    evaluatedSides.delete(sideKey(eventId, market, playerName));
    return "OVER";
  }
  return entry.side;
}

// Test/debug only — never call in prod request paths.
export function _resetPriceFloorForTests(): void {
  evaluatedSides.clear();
}
