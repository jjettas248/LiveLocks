/**
 * MLB Live Edge Trust Recovery (Phase 5) — carryForwardRevalidation.test.ts
 *
 * Run with: npx tsx server/mlb/carryForwardRevalidation.test.ts
 */

import { revalidateCarriedSignal, type CarryForwardRevalidationContext } from "./carryForwardRevalidation";
import type { MLBQualifiedSignal } from "./types";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
}

const NOW = 1_000_000_000;

function baseSignal(overrides: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "g1_p1_hits",
    gameId: "g1",
    playerId: "p1",
    playerName: "Test Player",
    team: "NYY",
    market: "hits",
    side: "OVER",
    sportsbook: "draftkings",
    line: 1.5,
    impliedProbability: null,
    engineProbability: 62,
    projection: 2.1,
    evPct: 5,
    confidenceTier: "STRONG",
    signalScore: 70,
    reasons: [],
    feedTags: [],
    signalTags: [],
    playerGlowEligible: false,
    gameCardSignalTags: [],
    formIndicator: "steady" as any,
    isExperimental: false,
    engineGeneratedAt: NOW - 10_000,
    badges: [],
    riskFlags: [],
    drivers: {},
    timestamps: {
      engineGeneratedAt: new Date(NOW - 10_000).toISOString(),
      oddsUpdatedAt: new Date(NOW - 10_000).toISOString(),
      gameStateUpdatedAt: new Date(NOW - 10_000).toISOString(),
    },
    fallbackUsed: false,
    actionable: true,
    alreadyHit: false,
    stale: false,
    watchlist: false,
    overOdds: -120,
    underOdds: 105,
    oddsTimestamp: NOW - 10_000,
    pitcherName: "Some Pitcher",
    pitcherHand: "R",
    pitcherPitchCount: 40,
    pitcherTimesThrough: 1,
    homeScore: 0,
    awayScore: 0,
    inning: 3,
    isTopInning: true,
    currentStat: 0,
    completedAB: 1,
    bookImplied: null,
    priorABResults: [],
    currentStatKnown: true,
    ...overrides,
  } as MLBQualifiedSignal;
}

function baseCtx(overrides: Partial<CarryForwardRevalidationContext> = {}): CarryForwardRevalidationContext {
  return {
    nowMs: NOW,
    maxCarryAgeMs: 20 * 60 * 1000,
    oddsFreshnessThresholdMs: 30_000,
    currentPitcherId: null,
    currentPitcherName: "Some Pitcher",
    currentOffenseTeam: "NYY",
    gameIsTerminal: false,
    isResolved: false,
    ...overrides,
  };
}

// ── Group A: happy path stays visible ────────────────────────────────────
{
  const r = revalidateCarriedSignal(baseSignal(), baseCtx());
  check("A1 fresh-ish carried signal within all bounds stays visible", r.visible === true, r.reasons);
}

// ── Group B: stale source quote ──────────────────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal({ oddsTimestamp: NOW - 60_000 }), baseCtx());
  check("B1 stale source price (60s old, 30s threshold) hidden", !r1.visible && r1.reasons.includes("stale_source_price"), r1.reasons);

  const r2 = revalidateCarriedSignal(baseSignal({ oddsTimestamp: null }), baseCtx());
  check("B2 missing source timestamp treated as stale", !r2.visible && r2.reasons.includes("stale_source_price"), r2.reasons);

  const r3 = revalidateCarriedSignal(baseSignal({ oddsTimestamp: NOW - 5_000 }), baseCtx());
  check("B3 fresh source price (5s old, 30s threshold) stays visible", r3.visible === true, r3.reasons);
}

// ── Group C: max carry age boundary (20 min) ─────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal({ engineGeneratedAt: NOW - (21 * 60 * 1000), oddsTimestamp: NOW - 1000 }), baseCtx());
  check("C1 past the 20-minute preservation boundary hidden", !r1.visible && r1.reasons.includes("max_age_exceeded"), r1.reasons);

  const r2 = revalidateCarriedSignal(baseSignal({ engineGeneratedAt: NOW - (19 * 60 * 1000), oddsTimestamp: NOW - 1000 }), baseCtx());
  check("C2 just under the 20-minute boundary stays visible", r2.visible === true, r2.reasons);
}

// ── Group D: pitching change invalidates ─────────────────────────────────
{
  // Batter market: pitcher name mismatch.
  const r1 = revalidateCarriedSignal(baseSignal({ pitcherName: "Old Pitcher" }), baseCtx({ currentPitcherName: "New Pitcher" }));
  check("D1 pitching change (batter market, name mismatch) invalidates", !r1.visible && r1.reasons.includes("pitching_changed"), r1.reasons);

  // Pitcher market: the signal's own playerId IS the pitcher; a mismatch
  // against the currently active pitcher means this pitcher left the game.
  const r2 = revalidateCarriedSignal(
    baseSignal({ market: "pitcher_strikeouts", playerId: "old-pitcher-id" }),
    baseCtx({ currentPitcherId: "new-pitcher-id" })
  );
  check("D2 pitching change (pitcher market, playerId mismatch) invalidates", !r2.visible && r2.reasons.includes("pitching_changed"), r2.reasons);

  const r3 = revalidateCarriedSignal(
    baseSignal({ market: "pitcher_strikeouts", playerId: "same-pitcher-id" }),
    baseCtx({ currentPitcherId: "same-pitcher-id" })
  );
  check("D3 same pitcher still in game stays visible on this axis", r3.visible === true, r3.reasons);
}

// ── Group E: same-team mismatch invalidates ──────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal({ team: "NYY" }), baseCtx({ currentOffenseTeam: "BOS" }));
  check("E1 same-team/offense mismatch invalidates", !r1.visible && r1.reasons.includes("same_team_mismatch"), r1.reasons);
}

// ── Group F: exhausted opportunity ───────────────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal({ completedAB: 4 }), baseCtx());
  check("F1 exhausted opportunity (4 completed ABs) invalidates", !r1.visible && r1.reasons.includes("opportunity_exhausted"), r1.reasons);

  const r2 = revalidateCarriedSignal(baseSignal({ market: "pitcher_strikeouts", completedAB: 4 }), baseCtx({ currentPitcherId: "p1" }));
  check("F2 opportunity_exhausted heuristic does not apply to pitcher markets", r2.visible === true, r2.reasons);
}

// ── Group G: terminal game state ─────────────────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal(), baseCtx({ gameIsTerminal: true }));
  check("G1 terminal game hides carried signal", !r1.visible && r1.reasons.includes("terminal_game_state"), r1.reasons);
}

// ── Group H: resolved market ──────────────────────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal(), baseCtx({ isResolved: true }));
  check("H1 already-resolved market hides carried signal", !r1.visible && r1.reasons.includes("already_resolved"), r1.reasons);
}

// ── Group I: cache degradation + unknown current stat ────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal({ isDegraded: true }), baseCtx());
  check("I1 degraded cache input hides carried signal", !r1.visible && r1.reasons.includes("cache_degraded"), r1.reasons);

  const r2 = revalidateCarriedSignal(baseSignal({ currentStatKnown: false }), baseCtx());
  check("I2 unknown current stat hides carried signal", !r2.visible && r2.reasons.includes("current_stat_unknown"), r2.reasons);
}

// ── Group J: family suppression ───────────────────────────────────────────
{
  const r1 = revalidateCarriedSignal(baseSignal({ isFlagship: false, familyPenaltyFactor: 0.5 }), baseCtx());
  check("J1 stale family-suppressed signal hides", !r1.visible && r1.reasons.includes("family_suppressed"), r1.reasons);

  const r2 = revalidateCarriedSignal(baseSignal({ isFlagship: true, familyPenaltyFactor: 0.5 }), baseCtx());
  check("J2 flagship signal is never family-suppressed regardless of factor", r2.visible === true, r2.reasons);
}

// ── Group K: never mutates the input signal ──────────────────────────────
{
  const sig = baseSignal({ oddsTimestamp: NOW - 60_000 });
  const snapshot = JSON.stringify(sig);
  revalidateCarriedSignal(sig, baseCtx());
  check("K1 revalidation never mutates the carried signal object", JSON.stringify(sig) === snapshot);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
