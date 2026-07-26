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
      playerId: "p1", ab: 4, bb: 1, hr: 2,
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
    { playerId: "p2", ab: 3, bb: 0, hr: 0, abResults: JSON.stringify([{ hitType: "double", inning: 2, half: "bottom" }]) },
  ]);
  const p2 = zeroHr.get("p2")!;
  ok(p2.hrCountToday === 0, "zero-HR game counts zero");
  ok(p2.firstHr === null, "firstHr is null with no home run");

  const nullAbResults = reduceBatterOutcomeFacts([{ playerId: "p3", ab: 0, bb: 0, hr: 0, abResults: null }]);
  const p3 = nullAbResults.get("p3")!;
  ok(p3.hasBoxScoreRow === true && p3.hrCountToday === 0 && p3.paCountObserved === 0, "null abResults (e.g. 0-PA row) degrades to zero facts, still hasBoxScoreRow:true");

  let threw = false;
  let malformed: ReturnType<typeof reduceBatterOutcomeFacts> | null = null;
  try {
    malformed = reduceBatterOutcomeFacts([{ playerId: "p4", ab: 2, bb: 0, hr: 0, abResults: "{not valid json[" }]);
  } catch {
    threw = true;
  }
  ok(!threw, "malformed abResults JSON never throws");
  ok(malformed?.get("p4")?.hrCountToday === 0, "malformed abResults JSON degrades to zero HR facts, not fabricated data");

  const notAnArray = reduceBatterOutcomeFacts([{ playerId: "p5", ab: 1, bb: 0, hr: 0, abResults: JSON.stringify({ not: "an array" }) }]);
  ok(notAnArray.get("p5")?.hrCountToday === 0, "abResults JSON that parses but isn't an array degrades to zero HR facts");
}

// ── 2b. hr column is the canonical HR source, not abResults (the actual
// Codex-reported regression: abResults comes from the in-memory contact
// cache and can be null/incomplete for a batter with a real, confirmed HR) ──
{
  // The exact regression: a batter with a full official box-score line
  // (ab+bb>0) but no captured abResults (e.g. after a restart) — the durable
  // hr column says they homered. Before the fix this produced hrCountToday:0
  // and a resolved-false label for a real home run.
  const missedContactHydration = reduceBatterOutcomeFacts([
    { playerId: "p6", ab: 4, bb: 0, hr: 1, abResults: null },
  ]);
  const p6 = missedContactHydration.get("p6")!;
  ok(p6.hrCountToday === 1, "hr:1 with null abResults still reports hrCountToday:1 — a missed contact-feed hydration never masks a real home run");
  ok(p6.firstHr === null, "firstHr honestly stays null (no location detail available) rather than fabricating an inning/PA for a HR abResults can't confirm");

  // hr:0 with abResults reporting a HR — the durable column wins (it's the
  // official record); abResults disagreeing is treated as the less
  // authoritative source, not silently trusted over the box score.
  const trustsHrColumnOverAbResults = reduceBatterOutcomeFacts([
    { playerId: "p7", ab: 4, bb: 0, hr: 0, abResults: JSON.stringify([{ hitType: "home_run", inning: 1, half: "top" }]) },
  ]);
  ok(trustsHrColumnOverAbResults.get("p7")?.hrCountToday === 0, "hr:0 (the durable box-score count) takes precedence over a disagreeing abResults entry");

  // hr:null (a row persisted before this column existed) falls back to
  // counting abResults — the honest best-effort path for historical rows only.
  const historicalRowFallback = reduceBatterOutcomeFacts([
    { playerId: "p8", ab: 4, bb: 0, hr: null, abResults: JSON.stringify([{ hitType: "home_run", inning: 2, half: "bottom" }]) },
  ]);
  const p8 = historicalRowFallback.get("p8")!;
  ok(p8.hrCountToday === 1, "hr:null (predates the column) falls back to the abResults-derived count");
  ok(p8.firstHr?.inning === 2, "firstHr is still derived from abResults regardless of which source hrCountToday came from");
}

// ── 3. resolvePlateHrV2GameOutcome ──────────────────────────────────────────
{
  let statusFetchCount = 0;
  const fakeFetchGameStatus = async () => { statusFetchCount++; return "final" as const; };
  const rows = [
    { playerId: "p1", gamePk: "778001", ab: 4, bb: 0, hr: 1, abResults: JSON.stringify([{ hitType: "home_run", inning: 2, half: "top" }]) },
    { playerId: "p2", gamePk: "778001", ab: 3, bb: 1, hr: 0, abResults: null },
    { playerId: "p3", gamePk: "778001", ab: 5, bb: 0, hr: 0, abResults: null },
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
