// ── MLB Odds Refresh Coordinator ──────────────────────────────────────────────
// Decides WHEN the provider should be asked to refresh a given MLB
// event+market's raw odds. Deliberately independent from oddsScheduler.ts,
// which owns game-state polling cadence for all three sports — this module
// owns exactly one concern: turning engine-expressed market interest into
// provider refreshes, so credit spend tracks what the engine actually cares
// about instead of every market on every tick.
//
// Every entry point here is synchronous and fire-and-forget: registering
// interest (or warming an event ID) never awaits the provider and never
// blocks the caller. The engine tick reads whatever is already cached
// (see readMLBPlayerOddsFromCache in ../oddsService) and picks up any
// refresh this module kicked off on a later tick.

import { refreshMLBMarketOdds, resolveMLBOddsEventId } from "../oddsService";
import type { MlbGameStatus } from "../oddsService";

export type MlbInterestPriority = "watched" | "near_actionable";

interface MarketInterest {
  eventId: string;
  market: string;
  priority: MlbInterestPriority;
  lastRefreshedAt: number;
  registeredAt: number;
}

// Refresh cadence per priority tier. "watched" doubles as the pregame
// cadence (2 min) — matches the pregame freshness requirement exactly, so a
// market that's merely being tracked (not urgently stale) never gets
// refreshed more often than the data would actually change usefully.
// "near_actionable" matches the live freshness requirement (30s).
const REFRESH_CADENCE_MS: Record<MlbInterestPriority, number> = {
  watched: 2 * 60 * 1000,
  near_actionable: 30 * 1000,
};

const interests = new Map<string, MarketInterest>();

function interestKey(eventId: string, market: string): string {
  return `${eventId}:${market}`;
}

function derivePriority(gameStatus: MlbGameStatus, stale: boolean): MlbInterestPriority {
  // "Near-actionable" == live AND the caller's own cache read came back
  // stale (i.e. there's currently nothing fresh enough to publish as
  // bettable) — exactly the situation the 30s cadence exists for. Everything
  // else (pregame, or live-but-already-fresh) only needs upkeep cadence.
  if (gameStatus === "live" && stale) return "near_actionable";
  return "watched";
}

function queueRefresh(key: string): void {
  const interest = interests.get(key);
  if (!interest) return;
  // Stamp BEFORE the fetch resolves — collapses the many same-tick callers
  // (one per player sharing this market) down to a single queued refresh,
  // and the single-flight lock inside getMLBRawOdds covers the rest.
  interest.lastRefreshedAt = Date.now();
  refreshMLBMarketOdds(interest.eventId, interest.market).catch((err: any) => {
    console.warn(`[MLB_ODDS_REFRESH] refresh failed for ${interest.eventId}/${interest.market}: ${err?.message ?? err}`);
  });
}

export interface RegisterMarketInterestArgs {
  eventId: string;
  market: string;
  gameStatus: MlbGameStatus;
  /** True when the caller's own cache read for this market was missing or
   *  degraded/stale — i.e. nothing fresh enough exists to publish right now. */
  stale?: boolean;
}

/**
 * Tell the coordinator the engine currently cares about this event+market.
 * Synchronous and fire-and-forget — never awaits the provider.
 *
 *  - final:   drop the interest entirely; stop refreshing.
 *  - unknown: cache-only — don't even track it, never spend quota while
 *             status is unresolved.
 *  - otherwise: dedupe by eventId+market, queue an immediate refresh on the
 *    very first registration (game-start warmup) or on promotion to
 *    near-actionable, and otherwise queue one only once the priority's
 *    cadence has elapsed since the last refresh.
 */
export function registerMarketInterest(args: RegisterMarketInterestArgs): void {
  const { eventId, market, gameStatus, stale = false } = args;
  const key = interestKey(eventId, market);

  if (gameStatus === "final") {
    interests.delete(key);
    return;
  }
  if (gameStatus === "unknown") {
    return;
  }

  const priority = derivePriority(gameStatus, stale);
  const existing = interests.get(key);
  const isNew = !existing;
  const isPromoted = !!existing && priority === "near_actionable" && existing.priority !== "near_actionable";

  const entry: MarketInterest = existing ?? { eventId, market, priority, lastRefreshedAt: 0, registeredAt: Date.now() };
  entry.priority = priority;
  interests.set(key, entry);

  const cadenceDue = Date.now() - entry.lastRefreshedAt >= REFRESH_CADENCE_MS[priority];
  if (isNew || isPromoted || cadenceDue) {
    queueRefresh(key);
  }
}

/** Drop every tracked interest for a game (all markets). Safe to call for a
 *  game with no tracked interests. */
export function removeGameInterests(eventId: string): void {
  for (const [key, interest] of Array.from(interests.entries())) {
    if (interest.eventId === eventId) interests.delete(key);
  }
}

// ── Event-ID warmup ─────────────────────────────────────────────────────────
// "Only the odds scheduler may refresh event IDs" — this coordinator is that
// scheduler. The engine tick calls this instead of the fetching event-ID
// resolver, so the ONLY remaining call to the network-hitting
// resolveMLBOddsEventId in the live engine path goes through here, on its
// own throttle, fire-and-forget.
const lastEventIdWarmAt = new Map<string, number>();
const EVENT_ID_WARM_INTERVAL_MS = 90 * 1000;

export function warmEventId(awayTeam: string, homeTeam: string): void {
  const key = `${awayTeam}|${homeTeam}`;
  const last = lastEventIdWarmAt.get(key) ?? 0;
  if (Date.now() - last < EVENT_ID_WARM_INTERVAL_MS) return;
  lastEventIdWarmAt.set(key, Date.now());
  resolveMLBOddsEventId(awayTeam, homeTeam).catch((err: any) => {
    console.warn(`[MLB_ODDS_REFRESH] warmEventId failed for ${awayTeam}@${homeTeam}: ${err?.message ?? err}`);
  });
}

// ── Test-only helpers ────────────────────────────────────────────────────────
export function _resetMlbOddsRefreshCoordinatorForTests(): void {
  interests.clear();
  lastEventIdWarmAt.clear();
}

export function _getInterestForTests(eventId: string, market: string): Readonly<MarketInterest> | undefined {
  const interest = interests.get(interestKey(eventId, market));
  return interest ? { ...interest } : undefined;
}

export function _getInterestCountForTests(): number {
  return interests.size;
}
