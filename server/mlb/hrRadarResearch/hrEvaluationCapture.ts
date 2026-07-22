// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — live evaluation capture orchestration (PR 2).
//
// Read-only observer. captureHrEvaluationEpoch is the ONLY function the
// orchestrator calls, and only AFTER champion computation for the tick has
// already fully completed (storage writes, edge-cache write, signal-bus
// population). It never reads-then-rewrites anything the champion touches —
// it only reads getAllGameHrSnapshots(gameId) (a read-only accessor) and the
// raw caches already assembled for the tick. Every step is wrapped so a
// failure here can never delay, block, or change champion decisions.
//
// Population completeness: every batter currently in the lineup, PLUS any
// batter who left the lineup on this exact tick (so their final
// lineup_removed_or_substituted row gets written), gets a snapshot row —
// not just batters the champion happened to evaluate for HR.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import type { PlayerContactData, WeatherCache, PitcherContextEntry } from "../dataPullService";
import { getMarketParkFactor, mergePitchUsage } from "../dataSources";
import { computePlayerParkWindFit } from "../parkWindFit";
import { estimateRichPADistribution } from "../paDistribution";
import { getAllGameHrSnapshots } from "../hrAlertEngine";
import type { HRAlertSnapshot } from "../hrAlertEngine";
import { HR_RADAR_PREDICTION_SCOPE } from "./hrEligibilityContract";
import { evaluateHrEligibility } from "./hrEligibilityEvaluator";
import { buildHrFeatureSnapshot, percentileFromDistribution, type HrFeatureBuilderBbe } from "./hrFeatureBuilder";
import { computeHrFeatureHash } from "./hrFeatureHash";
import { deriveEvaluationEpochId } from "./hrEvaluationEpochId";
import type { HrDetectedEpoch } from "./hrEvaluationEpochDetector";
import { shouldSampleGameForHrEvalCapture } from "./hrEvalCaptureSampling";
import { enqueueHrEvaluationSnapshot } from "./hrEvaluationWriteQueue";
import { recordHrCaptureDiagnostics } from "./hrEvalCaptureDiagnostics";
import type { InsertHrRadarEvaluationSnapshot } from "@shared/schema";

export interface HrCaptureBatterRollingStats {
  seasonHRRate: number | null;
  abSinceLastHR: number | null;
  hrRateLast7: number | null;
  hrRateLast15: number | null;
  hrRateLast30: number | null;
  seasonOps: number | null;
  seasonSlg: number | null;
  seasonIBBRate: number | null;
}

export interface HrCaptureBatterMaterials {
  batter: { playerId: string; playerName: string; team: string; slot: number };
  playerContact: PlayerContactData | null;
  rollingStats: HrCaptureBatterRollingStats | null;
  batterHand: string | null;
  alreadyHomeredThisGame: boolean;
  stillInBattingOrder: boolean;
}

export interface HrCaptureRuntimeContext {
  gameId: string;
  sessionDate: string;
  gameStatus: "live" | "pregame" | "final" | "unknown" | "suspended" | "postponed";
  state: {
    inning: number;
    isTopInning: boolean;
    pitchCount: number;
    outs: number;
    homeScore: number | null;
    awayScore: number | null;
  };
  detectedEpoch: HrDetectedEpoch;
  batters: HrCaptureBatterMaterials[];
  pitcherCtx: PitcherContextEntry | null;
  pitcherId: string | null;
  pitcherHand: string | null;
  pitcherEraSeasonal: number | null;
  weatherCache: WeatherCache | null;
  statsAsOfMs: number;
  flags: { enabled: boolean; percent: number };
}

function resolveRoofState(
  weatherCache: WeatherCache | null,
): "open" | "closed" | "retractable_unknown" | "na" | null {
  if (!weatherCache) return null;
  const roofTypeRaw = (weatherCache.roofTypeRaw ?? "").toLowerCase();
  const conditionRaw = (weatherCache.weatherConditionRaw ?? "").toLowerCase();
  if (!roofTypeRaw) return null;
  if (roofTypeRaw.includes("retractable")) {
    if (conditionRaw.includes("roof closed")) return "closed";
    if (conditionRaw.includes("roof open") || conditionRaw) return "open";
    return "retractable_unknown";
  }
  if (roofTypeRaw.includes("dome") || roofTypeRaw.includes("indoor")) return "closed";
  if (roofTypeRaw.includes("open")) return "na";
  return "na";
}

function nonHrBbeSequence(playerContact: PlayerContactData | null): HrFeatureBuilderBbe[] {
  const raw = playerContact?.priorABResults ?? [];
  // Filter out this batter's own home runs — an HR event can never become
  // evidence for predicting that same HR. Each play already collapses to one
  // entry regardless of how many measurements it produced (see
  // dataPullService.ts syncContactData), so this is already one-entry-per-BBE.
  return raw
    .filter((ab) => ab.hitType !== "home_run")
    .map((ab) => ({
      exitVelocity: ab.exitVelocity ?? null,
      launchAngle: ab.launchAngle ?? null,
      distance: ab.distance ?? null,
      outcome: ab.outcome ?? "other",
      hitType: ab.hitType ?? null,
      hrProbability: ab.hrProbability ?? null,
      inning: ab.inning ?? null,
      half: ab.half ?? null,
    }));
}

function pitchFamilyFitScores(
  playerContact: PlayerContactData | null,
  pitchMix: PitcherContextEntry["pitchMix"] | null | undefined,
): { pitchFamilyPowerFitScore: number | null; arsenalProfileFitScore: number | null } {
  const merged = mergePitchUsage(playerContact?.batterPitchSplits ?? null, pitchMix ?? null);
  if (!merged || merged.length === 0) {
    return { pitchFamilyPowerFitScore: null, arsenalProfileFitScore: null };
  }
  const withUsage = merged.filter((s) => s.usagePct != null && s.xSLG != null);
  if (withUsage.length === 0) {
    return { pitchFamilyPowerFitScore: null, arsenalProfileFitScore: null };
  }
  const mostUsed = withUsage.reduce((a, b) => ((b.usagePct ?? 0) > (a.usagePct ?? 0) ? b : a));
  const totalUsage = withUsage.reduce((sum, s) => sum + (s.usagePct ?? 0), 0);
  const arsenalProfileFitScore =
    totalUsage > 0
      ? withUsage.reduce((sum, s) => sum + (s.xSLG ?? 0) * (s.usagePct ?? 0), 0) / totalUsage
      : null;
  return { pitchFamilyPowerFitScore: mostUsed.xSLG ?? null, arsenalProfileFitScore };
}

/**
 * Builds one InsertHrRadarEvaluationSnapshot row for a single batter. Pure
 * except for the champion-output read (getAllGameHrSnapshots), which is a
 * read-only accessor into the champion's own in-memory state.
 */
function buildRowForBatter(
  ctx: HrCaptureRuntimeContext,
  materials: HrCaptureBatterMaterials,
  championSnapshots: Map<string, HRAlertSnapshot>,
): InsertHrRadarEvaluationSnapshot {
  const { batter, playerContact, rollingStats, batterHand, alreadyHomeredThisGame, stillInBattingOrder } = materials;
  const champion = championSnapshots.get(batter.playerId) ?? null;
  const championEvaluated = champion != null;

  const parkHrFactor = getMarketParkFactor(ctx.weatherCache?.venueName, "home_runs", null);
  const handednessParkHrFactor = getMarketParkFactor(ctx.weatherCache?.venueName, "home_runs", batterHand);
  const parkWindFit = computePlayerParkWindFit({
    venueName: ctx.weatherCache?.venueName ?? null,
    batterHand,
    pullRatePercent: playerContact?.pullRatePercent ?? null,
    windString: ctx.weatherCache?.windString ?? null,
    windDegrees: ctx.weatherCache?.windDegrees ?? null,
    windDirectionCoarse: ctx.weatherCache?.windDirection ?? null,
    windSpeedMph: ctx.weatherCache?.windSpeed ?? null,
    isIndoors: ctx.weatherCache?.isIndoors,
  });
  const remainingPaDist = estimateRichPADistribution(
    ctx.state.inning,
    batter.slot,
    (ctx.state.homeScore ?? 0) + (ctx.state.awayScore ?? 0),
    4.5,
    ctx.state.isTopInning,
  );
  const remainingPaEstimate =
    Object.entries(remainingPaDist).reduce((best, [pa, w]) => (w > (remainingPaDist[Number(best)] ?? -1) ? pa : best), "0");
  const { pitchFamilyPowerFitScore, arsenalProfileFitScore } = pitchFamilyFitScores(
    playerContact,
    ctx.pitcherCtx?.pitchMix,
  );

  const remainingPaEstimateNum = remainingPaEstimate != null ? Number(remainingPaEstimate) : null;

  const hasResolvedPlayerId = Boolean(batter.playerId);
  const championModeledProbabilityPositive =
    championEvaluated ? (champion!.hrOccurrenceProbability ?? 0) > 0 : null;

  const eligibility = evaluateHrEligibility({
    hasResolvedPlayerId,
    gameStatus: ctx.gameStatus,
    stillInBattingOrder,
    alreadyHomeredThisGame,
    remainingPaEstimate: remainingPaEstimateNum,
    championModeledProbabilityPositive,
  });

  const { derivedFeatures, availability, featureFreshness, rawInputs } = buildHrFeatureSnapshot({
    statsAsOfMs: ctx.statsAsOfMs,

    batterHand,
    seasonHRRate: rollingStats?.seasonHRRate ?? null,
    careerHRRate: null, // not currently tracked upstream — explicit null, not fabricated.
    barrelRateSeasonal: playerContact?.barrelPct != null ? playerContact.barrelPct / 100 : null,
    hardHitRateSeasonal: playerContact?.hardHitPct != null ? playerContact.hardHitPct / 100 : null,
    flyBallPercent: playerContact?.flyBallPercent ?? null,
    hrFBRatio: playerContact?.hrFBRatio ?? null,
    xSlg: playerContact?.xSLG ?? null,
    xIso: playerContact?.xISOSeason ?? null,
    sweetSpotPercent: playerContact?.sweetSpotPercent ?? null,
    pullRatePercent: playerContact?.pullRatePercent ?? null,
    batterPriorMeta: { fetchedAtMs: null },

    liveBbeSequence: nonHrBbeSequence(playerContact),
    gameBarrelCount: playerContact?.gameBarrelCount ?? null,
    gameAvgXBaToday: playerContact?.gameAvgXBA ?? null,
    seasonXBaForDelta: playerContact?.xBA ?? null,
    parkHrFactorForDistance: parkHrFactor,
    liveFormMeta: { fetchedAtMs: ctx.statsAsOfMs },

    pitcherHrRateAllowedSeasonal: null, // not currently tracked upstream — explicit null.
    pitcherFatigueScore: ctx.pitcherCtx?.velocityDrop ?? null,
    pitchCountToday: ctx.pitcherCtx?.pitchCount ?? null,
    timesThroughOrder: ctx.pitcherCtx?.timesThroughOrder ?? null,
    battersFacedToday: null, // not currently tracked upstream — explicit null.
    velocityTrendSlope: ctx.pitcherCtx?.recentVeloTrend ?? null,
    velocityDropFromSeason: ctx.pitcherCtx?.velocityDrop ?? null,
    pitchMixShiftScore: null, // no season-baseline pitch-mix snapshot tracked upstream yet.
    pitcherHand: ctx.pitcherHand,
    pitcherEraSeasonal: ctx.pitcherEraSeasonal,
    pitcherRemovalProbability: null, // no removal-probability model exists yet.
    pitcherStateMeta: { fetchedAtMs: ctx.statsAsOfMs },

    handednessSplitFactor: null,
    platoonAdvantage:
      batterHand && ctx.pitcherHand ? (batterHand !== ctx.pitcherHand ? true : false) : null,
    shrunkBatterVsHandHrRate: null,
    shrunkPitcherVsHandHrRateAllowed: null,
    pitchFamilyPowerFitScore,
    arsenalProfileFitScore,
    matchupMeta: { fetchedAtMs: ctx.statsAsOfMs },

    battingOrderSlot: batter.slot,
    lineupDistanceToNextPa: null, // requires current-batter-index context not threaded to capture yet.
    remainingPaEstimate: remainingPaEstimateNum,
    remainingPaP25: percentileFromDistribution(remainingPaDist, 0.25),
    remainingPaP50: percentileFromDistribution(remainingPaDist, 0.5),
    remainingPaP75: percentileFromDistribution(remainingPaDist, 0.75),
    inning: ctx.state.inning,
    scoreDifferential:
      ctx.state.homeScore != null && ctx.state.awayScore != null
        ? ctx.state.homeScore - ctx.state.awayScore
        : null,
    substitutionRiskScore: null,
    pitcherSurvivalUncertaintyScore: null,
    opportunityMeta: { fetchedAtMs: ctx.statsAsOfMs },

    windOutFactor: parkWindFit.fitMultiplier ?? null,
    temperatureF: ctx.weatherCache?.temperature ?? null,
    parkHrFactor,
    handednessParkHrFactor,
    wallDistanceFitScore: parkWindFit.components?.geometry ?? null,
    windVectorDegrees: ctx.weatherCache?.windDegrees ?? null,
    windSpeedMph: ctx.weatherCache?.windSpeed ?? null,
    humidityPercent: ctx.weatherCache?.humidity ?? null,
    pressureHpa: ctx.weatherCache?.pressure ?? null,
    roofState: resolveRoofState(ctx.weatherCache),
    environmentMeta: { fetchedAtMs: ctx.weatherCache?.fetchedAt ?? null },

    rawBvpHrRate: null,
    rawBvpPlateAppearances: null,
    atBatsSinceLastHr: rollingStats?.abSinceLastHR ?? null,
    seasonIbbRate: rollingStats?.seasonIBBRate ?? null,
    genericHotLabel: null,
    leverageIndex: null,

    identityConfidence: hasResolvedPlayerId ? "confirmed" : "unresolved",
    feedDegradationFlags: [],
  });

  const featureHash = computeHrFeatureHash(derivedFeatures);
  const evaluationEpochId = deriveEvaluationEpochId(
    ctx.gameId,
    ctx.detectedEpoch.triggerType,
    ctx.detectedEpoch.sourceEventId,
    0,
  );

  const row: InsertHrRadarEvaluationSnapshot = {
    snapshotId: randomUUID(),
    evaluationEpochId,
    sourceRevision: 0,
    sessionDate: ctx.sessionDate,
    gameId: ctx.gameId,
    playerId: batter.playerId,
    playerName: batter.playerName,
    team: batter.team,
    opponent: null,
    evaluationAt: new Date(ctx.statsAsOfMs),
    sourceEventAt: ctx.detectedEpoch.sourceEventAt ? new Date(ctx.detectedEpoch.sourceEventAt) : null,
    sourceEventId: ctx.detectedEpoch.sourceEventId,
    triggerType: ctx.detectedEpoch.triggerType,
    playSequence: ctx.detectedEpoch.playSequence,
    plateAppearanceId: null,
    inning: ctx.state.inning,
    half: ctx.state.isTopInning ? "top" : "bottom",
    outs: ctx.state.outs,
    currentPitcherId: ctx.pitcherId,
    battingOrderSlot: batter.slot,
    eligible: eligibility.eligible,
    exclusionReason: eligibility.exclusionReason,
    predictionTargetScope: HR_RADAR_PREDICTION_SCOPE,
    inputContractVersion: rawInputs.inputContractVersion,
    rawInputs,
    featureVersion: derivedFeatures.featureVersion,
    featureHash,
    derivedFeatures,
    availability,
    featureFreshness,
    statsAsOf: new Date(ctx.statsAsOfMs),
    championEvaluated,
    championExclusionReason: championEvaluated ? null : "not_evaluated",
    championVersionSource: "champion_live",
    championModelVersion: null,
    championRawProbability: championEvaluated ? String(champion!.hrConversionProbabilityRaw) : null,
    championCalibratedProbability: championEvaluated ? String(champion!.hrOccurrenceProbability) : null,
    championBuildScore: championEvaluated && champion!.buildScore != null ? String(champion!.buildScore) : null,
    championReadinessScore: championEvaluated ? String(champion!.hrReadinessScore) : null,
    championAlertPath: championEvaluated ? champion!.alertResult?.diagnostics?.alertPath ?? null : null,
    championAlertTier: championEvaluated ? champion!.alertResult?.alertTier ?? null : null,
    championStage: championEvaluated ? champion!.canonicalStage : null,
    championUserVisible: championEvaluated ? champion!.canonicalStage !== "watch" : false,
  };

  return row;
}

/**
 * Sole entry point the orchestrator calls, once per detected epoch, strictly
 * AFTER all champion computation/persistence for the tick has completed.
 * Synchronous — only enqueues rows onto the bounded write queue; the actual
 * DB write happens later on its own timer (hrEvaluationWriteQueue.ts).
 *
 * Wraps captureHrEvaluationEpochInner in its own top-level try/catch (in
 * addition to the per-batter try/catch inside it, and in addition to the
 * orchestrator's own call-site try/catch) — belt-and-suspenders, since
 * "capture failure never delays, blocks, or changes champion decisions" must
 * hold even if something upstream of the per-batter loop itself throws
 * (e.g. malformed population/state materials).
 */
export function captureHrEvaluationEpoch(ctx: HrCaptureRuntimeContext): void {
  try {
    captureHrEvaluationEpochInner(ctx);
  } catch (err) {
    console.warn(`[HR_RADAR_EVAL_CAPTURE] capture failed gameId=${ctx?.gameId ?? "unknown"} reason=${(err as Error)?.message ?? String(err)}`);
  }
}

function captureHrEvaluationEpochInner(ctx: HrCaptureRuntimeContext): void {
  if (!ctx.flags.enabled) return;
  if (!shouldSampleGameForHrEvalCapture(ctx.gameId, ctx.flags.percent)) return;

  const startedAtMs = ctx.statsAsOfMs;
  const championSnapshots = getAllGameHrSnapshots(ctx.gameId);

  // Population = current lineup ∪ any batter the epoch detector's diff found
  // no longer in it as of THIS tick (so a just-removed batter still gets one
  // final, correctly-excluded row). Read from ctx.detectedEpoch.removedBatters
  // — computed by the detector against the PRE-tick lineup — rather than
  // re-deriving via getLastKnownBattingOrder() here, which by the time this
  // function runs already reflects the POST-tick lineup (the detector updates
  // its own memory before triggerEngine/capture run), which would make
  // "removed" always compute as empty.
  const justRemoved: HrCaptureBatterMaterials[] = (ctx.detectedEpoch.removedBatters ?? [])
    .map((b) => ({
      batter: { playerId: b.playerId, playerName: b.playerName, team: b.team, slot: b.slot },
      playerContact: null,
      rollingStats: null,
      batterHand: null,
      alreadyHomeredThisGame: false,
      stillInBattingOrder: false,
    }));

  const population = [...ctx.batters, ...justRemoved];

  let eligibleCount = 0;
  let full = 0;
  let degraded = 0;
  let missing = 0;

  for (const materials of population) {
    try {
      const row = buildRowForBatter(ctx, materials, championSnapshots);
      if (row.eligible) eligibleCount++;
      if (row.derivedFeatures && typeof row.derivedFeatures === "object") {
        const q = (row.derivedFeatures as { dataQuality?: { overallQuality?: string } }).dataQuality?.overallQuality;
        if (q === "full") full++;
        else if (q === "degraded") degraded++;
        else missing++;
      }
      enqueueHrEvaluationSnapshot(row);
    } catch (err) {
      console.warn(
        `[HR_RADAR_EVAL_CAPTURE] per-batter capture failed gameId=${ctx.gameId} playerId=${materials?.batter?.playerId ?? "unknown"} reason=${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  try {
    recordHrCaptureDiagnostics({
      ts: startedAtMs,
      gameId: ctx.gameId,
      evaluationEpochId: deriveEvaluationEpochId(
        ctx.gameId,
        ctx.detectedEpoch.triggerType,
        ctx.detectedEpoch.sourceEventId,
        0,
      ),
      triggerType: ctx.detectedEpoch.triggerType,
      eligiblePopulationSize: population.length,
      eligibleCount,
      buildLatencyMs: Date.now() - startedAtMs,
      availabilityFullCount: full,
      availabilityDegradedCount: degraded,
      availabilityMissingCount: missing,
    });
  } catch { /* diagnostics never block capture */ }
}
