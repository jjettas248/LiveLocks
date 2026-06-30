// ── MLB Edge Output Cache ─────────────────────────────────────────────────────
// Written by triggerEngine after each orchestrator run.
// Read by /api/mlb/live-signals/:gameId — no recomputation on request.
// Cache key is the plain gameId string (e.g. "746376").

import type { MLBPropOutput, MLBQualifiedSignal } from "./types";
import { getActiveGames } from "./liveGameRegistry";

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CACHE_GAMES = 50;

// Engine-liveness window. The orchestrator's 25s heartbeat (P5) writes
// either a fresh qualifying cycle (updatedAt = now) or a blank-cycle
// preservation tick (preservedAt = now). If neither has happened in the
// last ACTIVE_FRESHNESS_MS, the engine is effectively dead — every
// consumer route must drop the entry, regardless of how recent the last
// preservation was. Shared so all MLB-surface routes agree on liveness.
const MLB_ACTIVE_FRESHNESS_MS = 4 * 60 * 1000;

interface EdgeCacheEntry {
  gameId: string;
  outputs: MLBPropOutput[];
  qualifiedSignals: MLBQualifiedSignal[];
  allSignals: MLBQualifiedSignal[];
  gameCardTags: string[];
  updatedAt: number;
  createdAt: number;
  isDegraded?: boolean;
  signalLocked?: boolean;
  // Set by the orchestrator when a blank-cycle preservation kicks in
  // (this tick produced 0 signals but prior signals are being held). The
  // /api/mlb/edge-feed freshness filter honors max(updatedAt, preservedAt)
  // so deliberately-preserved signals are not silently dropped from the
  // bettable feed during natural game gaps.
  preservedAt?: number;
}

const _cache = new Map<string, EdgeCacheEntry>();

// ── Cleanup sweep ─────────────────────────────────────────────────────────────
// Removes entries whose TTL has expired or whose game is no longer active.
// Games leave the active registry when they reach a final/completed state.
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  const activeIds = new Set(getActiveGames().map((g) => g.gameId));

  for (const [key, entry] of Array.from(_cache.entries())) {
    if (now - entry.createdAt > CACHE_TTL_MS || !activeIds.has(entry.gameId)) {
      _cache.delete(key);
    }
  }
}

// ── TTL-aware get ─────────────────────────────────────────────────────────────
function edgeCacheGet(key: string): EdgeCacheEntry | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return entry;
}

// ── Size-capped set with passive cleanup ──────────────────────────────────────
function edgeCacheSet(key: string, entry: EdgeCacheEntry): void {
  cleanupExpiredEntries();

  _cache.set(key, entry);

  // Enforce MAX_CACHE_GAMES after every write.
  if (_cache.size > MAX_CACHE_GAMES) {
    const overflow = _cache.size - MAX_CACHE_GAMES;
    const sorted = Array.from(_cache.entries()).sort(
      ([, a], [, b]) => a.createdAt - b.createdAt
    );
    for (let i = 0; i < overflow; i++) {
      _cache.delete(sorted[i][0]);
    }
  }
}

// ── Two-axis freshness check (shared by every MLB-surface route) ─────────────
// Both axes must pass for the entry to be considered fresh:
//
//  Axis A — Engine liveness:
//    Drop if neither updatedAt nor preservedAt has fired within
//    MLB_ACTIVE_FRESHNESS_MS. The orchestrator emits a tick (qualifying or
//    blank-cycle preserve) every ~25s, so silence beyond this window means
//    the engine is dead — a recent preserve cannot keep it visible.
//
//  Axis B — Last real qualifying cycle (per-route):
//    Even with active blank-cycle preserves, cap total signal visibility
//    at maxSignalAgeMs from the last cycle that actually qualified
//    signals. Routes choose this based on intent (bettable feed gets the
//    longest window; per-game live signals get the orchestrator-aligned
//    window; widgets and badge counts can be tighter or match).
export function isMLBEdgeEntryFresh(
  entry: { updatedAt: number; preservedAt?: number },
  maxSignalAgeMs: number,
  nowMs: number = Date.now(),
): boolean {
  const preservedAt = entry.preservedAt ?? 0;
  const lastEngineTick = Math.max(entry.updatedAt, preservedAt);
  // Axis A — engine alive.
  if (lastEngineTick > 0 && nowMs - lastEngineTick > MLB_ACTIVE_FRESHNESS_MS) {
    return false;
  }
  // Axis B — last qualifying cycle within route's intent window.
  if (entry.updatedAt > 0 && nowMs - entry.updatedAt > maxSignalAgeMs) {
    return false;
  }
  return true;
}

// ── mlbEdgeCache public interface ─────────────────────────────────────────────
// Exposes the subset of Map<string, EdgeCacheEntry> used at call sites.
export const mlbEdgeCache = {
  get(key: string): EdgeCacheEntry | undefined {
    return edgeCacheGet(key);
  },
  set(key: string, value: EdgeCacheEntry): void {
    edgeCacheSet(key, value);
  },
  has(key: string): boolean {
    return edgeCacheGet(key) !== undefined;
  },
  delete(key: string): boolean {
    return _cache.delete(key);
  },
  get size(): number {
    return _cache.size;
  },
  entries(): IterableIterator<[string, EdgeCacheEntry]> {
    const now = Date.now();
    const valid = new Map<string, EdgeCacheEntry>();
    for (const [key, entry] of Array.from(_cache.entries())) {
      if (now - entry.createdAt <= CACHE_TTL_MS) {
        valid.set(key, entry);
      } else {
        _cache.delete(key);
      }
    }
    return valid.entries();
  },
};
