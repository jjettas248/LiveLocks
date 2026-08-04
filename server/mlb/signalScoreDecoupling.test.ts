// MLB Live Edge safety-core (Stage A A5/A6) — signalScore / HIGH_PROB_BYPASS
// have NO authority over official eligibility, probability, tier, ranking, or
// family flagship selection. Varying signalScore (and bypass-style inputs) must
// not move any finalized decision.
//
// Run: npx tsx server/mlb/signalScoreDecoupling.test.ts

import type { MLBQualifiedSignal } from "./types";
import { stampMlbSignalFinalization } from "./mlbSignalFinalizer";
import {
  deriveFinalizedTier,
  compareMlbOfficialRank,
  dataQualityRank,
  type MlbOfficialRankKey,
} from "./mlbProductionLane";
import { applyFamilySuppression } from "./marketFamily";
import { buildTopPlays } from "../services/topPlaysService";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseSignal(overrides: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "g1_p1_hits", gameId: "g1", playerId: "p1", playerName: "DECOUPLE_TEST",
    team: "NYY", market: "hits", side: "OVER", sportsbook: "draftkings", line: 1.5,
    impliedProbability: null, engineProbability: 62, projection: 2.1, evPct: 5,
    confidenceTier: "STRONG", signalTier: "strong", signalScore: 70,
    reasons: [], feedTags: [], signalTags: [], playerGlowEligible: false,
    gameCardSignalTags: [], formIndicator: "steady" as any, isExperimental: false,
    engineGeneratedAt: Date.now(), badges: [], riskFlags: [], drivers: {},
    timestamps: { engineGeneratedAt: new Date().toISOString(), oddsUpdatedAt: new Date().toISOString(), gameStateUpdatedAt: new Date().toISOString() },
    fallbackUsed: false, actionable: true, alreadyHit: false, stale: false, watchlist: false,
    overOdds: -120, underOdds: 105, oddsTimestamp: Date.now(),
    pitcherName: "P", pitcherHand: "R", pitcherPitchCount: 40, pitcherTimesThrough: 1,
    homeScore: 0, awayScore: 0, inning: 5, isTopInning: true, currentStat: 0, completedAB: 1,
    bookImplied: null, priorABResults: [], currentStatKnown: true,
    modelMethod: "hit_distribution", remainingOpportunity: 3,
    ...overrides,
  } as MLBQualifiedSignal;
}

// ── 1. Eligibility / probability / tier / lane are invariant to signalScore ──
{
  const lo = baseSignal({ signalScore: 5 });
  const hi = baseSignal({ signalScore: 99 });
  stampMlbSignalFinalization([lo], 1_000_000);
  stampMlbSignalFinalization([hi], 1_000_000);
  ok(lo.officialEligibility?.eligible === hi.officialEligibility?.eligible, "official eligibility invariant to signalScore");
  ok(lo.engineProbability === hi.engineProbability, "engine probability invariant to signalScore");
  ok(lo.signalTier === hi.signalTier, "signalTier invariant to signalScore");
  ok(lo.finalizedTier === hi.finalizedTier, "finalizedTier invariant to signalScore");
  ok(lo.lane === hi.lane, "lane invariant to signalScore");
  ok(lo.modelEdgePctPoints === hi.modelEdgePctPoints, "no-vig edge invariant to signalScore");
}

// ── 2. HIGH_PROB_BYPASS style input (low score, high prob, watchlist) cannot
//       reach official or Elite/Strong ──────────────────────────────────────
{
  // A watch/bypass entry: high probability, low signalScore, watchlist flag.
  const bypass = baseSignal({ signalScore: 1, engineProbability: 88, watchlist: true, actionable: false, market: "hits" });
  stampMlbSignalFinalization([bypass], 1_000_000);
  ok(bypass.officialEligibility?.eligible === false, "bypass watch signal is NOT official");
  ok(bypass.lane !== "official", "bypass watch signal lane is not official");
  ok(bypass.finalizedTier !== "elite" && bypass.finalizedTier !== "strong", "bypass signal never Elite/Strong despite 88% prob");
}

// ── 3. deriveFinalizedTier: provisional/watch/shadow never Elite/Strong;
//       signalScore is not even a parameter ─────────────────────────────────
{
  ok(deriveFinalizedTier({ lane: "watch", semantics: "raw_provisional", candidateProbabilityPct: 95 }) !== "elite", "watch lane never elite");
  ok(deriveFinalizedTier({ lane: "shadow", semantics: "raw_provisional", candidateProbabilityPct: 95 }) !== "strong", "shadow lane never strong");
  ok(deriveFinalizedTier({ lane: "official", semantics: "raw_provisional", candidateProbabilityPct: 95 }) === "lean", "provisional official capped at lean");
  ok(deriveFinalizedTier({ lane: "official", semantics: "outcome_calibrated", candidateProbabilityPct: 72 }) === "elite", "calibrated official can be elite");
  ok(deriveFinalizedTier({ lane: "official", semantics: "outcome_calibrated", candidateProbabilityPct: 64 }) === "strong", "calibrated official strong band");
  ok(deriveFinalizedTier({ lane: "official", semantics: "outcome_calibrated", candidateProbabilityPct: 50 }) === "watch", "low prob → watch");
}

// ── 4. Official ranking: candidate probability → no-vig edge → freshness ─────
{
  const A: MlbOfficialRankKey = { candidateProbabilityPct: 60, modelEdgePctPoints: 3, oddsAgeMs: 5000, dataQualityRank: dataQualityRank("full") };
  const B: MlbOfficialRankKey = { candidateProbabilityPct: 65, modelEdgePctPoints: 1, oddsAgeMs: 5000, dataQualityRank: dataQualityRank("full") };
  ok(compareMlbOfficialRank(A, B) > 0, "higher probability ranks first (B before A)");

  const C: MlbOfficialRankKey = { candidateProbabilityPct: 62, modelEdgePctPoints: 2, oddsAgeMs: 5000, dataQualityRank: 3 };
  const D: MlbOfficialRankKey = { candidateProbabilityPct: 62, modelEdgePctPoints: 5, oddsAgeMs: 5000, dataQualityRank: 3 };
  ok(compareMlbOfficialRank(C, D) > 0, "equal prob → higher no-vig edge first (D before C)");

  const E: MlbOfficialRankKey = { candidateProbabilityPct: 62, modelEdgePctPoints: 3, oddsAgeMs: 20000, dataQualityRank: 3 };
  const F: MlbOfficialRankKey = { candidateProbabilityPct: 62, modelEdgePctPoints: 3, oddsAgeMs: 2000, dataQualityRank: 3 };
  ok(compareMlbOfficialRank(E, F) > 0, "equal prob+edge → fresher odds first (F before E)");
}

// ── 5. Family flagship is signalScore-free: highest candidate probability wins
//       even when signalScore points the other way ────────────────────────
{
  // Two siblings in the pitcherK family, same player. The LOWER signalScore has
  // the HIGHER candidate probability — it must still be the flagship.
  const members = [
    { playerId: "px", market: "pitcher_strikeouts" as const, side: "OVER", signalScore: 95, engineProbability: 58, edge: 2 },
    { playerId: "px", market: "pitcher_outs" as const, side: "OVER", signalScore: 20, engineProbability: 71, edge: 1 },
  ];
  const enriched = applyFamilySuppression(members);
  const flagship = enriched.find((m) => m.familyResult.isFlagship);
  ok(flagship?.market === "pitcher_outs", "flagship = higher-probability sibling, not higher signalScore");
}

// ── 6. Public top-plays MLB ordering is invariant to signalScore ────────────
{
  const wire = (over: number, score: number, id: string) => ({
    playerId: id, market: "hits", playerName: id, gameId: "g", recommendedSide: "OVER",
    bookLine: 1.5, enginePct: over, projection: 2, signalScore: score,
    signalTier: "lean", confidenceTier: "SOLID", modelEdgePctPoints: 3, oddsAgeMs: 5000,
    lane: "official", isFlagship: false,
  });
  // Same probabilities/edges, opposite signalScores → order must be identical.
  const asc = buildTopPlays([], [], [wire(70, 10, "A"), wire(60, 90, "B")], 10);
  const desc = buildTopPlays([], [], [wire(70, 90, "A"), wire(60, 10, "B")], 10);
  ok(asc.map((p) => p.playerOrTeam).join(",") === desc.map((p) => p.playerOrTeam).join(","), "MLB order invariant to signalScore");
  ok(asc[0].playerOrTeam === "A", "higher-probability MLB play ranks first regardless of signalScore");
}

console.log(`\nsignalScoreDecoupling.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
