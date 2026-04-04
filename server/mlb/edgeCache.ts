// ── MLB Edge Output Cache ─────────────────────────────────────────────────────
// Written by triggerEngine after each orchestrator run.
// Read by /api/mlb/live-signals/:gameId — no recomputation on request.
// Cache key is the plain gameId string (e.g. "746376").

import type { MLBPropOutput, MLBQualifiedSignal } from "./types";
import { getActiveGames } from "./liveGameRegistry";

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MAX_CACHE_GAMES = 50;

export interface EdgeCacheEntry {
  gameId: string;
  outputs: MLBPropOutput[];
  qualifiedSignals: MLBQualifiedSignal[];
  allSignals: MLBQualifiedSignal[];
  gameCardTags: string[];
  updatedAt: number;
  createdAt: number;
  isDegraded?: boolean;
  signalLocked?: boolean;
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
export function edgeCacheGet(key: string): EdgeCacheEntry | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return entry;
}

// ── Size-capped set with passive cleanup ──────────────────────────────────────
export function edgeCacheSet(key: string, entry: EdgeCacheEntry): void {
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
    for (const [key, entry] of _cache.entries()) {
      if (now - entry.createdAt <= CACHE_TTL_MS) {
        valid.set(key, entry);
      } else {
        _cache.delete(key);
      }
    }
    return valid.entries();
  },
};
