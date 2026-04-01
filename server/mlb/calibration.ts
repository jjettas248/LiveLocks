import type { MLBMarket } from "./types";
import type { MLBBatterArchetype, MLBPitcherArchetype } from "./archetypes";
import {
  getCalibrationShrinkage,
  getMLBSafetyCeiling,
  MARKET_VOLATILITY,
} from "./archetypes";
import {
  getDirectionalCorrection,
  trackSignalDirection,
} from "./directionalBias";

const DEFAULT_SHRINK = 0.92;

export function calibrateProbability(
  rawProb: number,
  archetype?: MLBBatterArchetype | MLBPitcherArchetype | null,
  market?: MLBMarket | null,
  isPitcherMarket?: boolean
): number {
  let shrinkage = DEFAULT_SHRINK;

  if (archetype && market) {
    shrinkage = getCalibrationShrinkage(archetype, market, isPitcherMarket ?? false);
  }

  const shifted = rawProb - 50;
  const calibrated = 50 + shifted * shrinkage;
  return Math.round(Math.min(99, Math.max(1, calibrated)) * 100) / 100;
}

export function applySafetyCeiling(
  calibratedProb: number,
  archetype: MLBBatterArchetype | MLBPitcherArchetype | null,
  market: MLBMarket
): { probability: number; ceilingApplied: boolean; ceiling: number } {
  if (!archetype) {
    return { probability: calibratedProb, ceilingApplied: false, ceiling: 99 };
  }

  const ceiling = getMLBSafetyCeiling(archetype, market);
  if (calibratedProb > ceiling) {
    console.log(`[MLB_CEILING] archetype=${archetype} market=${market} raw=${calibratedProb.toFixed(1)} capped=${ceiling}`);
    return { probability: ceiling, ceilingApplied: true, ceiling };
  }

  return { probability: calibratedProb, ceilingApplied: false, ceiling };
}

export function applyDirectionalBias(
  probability: number,
  market: MLBMarket,
  side: "OVER" | "UNDER"
): number {
  trackSignalDirection(market, side);
  return getDirectionalCorrection(market, probability, side);
}

export { MARKET_VOLATILITY };
