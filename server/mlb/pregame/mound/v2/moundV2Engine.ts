// Mound Radar V2 (shadow) — distributional engine.
//
// SHADOW ONLY. This module is never imported by buildMlbMoundRadar.ts,
// scoring.ts, moundDirection.ts, moundOutcomeAttribution.ts,
// evaluationSnapshot.ts, moundGradedStateCarry.ts, or any server/storage.ts
// mound method. score10 stays a matchup-quality composite (see scoring.ts);
// this module produces a genuine outcome PROBABILITY distribution alongside
// it, for research/backtesting only, until a promotion decision is made via
// moundV2PromotionGate.ts.
//
// Method: the strikeout count is a Poisson-binomial mixture — for every
// plausible "batters faced" count n (weighted by the workload model's
// battersFacedPmf), the n batters actually faced (cycling through the
// confirmed batting order) each contribute an independent strikeout trial,
// aggregated via poissonBinomialPmf; those n-conditional distributions are
// then weight-mixed into the unconditional strikeout distribution. Outs
// recorded is a separate, directly-modeled negative-binomial workload read
// (see battersFacedWorkloadModel.ts's header for why these are not derived
// from one another).

import { poissonBinomialPmf, mixPmfInto, normalizePmf, computeLineProbabilities, expectedValueOfPmf } from "./moundV2Math";
import { computeWorkloadDistributions } from "./battersFacedWorkloadModel";
import { LEAGUE_K_RATE } from "./batterStrikeoutProbability";
import type { MoundV2Inputs, MoundV2Distribution, MoundV2MarketResult } from "./moundV2Types";

const MAX_STRIKEOUTS_SUPPORT = 25;

function buildMarketResult(pmf: number[], line: number | null | undefined): MoundV2MarketResult {
  const expectedValue = expectedValueOfPmf(pmf);
  if (line == null) {
    return { overProbability: 0, underProbability: 0, pushProbability: 0, expectedValue, line: null };
  }
  const { over, under, push } = computeLineProbabilities(pmf, line);
  return { overProbability: over, underProbability: under, pushProbability: push, expectedValue, line };
}

export function computeMoundV2Distribution(inputs: MoundV2Inputs): MoundV2Distribution {
  const workload = computeWorkloadDistributions(inputs.workload);

  const lineupAvailable = inputs.batters.length > 0;
  // No confirmed lineup at all degrades to a single neutral league-average
  // "batter" that the cycling loop repeats for every trial — mathematically
  // valid (still sum-to-1), just low-confidence, flagged via dataAvailable.
  const orderedProbs = lineupAvailable
    ? inputs.batters
        .slice()
        .sort((a, b) => a.battingOrderSlot - b.battingOrderSlot)
        .map((b) => b.strikeoutProbability)
    : [LEAGUE_K_RATE];
  const lineupSize = orderedProbs.length;

  let strikeoutsPmf: number[] = [0];
  for (let n = 0; n < workload.battersFacedPmf.length; n++) {
    const weight = workload.battersFacedPmf[n];
    if (weight <= 0) continue;
    const trialProbs: number[] = [];
    for (let i = 0; i < n; i++) trialProbs.push(orderedProbs[i % lineupSize]);
    const conditionalPmf = poissonBinomialPmf(trialProbs);
    strikeoutsPmf = mixPmfInto(strikeoutsPmf, conditionalPmf, weight);
  }
  strikeoutsPmf = normalizePmf(strikeoutsPmf, MAX_STRIKEOUTS_SUPPORT);

  return {
    strikeouts: buildMarketResult(strikeoutsPmf, inputs.strikeoutsLine),
    outs: buildMarketResult(workload.outsPmf, inputs.outsLine),
    strikeoutsPmf,
    outsPmf: workload.outsPmf,
    diagnostics: {
      dataAvailable: workload.dataAvailable && lineupAvailable,
      battersInLineup: inputs.batters.length,
      expectedBattersFaced: workload.expectedBattersFaced,
      expectedOuts: workload.expectedOuts,
    },
  };
}
