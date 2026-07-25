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
//
// Two policies live here:
//
//  1. SIGNAL-AWARE FRESHNESS. Refresh urgency follows the existing canonical
//     lifecycle state (watch/build/strong/elite) rather than a parallel
//     invented state machine. A signal nobody could act on does not get
//     routine provider spend just because time passed.
//
//  2. DORMANCY. A market whose evaluated side is priced worse than -200 stops
//     receiving routine refreshes, but is never permanently abandoned: real
//     baseball events (inning change, pitcher change, promotion) grant it one
//     rediscovery opportunity. There is deliberately NO extra timer for
//     dormant markets — reconsideration rides the existing event flow.

import { refreshMLBMarketOdds, resolveMLBOddsEventId } from "../oddsService";
import type { MlbGameStatus } from "../oddsService";
import {
  recordOddsRefreshAttempt,
  recordOddsRefreshSkip,
  recordDormant,
  recordDormantReconsidered,
  recordDormantReactivated,
} from "../mlb/liveEdgeMetrics";

/**
 * Refresh urgency, derived from the canonical lifecycle state of the signals
 * riding on this market. Deliberately named after the product states rather
 * than invented tiers.
 *
 *  - monitoring: watch / nothing surfaced. Cached odds only; no routine
 *    external refresh purely because time elapsed. Event-driven refreshes and
 *    the first discovery request still apply.
 *  - build:      refresh only once the cached price is materially stale.
 *  - ready:      pricing validation is becoming relevant — refresh briskly.
 *  - actionable: elite / FIRE. Must have fresh pricing to be presented as
 *    actionable, so this is the tightest cadence plus an immediate refresh on
 *    promotion into the tier.
 */
export type MlbInterestPriority = "monitoring" | "build" | "ready" | "actionable";

export type MlbSignalUrgency = "watch" | "build" | "strong" | "elite" | null;

interface MarketInterest {
  eventId: string;
  market: string;
  priority: MlbInterestPriority;
  lastRefreshedAt: number;
  registeredAt: number;
  /** Parked because the evaluated side is priced worse than the floor. */
  dormant: boolean;
  dormantSince: number;
  /** Best approved-book price on the evaluated side at the time of dormancy. */
  lastBestPrice: number | null;
  /** One-shot rediscovery grant issued by a material baseball event. */
  rediscoveryPending: boolean;
}

// Cadence per priority tier. `monitoring` is Infinity — a monitoring market is
// refreshed ONLY on first discovery, on a material baseball event, or once it
// promotes out of monitoring. Never on a timer.
const REFRESH_CADENCE_MS: Record<MlbInterestPriority, number> = {
  monitoring: Number.POSITIVE_INFINITY,
  build: 2 * 60 * 1000,
  ready: 45 * 1000,
  actionable: 30 * 1000,
};

const PRIORITY_RANK: Record<MlbInterestPriority, number> = {
  monitoring: 0,
  build: 1,
  ready: 2,
  actionable: 3,
};

const interests = new Map<string, MarketInterest>();

function interestKey(eventId: string, market: string): string {
  return `${eventId}:${market}`;
}

/**
 * Map canonical lifecycle state to refresh urgency.
 *
 * `stale` still matters, but only as a tie-breaker within a tier — it can no
 * longer, by itself, promote an unsurfaced market to the tightest cadence.
 * That was the old behaviour and it meant "we have no fresh price" was reason
 * enough to spend, regardless of whether anyone could act on the result.
 */
function derivePriority(
  gameStatus: MlbGameStatus,
  urgency: MlbSignalUrgency,
  stale: boolean,
): MlbInterestPriority {
  if (gameStatus !== "live") return "monitoring";
  switch (urgency) {
    case "elite":  return "actionable";
    case "strong": return "ready";
    case "build":  return stale ? "ready" : "build";
    case "watch":  return "monitoring";
    default:       return "monitoring";
  }
}

function queueRefresh(key: string, reason: string): void {
  const interest = interests.get(key);
  if (!interest) return;
  // Stamp BEFORE the fetch resolves — collapses the many same-tick callers
  // (one per player sharing this market) down to a single queued refresh,
  // and the single-flight lock inside getMLBRawOdds covers the rest.
  interest.lastRefreshedAt = Date.now();
  interest.rediscoveryPending = false;
  recordOddsRefreshAttempt(interest.eventId, interest.market, `${interest.priority}:${reason}`);
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
  /** Canonical lifecycle state of the strongest signal on this market. */
  urgency?: MlbSignalUrgency;
  /** Best approved-book price on the EVALUATED side. null = never priced. */
  bestPriceForSide?: number | null;
  /** False when the price floor rejected this market/side. */
  priceEligible?: boolean;
  /** True when a real baseball event authorized this registration. */
  materialEvent?: boolean;
}

/**
 * Tell the coordinator the engine currently cares about this event+market.
 * Synchronous and fire-and-forget — never awaits the provider.
 *
 *  - final:   drop the interest entirely; stop refreshing.
 *  - unknown: cache-only — don't even track it, never spend quota while
 *             status is unresolved.
 *  - price-ineligible: park as dormant. No routine refresh until a material
 *    baseball event grants a rediscovery opportunity.
 *  - otherwise: dedupe by eventId+market, refresh immediately on first
 *    registration (discovery), on promotion to a tighter tier, or on a granted
 *    rediscovery; otherwise only once the tier's cadence has elapsed.
 */
export function registerMarketInterest(args: RegisterMarketInterestArgs): void {
  const {
    eventId,
    market,
    gameStatus,
    stale = false,
    urgency = null,
    bestPriceForSide = null,
    priceEligible = true,
    materialEvent = true,
  } = args;
  const key = interestKey(eventId, market);

  if (gameStatus === "final") {
    interests.delete(key);
    return;
  }
  if (gameStatus === "unknown") {
    return;
  }

  const priority = derivePriority(gameStatus, urgency, stale);
  const existing = interests.get(key);
  const isNew = !existing;

  const entry: MarketInterest = existing ?? {
    eventId,
    market,
    priority,
    lastRefreshedAt: 0,
    registeredAt: Date.now(),
    dormant: false,
    dormantSince: 0,
    lastBestPrice: null,
    rediscoveryPending: false,
  };

  const isPromoted = !!existing && PRIORITY_RANK[priority] > PRIORITY_RANK[existing.priority];
  entry.priority = priority;
  entry.lastBestPrice = bestPriceForSide;
  interests.set(key, entry);

  // ── Price floor ────────────────────────────────────────────────────────────
  if (!priceEligible) {
    // A rediscovery grant survives exactly one registration: it buys the one
    // refresh needed to learn whether the price has moved back above the floor.
    if (entry.rediscoveryPending) {
      queueRefresh(key, "rediscovery");
      return;
    }
    if (!entry.dormant) {
      entry.dormant = true;
      entry.dormantSince = Date.now();
      recordDormant(eventId, market, bestPriceForSide);
    }
    recordOddsRefreshSkip(eventId, market, "price_floor", { bestPrice: bestPriceForSide });
    return;
  }

  // Eligible. If it was dormant, its price has recovered — reactivate.
  if (entry.dormant) {
    entry.dormant = false;
    entry.dormantSince = 0;
    recordDormantReactivated(eventId, market, bestPriceForSide);
    queueRefresh(key, "reactivated");
    return;
  }

  // ── Refresh decision ───────────────────────────────────────────────────────
  if (isNew) {
    queueRefresh(key, "discovery");
    return;
  }
  if (isPromoted) {
    queueRefresh(key, "promotion");
    return;
  }
  if (entry.rediscoveryPending) {
    queueRefresh(key, "rediscovery");
    return;
  }

  const age = Date.now() - entry.lastRefreshedAt;
  const cadence = REFRESH_CADENCE_MS[priority];
  if (!Number.isFinite(cadence)) {
    // Monitoring: only a material baseball event may spend here, and only when
    // there is genuinely nothing fresh to read.
    if (materialEvent && stale) {
      queueRefresh(key, "material_event");
    } else {
      recordOddsRefreshSkip(eventId, market, materialEvent ? "fresh_cache" : "no_material_event", { priority });
    }
    return;
  }
  if (age >= cadence) {
    queueRefresh(key, "cadence");
  } else {
    recordOddsRefreshSkip(eventId, market, "fresh_cache", { priority, ageMs: age, cadenceMs: cadence });
  }
}

/**
 * Grant every dormant market on this event one rediscovery opportunity.
 *
 * Called from the orchestrator on material baseball events only
 * (inning_change, pitcher_change, lineup_substitution) and on lifecycle
 * promotion — never on a timer. The grant is consumed by the next
 * registration, which either reactivates the market (price recovered) or
 * re-parks it as dormant (still below the floor).
 */
export function reconsiderDormantMarkets(eventId: string, reason: string): number {
  let granted = 0;
  for (const [, interest] of Array.from(interests.entries())) {
    if (interest.eventId !== eventId) continue;
    if (!interest.dormant) continue;
    interest.rediscoveryPending = true;
    granted += 1;
    recordDormantReconsidered(eventId, interest.market, reason);
  }
  return granted;
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
