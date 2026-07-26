// Plate HR Probability V2 — label reconciler orchestration invariants (PR 2).
//
// No DATABASE_URL required: reconcilePlateHrV2Labels only dynamically
// imports the real storage module when deps.storage is omitted, and every
// test here supplies a fake — proving that lazy-import design actually works,
// not just asserting it in a comment.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2LabelReconciler.test.ts

import { reconcilePlateHrV2Labels } from "./plateHrV2LabelReconciler";
import type { PlateHrV2FeatureSnapshotRow, InsertPlateHrV2Label } from "@shared/schema";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function fixtureSnapshot(overrides: Partial<PlateHrV2FeatureSnapshotRow> & { snapshotId: string; gameId: string; batterId: string }): PlateHrV2FeatureSnapshotRow {
  return {
    snapshotId: overrides.snapshotId,
    sessionDate: "2026-07-20",
    gameId: overrides.gameId,
    batterId: overrides.batterId,
    batterName: "Test Batter",
    team: "NYY",
    opponent: "BOS",
    pitcherId: null,
    pitcherName: null,
    battingOrderSlot: 3,
    buildId: "build-1",
    firstCapturedAt: new Date("2026-07-20T18:00:00.000Z"),
    lastCapturedAt: new Date("2026-07-20T18:00:00.000Z"),
    captureRevision: 1,
    firstPitchTime: new Date("2026-07-20T19:00:00.000Z"),
    firstPitchLockEligible: true,
    gameStatus: "final",
    predictionAsOf: new Date("2026-07-20T18:00:00.000Z"),
    secondsToFirstPitch: 3600,
    lineupConfirmedAt: null,
    starterConfirmed: false,
    lockedAt: new Date("2026-07-20T19:00:00.000Z"),
    inputContractVersion: "plate_hr_v2_features_v1",
    rawInputs: {} as any,
    featureVersion: "plate_hr_v2_features_v1",
    featureHash: "hash1",
    derivedFeatures: {} as any,
    availability: {} as any,
    featureFreshness: {} as any,
    leakageWarnings: [],
    sufficientStatsRef: null,
    championModelVersion: "plate_jul20_restored_v1",
    championScore10: "6.5",
    championTier: "watch",
    championSuppressed: false,
    createdAt: new Date("2026-07-20T18:00:00.000Z"),
    updatedAt: new Date("2026-07-20T18:00:00.000Z"),
    ...overrides,
  };
}

function makeFakeStorage(pending: PlateHrV2FeatureSnapshotRow[], gamePlayerStatsByGame: Record<string, Array<{ playerId: string; gamePk: string | null; ab: number | null; bb: number | null; hr: number | null; abResults: string | null }>>) {
  const insertedKeys = new Set<string>();
  const insertedRows: InsertPlateHrV2Label[] = [];
  return {
    storage: {
      getPlateHrV2LockedSnapshotsPendingLabel: async () => pending,
      getGamePlayerStats: async (gameId: string) =>
        (gamePlayerStatsByGame[gameId] ?? []).map((r) => ({
          ...r, playerName: "x", teamAbbr: null, teamSide: null, battingOrderSlot: null,
          h: null, tb: null, r: null, rbi: null, k: null, sb: null, gameDate: null,
        })),
      insertPlateHrV2LabelIfAbsent: async (row: InsertPlateHrV2Label) => {
        const key = `${row.snapshotId}:${row.labelVersion}`;
        if (insertedKeys.has(key)) return false;
        insertedKeys.add(key);
        insertedRows.push(row);
        return true;
      },
    },
    insertedRows,
  };
}

// ── 1. A final 3-batter game -> 3 inserts, exactly 1 status fetch ──────────
{
  let statusFetchCount = 0;
  const fakeFetchGameStatus = async () => { statusFetchCount++; return "final" as const; };

  const pending = [
    fixtureSnapshot({ snapshotId: "s1", gameId: "g1", batterId: "p1" }),
    fixtureSnapshot({ snapshotId: "s2", gameId: "g1", batterId: "p2" }),
    fixtureSnapshot({ snapshotId: "s3", gameId: "g1", batterId: "p3" }),
  ];
  const gamePlayerStatsByGame = {
    g1: [
      { playerId: "p1", gamePk: "778001", ab: 4, bb: 0, hr: 1, abResults: JSON.stringify([{ hitType: "home_run", inning: 2, half: "top" }]) },
      { playerId: "p2", gamePk: "778001", ab: 3, bb: 1, hr: 0, abResults: null },
      { playerId: "p3", gamePk: "778001", ab: 4, bb: 0, hr: 0, abResults: null },
    ],
  };
  const { storage, insertedRows } = makeFakeStorage(pending, gamePlayerStatsByGame);

  const summary = await reconcilePlateHrV2Labels({}, { storage, fetchGameStatus: fakeFetchGameStatus });

  ok(statusFetchCount === 1, `exactly 1 status fetch for a 3-batter game (got ${statusFetchCount})`);
  ok(summary.scanned === 3, "scanned counts all 3 pending snapshots");
  ok(summary.resolved === 3, "all 3 resolve (final game, all batters had PA>0)");
  ok(summary.inserted === 3, "all 3 inserted");
  ok(insertedRows.find((r) => r.snapshotId === "s1")?.hitHrToday === true, "p1's HR is reflected");
  ok(insertedRows.find((r) => r.snapshotId === "s2")?.hitHrToday === false, "p2's no-HR resolved-false is reflected");
}

// ── 2. A postponed game -> 3 censored inserts ───────────────────────────────
{
  const pending = [
    fixtureSnapshot({ snapshotId: "s4", gameId: "g2", batterId: "p1" }),
    fixtureSnapshot({ snapshotId: "s5", gameId: "g2", batterId: "p2" }),
    fixtureSnapshot({ snapshotId: "s6", gameId: "g2", batterId: "p3" }),
  ];
  const { storage, insertedRows } = makeFakeStorage(pending, { g2: [{ playerId: "p1", gamePk: "778002", ab: 0, bb: 0, hr: 0, abResults: null }] });
  const summary = await reconcilePlateHrV2Labels({}, { storage, fetchGameStatus: async () => "postponed" });

  ok(summary.censored === 3, "all 3 censored for a postponed game");
  ok(summary.inserted === 3, "all 3 censored rows still get inserted (censored is a terminal, resolved-attempt disposition)");
  ok(insertedRows.every((r) => r.resolutionReason === "game_postponed"), "every inserted row carries game_postponed");
}

// ── 3. An in-progress game -> 0 inserts, skippedGameNotOverYet increments ──
{
  const pending = [
    fixtureSnapshot({ snapshotId: "s7", gameId: "g3", batterId: "p1" }),
    fixtureSnapshot({ snapshotId: "s8", gameId: "g3", batterId: "p2" }),
  ];
  const { storage, insertedRows } = makeFakeStorage(pending, {});
  const summary = await reconcilePlateHrV2Labels({}, { storage, fetchGameStatus: async () => "in_progress" });

  ok(summary.skippedGameNotOverYet === 2, "both snapshots counted as skipped, not manual_review");
  ok(summary.manualReview === 0, "manual_review never fires just because a game hasn't finished");
  ok(insertedRows.length === 0, "zero inserts for an in-progress game");
}

// ── 3b. A suspended game -> 0 inserts, skipped (never a stuck censored label) ──
// The regression this guards: labels are append-only, and
// getPlateHrV2LockedSnapshotsPendingLabel excludes any snapshot that already
// has a label row regardless of disposition. If a suspended game were
// labeled censored immediately, it could never be revisited once it resumes
// under the same gamePk and reaches a real final.
{
  const pending = [
    fixtureSnapshot({ snapshotId: "s10", gameId: "g5", batterId: "p1" }),
    fixtureSnapshot({ snapshotId: "s11", gameId: "g5", batterId: "p2" }),
  ];
  const { storage, insertedRows } = makeFakeStorage(pending, { g5: [{ playerId: "p1", gamePk: "778005", ab: 2, bb: 0, hr: 0, abResults: null }] });
  const summary = await reconcilePlateHrV2Labels({}, { storage, fetchGameStatus: async () => "suspended" });

  ok(summary.skippedGameNotOverYet === 2, "suspended game snapshots are skipped, not labeled");
  ok(summary.censored === 0, "no premature censored label is written for a suspended game");
  ok(insertedRows.length === 0, "zero inserts for a suspended game — it stays pending for a future run");
}

// ── 4. Re-running against an already-labeled snapshot increments alreadyLabeled, not inserted ──
{
  const pending = [fixtureSnapshot({ snapshotId: "s9", gameId: "g4", batterId: "p1" })];
  const { storage } = makeFakeStorage(pending, { g4: [{ playerId: "p1", gamePk: "778004", ab: 4, bb: 0, hr: 0, abResults: null }] });

  const first = await reconcilePlateHrV2Labels({}, { storage, fetchGameStatus: async () => "final" });
  ok(first.inserted === 1 && first.alreadyLabeled === 0, "first run inserts the label");

  // Second run against the SAME fake storage (same insertedKeys Set) simulates
  // a re-run where getPlateHrV2LockedSnapshotsPendingLabel's real WHERE-NOT-
  // EXISTS filter failed to exclude it (defensive belt-and-suspenders check).
  const second = await reconcilePlateHrV2Labels({}, { storage, fetchGameStatus: async () => "final" });
  ok(second.inserted === 0 && second.alreadyLabeled === 1, "second run against the same snapshot increments alreadyLabeled, not inserted");
}

console.log(`\nplateHrV2LabelReconciler.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
