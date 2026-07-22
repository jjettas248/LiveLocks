// Grade Factors — fresh-process persistence + hydration + lock round trip.
//
// Requires a real DATABASE_URL (temporary local Postgres for this
// verification pass — see PR 1 review). Proves, across a GENUINE process
// boundary (not just an in-process function call):
//   1. A current signal's gradeFactorSummary persists verbatim via the real
//      write path (signalToRow -> storage.upsertPregamePowerRadarSignal).
//   2. A fresh process (server restart) hydrates it back verbatim via the
//      real read path (loadPregameSnapshotFromDb).
//   3. A locked/final rebuild run against that REAL DB-hydrated prev freezes
//      the ORIGINAL summary — even when the "fresh" rebuild computed a
//      genuinely DIFFERENT one — never recalculating/replacing it.
//   4. A legacy signal (never had the field) hydrates to genuine absence and
//      STAYS absent through a locked rebuild — never backfilled.
//
// See _gradeFactorFreshProcessReader.ts for the reader half (run as a
// separate `npx tsx` process). This file only writes + spawns + asserts on
// the reader's reported result, then cleans up its own rows.
//
// Run: DATABASE_URL=... npx tsx server/mlb/pregamePowerRadar/gradeFactorFreshProcessRoundTrip.test.ts

import { execFileSync } from "child_process";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { signalToRow } from "./pregamePersistence";
import type { GradeFactorEntry } from "./gradeFactorSummary";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const SESSION_DATE = "fresh-rt"; // isolated, throwaway sessionDate so this never collides with real data
const BUILD_ID = "fresh-rt-build-1";

const CURRENT_FACTORS: GradeFactorEntry[] = [
  { key: "pitcherVulnerability", label: "Pitcher Vulnerability", displayLabel: "High", tone: "attack", value: 9.0, impact: 0.92, direction: "positive" },
  { key: "lineupOpportunity", label: "Lineup Opportunity", displayLabel: "Excellent", tone: "supporting", value: 8.5, impact: 0.315, direction: "positive" },
  { key: "matchupPenalty", label: "Matchup Penalty", displayLabel: "Downgrade", tone: "risk", value: -0.6, impact: -0.6, direction: "negative" },
];

function baseSignal(signalId: string, gradeFactorSummary: GradeFactorEntry[] | undefined): PregamePowerSignal {
  const s: PregamePowerSignal = {
    signalId, sport: "mlb", engine: "pregame_power_radar",
    sessionDate: SESSION_DATE, gameId: "g1", gameDate: SESSION_DATE, startsAt: null,
    generatedAt: new Date().toISOString(), buildId: BUILD_ID,
    batterId: signalId, batterName: "Fresh RT Batter", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    marketSetups: [{ market: "home_runs", setupScore: 7, setupLabel: "Strong", isPrimary: true }],
    score10: 7, tier: "strong",
    drivers: [{ key: "power", label: "Elite raw power", direction: "positive" }],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: true, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 6, pitcherVulnerabilityScore: 9, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 8.5, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
  };
  (s.diagnostics as any).gradeFactorSummary = gradeFactorSummary;
  return s;
}

async function main() {
  const current = baseSignal("mlb-pregame:fresh-rt:g1:current", CURRENT_FACTORS);
  const legacy = baseSignal("mlb-pregame:fresh-rt:g1:legacy", undefined);

  // ── Write via the REAL production write path ────────────────────────────
  await storage.upsertPregamePowerRadarSignal(signalToRow(current));
  await storage.upsertPregamePowerRadarSignal(signalToRow(legacy));
  await storage.recordPregamePowerBuild({
    buildId: BUILD_ID, sessionDate: SESSION_DATE, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    gamesScanned: 1, battersEvaluated: 2, lineupCoverage: "1", weatherCoverage: "1", batterCoverage: "1", pitcherCoverage: "1",
    signalsCreated: 2, suppressedCount: 0, status: "complete",
  });
  ok(true, "writer: persisted 2 signals + 1 build record via the real production write path");

  // ── Spawn a GENUINELY separate process to read it back ──────────────────
  let readerOutput = "";
  let readerExitCode = 0;
  try {
    readerOutput = execFileSync(
      "npx",
      ["tsx", "server/mlb/pregamePowerRadar/_gradeFactorFreshProcessReader.ts", SESSION_DATE],
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
    const readerPassed = parseInt(match[1], 10);
    const readerFailed = parseInt(match[2], 10);
    passed += readerPassed;
    failed += readerFailed;
  }
  ok(readerExitCode === 0, `reader process exited 0 (got ${readerExitCode})`);

  // ── Isolation check: this Plate-only round trip must never touch Mound
  //    tables — confirms the DB-level isolation the strategy doc requires. ─
  const moundRowsAfter = await storage.getMlbMoundRadarSignalsByDate(SESSION_DATE).catch(() => []);
  ok(
    moundRowsAfter.length === 0,
    `Plate-only fresh-process round trip left zero rows in Mound's table for this sessionDate (got ${moundRowsAfter.length})`,
  );

  // ── Cleanup: this test's rows are the only artifacts of this verification
  //    pass — remove them so the temporary DB can be torn down cleanly. ────
  await db.execute(sql`DELETE FROM pregame_power_radar_signals WHERE session_date = ${SESSION_DATE}`).catch(() => {});
  await db.execute(sql`DELETE FROM pregame_power_radar_builds WHERE session_date = ${SESSION_DATE}`).catch(() => {});

  console.log(`\ngradeFactorFreshProcessRoundTrip.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("CRASHED:", err);
  process.exit(1);
});
