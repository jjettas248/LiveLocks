// PR0 golden-fixture canonical inputs — typed, time-frozen DB rows.
//
// These construct MINIMAL, FULLY-TYPED, deterministic persisted-row objects for
// the Plate and Mound pregame signals (the exact `$inferSelect` row shapes from
// shared/schema.ts). They feed the real, pure mapping/serialization functions
// (rowToSignal / signalToRow / buildResponse / buildMoundResponse) so the PR0
// baseline covers those observable boundaries without any database or network.
//
// This file is NOT a *.test.ts, so `tsc --noEmit` type-checks it — that is what
// makes "fully typed" an enforced guarantee, not a claim. All timestamps are
// fixed literals (no Date.now()); all ids/values are deterministic.

import type {
  PregamePowerRadarSignalRow,
  MlbMoundRadarSignalRow,
} from "../../../shared/schema";
import type { PregamePowerDiagnostics } from "../../mlb/pregamePowerRadar/types";
import type { MoundDiagnostics } from "../../mlb/pregame/mound/types";

/** Fixed instants — no wall clock anywhere in these fixtures. */
export const FROZEN_CREATED = new Date("2026-08-03T15:00:00.000Z");
export const FROZEN_UPDATED = new Date("2026-08-03T18:30:00.000Z");
export const FROZEN_LOCKED = new Date("2026-08-03T22:05:00.000Z");

// ── Plate diagnostics (fully typed — forces every required field) ─────────────

function plateDiagnostics(over: Partial<PregamePowerDiagnostics> = {}): PregamePowerDiagnostics {
  return {
    batterPowerScore: 7.6,
    pitcherVulnerabilityScore: 6.4,
    pitcherHandednessScore: 6.2,
    matchupFitScore: 6.0,
    parkWeatherScore: 6.1,
    lineupOpportunityScore: 6.0,
    marketFitScore: 6.5,
    nearHrRecentFormScore: 5.4,
    pitcherOrderSplitAvailable: true,
    pitcherOrderSplitScore: 6.0,
    pitcherOrderSplitDirection: "vulnerable",
    batterCurrentOrderSlot: 3,
    batterOrderSplitAvailable: true,
    batterOrderSplitScore: 6.2,
    batterOrderSplitDirection: "strong",
    bvpAvailable: true,
    bvpScore: 6.0,
    bvpSampleSize: 18,
    bvpDirection: "positive",
    zeroProductionBvpFlags: [],
    dataCoverageScore: 0.95,
    finalScoreBeforeCaps: 7.5,
    finalScoreAfterCaps: 7.5,
    matchupPenalty: 0,
    publicTier: "elite",
    warningTags: [],
    downgradeReasons: [],
    suppressed: false,
    suppressedReasons: [],
    sourceFreshness: {
      lineupUpdatedAt: "2026-08-03T18:00:00.000Z",
      weatherUpdatedAt: "2026-08-03T18:00:00.000Z",
      batterStatsUpdatedAt: "2026-08-03T06:00:00.000Z",
      pitcherStatsUpdatedAt: "2026-08-03T06:00:00.000Z",
    },
    rawInputsAvailable: {
      lineup: true,
      batterPower: true,
      pitcherProfile: true,
      park: true,
      weather: true,
      bvp: true,
      nearHrRecentForm: true,
    },
    ...over,
  };
}

/** A canonical, fully-typed Plate row. Overrides let each case vary one axis. */
export function makePlateRow(over: Partial<PregamePowerRadarSignalRow> = {}): PregamePowerRadarSignalRow {
  return {
    signalId: "mlb-pregame:2026-08-03:GAME1:BATTER1",
    buildId: "build_fixed_1",
    sessionDate: "2026-08-03",
    gameId: "GAME1",
    gameDate: "2026-08-03",
    startsAt: "2026-08-03T23:10:00.000Z",
    gameStatus: "final",
    firstPitchLockEligible: true,
    batterId: "BATTER1",
    batterName: "Fixture Batter",
    team: "AAA",
    opponent: "BBB",
    pitcherId: "PITCHER1",
    pitcherName: "Fixture Pitcher",
    battingOrderSlot: 3,
    primaryMarket: "home_runs",
    marketTags: ["home_runs", "total_bases"],
    marketScores: { home_runs: 7.5, total_bases: 6.8 },
    score10: "7.5",
    tier: "elite",
    drivers: [
      { key: "power_iso", label: "Elite ISO", direction: "positive", weight: 80, tier: "ELITE" },
      { key: "pitcher_vuln", label: "Vulnerable Arm", direction: "positive", weight: 60 },
    ],
    warnings: [],
    diagnostics: plateDiagnostics(),
    lineupStatus: "posted",
    weatherStatus: "confirmed",
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "graded",
    suppressed: false,
    suppressedReasons: [],
    outcomes: { hitHr: true, totalBases: 4, outcome: "pregame_win", userVisible: true },
    everPubliclyFlagged: true,
    everAttackEnvironmentSuppressed: false,
    attackEnvironmentSuppressedScore10: null,
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    createdAt: FROZEN_CREATED,
    updatedAt: FROZEN_UPDATED,
    lockedAt: FROZEN_LOCKED,
    gradedAt: null,
    ...over,
  };
}

// ── Mound diagnostics (fully typed) ───────────────────────────────────────────

function moundDiagnostics(over: Partial<MoundDiagnostics> = {}): MoundDiagnostics {
  return {
    pitcherSkillScore: 7.4,
    opponentKProfileScore: 6.5,
    workloadScore: 6.1,
    runEnvironmentScore: 6.0,
    recentFormScore: 6.0,
    marketFitScore: 6.4,
    contactRiskScore: 5.0,
    riskPenalty: 0,
    appliedDrivers: ["pitcher_skill", "k_matchup"],
    appliedWarnings: [],
    dataCoverageScore: 0.9,
    finalScoreBeforeCaps: 6.9,
    finalScoreAfterCaps: 6.9,
    publicTier: "strong",
    suppressed: false,
    suppressedReasons: [],
    sourceFreshness: {
      lineupUpdatedAt: "2026-08-03T18:00:00.000Z",
      weatherUpdatedAt: "2026-08-03T18:00:00.000Z",
      pitcherStatsUpdatedAt: "2026-08-03T06:00:00.000Z",
    },
    rawInputsAvailable: {
      confirmedStarter: true,
      confirmedOpposingLineup: true,
      pitcherSeasonStats: true,
      pitcherHandednessSplits: true,
      pitcherRecentStarts: true,
      pitcherStuffMetrics: true,
      park: true,
      weather: true,
    },
    ...over,
  };
}

/** A canonical, fully-typed Mound row. */
export function makeMoundRow(over: Partial<MlbMoundRadarSignalRow> = {}): MlbMoundRadarSignalRow {
  return {
    signalId: "mlb-mound:2026-08-03:GAME1:PITCHER1",
    buildId: "build_fixed_1",
    sessionDate: "2026-08-03",
    gameId: "GAME1",
    gameDate: "2026-08-03",
    startsAt: "2026-08-03T23:10:00.000Z",
    gameStatus: "final",
    firstPitchLockEligible: true,
    pitcherId: "PITCHER1",
    pitcherName: "Fixture Starter",
    team: "AAA",
    opponent: "BBB",
    opposingLineupConfirmed: true,
    primaryMarket: "pitcher_strikeouts",
    marketTags: ["pitcher_strikeouts"],
    marketScores: { pitcher_strikeouts: 6.9 },
    score10: "6.9",
    tier: "strong",
    drivers: [
      { key: "pitcher_skill", label: "K Skill", direction: "positive", weight: 70 },
      { key: "k_matchup", label: "K Matchup", direction: "positive", weight: 55 },
    ],
    warnings: [],
    diagnostics: moundDiagnostics(),
    lineupStatus: "confirmed",
    weatherStatus: "confirmed",
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "graded",
    suppressed: false,
    suppressedReasons: [],
    outcomes: null,
    everPubliclyFlagged: true,
    everPubliclyFlaggedFade: false,
    moundDirection: "follow",
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    createdAt: FROZEN_CREATED,
    updatedAt: FROZEN_UPDATED,
    lockedAt: FROZEN_LOCKED,
    gradedAt: null,
    ...over,
  };
}

/** Coverage counters (shape shared by both response builders' signatures). */
export const FROZEN_COUNTERS = {
  gamesScanned: 3,
  battersEvaluated: 12,
  lineupCoverage: 1,
  weatherCoverage: 1,
  batterCoverage: 1,
  pitcherCoverage: 1,
};
