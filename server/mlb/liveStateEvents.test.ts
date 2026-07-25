// MLB Live Edge state-event classification — unit tests.
// Run: npx tsx server/mlb/liveStateEvents.test.ts
//
// Verifies the core product rule: TIME detects events, EVENTS drive
// computation. An ordinary pitch is not a baseball event; a completed PA, real
// contact, an inning transition and a pitcher change are.
//
// Pure module — no fetch, no env, no module state to reset.

import {
  classifyStateChange,
  isMaterialChange,
  computeImpactedMarkets,
  affectedActors,
  PITCH_COUNT_THRESHOLDS,
} from "./liveStateEvents";
import type { GameStateCache } from "./dataPullService";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_LIVE_STATE_EVENTS_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function baseState(over: Partial<GameStateCache> = {}): GameStateCache {
  return {
    inning: 3,
    isTopInning: true,
    outs: 1,
    runnersOnBase: ["first"],
    battingOrder: [
      { playerId: "b1", playerName: "Batter One", team: "NYY", slot: 1 },
      { playerId: "b2", playerName: "Batter Two", team: "NYY", slot: 2 },
      { playerId: "b3", playerName: "Batter Three", team: "NYY", slot: 3 },
    ],
    currentBatter: { playerId: "b1", playerName: "Batter One" },
    pitcherInGame: { playerId: "p1", playerName: "Pitcher One", team: "BOS", throws: "R" },
    pitchCount: 70,
    timesThroughOrder: 2,
    homeScore: 1,
    awayScore: 2,
    totalPlays: 20,
    homeTeamAbbr: "BOS",
    awayTeamAbbr: "NYY",
    fetchedAt: Date.now(),
    battedBallEvents: 12,
    ...over,
  };
}

// ─── Group A: no-op poll ───────────────────────────────────────────────────────
{
  const prev = baseState();
  const next = baseState({ fetchedAt: Date.now() + 10_000 });
  const triggers = classifyStateChange(prev, next);
  check("A1: identical baseball state yields zero triggers", triggers.length === 0, JSON.stringify(triggers));
  check("A2: isMaterialChange false on a no-op poll", isMaterialChange(triggers) === false);
}

// ─── Group B: ordinary pitches are NOT ball_in_play ────────────────────────────
{
  // Called strike: pitchCount +1, no batted ball, no completed play.
  const prev = baseState({ pitchCount: 70, battedBallEvents: 12 });
  const next = baseState({ pitchCount: 71, battedBallEvents: 12 });
  const triggers = classifyStateChange(prev, next);
  check("B1: a called strike (pitchCount +1) produces NO triggers at all", triggers.length === 0, JSON.stringify(triggers));
  check("B2: a called strike is never classified ball_in_play", !triggers.includes("ball_in_play"));
}
{
  // Four ordinary pitches in a row — still nothing.
  let prev = baseState({ pitchCount: 70, battedBallEvents: 12 });
  let anyTrigger = false;
  for (let i = 1; i <= 4; i++) {
    const next = baseState({ pitchCount: 70 + i, battedBallEvents: 12 });
    if (classifyStateChange(prev, next).length > 0) anyTrigger = true;
    prev = next;
  }
  check("B3: a 4-pitch sequence with no contact produces no triggers", anyTrigger === false);
}
{
  // Missing battedBallEvents on both sides = unknown, never inferred contact.
  const prev = baseState({ pitchCount: 70, battedBallEvents: undefined });
  const next = baseState({ pitchCount: 75, battedBallEvents: undefined });
  const triggers = classifyStateChange(prev, next);
  check("B4: absent battedBallEvents never manufactures ball_in_play", !triggers.includes("ball_in_play"), JSON.stringify(triggers));
  check("B5: pitch-count threshold still crosses without contact data", triggers.includes("pitch_count_threshold"));
}

// ─── Group C: real contact ─────────────────────────────────────────────────────
{
  const prev = baseState({ pitchCount: 70, battedBallEvents: 12 });
  const next = baseState({ pitchCount: 71, battedBallEvents: 13 });
  const triggers = classifyStateChange(prev, next);
  check("C1: a real batted ball emits ball_in_play", triggers.includes("ball_in_play"), JSON.stringify(triggers));
  const impacted = computeImpactedMarkets(triggers);
  check("C2: contact impacts the HR/contact markets", impacted.has("home_runs") && impacted.has("hits") && impacted.has("total_bases"));
}

// ─── Group D: completed AB ─────────────────────────────────────────────────────
{
  const prev = baseState({ totalPlays: 20, currentBatter: { playerId: "b1", playerName: "Batter One" } });
  const next = baseState({ totalPlays: 21, currentBatter: { playerId: "b2", playerName: "Batter Two" } });
  const triggers = classifyStateChange(prev, next);
  check("D1: a completed play emits ab_completed", triggers.includes("ab_completed"), JSON.stringify(triggers));
  check("D2: the batter advancing emits new_ab", triggers.includes("new_ab"));

  const actors = affectedActors(triggers, prev, next);
  check("D3: ab_completed is narrowable (not game-wide)", actors.all === false, JSON.stringify(Array.from(actors.playerIds)));
  check("D4: the batter who just finished is included", actors.playerIds.has("b1"));
  check("D5: the new batter is included", actors.playerIds.has("b2"));
  check("D6: the current pitcher is included", actors.playerIds.has("p1"));
  check("D7: the on-deck batter is included", actors.playerIds.has("b3"));
}

// ─── Group E: pitch-count threshold crossings ──────────────────────────────────
{
  check("E1: canonical thresholds are unchanged", JSON.stringify(PITCH_COUNT_THRESHOLDS) === JSON.stringify([50, 65, 75, 85, 95, 105]));

  const cross = classifyStateChange(baseState({ pitchCount: 74 }), baseState({ pitchCount: 75 }));
  check("E2: 74 -> 75 crosses a threshold", cross.includes("pitch_count_threshold"));

  const noCross = classifyStateChange(baseState({ pitchCount: 75 }), baseState({ pitchCount: 76 }));
  check("E3: 75 -> 76 does NOT re-fire the same threshold", !noCross.includes("pitch_count_threshold"), JSON.stringify(noCross));

  const mid = classifyStateChange(baseState({ pitchCount: 71 }), baseState({ pitchCount: 72 }));
  check("E4: 71 -> 72 is not a threshold event", !mid.includes("pitch_count_threshold"));
  const mid2 = classifyStateChange(baseState({ pitchCount: 72 }), baseState({ pitchCount: 73 }));
  check("E5: 72 -> 73 is not a threshold event", !mid2.includes("pitch_count_threshold"));
}

// ─── Group F: inning change ────────────────────────────────────────────────────
{
  const triggers = classifyStateChange(
    baseState({ inning: 3, isTopInning: true }),
    baseState({ inning: 3, isTopInning: false }),
  );
  check("F1: a half-inning flip is an inning_change", triggers.includes("inning_change"));

  const full = classifyStateChange(baseState({ inning: 3 }), baseState({ inning: 4 }));
  check("F2: a full inning advance is an inning_change", full.includes("inning_change"));

  const impacted = computeImpactedMarkets(full);
  check("F3: inning_change impacts every market", impacted.size >= 7, String(impacted.size));

  const actors = affectedActors(full, baseState({ inning: 3 }), baseState({ inning: 4 }));
  check("F4: inning_change forces game-wide recalculation", actors.all === true);
}

// ─── Group G: pitcher change ───────────────────────────────────────────────────
{
  const prev = baseState();
  const next = baseState({ pitcherInGame: { playerId: "p2", playerName: "Reliever", team: "BOS", throws: "L" } });
  const triggers = classifyStateChange(prev, next);
  check("G1: a new pitcher emits pitcher_change", triggers.includes("pitcher_change"));

  const actors = affectedActors(triggers, prev, next);
  check("G2: pitcher_change forces game-wide recalculation", actors.all === true);
}

// ─── Group H: lineup substitution + TTO ────────────────────────────────────────
{
  const prev = baseState();
  const next = baseState({
    battingOrder: [...baseState().battingOrder, { playerId: "b4", playerName: "Sub", team: "NYY", slot: 4 }],
  });
  check("H1: a lineup size change emits lineup_substitution", classifyStateChange(prev, next).includes("lineup_substitution"));
}

// ─── Group I: market-family closure ────────────────────────────────────────────
{
  // runner_change maps to {hits,total_bases,hrr}; the `power` family is
  // [home_runs,total_bases]. Without closure total_bases would be re-ranked
  // against a family missing home_runs and both could end up isFlagship.
  const impacted = computeImpactedMarkets(["runner_change"]);
  check("I1: runner_change closure pulls in home_runs (power family)", impacted.has("home_runs"), JSON.stringify(Array.from(impacted)));
  check("I2: closure keeps the originally impacted markets", impacted.has("hits") && impacted.has("total_bases") && impacted.has("hrr"));
  check("I3: closure does not resurrect disabled markets", !impacted.has("walks_allowed" as any) && !impacted.has("hr_allowed" as any));
}

// ─── Group J: repeated no-change polls can never accumulate evidence ───────────
{
  // The HR promotion gate (consecutivePromoteTicks) is evaluation-counted, so
  // the ONLY protection against a poll manufacturing promotion evidence is
  // that a no-change poll must produce no triggers and therefore no engine run.
  const prev = baseState();
  let totalTriggers = 0;
  for (let i = 0; i < 25; i++) {
    totalTriggers += classifyStateChange(prev, baseState({ fetchedAt: Date.now() + i * 10_000 })).length;
  }
  check("J1: 25 repeated identical state observations produce zero triggers", totalTriggers === 0, String(totalTriggers));
}

console.log(`[MLB_LIVE_STATE_EVENTS_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MLB_LIVE_STATE_EVENTS_TEST] OK");
