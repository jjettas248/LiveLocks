/**
 * HR Radar consumer decision view — invariant test.
 *
 * Locks the contract `hrRadarDecisionView.ts` builds for Quick Decide + Full
 * Ladder: stage mapping, result classification (signal_hit/official_miss/
 * model_review), Fire-only counting, CTA gating, dedup + conflict
 * resolution, final-game exclusion, and counts/array-length parity.
 *
 * Run: npx tsx server/mlb/hrRadarDecisionView.test.ts
 */

import { buildHrRadarDecisionView, type HrRadarLadderInput } from "./hrRadarDecisionView";
import { validateHrRadarDecisionView } from "../validation/hrRadar/decisionViewInvariants";
import type { HrRadarLadderEntry } from "../storage";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

console.log("\n=== HR Radar Decision View — Invariant Suite ===\n");

let seq = 0;
function makeEntry(overrides: Partial<HrRadarLadderEntry> = {}): HrRadarLadderEntry {
  seq++;
  return {
    playerId: `p${seq}`,
    playerName: `Player ${seq}`,
    team: "NYY",
    gameId: overrides.gameId ?? `g${seq}`,
    currentStage: "watch",
    currentStatus: "live",
    outcome: "pending",
    plateAppearancesTracked: 2,
    hasLiveABContext: true,
    userReasons: [],
    adminReasons: [],
    summary: "",
    initialReadinessScore: null,
    currentReadinessScore: null,
    peakReadinessScore: null,
    buildScore: null,
    conversionProbability: null,
    pitcherHrVulnerability: null,
    initialSignalScore10: null,
    currentSignalScore10: null,
    peakSignalScore10: null,
    deltaFromInitial10: null,
    deltaFromPeak10: null,
    displayInitialScore10: null,
    displayCurrentScore10: null,
    displayPeakScore10: null,
    displayGrade: null,
    displayCap10: null,
    displayCapBadgeLabel: null,
    displayCapReason: null,
    isHeatingUp: false,
    isCoolingOff: false,
    momentumLabel: "flat",
    detectedLabel: null,
    hitLabel: null,
    stageExplanation: "",
    headlineReason: null,
    supportingReasons: [],
    state: null,
    confidenceTier: null,
    peakScore: null,
    signalStrengthScore: null,
    whyNowReasons: [],
    nextAbEstimate: null,
    detectedInning: null,
    detectedHalf: null,
    hitInning: null,
    hitHalf: null,
    outcomeStatus: "active",
    userVisible: true,
    signalDetectedAt: null,
    hitDetectedAt: null,
    resolvedAt: null,
    alertPath: null,
    remainingPAExpectation: null,
    currentInning: null,
    onlyHomersVerified: false,
    ohExitVelocity: null,
    ohLaunchAngle: null,
    ohDistance: null,
    ohPitchType: null,
    userStage: "track",
    stageLabel: "Track",
    stageDescription: "",
    qualifyingSignals: [],
    badges: [],
    cleanReasons: [],
    officialSignalStage: null,
    officialSignalAt: null,
    officialSignalInning: null,
    firstTrackedAt: null,
    firstTrackedInning: null,
    firstBuiltAt: null,
    firstBuiltInning: null,
    firstReadyAt: null,
    firstReadyInning: null,
    firstFireAt: null,
    firstFireInning: null,
    hrOccurredAt: null,
    hrOccurredInning: null,
    debugReasons: [],
    enginePath: null,
    ...overrides,
  } as HrRadarLadderEntry;
}

function ladderOf(sections: Partial<HrRadarLadderInput["sections"]>): HrRadarLadderInput {
  return { sessionDate: "2026-07-18", sections };
}

const quietLogs: string[] = [];
const quietLogger = (m: string) => { quietLogs.push(m); };

// ── 1. Live stage mapping ────────────────────────────────────────────────
console.log("Live stage mapping");
{
  const fire = makeEntry({ gameId: "g1", playerId: "fire1" });
  const ready = makeEntry({ gameId: "g1", playerId: "ready1" });
  const build = makeEntry({ gameId: "g1", playerId: "build1" });
  const watch = makeEntry({ gameId: "g1", playerId: "watch1" });
  const view = buildHrRadarDecisionView(
    ladderOf({ attackNow: [fire], ready: [ready], building: [build], watch: [watch], cashed: [], dead: [] }),
    { logger: quietLogger },
  );
  eq("1.1 attackNow row → liveStage fire", view.entries["g1:fire1"].liveStage, "fire");
  eq("1.2 ready row → liveStage ready", view.entries["g1:ready1"].liveStage, "ready");
  eq("1.3 building row → liveStage build", view.entries["g1:build1"].liveStage, "build");
  eq("1.4 watch row → liveStage watch", view.entries["g1:watch1"].liveStage, "watch");
  eq("1.5 fire in groups.takeNow", view.groups.takeNow.includes("g1:fire1"), true);
  eq("1.6 ready in groups.watchNextAb", view.groups.watchNextAb.includes("g1:ready1"), true);
  eq("1.7 build in groups.build", view.groups.build.includes("g1:build1"), true);
  eq("1.8 watch in groups.watch", view.groups.watch.includes("g1:watch1"), true);
}

// ── 2. Consumer action mapping ───────────────────────────────────────────
console.log("\nConsumer action mapping");
{
  const fire = makeEntry({ gameId: "g2", playerId: "fire1" });
  const ready = makeEntry({ gameId: "g2", playerId: "ready1" });
  const build = makeEntry({ gameId: "g2", playerId: "build1" });
  const view = buildHrRadarDecisionView(
    ladderOf({ attackNow: [fire], ready: [ready], building: [build], watch: [], cashed: [], dead: [] }),
    { logger: quietLogger },
  );
  eq("2.1 Fire → take_now", view.entries["g2:fire1"].consumerAction, "take_now");
  eq("2.2 Ready → watch_next_ab", view.entries["g2:ready1"].consumerAction, "watch_next_ab");
  eq("2.3 Build → none", view.entries["g2:build1"].consumerAction, "none");
}

// ── 3. canAddToSlip / canWatchNextAb gating ──────────────────────────────
console.log("\ncanAddToSlip / canWatchNextAb gating — Fire-only slip access");
{
  const fireValid = makeEntry({ gameId: "g3", playerId: "fire1" });
  const fireNoIdentity = makeEntry({ gameId: "g3", playerId: "fire2", playerName: "" });
  const ready = makeEntry({ gameId: "g3", playerId: "ready1" });
  const build = makeEntry({ gameId: "g3", playerId: "build1" });
  const watch = makeEntry({ gameId: "g3", playerId: "watch1" });
  const view = buildHrRadarDecisionView(
    ladderOf({
      attackNow: [fireValid, fireNoIdentity],
      ready: [ready],
      building: [build],
      watch: [watch],
      cashed: [],
      dead: [],
    }),
    { logger: quietLogger },
  );
  eq("3.1 valid Fire → canAddToSlip true", view.entries["g3:fire1"].canAddToSlip, true);
  eq("3.2 Fire with invalid identity → canAddToSlip false (still take_now)",
    view.entries["g3:fire2"].canAddToSlip, false);
  eq("3.2b Fire with invalid identity → consumerAction still take_now",
    view.entries["g3:fire2"].consumerAction, "take_now");
  eq("3.3 Ready → canAddToSlip false", view.entries["g3:ready1"].canAddToSlip, false);
  eq("3.4 Ready → canWatchNextAb true", view.entries["g3:ready1"].canWatchNextAb, true);
  eq("3.5 Build → canAddToSlip false", view.entries["g3:build1"].canAddToSlip, false);
  eq("3.6 Build → canWatchNextAb false", view.entries["g3:build1"].canWatchNextAb, false);
  eq("3.7 Watch → canAddToSlip false", view.entries["g3:watch1"].canAddToSlip, false);
  eq("3.8 Watch → canWatchNextAb false", view.entries["g3:watch1"].canWatchNextAb, false);
}

// ── 4. Result classification — Fire-only signal_hit / official_miss ─────
console.log("\nResult classification — Fire-only, model_review never leaks into public buckets");
{
  const fireHit = makeEntry({
    gameId: "g4", playerId: "hit1", currentStatus: "resolved",
    outcome: "called_hit", outcomeStatus: "called_hit_attack",
  });
  const legacyHit = makeEntry({
    gameId: "g4", playerId: "hit2", currentStatus: "resolved",
    outcome: "called_hit", outcomeStatus: "called_hit",
  });
  const readyTierHit = makeEntry({
    gameId: "g4", playerId: "hit3", currentStatus: "resolved",
    outcome: "called_hit", outcomeStatus: "called_hit_ready",
  });
  const buildTierHit = makeEntry({
    gameId: "g4", playerId: "hit4", currentStatus: "resolved",
    outcome: "called_hit", outcomeStatus: "called_hit_build",
  });
  const fireMiss = makeEntry({
    gameId: "g4", playerId: "miss1", currentStatus: "resolved",
    outcome: "miss", outcomeStatus: "called_miss",
  });
  const uncalledHr = makeEntry({
    gameId: "g4", playerId: "review1", currentStatus: "resolved",
    outcome: "uncalled_hr", outcomeStatus: "uncalled_hr",
  });
  const lateSignal = makeEntry({
    gameId: "g4", playerId: "review2", currentStatus: "resolved",
    outcome: "late_signal", outcomeStatus: "late_signal",
  });
  const earlyWindow = makeEntry({
    gameId: "g4", playerId: "review3", currentStatus: "resolved",
    outcome: "early_window_hr", outcomeStatus: "early_hr_insufficient_sample",
  });
  const expired = makeEntry({
    gameId: "g4", playerId: "review4", currentStatus: "resolved",
    outcome: "expired", outcomeStatus: "unresolved",
  });
  const view = buildHrRadarDecisionView(
    ladderOf({
      attackNow: [], ready: [], building: [], watch: [],
      cashed: [fireHit, legacyHit, readyTierHit, buildTierHit],
      dead: [fireMiss, uncalledHr, lateSignal, earlyWindow, expired],
    }),
    { logger: quietLogger },
  );
  eq("4.1 called_hit_attack → signal_hit", view.entries["g4:hit1"].resultType, "signal_hit");
  eq("4.2 legacy untiered called_hit → signal_hit", view.entries["g4:hit2"].resultType, "signal_hit");
  eq("4.3 called_hit_ready → model_review (NOT signal_hit)", view.entries["g4:hit3"].resultType, "model_review");
  eq("4.4 called_hit_build → model_review (NOT signal_hit)", view.entries["g4:hit4"].resultType, "model_review");
  eq("4.5 miss (already Fire-gated at write time) → official_miss", view.entries["g4:miss1"].resultType, "official_miss");
  eq("4.6 uncalled_hr → model_review (NEVER officialMisses)", view.entries["g4:review1"].resultType, "model_review");
  eq("4.7 late_signal → model_review", view.entries["g4:review2"].resultType, "model_review");
  eq("4.8 early_window_hr → model_review", view.entries["g4:review3"].resultType, "model_review");
  eq("4.9 expired → model_review", view.entries["g4:review4"].resultType, "model_review");

  eq("4.10 groups.signalHits has exactly the two Fire-tier hits",
    [...view.groups.signalHits].sort().join(","), ["g4:hit1", "g4:hit2"].sort().join(","));
  eq("4.11 groups.officialMisses has exactly the Fire miss", view.groups.officialMisses.join(","), "g4:miss1");
  eq("4.12 groups.modelReview has all 6 non-Fire resolved rows", view.groups.modelReview.length, 6);
  eq("4.13 uncalled_hr never in officialMisses", view.groups.officialMisses.includes("g4:review1"), false);
  eq("4.14 Ready-tier hit never in signalHits", view.groups.signalHits.includes("g4:hit3"), false);

  eq("4.15 fireHitsToday counts only Fire-tier hits", view.counts.fireHitsToday, 2);
  eq("4.16 fireMissesToday counts only Fire misses", view.counts.fireMissesToday, 1);
  eq("4.17 hasFireCommitment true for Fire hit", view.entries["g4:hit1"].hasFireCommitment, true);
  eq("4.18 hasFireCommitment false for Ready-tier hit", view.entries["g4:hit3"].hasFireCommitment, false);
  eq("4.19 hasFireCommitment true for Fire miss", view.entries["g4:miss1"].hasFireCommitment, true);
}

// ── 5. Final-game protection ─────────────────────────────────────────────
console.log("\nFinal-game protection — a final-game row is never live");
{
  const staleFireRow = makeEntry({
    gameId: "g5", playerId: "stale1", currentStatus: "live", outcome: "pending",
    isGameFinal: true,
  });
  const view = buildHrRadarDecisionView(
    ladderOf({ attackNow: [staleFireRow], ready: [], building: [], watch: [], cashed: [], dead: [] }),
    { logger: quietLogger },
  );
  eq("5.1 final-game row → liveStage null", view.entries["g5:stale1"].liveStage, null);
  eq("5.2 final-game row → isResolved true", view.entries["g5:stale1"].isResolved, true);
  eq("5.3 final-game row not in takeNow", view.groups.takeNow.includes("g5:stale1"), false);
  eq("5.4 final-game row with pending outcome → model_review (undercount, not fabricated)",
    view.entries["g5:stale1"].resultType, "model_review");
}

// ── 6. Dedup + conflict resolution ───────────────────────────────────────
console.log("\nDedup + conflict resolution — strongest canonical section wins");
{
  const dupFire = makeEntry({ gameId: "g6", playerId: "dup1" });
  const dupWatch = makeEntry({ gameId: "g6", playerId: "dup1" }); // same entryId, weaker section
  const conflictLogs: string[] = [];
  const view = buildHrRadarDecisionView(
    ladderOf({ attackNow: [dupFire], ready: [], building: [], watch: [dupWatch], cashed: [], dead: [] }),
    { logger: (m) => { conflictLogs.push(m); } },
  );
  eq("6.1 duplicate entryId collapses to one entry", Object.keys(view.entries).filter((k) => k === "g6:dup1").length, 1);
  eq("6.2 Fire (stronger) wins over Watch (weaker)", view.entries["g6:dup1"].liveStage, "fire");
  eq("6.3 entry appears only once across groups",
    [...view.groups.takeNow, ...view.groups.watch].filter((id) => id === "g6:dup1").length, 1);
  assert("6.4 [HR_RADAR_DECISION_CONFLICT] logged for the duplicate",
    conflictLogs.some((l) => l.includes("[HR_RADAR_DECISION_CONFLICT]") && l.includes("g6:dup1")));
}

// ── 7. Pregame-only exclusion vs waiting-for-first-AB ────────────────────
console.log("\nPregame-only rows excluded; live-no-AB rows go to waitingForFirstAb");
{
  const truePregame = makeEntry({
    gameId: "g7", playerId: "pregame1", plateAppearancesTracked: 0, hasLiveABContext: false,
  });
  const liveNoAb = makeEntry({
    gameId: "g7", playerId: "noab1", plateAppearancesTracked: 0, hasLiveABContext: true,
  });
  const view = buildHrRadarDecisionView(
    ladderOf({ attackNow: [], ready: [], building: [], watch: [truePregame, liveNoAb], cashed: [], dead: [] }),
    { logger: quietLogger },
  );
  eq("7.1 true pregame-only row excluded from entries", "g7:pregame1" in view.entries, false);
  eq("7.2 live-but-no-AB row present", "g7:noab1" in view.entries, true);
  eq("7.3 live-but-no-AB row → waitingForFirstAb", view.groups.waitingForFirstAb.includes("g7:noab1"), true);
  eq("7.4 live-but-no-AB row NOT in watch group", view.groups.watch.includes("g7:noab1"), false);
}

// ── 8. Counts equal array lengths (contract-level, via the invariant validator) ──
console.log("\nCounts equal their array lengths (full decision-view invariant sweep)");
{
  const fire = makeEntry({ gameId: "g8", playerId: "fire1" });
  const ready = makeEntry({ gameId: "g8", playerId: "ready1" });
  const build = makeEntry({ gameId: "g8", playerId: "build1" });
  const watch = makeEntry({ gameId: "g8", playerId: "watch1" });
  const hit = makeEntry({
    gameId: "g8", playerId: "hit1", currentStatus: "resolved",
    outcome: "called_hit", outcomeStatus: "called_hit_attack",
  });
  const miss = makeEntry({
    gameId: "g8", playerId: "miss1", currentStatus: "resolved",
    outcome: "miss", outcomeStatus: "called_miss",
  });
  const view = buildHrRadarDecisionView(
    ladderOf({
      attackNow: [fire], ready: [ready], building: [build], watch: [watch],
      cashed: [hit], dead: [miss],
    }),
    { logger: quietLogger },
  );
  const report = validateHrRadarDecisionView(view);
  assert("8.1 no invariant violations", report.violations.length === 0, JSON.stringify(report.violations));
  eq("8.2 totalEntries matches entries built", report.totalEntries, Object.keys(view.entries).length);
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
