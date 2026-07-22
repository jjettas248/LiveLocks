// Grade Factors DB-hydration regression — diagnostics.gradeFactorSummary must
// round-trip through signalToRow -> rowToSignal verbatim, and a legacy row's
// genuine absence must hydrate to absence, never a fabricated default.
//
// Separate from gradeFactorParity.test.ts because this file imports
// pregamePersistence.ts, which requires DATABASE_URL to be set (same
// environment dependency as the existing coexistenceDiagnostics.test.ts) —
// keeping it isolated lets the pure carryForwardGradedState/eligibility tests
// in gradeFactorParity.test.ts run standalone without a database.
//
// Run: npx tsx server/mlb/pregamePowerRadar/gradeFactorPersistence.test.ts

import { signalToRow, rowToSignal } from "./pregamePersistence";
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

function sig(gradeFactorSummary?: GradeFactorEntry[] | null): PregamePowerSignal {
  const s: PregamePowerSignal = {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [{ key: "power", label: "Elite raw power", direction: "positive" }],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "final", firstPitchLockEligible: false, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "graded", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: true, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 8, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 9, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
  };
  (s.diagnostics as any).gradeFactorSummary = gradeFactorSummary;
  return s;
}

// ── 1. signalToRow -> rowToSignal retains gradeFactorSummary verbatim ──────
// `diagnostics` round-trips through JSONB wholesale (signalToRow stores
// `s.diagnostics` verbatim; rowToSignal restores `r.diagnostics` verbatim —
// see pregamePersistence.ts:66,140), so no per-field DB wiring was needed for
// this new field — this proves it, rather than assuming it, matching the
// pattern coexistenceDiagnostics.test.ts already established for powerProfile.
{
  const original = sig(FACTORS_A);
  const hydrated = rowToSignal(signalToRow(original) as any);
  ok(
    JSON.stringify((hydrated.diagnostics as any).gradeFactorSummary) === JSON.stringify(FACTORS_A),
    "DB hydration (signalToRow -> rowToSignal) retains gradeFactorSummary verbatim",
  );
}

// ── 2. A legacy row with no gradeFactorSummary hydrates to genuine absence ──
{
  const legacy = sig(undefined);
  const hydrated = rowToSignal(signalToRow(legacy) as any);
  ok(
    (hydrated.diagnostics as any).gradeFactorSummary === undefined,
    "DB hydration of a legacy row (no gradeFactorSummary) stays genuinely absent, never fabricated",
  );
}

console.log(`\ngradeFactorPersistence.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
