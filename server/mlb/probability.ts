import type { MLBMarket } from "./types";
import { MARKET_SIGMA } from "./types";

function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

export function computeRawProbability(
  projection: number,
  bookLine: number,
  market: MLBMarket
): { overProb: number; underProb: number } {
  const sigma = MARKET_SIGMA[market];
  const diff = projection - bookLine;
  const zScore = diff / sigma;
  const overProb = normalCDF(zScore) * 100;
  const underProb = 100 - overProb;

  return {
    overProb: Math.round(overProb * 100) / 100,
    underProb: Math.round(underProb * 100) / 100,
  };
}
