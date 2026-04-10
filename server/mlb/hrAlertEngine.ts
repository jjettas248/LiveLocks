import type { HRAlertInput, HRAlertResult } from "./evaluateHRAlert";
import { evaluateHRAlert } from "./evaluateHRAlert";

export type DynamicHRState = "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED";

export interface HRAlertSnapshot {
  currentState: DynamicHRState;
  hrReadinessScore: number;
  hrConversionProbabilityRaw: number;
  hrConversionProbabilityCalibrated: number;
  remainingPAExpectation: number;
  positiveDrivers: string[];
  negativeSuppressors: string[];
  cooldownReason: string | null;
  lastStateChangeAt: number;
  dataFreshnessMs: number;
  peakScore: number;
  peakState: DynamicHRState;
  peakAt: number;
  detectedInning: number | null;
  currentInning: number;
  pitcherHrVulnerability: number;
  decayFactor: number;
  tickCount: number;
  lastRecomputeAt: number;
  alertResult: HRAlertResult;
}

interface BatterHRState {
  playerId: string;
  playerName: string;
  gameId: string;
  currentState: DynamicHRState;
  lastStateChangeAt: number;
  peakScore: number;
  peakState: DynamicHRState;
  peakAt: number;
  detectedInning: number | null;
  detectedAtMs: number | null;
  tickCount: number;
  lastRecomputeAt: number;
  contactEventsAtLastRecompute: number;
  lastAlertResult: HRAlertResult | null;
  previousPitcherId: string | null;
  consecutiveDeclineTicks: number;
}

const stateMap = new Map<string, BatterHRState>();

function stateKey(gameId: string, playerId: string): string {
  return `${gameId}_${playerId}`;
}

const BET_NOW_THRESHOLD = 0.14;
const PREPARE_THRESHOLD = 0.08;
const WATCH_THRESHOLD = 0.05;

const DECAY_HALF_LIFE_MINUTES = 12;
const DECAY_PA_HALF_LIFE = 3;
const CONSECUTIVE_DECLINE_COOLDOWN = 3;

function computeDecayFactor(minutesSinceDetection: number, pasSinceDetection: number): number {
  const timeDecay = Math.pow(0.5, minutesSinceDetection / DECAY_HALF_LIFE_MINUTES);
  const paDecay = Math.pow(0.5, pasSinceDetection / DECAY_PA_HALF_LIFE);
  return Math.min(timeDecay, paDecay);
}

function computeRemainingPA(
  inning: number,
  isTopInning: boolean,
  battingOrderSlot: number,
  isHome: boolean
): number {
  const currentHalfInning = (inning - 1) * 2 + (isTopInning ? 0 : 1);
  const totalHalfInnings = isHome ? 17 : 18;
  const remainingHalfInnings = Math.max(0, totalHalfInnings - currentHalfInning);
  const battersPerHalfInning = 4.3;
  const totalRemainingBatters = remainingHalfInnings * battersPerHalfInning / 2;
  const orderCyclesRemaining = totalRemainingBatters / 9;
  const adjustedSlotFactor = battingOrderSlot <= 4 ? 1.15 : battingOrderSlot <= 6 ? 1.0 : 0.85;
  return Math.max(0, orderCyclesRemaining * adjustedSlotFactor);
}

function computePitcherHrVulnerability(input: HRAlertInput): number {
  let vuln = 50;
  const pc = input.pitchCount ?? 0;
  if (pc >= 100) vuln += 20;
  else if (pc >= 90) vuln += 15;
  else if (pc >= 75) vuln += 8;

  const tto = input.timesThrough ?? 1;
  if (tto >= 3) vuln += 12;
  else if (tto >= 2) vuln += 5;

  if (input.isPitcherCollapsing) vuln += 20;

  const era = input.era;
  if (era != null && era >= 5.0) vuln += 12;
  else if (era != null && era >= 4.0) vuln += 6;

  const det = input.pitcherDeterioration;
  if (det) {
    if (det.velocityDrop !== null && det.velocityDrop > 2) vuln += 10;
    if (det.isReliever && det.relieverEra !== null && det.relieverEra >= 5.0) vuln += 8;
    if (det.bullpenEra !== null && det.bullpenEra >= 5.0) vuln += 5;
  }

  if (input.leiPitcherFatigueScore != null && input.leiPitcherFatigueScore >= 0.07) vuln += 8;
  if (input.leiVeloDropScore != null && input.leiVeloDropScore >= 0.06) vuln += 5;

  return Math.min(100, Math.max(0, vuln));
}

function deriveState(
  calibratedProb: number,
  decayFactor: number,
  prevState: DynamicHRState,
  consecutiveDeclines: number,
  hardVetoed: boolean,
  gameFinal: boolean
): DynamicHRState {
  if (gameFinal) return "CLOSED";

  if (prevState === "COOLED_OFF") {
    if (calibratedProb * decayFactor >= BET_NOW_THRESHOLD) return "BET_NOW";
    if (calibratedProb * decayFactor >= PREPARE_THRESHOLD) return "PREPARE";
    return "COOLED_OFF";
  }

  if (hardVetoed) return prevState === "BET_NOW" || prevState === "PREPARE" ? "COOLED_OFF" : "WATCH";

  const effectiveProb = calibratedProb * decayFactor;

  if (effectiveProb >= BET_NOW_THRESHOLD) return "BET_NOW";
  if (effectiveProb >= PREPARE_THRESHOLD) return "PREPARE";
  if (effectiveProb >= WATCH_THRESHOLD) return "WATCH";

  if (prevState === "BET_NOW" || prevState === "PREPARE") {
    if (consecutiveDeclines >= CONSECUTIVE_DECLINE_COOLDOWN) return "COOLED_OFF";
    return "WATCH";
  }

  return "WATCH";
}

export function recomputeHrAlertState(
  input: HRAlertInput,
  options: {
    gameFinal?: boolean;
    currentPitcherId?: string | null;
    isHome?: boolean;
    precomputedAlert?: HRAlertResult;
  } = {}
): HRAlertSnapshot {
  const key = stateKey(input.gameId, input.playerId);
  const now = Date.now();

  let prev = stateMap.get(key);
  if (!prev) {
    prev = {
      playerId: input.playerId,
      playerName: input.playerName,
      gameId: input.gameId,
      currentState: "WATCH",
      lastStateChangeAt: now,
      peakScore: 0,
      peakState: "WATCH",
      peakAt: now,
      detectedInning: null,
      detectedAtMs: null,
      tickCount: 0,
      lastRecomputeAt: 0,
      contactEventsAtLastRecompute: 0,
      lastAlertResult: null,
      previousPitcherId: options.currentPitcherId ?? null,
      consecutiveDeclineTicks: 0,
    };
    stateMap.set(key, prev);
  }

  const alertResult = options.precomputedAlert ?? evaluateHRAlert(input);
  const convResult = alertResult.diagnostics?.hrConversion;
  const rawProb = convResult?.hrConversionProbability ?? 0;
  const calibratedProb = convResult?.calibratedProbability ?? rawProb;

  const minutesSinceDetection = prev.detectedAtMs != null
    ? (now - prev.detectedAtMs) / 60000
    : 0;
  const currentContactEvents = input.priorABResults?.length ?? 0;
  const pasSinceDetection = Math.max(0, currentContactEvents - prev.contactEventsAtLastRecompute);
  const decayFactor = prev.detectedAtMs != null ? computeDecayFactor(minutesSinceDetection, pasSinceDetection) : 1.0;

  const hardVetoed = alertResult.diagnostics?.alertPath === "VETOED" ||
    alertResult.diagnostics?.alertPath === "CONV_LOW";

  const pitcherChanged = options.currentPitcherId != null &&
    prev.previousPitcherId != null &&
    options.currentPitcherId !== prev.previousPitcherId;

  const effectiveCalibrated = pitcherChanged
    ? calibratedProb * 0.85
    : calibratedProb;

  const wasBetterBefore = prev.lastAlertResult != null &&
    (prev.lastAlertResult.confidenceScore > alertResult.confidenceScore);
  const consecutiveDeclines = wasBetterBefore
    ? prev.consecutiveDeclineTicks + 1
    : 0;

  const newState = deriveState(
    effectiveCalibrated,
    decayFactor,
    prev.currentState,
    consecutiveDeclines,
    hardVetoed,
    options.gameFinal ?? false
  );

  const stateChanged = newState !== prev.currentState;
  const readinessScore = Math.round(
    (alertResult.confidenceScore / 10) * 40 +
    Math.min(100, (effectiveCalibrated * 100) / BET_NOW_THRESHOLD * 60)
  );

  const pitcherVuln = computePitcherHrVulnerability(input);
  const remainingPA = computeRemainingPA(
    input.inning,
    input.isTopInning ?? true,
    input.battingOrderSlot ?? 5,
    options.isHome ?? false
  );

  const positiveDrivers: string[] = alertResult.diagnostics?.positiveFactors ?? [];
  const negativeSuppressors: string[] = (alertResult.diagnostics?.suppressionFlags ?? []).map(f => f.reason);

  let cooldownReason: string | null = null;
  if (newState === "COOLED_OFF") {
    if (pitcherChanged) cooldownReason = "Pitcher change — new arm reduces HR vulnerability";
    else if (consecutiveDeclines >= CONSECUTIVE_DECLINE_COOLDOWN) cooldownReason = "Evidence decayed without reinforcement";
    else if (hardVetoed) cooldownReason = "Hard suppression flag triggered";
    else cooldownReason = "Context deteriorated";
  }

  if (effectiveCalibrated > prev.peakScore || newState === "BET_NOW") {
    prev.peakScore = Math.max(prev.peakScore, effectiveCalibrated);
    if (newState === "BET_NOW" || newState === "PREPARE") {
      prev.peakState = newState;
      prev.peakAt = now;
    }
  }

  if (stateChanged) {
    prev.lastStateChangeAt = now;
    prev.currentState = newState;
    if (newState !== "WATCH" && newState !== "CLOSED" && newState !== "COOLED_OFF" && prev.detectedInning == null) {
      prev.detectedInning = input.inning;
      prev.detectedAtMs = now;
      prev.contactEventsAtLastRecompute = currentContactEvents;
    }
  }

  const dataFreshnessMs = prev.lastRecomputeAt > 0 ? now - prev.lastRecomputeAt : 0;

  prev.tickCount++;
  prev.lastRecomputeAt = now;
  prev.lastAlertResult = alertResult;
  prev.consecutiveDeclineTicks = consecutiveDeclines;
  if (options.currentPitcherId != null) {
    prev.previousPitcherId = options.currentPitcherId;
  }

  return {
    currentState: newState,
    hrReadinessScore: Math.min(100, Math.max(0, readinessScore)),
    hrConversionProbabilityRaw: rawProb,
    hrConversionProbabilityCalibrated: effectiveCalibrated,
    remainingPAExpectation: remainingPA,
    positiveDrivers,
    negativeSuppressors,
    cooldownReason,
    lastStateChangeAt: prev.lastStateChangeAt,
    dataFreshnessMs,
    peakScore: prev.peakScore,
    peakState: prev.peakState,
    peakAt: prev.peakAt,
    detectedInning: prev.detectedInning,
    currentInning: input.inning,
    pitcherHrVulnerability: pitcherVuln,
    decayFactor,
    tickCount: prev.tickCount,
    lastRecomputeAt: now,
    alertResult,
  };
}

export function getHrAlertState(gameId: string, playerId: string): HRAlertSnapshot | null {
  const prev = stateMap.get(stateKey(gameId, playerId));
  if (!prev || !prev.lastAlertResult) return null;

  return {
    currentState: prev.currentState,
    hrReadinessScore: 0,
    hrConversionProbabilityRaw: 0,
    hrConversionProbabilityCalibrated: prev.peakScore,
    remainingPAExpectation: 0,
    positiveDrivers: prev.lastAlertResult.diagnostics?.positiveFactors ?? [],
    negativeSuppressors: (prev.lastAlertResult.diagnostics?.suppressionFlags ?? []).map(f => f.reason),
    cooldownReason: null,
    lastStateChangeAt: prev.lastStateChangeAt,
    dataFreshnessMs: Date.now() - prev.lastRecomputeAt,
    peakScore: prev.peakScore,
    peakState: prev.peakState,
    peakAt: prev.peakAt,
    detectedInning: prev.detectedInning,
    currentInning: 0,
    pitcherHrVulnerability: 0,
    decayFactor: 1,
    tickCount: prev.tickCount,
    lastRecomputeAt: prev.lastRecomputeAt,
    alertResult: prev.lastAlertResult,
  };
}

export function clearGameHrStates(gameId: string): void {
  for (const key of Array.from(stateMap.keys())) {
    if (key.startsWith(`${gameId}_`)) stateMap.delete(key);
  }
}

export function getAllGameHrSnapshots(gameId: string): Map<string, HRAlertSnapshot> {
  const results = new Map<string, HRAlertSnapshot>();
  for (const [key, state] of stateMap) {
    if (!key.startsWith(`${gameId}_`)) continue;
    if (!state.lastAlertResult) continue;
    const snap = getHrAlertState(gameId, state.playerId);
    if (snap) results.set(state.playerId, snap);
  }
  return results;
}
