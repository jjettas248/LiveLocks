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

import type { PregameMathInputs, LogOddsTerm, SegmentedHrPerPaResult } from "./mathTypes";
import { sigmoid, logit, clamp } from "./normalizeStats";
import { shrinkRate, STABILIZATION_K } from "./shrinkRates";
import { scoreBatterTruePower } from "./scoreBatterTruePower";
import { scoreBatTrackingPower } from "./scoreBatTrackingPower";
import { scorePitcherHrVulnerability } from "./scorePitcherHrVulnerability";
import { scorePitchTypeInteraction } from "./scorePitchTypeInteraction";
import { scoreZoneLocationInteraction } from "./scoreZoneLocationInteraction";
import { scoreParkWeatherSprayInteraction } from "./scoreParkWeatherSprayInteraction";
import { scoreLineupOpportunity } from "./scoreLineupOpportunity";
import { scoreStarterBullpenPath, scoreBullpenVulnerability } from "./scoreStarterBullpenPath";
import { scoreRecentContactForm } from "./scoreRecentContactForm";
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
  const preSuppressorLogit = L;
  const preSuppressorHrPerPa = clampHrPerPa(sigmoid(preSuppressorLogit));
  // Reported full-matchup value INCLUDES the availability penalty.
  const matchupAdjustedHrPerPa = clampHrPerPa(sigmoid(preSuppressorLogit - suppressor.penaltyLogOdds));

  // ── Model-stability shrinkage toward league prior ────────────────────────
  // Low data confidence (missing core families / thin samples) pulls the output
  // back toward league average. This is PRIOR shrinkage, NOT calibration against
  // realized outcomes.
  //
  // IMPORTANT: shrink the PRE-suppressor value, then RE-APPLY the suppressor
  // penalty afterward. Shrinking the already-penalized value toward the league
  // prior on a zero/low-coverage row could otherwise RAISE a suppressed rate back
  // toward league — i.e. an availability suppressor would paradoxically increase
  // the HR probability. Re-applying the penalty last keeps suppressors monotone:
  // they can only ever lower the per-PA rate.
  const coreCoverage = computeCoreCoverage(batterPower.available, pitcher.available);
  const effectiveSample = inputs.batterPower?.paSample ?? 0;
  const { value: shrunkPre } = shrinkRate(
    preSuppressorHrPerPa,
    Math.max(1, effectiveSample) * coreCoverage,
    LEAGUE_HR_PER_PA,
    STABILIZATION_K.hrPerPa,
  );
  const shrunkHrPerPa = clampHrPerPa(sigmoid(logit(shrunkPre) - suppressor.penaltyLogOdds));

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

// ─────────────────────────────────────────────────────────────────────────────
// PR6 — segmented (starter vs bullpen) per-PA HR probability.
//
// §10 per-segment decomposition. BOTH segments share the hitter / recent-form /
// park terms; only the opponent terms differ:
//
//   logit(p_s) = β0 + Hitter + RecentForm + ParkWeather
//                   + StarterVulnerability + StarterPitchMix + StarterZone
//   logit(p_b) = β0 + Hitter + RecentForm + ParkWeather
//                   + ExpectedBullpenVulnerability
//
// Starter-only opponent terms (pitcher vulnerability, starter pitch-mix, starter
// zone) NEVER enter p_b; hitter/form/park ALWAYS enter p_b. Lineup opportunity and
// market are DELIBERATELY excluded from the per-PA rate here — lineup drives PA
// VOLUME (the joint PA-path, not the rate) and market is confirm/rank-only and is
// excluded from probability entirely (product principle). This is a genuine
// correction over the legacy single-rate `buildPregameHrPerPa`, which folded both
// into the rate.
//
// Each segment's pre-suppressor rate is shrunk toward the league prior by its own
// core coverage × sample, then the availability suppressor penalty is re-applied
// last so suppressors can only ever LOWER the rate (never be raised back toward
// league by prior shrinkage on a low-coverage row).
// ─────────────────────────────────────────────────────────────────────────────
export function buildSegmentedHrPerPa(inputs: PregameMathInputs): SegmentedHrPerPaResult {
  // Shared batter / form / park terms (identical in both segments).
  const batterPower = scoreBatterTruePower(inputs.batterPower);
  const batTracking = scoreBatTrackingPower(inputs.batTracking);
  const recentForm = scoreRecentContactForm(inputs.recentContactForm ?? null);
  const park = scoreParkWeatherSprayInteraction(inputs.parkWeatherSpray);

  // Starter opponent terms.
  const pitcher = scorePitcherHrVulnerability(inputs.pitcherVulnerability);
  const pitchType = scorePitchTypeInteraction(inputs.pitchType);
  const zone = scoreZoneLocationInteraction(inputs.zoneLocation);

  // Bullpen opponent term (pure vulnerability; exposure lives in the PA-path).
  const bullpen = scoreBullpenVulnerability(inputs.starterBullpen);

  // Availability suppressor (applies to both segments).
  const suppressor = scoreAvailabilitySuppressors(inputs.availability);

  const sharedLogit =
    INTERCEPT + batterPower.logOdds + batTracking.logOdds + recentForm.logOdds + park.logOdds;
  const starterOpponentLogOdds = pitcher.logOdds + pitchType.logOdds + zone.logOdds;
  const bullpenOpponentLogOdds = bullpen.logOdds;

  const effectiveSample = inputs.batterPower?.paSample ?? 0;
  const starterCoreCoverage = computeCoreCoverage(batterPower.available, pitcher.available);
  const bullpenCoreCoverage = computeCoreCoverage(batterPower.available, bullpen.available);

  const starterHrPerPa = shrinkThenSuppress(
    sharedLogit + starterOpponentLogOdds,
    effectiveSample,
    starterCoreCoverage,
    suppressor.penaltyLogOdds,
  );
  const bullpenHrPerPa = shrinkThenSuppress(
    sharedLogit + bullpenOpponentLogOdds,
    effectiveSample,
    bullpenCoreCoverage,
    suppressor.penaltyLogOdds,
  );

  const terms: LogOddsTerm[] = [
    batterPower, batTracking, recentForm, park, pitcher, pitchType, zone, bullpen,
  ];

  return {
    starterHrPerPa,
    bullpenHrPerPa,
    sharedLogit,
    starterOpponentLogOdds,
    bullpenOpponentLogOdds,
    recentFormLogOdds: recentForm.logOdds,
    bullpenVulnerabilityAvailable: bullpen.available,
    terms,
    suppressors: suppressor.suppressors,
    suppressorPenalty: suppressor.penaltyLogOdds,
    confidenceFactor: suppressor.confidenceFactor,
    starterCoreCoverage,
    bullpenCoreCoverage,
    effectiveSample,
  };
}

/**
 * Model-stability shrinkage toward the league prior by coverage × sample, then
 * re-apply the availability suppressor penalty LAST (monotone: suppressors can
 * only lower the rate). Mirrors the legacy `buildPregameHrPerPa` discipline.
 */
function shrinkThenSuppress(
  preSuppressorLogit: number,
  effectiveSample: number,
  coreCoverage: number,
  suppressorPenaltyLogOdds: number,
): number {
  const preSuppressorHrPerPa = clampHrPerPa(sigmoid(preSuppressorLogit));
  const { value: shrunkPre } = shrinkRate(
    preSuppressorHrPerPa,
    Math.max(1, effectiveSample) * coreCoverage,
    LEAGUE_HR_PER_PA,
    STABILIZATION_K.hrPerPa,
  );
  return clampHrPerPa(sigmoid(logit(shrunkPre) - suppressorPenaltyLogOdds));
}
