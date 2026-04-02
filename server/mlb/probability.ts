import type { MLBMarket } from "./types";
import { MARKET_SIGMA } from "./types";

// ── Value clamps ──────────────────────────────────────────────────────────────

export function clampProjection(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, p);
}

export function clampProbability(prob: number): number {
  if (!Number.isFinite(prob)) return 5;
  return Math.min(96, Math.max(5, prob));
}

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
  const clampedProjection = clampProjection(projection);
  const diff = clampedProjection - bookLine;
  const zScore = diff / sigma;
  const rawOver = normalCDF(zScore) * 100;
  const rawUnder = 100 - rawOver;

  return {
    overProb: Math.round(clampProbability(rawOver) * 100) / 100,
    underProb: Math.round(clampProbability(rawUnder) * 100) / 100,
  };
}
