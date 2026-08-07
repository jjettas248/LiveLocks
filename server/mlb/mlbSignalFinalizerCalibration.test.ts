// MLB Live Edge Stage C PR3 — calibration flows through the finalizer ONLY when
// the promotion flag is on and a compatible active calibrator is loaded. The raw
// engine probability is never mutated. With the flag off (default), behavior is
// byte-identical to Stage A (calibratedCandidateProbability stays null).
//
// Run: npx tsx server/mlb/mlbSignalFinalizerCalibration.test.ts

process.env.ODDS_API_KEY = process.env.ODDS_API_KEY || "test-key-1";

import { finalizeMlbSignal } from "./mlbSignalFinalizer";
import { resolveMlbCalibrationPromotionEnabled } from "./productionPolicy";
import {
  setActiveCalibratorRegistry,
  __resetActiveCalibratorRegistryForTest,
} from "./stageC/activeCalibratorRegistry";
import { MLB_CALIBRATION_ARTIFACT_VERSION, type MlbActiveCalibrator, type MlbCalibrationArtifact } from "@shared/mlbCalibration";
import type { MLBQualifiedSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function sig(overrides: Partial<MLBQualifiedSignal> = {}): MLBQualifiedSignal {
  return {
    id: "g1_p1_hits", gameId: "g1", playerId: "p1", playerName: "CAL_TEST", team: "NYY",
    market: "hits", side: "OVER", sportsbook: "draftkings", line: 1.5, impliedProbability: null,
    engineProbability: 65, projection: 2.1, evPct: 5, confidenceTier: "STRONG", signalTier: "strong",
    signalScore: 70, reasons: [], feedTags: [], signalTags: [], playerGlowEligible: false,
    gameCardSignalTags: [], formIndicator: "steady" as any, isExperimental: false,
    engineGeneratedAt: Date.now(), badges: [], riskFlags: [], drivers: {},
    timestamps: { engineGeneratedAt: new Date().toISOString(), oddsUpdatedAt: new Date().toISOString(), gameStateUpdatedAt: new Date().toISOString() },
    fallbackUsed: false, actionable: true, alreadyHit: false, stale: false, watchlist: false,
    overOdds: -120, underOdds: 105, oddsTimestamp: Date.now(), pitcherName: "P", pitcherHand: "R",
    pitcherPitchCount: 40, pitcherTimesThrough: 1, homeScore: 0, awayScore: 0, inning: 6,
    isTopInning: true, currentStat: 0, completedAB: 1, bookImplied: null, priorABResults: [],
    currentStatKnown: true, ...overrides,
  } as MLBQualifiedSignal;
}

function artifact(segment: string, mapTo: number): MlbCalibrationArtifact {
  // Single-support mapping around center 0.65 → `mapTo`/100 so a raw 65 lands in
  // support and calibrates to mapTo.
  return {
    segment, method: "reliability_isotonic_v1",
    bins: [
      { lo: 0.55, hi: 0.65, center: 0.60, count: 100, empiricalRate: mapTo / 100 - 0.03, calibratedRate: mapTo / 100 - 0.03 },
      { lo: 0.65, hi: 0.75, center: 0.70, count: 100, empiricalRate: mapTo / 100 + 0.03, calibratedRate: mapTo / 100 + 0.03 },
    ],
    fitStats: { sampleSize: 200, distinctSlateDates: 20, basePositiveRate: 0.6, rawBrier: 0.28, calibratedBrier: 0.23, rawLogLoss: 0.7, calibratedLogLoss: 0.6, rawEcePct: 9, calibratedEcePct: 2, inSample: true },
    builtAtMs: 1_700_000_000_000, ledgerContractVersion: "mlb_prediction_ledger_v1", artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
}

function activeCal(segment: string, mapTo: number): MlbActiveCalibrator {
  return {
    segment, artifactId: `${segment}:1`, artifact: artifact(segment, mapTo), active: true,
    activatedAtMs: 1_700_000_000_000, activatedBy: "auto_promotion_runner", promotionEvidence: null,
    deactivatedAtMs: null, deactivationReason: null,
    ledgerContractVersion: "mlb_prediction_ledger_v1", artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
}

// FLAG OFF (default) ⇒ no calibration even with a calibrator loaded.
{
  __resetActiveCalibratorRegistryForTest();
  delete (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED;
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([activeCal("hits", 58)], 1_700_000_000_000);

  const f = finalizeMlbSignal(sig());
  ok(f.calibratedCandidateProbability === null, "flag OFF ⇒ calibratedCandidateProbability null even with a loaded calibrator");
  ok(f.outcomeProbabilitySemantics === "raw_provisional", "flag OFF ⇒ raw_provisional semantics");
  ok(f.probability === 65, "raw engine probability unchanged (65)");
}

// FLAG ON + compatible calibrator ⇒ calibrated stamped, semantics flip, raw kept.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([activeCal("hits", 60)], 1_700_000_000_000);

  const f = finalizeMlbSignal(sig());
  ok(f.calibratedCandidateProbability != null, "flag ON + calibrator ⇒ calibratedCandidateProbability stamped");
  ok(Math.abs((f.calibratedCandidateProbability as number) - 60) < 0.5, "calibrated value ~60 (65 mapped into support)");
  ok(f.outcomeProbabilitySemantics === "outcome_calibrated", "flag ON + calibrator ⇒ outcome_calibrated semantics");
  ok(f.probability === 65, "raw engine probability STILL unchanged (65) — calibration is a decision input only");
}

// FLAG ON but no calibrator for the market ⇒ uncalibrated (null), raw kept.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([activeCal("total_bases", 60)], 1_700_000_000_000);

  const f = finalizeMlbSignal(sig({ market: "hits" }));
  ok(f.calibratedCandidateProbability === null && f.outcomeProbabilitySemantics === "raw_provisional", "no calibrator for the market ⇒ stays raw_provisional (never identity copy)");
}

// home_runs is never calibrated (HR Radar owns its lifecycle), flag on or not.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([activeCal("home_runs", 60)], 1_700_000_000_000);

  const f = finalizeMlbSignal(sig({ market: "home_runs", line: 0.5 }));
  ok(f.calibratedCandidateProbability === null, "home_runs never calibrated through this path");
}

// Restore default off.
__resetActiveCalibratorRegistryForTest();
delete (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED;
resolveMlbCalibrationPromotionEnabled();

console.log(`\nmlbSignalFinalizerCalibration.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
