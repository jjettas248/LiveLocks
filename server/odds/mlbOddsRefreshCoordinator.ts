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
//
// MLB Live Edge Trust Recovery (Phase 3) — dormancy/eligibility is tracked at
// consumer granularity (player + evaluated side), not just eventId:market.
// One player's bad OVER price must never park another player's evaluation (or
// that same player's UNDER) on the same market. A SINGLE provider refresh
// decision for the shared eventId:market response is still made by
// aggregating those consumer interests — this does not increase provider
// requests per player; it only fixes which consumers are ALLOWED to ask.

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

/** Per-consumer (player + evaluated side) dormancy/priority state. */
interface ConsumerInterest {
  player: string;
  side: string;
  priority: MlbInterestPriority;
  registeredAt: number;
  /** Parked because the evaluated side is priced worse than the floor. */
  dormant: boolean;
  dormantSince: number;
  /** Best approved-book price on the evaluated side at the time of dormancy. */
  lastBestPrice: number | null;
  /** One-shot rediscovery grant issued by a material baseball event. */
  rediscoveryPending: boolean;
}

interface MarketInterest {
  eventId: string;
  market: string;
  /** Legacy/default-consumer state — used only when a caller registers
   *  interest without a `player` (back-compat with pre-Phase-3 callers and
   *  tests). Real production registrations always pass `player`, so this
   *  stays at its initial values in that path. */
  priority: MlbInterestPriority;
  lastRefreshedAt: number;
  registeredAt: number;
  dormant: boolean;
  dormantSince: number;
  lastBestPrice: number | null;
  rediscoveryPending: boolean;
  /** Per-player+side consumer state (Phase 3). */
  consumers: Map<string, ConsumerInterest>;
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

function consumerKey(player: string, side: string | null | undefined): string {
  return `${player.toLowerCase().trim()}:${side ?? "unknown"}`;
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

function queueRefresh(market: MarketInterest, reason: string): void {
  // Stamp BEFORE the fetch resolves — collapses the many same-tick callers
  // (one per player/side sharing this market) down to a single queued
  // refresh, and the single-flight lock inside getMLBRawOdds collapses any
  // remaining concurrent provider calls for the same key into one request.
  market.lastRefreshedAt = Date.now();
  recordOddsRefreshAttempt(market.eventId, market.market, reason);
  refreshMLBMarketOdds(market.eventId, market.market).catch((err: any) => {
    console.warn(`[MLB_ODDS_REFRESH] refresh failed for ${market.eventId}/${market.market}: ${err?.message ?? err}`);
  });
}

export interface RegisterMarketInterestArgs {
  eventId: string;
  market: string;
  gameStatus: MlbGameStatus;
  /**
   * Player this registration is on behalf of. MLB Live Edge Trust Recovery
   * (Phase 3) — when provided, dormancy/eligibility for this player+side is
   * tracked independently of every other consumer on the same market. Omit
   * only for legacy/whole-market registrations (kept for back-compat).
   */
  player?: string;
  /** Evaluated side for this player (OVER/UNDER). Only meaningful with `player`. */
  side?: string | null;
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
 * Tell the coordinator the engine currently cares about this event+market
 * (optionally scoped to a specific player+side consumer). Synchronous and
 * fire-and-forget — never awaits the provider.
 *
 *  - final:   drop the interest entirely; stop refreshing.
 *  - unknown: cache-only — don't even track it, never spend quota while
 *             status is unresolved.
 *  - price-ineligible: park as dormant (this consumer only, when `player` is
 *    given). No routine refresh until a material baseball event grants a
 *    rediscovery opportunity.
 *  - otherwise: dedupe by eventId+market (+player+side when given), refresh
 *    immediately on first registration (discovery), on promotion to a
 *    tighter tier, or on a granted rediscovery; otherwise only once the
 *    tier's cadence has elapsed.
 */
export function registerMarketInterest(args: RegisterMarketInterestArgs): void {
  const {
    eventId,
    market,
    gameStatus,
    player,
    side = null,
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
  const existingMarket = interests.get(key);
  const isNewMarket = !existingMarket;

  const marketEntry: MarketInterest = existingMarket ?? {
    eventId,
    market,
    priority,
    lastRefreshedAt: 0,
    registeredAt: Date.now(),
    dormant: false,
    dormantSince: 0,
    lastBestPrice: null,
    rediscoveryPending: false,
    consumers: new Map(),
  };
  interests.set(key, marketEntry);

  if (player) {
    registerConsumerInterest(marketEntry, {
      player, side, priority, bestPriceForSide, priceEligible, materialEvent, stale, isNewMarket,
    });
    return;
  }

  // ── Legacy/default-consumer path (no player given) — unchanged behavior ──
  const isPromoted = !!existingMarket && PRIORITY_RANK[priority] > PRIORITY_RANK[existingMarket.priority];
  marketEntry.priority = priority;
  marketEntry.lastBestPrice = bestPriceForSide;

  if (!priceEligible) {
    if (marketEntry.rediscoveryPending) {
      queueRefresh(marketEntry, "rediscovery");
      marketEntry.rediscoveryPending = false;
      return;
    }
    if (!marketEntry.dormant) {
      marketEntry.dormant = true;
      marketEntry.dormantSince = Date.now();
      recordDormant(eventId, market, bestPriceForSide);
    }
    recordOddsRefreshSkip(eventId, market, "price_floor", { bestPrice: bestPriceForSide });
    return;
  }

  if (marketEntry.dormant) {
    marketEntry.dormant = false;
    marketEntry.dormantSince = 0;
    recordDormantReactivated(eventId, market, bestPriceForSide);
    queueRefresh(marketEntry, "reactivated");
    return;
  }

  if (isNewMarket) {
    queueRefresh(marketEntry, "discovery");
    return;
  }
  if (isPromoted) {
    queueRefresh(marketEntry, "promotion");
    return;
  }
  if (marketEntry.rediscoveryPending) {
    queueRefresh(marketEntry, "rediscovery");
    marketEntry.rediscoveryPending = false;
    return;
  }

  const age = Date.now() - marketEntry.lastRefreshedAt;
  const cadence = REFRESH_CADENCE_MS[priority];
  if (!Number.isFinite(cadence)) {
    if (materialEvent && stale) {
      queueRefresh(marketEntry, "material_event");
    } else {
      recordOddsRefreshSkip(eventId, market, materialEvent ? "fresh_cache" : "no_material_event", { priority });
    }
    return;
  }
  if (age >= cadence) {
    queueRefresh(marketEntry, "cadence");
  } else {
    recordOddsRefreshSkip(eventId, market, "fresh_cache", { priority, ageMs: age, cadenceMs: cadence });
  }
}

interface ConsumerRegistrationArgs {
  player: string;
  side: string | null;
  priority: MlbInterestPriority;
  bestPriceForSide: number | null;
  priceEligible: boolean;
  materialEvent: boolean;
  stale: boolean;
  isNewMarket: boolean;
}

/**
 * Phase 3 — per-consumer (player+side) dormancy/eligibility, aggregated into
 * the SAME shared eventId:market provider-refresh decision. One consumer's
 * bad price can only ever dormant-park THAT consumer; it can never suppress,
 * reactivate, or overwrite another consumer's state, and it can never cause
 * more than one upstream refresh per market cadence window (queueRefresh's
 * lastRefreshedAt stamp + oddsService's own single-flight both still apply
 * uniformly across every consumer of this market).
 */
function registerConsumerInterest(marketEntry: MarketInterest, args: ConsumerRegistrationArgs): void {
  const { player, side, priority, bestPriceForSide, priceEligible, materialEvent, stale, isNewMarket } = args;
  const cKey = consumerKey(player, side);
  const existingConsumer = marketEntry.consumers.get(cKey);
  const isNewConsumer = !existingConsumer;

  const consumer: ConsumerInterest = existingConsumer ?? {
    player, side: side ?? "unknown", priority, registeredAt: Date.now(),
    dormant: false, dormantSince: 0, lastBestPrice: null, rediscoveryPending: false,
  };
  marketEntry.consumers.set(cKey, consumer);

  const isPromoted = !!existingConsumer && PRIORITY_RANK[priority] > PRIORITY_RANK[existingConsumer.priority];
  consumer.priority = priority;
  consumer.lastBestPrice = bestPriceForSide;

  if (!priceEligible) {
    if (consumer.rediscoveryPending) {
      consumer.rediscoveryPending = false;
      queueRefresh(marketEntry, "rediscovery");
      return;
    }
    if (!consumer.dormant) {
      consumer.dormant = true;
      consumer.dormantSince = Date.now();
      recordDormant(marketEntry.eventId, marketEntry.market, bestPriceForSide);
    }
    recordOddsRefreshSkip(marketEntry.eventId, marketEntry.market, "price_floor", { bestPrice: bestPriceForSide, player, side });
    return;
  }

  if (consumer.dormant) {
    consumer.dormant = false;
    consumer.dormantSince = 0;
    recordDormantReactivated(marketEntry.eventId, marketEntry.market, bestPriceForSide);
    queueRefresh(marketEntry, "reactivated");
    return;
  }

  // "Discovery" for a whole new market fires exactly once, the first time
  // ANY consumer registers on it — never once PER consumer (that would spend
  // extra provider quota per player on an already-fresh market).
  if (isNewMarket) {
    queueRefresh(marketEntry, "discovery");
    return;
  }
  if (isNewConsumer) {
    recordOddsRefreshSkip(marketEntry.eventId, marketEntry.market, "fresh_cache", { priority, player, side, reason: "new_consumer_existing_market" });
    return;
  }
  if (isPromoted) {
    queueRefresh(marketEntry, "promotion");
    return;
  }
  if (consumer.rediscoveryPending) {
    consumer.rediscoveryPending = false;
    queueRefresh(marketEntry, "rediscovery");
    return;
  }

  const age = Date.now() - marketEntry.lastRefreshedAt;
  const cadence = REFRESH_CADENCE_MS[priority];
  if (!Number.isFinite(cadence)) {
    if (materialEvent && stale) {
      queueRefresh(marketEntry, "material_event");
    } else {
      recordOddsRefreshSkip(marketEntry.eventId, marketEntry.market, materialEvent ? "fresh_cache" : "no_material_event", { priority, player, side });
    }
    return;
  }
  if (age >= cadence) {
    queueRefresh(marketEntry, "cadence");
  } else {
    recordOddsRefreshSkip(marketEntry.eventId, marketEntry.market, "fresh_cache", { priority, ageMs: age, cadenceMs: cadence, player, side });
  }
}

/**
 * Grant every dormant market/consumer on this event one rediscovery
 * opportunity.
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
    if (interest.dormant) {
      interest.rediscoveryPending = true;
      granted += 1;
      recordDormantReconsidered(eventId, interest.market, reason);
    }
    for (const consumer of Array.from(interest.consumers.values())) {
      if (!consumer.dormant) continue;
      consumer.rediscoveryPending = true;
      granted += 1;
      recordDormantReconsidered(eventId, interest.market, reason);
    }
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

export function _getInterestForTests(eventId: string, market: string): Readonly<Omit<MarketInterest, "consumers">> | undefined {
  const interest = interests.get(interestKey(eventId, market));
  if (!interest) return undefined;
  const { consumers, ...rest } = interest;
  return { ...rest };
}

export function _getConsumerForTests(
  eventId: string, market: string, player: string, side?: string | null,
): Readonly<ConsumerInterest> | undefined {
  const interest = interests.get(interestKey(eventId, market));
  const consumer = interest?.consumers.get(consumerKey(player, side));
  return consumer ? { ...consumer } : undefined;
}

export function _getInterestCountForTests(): number {
  return interests.size;
}
