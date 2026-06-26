// Pre-Game Power Radar — v2 SHADOW PA distribution + game HR probability.
// Run: npx tsx server/mlb/pregamePowerRadar/math/paAndGameProbability.test.ts

import { estimatePregamePaDistribution, expectedPaForSlot } from "./estimatePregamePaDistribution";
import { gameHrProbability, gameHrProbabilityForPaCount } from "./gameHrProbability";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 1e-9) { return Math.abs(a - b) <= eps; }

// ── PA distribution sums to ~1 for every slot ─────────────────────────────────
for (let slot = 1; slot <= 9; slot++) {
  const { distribution, expectedPA } = estimatePregamePaDistribution({ battingOrderSlot: slot });
  const sum = Object.values(distribution).reduce((a, b) => a + b, 0);
  ok(approx(sum, 1, 1e-9), `slot ${slot} distribution sums to 1 (got ${sum})`);
  ok(expectedPA > 3 && expectedPA < 5.2, `slot ${slot} expectedPA plausible (${expectedPA.toFixed(2)})`);
}

// ── Null slot still yields a valid distribution ───────────────────────────────
const nullSlot = estimatePregamePaDistribution({ battingOrderSlot: null });
ok(approx(Object.values(nullSlot.distribution).reduce((a, b) => a + b, 0), 1), "null slot sums to 1");

// ── Top of order sees more PA than bottom ─────────────────────────────────────
ok(expectedPaForSlot(1) > expectedPaForSlot(9), "leadoff > #9 expected PA");
const lead = estimatePregamePaDistribution({ battingOrderSlot: 1 }).expectedPA;
const tail = estimatePregamePaDistribution({ battingOrderSlot: 9 }).expectedPA;
ok(lead > tail, "slot-1 expectedPA > slot-9 expectedPA");

// ── Run environment nudges mean up ────────────────────────────────────────────
const lowRuns = estimatePregamePaDistribution({ battingOrderSlot: 4, teamImpliedRuns: 3.3 }).expectedPA;
const highRuns = estimatePregamePaDistribution({ battingOrderSlot: 4, teamImpliedRuns: 5.8 }).expectedPA;
ok(highRuns > lowRuns, "higher implied runs → higher expected PA");

// ── Game HR probability monotonic in PA count ─────────────────────────────────
const p = 0.05;
let prev = -1;
for (let n = 1; n <= 6; n++) {
  const g = gameHrProbabilityForPaCount(p, n);
  ok(g > prev, `gameHrProb increases with PA count (n=${n}, ${g.toFixed(4)})`);
  ok(g >= 0 && g <= 1, `gameHrProb bounded (n=${n})`);
  prev = g;
}

// ── Game HR probability monotonic in per-PA rate ──────────────────────────────
const dist = estimatePregamePaDistribution({ battingOrderSlot: 3 }).distribution;
ok(gameHrProbability(0.02, dist) < gameHrProbability(0.08, dist), "gameHrProb increases with hrPerPa");
ok(gameHrProbability(0.12, dist) <= 1 && gameHrProbability(0.12, dist) >= 0, "gameHrProb bounded over dist");

// ── Edge cases: null/zero ─────────────────────────────────────────────────────
ok(gameHrProbability(null, dist) === 0, "null hrPerPa → 0");
ok(gameHrProbability(0.05, null) === 0, "null distribution → 0");
ok(gameHrProbabilityForPaCount(0.05, 0) === 0, "0 PA → 0");

// ── Independence approximation sanity: P(HR) ≈ 1-(1-p)^E[PA] order of magnitude ─
const g4 = gameHrProbabilityForPaCount(0.04, 4);
ok(approx(g4, 1 - Math.pow(0.96, 4), 1e-9), "closed form matches 1-(1-p)^n");

console.log(`\npaAndGameProbability.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
