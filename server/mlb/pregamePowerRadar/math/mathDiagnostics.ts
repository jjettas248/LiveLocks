// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: top-level model orchestrator + diagnostics
//
// Pure. `runPregameMathModel` wires the component scorers → per-PA assembly → PA
// distribution → game HR probability → (deferred/identity) calibration → ranking,
// and returns the canonical `PregameMathModelResult`.
//
// SHADOW-ONLY. Nothing here is imported by the production build/scoring path.
// Every output is additive/diagnostic; missing data degrades to nulls + warnings,
// never fabricated values.
// ─────────────────────────────────────────────────────────────────────────────

import type { PregameMathInputs, PregameMathModelResult } from "./mathTypes";
import { logit } from "./normalizeStats";
import { shrinkRate, STABILIZATION_K } from "./shrinkRates";
import {
  buildPregameHrPerPa,
  LEAGUE_HR_PER_PA,
} from "./buildPregameHrPerPa";
import { estimatePregamePaDistribution } from "./estimatePregamePaDistribution";
import { gameHrProbability } from "./gameHrProbability";
import { calibratePregameHrProbability } from "./calibratePregameHrProbability";
import { rankPregameCandidate } from "./rankPregameCandidatesV2";

const INTERCEPT = logit(LEAGUE_HR_PER_PA);

export function runPregameMathModel(inputs: PregameMathInputs): PregameMathModelResult {
  const build = buildPregameHrPerPa(inputs);

  // ── PA distribution + game-level probabilities ───────────────────────────
  const { distribution, expectedPA } = estimatePregamePaDistribution({
    battingOrderSlot: inputs.lineupOpportunity?.battingOrderSlot,
    teamImpliedRuns: inputs.lineupOpportunity?.teamImpliedRuns,
  });

  const rawGameHrProbability = gameHrProbability(build.matchupAdjustedHrPerPa, distribution);

  const cal = calibratePregameHrProbability(build.shrunkHrPerPa);
  const calibratedHrPerPa = cal.calibrated;
  const calibratedGameHrProbability = gameHrProbability(calibratedHrPerPa, distribution);

  // ── Baselines + lifts ────────────────────────────────────────────────────
  const playerSeasonShrunk = shrinkRate(
    inputs.batterPower?.hrPerPaSeason ?? null,
    inputs.batterPower?.paSample ?? null,
    LEAGUE_HR_PER_PA,
    STABILIZATION_K.hrPerPa,
  );
  const playerBaselineGameHrProbability =
    inputs.batterPower?.hrPerPaSeason != null
      ? gameHrProbability(playerSeasonShrunk.value, distribution)
      : null;

  const slateBaselineGameHrProbability = inputs.slateBaselineGameHrProbability ?? null;
  const marketImpliedHrProbability =
    inputs.market?.hrOddsAvailable
      ? inputs.market.noVigImpliedHrProbability ?? inputs.market.impliedHrProbability ?? null
      : null;

  const hrLiftVsPlayerBaseline = ratio(calibratedGameHrProbability, playerBaselineGameHrProbability);
  const hrLiftVsSlateBaseline = ratio(calibratedGameHrProbability, slateBaselineGameHrProbability);
  const hrLiftVsMarket = ratio(calibratedGameHrProbability, marketImpliedHrProbability);

  // ── Scores + tier ────────────────────────────────────────────────────────
  const setupLogitLift = logit(Math.max(1e-6, build.matchupAdjustedHrPerPa)) - INTERCEPT;
  const hasMajorSuppressor =
    build.suppressors.includes("not_confirmed_active") || build.suppressorPenalty >= 0.5;

  const rank = rankPregameCandidate({
    setupLogitLift,
    calibratedGameHrProbability,
    hrLiftVsSlateBaseline,
    hrLiftVsPlayerBaseline,
    coreCoverage: build.coreCoverage,
    suppressorConfidenceFactor: build.confidenceFactor,
    effectiveSample: build.effectiveSample,
    hasMajorSuppressor,
  });

  // ── Drivers / suppressors (human-readable) ───────────────────────────────
  const drivers: string[] = [];
  for (const t of build.terms) {
    if (t.available && t.logOdds >= 0.08) drivers.push(`${t.key}:+${t.logOdds.toFixed(2)}`);
  }
  const suppressors: string[] = [...build.suppressors];
  for (const t of build.terms) {
    if (t.available && t.logOdds <= -0.08) suppressors.push(`${t.key}:${t.logOdds.toFixed(2)}`);
  }

  // ── Coverage / diagnostics ───────────────────────────────────────────────
  const statCoverage = buildStatCoverage(inputs, build);

  const missingDataWarnings: string[] = [];
  if (!termAvailable(build, "batterPower")) missingDataWarnings.push("missing_batter_power");
  if (!termAvailable(build, "pitcherVulnerability")) missingDataWarnings.push("missing_pitcher_profile");
  if (!inputs.lineupOpportunity?.lineupConfirmed) missingDataWarnings.push("lineup_not_confirmed");
  if (!inputs.parkWeatherSpray?.weatherAvailable) missingDataWarnings.push("missing_weather");
  if (!inputs.market?.hrOddsAvailable) missingDataWarnings.push("missing_market_odds");

  // The v2 model inputs are a typed, pre-first-pitch-only contract (no live
  // fields exist on `PregameMathInputs`), so there is nothing to flag here.
  // Feature-level leakage is enforced at INGEST via the leakageGuard helpers
  // (isLiveOnlyFeatureName / assertPregameFeatureAllowed / filterLeakyFeatures),
  // which are unit-tested separately. Any caller that threads raw feature
  // provenance can attach `buildLeakageWarnings(...)` output here.
  const leakageWarnings: string[] = [];

  return {
    playerId: inputs.playerId,
    gameId: inputs.gameId,

    baselineHrPerPa: build.baselineHrPerPa,
    batterTruePowerHrPerPa: termAvailable(build, "batterPower") ? build.batterTruePowerHrPerPa : null,
    batterBatTrackingPowerScore100: build.batTrackingScore100,
    pitcherAdjustedHrPerPa: termAvailable(build, "pitcherVulnerability")
      ? build.pitcherAdjustedHrPerPa
      : null,
    pitchTypeAdjustedHrPerPa: termAvailable(build, "pitchType") ? build.pitchTypeAdjustedHrPerPa : null,
    zoneLocationAdjustedHrPerPa: termAvailable(build, "zoneLocation")
      ? build.zoneLocationAdjustedHrPerPa
      : null,
    parkWeatherAdjustedHrPerPa: termAvailable(build, "parkWeatherSpray")
      ? build.parkWeatherAdjustedHrPerPa
      : null,
    matchupAdjustedHrPerPa: build.matchupAdjustedHrPerPa,
    calibratedHrPerPa,

    projectedPA: round(expectedPA, 2),
    paDistribution: distribution,

    rawGameHrProbability: round(rawGameHrProbability, 4),
    calibratedGameHrProbability: round(calibratedGameHrProbability, 4),

    playerBaselineGameHrProbability: round(playerBaselineGameHrProbability, 4),
    slateBaselineGameHrProbability: round(slateBaselineGameHrProbability, 4),
    marketImpliedHrProbability: round(marketImpliedHrProbability, 4),

    hrLiftVsPlayerBaseline: round(hrLiftVsPlayerBaseline, 3),
    hrLiftVsSlateBaseline: round(hrLiftVsSlateBaseline, 3),
    hrLiftVsMarket: round(hrLiftVsMarket, 3),

    rawSetupScore100: rank.rawSetupScore100,
    probabilityScore100: rank.probabilityScore100,
    confidenceScore100: rank.confidenceScore100,
    candidateRankScore100: rank.candidateRankScore100,

    recommendedTier: rank.recommendedTier,

    drivers,
    suppressors,

    statCoverage,
    shrinkageDiagnostics: {
      coreCoverage: build.coreCoverage,
      effectiveSample: build.effectiveSample,
      playerSeasonShrunkHrPerPa: round(playerSeasonShrunk.value, 4),
      playerSeasonShrinkWeight: round(playerSeasonShrunk.weight, 3),
    },
    interactionDiagnostics: {
      terms: build.terms.map((t) => ({
        key: t.key,
        logOdds: round(t.logOdds, 3),
        available: t.available,
        shrinkWeight: t.shrinkWeight != null ? round(t.shrinkWeight, 3) : null,
      })),
      suppressorPenalty: round(build.suppressorPenalty, 3),
    },
    calibrationDiagnostics: cal.diagnostics,
    missingDataWarnings,
    leakageWarnings,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function termAvailable(
  build: ReturnType<typeof buildPregameHrPerPa>,
  key: string,
): boolean {
  return build.terms.some((t) => t.key === key && t.available);
}

function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return a / b;
}

function round(v: number | null, dp: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

type Coverage = "used" | "missing" | "fallback" | "not_available";

export function buildStatCoverage(
  inputs: PregameMathInputs,
  build: ReturnType<typeof buildPregameHrPerPa>,
): Record<string, Coverage> {
  return {
    batterPower: termAvailable(build, "batterPower") ? "used" : "missing",
    batTracking: build.batTrackingScore100 != null ? "used" : "missing",
    pitcherVulnerability: termAvailable(build, "pitcherVulnerability") ? "used" : "missing",
    pitchTypeInteraction: termAvailable(build, "pitchType") ? "used" : "missing",
    // Zone/location data is generally not produced today (P2) — distinguish.
    zoneLocation: termAvailable(build, "zoneLocation") ? "used" : "not_available",
    parkWeatherSpray: termAvailable(build, "parkWeatherSpray") ? "used" : "missing",
    lineupOpportunity: termAvailable(build, "lineupOpportunity") ? "used" : "missing",
    starterBullpenPath: termAvailable(build, "starterBullpenPath") ? "used" : "not_available",
    // No odds source is wired in the codebase today (P1) — not_available, not missing.
    marketConfirmation: inputs.market?.hrOddsAvailable ? "used" : "not_available",
  };
}
