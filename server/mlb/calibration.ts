const CALIBRATION_MIDPOINT = 50;
const CALIBRATION_STEEPNESS = 0.06;
const CALIBRATION_MAX = 88;
const CALIBRATION_MIN = 12;

export function calibrateProbability(rawProb: number): number {
  const shifted = rawProb - CALIBRATION_MIDPOINT;
  const compressed =
    CALIBRATION_MIDPOINT +
    (shifted * CALIBRATION_STEEPNESS * 100) /
      Math.sqrt(1 + CALIBRATION_STEEPNESS * CALIBRATION_STEEPNESS * shifted * shifted);

  const clamped = Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, compressed));
  return Math.round(clamped * 100) / 100;
}
