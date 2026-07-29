// Mound Radar V2 (shadow) — workload distributions (batters faced + outs).
//
// Two SEPARATE distributions, not one derived from the other: batters faced
// drives the strikeout aggregation (each batter faced gets an independent
// strikeout trial); outs recorded is its own workload read for the
// pitcher_outs market. Modeling one as a deterministic function of the other
// would require simulating baserunner accumulation inning-by-inning — out of
// scope and not something this codebase's data supports; instead each gets
// its own negative-binomial (a standard, real overdispersed count model for
// pitcher workload — variance genuinely exceeds the mean because some starts
// end early via a quick hook or fatigue and some run long).
//
// No per-pitcher batting-average/OBP-against data source exists anywhere in
// this codebase (confirmed against pitcherSkill.ts/workload.ts's own input
// sets) — LEAGUE_AVG_BATTERS_PER_INNING stays a single documented league
// constant rather than a fabricated precise per-pitcher figure, exactly the
// same discipline matchupAdjustedKs.ts already applies to its own "no
// K-specific park factor exists" run-environment nudge.

import { negativeBinomialPmf } from "./moundV2Math";
import { clamp } from "../scoreUtils";
import type { MoundV2WorkloadInputs } from "./moundV2Types";

const LEAGUE_AVG_BATTERS_PER_INNING = 4.3;
const DEFAULT_AVG_INNINGS = 5.2;
const DEFAULT_INNINGS_STD = 1.5;
const MIN_INNINGS_STD = 0.5;

const MAX_OUTS_SUPPORT = 33; // an 11-inning relief-assisted complete team effort is already extreme; generous ceiling
const MAX_BATTERS_FACED_SUPPORT = 42;

export interface WorkloadDistributions {
  battersFacedPmf: number[];
  outsPmf: number[];
  expectedBattersFaced: number;
  expectedOuts: number;
  /** False when the pitcher's own avgInningsPerStart is unavailable — DEFAULT_AVG_INNINGS is used as a neutral fallback rather than fabricating a confident number. */
  dataAvailable: boolean;
}

export function computeWorkloadDistributions(inputs: MoundV2WorkloadInputs): WorkloadDistributions {
  const dataAvailable = inputs.avgInningsPerStart != null;
  const avgInnings = inputs.avgInningsPerStart ?? DEFAULT_AVG_INNINGS;

  const inningsStd =
    inputs.ipVarianceLast3 != null
      ? Math.max(Math.sqrt(inputs.ipVarianceLast3), MIN_INNINGS_STD)
      : DEFAULT_INNINGS_STD;

  // Pitch-count efficiency and walk rate both nudge expected outs DOWN when
  // elevated (a quicker hook) — the same two real signals workload.ts's
  // score10 component already reads, applied here as a bounded multiplicative
  // adjustment to the workload mean rather than a new fabricated input.
  const pitchesPerInning =
    inputs.lastStartPitchCount != null && inputs.lastStartInningsPitched != null && inputs.lastStartInningsPitched > 0
      ? inputs.lastStartPitchCount / inputs.lastStartInningsPitched
      : null;
  const efficiencyAdjustment = pitchesPerInning != null ? clamp(1 - (pitchesPerInning - 16) * 0.012, 0.88, 1.05) : 1;
  const walkAdjustment = inputs.bbPer9 != null ? clamp(1 - (inputs.bbPer9 - 3.0) * 0.02, 0.88, 1.05) : 1;

  const adjustedAvgInnings = Math.max(0.1, avgInnings * efficiencyAdjustment * walkAdjustment);

  const expectedOuts = adjustedAvgInnings * 3;
  const outsVariance = (inningsStd * 3) ** 2;
  const maxOuts = Math.min(MAX_OUTS_SUPPORT, Math.ceil(expectedOuts + 8 * Math.sqrt(outsVariance)) + 3);
  const outsPmf = negativeBinomialPmf(expectedOuts, outsVariance, maxOuts);

  const expectedBattersFaced = adjustedAvgInnings * LEAGUE_AVG_BATTERS_PER_INNING;
  const battersFacedVariance = (inningsStd * LEAGUE_AVG_BATTERS_PER_INNING) ** 2;
  const maxBattersFaced = Math.min(MAX_BATTERS_FACED_SUPPORT, Math.ceil(expectedBattersFaced + 8 * Math.sqrt(battersFacedVariance)) + 3);
  const battersFacedPmf = negativeBinomialPmf(expectedBattersFaced, battersFacedVariance, maxBattersFaced);

  return { battersFacedPmf, outsPmf, expectedBattersFaced, expectedOuts, dataAvailable };
}
