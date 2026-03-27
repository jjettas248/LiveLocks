const SHRINK = 0.92;

export function calibrateProbability(rawProb: number): number {
  const shifted = rawProb - 50;
  const calibrated = 50 + shifted * SHRINK;
  return Math.round(Math.min(99, Math.max(1, calibrated)) * 100) / 100;
}
