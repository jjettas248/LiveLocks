/**
 * [PRIMARY ROI EXCLUSION v1] Validation harness
 *
 * Plain Node.js script (no jest/vitest dependency) — run with:
 *
 *   npx tsx server/services/roiEngine.test.ts
 *
 * Asserts:
 *   1. EXCLUDED_FROM_PRIMARY_ROI contains exactly the canonical market keys
 *      home_runs and batter_strikeouts and is frozen / immutable.
 *   2. isExcludedFromPrimaryRoi() correctly identifies excluded markets and
 *      degrades safely on null/undefined/unknown.
 *   3. filterPrimaryRoiPlays() removes only excluded markets, keeps all
 *      others (incl. unknown / null).
 *   4. getPrimaryROIMetrics() and getROIMetrics() diverge exactly when the
 *      input contains excluded-market plays — and agree otherwise.
 *   5. getRoiByMarket() flags excluded markets via excludedFromPrimary.
 *   6. buildFullROIReport() exposes both `global` (all markets) and
 *      `primary` (filtered) blocks and they reconcile to the helpers.
 *   7. logRoiFilterApplied() emits the [ROI_FILTER_APPLIED] tag with the
 *      expected fields (capturable via console.log spy).
 */

import {
  EXCLUDED_FROM_PRIMARY_ROI,
  isExcludedFromPrimaryRoi,
  filterPrimaryRoiPlays,
  getPrimaryROIMetrics,
  getROIMetrics,
  getRoiByMarket,
  buildFullROIReport,
  logRoiFilterApplied,
} from "./roiEngine";
import type { PersistedPlay } from "@shared/schema";

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
function assertDeep<T>(actual: T, expected: T, ctx: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${ctx}:\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

// Tiny play factory — only the fields roiEngine actually reads. The full
// PersistedPlay type has many irrelevant fields; we cast through `unknown`
// to keep the harness terse but type-safe at the call site.
function play(market: string, result: "hit" | "miss" | "push" | null, opts: { stake?: number; odds?: number } = {}): PersistedPlay {
  return {
    market,
    result,
    stake: opts.stake != null ? String(opts.stake) : null,
    odds: opts.odds != null ? String(opts.odds) : null,
    sport: "mlb",
    direction: "over",
  } as unknown as PersistedPlay;
}

// 1 — EXCLUDED_FROM_PRIMARY_ROI shape & immutability
test("EXCLUDED_FROM_PRIMARY_ROI contains home_runs + batter_strikeouts (frozen)", () => {
  assertDeep([...EXCLUDED_FROM_PRIMARY_ROI].sort(), ["batter_strikeouts", "home_runs"], "exclusion list");
  assertEq(Object.isFrozen(EXCLUDED_FROM_PRIMARY_ROI), true, "EXCLUDED_FROM_PRIMARY_ROI is frozen");
});

// 2 — isExcludedFromPrimaryRoi identification + safety
test("isExcludedFromPrimaryRoi flags home_runs", () => {
  assertEq(isExcludedFromPrimaryRoi("home_runs"), true, "home_runs");
});
test("isExcludedFromPrimaryRoi flags batter_strikeouts", () => {
  assertEq(isExcludedFromPrimaryRoi("batter_strikeouts"), true, "batter_strikeouts");
});
test("isExcludedFromPrimaryRoi keeps hits / total_bases / hrr", () => {
  assertEq(isExcludedFromPrimaryRoi("hits"), false, "hits");
  assertEq(isExcludedFromPrimaryRoi("total_bases"), false, "total_bases");
  assertEq(isExcludedFromPrimaryRoi("hrr"), false, "hrr");
});
test("isExcludedFromPrimaryRoi degrades safely on null/undefined/unknown", () => {
  assertEq(isExcludedFromPrimaryRoi(null), false, "null");
  assertEq(isExcludedFromPrimaryRoi(undefined), false, "undefined");
  assertEq(isExcludedFromPrimaryRoi("garbage_market"), false, "garbage");
});

// 3 — filterPrimaryRoiPlays removes only excluded markets
test("filterPrimaryRoiPlays drops home_runs + batter_strikeouts only", () => {
  const plays = [
    play("hits", "hit"),
    play("home_runs", "miss"),
    play("total_bases", "hit"),
    play("batter_strikeouts", "miss"),
    play("hrr", "hit"),
  ];
  const filtered = filterPrimaryRoiPlays(plays);
  assertEq(filtered.length, 3, "kept 3 of 5");
  assertDeep(filtered.map(p => p.market).sort(), ["hits", "hrr", "total_bases"], "kept correct markets");
});

// 4 — getPrimaryROIMetrics diverges exactly when excluded plays are present
test("getPrimaryROIMetrics excludes losing HR + K plays from headline", () => {
  // Construct a scenario where excluded markets are pure losses; the primary
  // ROI should improve relative to the full ROI.
  const plays = [
    play("hits", "hit", { stake: 100, odds: -110 }), // +90.91
    play("hits", "hit", { stake: 100, odds: -110 }), // +90.91
    play("home_runs", "miss", { stake: 100, odds: 400 }), // -100
    play("batter_strikeouts", "miss", { stake: 100, odds: -110 }), // -100
  ];
  const full = getROIMetrics(plays);
  const primary = getPrimaryROIMetrics(plays);
  assertEq(full.totalBets, 4, "full counts all 4 settled");
  assertEq(primary.totalBets, 2, "primary counts 2 (hits only)");
  assertEq(primary.hits, 2, "primary hits = 2");
  assertEq(primary.hitRate, 100, "primary hit rate = 100%");
  // Primary ROI should be strictly greater than full ROI in this scenario.
  if (primary.roi <= full.roi) {
    throw new Error(`primary ROI (${primary.roi}) should beat full ROI (${full.roi}) when excluded markets are pure losses`);
  }
});

test("getPrimaryROIMetrics agrees with getROIMetrics when no excluded plays present", () => {
  const plays = [
    play("hits", "hit", { stake: 100, odds: -110 }),
    play("total_bases", "miss", { stake: 100, odds: -110 }),
    play("hrr", "hit", { stake: 100, odds: -110 }),
  ];
  const full = getROIMetrics(plays);
  const primary = getPrimaryROIMetrics(plays);
  assertEq(primary.roi, full.roi, "ROI matches when no excluded plays");
  assertEq(primary.hitRate, full.hitRate, "hit rate matches");
  assertEq(primary.totalBets, full.totalBets, "totalBets matches");
});

// 5 — getRoiByMarket flags excluded markets
test("getRoiByMarket flags excluded markets via excludedFromPrimary", () => {
  const plays = [
    play("hits", "hit"),
    play("home_runs", "miss"),
    play("batter_strikeouts", "miss"),
    play("total_bases", "hit"),
  ];
  const breakdown = getRoiByMarket(plays);
  const byMarket = new Map(breakdown.map(r => [r.market, r]));
  assertEq(byMarket.get("home_runs")?.excludedFromPrimary, true, "home_runs flagged");
  assertEq(byMarket.get("batter_strikeouts")?.excludedFromPrimary, true, "batter_strikeouts flagged");
  assertEq(byMarket.get("hits")?.excludedFromPrimary, false, "hits not flagged");
  assertEq(byMarket.get("total_bases")?.excludedFromPrimary, false, "total_bases not flagged");
});

// 6 — buildFullROIReport exposes both blocks and they reconcile
test("buildFullROIReport exposes both global + primary, both reconcile", () => {
  const plays = [
    play("hits", "hit", { stake: 100, odds: -110 }),
    play("home_runs", "miss", { stake: 100, odds: 400 }),
    play("total_bases", "miss", { stake: 100, odds: -110 }),
  ];
  const report = buildFullROIReport(plays);
  assertEq(report.global.totalBets, 3, "global counts all");
  assertEq(report.primary.totalBets, 2, "primary excludes home_runs");
  assertDeep([...report.excludedFromPrimary].sort(), ["batter_strikeouts", "home_runs"], "report exposes exclusion list");
  // The byMarketBreakdown should mark home_runs as excluded.
  const hr = report.byMarketBreakdown.find(r => r.market === "home_runs");
  if (!hr) throw new Error("home_runs row missing from byMarketBreakdown");
  assertEq(hr.excludedFromPrimary, true, "byMarketBreakdown flags home_runs");
});

// 7 — logRoiFilterApplied emits the structured tag
test("logRoiFilterApplied emits [ROI_FILTER_APPLIED] with surface + counts", () => {
  const captured: any[] = [];
  const orig = console.log;
  console.log = (...args: any[]) => { captured.push(args); };
  try {
    logRoiFilterApplied({
      surface: "harness_test",
      totalPlays: 10,
      primaryPlays: 8,
    });
  } finally {
    console.log = orig;
  }
  if (captured.length !== 1) throw new Error(`expected 1 log call, got ${captured.length}`);
  const [tag, payload] = captured[0];
  assertEq(tag, "[ROI_FILTER_APPLIED]", "log tag");
  assertEq(payload.surface, "harness_test", "surface");
  assertEq(payload.totalPlays, 10, "totalPlays");
  assertEq(payload.primaryPlays, 8, "primaryPlays");
  assertEq(payload.removed, 2, "removed");
  assertDeep([...payload.excludedMarkets].sort(), ["batter_strikeouts", "home_runs"], "excludedMarkets default");
});

// — runner —
let pass = 0;
let fail = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    pass++;
    console.log(`  \u2713 ${c.name}`);
  } catch (e: any) {
    fail++;
    failures.push(`  \u2717 ${c.name}\n      ${e.message}`);
    console.log(`  \u2717 ${c.name}`);
    console.log(`      ${e.message}`);
  }
}
console.log(`\n[Primary ROI Exclusion — Phase 1] ${pass}/${pass + fail} cases passed`);
if (fail > 0) {
  console.error(`\nFAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
