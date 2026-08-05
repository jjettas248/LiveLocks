// Run: npx tsx server/engines/nbaPregame/decision/lineProbabilities.test.ts
// Pregame Targets PR4 — coherent line probabilities: integer-line push, half-line
// zero-push, OVER/UNDER complementarity, pNoPushWin denominator behavior,
// tail-folded PMF boundary, opposite sides from ONE shared PMF (never contradictory).
import { computeLineProbabilities, lineProbabilitiesAreCoherent } from "./lineProbabilities";
import { negativeBinomialPmf, normalizePmf } from "../math/pmf";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// A simple normalized PMF over 0..5: [0.1,0.2,0.3,0.2,0.15,0.05]
const PMF = [0.1, 0.2, 0.3, 0.2, 0.15, 0.05];

// ── Integer line preserves explicit push mass ───────────────────────────────
{
  const lp = computeLineProbabilities(PMF, 2); // push = pmf[2] = 0.3
  ok(lp.isIntegerLine, "line 2 recognized as integer");
  ok(approx(lp.pPush, 0.3), "integer line push = pmf[line]");
  ok(approx(lp.pUnder, 0.1 + 0.2), "under = mass strictly below the line");
  ok(approx(lp.pOver, 0.2 + 0.15 + 0.05), "over = mass strictly above the line");
  ok(approx(lp.pOver + lp.pUnder + lp.pPush, 1), "over+under+push = 1 (integer)");
}

// ── Half line → zero push, complementary over/under ─────────────────────────
{
  const lp = computeLineProbabilities(PMF, 2.5);
  ok(!lp.isIntegerLine, "line 2.5 recognized as half line");
  ok(lp.pPush === 0, "half line push = 0 exactly");
  ok(approx(lp.pUnder, 0.1 + 0.2 + 0.3), "under = P(k ≤ 2)");
  ok(approx(lp.pOver, 0.2 + 0.15 + 0.05), "over = P(k ≥ 3)");
  ok(approx(lp.pOver + lp.pUnder, 1), "over+under = 1 (half line, no push)");
}

// ── OVER/UNDER complementarity from ONE shared PMF (never contradictory) ─────
{
  for (const line of [0.5, 1, 1.5, 2, 3, 3.5, 4]) {
    const lp = computeLineProbabilities(PMF, line);
    ok(approx(lp.pOver + lp.pUnder + lp.pPush, 1), `line ${line}: over+under+push = 1`);
    ok(lineProbabilitiesAreCoherent(lp), `line ${line}: coherent`);
    // Opposite sides are complements, not independently estimated.
    ok(lp.pOver >= 0 && lp.pUnder >= 0 && lp.pPush >= 0, `line ${line}: non-negative`);
  }
}

// ── pNoPushWin: denominator = 1 − pPush; the pair sums to 1 ──────────────────
{
  const lp = computeLineProbabilities(PMF, 2); // pPush 0.3, decidable 0.7
  ok(approx(lp.pNoPushWinOver, lp.pOver / 0.7), "no-push OVER = pOver/(1−pPush)");
  ok(approx(lp.pNoPushWinUnder, lp.pUnder / 0.7), "no-push UNDER = pUnder/(1−pPush)");
  ok(approx(lp.pNoPushWinOver + lp.pNoPushWinUnder, 1), "no-push OVER+UNDER = 1");
  // Half line: no push, so no-push win == raw over/under.
  const half = computeLineProbabilities(PMF, 2.5);
  ok(approx(half.pNoPushWinOver, half.pOver) && approx(half.pNoPushWinUnder, half.pUnder), "no push ⇒ no-push win == raw");
}

// ── pNoPushWin degenerate denominator: a fully-push PMF ──────────────────────
{
  // All mass at exactly 3; integer line 3 → pPush = 1, decidable = 0.
  const pointMass = [0, 0, 0, 1, 0, 0];
  const lp = computeLineProbabilities(pointMass, 3);
  ok(approx(lp.pPush, 1), "point-mass integer line → push = 1");
  ok(lp.pNoPushWinOver === 0 && lp.pNoPushWinUnder === 0, "zero decidable mass → no-push wins are 0 (documented degenerate)");
  ok(lineProbabilitiesAreCoherent(lp), "fully-push case still reported coherent");
}

// ── Tail-folded PMF boundary behavior ───────────────────────────────────────
{
  // Build an NB PMF truncated to 0..10 (index 10 = folded tail ≥10).
  const pmf = normalizePmf(negativeBinomialPmf(6, 12, 40), 10); // length 11, last = folded
  const lastIndex = pmf.length - 1; // 10
  // A line strictly below the folded bucket is resolvable and coherent.
  const inSupport = computeLineProbabilities(pmf, 7.5);
  ok(inSupport.resolvable, "line below folded tail is resolvable");
  ok(approx(inSupport.pOver + inSupport.pUnder + inSupport.pPush, 1), "in-support line stays coherent");
  // A half line just below the folded bucket: over = the folded atom only.
  const atEdge = computeLineProbabilities(pmf, lastIndex - 0.5); // 9.5
  ok(atEdge.resolvable, "half line at lastIndex−0.5 resolvable");
  ok(approx(atEdge.pOver, pmf[lastIndex]), "over at the edge = the folded tail atom");
  // An integer line AT the folded bucket is NOT resolvable (its mass is ≥maxK, not exactly maxK).
  const onFold = computeLineProbabilities(pmf, lastIndex); // 10
  ok(!onFold.resolvable, "integer line on the folded tail bucket is NOT resolvable");
  // A line beyond support is not resolvable either.
  const beyond = computeLineProbabilities(pmf, lastIndex + 0.5);
  ok(!beyond.resolvable, "line beyond the folded tail is not resolvable");
}

// ── Fail closed on a corrupt PMF (impossible state) ─────────────────────────
{
  ok(throws(() => computeLineProbabilities([], 1)), "empty PMF throws");
  ok(throws(() => computeLineProbabilities([0.5, 0.6], 0.5)), "non-normalized PMF throws");
  ok(throws(() => computeLineProbabilities(PMF, NaN)), "non-finite line throws");
}

// ── Determinism ─────────────────────────────────────────────────────────────
{
  const a = computeLineProbabilities(PMF, 2);
  const b = computeLineProbabilities(PMF, 2);
  ok(JSON.stringify(a) === JSON.stringify(b), "deterministic");
}

console.log(`\nlineProbabilities.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
