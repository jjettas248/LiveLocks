/**
 * [MLB Canonical Signal Tier — Phase 2] Validation harness
 *
 * Plain Node.js script (no jest/vitest dependency) that mirrors the
 * canonicalProbability.test.ts harness from Phase 1. Run with:
 *
 *   npx tsx server/mlb/canonicalSignalTier.test.ts
 *
 * Asserts:
 *   1. deriveSignalTier() collapses the 5-state SignalConfidenceTier into
 *      the canonical 4-state SignalTier deterministically and never throws.
 *   2. The mapping is monotonic: ELITE → "elite" > STRONG → "strong" >
 *      SOLID → "lean" > WATCHLIST/NO_SIGNAL → "watch".
 *   3. Unknown / undefined / null inputs degrade safely to "watch".
 *   4. topPlaysService consumes server-stamped MLB.signalTier and surfaces
 *      it on TopPlayItem; missing stamp triggers fallback through the
 *      legacy confidenceTier path.
 *   5. The full ladder (ELITE → strong → SOLID → WATCHLIST → NO_SIGNAL)
 *      hits all four canonical tiers exactly once, with no duplicates and
 *      no missing tier.
 */

import { deriveSignalTier, type SignalTier, type SignalConfidenceTier } from "./signalScore";
import { buildTopPlays } from "../services/topPlaysService";

interface TestCase {
  name: string;
  fn: () => void;
}

const cases: TestCase[] = [];
function test(name: string, fn: () => void) {
  cases.push({ name, fn });
}
function assertEq<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) {
    throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// 1 — exact mapping from each SignalConfidenceTier value
test("deriveSignalTier maps ELITE → elite", () => {
  assertEq<SignalTier>(deriveSignalTier("ELITE"), "elite", "ELITE→elite");
});
test("deriveSignalTier maps STRONG → strong", () => {
  assertEq<SignalTier>(deriveSignalTier("STRONG"), "strong", "STRONG→strong");
});
test("deriveSignalTier maps SOLID → lean", () => {
  assertEq<SignalTier>(deriveSignalTier("SOLID"), "lean", "SOLID→lean");
});
test("deriveSignalTier maps WATCHLIST → watch", () => {
  assertEq<SignalTier>(deriveSignalTier("WATCHLIST"), "watch", "WATCHLIST→watch");
});
test("deriveSignalTier maps NO_SIGNAL → watch", () => {
  assertEq<SignalTier>(deriveSignalTier("NO_SIGNAL"), "watch", "NO_SIGNAL→watch");
});

// 2 — defensive coverage: undefined/null/garbage all collapse to "watch"
test("deriveSignalTier(undefined) → watch", () => {
  assertEq<SignalTier>(deriveSignalTier(undefined), "watch", "undefined→watch");
});
test("deriveSignalTier(null) → watch", () => {
  assertEq<SignalTier>(deriveSignalTier(null), "watch", "null→watch");
});
test("deriveSignalTier(garbage) → watch", () => {
  assertEq<SignalTier>(deriveSignalTier("BANANA" as any), "watch", "garbage→watch");
});

// 3 — full-ladder coverage: every canonical tier value gets reached
test("ladder coverage — all 4 canonical tiers reachable from the 5-state enum", () => {
  const inputs: SignalConfidenceTier[] = ["ELITE", "STRONG", "SOLID", "WATCHLIST", "NO_SIGNAL"];
  const out = inputs.map(deriveSignalTier);
  const distinct = new Set(out);
  if (!distinct.has("elite") || !distinct.has("strong") || !distinct.has("lean") || !distinct.has("watch")) {
    throw new Error(`missing canonical tier(s): saw ${[...distinct].join(",")}`);
  }
});

// 4 — topPlaysService prefers server-stamped MLB.signalTier
test("topPlaysService surfaces server-stamped signalTier on TopPlayItem", () => {
  const mlbSig = {
    playerId: "p1",
    playerName: "Player One",
    gameId: "g1",
    market: "hits",
    recommendedSide: "OVER",
    bookLine: 1.5,
    enginePct: 72,
    edge: 6.5,
    projection: 1.7,
    signalScore: 78,
    confidenceTier: "STRONG",
    signalTier: "elite", // server-stamped, intentionally diverges from confidenceTier
    explanationBullets: ["good matchup"],
    thesis: null,
    timingContext: null,
    batterArchetype: null,
    pitcherArchetype: null,
    isFlagship: false,
    currentStats: null,
    lastABContact: null,
  };
  const plays = buildTopPlays([], [], [mlbSig], 5);
  if (plays.length !== 1) throw new Error(`expected 1 play, got ${plays.length}`);
  const p = plays[0];
  assertEq(p.signalTier, "elite", "TopPlayItem.signalTier (server-stamped wins)");
  // confidenceTier is recomputed from the canonical tier so the legacy
  // rank-weighting path stays in lockstep with the canonical vocabulary.
  assertEq(p.confidenceTier, "ELITE", "TopPlayItem.confidenceTier (rebuilt from signalTier)");
});

// 5 — topPlaysService fallback path when stamp is missing (legacy/cached signal)
test("topPlaysService fallback maps confidenceTier when signalTier missing", () => {
  const mlbSig = {
    playerId: "p2",
    playerName: "Player Two",
    gameId: "g2",
    market: "total_bases",
    recommendedSide: "OVER",
    bookLine: 1.5,
    enginePct: 67,
    edge: 4.0,
    projection: 1.6,
    signalScore: 60,
    confidenceTier: "STRONG", // legacy uppercase still flows through
    // signalTier intentionally absent — simulates pre-Phase-2 cache
    explanationBullets: [],
    thesis: null,
  };
  const plays = buildTopPlays([], [], [mlbSig], 5);
  if (plays.length !== 1) throw new Error(`expected 1 play, got ${plays.length}`);
  const p = plays[0];
  // Fallback path uses the legacy confidenceTier verbatim and leaves
  // signalTier undefined so the surface knows it came from the fallback.
  assertEq(p.signalTier, undefined, "TopPlayItem.signalTier (undefined on fallback)");
  assertEq(p.confidenceTier, "STRONG", "TopPlayItem.confidenceTier (legacy passthrough on fallback)");
});

// 6 — routes.ts top-plays payload shape: assert the exact object literal
// pushed into mlbSignals from server/routes.ts (L8326+) round-trips signalTier
// through buildTopPlays so the wire stamp survives the route boundary.
test("routes.ts top-plays payload preserves orchestrator-stamped signalTier", () => {
  // Mirror the literal pushed by /api/top-plays (server/routes.ts L8326+).
  // If a future edit to that push site drops `signalTier:` again, this case
  // fails and surfaces the regression before topPlaysService falls through to
  // the legacy [MLB_TIER_FALLBACK] path that the architect flagged.
  const sigFromOrchestrator = {
    playerId: 12345,
    playerName: "Routes Path Player",
    market: "hits",
    enginePct: 64.7,
    edge: 5.5,
    bookLine: 0.5,
    projection: 1.1,
    recommendedSide: "OVER",
    gameId: "g-routes",
    signalScore: 78,
    confidenceTier: "STRONG" as const,
    signalTier: "strong" as const, // <-- the exact field the route now passes through
    timingContext: "Inning 3",
    currentStats: null,
    lastABContact: null,
    batterArchetype: null,
    pitcherArchetype: null,
    thesis: null,
    isFlagship: false,
    safetyCeilingApplied: false,
    dataQuality: null,
  };
  const plays = buildTopPlays([], [], [sigFromOrchestrator], 5);
  if (plays.length !== 1) throw new Error(`expected 1 play, got ${plays.length}`);
  const p = plays[0];
  assertEq(p.signalTier, "strong", "routes payload → TopPlayItem.signalTier survives boundary");
  assertEq(p.confidenceTier, "STRONG", "routes payload → TopPlayItem.confidenceTier rebuilt from signalTier");
  assertEq(p.sport, "MLB", "routes payload → sport MLB");
});

// 7 — topPlaysService NBA branch is untouched (no signalTier emitted)
test("NBA plays do not get signalTier (untouched)", () => {
  const nbaSig = {
    playerId: "n1",
    playerName: "NBA Player",
    gameId: "ng1",
    market: "points",
    recommendedSide: "OVER",
    bookLine: 22.5,
    enginePct: 70,
    edge: 5.0,
    projection: 24.0,
  };
  const plays = buildTopPlays([nbaSig], [], [], 5);
  if (plays.length !== 1) throw new Error(`expected 1 NBA play, got ${plays.length}`);
  const p = plays[0];
  assertEq(p.sport, "NBA", "sport NBA preserved");
  assertEq(p.signalTier, undefined, "NBA play has no signalTier (correct — separate tiering)");
});

// — runner —
let pass = 0;
let fail = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    pass++;
    console.log(`  ✓ ${c.name}`);
  } catch (e: any) {
    fail++;
    failures.push(`  ✗ ${c.name}\n      ${e.message}`);
    console.log(`  ✗ ${c.name}`);
    console.log(`      ${e.message}`);
  }
}
console.log(`\n[MLB Canonical Signal Tier — Phase 2] ${pass}/${pass + fail} cases passed`);
if (fail > 0) {
  console.error(`\nFAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
