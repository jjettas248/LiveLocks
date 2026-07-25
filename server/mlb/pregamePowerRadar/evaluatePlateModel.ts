// The Plate — policy-driven model evaluation.
//
// One function, two policies. Champion and challenger run the SAME shared
// component scorers over the SAME frozen input; only `policy` differs. There is
// no forked engine to drift.
//
// `policy` is a required positional argument with no default: production model
// selection must be visible at the call site, never inherited from a default
// that a later edit could quietly change.
//
// Pure — no I/O, no fetches, no mutation of the frozen input.

import { computeBatterPowerProfile } from "./batterPowerProfile";
import { computePitcherVulnerability } from "./pitcherVulnerability";
import { computeMatchupFit } from "./matchupFit";
import { computeParkWeatherScore } from "./parkWeatherScore";
import { computeLineupOpportunity } from "./lineupOpportunity";
import { computeMarketTags } from "./marketTagger";
import { computeAttackEnvironment, getParkDirection } from "./attackEnvironment";
import { composePregameScore, type ScoringFlags } from "./scoring";
import { countPositiveDrivers, driverKeysForUniverse } from "./modelVersions/plateDriverUniverse";
import { decidePlatePublication } from "./modelVersions/platePublicationDecision";
import type { PlateModelEvaluation, PlateModelPolicy, PlatePublicationContext } from "./modelVersions/plateModelTypes";
import type { FrozenPlateInput } from "./frozenPlateInput";
import type { PowerDriver } from "./types";

export function evaluatePlateModel(
  frozen: Readonly<FrozenPlateInput>,
  policy: PlateModelPolicy,
  ctx: PlatePublicationContext,
): PlateModelEvaluation {
  const batterPower = computeBatterPowerProfile(
    {
      xISO: frozen.batter.xISO,
      xSLG: frozen.batter.xSLG,
      barrelRatePct: frozen.batter.barrelRatePct,
      hardHitRatePct: frozen.batter.hardHitRatePct,
      exitVelocity: frozen.batter.exitVelocity,
      maxEV: frozen.batter.maxEV,
      flyBallPct: frozen.batter.flyBallPct,
      hrFBRatioPct: frozen.batter.hrFBRatioPct,
      pullRatePct: frozen.batter.pullRatePct,
      sweetSpotPct: frozen.batter.sweetSpotPct,
      xwOBA: frozen.batter.xwOBA,
      battedBallEvents: frozen.batter.battedBallEvents,
    },
    policy.batter,
  );

  // Research fields are passed unconditionally; the champion policy nulls them
  // inside the scorer. Passing them here keeps the two models reading one
  // object rather than two differently-shaped ones.
  const pitcherVuln = computePitcherVulnerability(
    {
      pitcherKnown: frozen.pitcher.pitcherKnown,
      batterHand: frozen.batter.bats,
      pitcherThrows: frozen.pitcher.throws,
      hrPer9VsLHB: frozen.pitcher.hrPer9VsLHB,
      hrPer9VsRHB: frozen.pitcher.hrPer9VsRHB,
      eraVsLHB: frozen.pitcher.eraVsLHB,
      eraVsRHB: frozen.pitcher.eraVsRHB,
      barrelAllowedPct: frozen.research.barrelAllowedPct,
      hardHitAllowedPct: frozen.research.hardHitAllowedPct,
      flyBallAllowedPct: frozen.research.flyBallAllowedPct,
      last3StartERA: frozen.research.last3StartERA,
      daysSinceLastStart: frozen.research.daysSinceLastStart,
    },
    policy.pitcher,
  );

  const parkWeather = computeParkWeatherScore({
    parkHrFactor: frozen.parkWeather.parkHrFactor,
    isIndoors: frozen.parkWeather.isIndoors,
    weatherAvailable: frozen.parkWeather.weatherAvailable,
    temperature: frozen.parkWeather.temperature,
    windSpeed: frozen.parkWeather.windSpeed,
    windDirection: frozen.parkWeather.windDirection,
  });

  const matchupFit = computeMatchupFit({
    batterHand: frozen.batter.bats,
    pitcherThrows: frozen.pitcher.throws,
    batterOpsVsHand: frozen.matchup.batterOpsVsHand,
    batterXslgVsDominantFamily: frozen.matchup.batterXslgVsDominantFamily,
    pullRatePct: frozen.batter.pullRatePct,
    parkFavorsPull: frozen.matchup.parkFavorsPull,
    bvpPlateAppearances: frozen.matchup.bvpPlateAppearances,
    bvpHr: frozen.matchup.bvpHr,
    bvpHits: frozen.matchup.bvpHits,
    bvpAtBats: frozen.matchup.bvpAtBats,
    bvpStrikeouts: frozen.matchup.bvpStrikeouts,
    bvpOps: frozen.matchup.bvpOps,
    bvpAvg: frozen.matchup.bvpAvg,
  });

  const lineupOpp = computeLineupOpportunity({
    battingOrderSlot: frozen.lineup.battingOrderSlot,
    teamImpliedRuns: frozen.lineup.teamImpliedRuns,
    obpAhead: frozen.lineup.obpAhead,
  });

  // Mirrors buildPregamePowerRadar.ts: the score every downstream consumer sees
  // is the blend, not pitcherVuln.score10. The order-split feed is unwired in
  // production, so this resolves to pitcherVuln.score10 today — but reproducing
  // the expression keeps the two paths from diverging if it is ever connected.
  const pos = frozen.precomputed.pitcherOrderSplit;
  const pitcherVulnerabilityScore = pitcherVuln.available && pos.available
    ? Math.round(((pitcherVuln.score10 * 2 + pos.score10 * 3) / 5) * 10) / 10
    : pos.available
      ? pos.score10
      : pitcherVuln.score10;
  const pitcherProfileAvailable = pitcherVuln.available || pos.available;

  const marketTags = computeMarketTags({
    batterPowerScore: batterPower.score10,
    pitcherVulnerabilityScore,
    parkWeatherScore: parkWeather.score10,
    hrFBRatioPct: frozen.batter.hrFBRatioPct,
    xISO: frozen.batter.xISO,
    hardHitRatePct: frozen.batter.hardHitRatePct,
  });

  // Same union, same order as buildPregamePowerRadar.ts — the order-split and
  // recent-form drivers are policy-independent and arrive precomputed, so this
  // is the production driver set, not a subset of it.
  const drivers: PowerDriver[] = [
    ...batterPower.drivers,
    ...pitcherVuln.drivers,
    ...frozen.precomputed.pitcherOrderSplit.drivers,
    ...frozen.precomputed.batterOrderSplit.drivers,
    ...matchupFit.drivers,
    ...parkWeather.drivers,
    ...lineupOpp.drivers,
    ...frozen.precomputed.nearHrRecentForm.drivers,
    ...marketTags.drivers,
  ];
  const positiveDriverCount = countPositiveDrivers(drivers, driverKeysForUniverse(policy.drivers.universe));

  const attackEnvironment = computeAttackEnvironment({
    batterPowerScore: batterPower.score10,
    pitcherVulnerabilityScore,
    matchupFitScore: matchupFit.score10,
    parkDirection: getParkDirection(parkWeather.drivers),
    carryType: parkWeather.carryType,
    selectedMarketScore:
      marketTags.primaryMarket === "home_runs"
        ? marketTags.marketScores.home_runs ?? 0
        : marketTags.marketScores.total_bases ?? 0,
  });

  // Availability is policy-forked: the champion uses July-20's loose reads, the
  // challenger the stricter honest ones. Both are derived from the same frozen
  // dataQuality block, so neither model can be "measuring" something the other
  // could not have seen.
  const batterPowerAvailable = policy.availability.strictBatterQuality
    ? batterPower.available && frozen.dataQuality.savantQuality === "full"
    : batterPower.available;
  const parkAvailable = policy.availability.strictVenueResolution
    ? frozen.dataQuality.venueResolved
    : frozen.parkWeather.parkHrFactor != null;

  const flags: ScoringFlags = {
    batterPowerAvailable,
    pitcherProfileAvailable,
    confirmedLineup: frozen.lineup.lineupPosted,
    parkAvailable,
    weatherAvailable: frozen.parkWeather.weatherAvailable,
    bvpAvailable: matchupFit.bvpAvailable,
    parkIsOnlyPositiveDriver: parkWeather.parkIsOnlyPositiveDriver,
    positiveDriverCount,
    bvpDirection: matchupFit.bvpDirection,
    bvpZeroProduction: matchupFit.bvpZeroProduction,
    pitcherOrderSplitDirection: pos.direction,
    batterOrderSplitDirection: frozen.precomputed.batterOrderSplit.direction,
    attackEnvironmentTier: attackEnvironment.tier,
    attackEnvironmentEliminationEligible: attackEnvironment.eliminationEligible,
  };

  const scoring = composePregameScore(
    {
      batterPowerScore: batterPower.score10,
      pitcherVulnerabilityScore,
      matchupFitScore: matchupFit.score10,
      parkWeatherScore: parkWeather.score10,
      lineupOpportunityScore: lineupOpp.score10,
      nearHrRecentFormScore: frozen.precomputed.nearHrRecentForm.score10,
      bvpModifier: matchupFit.bvpModifier,
    },
    flags,
    policy.gates,
  );

  const publication = decidePlatePublication(
    {
      tier: scoring.tier,
      score10: scoring.score10,
      suppressed: scoring.suppressed,
      positiveDriverCount,
      evidenceFamilyCount: scoring.evidenceFamilyCount,
      dataCoverageScore: scoring.dataCoverageScore,
      batterPowerAvailable,
      lineupStatus: ctx.lineupStatus,
      isOfficialPlay: ctx.isOfficialPlay,
      isPregameTarget: ctx.isPregameTarget,
    },
    policy,
  );

  return {
    modelVersion: policy.version,
    components: {
      batterPowerScore: batterPower.score10,
      pitcherVulnerabilityScore,
      matchupFitScore: matchupFit.score10,
      parkWeatherScore: parkWeather.score10,
      lineupOpportunityScore: lineupOpp.score10,
      nearHrRecentFormScore: frozen.precomputed.nearHrRecentForm.score10,
    },
    scoring,
    tier: scoring.tier,
    score10: scoring.score10,
    suppressed: scoring.suppressed,
    suppressedReasons: scoring.suppressedReasons,
    primaryMarket: marketTags.primaryMarket,
    positiveDriverCount,
    evidenceFamilyCount: scoring.evidenceFamilyCount,
    attackEnvironment,
    publicEligible: publication.publicEligible,
    publicIneligibleReasons: publication.ineligibleReasons,
    flags: {
      // Whether the branch was ENABLED and had data to act on — not merely
      // enabled. Attribution reads these, so "the policy allows contact
      // features but none were present" must not be reported as a cause.
      usedPitcherContactFeatures:
        policy.pitcher.useContactAllowed &&
        (frozen.research.barrelAllowedPct != null ||
          frozen.research.hardHitAllowedPct != null ||
          frozen.research.flyBallAllowedPct != null),
      usedPitcherRecentForm: policy.pitcher.useRecentForm && frozen.research.last3StartERA != null,
      usedPitcherRestDays: policy.pitcher.useRestDays && frozen.research.daysSinceLastStart != null,
      appliedBatterSampleShrinkage:
        policy.batter.applySampleShrinkage &&
        frozen.batter.battedBallEvents != null &&
        frozen.batter.battedBallEvents < 70,
      attackEnvironmentGateEngaged:
        policy.gates.attackEnvironmentGates &&
        (scoring.attackEnvironmentSuppressionApplied || attackEnvironment.tier !== "NEUTRAL"),
      evidenceFamilyGateEngaged: policy.gates.evidenceFamilyGate && scoring.evidenceFamilyCount < 2,
      strictAvailabilityEngaged:
        (policy.availability.strictBatterQuality && frozen.dataQuality.savantQuality !== "full") ||
        (policy.availability.strictVenueResolution && !frozen.dataQuality.venueResolved),
      driverUniverse: policy.drivers.universe,
    },
  };
}
