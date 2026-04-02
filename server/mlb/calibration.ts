import type { MLBMarket } from "./types";
import type { MLBBatterArchetype, MLBPitcherArchetype } from "./archetypes";
import { MARKET_VOLATILITY } from "./archetypes";
import {
  getDirectionalCorrection,
  trackSignalDirection,
} from "./directionalBias";

export {
  calibrateModelProbability as calibrateProbability,
  applyModelSafetyCeiling as applySafetyCeiling,
} from "./probabilityEngine";

export function applyDirectionalBias(
  probability: number,
  market: MLBMarket,
  side: "OVER" | "UNDER"
): number {
  trackSignalDirection(market, side);
  return getDirectionalCorrection(market, probability, side);
}

export { MARKET_VOLATILITY };
