import type { MLBPropInput, MLBPropOutput } from "../types";
import { getPitchFamily } from "../pitchTypeNormalizer";
import { isBarrel } from "../statcastXBA";
import type { HrEvaluationSnapshotV1 } from "./hrEvaluationSnapshot";

/**
 * FROZEN — Live Edge HR engine, v1.
 *
 * This module is a deliberate, private fork of the `home_runs` evaluation
 * path as it existed at the moment this file was created (repo state:
 * jjettas248/LiveLocks main @ 0b24883, i.e. immediately after the Home Run
 * Radar UI retirement PR). It exists so `evaluateLiveEdgeHrV1` can keep
 * producing today's exact decision on a frozen input forever, even after a
 * later PR fixes the known defects in the live path (seasonHRRate wiring,
 * the unified `finalizeHomeRunSignal`, and the label-derivation ordering
 * bug — see the plan's Phase 3). That comparison is only meaningful if v1
 * cannot drift when the live code changes.
 *
 * HARD RULE FOR THIS FILE: it must never import
 * `computeHRRatePerPA`/`eventRates.ts`, `computeHrRadarSignalComposite` or
 * any of its sub-scorers/`deriveHrConfidenceTier`/`deriveSignalTier` from
 * `signalScore.ts`, or the HR Watch bump/label-derivation logic inline in
 * `liveGameOrchestrator.ts` — those are exactly the functions a later PR
 * edits in place to ship the fixes. Every one of them is forked verbatim
 * below instead. It is safe to import from files this consolidation does
 * not touch: `types.ts`, `pitchTypeNormalizer.ts`, `statcastXBA.ts`.
 * `liveEdgeHrV1Parity.test.ts` enforces both the "never imports the live
 * versions" rule (source-text scan) and "produces identical output to the
 * live versions" (direct diff against the real exported functions), so any
 * accidental import or transcription drift fails CI.
 *
 * KNOWN BUG PRESERVED ON PURPOSE: `signalMode` is derived from the
 * pre-bump `scoreBreakdown.total`/`confidenceTier`, but the near-HR bump
 * below mutates `scoreBreakdown.total`/`confidenceTier` afterward without
 * re-deriving `signalMode` — so `signalMode` can disagree with
 * `scoreBreakdown.confidenceTier` on tier band. This is today's real
 * production behavior (`liveGameOrchestrator.ts` ~L2549-2561, ~L2613-2653)
 * and must NOT be fixed here; fixing it is v2's job.
 */

// ── Forked from server/mlb/eventRates.ts (computeHRRatePerPA) ─────────────
// Diagnostic-only in this file: v1's per-PA HR rate is exposed for later
// A/B comparison against v2's corrected version, but is not fed back into a
// full engine-probability recompute — `snapshot.propOutput` (Phase 1's real,
// already-computed calibratedProbability/projection/edge/bookLine) is used
// as-is by the composition math below, exactly as the live composition
// layer does today (composition never re-derives engine probability).

const LEAGUE_AVG_HR_RATE_V1 = 0.033;
const LEAGUE_AVG_SLG_V1 = 0.400;

export function computeHRRatePerPAV1(input: MLBPropInput): number {
  const barrel = input.contactQuality.barrelRateProxySeason ?? 0.06;
  const hardHit = input.contactQuality.hardHitRateSeason ?? 0.35;

  let baseHR = input.seasonAvg > 0 && input.seasonAvg < 0.15
    ? input.seasonAvg
    : LEAGUE_AVG_HR_RATE_V1;

  const barrelPower = Math.min(2.0, barrel / 0.06);
  baseHR *= 0.5 + 0.5 * barrelPower;

  const hhPower = Math.min(1.5, hardHit / 0.35);
  baseHR *= 0.6 + 0.4 * hhPower;

  const ev = input.contactQuality.exitVelocity;
  if (ev != null && ev > 0) {
    if (ev >= 100) baseHR *= 1.15;
    else if (ev >= 95) baseHR *= 1.05;
    else if (ev < 88) baseHR *= 0.85;
  }

  const la = input.contactQuality.launchAngle;
  if (la != null) {
    if (la >= 20 && la <= 35) baseHR *= 1.10;
    else if (la < 10 || la > 45) baseHR *= 0.75;
  }

  if (input.contactQuality.xSLG != null && input.contactQuality.xSLG > 0) {
    const xslgFactor = input.contactQuality.xSLG / LEAGUE_AVG_SLG_V1;
    baseHR *= Math.max(0.7, Math.min(1.5, xslgFactor));
  }

  if (input.pitcher.era != null && input.pitcher.era > 4.5) {
    baseHR *= 1.08;
  }

  baseHR *= input.weatherPark.parkFactor;

  if (!input.weatherPark.isIndoors) {
    if (input.weatherPark.windDirection === "out" && (input.weatherPark.windSpeed ?? 0) >= 8) {
      baseHR *= 1.08;
    }
    const temp = input.weatherPark.temperature ?? 70;
    if (temp >= 85) baseHR *= 1.04;
    else if (temp <= 50) baseHR *= 0.92;
  }

  if (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) {
    baseHR *= 1.05;
  }

  const evSafe = input.contactQuality.exitVelocity ?? 0;
  const laSafe = input.contactQuality.launchAngle ?? 0;
  const isElitePower =
    (evSafe >= 95) &&
    (laSafe >= 18 && laSafe <= 36) &&
    (input.weatherPark.parkFactor >= 1.02) &&
    (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) &&
    ((input.pitcher.era ?? 0) > 4.5 ||
      (input.weatherPark.windDirection === "out" && (input.weatherPark.windSpeed ?? 0) >= 8));

  const cap = isElitePower ? 0.18 : 0.12;
  return Math.max(0.01, Math.min(cap, baseHR));
}

// ── Forked from server/mlb/signalScore.ts ──────────────────────────────────

export type SignalConfidenceTierV1 = "ELITE" | "STRONG" | "SOLID" | "WATCHLIST" | "NO_SIGNAL";

export interface SignalScoreBreakdownV1 {
  probability: number;
  projection: number;
  liveContext: number;
  matchup: number;
  form: number;
  opportunity: number;
  marketReliability: number;
  priceValidation: number;
  eventBoost: number;
  total: number;
  confidenceTier: SignalConfidenceTierV1;
}

export type SignalTierV1 = "watch" | "lean" | "strong" | "elite";

function clampV1(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function deriveSignalTierV1(confidenceTier: SignalConfidenceTierV1 | string | null | undefined): SignalTierV1 {
  switch (confidenceTier) {
    case "ELITE":
      return "elite";
    case "STRONG":
      return "strong";
    case "SOLID":
      return "lean";
    case "WATCHLIST":
    case "NO_SIGNAL":
    default:
      return "watch";
  }
}

export function deriveHrConfidenceTierV1(total: number): SignalConfidenceTierV1 {
  if (total >= 80) return "ELITE";
  if (total >= 65) return "STRONG";
  if (total >= 55) return "SOLID";
  if (total >= 35) return "WATCHLIST";
  return "NO_SIGNAL";
}

function computeProbabilityComponentV1(engineProb: number): number {
  if (engineProb >= 75) return 100;
  if (engineProb >= 65) return 80;
  if (engineProb >= 60) return 65;
  if (engineProb >= 55) return 50;
  if (engineProb >= 50) return 35;
  return 20;
}

function computeOpportunityComponentV1(input: MLBPropInput): number {
  const remaining = input.remainingPA;
  if (remaining >= 4) return 85;
  if (remaining >= 3) return 70;
  if (remaining >= 2) return 55;
  if (remaining >= 1) return 35;
  return 15;
}

function computeEventBoostComponentV1(input: MLBPropInput, output: MLBPropOutput): number {
  let boost = 0;

  const priorABs = input.contactQuality.priorABResults ?? [];
  const hasHR = priorABs.some(ab => ab.outcome === "home_run" || ab.outcome === "homerun");
  if (hasHR) boost += 40;

  const hasBarrel = priorABs.some(ab => isBarrel(ab.exitVelocity ?? null, ab.launchAngle ?? null));
  if (hasBarrel) boost += 30;

  const ev = input.contactQuality.exitVelocity ?? 0;
  if (ev >= 100) boost += 20;
  else if (ev >= 95) boost += 10;

  const hits = priorABs.filter(ab => ab.outcome === "hit" || ab.outcome === "home_run" || ab.outcome === "homerun").length;
  if (hits >= 3) boost += 20;
  else if (hits >= 2) boost += 10;

  const tb = input.currentStatValue;
  if (input.market === "total_bases" && tb >= 4) boost += 15;

  const pa = output.pitcherAnalysis;
  if (pa) {
    if (pa.stuff >= 75 && pa.swingMiss >= 70) boost += 15;
    if (pa.fatigue >= 65) boost += 10;
  }

  return clampV1(boost, 0, 100);
}

function computeParkWeatherComponentV1(input: MLBPropInput): number {
  let score = 50;
  if (input.weatherPark?.parkFactor != null) {
    const pf = input.weatherPark.parkFactor;
    if (pf >= 1.15) score += 20;
    else if (pf >= 1.10) score += 15;
    else if (pf >= 1.05) score += 8;
    else if (pf <= 0.90) score -= 15;
    else if (pf <= 0.95) score -= 8;
  }
  if (!input.weatherPark?.isIndoors) {
    if (input.weatherPark?.windDirection === "out" && (input.weatherPark?.windSpeed ?? 0) >= 8) score += 10;
    else if (input.weatherPark?.windDirection === "in" && (input.weatherPark?.windSpeed ?? 0) >= 8) score -= 10;
    const temp = input.weatherPark?.temperature ?? 70;
    if (temp >= 85) score += 5;
    else if (temp <= 50) score -= 8;
  }
  return clampV1(score, 0, 100);
}

function computeHrTimingComponentV1(input: MLBPropInput): number {
  const trend = input.hrTrend;
  if (!trend) return 50;
  const { abSinceLastHR, seasonTotalHR, seasonTotalAB } = trend;
  if (abSinceLastHR == null || seasonTotalAB === 0 || seasonTotalHR === 0) return 50;

  const expectedABperHR = seasonTotalAB / seasonTotalHR;
  const overdueRatio = abSinceLastHR / expectedABperHR;

  if (overdueRatio >= 3.0) return 90;
  if (overdueRatio >= 2.5) return 80;
  if (overdueRatio >= 2.0) return 72;
  if (overdueRatio >= 1.5) return 62;
  if (overdueRatio >= 1.0) return 52;
  if (overdueRatio < 0.5) return 35;
  return 45;
}

function computePitchMixMatchupScoreV1(input: MLBPropInput): number {
  const pitchMix = input.pitcher?.pitchMix;
  if (!pitchMix || pitchMix.length === 0) return 50;

  let fbPct = 0, breakPct = 0, offspeedPct = 0;
  for (const entry of pitchMix) {
    const family = getPitchFamily(entry.pitchType);
    if (family === "fastball") fbPct += entry.percentage;
    else if (family === "breaking") breakPct += entry.percentage;
    else if (family === "offspeed") offspeedPct += entry.percentage;
  }

  const batterHand = input.batterHand;
  const pitcherThrows = input.pitcher?.throws ?? null;
  const isOpposite = batterHand && pitcherThrows && batterHand !== pitcherThrows;

  let score = 50;
  if (fbPct >= 60) score += isOpposite ? 20 : 12;
  else if (fbPct >= 50) score += isOpposite ? 14 : 8;
  if (breakPct >= 45) score -= 18;
  else if (breakPct >= 35) score -= 10;
  if (offspeedPct >= 35) score -= 10;
  if (fbPct >= 60 && breakPct < 20) score += 8;

  return clampV1(score, 0, 100);
}

function computeHandednessSplitsScoreV1(input: MLBPropInput): number {
  let score = 50;
  const pitcherSplits = input.pitcherHandednessSplits;
  const batterSplits = input.batterHandednessSplits;
  const pitcherThrows = input.pitcher?.throws ?? null;
  const batterHand = input.batterHand;

  if (pitcherSplits && batterHand) {
    const matchupERA = batterHand === "L" ? pitcherSplits.eraVsLHB : pitcherSplits.eraVsRHB;
    if (matchupERA != null) {
      if (matchupERA >= 6.0) score += 20;
      else if (matchupERA >= 5.0) score += 13;
      else if (matchupERA >= 4.5) score += 7;
      else if (matchupERA <= 2.5) score -= 18;
      else if (matchupERA <= 3.2) score -= 10;
    }
    const matchupHrPer9 = batterHand === "L" ? pitcherSplits.hrPer9VsLHB : pitcherSplits.hrPer9VsRHB;
    if (matchupHrPer9 != null) {
      if (matchupHrPer9 >= 2.5) score += 22;
      else if (matchupHrPer9 >= 2.0) score += 14;
      else if (matchupHrPer9 >= 1.5) score += 7;
      else if (matchupHrPer9 <= 0.6) score -= 15;
      else if (matchupHrPer9 <= 0.9) score -= 8;
    }
  }

  if (batterSplits && pitcherThrows) {
    const hrRate = pitcherThrows === "L" ? batterSplits.hrRateVsLHP : batterSplits.hrRateVsRHP;
    const ops = pitcherThrows === "L" ? batterSplits.opsVsLHP : batterSplits.opsVsRHP;
    if (hrRate != null) {
      if (hrRate >= 0.055) score += 18;
      else if (hrRate >= 0.040) score += 10;
      else if (hrRate >= 0.030) score += 5;
      else if (hrRate <= 0.015) score -= 12;
    }
    if (ops != null) {
      if (ops >= 0.900) score += 8;
      else if (ops <= 0.650) score -= 8;
    }
  }

  return clampV1(score, 0, 100);
}

function computePowerProfileScoreV1(input: MLBPropInput): number {
  let score = 50;
  const cq = input.contactQuality;

  const rawParkFactor = (input.weatherPark as any)?.parkFactor ?? 1.0;
  const parkBias = 0.5 + 0.5 * rawParkFactor;

  const hrFB = cq.hrFBRatio != null ? cq.hrFBRatio / parkBias : null;
  if (hrFB != null) {
    if (hrFB >= 18) score += 22;
    else if (hrFB >= 14) score += 14;
    else if (hrFB >= 11) score += 6;
    else if (hrFB <= 8) score -= 12;
    else if (hrFB <= 11) score -= 4;
  }

  const fbPct = cq.flyBallPercent != null ? cq.flyBallPercent / Math.sqrt(parkBias) : null;
  if (fbPct != null) {
    if (fbPct >= 42) score += 12;
    else if (fbPct >= 38) score += 6;
    else if (fbPct <= 28) score -= 10;
  }

  const xISO = cq.xISOSeason;
  if (xISO != null) {
    if (xISO >= 0.220) score += 16;
    else if (xISO >= 0.180) score += 10;
    else if (xISO >= 0.140) score += 4;
    else if (xISO <= 0.100) score -= 10;
  }

  const xwoba = cq.xwOBASeason;
  if (xwoba != null) {
    if (xwoba >= 0.380) score += 10;
    else if (xwoba >= 0.340) score += 4;
    else if (xwoba <= 0.280) score -= 8;
  }

  const ss = cq.sweetSpotPercent;
  if (ss != null) {
    if (ss >= 38) score += 8;
    else if (ss >= 32) score += 4;
    else if (ss <= 22) score -= 6;
  }

  const batSpeed = cq.avgBatSpeed;
  const swingLen = cq.avgSwingLength;
  if (batSpeed != null && swingLen != null && swingLen > 0) {
    const eff = batSpeed / swingLen;
    if (eff >= 10.5) score += 8;
    else if (eff < 8.5) score -= 5;
  }

  const pull = cq.pullRatePercent;
  if (pull != null) {
    if (pull >= 48) score += 8;
    else if (pull >= 43) score += 4;
    else if (pull <= 32) score -= 5;
  }

  const barrelRate = cq.barrelRateProxySeason;
  if (barrelRate != null) {
    if (barrelRate >= 0.12) score += 14;
    else if (barrelRate >= 0.08) score += 8;
    else if (barrelRate >= 0.05) score += 3;
    else if (barrelRate <= 0.03) score -= 8;
  }

  const hardHit = cq.hardHitRateSeason;
  if (hardHit != null) {
    if (hardHit >= 0.50) score += 8;
    else if (hardHit >= 0.40) score += 4;
    else if (hardHit <= 0.28) score -= 5;
  }

  const xba = cq.xBA;
  if (xba != null) {
    if (xba >= 0.290) score += 8;
    else if (xba >= 0.260) score += 4;
    else if (xba <= 0.210) score -= 5;
  }

  const xslg = cq.xSLG;
  if (xslg != null) {
    if (xslg >= 0.550) score += 12;
    else if (xslg >= 0.480) score += 6;
    else if (xslg >= 0.420) score += 2;
    else if (xslg <= 0.340) score -= 8;
  }

  const hrLikelihood = cq.learnedHrLikelihood;
  if (hrLikelihood != null && hrLikelihood > 0) {
    if (hrLikelihood >= 0.20) score += 15;
    else if (hrLikelihood >= 0.12) score += 8;
    else if (hrLikelihood >= 0.06) score += 3;
  }

  return clampV1(score, 0, 100);
}

function computeLineupSlotHRScoreV1(input: MLBPropInput): number {
  const slot = input.lineup.battingOrderSlot;
  if (slot >= 3 && slot <= 5) return 70;
  if (slot === 2 || slot === 6) return 58;
  if (slot === 1) return 45;
  return 35;
}

function computePitcherEntryFatigueScoreV1(input: MLBPropInput): number {
  const ef = input.pitcherEntryFatigue;
  if (!ef) return 50;
  let score = 50;

  if (ef.lastStartPitchCount !== null) {
    if (ef.lastStartPitchCount >= 110) score += 20;
    else if (ef.lastStartPitchCount >= 95) score += 12;
  }
  if (ef.daysSinceLastStart !== null) {
    if (ef.daysSinceLastStart <= 3) score += 18;
    else if (ef.daysSinceLastStart <= 4) score += 10;
    else if (ef.daysSinceLastStart >= 8) score -= 10;
  }
  if (ef.last3StartERA !== null) {
    if (ef.last3StartERA >= 6.0) score += 18;
    else if (ef.last3StartERA >= 5.0) score += 10;
    else if (ef.last3StartERA <= 2.5) score -= 15;
  }

  return clampV1(score, 0, 100);
}

function computeRecentFormScoreV1(input: MLBPropInput): number {
  let score = 50;
  const trend = input.hrTrend;
  if (trend && trend.seasonTotalAB > 0 && trend.seasonTotalHR > 0) {
    const seasonRate = trend.seasonTotalHR / trend.seasonTotalAB;
    const l7 = trend.hrRateLast7;
    const l15 = trend.hrRateLast15;
    let recent: number | null = null;
    if (l7 != null && l15 != null) recent = 0.4 * l7 + 0.6 * l15;
    else if (l15 != null) recent = l15;
    else if (l7 != null) recent = l7;
    if (recent != null && seasonRate > 0) {
      const ratio = recent / seasonRate;
      if (ratio >= 1.8) score += 24;
      else if (ratio >= 1.4) score += 14;
      else if (ratio >= 1.1) score += 6;
      else if (ratio <= 0.4) score -= 16;
      else if (ratio <= 0.7) score -= 8;
    }
  }

  const rf = input.rollingForm;
  if (rf && rf.last15Ops != null && rf.seasonOps != null && rf.seasonOps > 0) {
    const opsRatio = rf.last15Ops / rf.seasonOps;
    if (opsRatio >= 1.15) score += 12;
    else if (opsRatio >= 1.07) score += 6;
    else if (opsRatio <= 0.85) score -= 10;
    else if (opsRatio <= 0.93) score -= 4;
  }

  return clampV1(score, 0, 100);
}

function computeIbbRespectScoreV1(input: MLBPropInput): number {
  const ibb = input.ibbContext;
  if (!ibb) return 50;
  let score = 50;

  const rate = ibb.seasonIBBRate;
  if (rate != null && rate > 0) {
    if (rate >= 0.030) score += 22;
    else if (rate >= 0.020) score += 14;
    else if (rate >= 0.010) score += 7;
  }

  const slot = input.lineup.battingOrderSlot;
  const isThreat = (rate != null && rate >= 0.010) || (slot >= 3 && slot <= 5);
  const closeGame = ibb.scoreDifferential != null && Math.abs(ibb.scoreDifferential) <= 2;
  const lateGame = ibb.inning != null && ibb.inning >= 6;
  if (ibb.firstBaseOpen === true && ibb.runnerInScoringPosition === true && isThreat) {
    score += closeGame && lateGame ? 14 : 7;
  }

  return clampV1(score, 0, 100);
}

export function computeHrRadarSignalCompositeV1(
  input: MLBPropInput,
  output: MLBPropOutput
): SignalScoreBreakdownV1 {
  const lei = input.liveInterpretation;

  let nearHrScore = 50;
  if (lei) {
    nearHrScore = clampV1(50 + (lei.nearHrScore / 0.15) * 50, 0, 100);
  }
  const priorABs = input.contactQuality.priorABResults ?? [];
  const hasBarrel = priorABs.some(ab => isBarrel(ab.exitVelocity ?? null, ab.launchAngle ?? null));
  const hasHR = priorABs.some(ab => ab.outcome === "home_run" || ab.outcome === "homerun" || ab.outcome === "hr");
  if (hasBarrel) nearHrScore = clampV1(nearHrScore + 25, 0, 100);
  if (hasHR) nearHrScore = clampV1(nearHrScore + 30, 0, 100);

  let contactScore = 50;
  const ev = input.contactQuality.exitVelocity;
  if (ev != null) {
    if (ev >= 105) contactScore = 95;
    else if (ev >= 100) contactScore = 85;
    else if (ev >= 95) contactScore = 70;
    else if (ev >= 90) contactScore = 55;
    else contactScore = 35;
  }
  if (input.contactQuality.barrelRateProxySeason != null && input.contactQuality.barrelRateProxySeason >= 0.10) contactScore = clampV1(contactScore + 10, 0, 100);
  if (input.contactQuality.xSLG != null && input.contactQuality.xSLG >= 0.500) contactScore = clampV1(contactScore + 10, 0, 100);

  let pitcherVuln = 50;
  if (lei) {
    pitcherVuln = clampV1(50 + (lei.pitcherFatigueScore / 0.15) * 30 + (lei.veloDropScore / 0.10) * 20, 0, 100);
  }
  if (input.pitcher.era != null && input.pitcher.era >= 5.0) pitcherVuln = clampV1(pitcherVuln + 12, 0, 100);
  else if (input.pitcher.era != null && input.pitcher.era >= 4.0) pitcherVuln = clampV1(pitcherVuln + 6, 0, 100);
  if (input.pitcher.isPitcherCollapsing) pitcherVuln = clampV1(pitcherVuln + 15, 0, 100);
  if (input.pitcher.timesThrough >= 3) pitcherVuln = clampV1(pitcherVuln + 10, 0, 100);

  const spin = input.pitcher.avgFastballSpin;
  if (spin != null) {
    if (spin < 2100) pitcherVuln = clampV1(pitcherVuln + 12, 0, 100);
    else if (spin < 2200) pitcherVuln = clampV1(pitcherVuln + 6, 0, 100);
    else if (spin > 2450) pitcherVuln = clampV1(pitcherVuln - 8, 0, 100);
  }

  const veloDrop = input.pitcher.velocityDrop;
  if (veloDrop != null && veloDrop > 0) {
    if (veloDrop >= 3.5) pitcherVuln = clampV1(pitcherVuln + 18, 0, 100);
    else if (veloDrop >= 2.5) pitcherVuln = clampV1(pitcherVuln + 10, 0, 100);
    else if (veloDrop >= 1.5) pitcherVuln = clampV1(pitcherVuln + 5, 0, 100);
  }

  if (input.pitcher.pitchCount >= 70 || input.pitcher.timesThrough >= 2) {
    const bp = input.bullpen;
    if (bp.bullpenEra != null && bp.bullpenEra >= 4.5) pitcherVuln = clampV1(pitcherVuln + 8, 0, 100);
    if (bp.bullpenUsageLastThreeDays != null && bp.bullpenUsageLastThreeDays >= 80) pitcherVuln = clampV1(pitcherVuln + 6, 0, 100);
    if (!bp.isTopRelieverAvailable) pitcherVuln = clampV1(pitcherVuln + 4, 0, 100);
  }

  const parkWeather = computeParkWeatherComponentV1(input);
  const opportunity = computeOpportunityComponentV1(input);
  const eventBoost = computeEventBoostComponentV1(input, output);
  const prob = computeProbabilityComponentV1(output.calibratedProbability);
  const pitchMixMatchup = computePitchMixMatchupScoreV1(input);
  const hrTiming = computeHrTimingComponentV1(input);
  const entryFatigue = computePitcherEntryFatigueScoreV1(input);
  const handednessSplits = computeHandednessSplitsScoreV1(input);
  const powerProfile = computePowerProfileScoreV1(input);
  const lineupSlotHR = computeLineupSlotHRScoreV1(input);
  const recentForm = computeRecentFormScoreV1(input);
  const ibbRespect = computeIbbRespectScoreV1(input);

  const baseTotal = Math.round(
    0.16 * nearHrScore +
    0.15 * contactScore +
    0.10 * pitcherVuln +
    0.08 * pitchMixMatchup +
    0.06 * hrTiming +
    0.06 * entryFatigue +
    0.05 * handednessSplits +
    0.06 * powerProfile +
    0.05 * parkWeather +
    0.03 * lineupSlotHR +
    0.03 * opportunity +
    0.04 * recentForm +
    0.03 * ibbRespect +
    0.05 * eventBoost +
    0.05 * prob
  );

  const total = clampV1(baseTotal, 0, 100);
  const confidenceTier = deriveHrConfidenceTierV1(total);

  return {
    probability:       Math.round(prob),
    projection:        Math.round(contactScore),
    liveContext:       Math.round(nearHrScore),
    matchup:           Math.round(handednessSplits),
    form:              Math.round(hrTiming),
    opportunity:       Math.round(opportunity),
    marketReliability: Math.round(parkWeather),
    priceValidation:   Math.round(powerProfile),
    eventBoost:        Math.round(eventBoost),
    total,
    confidenceTier,
  };
}

// ── Forked from server/mlb/liveGameOrchestrator.ts's HR Watch block ───────
// (~L2549-2561 signalMode ladder, ~L2567-2631 near-HR tag injection + bump).
// Faithful transcription, not a live import — see file header. The
// console.log/diagnosticsBuffer side effects in the original are diagnostics
// only and are intentionally not reproduced here; they have no effect on the
// decision fields this function returns.

export type HrSignalModeV1 = "hr_watch" | "hr_heating_up" | "hr_strong" | "hr_elite" | null;

export interface HrWatchCompositionResultV1 {
  signalMode: HrSignalModeV1;
  stampSignalType: "hr_watch" | undefined;
  bumpApplied: number;
}

/** Mutates `scoreBreakdown` in place (total/confidenceTier) and `signalTags` (drivers appended) — matching today's live behavior exactly, bug included. */
export function deriveHrWatchCompositionV1(
  scoreBreakdown: SignalScoreBreakdownV1,
  nearHrTier: "watch" | "lean" | null,
  nearHrDrivers: readonly string[],
  signalTags: string[],
): HrWatchCompositionResultV1 {
  const HR_WATCH_GATE = nearHrTier ? 25 : 35;

  // L2549-2561 today — HR-specific signalMode ladder, derived BEFORE the bump.
  let signalMode: HrSignalModeV1 = null;
  if (scoreBreakdown.confidenceTier === "ELITE") signalMode = "hr_elite";
  else if (scoreBreakdown.confidenceTier === "STRONG") signalMode = "hr_strong";
  else if (scoreBreakdown.confidenceTier === "SOLID") signalMode = "hr_heating_up";
  else if (scoreBreakdown.total >= HR_WATCH_GATE) signalMode = "hr_watch";

  let stampSignalType: "hr_watch" | undefined = undefined;
  let bumpApplied = 0;

  if (nearHrTier) {
    for (const d of nearHrDrivers) {
      if (!signalTags.includes(d)) signalTags.push(d);
    }

    // L2575-2577 today — "watch band" check, ALSO read before the bump.
    const isWatchBand = signalMode === "hr_watch" || signalMode === "hr_heating_up" || signalMode === null;
    if (isWatchBand) {
      stampSignalType = "hr_watch";
    }

    // L2619-2631 today — HR Watch → signalScore additive bump.
    // KNOWN BUG (preserved deliberately, fixed in v2): signalMode and
    // stampSignalType above were already derived from the PRE-bump total/
    // confidenceTier and are never re-derived after this mutation, so they
    // can disagree with the post-bump confidenceTier the rest of the live
    // pipeline reads (scoreBreakdown.confidenceTier, signalTier, signalScore
    // all reflect the mutation below; signalMode does not).
    const bump = nearHrTier === "lean" ? 6 : nearHrTier === "watch" ? 3 : 0;
    if (bump > 0) {
      const newTotal = Math.max(0, Math.min(100, scoreBreakdown.total + bump));
      scoreBreakdown.total = newTotal;
      scoreBreakdown.confidenceTier = deriveHrConfidenceTierV1(newTotal);
      bumpApplied = bump;
    }
  }

  return { signalMode, stampSignalType, bumpApplied };
}

// ── The v1 evaluator ────────────────────────────────────────────────────────

export interface LiveEdgeHrV1Result {
  readonly engineVersion: "live_edge_hr_v1";
  /** Diagnostic only — v1's own per-PA HR rate; not integrated into scoreBreakdown. See file header. */
  readonly hrRatePerPA: number;
  readonly scoreBreakdown: SignalScoreBreakdownV1;
  readonly signalTier: SignalTierV1;
  readonly signalMode: HrSignalModeV1;
  readonly signalType: "hr_watch" | undefined;
  readonly signalTags: string[];
}

export function evaluateLiveEdgeHrV1(snapshot: HrEvaluationSnapshotV1): LiveEdgeHrV1Result {
  const { propInput, propOutput, nearHrTier, nearHrDrivers } = snapshot;

  const hrRatePerPA = computeHRRatePerPAV1(propInput);
  const scoreBreakdown = computeHrRadarSignalCompositeV1(propInput, propOutput);
  const signalTags: string[] = [];

  const { signalMode, stampSignalType } = deriveHrWatchCompositionV1(
    scoreBreakdown,
    nearHrTier,
    nearHrDrivers,
    signalTags,
  );

  // Matches today's live derivation order: signalTier is computed from
  // scoreBreakdown.confidenceTier AFTER the bump has already mutated it
  // (liveGameOrchestrator.ts ~L2691) — only signalMode is stale (the bug).
  const signalTier = deriveSignalTierV1(scoreBreakdown.confidenceTier);

  return {
    engineVersion: "live_edge_hr_v1",
    hrRatePerPA,
    scoreBreakdown,
    signalTier,
    signalMode,
    signalType: stampSignalType,
    signalTags,
  };
}
