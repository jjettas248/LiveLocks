import type { MLBMarket } from "./types";

export interface DirectionalBiasState {
  market: MLBMarket;
  windowSize: number;
  overCount: number;
  underCount: number;
  ratio: number;
  expectedRatio: number;
  drift: number;
  correctionFactor: number;
}

export const EXPECTED_DIRECTION_RATIOS: Record<MLBMarket, number> = {
  hits: 0.45,
  total_bases: 0.48,
  home_runs: 0.35,
  hrr: 0.50,
  pitcher_strikeouts: 0.52,
  pitcher_outs: 0.50,
  hits_allowed: 0.50,
  walks_allowed: 0.48,
  batter_strikeouts: 0.52,
  hr_allowed: 0.40,
};

const DRIFT_THRESHOLD = 0.10;
const MAX_CORRECTION = 0.03;
const WINDOW_SIZE = 200;
const MIN_SAMPLE_FOR_CORRECTION = 200;

const rollingWindows = new Map<MLBMarket, Array<"OVER" | "UNDER">>();

export function trackSignalDirection(market: MLBMarket, side: "OVER" | "UNDER"): void {
  if (!rollingWindows.has(market)) {
    rollingWindows.set(market, []);
  }
  const window = rollingWindows.get(market)!;
  window.push(side);
  if (window.length > WINDOW_SIZE) {
    window.shift();
  }
}

export function getDirectionalBiasState(market: MLBMarket): DirectionalBiasState {
  const window = rollingWindows.get(market) ?? [];
  const total = window.length;
  const overCount = window.filter(s => s === "OVER").length;
  const underCount = total - overCount;
  const ratio = total > 0 ? overCount / total : 0.50;
  const expectedRatio = EXPECTED_DIRECTION_RATIOS[market] ?? 0.50;
  const drift = ratio - expectedRatio;

  let correctionFactor = 0;
  if (total >= MIN_SAMPLE_FOR_CORRECTION && Math.abs(drift) > DRIFT_THRESHOLD) {
    correctionFactor = Math.min(Math.abs(drift) * 0.15, MAX_CORRECTION);
    if (drift > 0) correctionFactor = -correctionFactor;
  }

  return {
    market,
    windowSize: total,
    overCount,
    underCount,
    ratio: Math.round(ratio * 1000) / 1000,
    expectedRatio,
    drift: Math.round(drift * 1000) / 1000,
    correctionFactor: Math.round(correctionFactor * 10000) / 10000,
  };
}

export function getDirectionalCorrection(
  market: MLBMarket,
  rawProbability: number,
  side: "OVER" | "UNDER"
): number {
  const state = getDirectionalBiasState(market);

  if (state.windowSize < MIN_SAMPLE_FOR_CORRECTION) return rawProbability;
  if (Math.abs(state.drift) <= DRIFT_THRESHOLD) return rawProbability;

  let adjustment = state.correctionFactor;
  if (side === "UNDER") adjustment = -adjustment;

  const corrected = rawProbability + adjustment * 100;
  return Math.min(99, Math.max(1, corrected));
}

export function getAllDirectionalBiasStates(): DirectionalBiasState[] {
  const allMarkets: MLBMarket[] = [
    "hits", "total_bases", "home_runs", "hrr",
    "pitcher_strikeouts", "pitcher_outs", "hits_allowed",
    "walks_allowed", "batter_strikeouts", "hr_allowed",
  ];
  return allMarkets.map(m => getDirectionalBiasState(m));
}
