/**
 * MLB Live Edge Trust Recovery (Phase 5) — mlbSignalFinalizer.test.ts
 *
 * End-to-end table-driven coverage of the single finalized-signal contract:
 * official, watch, suppressed, stale-price, degraded, resolved,
 * occurrence-only (HR), and FIRE (HR) — through finalizeMlbSignal() AND
 * through the real API-normalization layer (normalizeMLBSignal /
 * applyDisplayContract), proving isBettable/officialEligibility/
 * lifecycleClassification never contradict each other and that the display
 * contract does not independently re-derive isBettable.
 *
 * Run with: npx tsx server/mlb/mlbSignalFinalizer.test.ts
 */

process.env.ODDS_API_KEY = process.env.ODDS_API_KEY || "test-key-1";

import { finalizeMlbSignal, stampMlbSignalFinalization, type MlbLifecycleClassification } from "./mlbSignalFinalizer";
import { normalizeMLBSignal } from "./normalizeSignal";
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
    playerName: "TABLE_TEST_PLAYER",
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

interface TableCase {
  name: string;
  signal: MLBQualifiedSignal;
  expectedClassification: MlbLifecycleClassification;
  expectedEligible: boolean;
  expectedBettable: boolean;
}

const CASES: TableCase[] = [
  {
    name: "1. OFFICIAL — fully valid, actionable, approved book, fresh odds",
    signal: baseSignal(),
    expectedClassification: "official",
    expectedEligible: true,
    expectedBettable: true,
  },
  {
    name: "2. WATCH — watchlist signal, not yet actionable",
    signal: baseSignal({ watchlist: true, actionable: false, signalTier: "watch" }),
    expectedClassification: "watch",
    expectedEligible: false,
    expectedBettable: false,
  },
  {
    name: "3. SUPPRESSED — non-flagship family-suppressed signal",
    signal: baseSignal({ isFlagship: false, familyPenaltyFactor: 0.5 }),
    expectedClassification: "suppressed",
    expectedEligible: false,
    expectedBettable: true, // isBettable is a separate axis from family suppression
  },
  {
    name: "4. STALE-PRICE — no real sportsbook source timestamp",
    signal: baseSignal({ oddsTimestamp: null }),
    expectedClassification: "stale_price",
    expectedEligible: false,
    expectedBettable: true,
  },
  {
    name: "5. DEGRADED — current stat unknown (degraded input quality)",
    signal: baseSignal({ currentStatKnown: false }),
    expectedClassification: "degraded",
    expectedEligible: false,
    expectedBettable: true,
  },
  {
    name: "6. RESOLVED — already hit / terminal",
    signal: baseSignal({ alreadyHit: true }),
    expectedClassification: "resolved",
    expectedEligible: false,
    expectedBettable: true,
  },
  {
    name: "7. HR OCCURRENCE-ONLY — real HR detection, no real sportsbook line",
    signal: baseSignal({
      market: "home_runs",
      hasRealSportsbookLine: false,
      hrCurrentState: "PREPARE" as any,
      sportsbook: null,
    }),
    expectedClassification: "occurrence_only",
    expectedEligible: false,
    expectedBettable: false,
  },
  {
    name: "8. HR FIRE — real line, unified FSM at BET_NOW",
    signal: baseSignal({
      market: "home_runs",
      hasRealSportsbookLine: true,
      hrCurrentState: "BET_NOW" as any,
    }),
    expectedClassification: "official",
    expectedEligible: true,
    expectedBettable: true,
  },
];

for (const tc of CASES) {
  const finalized = finalizeMlbSignal(tc.signal);
  check(`${tc.name} — classification`, finalized.lifecycleClassification === tc.expectedClassification, finalized);
  check(`${tc.name} — officialEligibility.eligible`, finalized.officialEligibility.eligible === tc.expectedEligible, finalized.officialEligibility);
  check(`${tc.name} — isBettable`, finalized.isBettable === tc.expectedBettable, finalized.isBettable);
  // Internal consistency: official ⟹ isBettable === true (never a hybrid state).
  if (finalized.lifecycleClassification === "official") {
    check(`${tc.name} — official implies isBettable`, finalized.isBettable === true);
    check(`${tc.name} — official implies eligible`, finalized.officialEligibility.eligible === true);
  }
  // Decision reasons are NEVER an empty array — always explain the classification.
  check(`${tc.name} — decisionReasons non-empty`, finalized.decisionReasons.length > 0, finalized.decisionReasons);
}

// ── Positive-reason completeness for the official case ───────────────────
{
  const finalized = finalizeMlbSignal(CASES[0].signal);
  check("official signal's decisionReasons are POSITIVE confirmation tags, not an empty pass", finalized.decisionReasons.includes("bettable") && finalized.decisionReasons.length >= 10, finalized.decisionReasons);
}

// ── stampMlbSignalFinalization mutates in place, matches finalizeMlbSignal ──
{
  const sig = baseSignal();
  const expected = finalizeMlbSignal(sig);
  stampMlbSignalFinalization([sig]);
  check("stamp sets officialEligibility.eligible to match finalizeMlbSignal", sig.officialEligibility?.eligible === expected.officialEligibility.eligible);
  check("stamp sets isBettable to match finalizeMlbSignal", sig.isBettable === expected.isBettable);
  check("stamp sets lifecycleClassification to match finalizeMlbSignal", sig.lifecycleClassification === expected.lifecycleClassification);
  check("stamp sets decisionReasons to match finalizeMlbSignal", JSON.stringify(sig.decisionReasons) === JSON.stringify(expected.decisionReasons));
}

// ── Through the ACTUAL API-normalization layer: isBettable propagates ────
// without independent re-derivation. Uses sentinel-tagged fixture data only
// (never real production data), matching this repo's established
// integration-fixture convention.
{
  for (const tc of CASES) {
    const sig = { ...tc.signal, playerName: `SENTINEL_FINALIZER_${tc.name.replace(/[^A-Z0-9]/gi, "_")}` };
    stampMlbSignalFinalization([sig]);
    let wire: any;
    try {
      wire = normalizeMLBSignal(sig, {
        gameId: sig.gameId,
        rawOutput: null,
        gameState: null,
        game: null,
        pitchMixFallback: null,
      });
    } catch (err) {
      check(`${tc.name} — normalizeMLBSignal does not throw`, false, err);
      continue;
    }
    check(`${tc.name} — wire isBettable matches the stamped finalizer value (no re-derivation)`, wire.isBettable === sig.isBettable, { wireIsBettable: wire.isBettable, stampedIsBettable: sig.isBettable });
    check(`${tc.name} — wire lifecycleClassification surfaces the same final decision`, wire.lifecycleClassification === sig.lifecycleClassification, { wire: wire.lifecycleClassification, stamped: sig.lifecycleClassification });
    check(`${tc.name} — wire decisionReasons surfaces the same reasons`, JSON.stringify(wire.decisionReasons) === JSON.stringify(sig.decisionReasons));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
