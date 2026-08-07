// Pregame composition layer — Cross-Radar pure builder invariants.
//
// Scope note: this pure function does NOT decide Plate eligibility (that is
// enrichMoundResponse.ts's job, via Plate's own canonical isPublicPregameSignal
// predicate — see enrichMoundResponse.test.ts). This suite assumes its input
// is already-eligible and tests only: the cr_high trigger, the gameId+pitcherId
// join, malformed-candidate rejection, ranking, dedup, and the cap.
//
// Run: npx tsx server/mlb/pregame/composition/moundPlateTargets.test.ts

import { buildMoundPlateTargetSuggestions } from "./moundPlateTargets";
import type { MoundSignal, MoundDriver } from "../mound/types";
import type { PregamePowerSignal, PregamePowerDiagnostics } from "../../pregamePowerRadar/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── Complete typed factories (no `as unknown as` on the objects under test) ──

function baseMoundDiagnostics(): MoundSignal["diagnostics"] {
  return {
    pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 6,
    recentFormScore: 6, marketFitScore: 6, contactRiskScore: 7, riskPenalty: 0,
    appliedDrivers: [], appliedWarnings: [],
    dataCoverageScore: 0.9, finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
    suppressed: false, suppressedReasons: [],
    sourceFreshness: {},
    rawInputsAvailable: {
      confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
      pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
      park: true, weather: true,
    },
  } as MoundSignal["diagnostics"];
}

function moundSignal(overrides: Partial<MoundSignal> & { drivers: MoundDriver[] }): MoundSignal {
  const base: MoundSignal = {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "2026-07-01T00:00:00Z", buildId: "b1",
    pitcherId: "p1", pitcherName: "Test Pitcher", team: "NYY", opponent: "BOS", throws: "R",
    opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts"],
    marketScores: { pitcher_strikeouts: 7 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: null,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: baseMoundDiagnostics(),
  };
  return { ...base, ...overrides } as MoundSignal;
}

const CR_HIGH: MoundDriver = { key: "cr_high", label: "Hit/HR Susceptible: High", direction: "negative" };
const CR_LOW: MoundDriver = { key: "cr_low", label: "Hit/HR Susceptible: Low", direction: "positive" };

function baseDiagnostics(): PregamePowerDiagnostics {
  return {
    batterPowerScore: 7, pitcherVulnerabilityScore: 6, pitcherHandednessScore: 6,
    matchupFitScore: 6, parkWeatherScore: 6, lineupOpportunityScore: 6, marketFitScore: 6,
    pitcherOrderSplitAvailable: true, pitcherOrderSplitScore: 6, pitcherOrderSplitDirection: "neutral",
    batterCurrentOrderSlot: 3, batterOrderSplitAvailable: true, batterOrderSplitScore: 6, batterOrderSplitDirection: "neutral",
    bvpAvailable: false, bvpScore: null, bvpSampleSize: null, bvpDirection: "neutral",
    zeroProductionBvpFlags: [],
    dataCoverageScore: 0.9, finalScoreBeforeCaps: 8, finalScoreAfterCaps: 8, matchupPenalty: 0,
    publicTier: "elite", warningTags: [], downgradeReasons: [],
    suppressed: false, suppressedReasons: [],
    sourceFreshness: {},
    rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
  };
}

// Already treated as Plate-eligible for this suite's purposes — the real
// isPublicPregameSignal gate is exercised separately in enrichMoundResponse.test.ts.
function eligiblePlateSignal(overrides: Partial<PregamePowerSignal> = {}): PregamePowerSignal {
  const base: PregamePowerSignal = {
    signalId: "mlb-pregame:2026-07-01:g1:batter1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "2026-07-01T00:00:00Z", buildId: "b1",
    batterId: "batter1", batterName: "Test Batter", team: "BOS", opponent: "NYY",
    pitcherId: "p1", pitcherName: "Test Pitcher",
    battingOrderSlot: 3, handednessMatchup: "R vs R",
    primaryMarket: "home_runs", marketTags: ["home_runs"],
    marketScores: { home_runs: 8.0 }, marketSetups: [],
    parkContext: null,
    score10: 7.5, tier: "elite",
    drivers: [], warnings: [], tags: [],
    lineupStatus: "posted", weatherStatus: "estimated", gameStatus: "scheduled",
    firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null,
    everPubliclyFlagged: false, everAttackEnvironmentSuppressed: false, attackEnvironmentSuppressedScore10: null,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: baseDiagnostics(),
  };
  return { ...base, ...overrides } as PregamePowerSignal;
}

const HR_SUSCEPTIBLE = moundSignal({ drivers: [CR_HIGH] });

// ── 1. Returns suggestions only when cr_high exists ─────────────────────────
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal()]).length === 1, "cr_high present → one qualifying suggestion returned");

// ── 2. Returns [] when only cr_low exists ────────────────────────────────────
{
  const notSusceptible = moundSignal({ drivers: [CR_LOW] });
  ok(buildMoundPlateTargetSuggestions(notSusceptible, [eligiblePlateSignal()]).length === 0, "cr_low alone → []");
}

// ── 3. Returns [] when no contact-risk driver exists ─────────────────────────
{
  const noDriver = moundSignal({ drivers: [{ key: "ps_k9", label: "Pitcher High K%", direction: "positive" }] });
  ok(buildMoundPlateTargetSuggestions(noDriver, [eligiblePlateSignal()]).length === 0, "no contact-risk driver at all → []");
}

// ── Pregame-only lifecycle gate: cr_high is necessary but not sufficient ────
// (a locked/graded/live/final Mound card must never surface suggestions,
// even though the canonical Mound response intentionally retains those
// cards after first pitch).
ok(
  buildMoundPlateTargetSuggestions(moundSignal({ drivers: [CR_HIGH], status: "locked" }), [eligiblePlateSignal()]).length === 0,
  "locked Mound signal → [] (first pitch has passed)",
);
ok(
  buildMoundPlateTargetSuggestions(moundSignal({ drivers: [CR_HIGH], status: "graded" }), [eligiblePlateSignal()]).length === 0,
  "graded Mound signal → []",
);
ok(
  buildMoundPlateTargetSuggestions(moundSignal({ drivers: [CR_HIGH], gameStatus: "live" }), [eligiblePlateSignal()]).length === 0,
  "live Mound game → []",
);
ok(
  buildMoundPlateTargetSuggestions(moundSignal({ drivers: [CR_HIGH], gameStatus: "final" }), [eligiblePlateSignal()]).length === 0,
  "final Mound game → []",
);
ok(
  buildMoundPlateTargetSuggestions(moundSignal({ drivers: [CR_HIGH], gameStatus: "postponed" }), [eligiblePlateSignal()]).length === 0,
  "postponed Mound game → []",
);
ok(
  buildMoundPlateTargetSuggestions(moundSignal({ drivers: [CR_HIGH], firstPitchLockEligible: false }), [eligiblePlateSignal()]).length === 0,
  "firstPitchLockEligible=false Mound signal → []",
);

// ── 4/5/6. Requires both canonical gameId and pitcherId; excludes mismatches ─
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ gameId: "wrong-game" })]).length === 0, "wrong gameId excluded");
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ pitcherId: "wrong-pitcher" })]).length === 0, "wrong pitcherId excluded");
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ pitcherId: null })]).length === 0, "null pitcherId excluded");

// ── 7. Excludes malformed candidates (empty/invalid batterId or batterName, non-finite score) ──
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ batterId: "" })]).length === 0, "empty batterId excluded");
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ batterId: "   " })]).length === 0, "whitespace-only batterId excluded");
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ batterName: "" })]).length === 0, "empty batterName excluded");
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ score10: NaN })]).length === 0, "non-finite overall score10 excluded");

// ── 8. Deduplicates duplicate batter IDs ────────────────────────────────────
{
  const dupA = eligiblePlateSignal({ batterId: "dup1", marketScores: { home_runs: 9.0 } });
  const dupB = eligiblePlateSignal({ batterId: "dup1", marketScores: { home_runs: 3.0 } });
  const result = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [dupA, dupB]);
  ok(result.length === 1, `duplicate batterId collapses to one suggestion (got ${result.length})`);
  ok(result[0].hrScore === 9.0, "the higher-ranked (first-sorted) duplicate instance wins, not last-in-array");
}

// ── 8b. Dedup key is whitespace-normalized ───────────────────────────────────
{
  const bare = eligiblePlateSignal({ batterId: "123", marketScores: { home_runs: 9.0 } });
  const padded = eligiblePlateSignal({ batterId: " 123 ", marketScores: { home_runs: 3.0 } });
  const result = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [bare, padded]);
  ok(result.length === 1, `"123" and " 123 " are treated as the same batter after trim-normalizing the dedupe key (got ${result.length})`);
}

// ── Defensive tier guard: a "track"-tier candidate is excluded even though it
// structurally cannot occur when the caller correctly pre-filters with
// isPlateCompositionEligible (Plate's own gate never admits "track") ────────
ok(
  buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ tier: "track" })]).length === 0,
  "track-tier candidate is defensively excluded at the suggestion-construction boundary",
);

// ── 9/10. Prioritizes finite HR-specific scores; sorted descending ──────────
{
  const withHr = eligiblePlateSignal({ batterId: "withHr", score10: 4.0, marketScores: { home_runs: 6.0 } });
  const noHr = eligiblePlateSignal({ batterId: "noHr", score10: 9.9, marketScores: {} });
  const result = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [noHr, withHr]);
  ok(result.length === 2, "both candidates qualify");
  ok(result[0].batterId === "withHr", "a finite HR score ranks ahead of a missing HR score regardless of overall score10 magnitude");

  const hrA = eligiblePlateSignal({ batterId: "hrA", marketScores: { home_runs: 9.0 } });
  const hrB = eligiblePlateSignal({ batterId: "hrB", marketScores: { home_runs: 3.0 } });
  const hrC = eligiblePlateSignal({ batterId: "hrC", marketScores: { home_runs: 6.0 } });
  const ranked = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [hrA, hrB, hrC]);
  ok(ranked.map((r) => r.batterId).join(",") === "hrA,hrC,hrB", `HR scores sort descending (got ${ranked.map((r) => r.batterId).join(",")})`);
}

// ── 11. Overall score only a secondary/fallback rank ─────────────────────────
{
  const noHrHighScore = eligiblePlateSignal({ batterId: "a", marketScores: {}, score10: 8.0 });
  const noHrLowScore = eligiblePlateSignal({ batterId: "b", marketScores: {}, score10: 5.0 });
  const ranked = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [noHrLowScore, noHrHighScore]);
  ok(ranked.map((r) => r.batterId).join(",") === "a,b", "among no-HR-score candidates, overall score10 breaks the tie, descending");
  ok(ranked.every((r) => r.rankingBasis === "overall_fallback"), "both report rankingBasis overall_fallback");
}

// ── 12. Deterministic batting-order and batter-ID tie-breakers ───────────────
{
  const slotLate = eligiblePlateSignal({ batterId: "z", marketScores: { home_runs: 5.0 }, battingOrderSlot: 6 });
  const slotEarly = eligiblePlateSignal({ batterId: "a", marketScores: { home_runs: 5.0 }, battingOrderSlot: 2 });
  const slotUnknown = eligiblePlateSignal({ batterId: "m", marketScores: { home_runs: 5.0 }, battingOrderSlot: null });
  const ranked = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [slotLate, slotUnknown, slotEarly]);
  ok(
    ranked.map((r) => r.batterId).join(",") === "a,z,m",
    `equal HR score ties break on batting-order slot ascending, unconfirmed last (got ${ranked.map((r) => r.batterId).join(",")})`,
  );

  const idB = eligiblePlateSignal({ batterId: "batter-b", marketScores: { home_runs: 5.0 }, battingOrderSlot: 3 });
  const idA = eligiblePlateSignal({ batterId: "batter-a", marketScores: { home_runs: 5.0 }, battingOrderSlot: 3 });
  const rankedById = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [idB, idA]);
  ok(
    rankedById.map((r) => r.batterId).join(",") === "batter-a,batter-b",
    "equal HR score AND slot ties break on batterId ascending as the final stable tie-break",
  );
}

// ── 13. Caps output at three ───────────────────────────────────────────────────
{
  const four = [1, 2, 3, 4].map((n) => eligiblePlateSignal({ batterId: `b${n}`, marketScores: { home_runs: n } }));
  ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, four).length === 3, "4 qualifying candidates capped at 3");
}

// ── 14. Does not mutate the input Plate array ─────────────────────────────────
{
  const a = eligiblePlateSignal({ batterId: "a", marketScores: { home_runs: 3.0 } });
  const b = eligiblePlateSignal({ batterId: "b", marketScores: { home_runs: 9.0 } });
  const input = [a, b];
  const inputSnapshot = [...input];
  buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, input);
  ok(input[0] === inputSnapshot[0] && input[1] === inputSnapshot[1], "input array order/identity is unchanged after ranking (sorts a copy)");
  ok(JSON.stringify(a) === JSON.stringify(eligiblePlateSignal({ batterId: "a", marketScores: { home_runs: 3.0 } })), "individual Plate signal objects are never mutated");
}

// ── 15. Handles missing marketScores ─────────────────────────────────────────
{
  const noMarketScores = eligiblePlateSignal({ marketScores: undefined as unknown as Partial<Record<string, number>> });
  const result = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [noMarketScores]);
  ok(result.length === 1, "missing marketScores object entirely still qualifies (falls back to overall score)");
  ok(result[0].hrScore === null && result[0].rankingBasis === "overall_fallback", "missing marketScores → hrScore null, overall_fallback");
}

// ── 16. Handles NaN, Infinity, and non-finite scores ──────────────────────────
for (const bad of [NaN, Infinity, -Infinity]) {
  const result = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ marketScores: { home_runs: bad } })]);
  ok(result.length === 1, `non-finite home_runs score (${bad}) still qualifies via fallback, never throws`);
  ok(result[0].hrScore === null, `non-finite home_runs score (${bad}) is treated as unavailable, not fabricated`);
}

// ── 17. Returns a correct rankingBasis ────────────────────────────────────────
{
  const withHr = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ marketScores: { home_runs: 7.0 } })]);
  ok(withHr[0].rankingBasis === "home_runs" && withHr[0].hrScore === 7.0, "finite HR score → rankingBasis home_runs");
  const withoutHr = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal({ marketScores: {} })]);
  ok(withoutHr[0].rankingBasis === "overall_fallback" && withoutHr[0].hrScore === null, "no HR score → rankingBasis overall_fallback, hrScore null");
}

// ── 18. Never throws when passed an empty Plate signal array ─────────────────
ok(buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, []).length === 0, "empty Plate array → [] without throwing");

// ── Output contains only the approved response fields ────────────────────────
{
  const [suggestion] = buildMoundPlateTargetSuggestions(HR_SUSCEPTIBLE, [eligiblePlateSignal()]);
  const expectedKeys = ["batterId", "batterName", "team", "battingOrderSlot", "plateTier", "plateScore10", "hrScore", "rankingBasis"].sort().join(",");
  ok(Object.keys(suggestion).sort().join(",") === expectedKeys, `suggestion has exactly the approved fields (got ${Object.keys(suggestion).sort().join(",")})`);
}

console.log(`\nmoundPlateTargets.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
