/**
 * MLB Live Edge Trust Recovery (Phase 4) — mlbOfficialEligibility.test.ts
 *
 * Pure-function regression harness for evaluateMlbOfficialEligibility(),
 * the single typed finalized-eligibility contract every MLB persistence
 * entry point (orchestrator autoPersistMLBSignals, routes.ts route safety
 * net) must consume identically. Run with:
 *
 *   npx tsx server/mlb/mlbOfficialEligibility.test.ts
 */

process.env.ODDS_API_KEY = process.env.ODDS_API_KEY || "test-key-1";

import { evaluateMlbOfficialEligibility, MLB_OFFICIAL_ELIGIBILITY_VERSION } from "./mlbOfficialEligibility";
import type { MLBQualifiedSignal } from "./types";

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}`, detail ?? ""); }
}

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
    signalTier: "strong",
    signalScore: 70,
    reasons: [],
    feedTags: [],
    signalTags: [],
    playerGlowEligible: false,
    gameCardSignalTags: [],
    formIndicator: "steady" as any,
    isExperimental: false,
    engineGeneratedAt: Date.now(),
    badges: [],
    riskFlags: [],
    drivers: {},
    timestamps: {
      engineGeneratedAt: new Date().toISOString(),
      oddsUpdatedAt: new Date().toISOString(),
      gameStateUpdatedAt: new Date().toISOString(),
    },
    fallbackUsed: false,
    actionable: true,
    alreadyHit: false,
    stale: false,
    watchlist: false,
    overOdds: -120,
    underOdds: 105,
    oddsTimestamp: Date.now(),
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

// ── Group A: happy path ──────────────────────────────────────────────────
{
  const sig = baseSignal();
  const result = evaluateMlbOfficialEligibility(sig);
  check("A1 valid non-HR signal is eligible", result.eligible === true, result.reasons);
  check("A2 version stamped", result.version === MLB_OFFICIAL_ELIGIBILITY_VERSION);
  check("A3 no reasons on eligible signal", result.reasons.length === 0, result.reasons);
}

// ── Group B: structural identity ─────────────────────────────────────────
{
  const r1 = evaluateMlbOfficialEligibility(baseSignal({ gameId: "" }));
  check("B1 missing gameId rejected", !r1.eligible && r1.reasons.includes("missing_game_id"), r1.reasons);

  const r2 = evaluateMlbOfficialEligibility(baseSignal({ playerId: "" }));
  check("B2 missing playerId rejected", !r2.eligible && r2.reasons.includes("missing_player_id"), r2.reasons);

  const r3 = evaluateMlbOfficialEligibility(baseSignal({ side: null as any }));
  check("B3 missing side rejected", !r3.eligible && r3.reasons.includes("missing_side"), r3.reasons);

  const r4 = evaluateMlbOfficialEligibility(baseSignal({ market: "walks_allowed" }));
  check("B4 disabled/unsupported market rejected", !r4.eligible && r4.reasons.includes("unsupported_market"), r4.reasons);
}

// ── Group C: actionability / watch / early / suppressed / resolved ──────
{
  const r1 = evaluateMlbOfficialEligibility(baseSignal({ actionable: false }));
  check("C1 not actionable rejected", !r1.eligible && r1.reasons.includes("not_actionable"), r1.reasons);

  const r2 = evaluateMlbOfficialEligibility(baseSignal({ watchlist: true }));
  check("C2 watchlist rejected", !r2.eligible && r2.reasons.includes("watchlist"), r2.reasons);

  // No watchlist-bypass carve-out: batter_over + watch mode must still reject.
  const r3 = evaluateMlbOfficialEligibility(baseSignal({ watchlist: true, marketFamily: "batter_over", mode: "watch" }));
  check("C3 batter_over watch carve-out removed — still rejected", !r3.eligible && r3.reasons.includes("watchlist"), r3.reasons);

  const r4 = evaluateMlbOfficialEligibility(baseSignal({ isEarlySignal: true }));
  check("C4 early signal rejected", !r4.eligible && r4.reasons.includes("early_signal"), r4.reasons);

  const r5 = evaluateMlbOfficialEligibility(baseSignal({ alreadyHit: true }));
  check("C5 already-hit/resolved rejected", !r5.eligible && r5.reasons.includes("already_hit"), r5.reasons);

  const r6 = evaluateMlbOfficialEligibility({ ...baseSignal(), suppressed: true } as any);
  check("C6 suppressed rejected", !r6.eligible && r6.reasons.includes("suppressed"), r6.reasons);

  const r7 = evaluateMlbOfficialEligibility(baseSignal({ isFlagship: false, familyPenaltyFactor: 0.5 }));
  check("C7 non-flagship family-suppressed signal rejected", !r7.eligible && r7.reasons.includes("family_suppressed"), r7.reasons);

  const r8 = evaluateMlbOfficialEligibility(baseSignal({ isFlagship: true, familyPenaltyFactor: 0.5 }));
  check("C8 flagship signal is never family-suppressed regardless of penalty factor", !r8.reasons.includes("family_suppressed"), r8.reasons);

  const r9 = evaluateMlbOfficialEligibility(baseSignal({ signalTier: "watch" as any }));
  check("C9 watch-tier signal rejected as not_bettable (isBettable required for eligibility)", !r9.eligible && r9.reasons.includes("not_bettable"), r9.reasons);

  const r10 = evaluateMlbOfficialEligibility(baseSignal({ engineProbability: 49 }));
  check("C10 sub-50% probability on a non-HR market rejected as not_bettable", !r10.eligible && r10.reasons.includes("not_bettable"), r10.reasons);
}

// ── Group D: sportsbook / provenance ──────────────────────────────────────
{
  const r1 = evaluateMlbOfficialEligibility(baseSignal({ sportsbook: null }));
  check("D1 missing sportsbook rejected — never fabricated as odds_api", !r1.eligible && r1.reasons.includes("missing_sportsbook"), r1.reasons);

  const r2 = evaluateMlbOfficialEligibility(baseSignal({ sportsbook: "some_unapproved_book" }));
  check("D2 unapproved book rejected", !r2.eligible && r2.reasons.includes("sportsbook_not_approved"), r2.reasons);

  const r3 = evaluateMlbOfficialEligibility(baseSignal({ oddsTimestamp: null }));
  check("D3 missing odds source timestamp rejected (fresh fetch does not rescue it)", !r3.eligible && r3.reasons.includes("missing_odds_source_timestamp"), r3.reasons);

  const r4 = evaluateMlbOfficialEligibility(baseSignal({ side: "OVER", overOdds: null }));
  check("D4 invalid odds for recommended side rejected", !r4.eligible && r4.reasons.includes("invalid_odds_for_side"), r4.reasons);

  const r5 = evaluateMlbOfficialEligibility(baseSignal({ side: "OVER", overOdds: -50 }));
  check("D5 out-of-range American odds rejected", !r5.eligible && r5.reasons.includes("invalid_odds_for_side"), r5.reasons);

  // Opposite side's price is irrelevant — only the recommended side's price counts.
  const r6 = evaluateMlbOfficialEligibility(baseSignal({ side: "OVER", overOdds: -120, underOdds: null }));
  check("D6 opposite-side missing price does not block eligibility", r6.eligible === true, r6.reasons);
}

// ── Group E: numeric integrity ────────────────────────────────────────────
{
  const r1 = evaluateMlbOfficialEligibility(baseSignal({ line: 0 }));
  check("E1 zero line rejected", !r1.eligible && r1.reasons.includes("invalid_line"), r1.reasons);

  const r2 = evaluateMlbOfficialEligibility(baseSignal({ line: NaN as any }));
  check("E2 NaN line rejected", !r2.eligible && r2.reasons.includes("invalid_line"), r2.reasons);

  const r3 = evaluateMlbOfficialEligibility(baseSignal({ engineProbability: NaN as any }));
  check("E3 NaN probability rejected", !r3.eligible && r3.reasons.includes("invalid_probability"), r3.reasons);

  const r4 = evaluateMlbOfficialEligibility(baseSignal({ engineProbability: 150 }));
  check("E4 out-of-range probability rejected", !r4.eligible && r4.reasons.includes("invalid_probability"), r4.reasons);

  const r5 = evaluateMlbOfficialEligibility(baseSignal({ projection: Infinity }));
  check("E5 non-finite projection rejected", !r5.eligible && r5.reasons.includes("invalid_projection"), r5.reasons);
}

// ── Group F: current-stat-known ───────────────────────────────────────────
{
  const r1 = evaluateMlbOfficialEligibility(baseSignal({ currentStatKnown: false }));
  check("F1 unknown current stat rejected", !r1.eligible && r1.reasons.includes("current_stat_unknown"), r1.reasons);

  const r2 = evaluateMlbOfficialEligibility(baseSignal({ currentStatKnown: undefined }));
  check("F2 missing currentStatKnown (undefined) rejected — never defaults to true", !r2.eligible && r2.reasons.includes("current_stat_unknown"), r2.reasons);
}

// ── Group G: HR-specific FIRE/BET_NOW + real pricing gate ────────────────
{
  const hrBase = baseSignal({ market: "home_runs", hasRealSportsbookLine: true, hrCurrentState: "BET_NOW" as any });
  const r1 = evaluateMlbOfficialEligibility(hrBase);
  check("G1 HR at BET_NOW with real line is eligible", r1.eligible === true, r1.reasons);

  const r2 = evaluateMlbOfficialEligibility({ ...hrBase, hrCurrentState: "PREPARE" as any });
  check("G2 HR not at BET_NOW rejected", !r2.eligible && r2.reasons.includes("hr_not_current_fire"), r2.reasons);

  const r3 = evaluateMlbOfficialEligibility({ ...hrBase, hasRealSportsbookLine: false });
  check("G3 HR occurrence-only (no real line) rejected", !r3.eligible && r3.reasons.includes("hr_missing_real_line"), r3.reasons);

  const r4 = evaluateMlbOfficialEligibility({ ...hrBase, hrCurrentState: undefined });
  check("G4 HR missing FSM state rejected", !r4.eligible && r4.reasons.includes("hr_not_current_fire"), r4.reasons);
}

// ── Group H: multiple simultaneous failures are all reported ─────────────
{
  const r1 = evaluateMlbOfficialEligibility(baseSignal({ watchlist: true, sportsbook: null, oddsTimestamp: null }));
  check("H1 multiple failures all surfaced", !r1.eligible
    && r1.reasons.includes("watchlist")
    && r1.reasons.includes("missing_sportsbook")
    && r1.reasons.includes("missing_odds_source_timestamp"), r1.reasons);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
