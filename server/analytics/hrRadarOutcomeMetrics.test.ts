// HR Radar Intelligence — playability outcome-bucket metrics (spec §8).
//   npx tsx server/analytics/hrRadarOutcomeMetrics.test.ts
//
// Key invariants:
//   1. officialRecall <= radarCoverageRecall always (official is a subset of
//      radar coverage by construction).
//   2. A Lean/Watchlist-only HR must NOT inflate officialRecall.
import { _resetAnalyticsForTests } from "./analyticsEvent";
import { emitHrRadarTransition, emitHrRadarOutcome, emitHrRadarMissTrace, emitCalledHitLeadTime } from "./eventEmitters";
import { computeHrRadarIntelligence } from "./hrRadarIntelligence";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}
function assert(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  cond ? pass++ : fail++;
}

function climb(signalId: string, stages: string[]) {
  let prev = "inactive";
  for (const s of stages) {
    emitHrRadarTransition({ signalId, gameId: "G1", playerId: signalId, fromStage: prev, toStage: s, signalPath: "PATH_A", score10: 8 });
    prev = s;
  }
}

console.log("\n=== HR Radar Playability Outcome Metrics ===\n");
_resetAnalyticsForTests();

// s1: reached FIRE (Attack), cashed → attack_before_hr, official.
climb("s1", ["track", "build", "ready", "fire"]);
emitHrRadarOutcome({ signalId: "s1", gameId: "G1", playerId: "s1", kind: "cashed", signalPath: "PATH_A", score10: 9, gradingStatus: "called_hit" });
emitCalledHitLeadTime({ signalId: "s1", gameId: "G1", playerId: "s1", leadTimeMs: 60000, alertPath: "PATH_A" });

// s2: reached READY only (Playable), cashed → playable_before_hr, still official
// under the playability contract (distinct from the stricter FIRE-only
// officialFireRecord metric tested elsewhere).
climb("s2", ["track", "build", "ready"]);
emitHrRadarOutcome({ signalId: "s2", gameId: "G1", playerId: "s2", kind: "cashed", signalPath: "PATH_A", score10: 7, gradingStatus: "uncalled_hr" });

// s3: reached BUILD only (Lean), cashed → lean_before_hr, NOT official.
climb("s3", ["track", "build"]);
emitHrRadarOutcome({ signalId: "s3", gameId: "G1", playerId: "s3", kind: "cashed", signalPath: "PATH_A", score10: 5, gradingStatus: "uncalled_hr" });

// s4: reached TRACK only (Watchlist), cashed → watchlist_before_hr, NOT official.
climb("s4", ["track"]);
emitHrRadarOutcome({ signalId: "s4", gameId: "G1", playerId: "s4", kind: "cashed", signalPath: "PATH_A", score10: 2, gradingStatus: "uncalled_hr" });

// s5: a late-signal HR (radar caught it only after the fact).
emitHrRadarMissTrace({ signalId: "s5", gameId: "G1", playerId: "s5", gradingStatus: "late_signal", blockedGate: "late_signal", strongContact: false });

// s6: a true uncalled HR — no pre-HR playability at all.
emitHrRadarMissTrace({ signalId: "s6", gameId: "G1", playerId: "s6", gradingStatus: "uncalled_hr", blockedGate: "no_alert", strongContact: false });

const snap = computeHrRadarIntelligence({ windowMs: 60 * 60 * 1000 });
const m = snap.playabilityMetrics;

// allHrsObserved = s1(attack) + s2(playable) + s3(lean) + s4(watchlist) + s5(late) + s6(uncalled) = 6.
eq("officialRecall = 2/6 (s1 attack + s2 playable)", m.officialRecall, 2 / 6);
eq("radarCoverageRecall = 4/6 (s1+s2+s3+s4)", m.radarCoverageRecall, 4 / 6);
eq("lateSignalRate = 1/6 (s5)", m.lateSignalRate, 1 / 6);
eq("trueUncalledHrRate = 1/6 (s6)", m.trueUncalledHrRate, 1 / 6);

// Key invariant 1: officialRecall <= radarCoverageRecall always.
assert("officialRecall <= radarCoverageRecall",
  (m.officialRecall ?? 0) <= (m.radarCoverageRecall ?? 0),
  `officialRecall=${m.officialRecall} radarCoverageRecall=${m.radarCoverageRecall}`);

// Key invariant 2: a Lean/Watchlist-only HR (s3, s4) must not inflate officialRecall —
// verify by comparing against a numerator that deliberately excludes them.
assert("Lean/Watchlist-only cashes (s3,s4) excluded from officialRecall numerator",
  (m.officialRecall ?? 0) < (m.radarCoverageRecall ?? 0),
  `officialRecall=${m.officialRecall} radarCoverageRecall=${m.radarCoverageRecall}`);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
