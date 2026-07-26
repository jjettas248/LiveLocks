// Plate HR Probability V2 — durable outcome source invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2OutcomeSource.test.ts

import {
  mapMlbScheduleStatus,
  reduceBatterOutcomeFacts,
  resolvePlateHrV2GameOutcome,
} from "./plateHrV2OutcomeSource";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── 1. mapMlbScheduleStatus ──────────────────────────────────────────────────
{
  ok(mapMlbScheduleStatus({ abstractGameState: "Final", codedGameState: "F" }) === "final", "abstractGameState=Final maps to final");
  ok(mapMlbScheduleStatus({ codedGameState: "F" }) === "final", "codedGameState=F alone maps to final");
  ok(mapMlbScheduleStatus({ abstractGameState: "Preview", detailedState: "Postponed" }) === "postponed", "detailedState containing 'Postponed' maps to postponed");
  ok(mapMlbScheduleStatus({ abstractGameState: "Live", detailedState: "Suspended: Rain" }) === "suspended", "detailedState containing 'Suspended' maps to suspended (wins over Live abstractGameState)");
  ok(mapMlbScheduleStatus({ abstractGameState: "Live", detailedState: "In Progress" }) === "in_progress", "abstractGameState=Live maps to in_progress");
  ok(mapMlbScheduleStatus({ abstractGameState: "Preview" }) === "unknown", "abstractGameState=Preview (not started) maps to unknown, not a guessed final/live state");
  ok(mapMlbScheduleStatus({ abstractGameState: "SomethingNewMlbInvented" }) === "unknown", "unrecognized abstractGameState degrades to unknown, never guessed");
  ok(mapMlbScheduleStatus(null) === "unknown", "null input maps to unknown");
  ok(mapMlbScheduleStatus(undefined) === "unknown", "undefined input maps to unknown");
  ok(mapMlbScheduleStatus({}) === "unknown", "empty object maps to unknown");
}

// ── 2. reduceBatterOutcomeFacts ──────────────────────────────────────────────
{
  const multiHr = reduceBatterOutcomeFacts([
    {
      playerId: "p1", ab: 4, bb: 1,
      abResults: JSON.stringify([
        { hitType: "single", inning: 1, half: "top" },
        { hitType: "home_run", inning: 3, half: "top" },
        { hitType: null, inning: 5, half: "top" },
        { hitType: "home_run", inning: 7, half: "top" },
      ]),
    },
  ]);
  const p1 = multiHr.get("p1")!;
  ok(p1.hrCountToday === 2, "multi-HR game counts both home runs, not just the first");
  ok(p1.firstHr?.plateAppearanceNumber === 2 && p1.firstHr?.inning === 3, "firstHr reflects only the FIRST home run (2nd AB), not the later one");
  ok(p1.firstHr?.firstAb === false, "firstHr correctly reports this was not the batter's first AB");
  ok(p1.paCountObserved === 5, "paCountObserved = ab + bb (4+1)");

  const zeroHr = reduceBatterOutcomeFacts([
    { playerId: "p2", ab: 3, bb: 0, abResults: JSON.stringify([{ hitType: "double", inning: 2, half: "bottom" }]) },
  ]);
  const p2 = zeroHr.get("p2")!;
  ok(p2.hrCountToday === 0, "zero-HR game counts zero");
  ok(p2.firstHr === null, "firstHr is null with no home run");

  const nullAbResults = reduceBatterOutcomeFacts([{ playerId: "p3", ab: 0, bb: 0, abResults: null }]);
  const p3 = nullAbResults.get("p3")!;
  ok(p3.hasBoxScoreRow === true && p3.hrCountToday === 0 && p3.paCountObserved === 0, "null abResults (e.g. 0-PA row) degrades to zero facts, still hasBoxScoreRow:true");

  let threw = false;
  let malformed: ReturnType<typeof reduceBatterOutcomeFacts> | null = null;
  try {
    malformed = reduceBatterOutcomeFacts([{ playerId: "p4", ab: 2, bb: 0, abResults: "{not valid json[" }]);
  } catch {
    threw = true;
  }
  ok(!threw, "malformed abResults JSON never throws");
  ok(malformed?.get("p4")?.hrCountToday === 0, "malformed abResults JSON degrades to zero HR facts, not fabricated data");

  const notAnArray = reduceBatterOutcomeFacts([{ playerId: "p5", ab: 1, bb: 0, abResults: JSON.stringify({ not: "an array" }) }]);
  ok(notAnArray.get("p5")?.hrCountToday === 0, "abResults JSON that parses but isn't an array degrades to zero HR facts");
}

// ── 3. resolvePlateHrV2GameOutcome ──────────────────────────────────────────
{
  let statusFetchCount = 0;
  const fakeFetchGameStatus = async () => { statusFetchCount++; return "final" as const; };
  const rows = [
    { playerId: "p1", gamePk: "778001", ab: 4, bb: 0, abResults: JSON.stringify([{ hitType: "home_run", inning: 2, half: "top" }]) },
    { playerId: "p2", gamePk: "778001", ab: 3, bb: 1, abResults: null },
    { playerId: "p3", gamePk: "778001", ab: 5, bb: 0, abResults: null },
  ];
  const bundle = await resolvePlateHrV2GameOutcome("g1", {
    getGamePlayerStats: async () => rows,
    fetchGameStatus: fakeFetchGameStatus,
  });
  ok(statusFetchCount === 1, `exactly one status fetch fires for one game with 3 batters (got ${statusFetchCount})`);
  ok(bundle.game.gameStatus === "final", "resolved game status comes from the injected fetch");
  ok(bundle.game.gamePk === "778001", "gamePk resolved from the first row that has one");
  ok(bundle.batters.size === 3, "all 3 batters present in the bundle");
  ok(bundle.anyBoxScoreRowsForGame === true, "anyBoxScoreRowsForGame is true when rows exist");

  const emptyBundle = await resolvePlateHrV2GameOutcome("g2", {
    getGamePlayerStats: async () => [],
    fetchGameStatus: fakeFetchGameStatus,
  });
  ok(emptyBundle.anyBoxScoreRowsForGame === false, "anyBoxScoreRowsForGame is false when zero rows exist");
  ok(emptyBundle.game.gamePk === null, "gamePk is null with zero rows");
  ok(emptyBundle.game.gameStatus === "unknown", "no gamePk means no status fetch is attempted; status is honestly unknown");
}

console.log(`\nplateHrV2OutcomeSource.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
