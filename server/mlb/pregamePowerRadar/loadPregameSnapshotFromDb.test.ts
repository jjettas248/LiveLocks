// Pre-Game Power Radar — boot-hydration reconstruction invariants.
//
// server/index.ts calls loadPregameSnapshotFromDb once at boot (guarded by a
// double-checked `!getSnapshot()`, see server/index.ts) to seed the in-memory
// snapshot from already-persisted rows before the first live rebuild
// completes, so a restart mid-slate never transiently loses visibility into
// already-graded state that is safely sitting in the DB. These tests
// monkey-patch storage (no live database in this environment) to exercise
// the reconstruction logic directly.
//
// Run: npx tsx server/mlb/pregamePowerRadar/loadPregameSnapshotFromDb.test.ts

import { loadPregameSnapshotFromDb } from "./pregamePersistence";
import { storage } from "../../storage";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const originalGetLatestBuild = storage.getLatestPregamePowerBuild.bind(storage);
const originalGetSignalsByDate = storage.getPregamePowerRadarSignalsByDate.bind(storage);

function restore() {
  (storage as any).getLatestPregamePowerBuild = originalGetLatestBuild;
  (storage as any).getPregamePowerRadarSignalsByDate = originalGetSignalsByDate;
}

function makeRow(over: Record<string, any>) {
  return {
    signalId: over.signalId, buildId: over.buildId, sessionDate: "2026-07-01",
    gameId: "g1", gameDate: "2026-07-01", startsAt: null, gameStatus: "final",
    firstPitchLockEligible: false, batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: null, pitcherName: null, battingOrderSlot: 3, primaryMarket: "home_runs",
    marketTags: ["home_runs"], marketScores: {}, score10: "7.5", tier: "strong",
    drivers: [], warnings: [], diagnostics: {}, lineupStatus: "posted", weatherStatus: "estimated",
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, status: "graded",
    suppressed: false, suppressedReasons: [], outcomes: { hitHr: true, outcome: "pregame_win", userVisible: true },
    everPubliclyFlagged: true, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    lockedAt: null, gradedAt: null, updatedAt: null,
    ...over,
  };
}

async function main() {
  // ── No build for the date → null, not an empty/fabricated snapshot ────────
  (storage as any).getLatestPregamePowerBuild = async () => null;
  (storage as any).getPregamePowerRadarSignalsByDate = async () => [];
  {
    const result = await loadPregameSnapshotFromDb("2026-07-01");
    ok(result === null, "no persisted build for the date → null, no fabricated snapshot");
  }

  // ── Build exists, matching rows present → reconstructs a real snapshot ────
  (storage as any).getLatestPregamePowerBuild = async () => ({
    buildId: "b-current", sessionDate: "2026-07-01", startedAt: "2026-07-01T12:00:00Z",
    completedAt: "2026-07-01T12:05:00Z", gamesScanned: 1, battersEvaluated: 1,
    lineupCoverage: "1", weatherCoverage: "1", batterCoverage: "1", pitcherCoverage: "1",
  });
  (storage as any).getPregamePowerRadarSignalsByDate = async () => [
    makeRow({ signalId: "mlb-pregame:2026-07-01:g1:b1", buildId: "b-current" }),
    // A stale row from a PRIOR build for the same date — must be excluded.
    makeRow({ signalId: "mlb-pregame:2026-07-01:g1:b2", buildId: "b-stale" }),
  ];
  {
    const result = await loadPregameSnapshotFromDb("2026-07-01");
    ok(result !== null, "build + matching rows present → reconstructs a snapshot");
    ok(result?.buildId === "b-current", "reconstructed snapshot carries the latest build id");
    ok(result?.signals.size === 1, "only rows from the latest build are included, stale-build rows excluded");
    ok(result?.signals.get("mlb-pregame:2026-07-01:g1:b1")?.outcomes?.outcome === "pregame_win",
      "reconstructed signal carries its persisted graded outcome");
  }

  // ── Build exists but no rows match its buildId → null, not an empty board ──
  (storage as any).getPregamePowerRadarSignalsByDate = async () => [
    makeRow({ signalId: "mlb-pregame:2026-07-01:g1:b2", buildId: "b-stale" }),
  ];
  {
    const result = await loadPregameSnapshotFromDb("2026-07-01");
    ok(result === null, "no rows matching the latest build id → null, not a fabricated empty snapshot");
  }

  restore();
  console.log(`\nloadPregameSnapshotFromDb.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  restore();
  console.error(e);
  process.exit(1);
});
