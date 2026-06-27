/**
 * HR Radar Live v2 Shadow — scoring/normalization helper invariants.
 *
 * Locks: normalizer bounds/shape, real-data scorers compute from real fields,
 * missing data → null (never optimistic), and strict-null scorers return null
 * today (no proxies).
 *
 * Run: npx tsx server/mlb/hrRadarAdvancedScoring.test.ts
 */

import {
  clamp01,
  clampScore100,
  gaussianPeakScore,
  scoreBarrelQuality,
  scoreCommandDeterioration,
  scoreContactGeometry,
  scoreCountLeverage,
  scoreDataQuality,
  scoreDistance,
  scoreDriverCalibration,
  scoreExitVelocity,
  scoreFreshnessDecay,
  scoreGameStateAttack,
  scoreLaunchAngle,
  scoreLiveSwingTrend,
  scoreMarketConfirmation,
  scoreNearHrGeometry,
  scoreParkGeometryFit,
  scorePitchTypeDamage,
  scorePitcherDeterioration,
  scorePitcherPitchTypeVulnerability,
  scorePullAirIntent,
  scoreSimilarityMatchup,
  scoreSwingDecisionForm,
  scoreUmpCatcherContext,
  scoreWindSprayFit,
  scoreZoneMistakeRisk,
  sigmoidScore,
} from "./hrRadarAdvancedScoring";
import type { V2ContactEvidence } from "./hrRadarV2Types";

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
const inRange01 = (v: number | null) => v != null && v >= 0 && v <= 1;

console.log("\n=== HR Radar v2 — Advanced Scoring Helpers ===\n");

// ── Normalizers ─────────────────────────────────────────────────────────────
console.log("1. Normalizers");
assert("1.1 sigmoid midpoint = 0.5", Math.abs(sigmoidScore(100, 100, 4) - 0.5) < 1e-9);
assert("1.2 sigmoid monotonic increasing", sigmoidScore(104, 100, 4) > sigmoidScore(96, 100, 4));
assert("1.3 sigmoid bounded 0..1", inRange01(sigmoidScore(999, 100, 4)) && inRange01(sigmoidScore(-999, 100, 4)));
assert("1.4 gaussian peaks at peak", Math.abs(gaussianPeakScore(27, 27, 9) - 1) < 1e-9);
assert("1.5 gaussian falls off symmetrically", gaussianPeakScore(27, 27, 9) > gaussianPeakScore(40, 27, 9));
assert("1.6 clamp01 bounds", clamp01(-5) === 0 && clamp01(5) === 1 && clamp01(0.3) === 0.3);
assert("1.7 clampScore100 bounds", clampScore100(-5) === 0 && clampScore100(150) === 100 && clampScore100(73) === 73);
assert("1.8 clamp handles NaN", clamp01(NaN) === 0 && clampScore100(NaN) === 0);

// ── Real-data scorers: null on missing, monotonic on real ───────────────────
console.log("\n2. Real-data scorers");
assert("2.1 scoreExitVelocity null on null", scoreExitVelocity(null) === null);
assert("2.2 scoreExitVelocity monotonic", (scoreExitVelocity(106) as number) > (scoreExitVelocity(94) as number));
assert("2.3 scoreLaunchAngle null on null", scoreLaunchAngle(null) === null);
assert("2.4 scoreLaunchAngle peaks ~27", (scoreLaunchAngle(27) as number) > (scoreLaunchAngle(5) as number));
assert("2.5 scoreDistance null on null", scoreDistance(undefined) === null);
assert("2.6 scoreDistance monotonic", (scoreDistance(410) as number) > (scoreDistance(330) as number));
assert("2.7 scoreBarrelQuality null without any data", scoreBarrelQuality(null, null, null) === null);
assert("2.8 scoreBarrelQuality barrel floors high", (scoreBarrelQuality(true, null, null) as number) >= 0.85);

const strongEvidence: V2ContactEvidence[] = [
  { abIndex: 0, ev: 95, la: 18, distance: 330, xba: 0.4, isBarrel: false, outcome: "out" },
  { abIndex: 1, ev: 106, la: 27, distance: 405, xba: 0.78, isBarrel: true, outcome: "out" },
];
assert("2.9 scoreContactGeometry null on empty", scoreContactGeometry([]) === null);
assert("2.10 scoreContactGeometry high on barrel", (scoreContactGeometry(strongEvidence) as number) > 0.6);
assert("2.11 scoreContactGeometry in 0..1", inRange01(scoreContactGeometry(strongEvidence)));

assert("2.12 scoreNearHrGeometry null on null", scoreNearHrGeometry(null) === null);
assert("2.13 scoreNearHrGeometry lean > watch", (scoreNearHrGeometry("lean") as number) > (scoreNearHrGeometry("watch") as number));
assert("2.14 scoreNearHrGeometry repeatedDanger lifts watch", (scoreNearHrGeometry("watch", true) as number) > (scoreNearHrGeometry("watch", false) as number));

assert("2.15 scoreLiveSwingTrend null with <2 EVs", scoreLiveSwingTrend([strongEvidence[0]]) === null);
const rising: V2ContactEvidence[] = [
  { abIndex: 0, ev: 90, la: 20, distance: 300, xba: 0.3, isBarrel: false, outcome: "out" },
  { abIndex: 1, ev: 92, la: 22, distance: 320, xba: 0.35, isBarrel: false, outcome: "out" },
  { abIndex: 2, ev: 101, la: 25, distance: 380, xba: 0.6, isBarrel: false, outcome: "out" },
  { abIndex: 3, ev: 104, la: 26, distance: 395, xba: 0.7, isBarrel: false, outcome: "out" },
];
const falling = [...rising].reverse().map((e, i) => ({ ...e, abIndex: i }));
assert("2.16 scoreLiveSwingTrend rising > 0.5", (scoreLiveSwingTrend(rising) as number) > 0.5);
assert("2.17 scoreLiveSwingTrend falling < 0.5", (scoreLiveSwingTrend(falling) as number) < 0.5);

assert("2.18 scoreFreshnessDecay null without inputs", scoreFreshnessDecay({}) === null);
const fresh = scoreFreshnessDecay({ latestEvidenceAtIso: "2026-06-26T20:00:00Z", referenceTimeIso: "2026-06-26T20:00:30Z" });
const stale = scoreFreshnessDecay({ latestEvidenceAtIso: "2026-06-26T20:00:00Z", referenceTimeIso: "2026-06-26T20:25:00Z" });
assert("2.19 fresh > stale", (fresh as number) > (stale as number));
assert("2.20 fresh near 1", (fresh as number) > 0.9 && (fresh as number) <= 1);
assert("2.21 freshness inning fallback works", scoreFreshnessDecay({ latestEvidenceInning: 3, currentInning: 7 }) != null);

assert("2.22 scoreDataQuality null on empty", scoreDataQuality([]) === null);
assert("2.23 scoreDataQuality full = 1", scoreDataQuality(strongEvidence) === 1);
assert(
  "2.24 scoreDataQuality partial < 1",
  (scoreDataQuality([{ abIndex: 0, ev: 100, la: null, distance: null, xba: null, isBarrel: false, outcome: null }]) as number) < 1,
);

// ── Conditional real scorers (null without their real inputs) ───────────────
console.log("\n3. Conditional real scorers");
assert("3.1 scorePitcherDeterioration null without data", scorePitcherDeterioration(null) === null);
assert("3.2 scorePitcherDeterioration value with data", inRange01(scorePitcherDeterioration({ pitchCount: 95, isCollapsing: true })));
assert("3.3 scoreCountLeverage null without count", scoreCountLeverage(null) === null);
assert("3.4 scoreCountLeverage hitter count high", (scoreCountLeverage({ balls: 3, strikes: 0 }) as number) > (scoreCountLeverage({ balls: 0, strikes: 2 }) as number));
assert("3.5 scoreGameStateAttack null without data", scoreGameStateAttack(null) === null);
assert("3.6 scoreSwingDecisionForm null without data", scoreSwingDecisionForm(null) === null);

// ── Strict-null scorers (no proxies — null today) ───────────────────────────
console.log("\n4. Strict-null scorers (no proxies)");
const strictNull: Array<[string, (d?: unknown) => number | null]> = [
  ["scorePitchTypeDamage", scorePitchTypeDamage],
  ["scorePitcherPitchTypeVulnerability", scorePitcherPitchTypeVulnerability],
  ["scoreZoneMistakeRisk", scoreZoneMistakeRisk],
  ["scorePullAirIntent", scorePullAirIntent],
  ["scoreParkGeometryFit", scoreParkGeometryFit],
  ["scoreWindSprayFit", scoreWindSprayFit],
  ["scoreCommandDeterioration", scoreCommandDeterioration],
  ["scoreMarketConfirmation", scoreMarketConfirmation],
  ["scoreDriverCalibration", scoreDriverCalibration],
  ["scoreUmpCatcherContext", scoreUmpCatcherContext],
  ["scoreSimilarityMatchup", scoreSimilarityMatchup],
];
for (const [name, fn] of strictNull) {
  assert(`4.x ${name} null with no data`, fn(null) === null && fn(undefined) === null);
}

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
