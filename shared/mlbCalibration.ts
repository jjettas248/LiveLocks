// ── LiveLocks MLB Live Edge — Stage C: Calibration Artifact Contract ─────────
// Stage B (shared/mlbPredictionLedger.ts) captures every all-lane prediction and
// grades it against the real outcome. Stage C is the OFFLINE calibrator that
// reads that graded dataset and fits a raw→calibrated probability mapping — the
// value Stage A deliberately left `null` until a compatible calibrator exists.
//
// This file is the transport contract only: a frozen, versioned calibration
// ARTIFACT plus the pure `applyCalibrator` that maps a raw engine probability to
// a calibrated one. Fitting lives in server/mlb/stageC/*.
//
// CRITICAL — calibration is OFFLINE and GATED:
//   * Producing an artifact NEVER promotes it. Nothing in the live engine reads
//     an artifact until an explicit, human-reviewed promotion step wires it in
//     (see server/mlb/stageC/calibratorPromotionGate.ts — a checker that is
//     never auto-applied). Until then production stays fail-closed/shadow and
//     mlbProductionLane keeps `calibratedProbability = null` (Stage A rule).
//   * applyCalibrator is a pure, monotonic, clamped mapping — it is the function
//     a FUTURE promotion would call; importing/using it here does not wire it
//     into the engine.
//
// Pure, no I/O. Shared so the fitter, a future promotion path, and any admin
// read surface speak one shape.

export const MLB_CALIBRATION_METHODS = ["reliability_isotonic_v1"] as const;
export type MlbCalibrationMethod = (typeof MLB_CALIBRATION_METHODS)[number];

export const MLB_CALIBRATION_ARTIFACT_VERSION = "mlb_calibration_v1" as const;

// One predicted-probability bin. All probabilities are 0..1 fractions here (the
// engine's 0..100 scale is converted at the apply boundary). `calibratedRate` is
// the post-shrinkage, isotonic (monotonic non-decreasing) mapped value.
export interface MlbCalibrationBin {
  lo: number;             // bin lower edge (inclusive), 0..1
  hi: number;             // bin upper edge (exclusive, except the last), 0..1
  center: number;         // mean predicted probability of the obs in this bin, 0..1
  count: number;          // decided observations (cashed + missed) in this bin
  empiricalRate: number;  // raw cashed / count, 0..1 (pre-shrinkage/isotonic)
  calibratedRate: number; // shrunk + isotonic value, 0..1, non-decreasing in center
}

export interface MlbCalibrationFitStats {
  sampleSize: number;          // decided observations (push/void excluded)
  distinctSlateDates: number;  // unique ET slate dates in the fit set
  basePositiveRate: number;    // global cashed rate over the fit set, 0..1
  rawBrier: number;
  calibratedBrier: number;
  rawLogLoss: number;
  calibratedLogLoss: number;
  rawEcePct: number;           // expected calibration error, percentage points
  calibratedEcePct: number;
  // Honesty flag: these are FIT-SET (in-sample) metrics. Promotion requires
  // held-out / walk-forward evidence — see calibratorPromotionGate.ts.
  inSample: boolean;
}

export interface MlbCalibrationArtifact {
  segment: string;             // e.g. market key ("hits") or "market:lane"
  method: MlbCalibrationMethod;
  bins: MlbCalibrationBin[];   // ascending by center; calibratedRate non-decreasing
  fitStats: MlbCalibrationFitStats;
  builtAtMs: number;
  ledgerContractVersion: string; // the Stage B contract version at fit time
  artifactVersion: typeof MLB_CALIBRATION_ARTIFACT_VERSION;
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Maps a raw engine probability (0..100) to a calibrated probability (0..100)
 * using the artifact's bins: piecewise-linear interpolation across bin centers
 * of `calibratedRate`, flat-extrapolated beyond the first/last center, clamped
 * to [0,100]. Monotonic non-decreasing by construction (centers ascending,
 * calibratedRate non-decreasing). Returns null when the artifact has no bins
 * (no compatible calibrator ⇒ caller keeps calibratedProbability null, never an
 * identity copy — Stage A rule).
 */
export function applyCalibrator(artifact: MlbCalibrationArtifact, rawProbPct: number): number | null {
  const bins = artifact.bins;
  if (!bins || bins.length === 0) return null;
  if (!Number.isFinite(rawProbPct)) return null;

  const x = clamp01(rawProbPct / 100);

  // Build ascending (center, calibratedRate) knots, collapsing duplicate centers
  // to their max calibratedRate (keeps monotonicity, avoids divide-by-zero).
  const knots: Array<{ c: number; v: number }> = [];
  for (const b of bins) {
    const c = clamp01(b.center);
    const v = clamp01(b.calibratedRate);
    const last = knots[knots.length - 1];
    if (last && Math.abs(last.c - c) < 1e-12) {
      last.v = Math.max(last.v, v);
    } else {
      knots.push({ c, v });
    }
  }
  if (knots.length === 1) return Math.round(clamp01(knots[0].v) * 100 * 100) / 100;

  if (x <= knots[0].c) return round2(knots[0].v * 100);
  if (x >= knots[knots.length - 1].c) return round2(knots[knots.length - 1].v * 100);

  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    if (x >= a.c && x <= b.c) {
      const span = b.c - a.c;
      const t = span > 1e-12 ? (x - a.c) / span : 0;
      const v = a.v + t * (b.v - a.v);
      return round2(clamp01(v) * 100);
    }
  }
  // Unreachable given the bounds checks above, but fail-closed.
  return round2(knots[knots.length - 1].v * 100);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * True when `rawProbPct` falls within the artifact's FITTED support — i.e.
 * between the lowest and highest bin centers. Outside that range applyCalibrator
 * flat-extrapolates (monotonic but distorted for the most confident inputs), so
 * a future promotion's application layer should treat out-of-support inputs as
 * uncalibrated (calibratedProbability = null) rather than ship an extrapolated
 * value. Fail-closed: no bins / non-finite input ⇒ false (not in support).
 */
export function isWithinCalibratorSupport(artifact: MlbCalibrationArtifact, rawProbPct: number): boolean {
  const bins = artifact.bins;
  if (!bins || bins.length === 0) return false;
  if (!Number.isFinite(rawProbPct)) return false;
  const x = clamp01(rawProbPct / 100);
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bins) {
    const c = clamp01(b.center);
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  return x >= lo && x <= hi;
}
