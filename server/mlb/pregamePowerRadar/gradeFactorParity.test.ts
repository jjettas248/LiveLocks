// Grade Factors parity regression — diagnostics.gradeFactorSummary (PR 1) must
// coexist with every other field without affecting scoring, eligibility,
// ranking, drivers, or primaryMarket, and must freeze at lock (including its
// legacy absence) exactly like diagnostics.powerProfile already does.
//
// Run: npx tsx server/mlb/pregamePowerRadar/gradeFactorParity.test.ts

import { carryForwardGradedState } from "./gradedStateCarry";
import { isPublicPregameSignal, wasPubliclyFlaggedPregame } from "./diagnostics";
import type { GradeFactorEntry } from "./gradeFactorSummary";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const FACTORS_A: GradeFactorEntry[] = [
  { key: "pitcherVulnerability", label: "Pitcher Vulnerability", displayLabel: "High", tone: "attack", value: 8.0, impact: 0.69, direction: "positive" },
  { key: "lineupOpportunity", label: "Lineup Opportunity", displayLabel: "Excellent", tone: "supporting", value: 9.0, impact: 0.36, direction: "positive" },
  { key: "matchupPenalty", label: "Matchup Penalty", displayLabel: "Downgrade", tone: "risk", value: -0.5, impact: -0.5, direction: "negative" },
];

function sig(over: Partial<PregamePowerSignal>, gradeFactorSummary?: GradeFactorEntry[] | null): PregamePowerSignal {
  const s: PregamePowerSignal = {
    signalId: over.signalId ?? "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: over.batterId ?? "b1", batterName: over.batterName ?? "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: over.score10 ?? 7, tier: over.tier ?? "strong",
    drivers: [
      { key: "power", label: "Elite raw power", direction: "positive" },
      { key: "park", label: "HR park boost", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 8, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 9, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
  (s.diagnostics as any).gradeFactorSummary = gradeFactorSummary;
  return s;
}

// ── 1. Locked rebuild freezes gradeFactorSummary to the ORIGINAL pregame value,
//     including a legacy row's genuine absence — same discipline as powerProfile. ─
{
  const prev = sig({ everPubliclyFlagged: true }, FACTORS_A);
  const fresh = sig({ gameStatus: "final", status: "locked", firstPitchLockEligible: false }, null);
  carryForwardGradedState(fresh, prev);
  ok(
    JSON.stringify((fresh.diagnostics as any).gradeFactorSummary) === JSON.stringify(FACTORS_A),
    "locked rebuild freezes gradeFactorSummary to the original pregame value, never a post-lock recompute",
  );
}
{
  // Legacy row (prev never had the field) must NOT be backfilled by a freshly
  // computed post-lock value — absence itself is frozen, exactly like powerProfile.
  const legacyPrev = sig({ everPubliclyFlagged: true }, undefined);
  const fresh = sig({ gameStatus: "final", status: "locked", firstPitchLockEligible: false }, FACTORS_A);
  carryForwardGradedState(fresh, legacyPrev);
  ok(
    (fresh.diagnostics as any).gradeFactorSummary === undefined,
    "legacy row's genuine absence is frozen — never backfilled by a fresh post-lock computation",
  );
}

// ── 2. Presence/absence never changes score/tier/drivers/eligibility/ranking/primaryMarket ─
{
  const withFactors = [
    sig({ signalId: "a", batterId: "a", score10: 8.1, tier: "elite" }, FACTORS_A),
    sig({ signalId: "b", batterId: "b", score10: 7.0, tier: "strong" }, FACTORS_A),
    sig({ signalId: "c", batterId: "c", score10: 6.2, tier: "strong" }, null),
  ];
  const without = [
    sig({ signalId: "a", batterId: "a", score10: 8.1, tier: "elite" }, undefined),
    sig({ signalId: "b", batterId: "b", score10: 7.0, tier: "strong" }, undefined),
    sig({ signalId: "c", batterId: "c", score10: 6.2, tier: "strong" }, undefined),
  ];
  ok(withFactors.every((s, i) => wasPubliclyFlaggedPregame(s) === wasPubliclyFlaggedPregame(without[i])), "eligibility identical with vs without gradeFactorSummary");
  ok(withFactors.filter(isPublicPregameSignal).length === without.filter(isPublicPregameSignal).length, "candidate count identical");
  const rank = (a: PregamePowerSignal[]) => a.slice().sort((x, y) => y.score10 - x.score10).map((s) => s.signalId).join(",");
  ok(rank(withFactors) === rank(without), "ranking order identical");
  ok(withFactors.every((s, i) =>
    s.score10 === without[i].score10 && s.tier === without[i].tier && s.primaryMarket === without[i].primaryMarket &&
    JSON.stringify(s.drivers) === JSON.stringify(without[i].drivers) && JSON.stringify(s.marketScores) === JSON.stringify(without[i].marketScores)),
    "score/tier/drivers/marketScores/primaryMarket identical with vs without gradeFactorSummary");
}

console.log(`\ngradeFactorParity.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
