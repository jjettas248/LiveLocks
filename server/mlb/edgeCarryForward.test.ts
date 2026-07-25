// MLB Live Edge narrowed-cycle carry-forward — unit tests.
// Run: npx tsx server/mlb/edgeCarryForward.test.ts
//
// The invariant under test: an in-scope player/market that produced no fresh
// signal is a REAL DELETION and must stay deleted. Only state the cycle never
// looked at may carry forward, and it must carry forward untouched.

import {
  mergeCarryForward,
  isFullScope,
  inScope,
  compareMLBSignalsForFeed,
  type CycleScope,
} from "./edgeCarryForward";
import type { MLBPropOutput, MLBQualifiedSignal } from "./types";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_CARRY_FORWARD_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

const NOW = 1_700_000_000_000;
const MAX_AGE = 20 * 60 * 1000;
const neverResolved = () => false;

function sig(playerId: string, market: string, over: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: `g1_${playerId}_${market}`,
    playerId,
    playerName: `Player ${playerId}`,
    market,
    side: "OVER",
    signalScore: 70,
    confidenceTier: "STRONG",
    isDegraded: false,
    isFlagship: true,
    engineGeneratedAt: NOW - 1000,
    signalTags: [],
    ...over,
  } as unknown as MLBQualifiedSignal;
}

function out(playerId: string, market: string): MLBPropOutput {
  return { playerId, market, playerName: `Player ${playerId}`, edge: 5 } as unknown as MLBPropOutput;
}

function slice(signals: MLBQualifiedSignal[], qualified?: MLBQualifiedSignal[]) {
  return {
    outputs: signals.map(s => out(s.playerId, s.market)),
    qualifiedSignals: qualified ?? signals,
    allSignals: signals,
  };
}

// ─── Group A: full scope is a strict no-op ────────────────────────────────────
{
  const fresh = slice([sig("p1", "hits")]);
  const prior = slice([sig("p2", "home_runs")]);
  const scope: CycleScope = { markets: "all", playerIds: "all" };
  check("A1: isFullScope true for all/all", isFullScope(scope));

  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh, scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("A2: full scope returns fresh allSignals BY REFERENCE", merged.allSignals === fresh.allSignals);
  check("A3: full scope returns fresh outputs BY REFERENCE", merged.outputs === fresh.outputs);
  check("A4: full scope returns fresh qualified BY REFERENCE", merged.qualifiedSignals === fresh.qualifiedSignals);
  check("A5: full scope carries nothing", merged.carriedSignals === 0);
}
{
  // No prior entry: also a strict no-op.
  const fresh = slice([sig("p1", "hits")]);
  const merged = mergeCarryForward({
    gameId: "g1", prior: undefined, fresh,
    scope: { markets: new Set(["hits"]), playerIds: "all" },
    nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("A6: no prior entry returns fresh by reference", merged.allSignals === fresh.allSignals);
}

// ─── Group B: scope is the carry predicate, not absence ───────────────────────
{
  // pitcher_strikeouts is OUT of scope -> carried. hits is IN scope and the
  // fresh cycle emitted nothing for p1 -> real deletion.
  const prior = slice([sig("p1", "hits"), sig("p9", "pitcher_strikeouts")]);
  const fresh = slice([]);
  const scope: CycleScope = { markets: new Set(["hits"]), playerIds: "all" };

  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh, scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("B1: out-of-scope market is carried forward", merged.allSignals.some(s => s.market === "pitcher_strikeouts"));
  check("B2: in-scope market with no fresh signal is DELETED", !merged.allSignals.some(s => s.market === "hits"), JSON.stringify(merged.allSignals.map(s => s.market)));
  check("B3: carried count is 1", merged.carriedSignals === 1, String(merged.carriedSignals));
}
{
  // Player narrowing: p1 evaluated, p2 not.
  const prior = slice([sig("p1", "hits"), sig("p2", "hits")]);
  const fresh = slice([]);
  const scope: CycleScope = { markets: new Set(["hits"]), playerIds: new Set(["p1"]) };
  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh, scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("B4: narrowed-out player is carried", merged.allSignals.some(s => s.playerId === "p2"));
  check("B5: evaluated player that produced nothing is deleted", !merged.allSignals.some(s => s.playerId === "p1"));
}
{
  // fullyEvaluatedMarkets overrides player narrowing (home_runs / pitcher mkts).
  const scope: CycleScope = {
    markets: new Set(["hits", "home_runs"]),
    playerIds: new Set(["p1"]),
    fullyEvaluatedMarkets: new Set(["home_runs"]),
  };
  check("B6: home_runs for a narrowed-out player is still IN scope", inScope(scope, "p2", "home_runs"));
  check("B7: hits for a narrowed-out player is OUT of scope", !inScope(scope, "p2", "hits"));

  const prior = slice([sig("p2", "home_runs")]);
  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh: slice([]), scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("B8: a vanished HR signal is a real deletion, never carried", merged.carriedSignals === 0, JSON.stringify(merged.allSignals));
}

// ─── Group C: carried signals are never mutated ───────────────────────────────
{
  const carried = sig("p2", "hits", { signalScore: 80, isFlagship: true, confidenceTier: "STRONG" });
  Object.freeze(carried);
  const prior = slice([carried]);
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };

  let threw = false;
  let result: any;
  try {
    result = mergeCarryForward({
      gameId: "g1", prior, fresh: slice([sig("p9", "pitcher_strikeouts")]), scope,
      nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
    });
  } catch { threw = true; }
  check("C1: merging a frozen carried signal does not throw", !threw);
  check("C2: the carried object is the SAME reference (no copy, no re-derive)", result.allSignals.includes(carried));
  check("C3: signalScore untouched", carried.signalScore === 80);
  check("C4: confidenceTier untouched", carried.confidenceTier === "STRONG");
}
{
  // Repeated narrowed cycles must not decay a carried score (the family
  // suppression 0.85^n bug this ordering exists to prevent).
  const carried = sig("p2", "hits", { signalScore: 80 });
  let priorSlice = slice([carried]);
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  for (let i = 0; i < 5; i++) {
    const merged = mergeCarryForward({
      gameId: "g1", prior: priorSlice, fresh: slice([sig("p9", "pitcher_strikeouts")]), scope,
      nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
    });
    priorSlice = { outputs: merged.outputs, qualifiedSignals: merged.qualifiedSignals, allSignals: merged.allSignals };
  }
  check("C5: score is bit-identical after 5 narrowed carry cycles", carried.signalScore === 80, String(carried.signalScore));
  check("C6: no duplicate accumulation across cycles", priorSlice.allSignals.filter(s => s.id === carried.id).length === 1);
}

// ─── Group D: outputs travel with their signals ───────────────────────────────
{
  const prior = slice([sig("p2", "hits")]);
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh: slice([sig("p9", "pitcher_strikeouts")]), scope,
    nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("D1: a carried signal brings its outputs row", merged.outputs.some(o => o.playerId === "p2" && o.market === "hits"));
  check("D2: carriedOutputs is counted", merged.carriedOutputs === 1, String(merged.carriedOutputs));
  check("D3: fresh outputs are still present", merged.outputs.some(o => o.playerId === "p9"));
  check("D4: every carried signal has a matching output", merged.allSignals.every(s => merged.outputs.some(o => o.playerId === s.playerId && o.market === s.market)));
}

// ─── Group E: resolved pairs are never resurrected ────────────────────────────
{
  const prior = slice([sig("p2", "hits"), sig("p3", "home_runs")]);
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh: slice([]), scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE,
    isResolved: (pid) => pid === "p2" || pid === "p3",
  });
  check("E1: resolved pairs are dropped, not carried", merged.carriedSignals === 0, JSON.stringify(merged.allSignals));
  check("E2: droppedResolved is counted", merged.droppedResolved === 2, String(merged.droppedResolved));
}
{
  // Legacy "hr" market string must normalize to home_runs for the resolved check.
  const prior = slice([sig("p3", "hr")]);
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  const seen: string[] = [];
  mergeCarryForward({
    gameId: "g1", prior, fresh: slice([]), scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE,
    isResolved: (_pid, market) => { seen.push(market); return false; },
  });
  check("E3: isResolved receives the raw market for the caller to normalize", seen.includes("hr"), JSON.stringify(seen));
}

// ─── Group F: zombie carry is bounded ─────────────────────────────────────────
{
  const stale = sig("p2", "hits", { engineGeneratedAt: NOW - (21 * 60 * 1000) });
  const prior = slice([stale]);
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh: slice([]), scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("F1: a signal older than the carry window is dropped", merged.carriedSignals === 0);
  check("F2: droppedStale is counted", merged.droppedStale === 1, String(merged.droppedStale));
}
{
  const fresh19 = sig("p2", "hits", { engineGeneratedAt: NOW - (19 * 60 * 1000) });
  const merged = mergeCarryForward({
    gameId: "g1", prior: slice([fresh19]), fresh: slice([]),
    scope: { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" },
    nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("F3: a signal inside the carry window survives", merged.carriedSignals === 1);
}

// ─── Group G: qualified vs watch-only membership ──────────────────────────────
{
  const qualified = sig("p2", "hits");
  const watchOnly = sig("p3", "hits");
  const prior = { outputs: [out("p2", "hits"), out("p3", "hits")], qualifiedSignals: [qualified], allSignals: [qualified, watchOnly] };
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  const merged = mergeCarryForward({
    gameId: "g1", prior, fresh: slice([]), scope, nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("G1: both signals carried into allSignals", merged.allSignals.length === 2);
  check("G2: only the previously-qualified one lands in qualifiedSignals", merged.qualifiedSignals.length === 1 && merged.qualifiedSignals[0] === qualified);
}

// ─── Group H: fresh always wins over a stale duplicate ────────────────────────
{
  const priorSig = sig("p2", "hits", { signalScore: 40 });
  const freshSig = sig("p2", "hits", { signalScore: 90 });
  const scope: CycleScope = { markets: new Set(["pitcher_strikeouts"]), playerIds: "all" };
  const merged = mergeCarryForward({
    gameId: "g1", prior: slice([priorSig]), fresh: slice([freshSig]), scope,
    nowMs: NOW, maxCarryAgeMs: MAX_AGE, isResolved: neverResolved,
  });
  check("H1: same id is not duplicated", merged.allSignals.filter(s => s.id === freshSig.id).length === 1);
  check("H2: the fresh signal wins", merged.allSignals[0].signalScore === 90);
}

// ─── Group I: feed comparator ─────────────────────────────────────────────────
{
  const degraded = sig("p1", "hits", { isDegraded: true, signalScore: 99 });
  const flagship = sig("p2", "hits", { isFlagship: true, signalScore: 50 });
  const nonFlagship = sig("p3", "hits", { isFlagship: false, signalScore: 60 });
  const sorted = [degraded, nonFlagship, flagship].sort(compareMLBSignalsForFeed);
  check("I1: degraded sorts last", sorted[2] === degraded);
  check("I2: flagship outranks a higher-scoring non-flagship", sorted[0] === flagship);
}

console.log(`[MLB_CARRY_FORWARD_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MLB_CARRY_FORWARD_TEST] OK");
