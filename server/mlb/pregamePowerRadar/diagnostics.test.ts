// Pre-Game Power Radar — public-visibility predicate invariants.
//
// Guards the "player vanishes right after homering" regression: a `final`
// game whose shadow grader hasn't stamped `status: "graded"` yet must stay
// visible as a pending/locked row (same treatment as `live`), not disappear
// the instant `gameStatus` flips to `"final"`.
//
// Run: npx tsx server/mlb/pregamePowerRadar/diagnostics.test.ts

import { isPublicPregameSignal } from "./diagnostics";
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

// ── 1. Final + locked + not yet graded → stays visible (the core regression) ─
{
  const signal = sig({ gameStatus: "final", status: "locked", outcomes: null });
  ok(isPublicPregameSignal(signal) === true, "final-but-ungraded locked signal stays visible");
}

// ── 2. Final + graded + HR → visible (existing rescue, must still work) ─────
{
  const signal = sig({ gameStatus: "final", status: "graded", outcomes: gradedWin });
  ok(isPublicPregameSignal(signal) === true, "graded HR stays visible after grading");
}

// ── 3. Final + graded + miss → hidden ────────────────────────────────────────
{
  const signal = sig({ gameStatus: "final", status: "graded", outcomes: gradedMiss });
  ok(isPublicPregameSignal(signal) === false, "graded miss is hidden once grading resolves it");
}

// ── 4. Postponed → always hidden ─────────────────────────────────────────────
{
  const signal = sig({ gameStatus: "postponed", status: "locked" });
  ok(isPublicPregameSignal(signal) === false, "postponed games are never public");
}

// ── 5. Live + locked → visible (regression check) ───────────────────────────
{
  const signal = sig({ gameStatus: "live", status: "locked" });
  ok(isPublicPregameSignal(signal) === true, "live locked signal stays visible");
}

// ── 6. Live + active (not yet locked) → hidden (regression check) ──────────
{
  const signal = sig({ gameStatus: "live", status: "active" });
  ok(isPublicPregameSignal(signal) === false, "live game not yet locked is hidden");
}

// ── 7. Scheduled/pre pregame target → visible ───────────────────────────────
{
  const signal = sig({ gameStatus: "scheduled", status: "active" });
  ok(isPublicPregameSignal(signal) === true, "pregame scheduled target is visible");
}

// ── 8. Expired status is never public, regardless of gameStatus ────────────
{
  const signal = sig({ gameStatus: "final", status: "expired" });
  ok(isPublicPregameSignal(signal) === false, "expired status is hidden");
}

// ── 9. Not publicly flagged pregame → hidden regardless of everything else ──
{
  const signal = sig({ gameStatus: "final", status: "graded", outcomes: gradedWin, lineupStatus: "unposted" });
  ok(isPublicPregameSignal(signal) === false, "unconfirmed lineup is never publicly flagged, even with a graded HR");
}

// ── 10. Suspended + locked → stays visible (preserved, not hidden like postponed) ──
{
  const signal = sig({ gameStatus: "suspended", status: "locked" });
  ok(isPublicPregameSignal(signal) === true, "suspended-but-locked signal stays visible (preserved, not hidden)");
}

// ── 11. Suspended + not yet locked → hidden, same treatment as live/final ──
{
  const signal = sig({ gameStatus: "suspended", status: "active" });
  ok(isPublicPregameSignal(signal) === false, "suspended signal not yet locked is hidden, same as live/final");
}

console.log(`\ndiagnostics.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
