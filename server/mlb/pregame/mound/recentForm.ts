// Mound Radar Component — Recent Form (weight 0.14).
//
// v1 real signal: last-3-start K trend + ERA trend, from the extended
// fetchPitcherRecentStarts() (dataPullService.ts). Independent from Plate's
// nearHrRecentForm.ts — different inputs, different thresholds, no shared code.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, weightedAvg, round1, seasonKPer9ToPerStartExpectation } from "./scoreUtils";

export interface RecentFormInputs {
  pitcherKnown: boolean;
  seasonKPer9: number | null;
  last3StartStrikeouts: number[] | null;
  last3StartERA: number | null;
}

export function computeRecentForm(inputs: RecentFormInputs): ComponentScore {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  if (!inputs.pitcherKnown) {
    warnings.push("Probable starter unknown");
    return { score10: 5, available: false, drivers, warnings };
  }

  const avgRecentK =
    inputs.last3StartStrikeouts && inputs.last3StartStrikeouts.length > 0
      ? inputs.last3StartStrikeouts.reduce((a, b) => a + b, 0) / inputs.last3StartStrikeouts.length
      : null;

  // Recent K form relative to season pace — trending up (>0) is a positive signal.
  const kTrend =
    avgRecentK != null && inputs.seasonKPer9 != null
      ? avgRecentK - seasonKPer9ToPerStartExpectation(inputs.seasonKPer9)
      : null;
  const sKTrend = kTrend != null ? lin(kTrend, -2, 2) : null;
  // Blow-up risk: elevated recent ERA vs a typical quality-start baseline.
  const sEra = inputs.last3StartERA != null ? lin(inputs.last3StartERA, 6.5, 2.5) : null;

  const { score, coverage } = weightedAvg([
    { value: sKTrend, weight: 2 },
    { value: sEra, weight: 1 },
  ]);

  if (coverage === 0) {
    warnings.push("No recent-start data available");
    return { score10: 5, available: false, drivers, warnings };
  }

  if (sKTrend != null && sKTrend >= 7) {
    drivers.push({
      key: "rf_k_form",
      label: "Recent K Form",
      direction: "positive",
      weight: Math.round(sKTrend * 10),
      evidence: avgRecentK != null ? `${round1(avgRecentK)} K avg last 3 starts` : undefined,
    });
  }
  if (sEra != null && sEra <= 3) {
    warnings.push("Blow-Up Risk");
    drivers.push({
      key: "rf_blowup",
      label: "Blow-Up Risk",
      direction: "negative",
      weight: 60,
      evidence: `Last-3-start ERA ${round1(inputs.last3StartERA ?? 0)}`,
    });
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
