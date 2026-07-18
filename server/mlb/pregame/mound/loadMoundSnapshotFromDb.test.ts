// Mound Radar — boot-hydration reconstruction invariants (research plan §4.1,
// Option A). Mirrors pregamePowerRadar/loadPregameSnapshotFromDb.test.ts
// exactly for the Mound side. server/index.ts calls loadMoundSnapshotFromDb
// once at boot (guarded by a double-checked `!getMoundSnapshot()`) to seed
// the in-memory snapshot from already-persisted rows before the first build
// timer fires, so a restart never transiently loses already-persisted
// Follow/Fade flags, moundDirection, or diagnostics.evaluation state. These
// tests monkey-patch storage (no live database in this environment) to
// exercise the reconstruction logic directly.
//
// Run: npx tsx server/mlb/pregame/mound/loadMoundSnapshotFromDb.test.ts

import { loadMoundSnapshotFromDb } from "./moundPersistence";
import { storage } from "../../../storage";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const originalGetLatestBuild = storage.getLatestMlbMoundRadarBuild.bind(storage);
const originalGetSignalsByDate = storage.getMlbMoundRadarSignalsByDate.bind(storage);

function restore() {
  (storage as any).getLatestMlbMoundRadarBuild = originalGetLatestBuild;
  (storage as any).getMlbMoundRadarSignalsByDate = originalGetSignalsByDate;
}

function makeRow(over: Record<string, any>) {
  return {
    signalId: over.signalId, buildId: over.buildId, sessionDate: "2026-07-01",
    gameId: "g1", gameDate: "2026-07-01", startsAt: null, gameStatus: "final",
    firstPitchLockEligible: false, pitcherId: "p1", pitcherName: "P", team: "NYY", opponent: "BOS",
    opposingLineupConfirmed: true, primaryMarket: "pitcher_strikeouts",
    marketTags: ["pitcher_strikeouts"], marketScores: {}, score10: "7.5", tier: "strong",
    drivers: [], warnings: [], diagnostics: {}, lineupStatus: "confirmed", weatherStatus: "estimated",
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, status: "graded",
    suppressed: false, suppressedReasons: [], outcomes: { outcome: "mound_win", userVisible: true },
    everPubliclyFlagged: true, everPubliclyFlaggedFade: false, moundDirection: "follow",
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    lockedAt: null, gradedAt: null, updatedAt: null,
    ...over,
  };
}

async function main() {
  // ── No build for the date → null, not an empty/fabricated snapshot ────────
  (storage as any).getLatestMlbMoundRadarBuild = async () => null;
  (storage as any).getMlbMoundRadarSignalsByDate = async () => [];
  {
    const result = await loadMoundSnapshotFromDb("2026-07-01");
    ok(result === null, "no persisted build for the date → null, no fabricated snapshot");
  }

  // ── Build exists, matching rows present → reconstructs a real snapshot, preserving Follow/Fade + direction ──
  (storage as any).getLatestMlbMoundRadarBuild = async () => ({
    buildId: "mound-current", sessionDate: "2026-07-01", startedAt: "2026-07-01T12:00:00Z",
    completedAt: "2026-07-01T12:05:00Z", gamesScanned: 1, pitchersEvaluated: 1,
    starterCoverage: "1", weatherCoverage: "1", pitcherCoverage: "1", lineupCoverage: "1",
  });
  (storage as any).getMlbMoundRadarSignalsByDate = async () => [
    makeRow({ signalId: "mlb-mound:2026-07-01:g1:p1", buildId: "mound-current" }),
    // A stale row from a PRIOR build for the same date — must be excluded.
    makeRow({ signalId: "mlb-mound:2026-07-01:g1:p2", buildId: "mound-stale" }),
  ];
  {
    const result = await loadMoundSnapshotFromDb("2026-07-01");
    ok(result !== null, "build + matching rows present → reconstructs a snapshot");
    ok(result?.buildId === "mound-current", "reconstructed snapshot carries the latest build id");
    ok(result?.signals.size === 1, "only rows from the latest build are included, stale-build rows excluded");
    const signal = result?.signals.get("mlb-mound:2026-07-01:g1:p1");
    ok(signal?.outcomes?.outcome === "mound_win", "reconstructed signal carries its persisted graded outcome");
    ok(signal?.everPubliclyFlagged === true, "everPubliclyFlagged survives reconstruction");
    ok(signal?.moundDirection === "follow", "pinned moundDirection survives reconstruction — critical for grading correctness post-restart");
  }

  // ── Fade-direction row also reconstructs its own durable flag correctly ───
  (storage as any).getMlbMoundRadarSignalsByDate = async () => [
    makeRow({ signalId: "mlb-mound:2026-07-01:g1:p3", buildId: "mound-current", everPubliclyFlagged: false, everPubliclyFlaggedFade: true, moundDirection: "fade" }),
  ];
  {
    const result = await loadMoundSnapshotFromDb("2026-07-01");
    const signal = result?.signals.get("mlb-mound:2026-07-01:g1:p3");
    ok(signal?.everPubliclyFlaggedFade === true, "everPubliclyFlaggedFade survives reconstruction independently of everPubliclyFlagged");
    ok(signal?.moundDirection === "fade", "fade-pinned direction survives reconstruction");
  }

  // ── Build exists but no rows match its buildId → null, not an empty board ──
  (storage as any).getMlbMoundRadarSignalsByDate = async () => [
    makeRow({ signalId: "mlb-mound:2026-07-01:g1:p2", buildId: "mound-stale" }),
  ];
  {
    const result = await loadMoundSnapshotFromDb("2026-07-01");
    ok(result === null, "no rows matching the latest build id → null, not a fabricated empty snapshot");
  }

  restore();
  console.log(`\nloadMoundSnapshotFromDb.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  restore();
  console.error(e);
  process.exit(1);
});
