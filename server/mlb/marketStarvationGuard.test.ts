// MLB Market Starvation Guard — unit tests.
// Verifies the starvation evaluator's threshold logic (sample floor + rate
// threshold), and the runner's never-throws guarantee, cooldown suppression,
// and recovery logging. Run: npx tsx server/mlb/marketStarvationGuard.test.ts

import {
  evaluateMarketStarvation,
  checkMarketStarvation,
  _resetMarketStarvationGuardForTests,
} from "./marketStarvationGuard";
import type { AuditSummary } from "./qualificationAudit";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MARKET_STARVATION_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function mkBottleneck(market: string, rejected: number, qualified: number, staleOddsRejected: number) {
  const denom = rejected + qualified;
  const staleOddsRejectRate = denom > 0 ? Math.round((staleOddsRejected / denom) * 1000) / 10 : 0;
  return { market, rejected, qualified, rejectRate: 0, staleOddsRejected, staleOddsRejectRate };
}

function mkSummary(bottlenecks: ReturnType<typeof mkBottleneck>[]): AuditSummary {
  return {
    windowMs: 1_800_000,
    qualificationBottlenecks: bottlenecks,
  } as unknown as AuditSummary;
}

// ─── evaluateMarketStarvation — threshold logic ─────────────────────────────

const starved = mkSummary([mkBottleneck("hits", 25, 0, 25)]); // sample=25, rate=100%
const findings1 = evaluateMarketStarvation(starved);
check("fires at rate+sample-floor crossing", findings1.length === 1 && findings1[0].market === "hits",
  JSON.stringify(findings1));

const lowSample = mkSummary([mkBottleneck("total_bases", 5, 0, 5)]); // sample=5 (<20), rate=100%
const findings2 = evaluateMarketStarvation(lowSample);
check("does not fire below sample floor even at 100% rate", findings2.length === 0, JSON.stringify(findings2));

const lowRate = mkSummary([mkBottleneck("pitcher_strikeouts", 100, 100, 10)]); // sample=200, rate=5%
const findings3 = evaluateMarketStarvation(lowRate);
check("does not fire below rate threshold even with large sample", findings3.length === 0, JSON.stringify(findings3));

// Exactly at the boundary: sample=20 (SAMPLE_FLOOR), rate=70% (RATE_THRESHOLD_PCT) — inclusive, should fire.
const boundary = mkSummary([mkBottleneck("hrr", 14, 6, 14)]);
const findings4 = evaluateMarketStarvation(boundary);
check("fires at exact threshold boundary (sample=20, rate=70%)", findings4.length === 1, JSON.stringify(findings4));

// home_runs structurally never accumulates staleOdds rejections in real data
// (its odds-independent occurrence fallback means a missing book line never
// produces a staleOdds rejection) — verify that realistic shape never fires,
// while a genuinely starved market alongside it still does.
const hrRealistic = mkSummary([
  mkBottleneck("home_runs", 5, 120, 0), // non-staleOdds rejections only (e.g. probability floor)
  mkBottleneck("hits", 30, 5, 28),
]);
const findings5 = evaluateMarketStarvation(hrRealistic);
check("home_runs never fires under its realistic zero-staleOdds shape",
  !findings5.some((f) => f.market === "home_runs"), JSON.stringify(findings5));
check("hits still fires alongside a healthy home_runs entry",
  findings5.some((f) => f.market === "hits"), JSON.stringify(findings5));

// ─── evaluateMarketStarvation — malformed input never throws ───────────────

let evaluatorThrew = false;
try {
  evaluateMarketStarvation(null);
  evaluateMarketStarvation(undefined);
  evaluateMarketStarvation({} as any);
  evaluateMarketStarvation({ qualificationBottlenecks: null } as any);
  evaluateMarketStarvation({ qualificationBottlenecks: [null, undefined, { market: 123 }, {}] } as any);
} catch {
  evaluatorThrew = true;
}
check("evaluator never throws on malformed/empty summary", !evaluatorThrew);
check("evaluator returns [] for null summary", evaluateMarketStarvation(null).length === 0);
check("evaluator returns [] for empty bottlenecks", evaluateMarketStarvation(mkSummary([])).length === 0);

// ─── checkMarketStarvation — runner never throws, even if getSummary throws ─

_resetMarketStarvationGuardForTests();
let runnerThrew = false;
try {
  checkMarketStarvation(() => {
    throw new Error("boom");
  });
} catch {
  runnerThrew = true;
}
check("runner never throws even if getSummary throws", !runnerThrew);

// ─── checkMarketStarvation — cooldown suppresses re-fire ────────────────────

_resetMarketStarvationGuardForTests();
const originalWarn = console.warn;
let warnCount = 0;
console.warn = ((..._args: any[]) => {
  warnCount++;
}) as typeof console.warn;
try {
  const summaryFn = () => mkSummary([mkBottleneck("hits", 25, 0, 25)]);
  checkMarketStarvation(summaryFn);
  checkMarketStarvation(summaryFn);
  checkMarketStarvation(summaryFn);
} finally {
  console.warn = originalWarn;
}
check("cooldown suppresses re-fire on repeated calls within the window", warnCount === 1, `warnCount=${warnCount}`);

// ─── checkMarketStarvation — recovery log fires when a market drops out ────

_resetMarketStarvationGuardForTests();
const originalLog = console.log;
const originalWarn2 = console.warn;
const logs: string[] = [];
console.log = ((...args: any[]) => {
  logs.push(String(args[0]));
}) as typeof console.log;
console.warn = ((...args: any[]) => {
  logs.push(String(args[0]));
}) as typeof console.warn;
try {
  checkMarketStarvation(() => mkSummary([mkBottleneck("hits", 25, 0, 25)]));
  checkMarketStarvation(() => mkSummary([])); // hits recovers
} finally {
  console.log = originalLog;
  console.warn = originalWarn2;
}
check("starved log fires on first detection", logs.some((l) => l.includes("MLB_MARKET_STARVED")), JSON.stringify(logs));
check("recovery log fires when a starved market drops out of findings",
  logs.some((l) => l.includes("MLB_MARKET_STARVED_RECOVERED")), JSON.stringify(logs));

console.log(`[MARKET_STARVATION_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MARKET_STARVATION_TEST] OK");
