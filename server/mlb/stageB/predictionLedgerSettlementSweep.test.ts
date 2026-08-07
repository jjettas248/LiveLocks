// MLB Stage B — settlement sweep behavioral invariants (injected fakes).
//
// Run: npx tsx server/mlb/stageB/predictionLedgerSettlementSweep.test.ts

import {
  runStageBSettlementSweep,
  __resetStageBSweepGuardForTest,
  type StageBSweepDeps,
  type StageBSweepPolicy,
} from "./predictionLedgerSettlementSweep";
import { MLB_PREDICTION_LEDGER_CONTRACT_VERSION, type MlbLanePrediction } from "@shared/mlbPredictionLedger";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function pred(o: Partial<MlbLanePrediction> = {}): MlbLanePrediction {
  return {
    predictionId: "pid", signalId: "sid", sport: "MLB", gameId: "g1", playerId: "p1",
    playerName: "B", market: "hits", side: "OVER", lane: "shadow", line: 1.5,
    overOdds: -115, underOdds: -105, sideOdds: -115, sportsbook: "draftkings",
    oddsFetchedAt: null, oddsAgeMs: null,
    capturedAt: new Date(NOW - 3 * HOUR).toISOString(), // 3h old by default
    inning: 5, gamePhase: null, statAtCapture: 1, candidateProbabilityPct: 58,
    calibratedProbabilityPct: null, probabilitySemantics: "raw_provisional",
    modelEdgePctPoints: 6, noVigBookProbability: 52, edgeVersion: "novig_v1",
    finalizedTier: "watch", modelMethod: "hit_distribution", dataQuality: "full",
    baseEligible: false, signalScore: 41, laneReasons: [], finalizerVersion: null,
    laneVersion: null, goldmasterVersion: null, contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
    status: "captured", settlementResult: null, finalStat: null, settledAt: null, voidReason: null,
    ...o,
  };
}

interface Recorder {
  deps: StageBSweepDeps;
  fetchCalls: string[];
  settled: Array<{ id: string; finalStat: number }>;
  voided: Array<{ id: string; reason: string }>;
  listPendingOpts: Array<{ limit: number; capturedBeforeMs?: number }>;
}
function makeDeps(opts: {
  pending: MlbLanePrediction[];
  box?: (gameId: string) => unknown | null;   // null ⇒ not final
  stat?: (playerId: string, market: string) => number | null;
  players?: Set<string>;                       // playerIds present in the final box
  playerHasStats?: boolean;                    // did the found player participate at all
  fetchThrows?: boolean;
  settleThrows?: boolean;
}): Recorder {
  const fetchCalls: string[] = [];
  const settled: Array<{ id: string; finalStat: number }> = [];
  const voided: Array<{ id: string; reason: string }> = [];
  const players = opts.players ?? new Set(["p1"]);
  const listPendingOpts: Array<{ limit: number; capturedBeforeMs?: number }> = [];
  const deps: StageBSweepDeps = {
    listPending: async (o) => { listPendingOpts.push(o); return opts.pending; },
    settle: async (id, finalStat) => {
      if (opts.settleThrows) throw new Error("settle failed");
      settled.push({ id, finalStat }); return {};
    },
    voidPrediction: async (id, reason) => { voided.push({ id, reason }); return {}; },
    fetchBox: async (gameId) => {
      fetchCalls.push(gameId);
      if (opts.fetchThrows) throw new Error("fetch failed");
      return opts.box ? opts.box(gameId) : { gameId };
    },
    buildPlayerStats: (box) => {
      const map = new Map<string, unknown>();
      for (const pid of players) map.set(pid, { pid });
      return map;
    },
    getStatValue: (entry, market) => (opts.stat ? opts.stat((entry as any).pid, market) : 2),
    playerHasAnyStats: () => opts.playerHasStats ?? true,
    normalizeMarket: (m) => m,
    now: () => NOW,
  };
  return { deps, fetchCalls, settled, voided, listPendingOpts };
}

// Final + finite stat ⇒ settle graded
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [pred({ predictionId: "x", side: "OVER", line: 1.5 })], stat: () => 2 });
  const s = await runStageBSettlementSweep(r.deps);
  ok(s.settled === 1 && r.settled[0].id === "x" && r.settled[0].finalStat === 2, "final+stat ⇒ settle with graded finalStat");
  ok(s.voided === 0 && s.held === 0, "no void/hold for a settleable row");
}

// Per-game fetch dedup — one fetchBox call per game
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({
    pending: [
      pred({ predictionId: "a", gameId: "g1", playerId: "p1" }),
      pred({ predictionId: "b", gameId: "g1", playerId: "p2" }),
      pred({ predictionId: "c", gameId: "g2", playerId: "p1" }),
    ],
    players: new Set(["p1", "p2"]),
    stat: () => 2,
  });
  const s = await runStageBSettlementSweep(r.deps);
  ok(r.fetchCalls.length === 2, "fetchBox called once per game (dedup), not once per prediction");
  ok(s.games === 2 && s.settled === 3, "all three predictions settled across two games");
}

// Final + TRUE DNP (present, no participation at all) ⇒ void player_did_not_appear
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [pred({ predictionId: "dnp", playerId: "p1" })], players: new Set(["p1"]), stat: () => null, playerHasStats: false });
  const s = await runStageBSettlementSweep(r.deps);
  ok(s.voided === 1 && r.voided[0].reason === "player_did_not_appear", "found + no participation ⇒ void DNP");
}

// Final + player PLAYED but this market's stat null ⇒ NOT DNP: young holds
// (preserves the observation for a late/partial box), old terminal-voids neutral.
{
  __resetStageBSweepGuardForTest();
  const young = makeDeps({ pending: [pred({ predictionId: "np", playerId: "p1" })], players: new Set(["p1"]), stat: () => null, playerHasStats: true });
  const sy = await runStageBSettlementSweep(young.deps);
  ok(sy.held === 1 && sy.voided === 0, "played-but-stat-null (young) ⇒ hold, not DNP-void");

  __resetStageBSweepGuardForTest();
  const old = makeDeps({ pending: [pred({ predictionId: "npold", playerId: "p1", capturedAt: new Date(NOW - 60 * HOUR).toISOString() })], players: new Set(["p1"]), stat: () => null, playerHasStats: true });
  const so = await runStageBSettlementSweep(old.deps);
  ok(so.voided === 1 && old.voided[0].reason === "line_unresolvable", "played-but-stat-null (old) ⇒ terminal void line_unresolvable (not DNP)");
}

// Not final (box null), young ⇒ hold; no settle/void
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [pred({ predictionId: "y", capturedAt: new Date(NOW - 2 * HOUR).toISOString() })], box: () => null });
  const s = await runStageBSettlementSweep(r.deps);
  ok(s.held === 1 && s.settled === 0 && s.voided === 0, "young not-final ⇒ hold");
}

// Not final (box null), terminal-old ⇒ NEUTRAL line_unresolvable void (never a
// synthesized game_postponed that would mislabel a real final).
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [pred({ predictionId: "old", capturedAt: new Date(NOW - 80 * HOUR).toISOString() })], box: () => null });
  const s = await runStageBSettlementSweep(r.deps);
  ok(s.voided === 1 && r.voided[0].reason === "line_unresolvable", "old not-final ⇒ terminal void line_unresolvable (neutral, not postponed)");
}

// Sweep passes a capturedBeforeMs floor to listPending (skip too-fresh rows)
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [], });
  await runStageBSettlementSweep(r.deps);
  const o = r.listPendingOpts[0];
  ok(o != null && typeof o.capturedBeforeMs === "number" && o.capturedBeforeMs < NOW, "listPending receives a capturedBeforeMs floor below now (skips fresh rows)");
}

// fetchBox throws ⇒ fetchFailures counted, row held, sweep never throws
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [pred({ predictionId: "f" })], fetchThrows: true });
  let threw = false;
  let s: any;
  try { s = await runStageBSettlementSweep(r.deps); } catch { threw = true; }
  ok(!threw, "sweep never throws on a fetch failure");
  ok(s.fetchFailures === 1 && s.held === 1 && s.settled === 0, "fetch failure ⇒ counted + row held (never void on transient)");
}

// settle throws ⇒ errors counted, sweep never throws
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [pred({ predictionId: "e" })], stat: () => 2, settleThrows: true });
  let threw = false;
  let s: any;
  try { s = await runStageBSettlementSweep(r.deps); } catch { threw = true; }
  ok(!threw, "sweep never throws when a settle write fails");
  ok(s.errors === 1 && s.settled === 0, "settle failure ⇒ error counted, not settled");
}

// Empty pending ⇒ no fetches, zeroed summary
{
  __resetStageBSweepGuardForTest();
  const r = makeDeps({ pending: [] });
  const s = await runStageBSettlementSweep(r.deps);
  ok(s.scanned === 0 && s.games === 0 && r.fetchCalls.length === 0, "empty pending ⇒ no work, no fetch");
}

// maxGamesPerSweep caps games processed per run
{
  __resetStageBSweepGuardForTest();
  const pending = [pred({ predictionId: "g1p", gameId: "g1" }), pred({ predictionId: "g2p", gameId: "g2" }), pred({ predictionId: "g3p", gameId: "g3" })];
  const r = makeDeps({ pending, stat: () => 2 });
  const s = await runStageBSettlementSweep(r.deps, { pendingLimit: 2000, maxGamesPerSweep: 2, minSettleAgeMinutes: 10 });
  ok(s.games === 2 && r.fetchCalls.length === 2, "maxGamesPerSweep caps games (and fetches) per run");
}

console.log(`\npredictionLedgerSettlementSweep.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
