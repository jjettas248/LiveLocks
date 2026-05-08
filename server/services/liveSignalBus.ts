// ── LiveLocks Phase 1, Batch C — LiveSignalBus ────────────────────────
// THE ONLY ingress point for signals reaching UI / alerts / analytics /
// lifecycle / HR Radar surfaces.
//
// HARD RULES locked by user spec (Batch C constraints 1, 4, 6, 7, 10, 11, 17):
//   - Single registration path: registerSignal(canonical).
//   - Wraps (does not replace) mlbEdgeCache. Cache stays as MLB backing layer.
//   - Dedupe ONLY by signalId. Never by playerName / market text / UI label.
//   - Centralized freshness: every CanonicalSignal carries
//     engineGeneratedAt / surfacedAt / updatedAt / expiresAt. Bus
//     enforces stale-signal expiration via expireStaleSignals().
//   - Replay-safe: same signalId with newer engineGeneratedAt updates
//     while preserving lifecycleHistory + surfacedAt + gradingLink.
//   - Same signalId with same engineGeneratedAt → DEDUPE (no-op write).
//   - HARD: Bus is transport + dedupe + freshness only. NO probability /
//     projection / signalScore / signalTier math. Engine still owns
//     prediction logic. Lifecycle engine owns lifecycle transitions.
//
// What the bus owns (constraint 12):
//   - registration, dedupe, freshness, propagation
// What the bus does NOT own:
//   - Engine math (engine owns probability/projection/signalScore/signalTier/drivers)
//   - Lifecycle transitions (lifecycle engine owns lifecycleState/history)
//   - Rendering (UI owns)

import type { CanonicalSignal } from "../../shared/canonicalSignal";
import { isTerminalLifecycle } from "../../shared/canonicalSignal";
import {
  recordCanonical,
  getCanonical,
  listCanonical,
  sweepExpired,
} from "./lifecycleStore";
import { applyLifecycleEvent } from "./lifecycleEngine";
import { notifyLifecycleChange } from "./alertSubscriber";

// Lifecycle ranking — used to detect upgrade transitions for alerts.
const _ls_rank: Record<string, number> = {
  watch: 0, build: 1, strong: 2, elite: 3,
  cashed: 99, missed: 99, expired: 99,
};

// Default freshness window — a signal is considered stale if no update
// has been observed in this many ms. Bus expires it via the lifecycle
// engine. Independent of the lifecycle store's longer 30 min TTL — the
// bus's freshness is for "is this signal currently live and surfaceable?"
export const SIGNAL_FRESHNESS_MS = 5 * 60 * 1000;

// ── Metrics ──────────────────────────────────────────────────────────
interface BusMetrics {
  registered: number;       // first-time signalId registrations
  updated: number;          // re-registrations with newer engineGeneratedAt
  deduped: number;          // re-registrations with same engineGeneratedAt
  rejected: number;         // throws / contract violations / stale on entry
  staleExpired: number;     // expireStaleSignals() expirations
  legacyConsumers: Record<string, number>; // route → hit count
  // Propagation timing — registerSignal end-to-end ms
  propagationSamples: number[]; // last 200 samples for percentile calc
}

const _metrics: BusMetrics = {
  registered: 0,
  updated: 0,
  deduped: 0,
  rejected: 0,
  staleExpired: 0,
  legacyConsumers: {},
  propagationSamples: [],
};

const PROPAGATION_SAMPLE_CAP = 200;

function recordPropagation(ms: number) {
  _metrics.propagationSamples.push(ms);
  if (_metrics.propagationSamples.length > PROPAGATION_SAMPLE_CAP) {
    _metrics.propagationSamples.shift();
  }
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ── Legacy-consumer rate-limited logging (constraint 13) ─────────────
const LEGACY_LOG_INTERVAL_MS = 60 * 1000;
const _legacyLastLog: Map<string, number> = new Map();

export function markLegacyConsumer(label: string): void {
  _metrics.legacyConsumers[label] = (_metrics.legacyConsumers[label] ?? 0) + 1;
  const now = Date.now();
  const last = _legacyLastLog.get(label) ?? 0;
  if (now - last >= LEGACY_LOG_INTERVAL_MS) {
    _legacyLastLog.set(label, now);
    console.log(
      `[LL_LEGACY_SIGNAL_CONSUMER] route=${label} totalHits=${_metrics.legacyConsumers[label]}`
    );
  }
}

// ── Registration result ──────────────────────────────────────────────
export type RegisterKind = "created" | "updated" | "deduped" | "rejected";

export interface RegisterResult {
  kind: RegisterKind;
  canonical: CanonicalSignal | null;
  reason?: string;
}

/**
 * SOLE INGRESS for signals into the runtime. Every UI/alert/analytics/
 * lifecycle consumer reads what this function admits.
 *
 * Contract:
 *   - same signalId + same engineGeneratedAt   → DEDUPE   (no state change)
 *   - same signalId + newer engineGeneratedAt  → UPDATE   (refresh + lifecycle eval)
 *   - new  signalId                            → CREATED  (lifecycle from `created`)
 *   - terminal lifecycle (cashed/missed/expired) refused for re-promotion
 *
 * Never throws — all failures emit [LL_SIGNAL_REJECTED] and return rejected.
 */
export function registerSignal(incoming: CanonicalSignal): RegisterResult {
  const start = Date.now();
  try {
    if (!incoming || !incoming.signalId || !incoming.sport) {
      _metrics.rejected++;
      console.log(
        `[LL_SIGNAL_REJECTED] reason=missing-signalId-or-sport signalId=${incoming?.signalId ?? "<none>"}`
      );
      return { kind: "rejected", canonical: null, reason: "missing signalId/sport" };
    }

    // Stale on entry — engine cycle older than freshness window. Reject
    // before contaminating the store; it would expire on the next sweep
    // anyway and we don't want a flap.
    if (
      incoming.engineGeneratedAt > 0 &&
      Date.now() - incoming.engineGeneratedAt > SIGNAL_FRESHNESS_MS
    ) {
      _metrics.rejected++;
      console.log(
        `[LL_SIGNAL_REJECTED] reason=stale-on-entry signalId=${incoming.signalId} ageMs=${Date.now() - incoming.engineGeneratedAt}`
      );
      return { kind: "rejected", canonical: null, reason: "stale on entry" };
    }

    const existing = getCanonical(incoming.signalId);

    // Terminal-state guard — once cashed/missed/expired, the signal is
    // an immutable record. Engine cycles for the same signalId after
    // termination are dropped (DEDUPE-equivalent). The lifecycle engine
    // would also reject the transition, but rejecting here avoids
    // logging an INVALID_TRANSITION on a perfectly normal post-cash cycle.
    if (existing && isTerminalLifecycle(existing.lifecycleState)) {
      // If the engine generated a NEW cycle but the signal is terminal,
      // count as deduped (no-op). Don't refresh engine math — the
      // immutability post-bus contract forbids it.
      _metrics.deduped++;
      console.log(
        `[LL_SIGNAL_DEDUPE] signalId=${incoming.signalId} reason=terminal-state state=${existing.lifecycleState}`
      );
      recordPropagation(Date.now() - start);
      return { kind: "deduped", canonical: existing };
    }

    // Same engineGeneratedAt as last observation → exact dedupe.
    if (existing && existing.engineGeneratedAt === incoming.engineGeneratedAt) {
      _metrics.deduped++;
      console.log(
        `[LL_SIGNAL_DEDUPE] signalId=${incoming.signalId} engineGeneratedAt=${incoming.engineGeneratedAt}`
      );
      recordPropagation(Date.now() - start);
      return { kind: "deduped", canonical: existing };
    }

    // Replay-safe register: lifecycleStore preserves surfacedAt and
    // lifecycleHistory across recordCanonical calls. gradingLink is also
    // preserved by the store. We only need to make sure the incoming
    // carries the right freshness fields — set expiresAt if absent.
    const enriched: CanonicalSignal = {
      ...incoming,
      expiresAt: incoming.expiresAt ?? Date.now() + SIGNAL_FRESHNESS_MS,
    };

    const stored = recordCanonical(enriched);
    const isCreate = !existing;
    if (isCreate) {
      _metrics.registered++;
      console.log(
        `[LL_SIGNAL_REGISTER] signalId=${stored.signalId} sport=${stored.sport} market=${stored.market} side=${stored.side} state=${stored.lifecycleState}`
      );
      recordPropagation(Date.now() - start);
      // Bus → alert subscriber: a freshly created signal at strong/elite
      // tier is an upgrade-equivalent event.
      try {
        if (stored.signalTier === "strong" || stored.signalTier === "elite") {
          notifyLifecycleChange(stored, "tier_upgraded", "first observation at bettable tier");
        }
        // HR Watch detection — flagged via signalTags or triggerSummary
        const drv = stored.drivers ?? [];
        const isHrWatch = drv.some((d) => /hr.?watch|near.?hr/i.test(d?.label ?? "")) ||
          /hr.?watch/i.test(stored.triggerSummary ?? "");
        if (isHrWatch) {
          notifyLifecycleChange(stored, "hr_watch_detected", "first HR Watch surface");
        }
      } catch (e) { /* alerts must never break ingress */ }
      return { kind: "created", canonical: stored };
    }

    _metrics.updated++;
    console.log(
      `[LL_SIGNAL_UPDATE] signalId=${stored.signalId} state=${stored.lifecycleState} engineGeneratedAt=${stored.engineGeneratedAt}`
    );
    recordPropagation(Date.now() - start);
    // Bus → alert subscriber: detect lifecycle UPGRADE (e.g. build→strong).
    try {
      const fromRank = _ls_rank[existing!.lifecycleState] ?? 0;
      const toRank = _ls_rank[stored.lifecycleState] ?? 0;
      if (toRank > fromRank && toRank < 99) {
        notifyLifecycleChange(stored, "lifecycle_upgraded",
          `${existing!.lifecycleState}→${stored.lifecycleState}`);
      }
    } catch (e) { /* alerts must never break ingress */ }
    return { kind: "updated", canonical: stored };
  } catch (err) {
    _metrics.rejected++;
    console.log(
      `[LL_SIGNAL_REJECTED] reason=exception signalId=${incoming?.signalId ?? "<none>"} message=${(err as Error).message}`
    );
    return { kind: "rejected", canonical: null, reason: (err as Error).message };
  }
}

/**
 * Mark a signal expired explicitly (e.g., game went final, cache
 * eviction). Idempotent — terminal signals are no-ops.
 */
export function expireSignal(signalId: string, reason: string): void {
  const existing = getCanonical(signalId);
  if (!existing) return;
  if (isTerminalLifecycle(existing.lifecycleState)) return;

  const result = applyLifecycleEvent(existing, {
    kind: "expired",
    to: "expired",
    reason,
    by: "bus",
    at: Date.now(),
  });
  if (result.changed) {
    // Re-store via lifecycleStore by registering the result's next
    // — but lifecycleStore's recordCanonical would treat this as a
    // fresh engine cycle. Instead, mutate the underlying record by
    // registering through the lifecycle directly. Since lifecycleStore
    // doesn't expose a setter, we re-record the next-state canonical
    // (engineGeneratedAt unchanged so the dedupe path doesn't fight us).
    // Use applyLifecycleEvent's result by writing it through the store.
    // The cleanest path: call recordCanonical with the same engine
    // fields but new lifecycleState — but recordCanonical compares
    // existing vs incoming lifecycleState, so this works.
    const next: CanonicalSignal = {
      ...result.next,
      // engineGeneratedAt advances minimally so dedupe doesn't suppress
      // — but bus must NOT mutate engine cycle ts. Workaround: write
      // through lifecycleStore by passing the next-state canonical.
      // recordCanonical sees lifecycleState change and writes it.
    };
    recordCanonical(next);
    _metrics.staleExpired++;
    console.log(
      `[LL_SIGNAL_EXPIRED] signalId=${signalId} reason=${reason}`
    );
  }
}

/**
 * Mark a signal CASHED explicitly (e.g. HR observed for an HR Radar signal,
 * stat threshold crossed for a player prop). Idempotent — terminal signals
 * are no-ops. Invalid transitions (e.g. `watch → cashed` is not in the
 * lifecycle transition graph) are logged via the lifecycle engine and
 * silently dropped — the caller's downstream stamps still hold.
 *
 * Hard rule: bus is transport-only. This function NEVER mutates probability,
 * tier, drivers, or projection — only the lifecycle subset.
 */
export function cashSignal(signalId: string, reason: string): void {
  const existing = getCanonical(signalId);
  if (!existing) return;
  if (isTerminalLifecycle(existing.lifecycleState)) return;

  const result = applyLifecycleEvent(existing, {
    kind: "cashed",
    to: "cashed",
    reason,
    by: "hr-radar-grader",
    at: Date.now(),
  });
  if (result.changed) {
    recordCanonical(result.next);
    // Tag for HR Radar lifecycle repair audit. The lifecycle engine itself
    // emits [LL_SIGNAL_CASHED] from applyLifecycleEvent — this is the
    // bus-surface companion so admins can grep both.
    console.log(`[HR_RADAR_CASHED] signalId=${signalId} reason=${reason}`);
  }
}

/**
 * Central staleness sweep. Called by index.ts on a 60s cadence.
 * Components MUST NOT expire locally — only the bus expires.
 */
export function expireStaleSignals(now: number = Date.now()): number {
  let expired = 0;
  const all = listCanonical();
  for (const sig of all) {
    if (isTerminalLifecycle(sig.lifecycleState)) continue;
    const lastSeen = sig.updatedAt;
    if (now - lastSeen <= SIGNAL_FRESHNESS_MS) continue;
    expireSignal(
      sig.signalId,
      `inactive ${Math.round((now - lastSeen) / 1000)}s > ${Math.round(SIGNAL_FRESHNESS_MS / 1000)}s`
    );
    expired++;
  }
  if (expired > 0) {
    console.log(`[LL_SIGNAL_EXPIRED] sweep expired=${expired}`);
  }
  return expired;
}

// ── Read API for migrated consumers (constraints 1, 8, 9) ────────────
export interface RegisteredFilter {
  sport?: string;
  gameId?: string;
  // Caller can pass excludeTerminal=true to hide cashed/missed/expired
  // from active surfaces (UI default). Diagnostics pass false.
  excludeTerminal?: boolean;
  // Caller can require freshness window. Defaults to SIGNAL_FRESHNESS_MS.
  freshOnlyWithinMs?: number;
}

export function getRegistered(filter: RegisteredFilter = {}): CanonicalSignal[] {
  const all = listCanonical({ sport: filter.sport });
  const now = Date.now();
  const window = filter.freshOnlyWithinMs ?? SIGNAL_FRESHNESS_MS;
  return all.filter((s) => {
    if (filter.gameId && s.gameId !== filter.gameId) return false;
    if (filter.excludeTerminal && isTerminalLifecycle(s.lifecycleState)) return false;
    if (window > 0 && now - s.updatedAt > window) return false;
    return true;
  });
}

export function getRegisteredById(signalId: string): CanonicalSignal | null {
  return getCanonical(signalId);
}

// ── Metrics surface (constraint 14) ──────────────────────────────────
export function getMetrics() {
  const propP50 = percentile(_metrics.propagationSamples, 50);
  const propP95 = percentile(_metrics.propagationSamples, 95);
  return {
    registered: _metrics.registered,
    updated: _metrics.updated,
    deduped: _metrics.deduped,
    rejected: _metrics.rejected,
    staleExpired: _metrics.staleExpired,
    legacyConsumers: { ..._metrics.legacyConsumers },
    propagationMsP50: propP50,
    propagationMsP95: propP95,
    sampleCount: _metrics.propagationSamples.length,
  };
}

// ── Sweeper boot ─────────────────────────────────────────────────────
let _sweeperTimer: ReturnType<typeof setInterval> | null = null;
export function startBusSweeper(intervalMs: number = 60 * 1000) {
  if (_sweeperTimer) return;
  _sweeperTimer = setInterval(() => {
    try { expireStaleSignals(); } catch (e) {
      console.warn(`[LL_SIGNAL_REJECTED] sweep failed: ${(e as Error).message}`);
    }
  }, intervalMs);
  if (typeof _sweeperTimer.unref === "function") _sweeperTimer.unref();
  console.log(`[LL_SIGNAL_REGISTER] bus sweeper started intervalMs=${intervalMs} freshnessMs=${SIGNAL_FRESHNESS_MS}`);
}

// Test escape hatch
export function _resetBusForTests() {
  _metrics.registered = 0;
  _metrics.updated = 0;
  _metrics.deduped = 0;
  _metrics.rejected = 0;
  _metrics.staleExpired = 0;
  _metrics.legacyConsumers = {};
  _metrics.propagationSamples = [];
  _legacyLastLog.clear();
  if (_sweeperTimer) { clearInterval(_sweeperTimer); _sweeperTimer = null; }
}
