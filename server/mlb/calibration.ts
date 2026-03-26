const CALIBRATION_MAX = 88;
const CALIBRATION_MIN = 12;
const SHRINK = 0.92;

export function calibrateProbability(rawProb: number): number {
  const shifted = rawProb - 50;
  const calibrated = 50 + shifted * SHRINK;
  const clamped = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, calibrated));
  return Math.round(clamped * 100) / 100;
}
