// Component 6 — Market Tagger (weight 0 on score10).
//
// Classifies the best market(s) for a target. Phase 1 surfaces only
// `home_runs` + `total_bases`. `marketFitScore` is informational and NEVER
// modifies score10 (sportsbook edge, if ever added, lives in marketEdgeContext).
// Hits / RBI / HRR are Phase-5 (need lineup/run-environment context).

import type { ComponentScore, PowerDriver, PregamePowerMarket } from "./types";
import { round1, clamp10 } from "./scoreUtils";

export interface MarketTaggerInputs {
  batterPowerScore: number; // 0–10
  pitcherVulnerabilityScore: number; // 0–10
  parkWeatherScore: number; // 0–10
  // Raw power-shape hints:
  hrFBRatioPct: number | null;
  xISO: number | null;
  hardHitRatePct: number | null;
}

export interface MarketTaggerResult extends ComponentScore {
  primaryMarket: PregamePowerMarket;
  marketTags: PregamePowerMarket[];
  marketScores: Partial<Record<PregamePowerMarket, number>>;
}

export function computeMarketTags(inputs: MarketTaggerInputs): MarketTaggerResult {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];

  // HR market: power + pitcher HR vulnerability + park/weather.
  const hrScore = clamp10(
    inputs.batterPowerScore * 0.5 +
      inputs.pitcherVulnerabilityScore * 0.3 +
      inputs.parkWeatherScore * 0.2,
  );

  // TB market: rewards strong contact/SLG profile even when the HR ceiling is sub-elite.
  const tbScore = clamp10(
    inputs.batterPowerScore * 0.45 +
      (inputs.hardHitRatePct != null ? Math.min(10, inputs.hardHitRatePct / 5.2) : inputs.batterPowerScore) * 0.35 +
      inputs.pitcherVulnerabilityScore * 0.2,
  );

  const marketScores: Partial<Record<PregamePowerMarket, number>> = {
    home_runs: round1(hrScore),
    total_bases: round1(tbScore),
  };

  // Primary market: HR when the HR ceiling is genuinely present, else TB.
  const eliteHrShape =
    (inputs.hrFBRatioPct != null && inputs.hrFBRatioPct >= 14) ||
    (inputs.xISO != null && inputs.xISO >= 0.2);
  let primaryMarket: PregamePowerMarket;
  if (hrScore >= 6 && (eliteHrShape || hrScore >= tbScore)) {
    primaryMarket = "home_runs";
    drivers.push({ key: "mkt_hr", label: "HR Market Setup", direction: "positive", weight: Math.round(hrScore * 10) });
  } else {
    primaryMarket = "total_bases";
    drivers.push({ key: "mkt_tb", label: "Total Bases Setup", direction: "positive", weight: Math.round(tbScore * 10) });
  }

  const marketTags: PregamePowerMarket[] = [];
  if (hrScore >= 6) marketTags.push("home_runs");
  if (tbScore >= 6) marketTags.push("total_bases");
  if (marketTags.length === 0) marketTags.push(primaryMarket);

  const marketFitScore = round1(Math.max(hrScore, tbScore));

  return {
    score10: marketFitScore,
    available: true,
    drivers,
    warnings,
    primaryMarket,
    marketTags,
    marketScores,
  };
}
