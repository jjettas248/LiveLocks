// Pre-Game Power Radar — powerProfile display snapshot invariants.
//
// The optional diagnostics.powerProfile snapshot is DISPLAY-ONLY: it must be
// inert to scoring/tier/drivers/market selection/eligibility/ranking/candidate
// count (parity), must FREEZE to the original pregame value across rebuilds
// (never a post-first-pitch recompute), and must survive the persistence row
// round trip (hydration).
//
// Run: npx tsx server/mlb/pregamePowerRadar/powerProfileSnapshot.test.ts

import { isPublicPregameSignal, wasPubliclyFlaggedPregame } from "./diagnostics";
import { carryForwardGradedState } from "./gradedStateCarry";
import { signalToRow, rowToSignal } from "./pregamePersistence";
import type { PregamePowerProfileSnapshot, PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const PROFILE_A: PregamePowerProfileSnapshot = {
  xISO: 0.24, hrFBRatioPct: 18.5, barrelRatePct: 14.2, hardHitRatePct: 48.1, maxEV: 112.4, pullRatePct: 49,
};
const PROFILE_B: PregamePowerProfileSnapshot = {
  xISO: 0.19, hrFBRatioPct: 11.0, barrelRatePct: 9.0, hardHitRatePct: 40.0, maxEV: 108.0, pullRatePct: 41,
};

function sig(over: Partial<PregamePowerSignal>, profile?: PregamePowerProfileSnapshot): PregamePowerSignal {
  const base: PregamePowerSignal = {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
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
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
  if (profile) (base.diagnostics as any).powerProfile = profile;
  return base;
}

// ── PARITY: identical scheduled/pre-first-pitch fixtures WITH vs WITHOUT the
// snapshot must be indistinguishable to scoring/eligibility/ranking. ─────────
{
  const without = [
    sig({ signalId: "a", batterName: "A", score10: 8.1, tier: "elite" }),
    sig({ signalId: "b", batterName: "B", score10: 7.0, tier: "strong" }),
    sig({ signalId: "c", batterName: "C", score10: 6.2, tier: "strong" }),
  ];
  const withPP = [
    sig({ signalId: "a", batterName: "A", score10: 8.1, tier: "elite" }, PROFILE_A),
    sig({ signalId: "b", batterName: "B", score10: 7.0, tier: "strong" }, PROFILE_B),
    sig({ signalId: "c", batterName: "C", score10: 6.2, tier: "strong" }, PROFILE_A),
  ];

  // Eligibility identical
  ok(
    without.every((s, i) => wasPubliclyFlaggedPregame(s) === wasPubliclyFlaggedPregame(withPP[i])),
    "wasPubliclyFlaggedPregame is identical with vs without the snapshot",
  );
  // Candidate count identical
  ok(
    without.filter(isPublicPregameSignal).length === withPP.filter(isPublicPregameSignal).length,
    "candidate count is identical with vs without the snapshot",
  );
  // Ranking (sort by score10 desc) identical order
  const rank = (arr: PregamePowerSignal[]) => arr.slice().sort((x, y) => y.score10 - x.score10).map((s) => s.signalId).join(",");
  ok(rank(without) === rank(withPP), "ranking order is identical with vs without the snapshot");
  // Score/tier/drivers/marketScores/primaryMarket identical field-by-field
  ok(
    without.every((s, i) =>
      s.score10 === withPP[i].score10 &&
      s.tier === withPP[i].tier &&
      s.primaryMarket === withPP[i].primaryMarket &&
      JSON.stringify(s.drivers) === JSON.stringify(withPP[i].drivers) &&
      JSON.stringify(s.marketScores) === JSON.stringify(withPP[i].marketScores)),
    "score/tier/drivers/marketScores/primaryMarket are identical with vs without the snapshot",
  );
}

// ── FREEZE boundary is `status !== "active"` (locked/graded/resolved), NOT
// firstPitchLockEligible. Once locked/graded the ORIGINAL pregame snapshot —
// value OR absence — is preserved; while active (even a delayed/unknown pregame
// row with firstPitchLockEligible:false) a rebuild may acquire/refresh it. ────

// live + locked preserves the prior VALUE.
{
  const prev = sig({ everPubliclyFlagged: true, lockedAt: "2026-07-01T20:00:00Z" }, PROFILE_A);
  const fresh = sig({ gameStatus: "live", status: "locked", firstPitchLockEligible: false }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok(JSON.stringify((fresh.diagnostics as any).powerProfile) === JSON.stringify(PROFILE_A),
    "live + locked preserves the prior pregame snapshot value (frozen A, not the fresh B)");
}
// live + locked preserves the prior ABSENCE.
{
  const prev = sig({ everPubliclyFlagged: true }); // legacy: no profile
  const fresh = sig({ gameStatus: "live", status: "locked", firstPitchLockEligible: false }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok((fresh.diagnostics as any).powerProfile === undefined,
    "live + locked preserves the prior ABSENCE (legacy row stays 'unavailable', fresh B discarded)");
}
// final + graded preserves the prior VALUE.
{
  const prev = sig({ everPubliclyFlagged: true, status: "graded" }, PROFILE_A);
  const fresh = sig({ gameStatus: "final", status: "graded", firstPitchLockEligible: false }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok(JSON.stringify((fresh.diagnostics as any).powerProfile) === JSON.stringify(PROFILE_A),
    "final + graded preserves the prior pregame snapshot value (frozen A)");
}
// final + graded preserves the prior ABSENCE.
{
  const prev = sig({ everPubliclyFlagged: true, status: "graded" }); // legacy: no profile
  const fresh = sig({ gameStatus: "final", status: "graded", firstPitchLockEligible: false }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok((fresh.diagnostics as any).powerProfile === undefined,
    "final + graded preserves the prior ABSENCE (legacy row stays 'unavailable')");
}

// ── ACTIVE PREGAME ACQUIRE — a row that has NOT locked may acquire/refresh the
// additive snapshot even when firstPitchLockEligible is false (delayed/unknown). ─
{
  // delayed + active + firstPitchLockEligible:false → may acquire
  const prev = sig({ everPubliclyFlagged: false }); // no profile
  const fresh = sig({ gameStatus: "delayed", status: "active", firstPitchLockEligible: false }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok(JSON.stringify((fresh.diagnostics as any).powerProfile) === JSON.stringify(PROFILE_B),
    "delayed + active (firstPitchLockEligible:false) may still ACQUIRE the pregame snapshot");
}
{
  // unknown + active + firstPitchLockEligible:false → may refresh A→B
  const prev = sig({ everPubliclyFlagged: false }, PROFILE_A);
  const fresh = sig({ gameStatus: "unknown", status: "active", firstPitchLockEligible: false }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok(JSON.stringify((fresh.diagnostics as any).powerProfile) === JSON.stringify(PROFILE_B),
    "unknown + active (firstPitchLockEligible:false) may still REFRESH the pregame snapshot");
}
{
  // scheduled + active → may acquire (baseline pregame case)
  const prev = sig({ everPubliclyFlagged: false });
  const fresh = sig({ gameStatus: "scheduled", status: "active", firstPitchLockEligible: true }, PROFILE_B);
  carryForwardGradedState(fresh, prev);
  ok(JSON.stringify((fresh.diagnostics as any).powerProfile) === JSON.stringify(PROFILE_B),
    "scheduled + active may acquire the additive snapshot (not frozen yet)");
}

// ── HYDRATION: the profile survives the persistence row round trip ──────────
{
  const original = sig({ everPubliclyFlagged: true, status: "graded", outcomes: { hitHr: true, totalBases: 4, outcome: "pregame_win", userVisible: true } as any }, PROFILE_A);
  const row = signalToRow(original);
  const hydrated = rowToSignal(row as any);
  ok(
    JSON.stringify((hydrated.diagnostics as any).powerProfile) === JSON.stringify(PROFILE_A),
    "powerProfile survives the signalToRow → rowToSignal round trip (JSONB hydration)",
  );
}

// ── HYDRATION of a LEGACY absence: a locked row frozen to ABSENT stays absent
// through the row round trip — the card keeps rendering "unavailable". ───────
{
  const prev = sig({ everPubliclyFlagged: true }); // legacy: no profile
  const fresh = sig({ gameStatus: "final", status: "graded", firstPitchLockEligible: false,
    outcomes: { hitHr: false, totalBases: 1, outcome: "calibration_miss", userVisible: false } as any }, PROFILE_B);
  carryForwardGradedState(fresh, prev); // freezes to absent
  const hydrated = rowToSignal(signalToRow(fresh) as any);
  ok(
    (hydrated.diagnostics as any).powerProfile === undefined,
    "a legacy locked row's ABSENT powerProfile stays absent across the row round trip (renders 'unavailable')",
  );
}

console.log(`\npowerProfileSnapshot.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
