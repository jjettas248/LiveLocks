// Plate HR Probability V2 — frozen input contract invariants (PR 1).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/frozenPlateHrV2Input.test.ts

import {
  deepFreeze,
  freezePlateHrV2Input,
  hashFrozenPlateHrV2Input,
  toPregameMathInputs,
  type FrozenPlateHrV2Input,
} from "./frozenPlateHrV2Input";
import { scoreBatterTruePower } from "../math/scoreBatterTruePower";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseFrozenInput(): FrozenPlateHrV2Input {
  return {
    sessionDate: "2026-07-26",
    gameId: "game-1",
    batterId: "batter-1",
    pitcherId: "pitcher-1",
    batterHand: "R",
    body: {
      batterPower: {
        xISO: 0.18, xSLG: 0.42, xwOBAcon: 0.37, barrelRatePct: 8.5, hardHitRatePct: 40,
        exitVelocity: 90, maxEV: 108, flyBallPct: 35, hrFBRatioPct: 15, pullRatePct: 42,
        sweetSpotPct: 33, hrPerPaSeason: null, paSample: 210,
      },
      batTracking: {
        avgBatSpeed: 72, fastSwingRatePct: null, avgSwingLength: 7.2,
        squaredUpPerSwingPct: null, blastPerSwingPct: null, swingSample: null,
      },
      pitcherVulnerability: {
        pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 1.2,
        hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null,
        flyBallAllowedPct: null, bfSample: null,
      },
      pitchType: { families: [] },
      zoneLocation: {
        batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null,
        pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null,
      },
      parkWeatherSpray: {
        parkHrFactor: 1.05, parkHrFactorHand: 1.1, isIndoors: false, weatherAvailable: true,
        temperatureF: 75, windSpeedMph: 8, windDirection: "out", batterPullAirShare: 0.4,
      },
      lineupOpportunity: { battingOrderSlot: 3, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: true },
      starterBullpen: { starterConfirmed: true, projectedPaVsStarter: null, projectedPaVsBullpen: null, bullpenHrPer9: null, bullpenBarrelAllowedPct: null },
      market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null },
      availability: { confirmedActive: true, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null },
      contactOpportunity: { kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null, zoneContactRatePct: null, chaseRatePct: null },
      slateBaselineGameHrProbability: null,
    },
    dataQuality: { savantQuality: "full", venueResolved: true, pitcherHandResolved: true, batterPowerFullyAvailable: true },
  };
}

// ── 1. Hash stability under key reordering ──────────────────────────────────
{
  const a = baseFrozenInput();
  const bBody = { ...baseFrozenInput().body };
  // Reordered object-literal construction — same logical values, different
  // property insertion order at every level that matters.
  const b: FrozenPlateHrV2Input = {
    dataQuality: { pitcherHandResolved: true, batterPowerFullyAvailable: true, savantQuality: "full", venueResolved: true },
    batterHand: "R",
    pitcherId: "pitcher-1",
    batterId: "batter-1",
    gameId: "game-1",
    sessionDate: "2026-07-26",
    body: {
      ...bBody,
      batterPower: {
        paSample: 210, hrPerPaSeason: null, sweetSpotPct: 33, pullRatePct: 42, hrFBRatioPct: 15,
        flyBallPct: 35, maxEV: 108, exitVelocity: 90, hardHitRatePct: 40, barrelRatePct: 8.5,
        xwOBAcon: 0.37, xSLG: 0.42, xISO: 0.18,
      },
    },
  };
  ok(hashFrozenPlateHrV2Input(a) === hashFrozenPlateHrV2Input(b), "hash is stable under object-literal key reordering at every level");

  const c = baseFrozenInput();
  c.body.batterPower.xISO = 0.30;
  ok(hashFrozenPlateHrV2Input(a) !== hashFrozenPlateHrV2Input(c), "hash changes when an actual input value changes");
}

// ── 2. deepFreeze throws on mutation ─────────────────────────────────────────
{
  const frozen = freezePlateHrV2Input(baseFrozenInput());
  let threw = false;
  try {
    // @ts-expect-error — intentional mutation attempt against a frozen object
    frozen.body.batterPower.xISO = 999;
  } catch {
    threw = true;
  }
  // Object.freeze makes writes silently fail in non-strict mode but throw in
  // strict mode (ES modules are always strict) — either way the value must
  // not change.
  ok(frozen.body.batterPower.xISO !== 999, "deepFreeze prevents mutation of a nested value (strict-mode throw or silent no-op, never a successful write)");
  ok(threw || frozen.body.batterPower.xISO === 0.18, "mutation attempt either throws (strict mode) or is a silent no-op — value is preserved either way");
}

// ── 3. toPregameMathInputs() output is math/-compatible TODAY ───────────────
{
  const frozen = baseFrozenInput();
  const mathInputs = toPregameMathInputs(frozen);
  ok(mathInputs.playerId === frozen.batterId, "toPregameMathInputs maps batterId -> playerId");
  ok(mathInputs.gameId === frozen.gameId, "toPregameMathInputs preserves gameId");
  ok(mathInputs.batterPower === frozen.body.batterPower, "toPregameMathInputs passes batterPower through directly, no transformation");
  ok(!("contactOpportunity" in mathInputs), "toPregameMathInputs drops the PR1-only contactOpportunity extension — not part of PregameMathInputs");

  // Concrete proof, not just an assertion: feed the mapped output into a REAL
  // math/ scorer and confirm it runs without throwing and returns a valid
  // LogOddsTerm.
  const term = scoreBatterTruePower(mathInputs.batterPower);
  ok(typeof term.logOdds === "number" && Number.isFinite(term.logOdds), "a real math/ scorer (scoreBatterTruePower) accepts toPregameMathInputs()'s output and returns a finite logOdds");
  ok(term.available === true, "scoreBatterTruePower reports available:true for a fully-populated batterPower group");
}

console.log(`\nfrozenPlateHrV2Input.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
