// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: per-PA HR probability assembly
//
// Pure. Assembles the additive log-odds model into a per-PA HR probability:
//
//   logit(hrPerPa) = intercept
//     + batterPowerTerm + batTrackingTerm
//     + pitcherVulnerabilityTerm
//     + pitchTypeInteractionTerm + zoneLocationInteractionTerm
//     + parkWeatherSprayTerm
//     + lineupOpportunityTerm + starterBullpenPathTerm
//     + marketConfirmationTerm
//     − suppressorPenaltyTerm
//
//   hrPerPa = clamp(sigmoid(logit), MIN, MAX)
//   then shrink toward the league prior by overall data confidence.
//
// Coefficients/caps are documented DEFAULT PRIORS (see component files), NOT
// fitted to historical outcomes. Empirical calibration is a deferred future phase.
// ─────────────────────────────────────────────────────────────────────────────

import type { PregameMathInputs, LogOddsTerm } from "./mathTypes";
import { sigmoid, logit, clamp } from "./normalizeStats";
import { shrinkRate, STABILIZATION_K } from "./shrinkRates";
import { scoreBatterTruePower } from "./scoreBatterTruePower";
import { scoreBatTrackingPower } from "./scoreBatTrackingPower";
import { scorePitcherHrVulnerability } from "./scorePitcherHrVulnerability";
import { scorePitchTypeInteraction } from "./scorePitchTypeInteraction";
import { scoreZoneLocationInteraction } from "./scoreZoneLocationInteraction";
import { scoreParkWeatherSprayInteraction } from "./scoreParkWeatherSprayInteraction";
import { scoreLineupOpportunity } from "./scoreLineupOpportunity";
import { scoreStarterBullpenPath } from "./scoreStarterBullpenPath";
import { scoreMarketConfirmation } from "./scoreMarketConfirmation";
import { scoreAvailabilitySuppressors } from "./scoreAvailabilitySuppressors";

/** Documented league baseline HR per plate appearance (recent MLB ~0.033–0.034). */
export const LEAGUE_HR_PER_PA = 0.0335;

/** Safe per-PA HR probability clamps (task §Phase 4 math req 2). */
export const MIN_HR_PER_PA = 0.001;
export const MAX_HR_PER_PA = 0.12;

const INTERCEPT = logit(LEAGUE_HR_PER_PA);

export interface PregameHrPerPaResult {
  baselineHrPerPa: number;
  batterTruePowerHrPerPa: number;
  pitcherAdjustedHrPerPa: number;
  pitchTypeAdjustedHrPerPa: number;
  zoneLocationAdjustedHrPerPa: number;
  parkWeatherAdjustedHrPerPa: number;
  matchupAdjustedHrPerPa: number;
  /** After model-stability shrinkage toward league prior (NOT outcome calibration). */
  shrunkHrPerPa: number;

  batTrackingScore100: number | null;
  terms: LogOddsTerm[];
  suppressors: string[];
  suppressorPenalty: number;
  confidenceFactor: number;

  /** [0,1] coverage of the core model families (power + pitcher). */
  coreCoverage: number;
  /** Effective sample backing the batter rates (for shrinkage diagnostics). */
  effectiveSample: number;
}

export function buildPregameHrPerPa(inputs: PregameMathInputs): PregameHrPerPaResult {
  // ── Component terms ──────────────────────────────────────────────────────
  const batterPower = scoreBatterTruePower(inputs.batterPower);
  const batTracking = scoreBatTrackingPower(inputs.batTracking);
  const pitcher = scorePitcherHrVulnerability(inputs.pitcherVulnerability);
  const pitchType = scorePitchTypeInteraction(inputs.pitchType);
  const zone = scoreZoneLocationInteraction(inputs.zoneLocation);
  const park = scoreParkWeatherSprayInteraction(inputs.parkWeatherSpray);
  const lineup = scoreLineupOpportunity(inputs.lineupOpportunity);
  const bullpen = scoreStarterBullpenPath(inputs.starterBullpen);
  const market = scoreMarketConfirmation(inputs.market);
  const suppressor = scoreAvailabilitySuppressors(inputs.availability);

  const terms: LogOddsTerm[] = [
    batterPower, batTracking, pitcher, pitchType, zone, park, lineup, bullpen, market,
  ];

  // ── Cumulative logit with stage snapshots ────────────────────────────────
  let L = INTERCEPT;
  const baselineHrPerPa = clampHrPerPa(sigmoid(L));

  L += batterPower.logOdds + batTracking.logOdds;
  const batterTruePowerHrPerPa = clampHrPerPa(sigmoid(L));

  L += pitcher.logOdds;
  const pitcherAdjustedHrPerPa = clampHrPerPa(sigmoid(L));

  L += pitchType.logOdds;
  const pitchTypeAdjustedHrPerPa = clampHrPerPa(sigmoid(L));

  L += zone.logOdds;
  const zoneLocationAdjustedHrPerPa = clampHrPerPa(sigmoid(L));

  L += park.logOdds;
  const parkWeatherAdjustedHrPerPa = clampHrPerPa(sigmoid(L));

  L += lineup.logOdds + bullpen.logOdds + market.logOdds;
  L -= suppressor.penaltyLogOdds;
  const matchupAdjustedHrPerPa = clampHrPerPa(sigmoid(L));

  // ── Model-stability shrinkage toward league prior ────────────────────────
  // Low data confidence (missing core families / thin samples) pulls the output
  // back toward league average. This is PRIOR shrinkage, NOT calibration against
  // realized outcomes.
  const coreCoverage = computeCoreCoverage(batterPower.available, pitcher.available);
  const effectiveSample = inputs.batterPower?.paSample ?? 0;
  const { value: shrunkHrPerPa } = shrinkRate(
    matchupAdjustedHrPerPa,
    Math.max(1, effectiveSample) * coreCoverage,
    LEAGUE_HR_PER_PA,
    STABILIZATION_K.hrPerPa,
  );

  return {
    baselineHrPerPa,
    batterTruePowerHrPerPa,
    pitcherAdjustedHrPerPa,
    pitchTypeAdjustedHrPerPa,
    zoneLocationAdjustedHrPerPa,
    parkWeatherAdjustedHrPerPa,
    matchupAdjustedHrPerPa,
    shrunkHrPerPa: clampHrPerPa(shrunkHrPerPa),
    batTrackingScore100: batTracking.score100,
    terms,
    suppressors: suppressor.suppressors,
    suppressorPenalty: suppressor.penaltyLogOdds,
    confidenceFactor: suppressor.confidenceFactor,
    coreCoverage,
    effectiveSample,
  };
}

function clampHrPerPa(p: number): number {
  return clamp(p, MIN_HR_PER_PA, MAX_HR_PER_PA);
}

function computeCoreCoverage(batterAvailable: boolean, pitcherAvailable: boolean): number {
  // Batter power is the dominant family; weight it 0.7, pitcher 0.3.
  return (batterAvailable ? 0.7 : 0) + (pitcherAvailable ? 0.3 : 0);
}
