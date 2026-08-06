// Pregame composition layer — response enrichment invariants.
//
// Locks: (1) enrichMoundResponseWithPlateTargets receives an ALREADY-BUILT
// MoundRadarResponse and never touches its canonical fields (score10/tier/
// moundDirection/settlementView/ordering/diagnostics/date/buildId/etc — all
// pass through byte-identical except the added plateTargetSuggestions key),
// (2) it applies Plate's own canonical publication predicate
// (isPublicPregameSignal) — not an approximation — so a signal that would
// otherwise qualify (right game/pitcher, real driver evidence) but is
// suppressed, or belongs to a postponed game, is excluded, (3) never
// mutates either input, (4) never throws on empty/missing Plate data.
//
// Run: npx tsx server/mlb/pregame/composition/enrichMoundResponse.test.ts

import { enrichMoundResponseWithPlateTargets } from "./enrichMoundResponse";
import type { MoundSignal, MoundDriver, MoundRadarResponse } from "../mound/types";
import type { PregamePowerSignal } from "../../pregamePowerRadar/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function moundSignal(overrides: Partial<MoundSignal> & { drivers: MoundDriver[] }): MoundSignal {
  const base: MoundSignal = {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "2026-07-01T00:00:00Z", buildId: "b1",
    pitcherId: "p1", pitcherName: "Test Pitcher", team: "NYY", opponent: "BOS", throws: "R",
    opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts"],
    marketScores: { pitcher_strikeouts: 7 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: null,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 6,
      recentFormScore: 6, marketFitScore: 6, contactRiskScore: 7, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [],
      dataCoverageScore: 0.9, finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    } as any,
  };
  return { ...base, ...overrides } as MoundSignal;
}

/**
 * A GENUINELY publicly-eligible Plate signal — passes the real
 * isPublicPregameSignal → wasPubliclyFlaggedPregame → decidePlatePublication
 * chain (tier power_watch+, score10 >= 6.0, 2 real July-20 driver keys,
 * dataCoverageScore >= 0.6, batterPower available, lineup posted, not
 * suppressed, not official, is a pregame target). Mirrors the exact fixture
 * pregamePowerRadar/diagnostics.test.ts uses for the same purpose — this
 * suite must exercise Plate's REAL gate, not a hand-rolled approximation.
 */
function eligiblePlateSignal(overrides: Partial<PregamePowerSignal> = {}): PregamePowerSignal {
  const base: PregamePowerSignal = {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "Test Batter", team: "BOS", opponent: "NYY",
    pitcherId: "p1", pitcherName: "Test Pitcher", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 8.5 },
    marketSetups: [], parkContext: null,
    score10: 7, tier: "strong",
    // Real July-20 driver keys — see modelVersions/plateDriverUniverse.ts.
    drivers: [
      { key: "power_iso", label: "Elite Isolated Power", direction: "positive" },
      { key: "pv_hr9", label: "Pitcher Yields HR vs RHB", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null,
    everPubliclyFlagged: false, everAttackEnvironmentSuppressed: false, attackEnvironmentSuppressedScore10: null,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
  };
  return { ...base, ...overrides } as PregamePowerSignal;
}

const CR_HIGH: MoundDriver = { key: "cr_high", label: "Hit/HR Susceptible: High", direction: "negative" };

function moundResponse(signals: MoundSignal[]): MoundRadarResponse {
  return {
    date: "2026-07-01", buildId: "moundBuild1", generatedAt: "2026-07-01T00:00:00Z", source: "memory",
    gamesScanned: 1, signals,
    diagnostics: {
      starterCoverage: 1, weatherCoverage: 1, pitcherCoverage: 1, lineupCoverage: 1,
      totalPitchersEvaluated: signals.length, publicSignals: signals.length, suppressedSignals: 0,
      topSuppressionReasons: [],
    },
  };
}

// ── 1. Genuinely eligible Plate candidate produces a suggestion ─────────────
{
  const hrSusceptible = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([hrSusceptible]);
  const enriched = enrichMoundResponseWithPlateTargets(resp, [eligiblePlateSignal()]);
  ok(enriched.signals[0].plateTargetSuggestions.length === 1, "a genuinely publicly-eligible Plate candidate produces a suggestion");
}

// ── 2. Suppressed candidate is excluded via the REAL canonical gate, not an approximation ──
{
  const hrSusceptible = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([hrSusceptible]);
  const suppressedButOtherwiseEligible = eligiblePlateSignal({ suppressed: true });
  const enriched = enrichMoundResponseWithPlateTargets(resp, [suppressedButOtherwiseEligible]);
  ok(
    enriched.signals[0].plateTargetSuggestions.length === 0,
    "a suppressed Plate signal is excluded even though every other qualification field is satisfied — proves the real isPublicPregameSignal gate runs, not a suppressed/tier approximation",
  );
}

// ── 3. Postponed game is excluded via the canonical gate ────────────────────
{
  const hrSusceptible = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([hrSusceptible]);
  const postponed = eligiblePlateSignal({ gameStatus: "postponed" });
  const enriched = enrichMoundResponseWithPlateTargets(resp, [postponed]);
  ok(enriched.signals[0].plateTargetSuggestions.length === 0, "a postponed-game Plate signal is excluded (isPublicPregameSignal's early-return)");
}

// ── Pregame-only lifecycle gate: isPublicPregameSignal alone is NOT enough ──
// isPublicPregameSignal is a visibility-AND-RETENTION predicate — it stays
// TRUE for a signal that was genuinely flagged pre-first-pitch and is now
// locked/graded during a live/final/suspended game (correct for Plate's own
// product). These cases construct a signal where isPublicPregameSignal
// itself returns true via the retention branch, then prove
// enrichMoundResponseWithPlateTargets STILL excludes it — the pregame-only
// lifecycle check is a real, additional filter, not a no-op.
{
  const hrSusceptible = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([hrSusceptible]);

  const lockedRetained = eligiblePlateSignal({ status: "locked", everPubliclyFlagged: true });
  ok(
    enrichMoundResponseWithPlateTargets(resp, [lockedRetained]).signals[0].plateTargetSuggestions.length === 0,
    "locked Plate candidate excluded (first pitch has passed, even though isPublicPregameSignal's retention branch would say visible)",
  );

  const gradedRetained = eligiblePlateSignal({ status: "graded", everPubliclyFlagged: true });
  ok(
    enrichMoundResponseWithPlateTargets(resp, [gradedRetained]).signals[0].plateTargetSuggestions.length === 0,
    "graded Plate candidate excluded",
  );

  const liveRetained = eligiblePlateSignal({ status: "locked", gameStatus: "live", everPubliclyFlagged: true });
  ok(
    enrichMoundResponseWithPlateTargets(resp, [liveRetained]).signals[0].plateTargetSuggestions.length === 0,
    "live-game Plate candidate excluded (isPublicPregameSignal would retain it; pregame-only gate does not)",
  );

  const finalRetained = eligiblePlateSignal({ status: "graded", gameStatus: "final", everPubliclyFlagged: true });
  ok(
    enrichMoundResponseWithPlateTargets(resp, [finalRetained]).signals[0].plateTargetSuggestions.length === 0,
    "final-game Plate candidate excluded",
  );

  const suspendedRetained = eligiblePlateSignal({ status: "locked", gameStatus: "suspended", everPubliclyFlagged: true });
  ok(
    enrichMoundResponseWithPlateTargets(resp, [suspendedRetained]).signals[0].plateTargetSuggestions.length === 0,
    "suspended-game Plate candidate excluded",
  );
}

// ── 4. Below publish-score-floor candidate is excluded ──────────────────────
{
  const hrSusceptible = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([hrSusceptible]);
  const belowFloor = eligiblePlateSignal({ score10: 5.9 }); // PUBLICATION_MIN_SCORE is 6.0
  const enriched = enrichMoundResponseWithPlateTargets(resp, [belowFloor]);
  ok(enriched.signals[0].plateTargetSuggestions.length === 0, "score10 below Plate's publish floor (6.0) is excluded even with real evidence and no suppression");
}

// ── 5. Unposted lineup candidate is excluded ─────────────────────────────────
{
  const hrSusceptible = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([hrSusceptible]);
  const unposted = eligiblePlateSignal({ lineupStatus: "unposted" });
  const enriched = enrichMoundResponseWithPlateTargets(resp, [unposted]);
  ok(enriched.signals[0].plateTargetSuggestions.length === 0, "unposted-lineup Plate signal is excluded");
}

// ── 6. Non-HR-susceptible Mound signal gets [] regardless of Plate data ─────
{
  const notSusceptible = moundSignal({ drivers: [{ key: "d1", label: "D1", direction: "positive" }] });
  const resp = moundResponse([notSusceptible]);
  const enriched = enrichMoundResponseWithPlateTargets(resp, [eligiblePlateSignal()]);
  ok(enriched.signals[0].plateTargetSuggestions.length === 0, "non-HR-susceptible signal gets [] even with eligible Plate candidates present");
}

// ── 7. Canonical fields pass through byte-identical (structural parity) ─────
{
  const s1 = moundSignal({ signalId: "s1", pitcherId: "p1", score10: 9.0, tier: "elite", moundDirection: "follow", drivers: [CR_HIGH] });
  const s2 = moundSignal({ signalId: "s2", gameId: "g2", pitcherId: "p2", score10: 3.0, tier: "track", moundDirection: "fade", drivers: [] });
  const resp = moundResponse([s1, s2]);
  const enriched = enrichMoundResponseWithPlateTargets(resp, [eligiblePlateSignal()]);

  const strip = (signals: any[]) => signals.map(({ plateTargetSuggestions, ...rest }) => rest);
  ok(
    JSON.stringify(strip(resp.signals)) === JSON.stringify(strip(enriched.signals)),
    "stripping plateTargetSuggestions leaves the enriched signals byte-identical to the canonical input (score10/tier/moundDirection/ordering untouched)",
  );
  ok(JSON.stringify(resp.diagnostics) === JSON.stringify(enriched.diagnostics), "response-level diagnostics are byte-identical (never touched by composition)");
  ok(
    resp.date === enriched.date && resp.buildId === enriched.buildId &&
    resp.generatedAt === enriched.generatedAt && resp.source === enriched.source &&
    resp.gamesScanned === enriched.gamesScanned,
    "top-level response envelope fields (date/buildId/generatedAt/source/gamesScanned) are byte-identical",
  );
}

// ── 8. Never mutates the input MoundRadarResponse or its signal objects ─────
{
  const s1 = moundSignal({ drivers: [CR_HIGH] });
  const resp = moundResponse([s1]);
  const respSnapshotJson = JSON.stringify(resp);
  enrichMoundResponseWithPlateTargets(resp, [eligiblePlateSignal()]);
  ok(JSON.stringify(resp) === respSnapshotJson, "input MoundRadarResponse is never mutated");
  ok((s1 as any).plateTargetSuggestions === undefined, "input MoundSignal object is never mutated with plateTargetSuggestions");
}

// ── 9. Never mutates the input Plate signal array ────────────────────────────
{
  const p = eligiblePlateSignal();
  const before = JSON.stringify(p);
  const resp = moundResponse([moundSignal({ drivers: [CR_HIGH] })]);
  enrichMoundResponseWithPlateTargets(resp, [p]);
  ok(JSON.stringify(p) === before, "input Plate signal is never mutated");
}

// ── 10. Never throws on empty Plate array or empty signals ──────────────────
ok(enrichMoundResponseWithPlateTargets(moundResponse([]), []).signals.length === 0, "empty Mound signals + empty Plate array → empty output, never throws");
ok(
  enrichMoundResponseWithPlateTargets(moundResponse([moundSignal({ drivers: [CR_HIGH] })]), []).signals[0].plateTargetSuggestions.length === 0,
  "empty Plate array with an HR-susceptible Mound signal → [], never throws",
);

console.log(`\nenrichMoundResponse.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
