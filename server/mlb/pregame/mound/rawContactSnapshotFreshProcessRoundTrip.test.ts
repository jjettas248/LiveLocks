// Raw pitcher contact snapshot — fresh-process persistence + hydration + lock
// round trip.
//
// Requires a real DATABASE_URL (temporary local Postgres for this
// verification pass — mirrors pregamePowerRadar/gradeFactorFreshProcessRoundTrip.test.ts's
// pattern). Proves, across a GENUINE process boundary (not just an in-process
// function call):
//   1. A current signal's frozen rawContactSnapshot persists verbatim via the
//      real write path (signalToRow -> storage.upsertMlbMoundRadarSignal).
//   2. A fresh process (server restart) hydrates it back verbatim via the
//      real read path (loadMoundSnapshotFromDb).
//   3. A locked/final rebuild run against that REAL DB-hydrated prev freezes
//      the ORIGINAL snapshot — even when the "fresh" rebuild computed a
//      genuinely DIFFERENT one — never recalculating/replacing it.
//   4. A legacy signal (never had the field) hydrates to genuine absence and
//      STAYS absent through a locked rebuild — never backfilled.
//   5. Repeated initialization does not duplicate/mutate.
//
// See _rawContactSnapshotFreshProcessReader.ts for the reader half (run as a
// separate `npx tsx` process). This file only writes + spawns + asserts on
// the reader's reported result, then cleans up its own rows in `finally` —
// so cleanup still runs even if an assertion throws.
//
// Run: DATABASE_URL=... npx tsx server/mlb/pregame/mound/rawContactSnapshotFreshProcessRoundTrip.test.ts

import { execFileSync } from "child_process";
import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { signalToRow } from "./moundPersistence";
import { buildMoundEvaluationSnapshot } from "./evaluationSnapshot";
import type { MoundSignal, MoundEvaluationRecord } from "./types";
import type { RawPitcherContactSnapshot } from "./rawPitcherContactSnapshot";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const SESSION_DATE = "fresh-rt-mound"; // isolated, throwaway sessionDate — never collides with real data
const BUILD_ID = "fresh-rt-mound-build-1";

function contactSnap(): RawPitcherContactSnapshot {
  return {
    schemaVersion: 1,
    hr9Allowed: 1.2, barrelAllowedPct: 8.5, hardHitAllowedPct: 38.2, flyBallAllowedPct: 30.1,
    xSLGAllowed: 0.41, xwOBAAllowed: 0.32, bb9: 2.8, ipVariance: 1.1,
    sampleSizes: {
      inningsPitched: 100, homeRunsAllowed: 13, hardHitEligibleBbe: 200,
      barrelEligibleBbe: 200, bbTypeEligibleBbe: 200, xSLGEligibleBbe: 200, xwOBAEligibleBbe: 200,
    },
    availability: {
      hr9Allowed: "available", barrelAllowedPct: "available", hardHitAllowedPct: "available",
      flyBallAllowedPct: "available", xSLGAllowed: "available", xwOBAAllowed: "available",
      bb9: "available", ipVariance: "available",
    },
  };
}

function baseSignal(signalId: string, pitcherId: string): MoundSignal {
  return {
    signalId, sport: "mlb", engine: "mound_radar",
    sessionDate: SESSION_DATE, gameId: "g1", gameDate: SESSION_DATE, startsAt: null,
    generatedAt: new Date().toISOString(), buildId: BUILD_ID,
    pitcherId, pitcherName: "Fresh RT Pitcher", team: "NYY", opponent: "BOS",
    throws: "R", opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: { pitcher_strikeouts: 7, pitcher_outs: 6 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: 5.5,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: true, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 5,
      recentFormScore: 6, marketFitScore: 0, contactRiskScore: null, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [], dataCoverageScore: 0.9,
      finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    },
  };
}

async function main() {
  const currentBase = baseSignal("mlb-mound:fresh-rt-mound:g1:current", "current-pitcher");
  const legacyBase = baseSignal("mlb-mound:fresh-rt-mound:g1:legacy", "legacy-pitcher");

  const currentSnapshot = buildMoundEvaluationSnapshot(
    currentBase, { holistic: 1, byMarket: {} }, BUILD_ID, 1, new Date().toISOString(), 9, 6, contactSnap(),
  );
  const currentEvaluation: MoundEvaluationRecord = {
    firstPublicSnapshot: currentSnapshot, firstPublicUnavailableReason: null, firstPublicDirection: "follow", directionConflict: false,
    finalPregameSnapshot: currentSnapshot, finalPregameUnavailableReason: null,
  };
  const current: MoundSignal = { ...currentBase, diagnostics: { ...currentBase.diagnostics, evaluation: currentEvaluation } };

  // Legacy: finalPregameSnapshot exists (pre-PR shape) but with NO rawContactSnapshot at all.
  const legacySnapshot = buildMoundEvaluationSnapshot(
    legacyBase, { holistic: 1, byMarket: {} }, BUILD_ID, 1, new Date().toISOString(), 9, 6, undefined,
  );
  const legacyEvaluation: MoundEvaluationRecord = {
    firstPublicSnapshot: legacySnapshot, firstPublicUnavailableReason: null, firstPublicDirection: "follow", directionConflict: false,
    finalPregameSnapshot: legacySnapshot, finalPregameUnavailableReason: null,
  };
  const legacy: MoundSignal = { ...legacyBase, diagnostics: { ...legacyBase.diagnostics, evaluation: legacyEvaluation } };

  try {
    // ── Write via the REAL production write path ────────────────────────────
    await storage.upsertMlbMoundRadarSignal(signalToRow(current));
    await storage.upsertMlbMoundRadarSignal(signalToRow(legacy));
    await storage.recordMlbMoundRadarBuild({
      buildId: BUILD_ID, sessionDate: SESSION_DATE, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      gamesScanned: 1, pitchersEvaluated: 2, starterCoverage: "1", weatherCoverage: "1", pitcherCoverage: "1", lineupCoverage: "1",
      signalsCreated: 2, suppressedCount: 0, status: "complete",
    });
    ok(true, "writer: persisted 2 signals + 1 build record via the real production write path");

    // ── Spawn a GENUINELY separate process to read it back ──────────────────
    let readerOutput = "";
    let readerExitCode = 0;
    try {
      readerOutput = execFileSync(
        "npx",
        ["tsx", "server/mlb/pregame/mound/_rawContactSnapshotFreshProcessReader.ts", SESSION_DATE],
        { encoding: "utf8", env: process.env },
      );
    } catch (err: any) {
      readerOutput = (err.stdout ?? "") + (err.stderr ?? "");
      readerExitCode = err.status ?? 1;
    }
    console.log(readerOutput.trim());

    const match = readerOutput.match(/READER_RESULT: (\d+) passed, (\d+) failed/);
    ok(match != null, "reader process reported a result line");
    if (match) {
      passed += parseInt(match[1], 10);
      failed += parseInt(match[2], 10);
    }
    ok(readerExitCode === 0, `reader process exited 0 (got ${readerExitCode})`);

    // ── Isolation check: this Mound-only round trip must never touch Plate's table ──
    const plateRowsAfter = await storage.getPregamePowerRadarSignalsByDate(SESSION_DATE).catch(() => []);
    ok(
      plateRowsAfter.length === 0,
      `Mound-only fresh-process round trip left zero rows in Plate's table for this sessionDate (got ${plateRowsAfter.length})`,
    );
  } finally {
    // Cleanup runs even if an assertion above threw.
    await db.execute(sql`DELETE FROM mlb_mound_radar_signals WHERE session_date = ${SESSION_DATE}`).catch(() => {});
    await db.execute(sql`DELETE FROM mlb_mound_radar_builds WHERE session_date = ${SESSION_DATE}`).catch(() => {});
  }

  console.log(`\nrawContactSnapshotFreshProcessRoundTrip.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("CRASHED:", err);
  process.exit(1);
});
