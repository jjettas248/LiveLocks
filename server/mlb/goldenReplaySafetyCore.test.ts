// MLB Live Edge safety-core — golden replay of the known production failures.
// Each fixture reproduces a documented defect from the -35.28u sample and
// asserts it can NEVER surface as an official prediction after Stage A.
//
// Run: npx tsx server/mlb/goldenReplaySafetyCore.test.ts

import type { MLBQualifiedSignal } from "./types";
import { stampMlbSignalFinalization } from "./mlbSignalFinalizer";
import { getMarketFamily } from "./signalScore";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = 2_000_000_000_000;
function sig(overrides: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "g_p_m", gameId: "g", playerId: "p", playerName: "GOLDEN", team: "NYY",
    market: "hits", side: "OVER", sportsbook: "draftkings", line: 1.5,
    impliedProbability: null, engineProbability: 62, projection: 2.1, evPct: 5,
    confidenceTier: "STRONG", signalTier: "strong", signalScore: 70,
    reasons: [], feedTags: [], signalTags: [], playerGlowEligible: false,
    gameCardSignalTags: [], formIndicator: "steady" as any, isExperimental: false,
    engineGeneratedAt: NOW, badges: [], riskFlags: [], drivers: {},
    timestamps: { engineGeneratedAt: new Date(NOW).toISOString(), oddsUpdatedAt: new Date(NOW).toISOString(), gameStateUpdatedAt: new Date(NOW).toISOString() },
    fallbackUsed: false, actionable: true, alreadyHit: false, stale: false, watchlist: false,
    overOdds: -115, underOdds: -105, oddsTimestamp: NOW - 5000,
    pitcherName: "P", pitcherHand: "R", pitcherPitchCount: 40, pitcherTimesThrough: 1,
    homeScore: 0, awayScore: 0, inning: 5, isTopInning: true, currentStat: 0, completedAB: 1,
    bookImplied: null, priorABResults: [], currentStatKnown: true,
    modelMethod: "hit_distribution", remainingOpportunity: 3,
    ...overrides,
  } as MLBQualifiedSignal;
}

function laneOf(s: MLBQualifiedSignal): string | null | undefined {
  stampMlbSignalFinalization([s], NOW);
  return s.lane;
}

// 1. Zeroed pitcher state producing a fake confident UNDER — currentStatKnown
//    false ⇒ never official.
{
  const s = sig({ market: "pitcher_strikeouts", side: "UNDER", currentStatKnown: false, engineProbability: 80, inning: 6 });
  ok(laneOf(s) !== "official", "zeroed pitcher UNDER cannot be official");
}

// 2. Total-bases first-AB double contamination — TB is a shadow market ⇒ never
//    official regardless of an inflated probability.
{
  const s = sig({ market: "total_bases", engineProbability: 85, inning: 6, modelMethod: "tb_distribution" });
  ok(laneOf(s) === "shadow", "total_bases contamination stays shadow, never official");
}

// 3. HRR solo/productive-AB rate explosion — HRR is shadow ⇒ never official.
{
  const s = sig({ market: "hrr", engineProbability: 88, inning: 6 });
  ok(laneOf(s) === "shadow", "hrr rate explosion stays shadow");
}

// 4. Cap clusters (72/74/88) presented as calibrated — a cap-applied signal
//    fails the evidence invariants ⇒ never official.
{
  const s = sig({ market: "hits", engineProbability: 74, inning: 6, safetyCeilingApplied: true });
  ok(laneOf(s) !== "official", "cap-applied signal cannot be official");
}

// 5. Early-inning (1-3) score promotion — innings 1-3 never official.
{
  const s = sig({ market: "hits", engineProbability: 80, inning: 2 });
  ok(laneOf(s) !== "official", "innings 1-3 never official");
}

// 6. Pitcher OVER routed through the UNDER scorer/family — must get its own
//    family, never "under".
{
  ok(getMarketFamily("pitcher_strikeouts", "OVER") === "pitcher_over", "pitcher OVER never routed through under family");
  ok(getMarketFamily("pitcher_outs", "OVER") !== "under", "pitcher_outs OVER not under");
}

// 7. Pushable integer line — non-official until a win/push/loss model exists.
{
  const s = sig({ market: "hits", line: 2, overOdds: -110, underOdds: -110, inning: 6 });
  ok(laneOf(s) !== "official", "integer/pushable line cannot be official");
}

// 8. A legitimately strong hits play (innings 4+, fresh two-sided price,
//    non-integer line, real distribution) STILL reaches official — the feed is
//    fail-closed, not closed-shut.
{
  const s = sig({ market: "hits", engineProbability: 66, inning: 6, line: 1.5, currentStat: 0, remainingOpportunity: 3 });
  ok(laneOf(s) === "official", "a valid hits play still reaches official (provisional)");
}

console.log(`\ngoldenReplaySafetyCore.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
