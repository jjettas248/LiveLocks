// Pre-Game Power Radar — grading persistence retry invariants.
//
// gradePregameOutcomes() uses copy-on-write: grading mutations land on a
// fresh `draft` object and are only committed back into the live snapshot
// (via commitGradedSignal's compare-and-swap) after persistSignalWithRetry
// confirms a successful DB write. These tests exercise persistSignalWithRetry
// in isolation by monkey-patching storage.upsertPregamePowerRadarSignal (a
// plain, unfrozen instance method) — there is no live database in this
// environment, so this is the only way to exercise the retry/backoff path.
//
// Run: npx tsx server/mlb/pregamePowerRadar/persistSignalWithRetry.test.ts

import { persistSignalWithRetry } from "./shadowOutcomes";
import { storage } from "../../storage";
import type { PregamePowerSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const originalUpsert = storage.upsertPregamePowerRadarSignal.bind(storage);

function makeSignal(over: Partial<PregamePowerSignal> = {}): PregamePowerSignal {
  return {
    signalId: "mlb-pregame:2026-07-01:g1:b1", sport: "mlb", engine: "pregame_power_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b", batterId: "b1", batterName: "X", team: "NYY", opponent: "BOS",
    pitcherId: "p1", pitcherName: "P", battingOrderSlot: 3, handednessMatchup: "R vs L",
    primaryMarket: "home_runs", marketTags: ["home_runs"], marketScores: { home_runs: 7 },
    score10: 7, tier: "strong",
    drivers: [], warnings: [], tags: [], lineupStatus: "posted", weatherStatus: "estimated",
    gameStatus: "final", firstPitchLockEligible: false, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    status: "graded", suppressed: false, suppressedReasons: [],
    outcomes: { hitHr: true, outcome: "pregame_win", userVisible: true }, everPubliclyFlagged: true,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      batterPowerScore: 8, pitcherVulnerabilityScore: 7, matchupFitScore: 6, parkWeatherScore: 6,
      lineupOpportunityScore: 6, marketFitScore: 7, dataCoverageScore: 0.95, suppressed: false,
      suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: { lineup: true, batterPower: true, pitcherProfile: true, park: true, weather: true, bvp: false },
    } as any,
    ...over,
  };
}

async function withPatchedUpsert(impl: (row: any) => Promise<unknown>, run: () => Promise<void>) {
  (storage as any).upsertPregamePowerRadarSignal = impl;
  try {
    await run();
  } finally {
    (storage as any).upsertPregamePowerRadarSignal = originalUpsert;
  }
}

async function main() {
  // ── Write succeeds on the first attempt — no retry needed ──────────────────
  await withPatchedUpsert(
    async () => undefined,
    async () => {
      const result = await persistSignalWithRetry(makeSignal({ signalId: "s-first-try" }));
      ok(result === true, "succeeds immediately when the write succeeds first try");
    },
  );

  // ── Write fails every attempt — exhausts retries, reports failure ──────────
  await withPatchedUpsert(
    async () => { throw new Error("simulated DB outage"); },
    async () => {
      const result = await persistSignalWithRetry(makeSignal({ signalId: "s-always-fails" }), 2);
      ok(result === false, "reports failure only after every retry attempt is exhausted");
    },
  );

  // ── Write fails once, then succeeds — recovers within the retry budget ─────
  await withPatchedUpsert(
    (() => {
      let calls = 0;
      return async () => {
        calls++;
        if (calls === 1) throw new Error("transient failure");
        return undefined;
      };
    })(),
    async () => {
      const result = await persistSignalWithRetry(makeSignal({ signalId: "s-recovers" }), 2);
      ok(result === true, "recovers and reports success when a later attempt within budget succeeds");
    },
  );

  console.log(`\npersistSignalWithRetry.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
