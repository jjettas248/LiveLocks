// Mound V2 shadow grading — pure decision-logic invariants (no storage
// import, no DATABASE_URL needed). Sweep/regrade orchestration tests that
// touch storage.ts live in moundV2ShadowGrading.integration.test.ts.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2ShadowGrading.test.ts

import {
  classifyMoundV2GameStatusForGrading,
  deriveMoundV2FinalResult,
  computeMoundV2GradingDecision,
} from "./moundV2ShadowGrading";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── classifyMoundV2GameStatusForGrading ─────────────────────────────────
{
  ok(classifyMoundV2GameStatusForGrading(null) === "unknown", "null status -> unknown");
  ok(classifyMoundV2GameStatusForGrading(undefined) === "unknown", "undefined status -> unknown");
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Final", detailedState: "Final", codedGameState: "F" }) === "final",
    "abstractGameState=Final, detailedState=Final -> final",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Final", detailedState: "Cancelled", codedGameState: "C" }) === "cancelled",
    "detailedState containing 'Cancelled' -> cancelled, even though abstractGameState=Final",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Final", detailedState: "Completed Early: Rain", codedGameState: "F" }) === "final",
    "'Completed Early: Rain' is a real final, not cancelled (doesn't contain 'cancel')",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Live", detailedState: "In Progress", codedGameState: "I" }) === "in_progress",
    "abstractGameState=Live, ordinary detailedState -> in_progress",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Live", detailedState: "Suspended: Rain", codedGameState: "U" }) === "postponed_or_suspended",
    "'Suspended' keyword wins over abstractGameState=Live",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" }) === "not_yet_played",
    "abstractGameState=Preview, ordinary detailedState -> not_yet_played",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Preview", detailedState: "Postponed", codedGameState: "O" }) === "postponed_or_suspended",
    "'Postponed' keyword -> postponed_or_suspended",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "Preview", detailedState: "Delayed Start", codedGameState: "S" }) === "postponed_or_suspended",
    "'Delayed' keyword under Preview -> postponed_or_suspended",
  );
  ok(
    classifyMoundV2GameStatusForGrading({ abstractGameState: "", detailedState: "", codedGameState: "" }) === "unknown",
    "empty/unrecognized status fields -> unknown, never assumed final",
  );
}

// ── deriveMoundV2FinalResult ─────────────────────────────────────────────
{
  ok(deriveMoundV2FinalResult(6.5, 7) === "over", "final 7 vs line 6.5 -> over");
  ok(deriveMoundV2FinalResult(6.5, 6) === "under", "final 6 vs line 6.5 -> under");
  ok(deriveMoundV2FinalResult(6, 6) === "push", "final 6 vs integer line 6 -> push");
  ok(deriveMoundV2FinalResult(6, 7) === "over", "final 7 vs integer line 6 -> over (no push)");
  ok(deriveMoundV2FinalResult(6, 5) === "under", "final 5 vs integer line 6 -> under (no push)");
  ok(deriveMoundV2FinalResult(null, 7) === null, "null line -> null result, never fabricated");
  ok(deriveMoundV2FinalResult(Number.NaN, 7) === null, "non-finite line -> null result");
}

// ── computeMoundV2GradingDecision ────────────────────────────────────────
const FINAL_STATUS = { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" };
const CANCELLED_STATUS = { abstractGameState: "Final", detailedState: "Cancelled", codedGameState: "C" };
const LIVE_STATUS = { abstractGameState: "Live", detailedState: "In Progress", codedGameState: "I" };

const SAMPLE_PITCHER_LINE = {
  pitcherId: "p1", pitcherName: "P", team: "NYY",
  strikeOuts: 7, outsRecorded: 16, baseOnBalls: 2, earnedRuns: 3, hits: 5, homeRuns: 1,
};

{
  const unknownMarket = computeMoundV2GradingDecision({
    market: "pitcher_hits_allowed", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: FINAL_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1", "p2"] },
  });
  ok(unknownMarket.kind === "hold" && unknownMarket.reason === "unknown_market", "unrecognized market -> hold/unknown_market, never fabricated");

  const cancelledNoLine = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: CANCELLED_STATUS, pitcherLine: null, pitcherOrderForTeam: null },
  });
  ok(cancelledNoLine.kind === "void" && cancelledNoLine.reason === "game_cancelled", "cancelled game, no pitcher line -> void/game_cancelled");

  const cancelledWithLine = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: CANCELLED_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1"] },
  });
  ok(cancelledWithLine.kind === "void" && cancelledWithLine.reason === "game_cancelled", "cancellation wins even when a partial pitcher line exists");

  const finalNoAppearance = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: FINAL_STATUS, pitcherLine: null, pitcherOrderForTeam: null },
  });
  ok(finalNoAppearance.kind === "void" && finalNoAppearance.reason === "pitcher_no_appearance", "final game, pitcher never appears in boxscore -> void (likely a pregame scratch)");

  const finalGraded = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: FINAL_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1"] },
  });
  ok(finalGraded.kind === "grade" && finalGraded.finalStatValue === 7 && finalGraded.finalResult === "over", "final game, strikeouts market -> graded with real strikeOuts (7) vs line 6.5 = over");

  const finalGradedOutsNoLine = computeMoundV2GradingDecision({
    market: "pitcher_outs", pitcherId: "p1", frozenLine: null,
    officialStats: { gameStatus: FINAL_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1"] },
  });
  ok(finalGradedOutsNoLine.kind === "grade" && finalGradedOutsNoLine.finalStatValue === 16 && finalGradedOutsNoLine.finalResult === null, "outs market with no real line -> graded (finalStatValue=16 honestly recorded) but finalResult null, never fabricated");

  const liveNotPulled = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: LIVE_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1"] },
  });
  ok(liveNotPulled.kind === "hold" && liveNotPulled.reason === "outing_in_progress", "game live, pitcher still last in appearance order (not pulled) -> hold/outing_in_progress");

  const livePulled = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: LIVE_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1", "p2"] },
  });
  ok(livePulled.kind === "grade" && livePulled.finalStatValue === 7, "game still live overall, but pitcher already pulled (p2 relieved) -> grades early via outingComplete, mirrors V1's hasPitcherBeenPulled");

  const liveNoAppearanceYet = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: LIVE_STATUS, pitcherLine: null, pitcherOrderForTeam: null },
  });
  ok(liveNoAppearanceYet.kind === "hold" && liveNoAppearanceYet.reason === "awaiting_pitcher_appearance", "game live, pitcher hasn't recorded a line yet (hasn't entered) -> hold, never voided prematurely");

  // "Never grade against a later line" — the function is a pure function of
  // its own frozenLine parameter; varying it changes only finalResult, never
  // finalStatValue, and there is no other input path (no live lookup) by
  // which a line could reach this function.
  const gradedAtOldLine = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 6.5,
    officialStats: { gameStatus: FINAL_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1"] },
  });
  const gradedAtHypotheticalLaterLine = computeMoundV2GradingDecision({
    market: "pitcher_strikeouts", pitcherId: "p1", frozenLine: 8.5,
    officialStats: { gameStatus: FINAL_STATUS, pitcherLine: SAMPLE_PITCHER_LINE, pitcherOrderForTeam: ["p1"] },
  });
  ok(
    gradedAtOldLine.kind === "grade" && gradedAtHypotheticalLaterLine.kind === "grade" &&
    gradedAtOldLine.finalStatValue === gradedAtHypotheticalLaterLine.finalStatValue &&
    gradedAtOldLine.finalResult === "over" && gradedAtHypotheticalLaterLine.finalResult === "under",
    "finalStatValue is identical regardless of which line is passed in; finalResult tracks ONLY the caller-supplied frozenLine — proving the function never substitutes a different/later line itself",
  );
}

console.log(`\nmoundV2ShadowGrading.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
