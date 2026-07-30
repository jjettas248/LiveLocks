// MLB Live Edge Trust Recovery (Phase 2) — live player-state contract tests.
// Covers: HRR = hits + runs + rbi (never hr + r + rbi), pitcher current-stat
// mapping from the typed live box score (never a hardcoded 0), explicit-zero
// vs missing-entry distinction, and opponent-pitcher integrity (offensive
// team by top/bottom inning, same-team matchup rejection).
// Run: npx tsx server/mlb/liveGameStateContract.test.ts

import {
  computeBatterCurrentStat,
  evaluatePitcherCurrentStat,
  validateBatterPitcherMatchup,
} from "./liveGameStateContract";
import type { GameBoxScorePlayer, GamePitchingBoxScorePitcher } from "./dataPullService";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[LIVE_GAME_STATE_CONTRACT_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function box(overrides: Partial<GameBoxScorePlayer> = {}): GameBoxScorePlayer {
  return {
    playerId: "b1", playerName: "Test Batter", team: "NYY",
    hits: 0, hr: 0, ab: 4, bb: 0, rbi: 0, so: 0, tb: 0, runs: 0, tbExact: true,
    ...overrides,
  };
}

function pbox(overrides: Partial<GamePitchingBoxScorePitcher> = {}): GamePitchingBoxScorePitcher {
  return {
    pitcherId: "p1", pitcherName: "Test Pitcher", team: "BOS",
    strikeOuts: 0, outsRecorded: 0, baseOnBalls: 0, earnedRuns: 0, hits: 0, homeRuns: 0,
    ...overrides,
  };
}

// ─── HRR = hits + runs + rbi, never hr + r + rbi ───────────────────────────
{
  const b = box({ hits: 2, runs: 1, rbi: 3, hr: 0 });
  check("HRR: hits=2,runs=1,rbi=3,hr=0 -> 6", computeBatterCurrentStat("hrr" as any, b) === 6,
    `got ${computeBatterCurrentStat("hrr" as any, b)}`);

  // A case where hits != hr and runs != 0 — the old hr+r+rbi formula (with
  // r always reading as 0) would have produced hr+rbi = 0+2 = 2, not 6.
  const b2 = box({ hits: 3, runs: 2, rbi: 1, hr: 0 });
  check("HRR uses hits/runs, not hr (differs from the old hr+rbi formula)",
    computeBatterCurrentStat("hrr" as any, b2) === 6, `got ${computeBatterCurrentStat("hrr" as any, b2)}`);
}

// ─── Other batter markets unaffected ────────────────────────────────────────
{
  const b = box({ hits: 2, hr: 1, tb: 5, runs: 3, rbi: 2 });
  check("hits market reads hits", computeBatterCurrentStat("hits" as any, b) === 2);
  check("home_runs market reads hr", computeBatterCurrentStat("home_runs" as any, b) === 1);
  check("total_bases market reads tb", computeBatterCurrentStat("total_bases" as any, b) === 5);
  check("missing box -> 0", computeBatterCurrentStat("hits" as any, undefined) === 0);
}

// ─── Pitcher: real box-score line, never a hardcoded 0 ─────────────────────
{
  const p = pbox({ strikeOuts: 5, outsRecorded: 14, hits: 4 });
  check("pitcher_strikeouts -> 5", evaluatePitcherCurrentStat("pitcher_strikeouts" as any, p).value === 5);
  check("pitcher_outs -> 14", evaluatePitcherCurrentStat("pitcher_outs" as any, p).value === 14);
  check("hits_allowed -> 4", evaluatePitcherCurrentStat("hits_allowed" as any, p).value === 4);

  const zeroP = pbox({ strikeOuts: 0, outsRecorded: 0, hits: 0 });
  const zeroResult = evaluatePitcherCurrentStat("pitcher_strikeouts" as any, zeroP);
  check("explicit zero remains zero AND known=true", zeroResult.value === 0 && zeroResult.known === true);

  const missing = evaluatePitcherCurrentStat("pitcher_strikeouts" as any, undefined);
  check("missing pitching entry -> value=0 but known=false (fails closed)",
    missing.value === 0 && missing.known === false);
}

// ─── Opponent-pitcher integrity ─────────────────────────────────────────────
{
  // Top of the inning -> away team bats, home team pitches.
  const topValid = validateBatterPitcherMatchup({
    batterTeam: "NYY", pitcherTeam: "BOS", pitcherKnown: true,
    isTopInning: true, homeTeamAbbr: "BOS", awayTeamAbbr: "NYY",
  });
  check("top inning: away batter vs home pitcher is valid", topValid.valid, JSON.stringify(topValid));

  // Bottom of the inning -> home team bats, away team pitches.
  const bottomValid = validateBatterPitcherMatchup({
    batterTeam: "BOS", pitcherTeam: "NYY", pitcherKnown: true,
    isTopInning: false, homeTeamAbbr: "BOS", awayTeamAbbr: "NYY",
  });
  check("bottom inning: home batter vs away pitcher is valid", bottomValid.valid, JSON.stringify(bottomValid));

  // Same-team matchup: a batter evaluated against their own team's pitcher.
  const sameTeam = validateBatterPitcherMatchup({
    batterTeam: "NYY", pitcherTeam: "NYY", pitcherKnown: true,
    isTopInning: true, homeTeamAbbr: "BOS", awayTeamAbbr: "NYY",
  });
  check("same-team batter/pitcher matchup is rejected",
    !sameTeam.valid && sameTeam.reason === "same_team_matchup", JSON.stringify(sameTeam));

  // Batter on the wrong side of the ball this half-inning (e.g. stale lineup
  // narrowing after an inning flip) — rejected even before the same-team check.
  const wrongSide = validateBatterPitcherMatchup({
    batterTeam: "BOS", pitcherTeam: "NYY", pitcherKnown: true,
    isTopInning: true, homeTeamAbbr: "BOS", awayTeamAbbr: "NYY",
  });
  check("batter not on the offensive team this half-inning is rejected",
    !wrongSide.valid && wrongSide.reason === "batter_not_on_offense", JSON.stringify(wrongSide));

  // No pitcher identified yet — never invent one.
  const noPitcher = validateBatterPitcherMatchup({
    batterTeam: "NYY", pitcherTeam: undefined, pitcherKnown: false,
    isTopInning: true, homeTeamAbbr: "BOS", awayTeamAbbr: "NYY",
  });
  check("unknown pitcher -> rejected (never invented)",
    !noPitcher.valid && noPitcher.reason === "no_active_pitcher", JSON.stringify(noPitcher));
}

console.log(`[LIVE_GAME_STATE_CONTRACT_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[LIVE_GAME_STATE_CONTRACT_TEST] OK");
