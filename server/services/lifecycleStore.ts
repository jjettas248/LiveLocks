// ── LiveLocks Batch B — Lifecycle Store ───────────────────────────────
// Thin in-memory store keyed by stable signalId. WRAPS, never replaces,
// the existing mlbEdgeCache. No callsites in mlbEdgeCache.set() change.
//
// What this owns:
//   - The CanonicalSignal record per signalId
//   - Lifecycle transition history (already inside CanonicalSignal)
//   - TTL sweep that promotes inactive non-terminal signals → expired
//
// What this does NOT own:
//   - Engine probability, scoring, drivers (engine-owned)
//   - mlbEdgeCache contents (untouched)
//   - Persisted plays (grading-owned)

import type { CanonicalSignal, LifecycleState } from "../../shared/canonicalSignal";
import { isTerminalLifecycle } from "../../shared/canonicalSignal";
import { applyLifecycleEvent, inferEventKind } from "./lifecycleEngine";

const DEFAULT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes inactive → expired

const _store: Map<string, CanonicalSignal> = new Map();

/**
 * Insert a freshly-built canonical signal, or merge onto an existing one
 * by promoting it through the lifecycle if the engine indicates the
 * new lifecycleState is different. Returns the resulting (immutable from
 * the caller's point of view) canonical signal.
 *
 * Engine fields (probability/edge/drivers/etc) ARE refreshed — they
 * come from the engine, which is the authoritative source. Only the
 * lifecycle subset is run through the transition engine.
 */
export function recordCanonical(incoming: CanonicalSignal): CanonicalSignal {
  const existing = _store.get(incoming.signalId);

  if (!existing) {
    // New signal — emit [LL_SIGNAL_CREATED] via the lifecycle engine by
    // applying a synthetic transition from the natural starting state.
    const created: CanonicalSignal = {
      ...incoming,
      lifecycleHistory: [
        {
          at: incoming.surfacedAt,
          from: null,
          to: incoming.lifecycleState,
          event: "created",
          reason: "first observation",
          by: "engine",
        },
      ],
    };
    console.log(
      `[LL_SIGNAL_CREATED] signalId=${created.signalId} state=${created.lifecycleState} sport=${created.sport} market=${created.market} side=${created.side}`
    );
    _store.set(created.signalId, created);
    return created;
  }

  // Refresh engine-owned fields from incoming, but DO NOT touch
  // lifecycleHistory unless the lifecycleState actually changes.
  const merged: CanonicalSignal = {
    ...existing,
    displayProbability: incoming.displayProbability,
    overProbability: incoming.overProbability,
    underProbability: incoming.underProbability,
    edge: incoming.edge,
    projection: incoming.projection,
    bookLine: incoming.bookLine,
    signalTier: incoming.signalTier,
    signalScore: incoming.signalScore,
    drivers: incoming.drivers,
    triggerSummary: incoming.triggerSummary,
    updatedAt: incoming.updatedAt,
    expiresAt: incoming.expiresAt ?? existing.expiresAt,
    sourceRef: incoming.sourceRef ?? existing.sourceRef,
  };

  if (incoming.lifecycleState !== existing.lifecycleState) {
    const event = {
      kind: inferEventKind(existing.lifecycleState, incoming.lifecycleState),
      to: incoming.lifecycleState,
      reason: "engine evidence change",
      by: "engine",
      at: incoming.updatedAt,
    };
    const result = applyLifecycleEvent(merged, event);
    _store.set(result.next.signalId, result.next);
    return result.next;
  }

  _store.set(merged.signalId, merged);
  return merged;
}

export function getCanonical(signalId: string): CanonicalSignal | null {
  return _store.get(signalId) ?? null;
}

export function getHistory(signalId: string) {
  return _store.get(signalId)?.lifecycleHistory ?? [];
}

export function listCanonical(opts?: { sport?: string; limit?: number }): CanonicalSignal[] {
  const out: CanonicalSignal[] = [];
  for (const sig of Array.from(_store.values())) {
    if (opts?.sport && sig.sport !== opts.sport) continue;
    out.push(sig);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return opts?.limit ? out.slice(0, opts.limit) : out;
}

/**
 * TTL sweep — moves any non-terminal canonical signal whose updatedAt
 * is older than `maxAgeMs` into the `expired` lifecycle state.
 * Idempotent. Safe to call from any cadence.
 */
export function sweepExpired(maxAgeMs: number = DEFAULT_EXPIRY_MS, now: number = Date.now()) {
  let expired = 0;
  for (const [id, sig] of Array.from(_store.entries())) {
    if (isTerminalLifecycle(sig.lifecycleState)) continue;
    const age = now - sig.updatedAt;
    if (age <= maxAgeMs) continue;

    const result = applyLifecycleEvent(sig, {
      kind: "expired",
      to: "expired",
      reason: `inactive for ${Math.round(age / 1000)}s (max ${Math.round(maxAgeMs / 1000)}s)`,
      by: "ttl-sweeper",
      at: now,
    });
    if (result.changed) {
      _store.set(id, result.next);
      expired++;
    }
  }
  if (expired > 0) {
    console.log(`[LL_LIFECYCLE_SWEEP] expired=${expired} totalTracked=${_store.size}`);
  }
  return expired;
}

let _sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startTtlSweeper(intervalMs: number = 5 * 60 * 1000) {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    try { sweepExpired(); } catch (e) {
      console.warn(`[LL_LIFECYCLE_SWEEP] failed: ${(e as Error).message}`);
    }
  }, intervalMs);
  // Don't keep the process alive solely for sweeps in dev/test contexts.
  if (typeof _sweepTimer.unref === "function") _sweepTimer.unref();
}

// Test-only escape hatch — never call from production code paths.
export function _resetForTests() {
  _store.clear();
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}
