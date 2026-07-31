// ── MLB Live Edge — narrowed-cycle carry-forward ──────────────────────────────
// Pure, I/O-free. Solves one problem created by event-driven, narrowed engine
// cycles: triggerEngine writes the edge cache WHOLESALE, so any market/player
// it didn't evaluate this cycle would be deleted from /api/mlb/edge-feed and
// /api/mlb/live-signals until the next full cycle.
//
// THE CARRY PREDICATE IS SCOPE, NOT ABSENCE.
//
//   in scope  + no fresh signal  => genuine deletion (odds vanished, firewall
//                                   reject, score fell below floor). Delete it.
//   out of scope                 => never looked at. Carry it forward verbatim.
//
// That single rule covers market narrowing and player narrowing uniformly and
// degenerates to an exact no-op on full-scope cycles.
//
// Carried objects are passed through BY REFERENCE, unmodified. Nothing here
// re-scores, re-ranks, re-derives, or mutates a signal field — carrying a
// signal through family suppression a second time would re-apply
// familyPenaltyFactor to signalScore and decay it geometrically. This module
// therefore runs AFTER family suppression, and its output feeds ONLY the cache
// write — never autoPersistMLBSignals and never the LiveSignalBus population
// loop, both of which must continue to see freshly computed signals only.

import type { MLBPropOutput, MLBQualifiedSignal } from "./types";
import { normalizeMlbMarketKey } from "./normalizeMarketKey";

export interface CycleScope {
  /** Markets actually iterated this cycle. */
  markets: "all" | Set<string>;
  /** Players actually iterated this cycle, for markets subject to narrowing. */
  playerIds: "all" | Set<string>;
  /**
   * Markets that were walked for the FULL lineup even when `playerIds` is
   * narrowed — home_runs (exempt from player narrowing) and the pitcher
   * markets (only ever one active pitcher to evaluate). A pair in one of these
   * markets is in scope regardless of `playerIds`, so its absence is a real
   * deletion rather than a carry-forward candidate.
   */
  fullyEvaluatedMarkets?: Set<string>;
}

export function isFullScope(scope: CycleScope): boolean {
  return scope.markets === "all" && scope.playerIds === "all";
}

export function inScope(scope: CycleScope, playerId: string, market: string): boolean {
  const normalized = normalizeMlbMarketKey(market);
  const marketOk = scope.markets === "all" || scope.markets.has(normalized);
  if (!marketOk) return false;
  if (scope.fullyEvaluatedMarkets?.has(normalized)) return true;
  return scope.playerIds === "all" || scope.playerIds.has(playerId);
}

interface CacheSlice {
  outputs: MLBPropOutput[];
  qualifiedSignals: MLBQualifiedSignal[];
  allSignals: MLBQualifiedSignal[];
}

export interface MergeCarryForwardArgs {
  gameId: string;
  /** Prior cache entry. Pass undefined to disable carry-forward entirely. */
  prior: CacheSlice | undefined;
  /** This cycle's freshly computed results. */
  fresh: CacheSlice;
  scope: CycleScope;
  nowMs: number;
  /** Upper bound on how long a signal may survive on carry-forward alone. */
  maxCarryAgeMs: number;
  /** Already-settled player/market pairs must never be resurrected. */
  isResolved: (playerId: string, market: string) => boolean;
}

export interface MergeCarryForwardResult extends CacheSlice {
  carriedSignals: number;
  carriedOutputs: number;
  droppedResolved: number;
  droppedStale: number;
  /**
   * IDs (MLBQualifiedSignal.id) of every signal in `allSignals`/
   * `qualifiedSignals` that was carried forward from a prior cycle rather
   * than freshly computed this tick. Callers use this to scope read-time
   * revalidation (server/mlb/carryForwardRevalidation.ts) to ONLY carried
   * signals — freshly computed signals already reflect current reality and
   * must never be re-filtered by the same logic.
   */
  carriedSignalIds: string[];
}

function outputKey(playerId: string, market: string): string {
  return `${playerId}_${normalizeMlbMarketKey(market)}`;
}

/**
 * Merge the prior cycle's untouched signals into this cycle's results.
 *
 * On a full-scope cycle (or with no prior entry) the fresh arrays are returned
 * BY REFERENCE IDENTITY — a hard guarantee that nothing changes for the cycles
 * that already behave correctly today.
 */
export function mergeCarryForward(args: MergeCarryForwardArgs): MergeCarryForwardResult {
  const { prior, fresh, scope, nowMs, maxCarryAgeMs, isResolved } = args;

  if (!prior || isFullScope(scope)) {
    return {
      outputs: fresh.outputs,
      qualifiedSignals: fresh.qualifiedSignals,
      allSignals: fresh.allSignals,
      carriedSignals: 0,
      carriedOutputs: 0,
      droppedResolved: 0,
      droppedStale: 0,
      carriedSignalIds: [],
    };
  }

  // Defensive fresh-wins tiebreak. `id` is `${gameId}_${playerId}_${market}`.
  const freshIds = new Set(fresh.allSignals.map(s => s.id));
  // qualifiedSignals and allSignals share object references (see the push
  // sites in triggerEngine), so identity membership is the correct test.
  const priorQualified = new Set<MLBQualifiedSignal>(prior.qualifiedSignals);

  const carriedAll: MLBQualifiedSignal[] = [];
  const carriedQualified: MLBQualifiedSignal[] = [];
  let droppedResolved = 0;
  let droppedStale = 0;

  for (const sig of prior.allSignals) {
    // Rule 1 — in scope means it was genuinely re-evaluated. Absence is a
    // deletion, not an oversight.
    if (inScope(scope, sig.playerId, sig.market)) continue;
    if (freshIds.has(sig.id)) continue;
    if (isResolved(sig.playerId, sig.market)) { droppedResolved += 1; continue; }

    const generatedAt = (sig as any).engineGeneratedAt ?? 0;
    if (generatedAt > 0 && nowMs - generatedAt > maxCarryAgeMs) { droppedStale += 1; continue; }

    carriedAll.push(sig);
    if (priorQualified.has(sig)) carriedQualified.push(sig);
  }

  // Outputs must travel with their signals: /api/mlb/live-signals reads edge,
  // hrFactors, hrBuildScore and hrAlertSnapshot off entry.outputs, joined by
  // playerId + normalized market. A signal carried without its output renders
  // a half-empty card.
  const carriedSignalKeys = new Set(carriedAll.map(s => outputKey(s.playerId, s.market)));
  const freshOutputKeys = new Set(fresh.outputs.map(o => outputKey(o.playerId, o.market)));
  const carriedOutputs: MLBPropOutput[] = [];
  for (const out of prior.outputs) {
    const key = outputKey(out.playerId, out.market);
    if (!carriedSignalKeys.has(key)) continue;
    if (freshOutputKeys.has(key)) continue;
    carriedOutputs.push(out);
  }

  return {
    outputs: [...fresh.outputs, ...carriedOutputs],
    qualifiedSignals: [...fresh.qualifiedSignals, ...carriedQualified],
    allSignals: [...fresh.allSignals, ...carriedAll],
    carriedSignals: carriedAll.length,
    carriedOutputs: carriedOutputs.length,
    droppedResolved,
    droppedStale,
    carriedSignalIds: carriedAll.map(s => s.id),
  };
}

/**
 * Feed presentation ordering. Extracted from triggerEngine so the merged array
 * is sorted with the identical comparator and the contract cannot drift.
 * Display ordering only — never touches signal values.
 */
export function compareMLBSignalsForFeed(a: MLBQualifiedSignal, b: MLBQualifiedSignal): number {
  const aDeg = a.isDegraded ? 1 : 0;
  const bDeg = b.isDegraded ? 1 : 0;
  if (aDeg !== bDeg) return aDeg - bDeg;
  const aFlagship = a.isFlagship ? 0 : 1;
  const bFlagship = b.isFlagship ? 0 : 1;
  if (aFlagship !== bFlagship) return aFlagship - bFlagship;
  return (b.signalScore ?? 0) - (a.signalScore ?? 0);
}
