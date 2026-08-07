// MLB Stage C PR3 — in-memory active-calibrator registry invariants.
//
// Run: npx tsx server/mlb/stageC/activeCalibratorRegistry.test.ts

import {
  setActiveCalibratorRegistry,
  lookupCalibratedProbability,
  getActiveCalibratorRegistrySnapshot,
  __resetActiveCalibratorRegistryForTest,
} from "./activeCalibratorRegistry";
import { resolveMlbCalibrationPromotionEnabled } from "../productionPolicy";
import { MLB_CALIBRATION_ARTIFACT_VERSION, type MlbActiveCalibrator, type MlbCalibrationArtifact } from "@shared/mlbCalibration";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NOW = 1_700_000_000_000;

function artifact(segment: string): MlbCalibrationArtifact {
  return {
    segment, method: "reliability_isotonic_v1",
    // Support spans centers 0.55..0.75; a monotone mapping that LOWERS the raw
    // prob (overconfident model): 0.55→0.52, 0.65→0.58, 0.75→0.62.
    bins: [
      { lo: 0.5, hi: 0.6, center: 0.55, count: 100, empiricalRate: 0.52, calibratedRate: 0.52 },
      { lo: 0.6, hi: 0.7, center: 0.65, count: 100, empiricalRate: 0.58, calibratedRate: 0.58 },
      { lo: 0.7, hi: 0.8, center: 0.75, count: 100, empiricalRate: 0.62, calibratedRate: 0.62 },
    ],
    fitStats: { sampleSize: 300, distinctSlateDates: 25, basePositiveRate: 0.57, rawBrier: 0.28, calibratedBrier: 0.23, rawLogLoss: 0.7, calibratedLogLoss: 0.6, rawEcePct: 9, calibratedEcePct: 2, inSample: true },
    builtAtMs: NOW, ledgerContractVersion: "mlb_prediction_ledger_v1", artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
  };
}

function active(segment: string, over?: Partial<MlbActiveCalibrator>): MlbActiveCalibrator {
  return {
    segment, artifactId: `${segment}:${NOW}`, artifact: artifact(segment), active: true,
    activatedAtMs: NOW, activatedBy: "auto_promotion_runner", promotionEvidence: null,
    deactivatedAtMs: null, deactivationReason: null,
    ledgerContractVersion: "mlb_prediction_ledger_v1", artifactVersion: MLB_CALIBRATION_ARTIFACT_VERSION,
    ...over,
  };
}

// GATE 1 — master switch OFF (default): lookup ALWAYS returns null, even loaded.
{
  __resetActiveCalibratorRegistryForTest();
  // Ensure default off (no env override in the test environment).
  delete (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED;
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([active("hits")], NOW);
  ok(lookupCalibratedProbability("hits", "official", 65) === null, "flag OFF ⇒ null even with a loaded compatible calibrator");
  ok(getActiveCalibratorRegistrySnapshot().enabled === false, "snapshot reports disabled");
}

// With the flag ON, the calibrator applies within support.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([active("hits")], NOW);

  const cal = lookupCalibratedProbability("hits", "official", 65);
  ok(cal != null && Math.abs((cal as number) - 58) < 0.001, "flag ON + in-support ⇒ calibrated value (65→58)");

  // GATE 3 — out of fitted support (centers 0.55..0.75): 90 is above ⇒ null.
  ok(lookupCalibratedProbability("hits", "official", 90) === null, "out-of-support raw prob ⇒ null (no extrapolation shipped)");
  ok(lookupCalibratedProbability("hits", "official", 40) === null, "below-support raw prob ⇒ null");
}

// GATE 2 — no compatible segment ⇒ null.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([active("hits")], NOW);
  ok(lookupCalibratedProbability("total_bases", "official", 65) === null, "unlisted segment ⇒ null");
}

// Segment-key precedence: market:lane wins over bare market.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  // Bare-market calibrator lowers to ~0.58; the lane-specific one raises to ~0.70.
  const laneArtifact = artifact("hits:official");
  laneArtifact.bins = laneArtifact.bins.map((b) => ({ ...b, calibratedRate: 0.70 }));
  setActiveCalibratorRegistry([active("hits"), active("hits:official", { artifact: laneArtifact })], NOW);
  const cal = lookupCalibratedProbability("hits", "official", 65);
  ok(cal != null && Math.abs((cal as number) - 70) < 0.001, "market:lane calibrator takes precedence over bare market");
}

// Inactive rows are ignored by setActiveCalibratorRegistry.
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([active("hits", { active: false })], NOW);
  ok(lookupCalibratedProbability("hits", "official", 65) === null, "inactive calibrator is not loaded into the registry");
  ok(getActiveCalibratorRegistrySnapshot().segments.length === 0, "snapshot excludes inactive rows");
}

// Non-finite raw prob ⇒ null (defensive).
{
  __resetActiveCalibratorRegistryForTest();
  (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED = "true";
  resolveMlbCalibrationPromotionEnabled();
  setActiveCalibratorRegistry([active("hits")], NOW);
  ok(lookupCalibratedProbability("hits", "official", NaN) === null, "NaN raw prob ⇒ null");
}

// Restore default off so we don't leak env state to other suites in a shared run.
delete (process.env as any).MLB_CALIBRATION_PROMOTION_ENABLED;
resolveMlbCalibrationPromotionEnabled();

console.log(`\nactiveCalibratorRegistry.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
