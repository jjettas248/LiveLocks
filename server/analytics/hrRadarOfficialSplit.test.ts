// HR Radar Intelligence — official(FIRE) vs shadow(watch) split invariants.
//   npx tsx server/analytics/hrRadarOfficialSplit.test.ts
//
// Asserts that ONLY signals that reached the FIRE stage count toward the
// official record, and READY-only resolutions are shadow/watch intelligence.
import { _resetAnalyticsForTests } from "./analyticsEvent";
import { emitHrRadarTransition, emitHrRadarOutcome } from "./eventEmitters";
import { computeHrRadarIntelligence } from "./hrRadarIntelligence";

let pass = 0, fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

function climb(signalId: string, stages: string[]) {
  let prev = "inactive";
  for (const s of stages) {
    emitHrRadarTransition({ signalId, gameId: "G1", playerId: signalId, fromStage: prev, toStage: s, signalPath: "PATH_A", score10: 8 });
    prev = s;
  }
}

console.log("\n=== HR Radar Official/Shadow Split ===\n");
_resetAnalyticsForTests();

// s1: track→build→ready→fire, then CASHED  → official FIRE cashed
climb("s1", ["track", "build", "ready", "fire"]);
emitHrRadarOutcome({ signalId: "s1", gameId: "G1", playerId: "s1", kind: "cashed", signalPath: "PATH_A", score10: 9, gradingStatus: "called_hit" });
// s2: ...→fire, then MISSED → official FIRE missed
climb("s2", ["track", "build", "ready", "fire"]);
emitHrRadarOutcome({ signalId: "s2", gameId: "G1", playerId: "s2", kind: "missed", signalPath: "PATH_A", score10: 8, gradingStatus: "called_miss" });
// s3: reached READY only (never fire), then CASHED → shadow win, NOT official
climb("s3", ["track", "build", "ready"]);
emitHrRadarOutcome({ signalId: "s3", gameId: "G1", playerId: "s3", kind: "cashed", signalPath: "PATH_A", score10: 7, gradingStatus: "uncalled_hr" });
// s4: reached READY only, then MISSED → shadow miss, NOT an official miss
climb("s4", ["track", "build", "ready"]);
emitHrRadarOutcome({ signalId: "s4", gameId: "G1", playerId: "s4", kind: "missed", signalPath: "PATH_A", score10: 6, gradingStatus: "expired" });

const snap = computeHrRadarIntelligence({ windowMs: 60 * 60 * 1000 });

eq("officialFireRecord.fireCalls = 2 (only s1+s2 reached FIRE)", snap.officialFireRecord.fireCalls, 2);
eq("officialFireRecord.fireCashed = 1 (s1)", snap.officialFireRecord.fireCashed, 1);
eq("officialFireRecord.fireMissed = 1 (s2)", snap.officialFireRecord.fireMissed, 1);
eq("officialFireRecord.fireHitRate = 0.5", snap.officialFireRecord.fireHitRate, 0.5);
eq("shadow.readyReached = 4 (all reached ready)", snap.shadowWatchIntelligence.readyReached, 4);
eq("shadow.watchPromotedToFire = 2 (s1,s2)", snap.shadowWatchIntelligence.watchPromotedToFire, 2);
eq("shadow.readyOnly = 2 (s3,s4)", snap.shadowWatchIntelligence.readyOnly, 2);
eq("shadow.watchCashedWithoutFire = 1 (s3)", snap.shadowWatchIntelligence.watchCashedWithoutFire, 1);
eq("shadow.readyOnlyMissed = 1 (s4)", snap.shadowWatchIntelligence.readyOnlyMissed, 1);
// Key invariant: a READY-only HR (s3) must NOT inflate the official cashed count.
eq("READY-only cash excluded from official fireCashed", snap.officialFireRecord.fireCashed, 1);

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) process.exit(1);
