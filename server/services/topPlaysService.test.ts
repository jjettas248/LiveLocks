/**
 * topPlaysService — qualification/count single-source-of-truth harness.
 *
 * Plain Node.js script (no jest/vitest dependency), matching the existing
 * server/mlb/*.test.ts convention. Run with:
 *
 *   npx tsx server/services/topPlaysService.test.ts
 *
 * Proves buildTopPlays (display, capped+sorted), buildTopPlaysWithCount
 * (single-pass, both outputs), and countQualifiedTopPlays (standalone
 * convenience) all derive from the same qualification decisions — not a
 * same-length coincidence, but a structural guarantee (see
 * buildAllQualifiedPlays in topPlaysService.ts).
 */

import { buildTopPlays, buildTopPlaysWithCount, countQualifiedTopPlays } from "./topPlaysService";

interface TestCase {
  name: string;
  fn: () => void;
}

const cases: TestCase[] = [];
function test(name: string, fn: () => void) {
  cases.push({ name, fn });
}
function assertEq<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) {
    throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// 15 qualifying signals spread across NBA/NCAAB/MLB — every one clears the
// enginePct/probability >= 55 threshold buildAllQualifiedPlays applies.
function buildFixture() {
  const nba = Array.from({ length: 6 }, (_, i) => ({
    playerId: `nba_${i}`,
    playerName: `NBA Player ${i}`,
    gameId: `nbag_${i}`,
    market: "points",
    recommendedSide: "OVER",
    bookLine: 20 + i,
    enginePct: 60 + i,
    edge: 5,
    projection: 22,
  }));
  const ncaab = Array.from({ length: 5 }, (_, i) => ({
    gameId: `ncaabg_${i}`,
    teamName: `NCAAB Team ${i}`,
    market: "total",
    probability: 60 + i,
    edge: 4,
    line: 140 + i,
  }));
  const mlb = Array.from({ length: 4 }, (_, i) => ({
    playerId: `mlb_${i}`,
    playerName: `MLB Player ${i}`,
    gameId: `mlbg_${i}`,
    market: "hits",
    recommendedSide: "OVER",
    bookLine: 1.5,
    enginePct: 60 + i,
    edge: 3,
    signalTier: "strong",
  }));
  return { nba, ncaab, mlb };
}

test("buildTopPlays(..., 10) still applies the display cap — unchanged behavior", () => {
  const { nba, ncaab, mlb } = buildFixture();
  const plays = buildTopPlays(nba, ncaab, mlb, 10);
  assertEq(plays.length, 10, "capped at 10");
});

test("countQualifiedTopPlays reports the TRUE total (15), not capped — reproduces & proves the activeCount-capping fix", () => {
  const { nba, ncaab, mlb } = buildFixture();
  const total = countQualifiedTopPlays(nba, ncaab, mlb);
  assertEq(total, 15, "true qualified total is 15, independent of any display cap");
});

test("same-source-of-truth proof: an uncapped buildTopPlays call produces exactly as many items as countQualifiedTopPlays reports", () => {
  const { nba, ncaab, mlb } = buildFixture();
  // maxPlays=100 far exceeds the 15-item fixture, so nothing gets truncated —
  // if buildTopPlays and countQualifiedTopPlays ever forked their
  // qualification predicates (e.g. a threshold changed in one place but not
  // the other), this assertion is what would catch it.
  const uncapped = buildTopPlays(nba, ncaab, mlb, 100);
  const total = countQualifiedTopPlays(nba, ncaab, mlb);
  assertEq(uncapped.length, total, "uncapped buildTopPlays length matches countQualifiedTopPlays");
});

test("buildTopPlaysWithCount — single call returns both the capped display list AND the true total, in one pass", () => {
  const { nba, ncaab, mlb } = buildFixture();
  const { plays, totalQualified } = buildTopPlaysWithCount(nba, ncaab, mlb, 10);
  assertEq(plays.length, 10, "buildTopPlaysWithCount.plays capped at 10");
  assertEq(totalQualified, 15, "buildTopPlaysWithCount.totalQualified is the true 15");
});

test("buildTopPlaysWithCount.plays matches buildTopPlays's output exactly for the same inputs", () => {
  const { nba, ncaab, mlb } = buildFixture();
  const viaWithCount = buildTopPlaysWithCount(nba, ncaab, mlb, 10).plays;
  const viaBuildTopPlays = buildTopPlays(nba, ncaab, mlb, 10);
  assertEq(JSON.stringify(viaWithCount), JSON.stringify(viaBuildTopPlays), "identical capped/sorted output");
});

// — runner —
let pass = 0;
let fail = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    pass++;
    console.log(`  ✓ ${c.name}`);
  } catch (e: any) {
    fail++;
    failures.push(`  ✗ ${c.name}\n      ${e.message}`);
    console.log(`  ✗ ${c.name}`);
    console.log(`      ${e.message}`);
  }
}
console.log(`\n[topPlaysService] ${pass}/${pass + fail} cases passed`);
if (fail > 0) {
  console.error(`\nFAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
