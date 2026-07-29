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
// Method: strikeouts and outs recorded are NOT modeled as two independent
// distributions (an earlier version of this file did that, and could
// produce incoherent joint states — e.g. an outs realization inconsistent
// with the same start's batters-faced realization). Both now come from ONE
// coherent process: for every plausible "batters faced" count n (weighted
// by the workload model's battersFacedPmf), the n batters actually faced
// (cycling through the confirmed batting order) are run one at a time
// through moundV2Math.ts's joint (strikeouts, outs) process — each trial is
// a strikeout, a non-strikeout out, or an on-base event, so a strikeout
// always increments both strikeouts AND outs together, structurally
// guaranteeing strikeouts <= outs <= batters faced in every reachable state.
// The joint table is built incrementally (one trial at a time) so its
// strikeout/outs marginals can be snapshotted and weight-mixed after EVERY
// n, without rebuilding the table from scratch per n.

import {
  stepJointStrikeoutOutsPmf,
  marginalizeJointPmf,
  mixPmfInto,
  normalizePmf,
  computeLineProbabilities,
  expectedValueOfPmf,
} from "./moundV2Math";
import { computeWorkloadDistributions } from "./battersFacedWorkloadModel";
import { LEAGUE_K_RATE } from "./batterStrikeoutProbability";
import type { MoundV2Inputs, MoundV2Distribution, MoundV2MarketResult } from "./moundV2Types";

const MAX_STRIKEOUTS_SUPPORT = 25;
const MAX_OUTS_SUPPORT = 33;

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

  const maxN = workload.battersFacedPmf.length - 1;

  let jointTable: number[][] = [[1]]; // n=0: P(0 strikeouts, 0 outs) = 1
  let strikeoutsPmfAcc: number[] = [0];
  let outsPmfAcc: number[] = [0];

  const weight0 = workload.battersFacedPmf[0] ?? 0;
  if (weight0 > 0) {
    strikeoutsPmfAcc = mixPmfInto(strikeoutsPmfAcc, marginalizeJointPmf(jointTable, "strikeouts"), weight0);
    outsPmfAcc = mixPmfInto(outsPmfAcc, marginalizeJointPmf(jointTable, "outs"), weight0);
  }

  for (let n = 1; n <= maxN; n++) {
    const batterProb = orderedProbs[(n - 1) % lineupSize];
    jointTable = stepJointStrikeoutOutsPmf(jointTable, batterProb, workload.nonStrikeoutOutRate);
    const weight = workload.battersFacedPmf[n] ?? 0;
    if (weight <= 0) continue;
    strikeoutsPmfAcc = mixPmfInto(strikeoutsPmfAcc, marginalizeJointPmf(jointTable, "strikeouts"), weight);
    outsPmfAcc = mixPmfInto(outsPmfAcc, marginalizeJointPmf(jointTable, "outs"), weight);
  }

  const strikeoutsPmf = normalizePmf(strikeoutsPmfAcc, MAX_STRIKEOUTS_SUPPORT);
  const outsPmf = normalizePmf(outsPmfAcc, MAX_OUTS_SUPPORT);

  return {
    strikeouts: buildMarketResult(strikeoutsPmf, inputs.strikeoutsLine),
    outs: buildMarketResult(outsPmf, inputs.outsLine),
    strikeoutsPmf,
    outsPmf,
    diagnostics: {
      dataAvailable: workload.dataAvailable && lineupAvailable,
      battersInLineup: inputs.batters.length,
      expectedBattersFaced: workload.expectedBattersFaced,
      expectedOuts: expectedValueOfPmf(outsPmf),
    },
  };
}
