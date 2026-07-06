// Mound Radar — Projected Ks / settlement-baseline consistency invariants.
//
// Regression guard for a real drift bug: the "🎯 Projected Ks" number shown
// on a Mound card (buildMlbMoundRadar.ts) and the number that actually
// decides win/loss grading (moundOutcomeAttribution.ts) used to be computed
// by two different formulas (real avg-innings-per-start vs a fixed 6-inning
// assumption). Both now call the same shared scoreUtils.ts function
// (projectedStrikeoutsFromKPer9) — this test pins that they can never
// silently diverge again.
// Run: npx tsx server/mlb/pregame/mound/moundProjectionConsistency.test.ts

import { projectedStrikeoutsFromKPer9, seasonKPer9ToPerStartExpectation, round1 } from "./scoreUtils";
import { deriveMoundOutcome } from "./moundOutcomeAttribution";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── projectedStrikeoutsFromKPer9 matches the raw formula, rounded ────────────
for (const kPer9 of [6.5, 8.0, 9.0, 9.87, 11.2]) {
  const expected = round1(seasonKPer9ToPerStartExpectation(kPer9));
  ok(
    projectedStrikeoutsFromKPer9(kPer9) === expected,
    `projectedStrikeoutsFromKPer9(${kPer9}) === round1(seasonKPer9ToPerStartExpectation(${kPer9})) (got ${projectedStrikeoutsFromKPer9(kPer9)}, expected ${expected})`,
  );
}

ok(projectedStrikeoutsFromKPer9(null) === null, "null kPer9 → null projection, never fabricated");
ok(projectedStrikeoutsFromKPer9(undefined) === null, "undefined kPer9 → null projection");

// ── The displayed projection is bit-for-bit identical to the settlement baseline ──
// This is the actual bug this test guards against: buildMlbMoundRadar.ts's
// projectedStrikeouts must equal moundOutcomeAttribution.ts's
// seasonBaselineValue for the same pitcher/kPer9 — not just "close".
for (const kPer9 of [6.5, 8.0, 9.0, 9.87, 11.2]) {
  const displayedProjection = projectedStrikeoutsFromKPer9(kPer9);
  const { seasonBaselineValue } = deriveMoundOutcome({
    primaryMarket: "pitcher_strikeouts",
    finalStrikeouts: null,
    finalOutsRecorded: null,
    seasonKPer9: kPer9,
    seasonAvgInningsPerStart: null,
    wasPubliclyFlagged: true,
  });
  ok(
    displayedProjection === seasonBaselineValue,
    `displayed Projected Ks (${displayedProjection}) === settlement baseline (${seasonBaselineValue}) for kPer9=${kPer9}`,
  );
}

console.log(`\nmoundProjectionConsistency.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
