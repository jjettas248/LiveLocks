// Component 6 — Market Tagger (weight 0 on score10).
//
// Classifies the best market(s) for a target. Phase 1 surfaces only
// `home_runs` + `total_bases`. `marketFitScore` is informational and NEVER
// modifies score10 (sportsbook edge, if ever added, lives in marketEdgeContext).
// Hits / RBI / HRR are Phase-5 (need lineup/run-environment context).

import type { ComponentScore, PowerDriver, PregamePowerMarket } from "./types";
import { round1, clamp10 } from "./scoreUtils";

/**
 * Markets `computeMarketTags` actually emits today (HR + Total Bases only — Hits/
 * RBI are Phase-5 and not built). Narrower than the broader product/persistence
 * type `PregamePowerMarket` so downstream power-family-only consumers (Attack
 * Environment) get a compile-time guarantee that a Hits/RBI/HRR value can never
 * reach them. `PregamePowerMarket` itself is untouched everywhere else.
 */
export type PregamePowerActiveMarket = Extract<PregamePowerMarket, "home_runs" | "total_bases">;

export interface MarketTaggerInputs {
  batterPowerScore: number; // 0–10
  pitcherVulnerabilityScore: number; // 0–10
  parkWeatherScore: number; // 0–10
  // Raw power-shape hints:
  hrFBRatioPct: number | null;
  xISO: number | null;
  hardHitRatePct: number | null;
}

/** Qualitative market-setup label — server-owned so the UI never re-derives it. */
export type MarketSetupLabel = "Elite" | "Strong" | "Solid" | "Watch";

export interface MarketSetup {
  market: PregamePowerMarket;
  /** Numeric 0–10 setup score — for expanded/detail/debug views only. */
  setupScore: number;
  /** Plain-English qualitative label rendered on the compact card. */
  setupLabel: MarketSetupLabel;
  isPrimary: boolean;
}

export interface MarketTaggerResult extends ComponentScore {
  primaryMarket: PregamePowerActiveMarket;
  marketTags: PregamePowerActiveMarket[];
  marketScores: Partial<Record<PregamePowerActiveMarket, number>>;
  marketSetups: MarketSetup[];
}

/** Map a 0–10 market-setup score onto its qualitative label (display contract). */
export function marketSetupLabel(score: number): MarketSetupLabel {
  if (score >= 8.5) return "Elite";
  if (score >= 7) return "Strong";
  if (score >= 6) return "Solid";
  return "Watch";
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

  const marketScores: Partial<Record<PregamePowerActiveMarket, number>> = {
    home_runs: round1(hrScore),
    total_bases: round1(tbScore),
  };

  // Primary market: HR when the HR ceiling is genuinely present, else TB.
  const eliteHrShape =
    (inputs.hrFBRatioPct != null && inputs.hrFBRatioPct >= 14) ||
    (inputs.xISO != null && inputs.xISO >= 0.2);
  let primaryMarket: PregamePowerActiveMarket;
  if (hrScore >= 6 && (eliteHrShape || hrScore >= tbScore)) {
    primaryMarket = "home_runs";
    drivers.push({ key: "mkt_hr", label: "HR Market Setup", direction: "positive", weight: Math.round(hrScore * 10) });
  } else {
    primaryMarket = "total_bases";
    drivers.push({ key: "mkt_tb", label: "Total Bases Setup", direction: "positive", weight: Math.round(tbScore * 10) });
  }

  const marketTags: PregamePowerActiveMarket[] = [];
  if (hrScore >= 6) marketTags.push("home_runs");
  if (tbScore >= 6) marketTags.push("total_bases");
  if (marketTags.length === 0) marketTags.push(primaryMarket);

  const marketFitScore = round1(Math.max(hrScore, tbScore));

  const marketSetups: MarketSetup[] = marketTags.map((market) => {
    const setupScore = marketScores[market] ?? 0;
    return {
      market,
      setupScore,
      setupLabel: marketSetupLabel(setupScore),
      isPrimary: market === primaryMarket,
    };
  });

  return {
    score10: marketFitScore,
    available: true,
    drivers,
    warnings,
    primaryMarket,
    marketTags,
    marketScores,
    marketSetups,
  };
}
