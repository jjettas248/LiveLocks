// Pre-Game Power Radar — frozen evaluation-snapshot invariants.
//
// Guards the research-instrumentation contract (Phase 1):
//   1. Every evaluated candidate (including suppressed/never-flagged ones)
//      gets a finalPregameSnapshot while a legitimate pregame build ran.
//   2. firstPublicSnapshot mints on a genuine nonpublic→public transition,
//      including a brand-new candidate's very first build — never suppressed
//      merely because prevSignal is null.
//   3. An instrumentation gap (hydrated prior signal already public with no
//      recorded firstPublicSnapshot) is the ONLY case that permanently blocks
//      firstPublicSnapshot — tagged instrumentation_started_after_surface.
//   4. finalPregameSnapshot freezes permanently once locked; a legacy row
//      (prior signal, no evaluation field) is distinguished from a genuinely
//      first-seen-post-lock candidate.
//   5. Population ranks are computed over the complete population with a
//      deterministic tie-breaker.
//   6. Champion score10/tier/drivers/marketScores are never read or mutated
//      by this instrumentation.
//
// Run: npx tsx server/mlb/pregamePowerRadar/evaluationSnapshot.test.ts

import {
  computePopulationRanks,
  buildEvaluationSnapshot,
  detectTransition,
  applySnapshotLifecycle,
  applyEvaluationSnapshots,
} from "./evaluationSnapshot";
import type { PregamePowerSignal, PregameEvaluationRecord } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(over: Partial<PregamePowerSignal>): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b1", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs", "total_bases"], marketScores: { home_runs: 7, total_bases: 6 },
    marketSetups: [], parkContext: null,
    score10: 7, tier: "strong",
    drivers: [], warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, pitcherHandednessScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95,
      pitcherOrderSplitAvailable: false, pitcherOrderSplitScore: null, pitcherOrderSplitDirection: "unavailable",
      batterCurrentOrderSlot: 3, batterOrderSplitAvailable: false, batterOrderSplitScore: null, batterOrderSplitDirection: "unavailable",
      bvpAvailable: false, bvpScore: null, bvpSampleSize: null, bvpDirection: "neutral", zeroProductionBvpFlags: [],
      finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, matchupPenalty: 0, publicTier: "strong",
      warningTags: [], downgradeReasons: [],
      suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    },
    ...over,
  };
}

// ── 1. Brand-new candidate becoming public on first build → genuine mint, not a gap ──
{
  const fresh = sig({ everPubliclyFlagged: true, status: "active", firstPitchLockEligible: true });
  const transition = detectTransition(fresh, undefined);
  ok(transition.becamePublicNow === true, "prevSignal null + fresh public now → becamePublicNow true");
  ok(transition.instrumentationGapDetected === false, "prevSignal null never triggers an instrumentation gap");

  const snapshot = buildEvaluationSnapshot(fresh, { holistic: 1, byMarket: { home_runs: 1 } }, "b1", 1, "2026-07-01T00:00:00Z");
  const record = applySnapshotLifecycle(null, snapshot, transition);
  ok(record.firstPublicSnapshot === snapshot, "brand-new public candidate mints firstPublicSnapshot");
  ok(record.firstPublicUnavailableReason === null, "no unavailable reason once minted");
}

// ── 2. Instrumentation gap: hydrated prior signal already public, no recorded snapshot ──
{
  const prev = sig({ everPubliclyFlagged: true, diagnostics: { ...sig({}).diagnostics } }); // evaluation field absent (legacy)
  const fresh = sig({ everPubliclyFlagged: true, status: "active" });
  const transition = detectTransition(fresh, prev);
  ok(transition.becamePublicNow === false, "already-public prev → not a fresh transition");
  ok(transition.instrumentationGapDetected === true, "hydrated already-public prior with no firstPublicSnapshot → gap detected");

  const snapshot = buildEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z");
  const record = applySnapshotLifecycle(null, snapshot, transition);
  ok(record.firstPublicSnapshot === null, "gap case: firstPublicSnapshot stays permanently null");
  ok(record.firstPublicUnavailableReason === "instrumentation_started_after_surface", "gap case tagged correctly");
}

// ── 2b. A DELAYED/UNKNOWN game before first pitch stays snapshot-eligible ──
// Codex review finding: firstPitchLockEligible is false for gameStatus
// "delayed"/"unknown" (only "scheduled"/"pre" set it true), but status stays
// "active" in that case (buildPregamePowerRadar.ts's isLocked only fires for
// suspended, or live/final without lock-eligibility) — the public predicate
// can still surface these rows. lockedForEvaluation must NOT freeze
// finalPregameSnapshot here.
{
  const fresh = sig({ status: "active", firstPitchLockEligible: false, gameStatus: "delayed" });
  const transition = detectTransition(fresh, undefined);
  ok(transition.lockedForEvaluation === false, "delayed pre-first-pitch game (status still active) is NOT locked-for-evaluation");

  const snapshot = buildEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z");
  const record = applySnapshotLifecycle(null, snapshot, transition);
  ok(record.finalPregameSnapshot === snapshot, "delayed game keeps refreshing finalPregameSnapshot, not prematurely frozen");
}

// ── 3. Suppressed/never-flagged candidate still gets a finalPregameSnapshot ──
{
  const fresh = sig({ everPubliclyFlagged: false, suppressed: true, status: "active", firstPitchLockEligible: true });
  const transition = detectTransition(fresh, undefined);
  const snapshot = buildEvaluationSnapshot(fresh, { holistic: 5, byMarket: {} }, "b1", 5, "2026-07-01T00:00:00Z");
  const record = applySnapshotLifecycle(null, snapshot, transition);
  ok(record.finalPregameSnapshot === snapshot, "suppressed candidate still gets a legitimate finalPregameSnapshot");
  ok(record.finalPregameUnavailableReason === null, "no unavailable reason while legitimately pre-lock");
  ok(record.firstPublicSnapshot === null && record.firstPublicUnavailableReason === "not_yet_public",
    "never-flagged candidate: firstPublicSnapshot null, reason not_yet_public (not an error)");
}

// ── 4. Candidate first built post-lock → first_seen_post_lock, no prior signal at all ──
{
  const fresh = sig({ status: "locked", firstPitchLockEligible: false, gameStatus: "live" });
  const transition = detectTransition(fresh, undefined);
  ok(transition.lockedForEvaluation === true, "locked status is detected as locked-for-evaluation");
  const snapshot = buildEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z");
  const record = applySnapshotLifecycle(null, snapshot, transition);
  ok(record.finalPregameSnapshot === null, "first-seen-post-lock candidate gets no fabricated pregame snapshot");
  ok(record.finalPregameUnavailableReason === "first_seen_post_lock", "reason is first_seen_post_lock, not legacy_row");
}

// ── 5. Legacy row: prior signal existed, but predates the evaluation field ──
{
  const prevBase = sig({ status: "locked", firstPitchLockEligible: false });
  const prev: PregamePowerSignal = { ...prevBase, diagnostics: { ...prevBase.diagnostics, evaluation: undefined } };
  const fresh = sig({ status: "locked", firstPitchLockEligible: false, gameStatus: "final" });
  const transition = detectTransition(fresh, prev);
  ok(transition.hadPriorSignal === true && transition.hadPriorEvaluationField === false, "legacy prior signal detected correctly");
  const snapshot = buildEvaluationSnapshot(fresh, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z");
  const record = applySnapshotLifecycle(null, snapshot, transition);
  ok(record.finalPregameUnavailableReason === "legacy_row", "prior signal without an evaluation field is classified legacy_row");
}

// ── 6. finalPregameSnapshot freezes permanently once locked — later cycles never overwrite it ──
{
  const pregameSnapshotAt6 = buildEvaluationSnapshot(sig({}), { holistic: 2, byMarket: {} }, "b1", 3, "2026-07-01T00:00:00Z");
  const prevEvaluation: PregameEvaluationRecord = {
    firstPublicSnapshot: null, firstPublicUnavailableReason: "not_yet_public",
    finalPregameSnapshot: pregameSnapshotAt6, finalPregameUnavailableReason: null,
  };
  const freshLocked = sig({ status: "locked", firstPitchLockEligible: false, score10: 9.9 }); // score jumped — must NOT leak in
  const transition = detectTransition(freshLocked, sig({ status: "active" }));
  ok(transition.lockedForEvaluation === true, "post-lock cycle is detected as locked");
  const laterSnapshot = buildEvaluationSnapshot(freshLocked, { holistic: 1, byMarket: {} }, "b2", 3, "2026-07-02T00:00:00Z");
  const record = applySnapshotLifecycle(prevEvaluation, laterSnapshot, transition);
  ok(record.finalPregameSnapshot === pregameSnapshotAt6, "locked signal keeps the ORIGINAL pregame snapshot, not the later rebuild's");
  ok(record.finalPregameSnapshot!.champion.score10 === 7, "frozen snapshot's score10 is untouched by the later score jump to 9.9");
}

// ── 7. computePopulationRanks: deterministic tie-breaker (score desc, coverage desc, signalId asc) ──
{
  const a = sig({ signalId: "a", score10: 7, marketScores: { home_runs: 8, total_bases: 5 } });
  const b = sig({ signalId: "b", score10: 7, marketScores: { home_runs: 8, total_bases: 6 } });
  b.diagnostics.dataCoverageScore = 0.5; // lower coverage than a (0.95) but same score10/home_runs score
  const c = sig({ signalId: "c", score10: 9, marketScores: { home_runs: 9 } });
  const ranks = computePopulationRanks([a, b, c]);
  ok(ranks.get("c")!.holistic === 1, "highest score10 ranks first");
  ok(ranks.get("a")!.holistic === 2, "tied score10 broken by higher data coverage (a > b)");
  ok(ranks.get("b")!.holistic === 3, "lower-coverage tie loses the tie-break");
  ok(ranks.get("c")!.byMarket.home_runs === 1 && ranks.get("a")!.byMarket.home_runs === 2 && ranks.get("b")!.byMarket.home_runs === 3,
    "home_runs rank uses market score independent of holistic rank");
  ok(ranks.get("c")!.byMarket.total_bases === undefined, "candidate with no total_bases marketScore is excluded from that market's rank");
}

// ── 8. applyEvaluationSnapshots: full orchestrator over a small population ──
{
  const signals = new Map<string, PregamePowerSignal>();
  signals.set("s1", sig({ signalId: "s1", score10: 8, everPubliclyFlagged: true }));
  signals.set("s2", sig({ signalId: "s2", score10: 5, suppressed: true, everPubliclyFlagged: false }));
  applyEvaluationSnapshots(signals, null, "build-1");
  ok(signals.get("s1")!.diagnostics.evaluation != null, "s1 gets an evaluation record");
  ok(signals.get("s2")!.diagnostics.evaluation != null, "s2 (suppressed) also gets an evaluation record");
  ok(signals.get("s1")!.diagnostics.evaluation!.firstPublicSnapshot != null, "s1 (publicly flagged) mints firstPublicSnapshot");
  ok(signals.get("s2")!.diagnostics.evaluation!.firstPublicSnapshot === null, "s2 (suppressed, never flagged) has no firstPublicSnapshot");
  ok(signals.get("s1")!.diagnostics.evaluation!.finalPregameSnapshot!.candidatePoolSize === 2, "candidatePoolSize reflects the full population, not per-signal");
}

console.log(`\nevaluationSnapshot.test (Plate): ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
