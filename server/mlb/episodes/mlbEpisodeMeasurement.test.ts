// MLB Performance Measurement — invariants.
//
// Run: npx tsx server/mlb/episodes/mlbEpisodeMeasurement.test.ts

import type { MlbRecommendationEpisode } from "@shared/mlbRecommendationEpisode";
import {
  unitsWonPerDollarStaked,
  computeMlbPerformanceMetrics,
  buildMlbPerformanceReport,
  filterEpisodesByWindow,
} from "./mlbEpisodeMeasurement";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function makeEpisode(overrides: Partial<MlbRecommendationEpisode> = {}): MlbRecommendationEpisode {
  return {
    episodeId: "ep_default",
    sport: "MLB",
    product: "mound",
    gameId: "game_1",
    playerId: "player_1",
    playerName: "Test Player",
    market: "pitcher_strikeouts",
    recommendedSide: "OVER",
    line: 5.5,
    americanOdds: -110,
    sportsbook: "draftkings",
    oddsFetchedAt: "2026-07-29T22:00:00.000Z",
    recommendationCreatedAt: "2026-07-29T22:00:05.000Z",
    modelVersion: "mound_v1",
    contractVersion: "episode_v1",
    projection: 6.2,
    modelProbability: 0.6,
    setupGrade: "Strong",
    sportsbookEdge: null,
    dataQuality: "complete",
    sourceType: "sportsbook",
    isOfficial: true,
    gamePhase: "pregame",
    surfacedAt: "2026-07-29T22:00:10.000Z",
    expiresAt: null,
    lifecycleStatus: "recommended",
    status: "settled",
    settlementResult: null,
    settledAt: "2026-07-30T01:00:00.000Z",
    ...overrides,
  };
}

// ── unitsWonPerDollarStaked: real American-odds conversion, not -110 flat ──
{
  ok(approx(unitsWonPerDollarStaked(-150), 100 / 150), "-150 pays 100/150 units on a win");
  ok(approx(unitsWonPerDollarStaked(200), 2), "+200 pays 2 units on a win");
  ok(approx(unitsWonPerDollarStaked(-110), 100 / 110), "-110 pays 100/110 units on a win");
  let threw = false;
  try { unitsWonPerDollarStaked(0); } catch { threw = true; }
  ok(threw, "0 is not a valid American price");
}

// ── Fixture: mixed products/markets/sides/grades/results ──────────────────
const epA = makeEpisode({
  episodeId: "epA", product: "mound", market: "pitcher_strikeouts", recommendedSide: "OVER",
  setupGrade: "Elite", modelVersion: "mound_v1", gamePhase: "pregame", dataQuality: "complete",
  americanOdds: -150, modelProbability: 0.62, settlementResult: "cashed",
});
const epB = makeEpisode({
  episodeId: "epB", product: "mound", market: "pitcher_strikeouts", recommendedSide: "OVER",
  setupGrade: "Strong", modelVersion: "mound_v1", gamePhase: "pregame", dataQuality: "complete",
  americanOdds: 200, modelProbability: 0.58, settlementResult: "cashed",
});
const epC = makeEpisode({
  episodeId: "epC", product: "plate", market: "home_runs", recommendedSide: "OVER",
  setupGrade: "Elite", modelVersion: "plate_v1", gamePhase: "pregame", dataQuality: "complete",
  americanOdds: -110, modelProbability: 0.71, settlementResult: "missed",
});
const epD = makeEpisode({
  episodeId: "epD", product: "live_edge", market: "total_bases", recommendedSide: "UNDER",
  setupGrade: "Strong", modelVersion: "live_v1", gamePhase: "4th", dataQuality: "partial",
  americanOdds: -110, modelProbability: 0.55, settlementResult: "push",
});
const epE = makeEpisode({
  episodeId: "epE", product: "live_edge", market: "hits", recommendedSide: "OVER",
  setupGrade: "Watch", modelVersion: "live_v1", gamePhase: "7th", dataQuality: "degraded",
  americanOdds: -110, modelProbability: 0.52, settlementResult: "void",
});
const epF = makeEpisode({
  episodeId: "epF", product: "mound", market: "pitcher_outs", recommendedSide: "OVER",
  setupGrade: "Strong", modelVersion: "mound_v1", gamePhase: "pregame", dataQuality: "complete",
  status: "surfaced", settlementResult: null, settledAt: null,
});
// A malformed/deserialized row claiming isOfficial:false must never count,
// even though the TS type normally guarantees isOfficial is literally true.
const epG_nonOfficial = { ...makeEpisode({ episodeId: "epG", settlementResult: "cashed" }), isOfficial: false } as unknown as MlbRecommendationEpisode;

const fixture = [epA, epB, epC, epD, epE, epF, epG_nonOfficial];

// ── Only official episodes count ────────────────────────────────────────
{
  const metrics = computeMlbPerformanceMetrics(fixture);
  ok(metrics.sampleSize === 6, `sampleSize excludes the non-official row (got ${metrics.sampleSize})`);
}

// ── Sample size / settlement / coverage ─────────────────────────────────
{
  const metrics = computeMlbPerformanceMetrics(fixture);
  ok(metrics.settledCount === 5, `settledCount is 5 (epF is not settled) (got ${metrics.settledCount})`);
  ok(approx(metrics.coverage, 5 / 6), `coverage is settledCount/sampleSize = 5/6 (got ${metrics.coverage})`);
}

// ── Pushes and voids handled correctly ───────────────────────────────────
{
  const metrics = computeMlbPerformanceMetrics(fixture);
  ok(metrics.wins === 2, `wins counts only cashed (epA, epB) (got ${metrics.wins})`);
  ok(metrics.losses === 1, `losses counts only missed (epC) (got ${metrics.losses})`);
  ok(metrics.pushes === 1, `pushes counts epD (got ${metrics.pushes})`);
  ok(metrics.voids === 1, `voids counts epE (got ${metrics.voids})`);
  ok(approx(metrics.winRate as number, 2 / 3), `winRate excludes push/void from its denominator: 2/(2+1) (got ${metrics.winRate})`);
}

// ── ROI uses each episode's own captured American price, not -110 flat ──
{
  const metrics = computeMlbPerformanceMetrics(fixture);
  const expectedUnits = (100 / 150) + 2 + (-1) + 0 + 0; // epA + epB + epC + epD(push=0) + epE(void=0)
  ok(approx(metrics.unitsWonLost, expectedUnits), `unitsWonLost = ${expectedUnits} using real captured prices (got ${metrics.unitsWonLost})`);
  const stakedCount = 2 + 1 + 1; // wins + losses + pushes (void stakes nothing)
  ok(approx(metrics.roi as number, expectedUnits / stakedCount), `roi = unitsWonLost / stakedCount (got ${metrics.roi})`);
}

// ── Brier / log loss / calibration — decided (cashed/missed) rows only ───
{
  const metrics = computeMlbPerformanceMetrics(fixture);
  // Independently re-derived (not sharing code with the implementation) over
  // epA(p=0.62,y=1), epB(p=0.58,y=1), epC(p=0.71,y=0).
  const rows: Array<{ p: number; y: number }> = [{ p: 0.62, y: 1 }, { p: 0.58, y: 1 }, { p: 0.71, y: 0 }];
  const expectedBrier = rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length;
  const expectedLogLoss = rows.reduce((s, r) => s - (r.y * Math.log(r.p) + (1 - r.y) * Math.log(1 - r.p)), 0) / rows.length;
  ok(approx(metrics.brierScore as number, expectedBrier, 1e-9), `brierScore over decided-only rows (got ${metrics.brierScore}, expected ${expectedBrier})`);
  ok(approx(metrics.logLoss as number, expectedLogLoss, 1e-9), `logLoss over decided-only rows (got ${metrics.logLoss}, expected ${expectedLogLoss})`);
  ok(typeof metrics.calibrationError === "number" && metrics.calibrationError! >= 0, "calibrationError is a non-negative number");
}

// ── Pure pregame-only fixture: decided.length === 0 yields null, not NaN ──
{
  const metrics = computeMlbPerformanceMetrics([epD, epE, epF]); // push, void, unsettled only
  ok(metrics.brierScore === null, "brierScore is null when there are no decided (cashed/missed) settlements");
  ok(metrics.logLoss === null, "logLoss is null when there are no decided settlements");
  ok(metrics.calibrationError === null, "calibrationError is null when there are no decided settlements");
  ok(metrics.winRate === null, "winRate is null when there are no decided settlements");
}

// ── Breakdown grouping ───────────────────────────────────────────────────
{
  const report = buildMlbPerformanceReport(fixture);
  ok(report.byProduct.length === 3, `byProduct has 3 groups: mound/plate/live_edge (got ${report.byProduct.length})`);
  const moundRow = report.byProduct.find((r) => r.key === "mound");
  ok(!!moundRow && moundRow.metrics.sampleSize === 3, `mound group has 3 episodes (epA, epB, epF) (got ${moundRow?.metrics.sampleSize})`);
  const plateRow = report.byProduct.find((r) => r.key === "plate");
  ok(!!plateRow && plateRow.metrics.sampleSize === 1, "plate group has 1 episode (epC)");

  ok(report.byMarket.length === 5, `byMarket has 5 distinct markets (got ${report.byMarket.length})`);
  ok(report.bySide.length === 2, `bySide has 2 groups: OVER/UNDER (got ${report.bySide.length})`);
  const underRow = report.bySide.find((r) => r.key === "UNDER");
  ok(!!underRow && underRow.metrics.sampleSize === 1, "UNDER group has 1 episode (epD)");

  ok(report.bySetupGrade.length === 3, `bySetupGrade has 3 groups: Elite/Strong/Watch (got ${report.bySetupGrade.length})`);
  ok(report.byModelVersion.length === 3, `byModelVersion has 3 groups (got ${report.byModelVersion.length})`);
  ok(report.byGamePhase.length === 3, `byGamePhase has 3 groups: pregame/4th/7th (got ${report.byGamePhase.length})`);
  ok(report.byDataQuality.length === 3, `byDataQuality has 3 groups: complete/partial/degraded (got ${report.byDataQuality.length})`);
}

// ── Date-window filtering ────────────────────────────────────────────────
{
  const early = makeEpisode({ episodeId: "early", recommendationCreatedAt: "2026-07-01T00:00:00.000Z" });
  const late = makeEpisode({ episodeId: "late", recommendationCreatedAt: "2026-08-01T00:00:00.000Z" });
  const windowed = filterEpisodesByWindow([early, late], "2026-07-15T00:00:00.000Z", "2026-07-31T00:00:00.000Z");
  ok(windowed.length === 0, "a window excluding both fixture episodes returns none");
  const windowed2 = filterEpisodesByWindow([early, late], "2026-06-01T00:00:00.000Z", "2026-07-15T00:00:00.000Z");
  ok(windowed2.length === 1 && windowed2[0].episodeId === "early", "a window covering only the early episode returns just it");
}

console.log(`\nmlbEpisodeMeasurement.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
