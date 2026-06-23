/**
 * HR Radar shadow precision/recall — invariant test.
 *
 * Exercises the full read-only chain: the additive emitters
 * (emitHrRadarTransition with signalPath/score10, emitHrRadarOutcome →
 * hr_radar_cashed/missed) feeding computeHrRadarShadowSnapshot /
 * computeHrRadarShadowRecords. Locks the per-path false-positive slicing and
 * the Ready-vs-Fire hit-rate comparison used to gate threshold changes.
 *
 * Run: npx tsx server/analytics/hrRadarShadowMetrics.test.ts
 */

import { _resetAnalyticsForTests, recordAnalyticsEvent } from "./analyticsEvent";
import { emitHrRadarTransition, emitHrRadarOutcome } from "./eventEmitters";
import {
  computeHrRadarShadowSnapshot,
  computeHrRadarShadowRecords,
} from "./hrRadarShadowMetrics";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function approx(name: string, actual: number | null, expected: number, eps = 1e-6): void {
  assert(name, actual != null && Math.abs(actual - expected) < eps, `expected≈${expected} actual=${String(actual)}`);
}

console.log("\n=== HR Radar Shadow Precision/Recall — Invariant Suite ===\n");

_resetAnalyticsForTests();

const PF = "PATH_F_BLOCKED_BRIDGE";
const PA = "PATH_A";

function transition(signalId: string, gameId: string, playerId: string, path: string, stages: string[], score10 = 8) {
  let prev = "inactive";
  for (const s of stages) {
    emitHrRadarTransition({ signalId, gameId, playerId, fromStage: prev, toStage: s, signalPath: path, score10 });
    prev = s;
  }
}

// G1 — S1 PATH_A: track→build→ready→fire, then HR (cashed).
transition("s1", "G1", "p1", PA, ["track", "build", "ready", "fire"], 9.2);
emitHrRadarOutcome({ signalId: "s1", gameId: "G1", playerId: "p1", kind: "cashed", signalPath: PA, score10: 9.2, gradingStatus: "called_hit" });
recordAnalyticsEvent({ eventType: "hr_radar_called_hit_lead", signalId: "s1", sport: "mlb", gameId: "G1", playerId: "p1", market: "home_runs", side: "OVER", signalTier: null, lifecycleState: null, leadTimeMs: 120000 });

// G1 — S2 PATH_F: track→build→ready, no HR (missed) → false positive (ready, not fire).
transition("s2", "G1", "p2", PF, ["track", "build", "ready"], 7.6);
emitHrRadarOutcome({ signalId: "s2", gameId: "G1", playerId: "p2", kind: "missed", signalPath: PF, score10: 7.6, gradingStatus: "called_miss" });

// G1 — S3 PATH_F: track→build→ready→fire, no HR (missed) → false positive (fire).
transition("s3", "G1", "p3", PF, ["track", "build", "ready", "fire"], 8.1);
emitHrRadarOutcome({ signalId: "s3", gameId: "G1", playerId: "p3", kind: "missed", signalPath: PF, score10: 8.1, gradingStatus: "called_miss" });

// G2 — S4 PATH_E: track→build only, no terminal outcome (still live / unresolved).
transition("s4", "G2", "p4", "PATH_E_CONVICTION", ["track", "build"], 5.5);

// G2 — S5: track→build, then an uncalled/late HR captured by the miss-tracer.
transition("s5", "G2", "p5", PF, ["track", "build"], 5.0);
recordAnalyticsEvent({ eventType: "hr_radar_miss_trace", signalId: "s5", sport: "mlb", gameId: "G2", playerId: "p5", market: "home_runs", side: "OVER", signalTier: null, lifecycleState: null, outcome: "late_signal", blockedGate: "below_bet_now", strongContact: true });

const snap = computeHrRadarShadowSnapshot();

console.log("totals + volume");
assert("5 signals observed", snap.totals.signalsObserved === 5, `got ${snap.totals.signalsObserved}`);
assert("2 games observed", snap.totals.gamesObserved === 2, `got ${snap.totals.gamesObserved}`);
assert("1 cashed", snap.totals.cashed === 1, `got ${snap.totals.cashed}`);
assert("2 missed", snap.totals.missed === 2, `got ${snap.totals.missed}`);
approx("signalsPerGame = 2.5", snap.signalsPerGame, 2.5);
approx("hrsCapturedPerGame = 0.5", snap.hrsCapturedPerGame, 0.5);

console.log("\nprecision — ready vs fire hit rate");
approx("readyHitRate = 1/3", snap.readyHitRate, 1 / 3, 1e-3);
approx("fireHitRate = 1/2", snap.fireHitRate, 0.5);
assert("fire outperforms ready", snap.fireOutperformsReady === true);
approx("readyToFireConversion = 2/3", snap.readyToFireConversion, 2 / 3, 1e-3);

console.log("\nfalse-positive rate by bridge path");
const byPath = Object.fromEntries(snap.falsePositiveRateByPath.map(p => [p.path, p]));
approx("PATH_F false-positive rate = 1.0", byPath[PF]?.falsePositiveRate ?? null, 1.0);
approx("PATH_A false-positive rate = 0.0", byPath[PA]?.falsePositiveRate ?? null, 0.0);
assert("worst path sorted first is PATH_F", snap.falsePositiveRateByPath[0]?.path === PF, snap.falsePositiveRateByPath[0]?.path);

console.log("\nrecall — missed HR with prior stage");
assert("1 missed HR had a prior stage", snap.missedHrWithPriorStage === 1, `got ${snap.missedHrWithPriorStage}`);

console.log("\nper-signal records");
const recs = Object.fromEntries(computeHrRadarShadowRecords().map(r => [`${r.gameId}:${r.playerId}`, r]));
assert("S1 hitHr=true, falsePositive=false", recs["G1:p1"]?.hitHr === true && recs["G1:p1"]?.falsePositive === false);
assert("S2 falsePositive=true, becameFire=false", recs["G1:p2"]?.falsePositive === true && recs["G1:p2"]?.becameFire === false);
assert("S3 falsePositive=true, becameFire=true", recs["G1:p3"]?.falsePositive === true && recs["G1:p3"]?.becameFire === true);
assert("S4 unresolved → falsePositive=false", recs["G2:p4"]?.falsePositive === false);
assert("S1 carries signalPath PATH_A", recs["G1:p1"]?.signalPath === PA, recs["G1:p1"]?.signalPath);
assert("S1 score10 captured (9.2)", recs["G1:p1"]?.score10 === 9.2, String(recs["G1:p1"]?.score10));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
process.exit(0);
