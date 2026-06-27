/**
 * HR Radar Live v2 Shadow — advanced-context boost (no hidden optimism).
 *
 * Locks: neutral → 0 boost, missing → excluded & NOT renormalized, weak →
 * negative, strong → positive, clamp bounds, and that buildAdvancedContext
 * is fully null today (no proxies) with a populated inventory.
 *
 * Run: npx tsx server/mlb/hrRadarAdvancedContext.test.ts
 */

import {
  ADVANCED_BOOST_MAX_POINTS,
  ADVANCED_BOOST_MIN_POINTS,
  buildAdvancedContext,
  computeAdvancedBoostPoints,
} from "./hrRadarAdvancedContext";
import type { HRRadarV2Input } from "./hrRadarV2Types";

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

const ALL_KEYS = [
  "batterPitchTypeDamageScore",
  "pitcherPitchTypeVulnerabilityScore",
  "zoneMistakeRiskScore",
  "pullAirIntentScore",
  "parkGeometryFitScore",
  "windSprayFitScore",
  "commandDeteriorationScore",
  "countLeverageScore",
  "gameStateAttackScore",
  "swingDecisionFormScore",
  "marketConfirmationScore",
  "driverCalibrationBoost",
] as const;

function allAt(v: number): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of ALL_KEYS) o[k] = v;
  return o;
}

console.log("\n=== HR Radar v2 — Advanced Context (no hidden optimism) ===\n");

// 1. Neutral → exactly 0
console.log("1. Neutral components");
const neutral = computeAdvancedBoostPoints(allAt(0.5));
assert("1.1 all-neutral boost == 0", Math.abs(neutral.boostPoints) < 1e-9, `got ${neutral.boostPoints}`);
assert("1.2 all-neutral counts all available", neutral.availableComponentCount === ALL_KEYS.length);

// 2. Missing → excluded, not renormalized
console.log("\n2. Missing components excluded (not renormalized)");
const none = computeAdvancedBoostPoints({});
assert("2.1 all-missing boost == 0", none.boostPoints === 0);
assert("2.2 all-missing availableComponentCount == 0", none.availableComponentCount === 0);
// One strong component alone must give only ITS weighted share — NOT a full
// renormalized swing. zoneMistakeRisk weight 0.13 → 0.13*0.5*35 = 2.275.
const oneStrong = computeAdvancedBoostPoints({ zoneMistakeRiskScore: 1.0 });
assert("2.3 single strong component is small (no renormalization)", oneStrong.boostPoints > 2 && oneStrong.boostPoints < 2.6, `got ${oneStrong.boostPoints}`);
assert("2.4 single strong availableCount == 1", oneStrong.availableComponentCount === 1);
// Same single component when all others present-but-neutral gives the SAME points.
const oneStrongRestNeutral = computeAdvancedBoostPoints({ ...allAt(0.5), zoneMistakeRiskScore: 1.0 });
assert(
  "2.5 missing vs neutral peers give identical boost (no renormalization)",
  Math.abs(oneStrongRestNeutral.boostPoints - oneStrong.boostPoints) < 1e-9,
  `neutral-peers=${oneStrongRestNeutral.boostPoints} missing-peers=${oneStrong.boostPoints}`,
);

// 3. Weak → negative, strong → positive
console.log("\n3. Direction");
assert("3.1 weak component → negative", computeAdvancedBoostPoints({ zoneMistakeRiskScore: 0.2 }).boostPoints < 0);
assert("3.2 strong component → positive", computeAdvancedBoostPoints({ zoneMistakeRiskScore: 0.8 }).boostPoints > 0);

// 4. Clamp bounds
console.log("\n4. Clamp bounds");
assert("4.1 all-max clamps to +17.5", Math.abs(computeAdvancedBoostPoints(allAt(1.0)).boostPoints - ADVANCED_BOOST_MAX_POINTS) < 1e-9);
assert("4.2 all-min clamps to -12.5", computeAdvancedBoostPoints(allAt(0.0)).boostPoints === ADVANCED_BOOST_MIN_POINTS);

// 5. buildAdvancedContext today: fully null, zero boost, inventory present
console.log("\n5. buildAdvancedContext (live, today)");
const input: HRRadarV2Input = {
  signalId: null,
  gameId: "g1",
  playerId: "p1",
  playerName: "Test Batter",
  currentStage: "build",
  currentScore10: 5.5,
  peakScore10: 6,
  lifecycleState: "build",
  active: true,
  terminal: false,
  hasLiveEvidence: true,
  contactEvidence: [{ abIndex: 0, ev: 104, la: 26, distance: 395, xba: 0.7, isBarrel: true, outcome: "out" }],
  triggerReasons: ["Statcast barrel"],
  triggerTags: ["BARREL_OVERRIDE"],
  detectedInning: 3,
  latestEvidenceInning: 3,
  detectedAtIso: "2026-06-26T20:00:00Z",
  latestEvidenceAtIso: "2026-06-26T20:00:00Z",
  referenceTimeIso: "2026-06-26T20:01:00Z",
  availableStats: ["contact_ev"],
  derivableStats: ["contact_geometry"],
  missingStats: [],
  diagnosticsOnlyStats: ["bvp_history"],
};
const ctx = buildAdvancedContext(input);
assert("5.1 boost == 0 today (all components null)", ctx.advancedContextBoostPoints === 0);
assert("5.2 availableComponentCount == 0 today", ctx.availableComponentCount === 0);
assert("5.3 totalComponentCount == 12", ctx.totalComponentCount === 12);
assert("5.4 all 12 boost components null", ALL_KEYS.every((k) => (ctx as any)[k] === null));
assert("5.5 missingStats populated (future feeds)", ctx.missingStats.length > 0);
assert("5.6 availableStats carried through", ctx.availableStats.includes("contact_ev"));
assert("5.7 diagnosticsOnlyStats carried through", ctx.diagnosticsOnlyStats.includes("bvp_history"));

console.log(`\n=== Result: ${pass} pass, ${fail} fail ===`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
