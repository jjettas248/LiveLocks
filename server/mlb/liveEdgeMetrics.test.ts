// MLB Live Edge polling/odds metrics — unit tests.
// Run: npx tsx server/mlb/liveEdgeMetrics.test.ts
//
// Observability must be bounded, rate-limited, and incapable of breaking
// runtime. It must also make the infrastructure KPI answerable:
// external Odds API requests per live game-hour.

import {
  recordStatePoll,
  recordEngineRun,
  recordReconciliationCheck,
  recordOddsRefreshAttempt,
  recordOddsRefreshSkip,
  recordDormant,
  recordDormantReconsidered,
  recordDormantReactivated,
  recordExternalOddsRequest,
  recordLiveGameTime,
  getLiveEdgeMetrics,
  maybeEmitLiveEdgeMetrics,
  _resetLiveEdgeMetricsForTests,
  _getMaxTriggerKeysForTests,
} from "./liveEdgeMetrics";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[MLB_LIVE_EDGE_METRICS_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// Silence the module's own tag output during counting tests.
const originalLog = console.log;
function quiet<T>(fn: () => T): T {
  console.log = (() => {}) as typeof console.log;
  try { return fn(); } finally { console.log = originalLog; }
}

// ─── Group A: state polls and no-change accounting ────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    recordStatePoll("g1", []);
    recordStatePoll("g1", []);
    recordStatePoll("g1", []);
    recordStatePoll("g1", ["ab_completed", "new_ab"]);
  });
  const m = getLiveEdgeMetrics();
  check("A1: every poll is counted", m.statePolls === 4, String(m.statePolls));
  check("A2: no-change polls are counted separately", m.statePollsNoChange === 3, String(m.statePollsNoChange));
  check("A3: material events counted per trigger", m.materialEvents["ab_completed"] === 1 && m.materialEvents["new_ab"] === 1, JSON.stringify(m.materialEvents));
  check("A4: no-change polls contribute no material events", Object.keys(m.materialEvents).length === 2);
  check("A5: noChangePollPct is derived", m.noChangePollPct === 75, String(m.noChangePollPct));
}

// ─── Group B: engine runs by trigger ──────────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    recordEngineRun("g1", ["ab_completed"], { narrowed: true, marketCount: 4, playerCount: 3 });
    recordEngineRun("g1", ["inning_change"], { narrowed: false, marketCount: 7, playerCount: "all" });
    recordEngineRun("g1", [], { narrowed: false });
  });
  const m = getLiveEdgeMetrics();
  check("B1: engine runs total", m.engineRunsTotal === 3, String(m.engineRunsTotal));
  check("B2: narrowed cycles counted", m.narrowedCycles === 1, String(m.narrowedCycles));
  check("B3: runs bucketed by trigger", m.engineRuns["ab_completed"] === 1 && m.engineRuns["inning_change"] === 1, JSON.stringify(m.engineRuns));
  check("B4: a run with no triggers is labelled 'initial'", m.engineRuns["initial"] === 1);
}

// ─── Group C: odds refresh accounting ─────────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    recordOddsRefreshAttempt("e1", "hits", "actionable");
    recordOddsRefreshSkip("e1", "hits", "fresh_cache", { ageMs: 5000 });
    recordOddsRefreshSkip("e1", "home_runs", "price_floor", { bestPrice: -235 });
    recordOddsRefreshSkip("e1", "hrr", "no_material_event");
  });
  const m = getLiveEdgeMetrics();
  check("C1: attempts counted", m.oddsRefreshAttempted === 1);
  check("C2: fresh-cache skips counted", m.oddsRefreshSkippedFresh === 1);
  check("C3: price-floor skips counted separately", m.oddsRefreshSkippedPriceFloor === 1);
  check("C4: no-event skips counted separately", m.oddsRefreshSkippedNoEvent === 1);
  check("C5: a fresh-cache skip is also a cache hit", m.oddsCacheHits === 1);
}

// ─── Group D: dormancy lifecycle ──────────────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    recordDormant("e1", "home_runs", -235);
    recordDormantReconsidered("e1", "home_runs", "inning_change");
    recordDormantReactivated("e1", "home_runs", -175);
  });
  const m = getLiveEdgeMetrics();
  check("D1: dormant counted", m.dormantMarkets === 1);
  check("D2: reconsiderations counted", m.dormantReconsidered === 1);
  check("D3: reactivations counted", m.dormantReactivated === 1);
}

// ─── Group E: the KPI — odds requests per live game-hour ──────────────────────
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    for (let i = 0; i < 30; i++) recordExternalOddsRequest("batter_hits");
    recordLiveGameTime(2 * 3_600_000); // two live game-hours observed
  });
  const m = getLiveEdgeMetrics();
  check("E1: external requests counted", m.externalOddsRequests === 30, String(m.externalOddsRequests));
  check("E2: per-live-game-hour KPI derived", m.oddsRequestsPerLiveGameHour === 15, String(m.oddsRequestsPerLiveGameHour));
}
{
  _resetLiveEdgeMetricsForTests();
  const m = getLiveEdgeMetrics();
  check("E3: KPI is null (not NaN/Infinity) with no observed live time", m.oddsRequestsPerLiveGameHour === null);
  check("E4: noChangePollPct is null with no polls", m.noChangePollPct === null);
}
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    recordLiveGameTime(-5);
    recordLiveGameTime(Number.NaN);
    recordLiveGameTime(1000);
  });
  check("E5: negative/NaN live time is ignored", getLiveEdgeMetrics().liveGameMs === 1000, String(getLiveEdgeMetrics().liveGameMs));
}

// ─── Group F: bounded trigger maps ────────────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  const cap = _getMaxTriggerKeysForTests();
  quiet(() => {
    for (let i = 0; i < cap + 50; i++) recordEngineRun("g1", [`bogus_trigger_${i}`]);
  });
  const keys = Object.keys(getLiveEdgeMetrics().engineRuns).length;
  check("F1: trigger map is bounded", keys <= cap, String(keys));
  check("F2: total count is still accurate despite the cap", getLiveEdgeMetrics().engineRunsTotal === cap + 50);
}

// ─── Group G: rate-limited tag emission ───────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  const logs: string[] = [];
  console.log = ((...args: any[]) => { logs.push(String(args[0])); }) as typeof console.log;
  try {
    // 50 identical events in a tight loop — production must not see 50 lines.
    for (let i = 0; i < 50; i++) recordStatePoll("g1", ["ball_in_play"]);
  } finally {
    console.log = originalLog;
  }
  const stateEventLines = logs.filter(l => l.includes("[MLB_STATE_EVENT]")).length;
  check("G1: repeated identical events emit at most one line per cooldown", stateEventLines === 1, String(stateEventLines));
  check("G2: counters still recorded every occurrence", getLiveEdgeMetrics().materialEvents["ball_in_play"] === 50);
}
{
  _resetLiveEdgeMetricsForTests();
  const logs: string[] = [];
  console.log = ((...args: any[]) => { logs.push(String(args[0])); }) as typeof console.log;
  try {
    maybeEmitLiveEdgeMetrics();
    maybeEmitLiveEdgeMetrics();
    maybeEmitLiveEdgeMetrics();
  } finally {
    console.log = originalLog;
  }
  const metricLines = logs.filter(l => l.includes("[MLB_POLLING_METRICS]")).length;
  check("G3: the aggregate line self-limits", metricLines === 1, String(metricLines));
}

// ─── Group H: never throws ────────────────────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  let threw = false;
  try {
    quiet(() => {
      recordStatePoll(undefined as any, undefined as any);
      recordEngineRun(undefined as any, undefined as any);
      recordOddsRefreshSkip(undefined as any, undefined as any, "price_floor");
      recordReconciliationCheck(true, undefined);
      recordExternalOddsRequest(undefined as any);
      getLiveEdgeMetrics();
      maybeEmitLiveEdgeMetrics();
    });
  } catch {
    threw = true;
  }
  check("H1: malformed input never throws", !threw);
}

// ─── Group I: reconciliation accounting ───────────────────────────────────────
{
  _resetLiveEdgeMetricsForTests();
  quiet(() => {
    recordReconciliationCheck(false, "g1");
    recordReconciliationCheck(false, "g1");
    recordReconciliationCheck(true, "g1");
  });
  const m = getLiveEdgeMetrics();
  check("I1: every reconciliation check is counted", m.reconciliationChecks === 3);
  check("I2: only recoveries are counted as recoveries", m.reconciliationRecoveries === 1);
}

console.log(`[MLB_LIVE_EDGE_METRICS_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[MLB_LIVE_EDGE_METRICS_TEST] OK");
