// Mound Radar Component — Opponent K Profile (weight 0.20).
//
// Production K matchup now has BOTH sides of the plate appearance:
//   1. Pitcher's own strikeout tendency by hitter handedness, weighted by the
//      confirmed opposing lineup composition.
//   2. Each opposing hitter's strikeout propensity against the starter's
//      throwing hand, aggregated in opponentBatterKProfile.ts.
//
// The two rates are combined in log-odds space around the league K prior. That
// preserves a sensible league-average fixed point while allowing an elite K
// pitcher + high-K lineup to compound and a contact-heavy lineup to pull an
// otherwise strong pitcher back toward neutral.

import type { ComponentScore, MoundDriver } from "./types";
import { lin, round1, weightedPlatoonKRate } from "./scoreUtils";

const LEAGUE_K_RATE = 0.223;
const PITCHER_WEIGHT = 0.55;
const HITTER_WEIGHT = 0.45;

export interface OpponentKProfileInputs {
  pitcherKnown: boolean;
  opposingLineupConfirmed: boolean;
  kRateVsLHB: number | null;
  kRateVsRHB: number | null;
  /** Confirmed opposing lineup handedness composition (from roster reads). */
  opposingLineupHandedness: { left: number; right: number; switchHit: number } | null;
  /** Shrunk lineup-average batter K% vs this starter's throwing hand. */
  lineupBatterKRate?: number | null;
  /** Fraction of confirmed hitters for whom the handedness K split was available. */
  lineupBatterKCoverage?: number | null;
  /** Share of available hitters with a shrunk K rate >= 26%. */
  lineupHighKShare?: number | null;
}

export interface OpponentKProfileResult extends ComponentScore {
  pitcherPlatoonKRate: number | null;
  lineupBatterKRate: number | null;
  /** Combined pitcher × hitter matchup K rate used by the richer K projection. */
  matchupKRate: number | null;
  lineupBatterKCoverage: number;
}

function clampProb(v: number): number {
  return Math.max(0.01, Math.min(0.60, v));
}

function logit(p: number): number {
  const x = clampProb(p);
  return Math.log(x / (1 - x));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function blendMatchupKRate(pitcherRate: number | null, hitterRate: number | null): number | null {
  if (pitcherRate == null) return hitterRate;
  if (hitterRate == null) return pitcherRate;
  const prior = logit(LEAGUE_K_RATE);
  const combined =
    prior +
    PITCHER_WEIGHT * (logit(pitcherRate) - prior) +
    HITTER_WEIGHT * (logit(hitterRate) - prior);
  return clampProb(sigmoid(combined));
}

export function computeOpponentKProfile(inputs: OpponentKProfileInputs): OpponentKProfileResult {
  const drivers: MoundDriver[] = [];
  const warnings: string[] = [];

  if (!inputs.pitcherKnown) {
    warnings.push("Probable starter unknown");
    return {
      score10: 5,
      available: false,
      drivers,
      warnings,
      pitcherPlatoonKRate: null,
      lineupBatterKRate: null,
      matchupKRate: null,
      lineupBatterKCoverage: 0,
    };
  }

  const pitcherPlatoonKRate = inputs.opposingLineupConfirmed
    ? weightedPlatoonKRate(inputs.kRateVsLHB, inputs.kRateVsRHB, inputs.opposingLineupHandedness)
    : null;
  const lineupBatterKRate = inputs.opposingLineupConfirmed ? inputs.lineupBatterKRate ?? null : null;
  const matchupKRate = blendMatchupKRate(pitcherPlatoonKRate, lineupBatterKRate);

  if (matchupKRate == null) {
    warnings.push("No opponent K-profile data available");
    return {
      score10: 5,
      available: false,
      drivers,
      warnings,
      pitcherPlatoonKRate,
      lineupBatterKRate,
      matchupKRate: null,
      lineupBatterKCoverage: inputs.lineupBatterKCoverage ?? 0,
    };
  }

  // 17% is a true contact-heavy matchup; 30% is an extreme strikeout setup.
  const score = lin(matchupKRate, 0.17, 0.30);
  const sPitcher = pitcherPlatoonKRate != null ? lin(pitcherPlatoonKRate, 0.18, 0.32) : null;
  const sLineup = lineupBatterKRate != null ? lin(lineupBatterKRate, 0.17, 0.29) : null;

  if (sPitcher != null && sPitcher >= 7) {
    drivers.push({
      key: "okp_platoon",
      label: "Pitcher Platoon K Advantage",
      direction: "positive",
      weight: Math.round(sPitcher * 10),
      evidence: `${round1(pitcherPlatoonKRate! * 100)}% pitcher K rate vs lineup hand mix`,
    });
  }
  if (sLineup != null && sLineup >= 6.5) {
    drivers.push({
      key: "okp_lineup_k",
      label: "Opponent Lineup K-Prone",
      direction: "positive",
      weight: Math.round(sLineup * 10),
      evidence: `${round1(lineupBatterKRate! * 100)}% lineup K profile vs pitcher hand`,
    });
  } else if (sLineup != null && sLineup <= 3.5) {
    drivers.push({
      key: "okp_contact_lineup",
      label: "Low-K Contact Lineup",
      direction: "negative",
      weight: Math.round((10 - sLineup) * 8),
      evidence: `${round1(lineupBatterKRate! * 100)}% lineup K profile vs pitcher hand`,
    });
  }

  if ((inputs.lineupBatterKCoverage ?? 0) > 0 && (inputs.lineupBatterKCoverage ?? 0) < 0.67) {
    warnings.push("Partial hitter K-profile coverage");
  }
  if (inputs.lineupHighKShare != null && inputs.lineupHighKShare >= 0.55) {
    drivers.push({
      key: "okp_k_density",
      label: "High-K Lineup Density",
      direction: "positive",
      weight: 45,
      evidence: `${Math.round(inputs.lineupHighKShare * 100)}% of measured hitters at 26%+ K`,
    });
  }

  return {
    score10: round1(score),
    available: true,
    drivers,
    warnings,
    pitcherPlatoonKRate,
    lineupBatterKRate,
    matchupKRate,
    lineupBatterKCoverage: inputs.lineupBatterKCoverage ?? 0,
  };
}
