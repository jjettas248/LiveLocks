// Frozen Mound shadow input contract — invariants.
//
// Run: npx tsx server/mlb/pregame/mound/v2/frozenMoundShadowInput.test.ts

import {
  buildFrozenMoundInput,
  computeMoundFeatureHash,
  deepFreezeMoundInput,
  MOUND_FROZEN_CONTRACT_VERSION,
  type BuildFrozenMoundInputArgs,
  type FrozenMoundInput,
} from "./frozenMoundShadowInput";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseArgs(overrides: Partial<BuildFrozenMoundInputArgs> = {}): BuildFrozenMoundInputArgs {
  return {
    snapshotId: "snap_1",
    gameId: "game_1",
    gamePk: "gamePk_1",
    pitcherId: "pitcher_1",
    pitcherName: "Test Pitcher",
    opponent: "OPP",
    scheduledGameTime: "2026-07-29T23:05:00.000Z",
    now: new Date("2026-07-29T20:00:00.000Z"),
    lineupStatus: "confirmed",
    battingOrder: [
      { playerId: "b1", playerName: "Batter One", battingOrderSlot: 1, handedness: "L", kRateVsThrowHand: 0.25, kRateSamplePa: 200, bvpAtBats: 10, bvpStrikeouts: 3 },
      { playerId: "b2", playerName: "Batter Two", battingOrderSlot: 2, handedness: "R", kRateVsThrowHand: 0.18, kRateSamplePa: 150, bvpAtBats: 0, bvpStrikeouts: 0 },
    ],
    pitcherThrows: "R",
    kPer9: 9.5,
    priorSeasonsKPer9: [9.0, 8.7],
    swStrPct: 12.5,
    cswPct: 29,
    missesBatsFamily: { family: "breaking", whiffPct: 35, usagePct: 28 },
    kRateVsLHB: 0.27,
    kRateVsRHB: 0.24,
    avgInningsPerStart: 5.8,
    ipVarianceLast3: 0.9,
    lastStartPitchCount: 92,
    lastStartInningsPitched: 5.5,
    bbPer9: 2.9,
    strikeoutsMarket: { line: 5.5, overPrice: -120, underPrice: 100, sportsbook: "draftkings", fetchedAt: "2026-07-29T19:58:00.000Z" },
    outsMarket: { line: 16.5, overPrice: -110, underPrice: -110, sportsbook: "fanduel", fetchedAt: "2026-07-29T19:58:00.000Z" },
    dataQuality: "complete",
    productionModelVersion: "mound_v1",
    v2ModelVersion: "mound_v2_shadow_v1",
    ...overrides,
  };
}

// ── Basic construction ──────────────────────────────────────────────────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  ok(frozen.contractVersion === MOUND_FROZEN_CONTRACT_VERSION, "contractVersion is stamped");
  ok(frozen.snapshotId === "snap_1", "snapshotId passes through");
  ok(frozen.featureHash.length === 64, `featureHash is a 64-char sha256 hex digest (got length ${frozen.featureHash.length})`);
  ok(frozen.battingOrder.length === 2, "batting order passes through");
  ok(frozen.gameId === "game_1", "gameId (ESPN event id) passes through");
  ok(frozen.gamePk === "gamePk_1", "gamePk (MLB Stats API id, a DIFFERENT id space than gameId) passes through — Correction 3's reconciliation cannot call syncGameBoxScore correctly without this");
}

// ── gamePk is a real, distinct identity field, not a gameId alias ──────────
{
  const frozen = buildFrozenMoundInput(baseArgs({ gameId: "espn_777", gamePk: "statsapi_999" }));
  ok(frozen.gameId === "espn_777" && frozen.gamePk === "statsapi_999", "gameId and gamePk are captured independently, never conflated or cross-substituted");
}

// ── A null gamePk (unresolved at capture time) is honestly null, never fabricated ──
{
  const frozen = buildFrozenMoundInput(baseArgs({ gamePk: null }));
  ok(frozen.gamePk === null, "a null gamePk passes through as null, never defaulted to gameId or any other guessed value");
}

// ── Deterministic hash: identical feature content -> identical hash ─────────
{
  const a = buildFrozenMoundInput(baseArgs({ snapshotId: "snap_A", now: new Date("2026-07-29T20:00:00.000Z") }));
  const b = buildFrozenMoundInput(baseArgs({ snapshotId: "snap_B", now: new Date("2026-07-29T21:30:00.000Z") }));
  ok(a.featureHash === b.featureHash, "two snapshots with identical feature content hash identically regardless of snapshotId/evaluationTimestamp");
  ok(a.snapshotId !== b.snapshotId && a.evaluationTimestamp !== b.evaluationTimestamp, "identity fields themselves still differ");
}

// ── Different feature content -> different hash ─────────────────────────────
{
  const a = buildFrozenMoundInput(baseArgs());
  const b = buildFrozenMoundInput(baseArgs({ kPer9: 7.0 }));
  ok(a.featureHash !== b.featureHash, "a real evidence change (kPer9) changes the feature hash");
}

// ── A different gamePk is different feature content too ─────────────────────
{
  const a = buildFrozenMoundInput(baseArgs({ gamePk: "pk_a" }));
  const b = buildFrozenMoundInput(baseArgs({ gamePk: "pk_b" }));
  ok(a.featureHash !== b.featureHash, "a different gamePk changes the feature hash — it is real captured identity, not incidental metadata");
}

// ── computeMoundFeatureHash is a pure function of its input shape ─────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const { snapshotId, evaluationTimestamp, featureHash, ...rest } = frozen;
  const recomputed = computeMoundFeatureHash(rest as any);
  ok(recomputed === featureHash, "recomputing the hash from the same content-only object reproduces the stamped featureHash");
}

// ── Repeated evaluation of identical evidence is idempotent ─────────────────
{
  const first = buildFrozenMoundInput(baseArgs({ snapshotId: "idem_1" }));
  const second = buildFrozenMoundInput(baseArgs({ snapshotId: "idem_2" }));
  ok(first.featureHash === second.featureHash, "repeated evaluation of the same underlying evidence is idempotent (same hash)");
}

// ── No outcome-shaped keys anywhere on the frozen object ────────────────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  const json = JSON.stringify(frozen).toLowerCase();
  const forbidden = ["finalstrikeouts", "finaloutsrecorded", "settlementresult", "\"result\"", "gradedat", "resolvedat"];
  for (const term of forbidden) {
    ok(!json.includes(term), `no outcome-shaped key "${term}" appears anywhere in a frozen snapshot`);
  }
}

// ── Post-lock mutation is structurally impossible (deep-frozen) ────────────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  let threw = false;
  try {
    (frozen as any).kPer9 = 99;
  } catch {
    threw = true;
  }
  ok(threw || frozen.kPer9 !== 99, "mutating a top-level field on a captured snapshot either throws or silently fails to apply");

  let nestedThrew = false;
  try {
    (frozen.battingOrder[0] as any).kRateVsThrowHand = 0.99;
  } catch {
    nestedThrew = true;
  }
  ok(nestedThrew || frozen.battingOrder[0].kRateVsThrowHand !== 0.99, "mutating a NESTED field (batting order entry) is also blocked — deep freeze, not shallow");
}

// ── deepFreezeMoundInput freezes arbitrary nested structures ────────────────
{
  const obj = deepFreezeMoundInput({ a: { b: { c: 1 } }, arr: [{ x: 1 }] });
  ok(Object.isFrozen(obj) && Object.isFrozen(obj.a) && Object.isFrozen(obj.a.b) && Object.isFrozen(obj.arr[0]), "deepFreezeMoundInput freezes every nested level");
}

// ── Umpire context defaults to honestly "unavailable", never fabricated ────
{
  const frozen = buildFrozenMoundInput(baseArgs());
  ok(frozen.umpireContext?.reliability === "unavailable", "umpire context defaults to unavailable when not supplied — never a fabricated confident value");
}

console.log(`\nfrozenMoundShadowInput.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
