import type { MLBPropInput, MLBMarket, ModifierBreakdown, ProjectionLog } from "./types";
import { MODIFIER_CAPS } from "./types";
import {
  computeLiveContactQualityScore,
  computeLineupContextScore,
  computePitcherContextScore,
  computePitchTypeScore,
  computeBatterVsPitchTypeSplit,
  computeWeatherParkScore,
  computeBullpenScore,
  computeParkHistoryAdjustment,
  computeHandednessMatchupScore,
  computeBvpAdjustment,
  computeLineupPocketWeaknessScore,
  applyTwoABRule,
} from "./featureEngineering";

function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

function capModifier(raw: number, cap: number): number {
  return clamp(raw, -cap, cap);
}

export interface ProjectionResult {
  baseValue: number;
  projection: number;
  modifiers: ModifierBreakdown;
  projectionLog: ProjectionLog;
  mode: "standard" | "early_explosive";
  twoABRuleSatisfied: boolean;
  warnings: string[];
}

function computeBaseValue(input: MLBPropInput, market: MLBMarket): number {
  const { seasonAvg, remainingPA, remainingAB, currentStatValue } = input;

  switch (market) {
    case "hits": {
      const ratePerAB = seasonAvg > 0 ? seasonAvg : 0.25;
      return currentStatValue + ratePerAB * remainingAB;
    }
    case "total_bases": {
      const tbRate = seasonAvg > 0 ? seasonAvg : 0.40;
      return currentStatValue + tbRate * remainingAB;
    }
    case "pitcher_strikeouts": {
      const kPer9 = input.pitcher.kPer9 ?? 8.0;
      const estimatedBFRemaining = remainingAB > 0 ? remainingAB : 10;
      return currentStatValue + (kPer9 / 9) * (estimatedBFRemaining / 4.3);
    }
    case "hits_allowed": {
      const whip = input.pitcher.whip ?? 1.30;
      const hitsPerIP = whip * 0.72;
      const estimatedIPRemaining = Math.max(0, (remainingAB / 4.3));
      return currentStatValue + hitsPerIP * estimatedIPRemaining;
    }
    case "walks_allowed": {
      const whipW = input.pitcher.whip ?? 1.30;
      const walksPerIP = whipW * 0.28;
      const estimatedIPRemainingW = Math.max(0, (remainingAB / 4.3));
      return currentStatValue + walksPerIP * estimatedIPRemainingW;
    }
    case "home_runs": {
      const hrRate = seasonAvg > 0 ? seasonAvg : 0.035;
      return currentStatValue + hrRate * remainingAB;
    }
    case "hrr": {
      const comp = input.hrrComponents;
      if (comp) {
        const projHits = comp.currentHits + comp.hitsRate * remainingAB;
        const projRuns = comp.currentRuns + comp.runsRate * remainingAB;
        const projRBIs = comp.currentRBIs + comp.rbisRate * remainingAB;
        return projHits + projRuns + projRBIs;
      }
      const hitsRate = seasonAvg > 0 ? seasonAvg * 0.4 : 0.10;
      const runsRate = seasonAvg > 0 ? seasonAvg * 0.35 : 0.08;
      const rbiRate = seasonAvg > 0 ? seasonAvg * 0.25 : 0.06;
      return (
        currentStatValue +
        (hitsRate + runsRate + rbiRate) * remainingAB
      );
    }
    default:
      return currentStatValue;
  }
}

export function projectBaseValue(input: MLBPropInput): ProjectionResult {
  const market = input.market;
  const warnings: string[] = [];

  const baseValue = computeBaseValue(input, market);

  const twoABResult = applyTwoABRule(input);

  let rawLiveForm = 0;
  if (twoABResult.liveFormAllowed) {
    rawLiveForm = computeLiveContactQualityScore(input.contactQuality);
    if (twoABResult.mode === "early_explosive") {
      rawLiveForm *= 1.3;
      warnings.push("Early explosive-contact mode active");
    }
  } else {
    warnings.push(twoABResult.reason);
  }

  const rawPitcher = computePitcherContextScore(input.pitcher);
  // pitchType includes both pitcher pitch-mix perspective + batter-vs-pitch-type split
  const rawPitchType = computePitchTypeScore(input.pitcher) + computeBatterVsPitchTypeSplit(input);
  const rawWeatherPark = computeWeatherParkScore(input.weatherPark);
  const rawLineup = computeLineupContextScore(input.lineup);
  const shouldApplyBullpen =
    input.pitcher.timesThrough >= 3 || input.pitcher.pitchCount > 90;
  const rawBullpen = shouldApplyBullpen ? computeBullpenScore(input.bullpen) : 0;
  const rawParkHistory = computeParkHistoryAdjustment(input);
  const rawHandedness = computeHandednessMatchupScore(input);
  const rawBvp = computeBvpAdjustment(input);
  const rawPocketWeakness = computeLineupPocketWeaknessScore(input);

  const liveForm = capModifier(rawLiveForm, MODIFIER_CAPS.liveForm);
  const pitcher = capModifier(rawPitcher, MODIFIER_CAPS.pitcher);
  const pitchType = capModifier(rawPitchType, MODIFIER_CAPS.pitchType);
  const weatherPark = capModifier(rawWeatherPark, MODIFIER_CAPS.weatherPark);
  const lineup = capModifier(rawLineup, MODIFIER_CAPS.lineup);
  const bullpen = capModifier(rawBullpen, MODIFIER_CAPS.bullpen);
  const parkHistory = capModifier(rawParkHistory, MODIFIER_CAPS.parkHistory);
  const handednessMatchup = capModifier(rawHandedness, MODIFIER_CAPS.handednessMatchup);
  const bvpHistory = capModifier(rawBvp, MODIFIER_CAPS.bvpHistory);
  const pocketWeakness = capModifier(rawPocketWeakness, MODIFIER_CAPS.pocketWeakness);

  const rawTotal = liveForm + pitcher + pitchType + weatherPark + lineup + bullpen +
    parkHistory + handednessMatchup + bvpHistory + pocketWeakness;
  const total = clamp(rawTotal, -MODIFIER_CAPS.totalMax, MODIFIER_CAPS.totalMax);

  if (Math.abs(rawTotal) > MODIFIER_CAPS.totalMax) {
    warnings.push(
      `Combined modifiers capped: raw=${(rawTotal * 100).toFixed(1)}%, capped=${(total * 100).toFixed(1)}%`
    );
  }

  const projection = baseValue * (1 + total);

  const modifiers: ModifierBreakdown = {
    liveForm,
    pitcher,
    pitchType,
    weatherPark,
    lineup,
    bullpen,
    parkHistory,
    handednessMatchup,
    bvpHistory,
    pocketWeakness,
    total,
  };

  const projectionLog: ProjectionLog = {
    baseProjection: Math.round(baseValue * 1000) / 1000,
    liveFormAdjustment: Math.round(baseValue * liveForm * 1000) / 1000,
    pitcherAdjustment: Math.round(baseValue * pitcher * 1000) / 1000,
    pitchTypeAdjustment: Math.round(baseValue * pitchType * 1000) / 1000,
    weatherParkAdjustment: Math.round(baseValue * weatherPark * 1000) / 1000,
    lineupAdjustment: Math.round(baseValue * lineup * 1000) / 1000,
    bullpenAdjustment: Math.round(baseValue * bullpen * 1000) / 1000,
    parkHistoryAdjustment: Math.round(baseValue * parkHistory * 1000) / 1000,
    handednessMatchupAdjustment: Math.round(baseValue * handednessMatchup * 1000) / 1000,
    bvpHistoryAdjustment: Math.round(baseValue * bvpHistory * 1000) / 1000,
    pocketWeaknessAdjustment: Math.round(baseValue * pocketWeakness * 1000) / 1000,
    finalCappedAdjustment: Math.round(baseValue * total * 1000) / 1000,
    rawProbability: 0,
    calibratedProbability: 0,
    confidenceTier: "NO_EDGE",
    modeUsed: twoABResult.mode === "early_explosive" ? "EARLY_EXPLOSIVE" : "STANDARD",
  };

  return {
    baseValue,
    projection: Math.round(projection * 100) / 100,
    modifiers,
    projectionLog,
    mode: twoABResult.mode,
    twoABRuleSatisfied: twoABResult.liveFormAllowed,
    warnings,
  };
}
