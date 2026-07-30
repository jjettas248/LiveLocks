// Mound Radar V2 (shadow) distributional engine — invariants.
//
// Covers the Mound V2 test requirements: OVER/UNDER/push sum correctly,
// integer-line push behavior, half-line behavior, low expected batters
// faced, pitch-count/pull-risk adjustment, and missing-lineup-input
// handling. A separate structural check (grep, not a unit test — see the
// verification pass) confirms this directory has zero production Mound
// import edges, so "primary market remains frozen" and "non-public outcomes
// never receive public Cashed treatment" hold trivially: this engine has no
// primaryMarket field and no settlement/grading concept at all.
//
// Run: npx tsx server/mlb/pregame/mound/v2/moundV2Engine.test.ts

import { computeMoundV2Distribution } from "./moundV2Engine";
import { LEAGUE_K_RATE } from "./batterStrikeoutProbability";
import type { MoundV2Inputs, MoundV2BatterInput } from "./moundV2Types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function nineBatters(probs: number[]): MoundV2BatterInput[] {
  return probs.map((p, i) => ({ playerId: `batter_${i + 1}`, battingOrderSlot: i + 1, strikeoutProbability: p }));
}

function baseInputs(overrides: Partial<MoundV2Inputs> = {}): MoundV2Inputs {
  return {
    pitcherId: "pitcher_1",
    workload: {
      avgInningsPerStart: 6.0,
      ipVarianceLast3: 1.0,
      lastStartPitchCount: 95,
      lastStartInningsPitched: 6,
      bbPer9: 3.0,
    },
    batters: nineBatters([0.22, 0.28, 0.30, 0.25, 0.20, 0.18, 0.24, 0.19, 0.15]),
    strikeoutsLine: 5.5,
    outsLine: 18,
    ...overrides,
  };
}

// ── OVER + UNDER + PUSH sum correctly (both markets) ────────────────────────
{
  const dist = computeMoundV2Distribution(baseInputs());
  const kTotal = dist.strikeouts.overProbability + dist.strikeouts.underProbability + dist.strikeouts.pushProbability;
  const outsTotal = dist.outs.overProbability + dist.outs.underProbability + dist.outs.pushProbability;
  ok(approx(kTotal, 1, 1e-6), `strikeouts over+under+push sums to 1 (got ${kTotal})`);
  ok(approx(outsTotal, 1, 1e-6), `outs over+under+push sums to 1 (got ${outsTotal})`);
  ok(dist.strikeouts.expectedValue > 0, "strikeouts expected value is positive");
  ok(dist.outs.expectedValue > 0, "outs expected value is positive");
}

// ── Integer-line push behavior ──────────────────────────────────────────────
{
  const dist = computeMoundV2Distribution(baseInputs({ strikeoutsLine: 6, outsLine: 18 }));
  ok(dist.strikeouts.pushProbability > 0, `an integer strikeouts line (6) has nonzero push probability (got ${dist.strikeouts.pushProbability})`);
  ok(dist.outs.pushProbability > 0, `an integer outs line (18) has nonzero push probability (got ${dist.outs.pushProbability})`);
}

// ── Half-line behavior: never a push ────────────────────────────────────────
{
  const dist = computeMoundV2Distribution(baseInputs({ strikeoutsLine: 5.5, outsLine: 17.5 }));
  ok(dist.strikeouts.pushProbability === 0, "a half-integer strikeouts line has exactly zero push probability");
  ok(dist.outs.pushProbability === 0, "a half-integer outs line has exactly zero push probability");
}

// ── No line supplied: over/under/push all zero, expectedValue still real ───
{
  const dist = computeMoundV2Distribution(baseInputs({ strikeoutsLine: null, outsLine: null }));
  ok(dist.strikeouts.line === null && dist.outs.line === null, "line is null when none was supplied");
  ok(
    dist.strikeouts.overProbability === 0 && dist.strikeouts.underProbability === 0 && dist.strikeouts.pushProbability === 0,
    "no line supplied yields all-zero over/under/push rather than a fabricated split",
  );
  ok(dist.strikeouts.expectedValue > 0, "expectedValue is still computed from the real PMF even with no line");
}

// ── Low expected batters faced (short-outing profile) still produces a sane distribution ──
{
  const dist = computeMoundV2Distribution(
    baseInputs({
      workload: { avgInningsPerStart: 1.2, ipVarianceLast3: 0.2, lastStartPitchCount: 30, lastStartInningsPitched: 1.2, bbPer9: 3.5 },
      strikeoutsLine: 2.5,
      outsLine: 4.5,
    }),
  );
  ok(dist.diagnostics.expectedBattersFaced < 10, `a 1.2-inning-average profile has a low expected batters-faced (got ${dist.diagnostics.expectedBattersFaced.toFixed(2)})`);
  const kTotal = dist.strikeouts.overProbability + dist.strikeouts.underProbability + dist.strikeouts.pushProbability;
  ok(approx(kTotal, 1, 1e-6), "a low-batters-faced profile's strikeout market still sums to 1");
  ok(dist.strikeouts.expectedValue < 3, `expected strikeouts is low for a short-outing profile (got ${dist.strikeouts.expectedValue.toFixed(2)})`);
}

// ── Pitch-count / pull-risk adjustment carries through to the final distribution ──
{
  const efficient = computeMoundV2Distribution(
    baseInputs({ workload: { avgInningsPerStart: 6.0, ipVarianceLast3: 1.0, lastStartPitchCount: 85, lastStartInningsPitched: 7, bbPer9: 2.0 } }),
  );
  const inefficient = computeMoundV2Distribution(
    baseInputs({ workload: { avgInningsPerStart: 6.0, ipVarianceLast3: 1.0, lastStartPitchCount: 112, lastStartInningsPitched: 5, bbPer9: 5.2 } }),
  );
  ok(
    inefficient.strikeouts.expectedValue < efficient.strikeouts.expectedValue,
    `a high-pitch-count/high-walk profile projects fewer expected strikeouts (${inefficient.strikeouts.expectedValue.toFixed(2)}) than an efficient one (${efficient.strikeouts.expectedValue.toFixed(2)}) holding avgInningsPerStart constant`,
  );
}

// ── Missing lineup inputs (empty batters array) degrades gracefully ────────
{
  const dist = computeMoundV2Distribution(baseInputs({ batters: [] }));
  ok(dist.diagnostics.dataAvailable === false, "dataAvailable is false with an empty batters array");
  ok(dist.diagnostics.battersInLineup === 0, "battersInLineup reports 0");
  const kTotal = dist.strikeouts.overProbability + dist.strikeouts.underProbability + dist.strikeouts.pushProbability;
  ok(approx(kTotal, 1, 1e-6), "an empty lineup still yields a valid, sum-to-1 distribution using the league-average fallback rather than throwing or fabricating a confident split");
  ok(approx(dist.strikeouts.expectedValue, dist.diagnostics.expectedBattersFaced * LEAGUE_K_RATE, 0.5),
    "an empty lineup's expected strikeouts is close to expectedBattersFaced * league K rate");
}

// ── Partial lineup (fewer than 9 confirmed batters) does not throw ─────────
{
  const dist = computeMoundV2Distribution(baseInputs({ batters: nineBatters([0.30, 0.25, 0.20]) }));
  ok(dist.diagnostics.battersInLineup === 3, "battersInLineup reflects a partial (3-batter) lineup");
  const kTotal = dist.strikeouts.overProbability + dist.strikeouts.underProbability + dist.strikeouts.pushProbability;
  ok(approx(kTotal, 1, 1e-6), "a partial lineup still produces a valid, sum-to-1 distribution (cycles through the confirmed batters)");
}

// ── This module never imports production Mound (structural isolation) ──────
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const productionModules = [
    "scoring", "moundDirection", "moundOutcomeAttribution", "evaluationSnapshot",
    "moundGradedStateCarry", "mlbMoundRadarStore", "moundPersistence", "buildMlbMoundRadar",
  ];
  const v2Files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  let clean = true;
  for (const file of v2Files) {
    const contents = fs.readFileSync(path.join(dir, file), "utf-8");
    for (const prod of productionModules) {
      if (new RegExp(`from\\s+["'].*${prod}["']`).test(contents)) {
        clean = false;
        console.error(`  ✗ ${file} imports production module "${prod}"`);
      }
    }
  }
  ok(clean, "no file under mound/v2/ imports any production Mound scoring/direction/settlement/persistence module");
}

// ── Joint coherence end-to-end: strikeouts <= outs <= batters faced ─────────
// The actual defect Part 2 fixes: strikeouts and outs used to be two
// INDEPENDENT negative binomials with no joint relationship at all.
{
  const scenarios: MoundV2Inputs[] = [
    baseInputs(),
    baseInputs({ workload: { avgInningsPerStart: 1.2, ipVarianceLast3: 0.2, lastStartPitchCount: 30, lastStartInningsPitched: 1.2, bbPer9: 3.5 } }),
    baseInputs({ workload: { avgInningsPerStart: 8.0, ipVarianceLast3: 2.0, lastStartPitchCount: 105, lastStartInningsPitched: 8, bbPer9: 1.8 } }),
    baseInputs({ batters: [] }),
    baseInputs({ batters: nineBatters([0.35, 0.32, 0.30, 0.28, 0.26, 0.24, 0.22, 0.20, 0.18]) }),
  ];
  for (const [i, scenario] of scenarios.entries()) {
    const dist = computeMoundV2Distribution(scenario);
    ok(
      dist.strikeouts.expectedValue <= dist.outs.expectedValue + 1e-6,
      `scenario ${i}: expected strikeouts (${dist.strikeouts.expectedValue.toFixed(3)}) never exceeds expected outs (${dist.outs.expectedValue.toFixed(3)})`,
    );
    ok(
      dist.outs.expectedValue <= dist.diagnostics.expectedBattersFaced + 1e-6,
      `scenario ${i}: expected outs (${dist.outs.expectedValue.toFixed(3)}) never exceeds expected batters faced (${dist.diagnostics.expectedBattersFaced.toFixed(3)})`,
    );
    // Support-level check, not just expected values: no strikeout PMF mass
    // beyond what the outs PMF's own support could coherently produce.
    const maxOutsWithMass = dist.outsPmf.reduce((max, p, k) => (p > 1e-9 ? k : max), 0);
    const maxStrikeoutsWithMass = dist.strikeoutsPmf.reduce((max, p, k) => (p > 1e-9 ? k : max), 0);
    ok(
      maxStrikeoutsWithMass <= maxOutsWithMass,
      `scenario ${i}: the highest strikeout count with real probability mass (${maxStrikeoutsWithMass}) does not exceed the highest outs count with real mass (${maxOutsWithMass})`,
    );
  }
}

console.log(`\nmoundV2Engine.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
