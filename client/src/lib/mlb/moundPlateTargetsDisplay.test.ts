// Cross-Radar client display-logic invariants.
// Run: npx tsx client/src/lib/mlb/moundPlateTargetsDisplay.test.ts

import { isAllHrRanked, plateTargetsHeading, formatHrScore, plateTargetScoreLabel, plateTierLabel } from "./moundPlateTargetsDisplay";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── field absent / empty array ───────────────────────────────────────────────
ok(isAllHrRanked([]) === false, "empty target list is never 'all HR ranked'");
ok(plateTargetsHeading([]) === "Plate Targets vs This Pitcher", "empty list heading falls back to the generic label");

// ── all-HR list ──────────────────────────────────────────────────────────────
{
  const allHr = [
    { rankingBasis: "home_runs" as const, hrScore: 9.0 },
    { rankingBasis: "home_runs" as const, hrScore: 5.1 },
  ];
  ok(isAllHrRanked(allHr) === true, "every entry HR-ranked with a finite score → true");
  ok(plateTargetsHeading(allHr) === "Plate HR Targets vs This Arm", "all-HR list heading");
}

// ── mixed list (one HR-ranked, one overall-fallback) — must NOT be mislabeled ──
{
  const mixed = [
    { rankingBasis: "home_runs" as const, hrScore: 9.0 },
    { rankingBasis: "overall_fallback" as const, hrScore: null },
    { rankingBasis: "overall_fallback" as const, hrScore: null },
  ];
  ok(isAllHrRanked(mixed) === false, "one overall-fallback entry among HR-ranked entries → not all-HR");
  ok(plateTargetsHeading(mixed) === "Plate Targets vs This Pitcher", "mixed list uses the generic heading, never the HR-specific one");
}

// ── all-fallback list ─────────────────────────────────────────────────────────
{
  const allFallback = [
    { rankingBasis: "overall_fallback" as const, hrScore: null },
    { rankingBasis: "overall_fallback" as const, hrScore: null },
  ];
  ok(isAllHrRanked(allFallback) === false, "all-fallback list is not all-HR");
  ok(plateTargetsHeading(allFallback) === "Plate Targets vs This Pitcher", "all-fallback list uses the generic heading");
}

// ── rankingBasis "home_runs" with null or non-finite hrScore (malformed/older payload) ──
{
  const malformedNull = [{ rankingBasis: "home_runs" as const, hrScore: null }];
  ok(isAllHrRanked(malformedNull) === false, "rankingBasis=home_runs with null hrScore is NOT treated as all-HR (malformed data doesn't get the HR heading)");

  for (const bad of [NaN, Infinity, -Infinity]) {
    const malformed = [{ rankingBasis: "home_runs" as const, hrScore: bad }];
    ok(isAllHrRanked(malformed) === false, `rankingBasis=home_runs with hrScore=${bad} is NOT treated as all-HR`);
  }
}

// ── formatHrScore: safe formatting, no non-null assertion needed ────────────
ok(formatHrScore(8.456) === "8.5", "formatHrScore rounds a real finite number to 1 decimal");
ok(formatHrScore(null) === null, "formatHrScore(null) → null, does not throw");
ok(formatHrScore(undefined) === null, "formatHrScore(undefined) → null, does not throw");
ok(formatHrScore(NaN) === null, "formatHrScore(NaN) → null");
ok(formatHrScore(Infinity) === null, "formatHrScore(Infinity) → null");
ok(formatHrScore(-Infinity) === null, "formatHrScore(-Infinity) → null");

// ── plateTargetScoreLabel: graceful fallback when HR score is malformed despite rankingBasis ──
ok(
  plateTargetScoreLabel({ rankingBasis: "home_runs", hrScore: 7.25, plateScore10: 6.0 }) === "HR Score 7.3",
  "genuine HR-ranked entry renders 'HR Score X.X'",
);
ok(
  plateTargetScoreLabel({ rankingBasis: "overall_fallback", hrScore: null, plateScore10: 6.0 }) === "Plate Score 6.0",
  "overall-fallback entry renders 'Plate Score X.X'",
);
ok(
  plateTargetScoreLabel({ rankingBasis: "home_runs", hrScore: null, plateScore10: 6.0 }) === "Plate Score 6.0",
  "rankingBasis=home_runs but hrScore is null/malformed still degrades to 'Plate Score X.X' instead of crashing or rendering 'undefined'",
);
ok(
  plateTargetScoreLabel({ rankingBasis: "home_runs", hrScore: NaN, plateScore10: 6.0 }) === "Plate Score 6.0",
  "rankingBasis=home_runs with hrScore=NaN degrades to Plate Score",
);

// ── plateTierLabel: known tiers + unknown-tier fallback ──────────────────────
ok(plateTierLabel("power_watch") === "Power Watch", "known tier renders its display label");
ok(plateTierLabel("elite") === "Elite", "known tier 'elite' renders 'Elite'");
ok(plateTierLabel("mystery_tier") === "mystery_tier", "unknown tier value falls back to the raw string rather than throwing");

console.log(`\nmoundPlateTargetsDisplay.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
