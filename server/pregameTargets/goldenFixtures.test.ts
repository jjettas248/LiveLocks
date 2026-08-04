// PR0 golden-fixture baseline — observable-boundary behavior lock.
//
// Run (verify):  npx tsx server/pregameTargets/goldenFixtures.test.ts
// Run (record):  GOLDEN_RECORD=1 npx tsx server/pregameTargets/goldenFixtures.test.ts
//
// WHAT THIS IS (PR0 corrections #2, #3, #6, #7)
// ---------------------------------------------
// A non-production-change baseline that freezes the CURRENT observable output
// of the pure engine / scoring / grading functions the NBA + NFL pregame-targets
// program will build on top of. Golden INPUTS are committed deterministic
// literals below; golden OUTPUTS are committed JSON under __fixtures__/. The
// test recomputes and asserts byte-equality against the committed JSON, so any
// unintended change to current behavior (or float precision) trips the guard.
//
// Everything here runs with NO network, NO database, and NO credentials.
//
// WHAT THIS IS NOT (correction #3 — do not overclaim pipeline coverage)
// ---------------------------------------------------------------------
// This captures FUNCTION-LEVEL boundaries only. It does NOT exercise the full
// build pipelines, serialized HTTP responses, DB round-trips, the live decision
// (odds) layer, or live grading feeds — those require external services and are
// enumerated as uncaptured boundaries in __fixtures__/README.md. Do not read a
// green run here as end-to-end coverage.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The Plate/Mound persistence modules import `storage` -> `db`, whose module
// guard throws unless DATABASE_URL is set. The mapping functions themselves are
// PURE (no query), and node-postgres opens a connection lazily (only on a real
// query, which never happens here). We set a FIXED, UNREACHABLE dummy URL purely
// to pass that import guard — NO database is contacted, no credential is read,
// and the result stays fully deterministic. Persistence is imported dynamically
// (below, in main) so this assignment runs before that import evaluates.
process.env.DATABASE_URL ??= "postgres://fixture:fixture@240.0.0.1:1/fixture";

import { finalizeNbaProbability, type FinalizerContext } from "../nba/probabilityFinalizer";
import { computeProbability, type EngineInput } from "../nba/probabilityEngine";
import { processNBAEngine, type NBAEngineCandidate } from "../engines/nba/index";
import {
  composePregameScore,
  classifyTier,
  tierFromScore,
  type ScoringComponents,
  type ScoringFlags,
} from "../mlb/pregamePowerRadar/scoring";
import {
  composeMoundScore,
  classifyMoundTier,
  type MoundScoringComponents,
  type MoundScoringFlags,
} from "../mlb/pregame/mound/scoring";
import { computeMoundDirection, type MoundDirectionInputs } from "../mlb/pregame/mound/moundDirection";
import {
  deriveMoundOutcome,
  deriveMoundMarketOutcome,
  deriveModelOutcomeLabel,
  type MoundOutcomeAttributionInput,
  type MoundMarketOutcomeInput,
} from "../mlb/pregame/mound/moundOutcomeAttribution";
import { buildResponse } from "../mlb/pregamePowerRadar/diagnostics";
import { buildMoundResponse } from "../mlb/pregame/mound/diagnostics";
import { deriveWinAttribution } from "../mlb/pregamePowerRadar/winAttribution";
import { canonicalize, ok, eqStable, summary } from "./__fixtures__/canonicalize";
import { makePlateRow, makeMoundRow, FROZEN_COUNTERS } from "./__fixtures__/signalFactories";

const FIXTURE_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const RECORD = process.env.GOLDEN_RECORD === "1";

type CaseMap = Record<string, unknown>;

/** Verify a group's cases against its committed golden JSON (or record it). */
function checkGroup(group: string, cases: CaseMap): void {
  const path = `${FIXTURE_DIR}${group}.json`;
  const actual = canonicalize(cases);
  if (RECORD || !existsSync(path)) {
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(actual, null, 2) + "\n", "utf8");
    console.log(`● recorded ${group}.json (${Object.keys(cases).length} cases)`);
    return;
  }
  const expected = JSON.parse(readFileSync(path, "utf8"));
  eqStable(actual, expected, `${group}: matches committed golden fixture`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Input builders (deterministic, canonically ordered)
// ─────────────────────────────────────────────────────────────────────────────

function finalizerCtx(o: Partial<FinalizerContext> = {}): FinalizerContext {
  return {
    rawSide: "OVER",
    market: "points",
    archetype: "stable_star",
    fragilityScore: 0,
    isPlayoffs: false,
    minutesCertainty: 0.9,
    projectionDeltaPct: 0.1,
    edgeFromGapOnly: false,
    freshOdds: true,
    ...o,
  };
}

function engineInput(o: Partial<EngineInput> = {}): EngineInput {
  return {
    playerName: "Fixture Player",
    playerId: 1001,
    gameId: "GAME_FIXTURE_1",
    market: "points",
    line: 24.5,
    archetype: "stable_star",
    rateRecent: { points: 0.85, rebounds: 0.18, assists: 0.22 },
    rateSeason: { points: 0.8, rebounds: 0.2, assists: 0.24 },
    rateRole: { points: 0.82, rebounds: 0.19, assists: 0.23 },
    recentGameCount: 10,
    varianceRateRecent: { points: 0.9, rebounds: 0.5, assists: 0.6 },
    varianceRateSeason: { points: 0.85, rebounds: 0.55, assists: 0.62 },
    varianceRateRole: { points: 0.88, rebounds: 0.52, assists: 0.6 },
    minutes: { expected: 34, variance: 12 },
    currentStat: 0,
    minutesPlayed: 0,
    fragilityInputs: {
      normalizedMinutesVariance: 0.1,
      roleUncertainty: 0.1,
      lineupInstability: 0.1,
      blowoutRisk: 0.1,
      usageShock: 0.1,
      lateSeasonChaos: 0.1,
    },
    oddsAgeSec: 60,
    ...o,
  };
}

function plateComponents(o: Partial<ScoringComponents> = {}): ScoringComponents {
  return {
    batterPowerScore: 7.5,
    pitcherVulnerabilityScore: 6.5,
    matchupFitScore: 6.0,
    parkWeatherScore: 6.0,
    lineupOpportunityScore: 6.0,
    nearHrRecentFormScore: 5.0,
    bvpModifier: 0,
    ...o,
  };
}

function plateFlags(o: Partial<ScoringFlags> = {}): ScoringFlags {
  return {
    batterPowerAvailable: true,
    pitcherProfileAvailable: true,
    confirmedLineup: true,
    parkAvailable: true,
    weatherAvailable: true,
    bvpAvailable: true,
    parkIsOnlyPositiveDriver: false,
    positiveDriverCount: 3,
    attackEnvironmentTier: "FAVORABLE",
    attackEnvironmentEliminationEligible: false,
    ...o,
  };
}

function moundComponents(o: Partial<MoundScoringComponents> = {}): MoundScoringComponents {
  return {
    pitcherSkillScore: 7.5,
    opponentKProfileScore: 6.5,
    workloadScore: 6.0,
    runEnvironmentScore: 6.0,
    recentFormScore: 6.0,
    riskPenalty: 0,
    ...o,
  };
}

function moundFlags(o: Partial<MoundScoringFlags> = {}): MoundScoringFlags {
  return {
    pitcherSkillAvailable: true,
    confirmedStarter: true,
    confirmedOpposingLineup: true,
    parkAvailable: true,
    weatherAvailable: true,
    positiveDriverCount: 3,
    ...o,
  };
}

function directionInputs(o: Partial<MoundDirectionInputs> = {}): MoundDirectionInputs {
  return {
    tier: "strong",
    pitcherSkillScore: 7.0,
    dataCoverageScore: 0.8,
    opposingLineupConfirmed: true,
    pitcherSeasonStatsAvailable: true,
    primaryMarket: "pitcher_strikeouts",
    seasonKPer9: 9.0,
    seasonAvgInningsPerStart: 5.5,
    ...o,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 1 — NBA final-probability calibrator (pure)
// ─────────────────────────────────────────────────────────────────────────────

function nbaFinalizeCases(): CaseMap {
  return {
    elite_pass_80: finalizeNbaProbability(0.8, finalizerCtx()),
    hard_ceiling_82: finalizeNbaProbability(0.95, finalizerCtx()),
    low_volume_cap_72: finalizeNbaProbability(0.85, finalizerCtx({ market: "steals" })),
    combo_cap_76: finalizeNbaProbability(0.85, finalizerCtx({ market: "pts_reb", fragilityScore: 0.35 })),
    volatile_cap_70: finalizeNbaProbability(0.8, finalizerCtx({ archetype: "bench_microwave" })),
    // Edge: stale/undefined odds (null behavior) — elite gate fires.
    stale_odds_gate: finalizeNbaProbability(0.85, finalizerCtx({ freshOdds: false })),
    // Edge: role change → role_uncertain archetype cap.
    role_uncertain_cap: finalizeNbaProbability(0.8, finalizerCtx({ archetype: "role_uncertain" })),
    // Edge: contradictory signal — conflicting side suppressed.
    conflict_survivor_68: finalizeNbaProbability(0.75, finalizerCtx({ conflictingSideSuppressed: true })),
    // Edge: clamp boundaries.
    clamp_low_1pp: finalizeNbaProbability(0.01, finalizerCtx()),
    clamp_high_99pp: finalizeNbaProbability(0.99, finalizerCtx()),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 2 — NBA projection engine (pure; no timestamps in output)
// ─────────────────────────────────────────────────────────────────────────────

function nbaComputeProbabilityCases(): CaseMap {
  return {
    single_points_normal: computeProbability(engineInput()),
    combo_pts_reb: computeProbability(engineInput({ market: "pts_reb", line: 40.5 })),
    // Edge: zero / low sample — recentGameCount < 5 shifts blend weights.
    low_sample_recent2: computeProbability(engineInput({ recentGameCount: 2 })),
    // Edge: ACTUAL zero sample — recentGameCount 0 (no recent games at all).
    zero_sample_recent0: computeProbability(engineInput({ recentGameCount: 0 })),
    // Edge: missing rate family (null behavior) — assists rates absent.
    missing_assist_rates: computeProbability(
      engineInput({
        market: "assists",
        line: 6.5,
        rateRecent: { points: 0.85 },
        rateSeason: { points: 0.8 },
        rateRole: { points: 0.82 },
      }),
    ),
    // Edge: role change — role_uncertain archetype widens variance.
    role_uncertain: computeProbability(engineInput({ archetype: "role_uncertain" })),
    // Edge: contradictory — recent well above season.
    contradictory_recent_hot: computeProbability(
      engineInput({ rateRecent: { points: 1.2 }, rateSeason: { points: 0.6 }, rateRole: { points: 0.65 } }),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 3 — NBA engine wrapper (Date.now() fields normalized via canonicalize)
// ─────────────────────────────────────────────────────────────────────────────

function candidate(o: Partial<NBAEngineCandidate> = {}): NBAEngineCandidate {
  // id + createdAt pinned so only top-level timestamp/dataFreshness stay volatile.
  return {
    id: "cand-fixed",
    playerId: "1001",
    playerName: "Fixture Player",
    team: "AAA",
    market: "points",
    line: 24.5,
    projection: 27.1,
    probability: 78,
    edge: 6,
    recommendedSide: "OVER",
    sportsbook: "consensus",
    gameId: "GAME_FIXTURE_1",
    createdAt: 1000,
    ...o,
  };
}

function nbaEngineWrapperCases(): CaseMap {
  return {
    strict_pass: processNBAEngine([candidate({ id: "c1" })]),
    // Edge: invalid candidates (missing line/prob/edge = null behavior) filtered.
    filters_invalid: processNBAEngine([
      candidate({ id: "c2", probability: null }),
      candidate({ id: "c3", edge: null }),
      candidate({ id: "c4", line: null }),
      candidate({ id: "c5" }),
    ]),
    // Edge: fallback path — all below strict edge, above fallback.
    fallback_low_edge: processNBAEngine([candidate({ id: "c6", edge: 3, probability: 60 })]),
    // Edge: deterministic ordering across multiple valid candidates.
    ordering_multi: processNBAEngine([
      candidate({ id: "cA", edge: 6, probability: 78 }),
      candidate({ id: "cB", edge: 9, probability: 80 }),
      candidate({ id: "cC", edge: 5, probability: 72 }),
    ]),
    empty: processNBAEngine([]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 4 — MLB Plate scoring/tier (pure)
// ─────────────────────────────────────────────────────────────────────────────

function mlbPlateScoringCases(): CaseMap {
  return {
    elite_setup: composePregameScore(plateComponents(), plateFlags()),
    // Power alone with weak pitcher → power_watch (not elite).
    power_watch: composePregameScore(
      plateComponents({ pitcherVulnerabilityScore: 4.0 }),
      plateFlags(),
    ),
    // Edge: missing batter power → hard cap 3.9.
    missing_batter_power: composePregameScore(
      plateComponents(),
      plateFlags({ batterPowerAvailable: false }),
    ),
    // Edge: low data coverage cap.
    low_coverage: composePregameScore(
      plateComponents(),
      plateFlags({ confirmedLineup: false, parkAvailable: false, weatherAvailable: false, bvpAvailable: false }),
    ),
    // Direct tier classifiers.
    tierFromScore_ladder: {
      nuclear: tierFromScore(9.0),
      elite: tierFromScore(7.6),
      strong: tierFromScore(6.1),
      watch: tierFromScore(4.5),
      track: tierFromScore(2.0),
    },
    classifyTier_gated: classifyTier(7.5, 7.2, 6.2, false, "FAVORABLE"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 5 — MLB Mound scoring/tier (pure)
// ─────────────────────────────────────────────────────────────────────────────

function mlbMoundScoringCases(): CaseMap {
  return {
    elite_setup: composeMoundScore(moundComponents(), moundFlags()),
    strong_setup: composeMoundScore(moundComponents({ pitcherSkillScore: 6.5 }), moundFlags()),
    // Edge: unconfirmed starter → hard cap 3.9.
    unconfirmed_starter: composeMoundScore(
      moundComponents(),
      moundFlags({ confirmedStarter: false }),
    ),
    // Edge: missing pitcher skill → hard cap 3.9.
    missing_skill: composeMoundScore(
      moundComponents(),
      moundFlags({ pitcherSkillAvailable: false }),
    ),
    classifyMoundTier_ladder: {
      nuclear: classifyMoundTier(9.0, 7.5, 6.5),
      elite: classifyMoundTier(7.5, 7.2, 5.8),
      strong: classifyMoundTier(6.0, 6.0, 5.0),
      watch: classifyMoundTier(4.5, 5.0, 4.0),
      track: classifyMoundTier(2.0, 3.0, 3.0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 6 — MLB Mound Fade/Follow direction (pure)
// ─────────────────────────────────────────────────────────────────────────────

function mlbMoundDirectionCases(): CaseMap {
  return {
    follow_strong: computeMoundDirection(directionInputs({ tier: "strong" })),
    follow_elite: computeMoundDirection(directionInputs({ tier: "elite" })),
    fade_track_with_baseline: computeMoundDirection(directionInputs({ tier: "track" })),
    // Edge: track but no settlement baseline (null K/9) → null direction (ungradeable fade).
    null_track_no_baseline: computeMoundDirection(
      directionInputs({ tier: "track", seasonKPer9: null }),
    ),
    // Edge: strong but degraded data → not a follow.
    null_strong_low_coverage: computeMoundDirection(
      directionInputs({ tier: "strong", dataCoverageScore: 0.4 }),
    ),
    // Edge: outs market uses innings baseline gate.
    fade_outs_market: computeMoundDirection(
      directionInputs({ tier: "track", primaryMarket: "pitcher_outs", seasonKPer9: null }),
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group 7 — MLB Mound grading outcomes: push / DNP / missing / correction
// ─────────────────────────────────────────────────────────────────────────────

function outcomeInput(o: Partial<MoundOutcomeAttributionInput> = {}): MoundOutcomeAttributionInput {
  return {
    primaryMarket: "pitcher_strikeouts",
    finalStrikeouts: 7,
    finalOutsRecorded: 18,
    seasonKPer9: 9.0,
    seasonAvgInningsPerStart: 5.5,
    wasPubliclyFlagged: true,
    moundDirection: "follow",
    ...o,
  };
}

function marketInput(o: Partial<MoundMarketOutcomeInput> = {}): MoundMarketOutcomeInput {
  return {
    moundDirection: "follow",
    frozenLine: { line: 6.5, lineUnavailableReason: null, sportsbook: "draftkings" },
    lineFrozenAt: "2026-08-03T18:00:00.000Z",
    actual: 7,
    ...o,
  };
}

function mlbMoundGradingCases(): CaseMap {
  return {
    // Model-baseline outcomes
    model_follow_cash: deriveMoundOutcome(outcomeInput({ finalStrikeouts: 8 })),
    model_follow_miss: deriveMoundOutcome(outcomeInput({ finalStrikeouts: 3 })),
    model_fade_cash: deriveMoundOutcome(outcomeInput({ moundDirection: "fade", finalStrikeouts: 3 })),
    // Edge: DNP / inactive (null final) → calibration_miss, not visible.
    model_dnp_null_final: deriveMoundOutcome(outcomeInput({ finalStrikeouts: null })),
    // Edge: missing baseline (null season K/9) → calibration_miss.
    model_missing_baseline: deriveMoundOutcome(outcomeInput({ seasonKPer9: null })),

    // Market outcomes (the only lane allowed to say cashed/missed/push)
    market_cashed: deriveMoundMarketOutcome(marketInput({ actual: 7 })),
    market_missed: deriveMoundMarketOutcome(marketInput({ actual: 5 })),
    // Edge: PUSH — actual exactly equals the frozen line.
    market_push: deriveMoundMarketOutcome(marketInput({ frozenLine: { line: 7, lineUnavailableReason: null }, actual: 7 })),
    // Edge: DNP / inactive → unavailable + no_final_stat.
    market_dnp_null_actual: deriveMoundMarketOutcome(marketInput({ actual: null })),
    // Edge: no line posted → unavailable + no_line_posted.
    market_no_line: deriveMoundMarketOutcome(marketInput({ frozenLine: { line: null, lineUnavailableReason: null } })),
    // Edge: market has no line source (pitcher_outs permanent state).
    market_no_source: deriveMoundMarketOutcome(marketInput({ frozenLine: { line: null, lineUnavailableReason: "no_data_source" } })),
    // Edge: null direction → unavailable + no_edge (no side ever recommended).
    market_null_direction: deriveMoundMarketOutcome(marketInput({ moundDirection: null })),

    // Edge: STAT CORRECTION — same inputs, corrected final flips the result.
    correction_before: deriveMoundMarketOutcome(marketInput({ actual: 6 })), // under 6.5 → missed
    correction_after: deriveMoundMarketOutcome(marketInput({ actual: 8 })), // corrected → cashed

    // Model label (exposes the exact-tie "push" case, display-only)
    label_confirmed: deriveModelOutcomeLabel(8, 6, "follow"),
    label_tie_push: deriveModelOutcomeLabel(6, 6, "follow"),
    label_null: deriveModelOutcomeLabel(null, 6, "follow"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Group 8 — Plate win attribution (pure)
// ─────────────────────────────────────────────────────────────────────────────

function plateWinAttributionCases(): CaseMap {
  return {
    hit_public_win: deriveWinAttribution({ hitHr: true, wasPubliclyFlagged: true }),
    hit_not_public: deriveWinAttribution({ hitHr: true, wasPubliclyFlagged: false }),
    miss_calibration: deriveWinAttribution({ hitHr: false, wasPubliclyFlagged: true }),
    // firstAb resolved from ordered ABs.
    hit_first_ab: deriveWinAttribution({
      hitHr: true,
      wasPubliclyFlagged: true,
      priorABResults: [{ hitType: "home_run", inning: 1, half: "top" }],
    }),
    // firstAb=false: HR in a later AB.
    hit_third_ab: deriveWinAttribution({
      hitHr: true,
      wasPubliclyFlagged: true,
      priorABResults: [
        { hitType: "single", inning: 1, half: "top" },
        { hitType: "double", inning: 3, half: "top" },
        { hitType: "home_run", inning: 6, half: "top" },
      ],
    }),
    // Edge: unknown firstAb — no AB-sequencing data, only a play-feed inning.
    hit_unknown_first_ab: deriveWinAttribution({
      hitHr: true,
      wasPubliclyFlagged: true,
      hrPlayInning: 5,
      hrPlayHalf: "bottom",
    }),
  };
}

async function main(): Promise<void> {
  // Pure engine/scoring/grading groups (no DB import needed).
  checkGroup("nbaFinalize", nbaFinalizeCases());
  checkGroup("nbaComputeProbability", nbaComputeProbabilityCases());
  checkGroup("nbaEngineWrapper", nbaEngineWrapperCases());
  checkGroup("mlbPlateScoring", mlbPlateScoringCases());
  checkGroup("mlbMoundScoring", mlbMoundScoringCases());
  checkGroup("mlbMoundDirection", mlbMoundDirectionCases());
  checkGroup("mlbMoundGrading", mlbMoundGradingCases());
  checkGroup("plateWinAttribution", plateWinAttributionCases());

  // Serialized-output boundaries (buildResponse/buildMoundResponse) — pure,
  // no DB import.
  const platePublic = rowToSignalPlate(makePlateRow());
  const plateSuppressed = rowToSignalPlate(
    makePlateRow({
      signalId: "mlb-pregame:2026-08-03:GAME1:BATTER2",
      batterId: "BATTER2",
      batterName: "Suppressed Batter",
      tier: "track",
      score10: "3.0",
      status: "active",
      gameStatus: "scheduled",
      everPubliclyFlagged: false,
      suppressed: true,
      suppressedReasons: ["batter_power_missing"],
    }),
  );
  checkGroup(
    "plateBuildResponse",
    {
      public_only: buildResponse(
        "2026-08-03", "build_fixed_1", "2026-08-03T18:30:00.000Z", "rebuilt",
        [platePublic, plateSuppressed], FROZEN_COUNTERS, false,
      ),
      include_suppressed: buildResponse(
        "2026-08-03", "build_fixed_1", "2026-08-03T18:30:00.000Z", "rebuilt",
        [platePublic, plateSuppressed], FROZEN_COUNTERS, true,
      ),
    },
  );

  const moundPublic = rowToSignalMound(makeMoundRow());
  const moundSuppressed = rowToSignalMound(
    makeMoundRow({
      signalId: "mlb-mound:2026-08-03:GAME2:PITCHER2",
      gameId: "GAME2",
      pitcherId: "PITCHER2",
      pitcherName: "Suppressed Starter",
      tier: "track",
      score10: "3.2",
      status: "active",
      gameStatus: "scheduled",
      everPubliclyFlagged: false,
      moundDirection: null,
      suppressed: true,
      suppressedReasons: ["starter_not_confirmed"],
    }),
  );
  checkGroup(
    "moundBuildResponse",
    {
      public_only: buildMoundResponse(
        "2026-08-03", "build_fixed_1", "2026-08-03T18:30:00.000Z", "rebuilt",
        [moundPublic, moundSuppressed], FROZEN_COUNTERS, false, false,
      ),
      include_research: buildMoundResponse(
        "2026-08-03", "build_fixed_1", "2026-08-03T18:30:00.000Z", "rebuilt",
        [moundPublic, moundSuppressed], FROZEN_COUNTERS, true, true,
      ),
    },
  );

  // Persistence/ledger mapping round-trips (row -> signal -> row). Behind the
  // no-connect dummy-URL import shim; the mapping functions never query.
  checkGroup("platePersistenceMapping", {
    rowToSignal: rowToSignalPlate(makePlateRow()),
    signalToRow_roundtrip: signalToRowPlate(rowToSignalPlate(makePlateRow())),
  });
  checkGroup("moundPersistenceMapping", {
    rowToSignal: rowToSignalMound(makeMoundRow()),
    signalToRow_roundtrip: signalToRowMound(rowToSignalMound(makeMoundRow())),
  });

  // Determinism self-check.
  const once = JSON.stringify(canonicalize(nbaComputeProbabilityCases()));
  const twice = JSON.stringify(canonicalize(nbaComputeProbabilityCases()));
  ok(once === twice, "computeProbability output is deterministic across runs");

  const s = summary();
  const mode = RECORD ? "RECORD" : "VERIFY";
  console.log(`\n[${mode}] ${s.passed} passed, ${s.failed} failed`);
  if (s.failed > 0) process.exit(1);
}

// Dynamically import the persistence modules AFTER the DATABASE_URL shim above.
let rowToSignalPlate: (r: ReturnType<typeof makePlateRow>) => any;
let signalToRowPlate: (s: any) => any;
let rowToSignalMound: (r: ReturnType<typeof makeMoundRow>) => any;
let signalToRowMound: (s: any) => any;

(async () => {
  const plate = await import("../mlb/pregamePowerRadar/pregamePersistence");
  const mound = await import("../mlb/pregame/mound/moundPersistence");
  rowToSignalPlate = plate.rowToSignal;
  signalToRowPlate = plate.signalToRow;
  rowToSignalMound = mound.rowToSignal;
  signalToRowMound = mound.signalToRow;
  await main();
})().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
