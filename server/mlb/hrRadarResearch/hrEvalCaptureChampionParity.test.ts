// HR Radar research capture — capture-off vs capture-on champion parity, and
// the "capture failure never blocks/changes anything" invariant.
//
// Scope note: captureHrEvaluationEpoch takes gate flags as an explicit
// parameter (not a frozen import-time constant) specifically so this test can
// exercise both the off and on paths in one process without any env-var or
// module-cache hacks — see hrEvaluationCapture.ts's HrCaptureRuntimeContext.
// This test verifies the OBSERVER's own contract (it never throws, it does
// nothing when gated off, and its return value is void/unconsumed); it does
// not spin up a full live orchestrator tick — the true byte-for-byte
// champion-output parity guarantee comes from where the single call site
// sits in liveGameOrchestrator.ts (see hrEvalCaptureNoChampionMutation.test.ts
// for the static half of that guarantee: the observer never references any
// champion-mutating function).
//
// Run: npx tsx server/mlb/hrRadarResearch/hrEvalCaptureChampionParity.test.ts

import { captureHrEvaluationEpoch, type HrCaptureRuntimeContext } from "./hrEvaluationCapture";
import { _resetHrEvaluationWriteQueueForTests, getHrEvaluationWriteQueueMetrics, _setHrEvaluationWriteExecutorForTests } from "./hrEvaluationWriteQueue";
import { _resetHrEvalCaptureDiagnosticsForTests } from "./hrEvalCaptureDiagnostics";
import { clearHrEpochDetectorStateForGame } from "./hrEvaluationEpochDetector";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseCtx(overrides: Partial<HrCaptureRuntimeContext> = {}): HrCaptureRuntimeContext {
  return {
    gameId: "parityGame1",
    sessionDate: "2026-07-01",
    gameStatus: "live",
    state: { inning: 4, isTopInning: true, pitchCount: 55, outs: 1, homeScore: 2, awayScore: 1 },
    detectedEpoch: { triggerType: "pa_complete", sourceEventId: "pa:20", sourceEventAt: null, playSequence: 20 },
    batters: [
      {
        batter: { playerId: "b1", playerName: "Batter One", team: "NYY", slot: 3 },
        playerContact: null,
        rollingStats: null,
        batterHand: "R",
        alreadyHomeredThisGame: false,
        stillInBattingOrder: true,
      },
      {
        batter: { playerId: "b2", playerName: "Batter Two", team: "NYY", slot: 4 },
        playerContact: null,
        rollingStats: null,
        batterHand: "L",
        alreadyHomeredThisGame: true,
        stillInBattingOrder: true,
      },
    ],
    pitcherCtx: null,
    pitcherId: "p1",
    pitcherHand: "R",
    pitcherEraSeasonal: 3.5,
    weatherCache: null,
    statsAsOfMs: 1_700_000_000_000,
    flags: { enabled: false, percent: 0 },
    ...overrides,
  };
}

async function run() {
  _setHrEvaluationWriteExecutorForTests(async (row) => [{ snapshotId: row.snapshotId }]);

  // ── Capture OFF (flag disabled) is a true no-op ────────────────────────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(async (row) => [{ snapshotId: row.snapshotId }]);
  _resetHrEvalCaptureDiagnosticsForTests();
  clearHrEpochDetectorStateForGame("parityGame1");
  const returnValueOff = captureHrEvaluationEpoch(baseCtx({ flags: { enabled: false, percent: 100 } }));
  ok(returnValueOff === undefined, "captureHrEvaluationEpoch returns nothing consumed by the caller (void)");
  ok(getHrEvaluationWriteQueueMetrics().queued === 0, "capture-off (flag disabled) enqueues zero rows regardless of sampling percent");

  // ── Capture ON (flag enabled, 100% sample) actually enqueues rows ──────
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(async (row) => [{ snapshotId: row.snapshotId }]);
  clearHrEpochDetectorStateForGame("parityGame1");
  captureHrEvaluationEpoch(baseCtx({ flags: { enabled: true, percent: 100 } }));
  const onMetrics = getHrEvaluationWriteQueueMetrics();
  ok(onMetrics.queued >= 2, `capture-on enqueues one row per population batter (got queued=${onMetrics.queued})`);

  // ── Capture ON but 0% sample enqueues nothing (percent gate honored) ───
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(async (row) => [{ snapshotId: row.snapshotId }]);
  clearHrEpochDetectorStateForGame("parityGame1");
  captureHrEvaluationEpoch(baseCtx({ flags: { enabled: true, percent: 0 } }));
  ok(getHrEvaluationWriteQueueMetrics().queued === 0, "capture-on with percent=0 enqueues zero rows for any game");

  // ── A deliberately-throwing dependency never escapes captureHrEvaluationEpoch ──
  _resetHrEvaluationWriteQueueForTests();
  _setHrEvaluationWriteExecutorForTests(async () => { throw new Error("should never be reached synchronously"); });
  clearHrEpochDetectorStateForGame("parityGame1");
  let threw = false;
  try {
    // Malformed batter materials (missing required nested fields at runtime,
    // even though TS wouldn't allow this at compile time) simulates an
    // unexpected shape making it through in production; the per-batter
    // try/catch inside captureHrEvaluationEpoch must swallow it.
    const malformedCtx = baseCtx({ flags: { enabled: true, percent: 100 } });
    (malformedCtx.batters[0] as any).batter = null;
    captureHrEvaluationEpoch(malformedCtx);
  } catch {
    threw = true;
  }
  ok(!threw, "a per-batter build failure never escapes captureHrEvaluationEpoch — it never throws into the caller");

  _resetHrEvaluationWriteQueueForTests();
  _resetHrEvalCaptureDiagnosticsForTests();
  clearHrEpochDetectorStateForGame("parityGame1");
  console.log(`hrEvalCaptureChampionParity.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
