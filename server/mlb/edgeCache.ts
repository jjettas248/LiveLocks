// ── MLB Edge Output Cache ─────────────────────────────────────────────────────
// Written by triggerEngine after each orchestrator run.
// Read by /api/mlb/live-signals/:gameId — no recomputation on request.
// Cache key is the plain gameId string (e.g. "746376").

import type { MLBPropOutput, MLBQualifiedSignal } from "./types";
import { getActiveGames, getGame } from "./liveGameRegistry";
import { isCarriedSignalWithinReadTimeBounds } from "./carryForwardRevalidation";
import { MLB_ODDS_LIVE_TTL } from "../oddsService";

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_CACHE_GAMES = 50;

// Same bound the orchestrator's write-time carry-forward filter uses
// (liveGameOrchestrator.ts's PRESERVE_MAX_AGE_MS) — kept here as an
// independent constant (not imported from the orchestrator, which this
// module must not depend on) so the read-time guard degrades safely even if
// the two ever drift; both currently agree at 20 minutes.
const CARRIED_SIGNAL_MAX_AGE_MS = 20 * 60 * 1000;

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
  /**
   * Observability only — how many of this entry's signals were carried
   * forward verbatim from the prior cycle because a narrowed (event-scoped)
   * engine run never evaluated them. Never read by freshness logic.
   */
  carriedForwardCount?: number;
  /**
   * IDs (within allSignals/qualifiedSignals) of signals that were carried
   * forward and passed write-time revalidation THIS write
   * (applyCarryForwardRevalidation's survivingCarriedIds). Used by the
   * read-time guard below to know which signals still need a per-read
   * time-bound recheck — see isCarriedSignalWithinReadTimeBounds. A signal
   * NOT in this list is either freshly computed (never needs the recheck)
   * or was already dropped before reaching the cache.
   */
  carriedSignalIds?: string[];
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

// ── Read-time carried-signal expiration guard ─────────────────────────────
// Fail-closed, time-only, and scoped ONLY to signals the write-time filter
// (applyCarryForwardRevalidation, called from liveGameOrchestrator.ts)
// already marked as carried this cycle (entry.carriedSignalIds) — freshly
// computed signals and cache entries with no carry-forward at all
// (carriedSignalIds empty/undefined) pass through completely untouched, so
// this can never affect a non-MLB-Live-Edge cache write or a test fixture
// that never populates carriedSignalIds.
//
// WHY THIS EXISTS: MLB Live Edge is event-driven (CLAUDE.md §3.2a-1) — the
// write-time filter only re-runs when a real baseball event triggers
// triggerEngine and a fresh write happens. Pure time passing between events
// is not itself an event, so a carried signal's frozen oddsTimestamp/
// engineGeneratedAt can silently age past validity while the entry sits
// untouched, served to every reader in the meantime. This re-checks the
// SAME two time bounds on every read, against the CURRENT clock — never
// pitching/matchup/family/degraded state, which stays write-time-only
// (those changes are always accompanied by a triggering event, so the next
// write-time pass catches them; re-deriving them here would need live
// pitcher/game state this module doesn't have and would duplicate complete
// signal finalization).
//
// Also treats a carried signal's game leaving the active registry (see
// server/mlb/liveGameRegistry.ts) as an immediate expiry — a known state
// version change no time bound alone can see, and cheap to check here since
// getGame() is already an O(1) in-memory lookup. Scoped to carried signals
// only, so it can never hide an entry a test or caller seeded without ever
// registering its gameId.
function applyReadTimeGuards(entry: EdgeCacheEntry, nowMs: number): EdgeCacheEntry {
  if (!entry.carriedSignalIds || entry.carriedSignalIds.length === 0) return entry;

  const gameIsTerminal = getGame(entry.gameId) === undefined;
  const carriedIdSet = new Set(entry.carriedSignalIds);
  const bounds = { maxCarryAgeMs: CARRIED_SIGNAL_MAX_AGE_MS, oddsFreshnessThresholdMs: MLB_ODDS_LIVE_TTL };
  const stillValidIds = new Set<string>();

  const allSignals = entry.allSignals.filter((sig) => {
    if (!carriedIdSet.has(sig.id)) return true;
    if (gameIsTerminal) return false;
    const ok = isCarriedSignalWithinReadTimeBounds(sig, nowMs, bounds);
    if (ok) stillValidIds.add(sig.id);
    return ok;
  });

  if (allSignals.length === entry.allSignals.length) return entry; // nothing expired — return the same reference, no new allocation

  const qualifiedSignals = entry.qualifiedSignals.filter((sig) => !carriedIdSet.has(sig.id) || stillValidIds.has(sig.id));
  return {
    ...entry,
    allSignals,
    qualifiedSignals,
    carriedSignalIds: entry.carriedSignalIds.filter((id) => stillValidIds.has(id)),
  };
}

// ── TTL-aware get ─────────────────────────────────────────────────────────────
function edgeCacheGet(key: string): EdgeCacheEntry | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return applyReadTimeGuards(entry, Date.now());
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
        valid.set(key, applyReadTimeGuards(entry, now));
      } else {
        _cache.delete(key);
      }
    }
    return valid.entries();
  },
};
