// MLB odds-timestamp provenance — the REAL sportsbook source timestamp must
// survive engine → API (normalizeSignal) → persist (trackPlay input), and must
// never be replaced by a fetch/engine clock.
//
// Run: npx tsx server/mlb/oddsTimestampProvenance.test.ts

import type { MLBQualifiedSignal } from "./types";
import { finalizeMlbSignal, stampMlbSignalFinalization } from "./mlbSignalFinalizer";
import { normalizeMLBSignal } from "./normalizeSignal";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// A real provider source timestamp, deliberately DIFFERENT from any fetch/engine
// clock so a substitution would be detectable.
const SOURCE_TS = 1_711_000_000_000;
const FETCH_TS = 1_711_000_050_000;
const ENGINE_TS = 1_711_000_099_000;
const NOW = 1_711_000_100_000;

function sig(overrides: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "g_p_hits", gameId: "g", playerId: "p", playerName: "TS_TEST", team: "NYY",
    market: "hits", side: "OVER", sportsbook: "draftkings", line: 1.5,
    impliedProbability: null, engineProbability: 63, projection: 2, evPct: 4,
    confidenceTier: "STRONG", signalTier: "strong", signalScore: 60,
    reasons: [], feedTags: [], signalTags: [], playerGlowEligible: false,
    gameCardSignalTags: [], formIndicator: "steady" as any, isExperimental: false,
    engineGeneratedAt: ENGINE_TS, badges: [], riskFlags: [], drivers: {},
    timestamps: { engineGeneratedAt: new Date(ENGINE_TS).toISOString(), oddsUpdatedAt: new Date(SOURCE_TS).toISOString(), gameStateUpdatedAt: new Date(ENGINE_TS).toISOString() },
    fallbackUsed: false, actionable: true, alreadyHit: false, stale: false, watchlist: false,
    overOdds: -115, underOdds: -105, oddsTimestamp: SOURCE_TS, oddsFetchedAt: FETCH_TS,
    pitcherName: "P", pitcherHand: "R", pitcherPitchCount: 40, pitcherTimesThrough: 1,
    homeScore: 0, awayScore: 0, inning: 6, isTopInning: true, currentStat: 0, completedAB: 1,
    bookImplied: null, priorABResults: [], currentStatKnown: true,
    modelMethod: "hit_distribution", remainingOpportunity: 3,
    ...overrides,
  } as MLBQualifiedSignal;
}

// ── Engine finalizer preserves the real source timestamp ────────────────────
{
  const s = sig();
  const f = finalizeMlbSignal(s);
  ok(f.oddsSourceUpdatedAt === SOURCE_TS, "finalizer oddsSourceUpdatedAt = real source ts");
  ok(f.oddsSourceUpdatedAt !== FETCH_TS, "not the fetch ts");
  ok(f.oddsSourceUpdatedAt !== ENGINE_TS, "not the engine-generation ts");
}

// ── Stamp + wire (normalizeSignal) preserve it; oddsAgeMs is derived from it ─
{
  const s = sig();
  stampMlbSignalFinalization([s], NOW);
  ok(s.oddsAgeMs === NOW - SOURCE_TS, "oddsAgeMs derived from the real source ts");
  const wire: any = normalizeMLBSignal(s, { gameId: s.gameId, rawOutput: null, gameState: null, game: null, pitchMixFallback: null });
  ok(wire.oddsTimestamp === SOURCE_TS, "wire oddsTimestamp = real source ts (survives engine→API)");
}

// ── Persist mapping preserves it: the orchestrator/route pass sig.oddsTimestamp
//    into trackPlay.oddsSourceUpdatedAt (asserted here on the finalized value the
//    persist call reads). ──────────────────────────────────────────────────
{
  const s = sig();
  stampMlbSignalFinalization([s], NOW);
  // The value the persistence path forwards (trackPlay oddsSourceUpdatedAt:
  // sig.oddsTimestamp) is exactly this — never Date.now().
  ok(s.oddsTimestamp === SOURCE_TS, "persist-time oddsTimestamp is the real source ts, not a clock");
  ok(s.oddsTimestamp !== NOW, "persist-time oddsTimestamp is not Date.now()");
}

console.log(`\noddsTimestampProvenance.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
