/**
 * MLB Live Edge Trust Recovery (Phase 6) — mlbLiveEdgeCalibrationReport.test.ts
 *
 * Run with: npx tsx server/analytics/mlbLiveEdgeCalibrationReport.test.ts
 */

import {
  computeCalibrationMetrics,
  computeReliabilityBuckets,
  computeExpectedCalibrationError,
  buildGroupedCalibrationReport,
  toCleanCalibrationRow,
  gatherMlbLiveEdgeCalibrationReport,
  SHADOW_CALIBRATION_UNAVAILABLE,
  type CalibrationRow,
} from "./mlbLiveEdgeCalibrationReport";
import type { PersistedPlay } from "@shared/schema";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
}

function row(overrides: Partial<CalibrationRow> = {}): CalibrationRow {
  return {
    probability: 60,
    hit: true,
    market: "hits",
    side: "over",
    engineVersion: "v1",
    calibrationVersion: "cal-v1",
    ...overrides,
  };
}

// ── Group A: empty input never throws, reports null/zero ────────────────
{
  const m = computeCalibrationMetrics([]);
  check("A1 empty rows -> sampleCount 0", m.sampleCount === 0);
  check("A2 empty rows -> null brier", m.brierScore === null);
  check("A3 empty rows -> null logLoss", m.logLoss === null);
  check("A4 empty rows -> null ECE", m.expectedCalibrationError === null);
  check("A5 empty rows -> 10 reliability buckets, all zero count", m.reliabilityBuckets.length === 10 && m.reliabilityBuckets.every(b => b.count === 0));
}

// ── Group B: perfect calibration ──────────────────────────────────────────
{
  // All predictions at 100% probability, all hit — perfect Brier/logloss.
  const rows = Array.from({ length: 10 }, () => row({ probability: 100, hit: true }));
  const m = computeCalibrationMetrics(rows);
  check("B1 perfect prediction -> brier near 0", m.brierScore !== null && m.brierScore < 0.001, m.brierScore);
  check("B2 perfect prediction -> logloss near 0", m.logLoss !== null && m.logLoss < 0.001, m.logLoss);
}

// ── Group C: worst-case calibration ──────────────────────────────────────
{
  // Predicted 100% but never hits — worst possible Brier (1.0).
  const rows = Array.from({ length: 5 }, () => row({ probability: 100, hit: false }));
  const m = computeCalibrationMetrics(rows);
  check("C1 worst-case prediction -> brier near 1", m.brierScore !== null && m.brierScore > 0.99, m.brierScore);
}

// ── Group D: reliability buckets bucket correctly ────────────────────────
{
  const rows: CalibrationRow[] = [
    row({ probability: 55, hit: true }),
    row({ probability: 58, hit: false }),
    row({ probability: 95, hit: true }),
  ];
  const buckets = computeReliabilityBuckets(rows);
  const b50 = buckets.find(b => b.bucketLabel === "50-60%");
  const b90 = buckets.find(b => b.bucketLabel === "90-100%");
  check("D1 50-60% bucket has 2 samples", b50?.count === 2, b50);
  check("D2 50-60% bucket actual hit rate is 50%", b50?.actualHitRate === 50, b50);
  check("D3 90-100% bucket has 1 sample, 100% hit rate", b90?.count === 1 && b90?.actualHitRate === 100, b90);
}

// ── Group E: ECE reflects miscalibration magnitude ───────────────────────
{
  // Predicted 90% but only hits 50% of the time within the bucket -> high ECE.
  const rows: CalibrationRow[] = [
    row({ probability: 90, hit: true }),
    row({ probability: 92, hit: false }),
  ];
  const ece = computeExpectedCalibrationError(rows);
  check("E1 miscalibrated bucket produces nonzero ECE", ece !== null && ece > 30, ece);
}

// ── Group F: grouping never blends dimensions ────────────────────────────
{
  const rows: CalibrationRow[] = [
    row({ market: "hits", side: "over", engineVersion: "v1", calibrationVersion: "cal-a", hit: true }),
    row({ market: "home_runs", side: "over", engineVersion: "v2", calibrationVersion: "cal-b", hit: false }),
  ];
  const report = buildGroupedCalibrationReport(rows);
  check("F1 overall combines both", report.overall.sampleCount === 2);
  check("F2 byMarket keeps hits and home_runs separate", report.byMarket["hits"]?.sampleCount === 1 && report.byMarket["home_runs"]?.sampleCount === 1);
  check("F3 byEngineVersion keeps v1/v2 separate", report.byEngineVersion["v1"]?.sampleCount === 1 && report.byEngineVersion["v2"]?.sampleCount === 1);
  check("F4 byCalibrationVersion keeps cal-a/cal-b separate", report.byCalibrationVersion["cal-a"]?.sampleCount === 1 && report.byCalibrationVersion["cal-b"]?.sampleCount === 1);
}

// ── Group G: toCleanCalibrationRow exclusion rules ───────────────────────
function basePlay(overrides: Partial<PersistedPlay> = {}): PersistedPlay {
  return {
    id: "p1",
    createdAt: new Date(),
    gameId: "g1",
    playerId: "player-1",
    playerName: "Test Player",
    team: "NYY",
    sport: "mlb",
    market: "hits",
    direction: "over",
    line: "1.5",
    prob: "62",
    engineProb: null,
    bookImplied: null,
    edgeGap: null,
    engineVersion: "v1",
    projection: null,
    sportsbook: "draftkings",
    derivedLine: false,
    gameDate: "2026-07-30",
    timestamp: new Date(),
    result: "hit",
    finalStat: null,
    settledAt: new Date(),
    notificationSent: false,
    duplicateGuard: "dup1",
    archetype: null, fragilityScore: null, familyId: null, siblingCount: null, siblingRank: null,
    flagshipOrDerivative: null, familyPenaltyFactor: null, calibrationTrack: null,
    confidenceCeilingApplied: null, ceilingReason: null, rawProbOver: null, rawProbUnder: null,
    modelEdge: null, minutesExpected: null, minutesVariance: null, marketType: null,
    finalProbOver: null, finalProbUnder: null, displayConfidence: null, playerVolatilityScore: null,
    comboCovarianceEstimate: null, fragilityPenalty: null, fragilityReasons: null,
    mu: null, sigma: null, zScore: null, hrBuildScore: null, hrIntensity: null,
    signalScore: null, opportunityScore: null, liveScore: null, eventBoost: null,
    odds: null, stake: "1", payout: null, inning: null, abNumber: null, pitchCount: null,
    contactQualityScore: null, confidenceTier: null,
    officialEpisodeKey: "mlb:v1:g1:player-1:hits",
    oddsSourceUpdatedAt: new Date(),
    oddsFetchedAt: new Date(),
    rawProbability: null,
    calibrationVersion: "cal-v1",
    inputSnapshotHash: null,
    officialEligibilityVersion: "mlb_official_eligibility_v1",
    officialEligibilityReasons: null,
    dataQuality: "full",
    currentStatKnown: true,
    ...overrides,
  } as PersistedPlay;
}

{
  const clean = toCleanCalibrationRow(basePlay());
  check("G1 fully-provenanced settled MLB row converts cleanly", clean !== null && clean.probability === 62 && clean.hit === true, clean);

  const nonMlb = toCleanCalibrationRow(basePlay({ sport: "nba" }));
  check("G2 non-MLB row excluded", nonMlb === null);

  const unresolved = toCleanCalibrationRow(basePlay({ result: null }));
  check("G3 unresolved (result null) row excluded", unresolved === null);

  const pushed = toCleanCalibrationRow(basePlay({ result: "push" }));
  check("G4 push result excluded (not binary hit/miss)", pushed === null);

  const legacyNoEpisodeKey = toCleanCalibrationRow(basePlay({ officialEpisodeKey: null }));
  check("G5 legacy row with no officialEpisodeKey excluded", legacyNoEpisodeKey === null);

  const noSourceTime = toCleanCalibrationRow(basePlay({ oddsSourceUpdatedAt: null }));
  check("G6 row with no real source-timestamp provenance excluded", noSourceTime === null);

  const badProb = toCleanCalibrationRow(basePlay({ prob: "not-a-number" }));
  check("G7 non-finite probability excluded", badProb === null);
}

// ── Group H: shadow explicitly reported as unavailable, never fabricated ──
{
  check("H1 shadow calibration is explicitly marked unavailable", SHADOW_CALIBRATION_UNAVAILABLE.available === false);
  check("H2 unavailability includes a concrete reason", typeof SHADOW_CALIBRATION_UNAVAILABLE.reason === "string" && SHADOW_CALIBRATION_UNAVAILABLE.reason.length > 20);
}

// ── Group I: end-to-end gatherer with a mock storage ─────────────────────
async function runAsync() {
  const mockStorage = {
    getPlays: async () => ({
      plays: [
        basePlay({ id: "a", result: "hit", prob: "70" }),
        basePlay({ id: "b", result: "miss", prob: "40" }),
        basePlay({ id: "c", officialEpisodeKey: null }), // legacy, excluded
        basePlay({ id: "d", sport: "nba" }), // non-MLB, excluded
      ],
      total: 4,
    }),
  };
  const report = await gatherMlbLiveEdgeCalibrationReport(mockStorage as any);
  check("I1 gatherer includes only clean official rows", report.official.overall.sampleCount === 2, report.official.overall.sampleCount);
  check("I2 gatherer counts excluded legacy/unprovenanced rows", report.officialRowsExcludedLegacyOrUnprovenanced === 2, report.officialRowsExcludedLegacyOrUnprovenanced);
  check("I3 gatherer reports shadow as unavailable, never blended with official", report.shadow.available === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

runAsync();
