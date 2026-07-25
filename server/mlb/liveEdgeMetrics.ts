// ── MLB Live Edge — polling / odds-spend observability ───────────────────────
// Read-only instrumentation for the event-driven Live Edge path. Mirrors the
// qualificationAudit.ts contract: in-memory counters only, bounded, never
// throws, and NEVER influences engine math, lifecycle, or refresh decisions.
//
// The point of this module is to make production Odds API consumption
// auditable — specifically to answer "why did each external odds request
// happen?" and "how many requests per live game-hour are we spending?".
//
// Logging discipline: no per-pitch output. Per-event tags are rate-limited
// with the same cooldown pattern marketStarvationGuard.ts uses, and the
// aggregate [MLB_POLLING_METRICS] line is emitted at most once every 5 min.

export type EngineTriggerLabel = string;

export interface LiveEdgeCounters {
  /** Cheap state observations (a poll that fetched authoritative game state). */
  statePolls: number;
  /** State polls whose diff contained zero real baseball events. */
  statePollsNoChange: number;
  /** Reconciliation backstop runs (150s no-engine-activity check). */
  reconciliationChecks: number;
  /** Reconciliation runs that found a missed event and classified it. */
  reconciliationRecoveries: number;
  /** Real baseball events detected, by trigger name. */
  materialEvents: Record<string, number>;
  /** triggerEngine executions that actually ran, by originating trigger. */
  engineRuns: Record<string, number>;
  /** triggerEngine executions total (sum of engineRuns). */
  engineRunsTotal: number;
  /** Engine cycles that ran narrowed (subset of markets and/or players). */
  narrowedCycles: number;
  /** Refresh interest registrations that were accepted. */
  oddsRefreshAttempted: number;
  /** Interest registrations skipped: cached snapshot already fresh enough. */
  oddsRefreshSkippedFresh: number;
  /** Interest registrations skipped: evaluated side priced worse than -200. */
  oddsRefreshSkippedPriceFloor: number;
  /** Interest registrations skipped: no material event authorized a refresh. */
  oddsRefreshSkippedNoEvent: number;
  /** Markets currently parked in the dormant price state. */
  dormantMarkets: number;
  /** Dormant markets granted a rediscovery opportunity by a baseball event. */
  dormantReconsidered: number;
  /** Dormant markets whose rediscovered price cleared the floor. */
  dormantReactivated: number;
  /** Actual outbound HTTP requests to the Odds API (the only number that costs money). */
  externalOddsRequests: number;
  /** Cache reads that were served without any provider contact. */
  oddsCacheHits: number;
  /** Milliseconds of observed live-game time, used for the per-game-hour KPI. */
  liveGameMs: number;
}

function emptyCounters(): LiveEdgeCounters {
  return {
    statePolls: 0,
    statePollsNoChange: 0,
    reconciliationChecks: 0,
    reconciliationRecoveries: 0,
    materialEvents: {},
    engineRuns: {},
    engineRunsTotal: 0,
    narrowedCycles: 0,
    oddsRefreshAttempted: 0,
    oddsRefreshSkippedFresh: 0,
    oddsRefreshSkippedPriceFloor: 0,
    oddsRefreshSkippedNoEvent: 0,
    dormantMarkets: 0,
    dormantReconsidered: 0,
    dormantReactivated: 0,
    externalOddsRequests: 0,
    oddsCacheHits: 0,
    liveGameMs: 0,
  };
}

let counters: LiveEdgeCounters = emptyCounters();
let startedAt = Date.now();

// Per-tag rate limiting so a hot loop can never spam production logs.
const lastTagEmit = new Map<string, number>();
const TAG_COOLDOWN_MS = 60 * 1000;
const METRICS_EMIT_INTERVAL_MS = 5 * 60 * 1000;
let lastMetricsEmit = 0;

// Bound the per-trigger maps so a malformed trigger name can't grow unbounded.
const MAX_TRIGGER_KEYS = 40;

function bump(map: Record<string, number>, key: string, by = 1): void {
  if (map[key] === undefined && Object.keys(map).length >= MAX_TRIGGER_KEYS) return;
  map[key] = (map[key] ?? 0) + by;
}

/** Emit a bracketed tag at most once per cooldown per key. Never throws. */
function emitTag(tag: string, dedupeKey: string, payload: Record<string, unknown>): void {
  try {
    const key = `${tag}:${dedupeKey}`;
    const last = lastTagEmit.get(key) ?? 0;
    const now = Date.now();
    if (now - last < TAG_COOLDOWN_MS) return;
    lastTagEmit.set(key, now);
    // Bound the dedupe map.
    if (lastTagEmit.size > 500) {
      for (const [k, ts] of Array.from(lastTagEmit.entries())) {
        if (now - ts > TAG_COOLDOWN_MS * 5) lastTagEmit.delete(k);
      }
    }
    console.log(`${tag} ${JSON.stringify(payload)}`);
  } catch {
    /* observability must never break runtime */
  }
}

// ── Recorders (all no-throw) ─────────────────────────────────────────────────

export function recordStatePoll(gameId: string, materialTriggers: readonly string[]): void {
  try {
    counters.statePolls += 1;
    if (materialTriggers.length === 0) {
      counters.statePollsNoChange += 1;
      return;
    }
    for (const t of materialTriggers) bump(counters.materialEvents, t);
    emitTag("[MLB_STATE_EVENT]", gameId, { gameId, triggers: materialTriggers });
  } catch { /* ignore */ }
}

export function recordEngineRun(
  gameId: string,
  triggers: readonly string[],
  opts?: { narrowed?: boolean; marketCount?: number; playerCount?: number | "all" },
): void {
  try {
    counters.engineRunsTotal += 1;
    const label = triggers.length > 0 ? triggers.join("+") : "initial";
    bump(counters.engineRuns, label);
    if (opts?.narrowed) counters.narrowedCycles += 1;
    emitTag("[MLB_ENGINE_TRIGGER]", `${gameId}:${label}`, {
      gameId,
      triggers: label,
      narrowed: !!opts?.narrowed,
      markets: opts?.marketCount ?? null,
      players: opts?.playerCount ?? null,
    });
  } catch { /* ignore */ }
}

export function recordReconciliationCheck(recovered: boolean, gameId?: string): void {
  try {
    counters.reconciliationChecks += 1;
    if (recovered) {
      counters.reconciliationRecoveries += 1;
      emitTag("[MLB_STATE_EVENT]", `reconcile:${gameId ?? "?"}`, {
        gameId: gameId ?? null,
        source: "reconciliation",
        recovered: true,
      });
    }
  } catch { /* ignore */ }
}

export type OddsRefreshSkipReason = "fresh_cache" | "price_floor" | "no_material_event";

export function recordOddsRefreshAttempt(eventId: string, market: string, priority: string): void {
  try {
    counters.oddsRefreshAttempted += 1;
    emitTag("[MLB_ODDS_REFRESH]", `${eventId}:${market}`, { eventId, market, priority });
  } catch { /* ignore */ }
}

export function recordOddsRefreshSkip(
  eventId: string,
  market: string,
  reason: OddsRefreshSkipReason,
  detail?: Record<string, unknown>,
): void {
  try {
    if (reason === "fresh_cache") {
      counters.oddsRefreshSkippedFresh += 1;
      counters.oddsCacheHits += 1;
      emitTag("[MLB_ODDS_CACHE_HIT]", `${eventId}:${market}`, { eventId, market, ...detail });
      return;
    }
    if (reason === "price_floor") {
      counters.oddsRefreshSkippedPriceFloor += 1;
      emitTag("[MLB_ODDS_PRICE_SUPPRESSED]", `${eventId}:${market}`, { eventId, market, ...detail });
      return;
    }
    counters.oddsRefreshSkippedNoEvent += 1;
  } catch { /* ignore */ }
}

export function recordDormant(eventId: string, market: string, bestPrice: number | null): void {
  try {
    counters.dormantMarkets += 1;
    emitTag("[MLB_ODDS_DORMANT]", `${eventId}:${market}`, { eventId, market, bestPrice });
  } catch { /* ignore */ }
}

export function recordDormantReconsidered(eventId: string, market: string, reason: string): void {
  try {
    counters.dormantReconsidered += 1;
    emitTag("[MLB_ODDS_DORMANT]", `reconsider:${eventId}:${market}`, { eventId, market, reason, reconsidered: true });
  } catch { /* ignore */ }
}

export function recordDormantReactivated(eventId: string, market: string, bestPrice: number | null): void {
  try {
    counters.dormantReactivated += 1;
    emitTag("[MLB_ODDS_REACTIVATED]", `${eventId}:${market}`, { eventId, market, bestPrice });
  } catch { /* ignore */ }
}

/** Called at the single real provider fetch site so the count cannot be gamed. */
export function recordExternalOddsRequest(marketKey: string): void {
  try {
    counters.externalOddsRequests += 1;
    void marketKey;
  } catch { /* ignore */ }
}

/** Accumulate observed live-game time so the per-game-hour KPI is meaningful. */
export function recordLiveGameTime(ms: number): void {
  try {
    if (Number.isFinite(ms) && ms > 0) counters.liveGameMs += ms;
  } catch { /* ignore */ }
}

// ── Snapshot + periodic aggregate emission ───────────────────────────────────

export interface LiveEdgeMetricsSnapshot extends LiveEdgeCounters {
  windowMs: number;
  startedAt: number;
  generatedAt: number;
  /** The infrastructure KPI: external Odds API requests per live game-hour. */
  oddsRequestsPerLiveGameHour: number | null;
  /** Share of state polls that terminated immediately (higher is better). */
  noChangePollPct: number | null;
}

export function getLiveEdgeMetrics(): LiveEdgeMetricsSnapshot {
  const now = Date.now();
  const liveHours = counters.liveGameMs / 3_600_000;
  return {
    ...counters,
    materialEvents: { ...counters.materialEvents },
    engineRuns: { ...counters.engineRuns },
    windowMs: now - startedAt,
    startedAt,
    generatedAt: now,
    oddsRequestsPerLiveGameHour: liveHours > 0
      ? Math.round((counters.externalOddsRequests / liveHours) * 10) / 10
      : null,
    noChangePollPct: counters.statePolls > 0
      ? Math.round((counters.statePollsNoChange / counters.statePolls) * 1000) / 10
      : null,
  };
}

/**
 * Emit the aggregate metrics line. Safe to call on every poll — it self-limits
 * to one emission per METRICS_EMIT_INTERVAL_MS.
 */
export function maybeEmitLiveEdgeMetrics(): void {
  try {
    const now = Date.now();
    if (now - lastMetricsEmit < METRICS_EMIT_INTERVAL_MS) return;
    lastMetricsEmit = now;
    const snap = getLiveEdgeMetrics();
    console.log(`[MLB_POLLING_METRICS] ${JSON.stringify({
      windowMin: Math.round(snap.windowMs / 60_000),
      statePolls: snap.statePolls,
      noChange: snap.statePollsNoChange,
      noChangePct: snap.noChangePollPct,
      engineRuns: snap.engineRunsTotal,
      narrowed: snap.narrowedCycles,
      engineRunsByTrigger: snap.engineRuns,
      reconChecks: snap.reconciliationChecks,
      reconRecoveries: snap.reconciliationRecoveries,
      oddsAttempted: snap.oddsRefreshAttempted,
      oddsSkippedFresh: snap.oddsRefreshSkippedFresh,
      oddsSkippedPriceFloor: snap.oddsRefreshSkippedPriceFloor,
      oddsSkippedNoEvent: snap.oddsRefreshSkippedNoEvent,
      dormant: snap.dormantMarkets,
      dormantReconsidered: snap.dormantReconsidered,
      dormantReactivated: snap.dormantReactivated,
      externalOddsRequests: snap.externalOddsRequests,
      oddsPerLiveGameHour: snap.oddsRequestsPerLiveGameHour,
    })}`);
  } catch { /* observability must never break runtime */ }
}

// ── Test-only helpers ────────────────────────────────────────────────────────
// Test/debug only — never call in prod request paths.
export function _resetLiveEdgeMetricsForTests(): void {
  counters = emptyCounters();
  startedAt = Date.now();
  lastTagEmit.clear();
  lastMetricsEmit = 0;
}

export function _getMaxTriggerKeysForTests(): number {
  return MAX_TRIGGER_KEYS;
}
