// Pre-Game Power Radar — public-visibility predicate invariants.
//
// Guards the "player vanishes right after homering" regression: a `final`
// game whose shadow grader hasn't stamped `status: "graded"` yet must stay
// visible as a pending/locked row (same treatment as `live`), not disappear
// the instant `gameStatus` flips to `"final"`.
//
// Run: npx tsx server/mlb/pregamePowerRadar/diagnostics.test.ts

import { isPublicPregameSignal, positiveDrivers } from "./diagnostics";
import type { PregamePowerSignal, PregameOutcome } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<PregamePowerSignal>): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [
      { key: "d1", label: "Driver 1", direction: "positive" },
      { key: "d2", label: "Driver 2", direction: "positive" },
    ],
    warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
}

const gradedWin: PregameOutcome = {
  hitHr: true, totalBases: 4, hitRecorded: true, rbiRecorded: 2,
  resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "pregame_win", userVisible: true,
  hrInning: 4, hrHalf: "bottom", plateAppearanceNumber: 2, firstAbPregameWin: false,
};

const gradedMiss: PregameOutcome = {
  hitHr: false, totalBases: 0, hitRecorded: false, rbiRecorded: 0,
  resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "calibration_miss", userVisible: false,
  hrInning: null, hrHalf: null, plateAppearanceNumber: null, firstAbPregameWin: false,
};

// A TB-primary graded outcome (no HR, some total bases) — a completed miss on
// the HR track but a real completed Total-Bases result. Its VISIBILITY must be
// identical to any other graded target (server retention is market-agnostic;
// the market-aware final display is client-side).
const gradedTb: PregameOutcome = {
  hitHr: false, totalBases: 2, hitRecorded: true, rbiRecorded: 1,
  resolvedAt: "2026-07-01T23:30:00.000Z",
  outcome: "calibration_miss", userVisible: false,
  hrInning: null, hrHalf: null, plateAppearanceNumber: null, firstAbPregameWin: false,
};

// ── 1. Scheduled/pre pregame target → visible via initial eligibility ───────
{
  const signal = sig({ gameStatus: "scheduled", status: "active" });
  ok(isPublicPregameSignal(signal) === true, "pregame scheduled target is visible (initial eligibility)");
}

// ── 2. Final + locked + not yet graded + flagged → stays visible (retention) ─
{
  const signal = sig({ gameStatus: "final", status: "locked", outcomes: null, everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === true, "final-but-ungraded locked flagged signal stays visible");
}

// ── 3. Graded HR + flagged → visible ────────────────────────────────────────
{
  const signal = sig({ gameStatus: "final", status: "graded", outcomes: gradedWin, everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === true, "graded HR stays visible after grading");
}

// ── 4. Graded miss + flagged → STAYS VISIBLE (the core retention fix) ────────
// Previously deleted the instant status flipped to "graded" without a HR.
{
  const signal = sig({ gameStatus: "final", status: "graded", outcomes: gradedMiss, everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === true, "graded miss STAYS visible through the slate (completed, not erased)");
}

// ── 5. Completed Total-Bases target (graded, no HR, TB recorded) → visible ──
{
  const signal = sig({
    gameStatus: "final", status: "graded", primaryMarket: "total_bases",
    outcomes: gradedTb, everPubliclyFlagged: true,
  });
  ok(isPublicPregameSignal(signal) === true, "completed Total-Bases candidate stays visible with its final result");
}

// ── 6. Postponed → always hidden ─────────────────────────────────────────────
{
  const signal = sig({ gameStatus: "postponed", status: "locked", everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === false, "postponed games are never public");
}

// ── 7. Live + locked + flagged → visible (immutable while live) ─────────────
{
  const signal = sig({ gameStatus: "live", status: "locked", everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === true, "live locked flagged signal stays visible");
}

// ── 8. Live + active (not yet locked) → hidden ──────────────────────────────
{
  const signal = sig({ gameStatus: "live", status: "active", everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === false, "live game not yet locked is hidden");
}

// ── 9. Expired status is never public, regardless of gameStatus ────────────
{
  const signal = sig({ gameStatus: "final", status: "expired", everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === false, "expired status is hidden");
}

// ── 10. Never publicly flagged → hidden even with a graded HR ───────────────
// A late scratch / unposted-lineup target never got a frozen flag, so it is
// never retained — retention requires ACTUAL prior public admission.
{
  const signal = sig({ gameStatus: "final", status: "graded", outcomes: gradedWin, everPubliclyFlagged: false });
  ok(isPublicPregameSignal(signal) === false, "never-flagged target is not retained, even with a graded HR");
}

// ── 11. Substituted batter (carried forward, locked, flagged) → stays visible ─
// A pinch-hit/defensive-sub batter whose signal was carried forward keeps its
// frozen flag + locked state, so it remains on the completed board.
{
  const signal = sig({ gameStatus: "final", status: "locked", everPubliclyFlagged: true, lineupStatus: "unposted" });
  ok(isPublicPregameSignal(signal) === true, "substituted (carried-forward) locked flagged batter stays visible");
}

// ── 12. Already-flagged + suspended + locked → stays visible (preserved) ────
{
  const signal = sig({ gameStatus: "suspended", status: "locked", everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === true, "already-flagged suspended-and-locked signal stays visible (preserved)");
}

// ── 13. Suspended + not yet locked → hidden ─────────────────────────────────
{
  const signal = sig({ gameStatus: "suspended", status: "active", everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === false, "suspended signal not yet locked is hidden");
}

// ── 14. Cold-start: never-flagged live/final/suspended locked → hidden ──────
// Retention reads the durable frozen flag only. A signal built for the first
// time after first pitch (no prior copy → everPubliclyFlagged never minted, see
// gradedStateCarry cold-start guard) must NEVER surface for the first time.
{
  ok(isPublicPregameSignal(sig({ gameStatus: "live", status: "locked", everPubliclyFlagged: false })) === false,
    "cold-start live locked never-flagged signal is hidden");
  ok(isPublicPregameSignal(sig({ gameStatus: "final", status: "locked", everPubliclyFlagged: false })) === false,
    "cold-start final locked never-flagged signal is hidden");
  ok(isPublicPregameSignal(sig({ gameStatus: "suspended", status: "locked", everPubliclyFlagged: false })) === false,
    "cold-start suspended locked never-flagged signal is hidden");
}

// ── 15. Frozen-flag recovery: a graded win survives a later mutable-field dip ─
{
  const signal = sig({ gameStatus: "final", status: "graded", score10: 5.5, everPubliclyFlagged: true, outcomes: gradedWin });
  ok(isPublicPregameSignal(signal) === true, "graded win recovers via frozen flag even if score10 drifted below threshold");
}

// ── 16. Pre-grading, live gates stay authoritative (flag does NOT recover) ──
{
  const signal = sig({ gameStatus: "scheduled", status: "active", score10: 5.5, everPubliclyFlagged: true });
  ok(isPublicPregameSignal(signal) === false,
    "a still-active pre-first-pitch signal does NOT recover via the frozen flag — live eligibility stays authoritative");
}

// ── 17. positiveDrivers helper derives from drivers[] ───────────────────────
{
  ok(positiveDrivers(sig({})).length === 2, "positiveDrivers derives from drivers[]");
}

console.log(`\ndiagnostics.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
