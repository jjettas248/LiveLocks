import type { HRAlertInput, HRAlertResult } from "./evaluateHRAlert";
import { evaluateHRAlert } from "./evaluateHRAlert";

export type DynamicHRState = "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED";

/**
 * Canonical user-facing HR Radar stage ladder (Phase 1 of HR Goldmaster fix).
 *
 * One — and only one — ladder is shown to users:
 *   watch → building → attack (with cooling and closed as terminal/lateral)
 *
 * The dynamic state machine (DynamicHRState) is the source of truth.
 * Legacy taxonomies (confidenceTier monitor/building/strong, signalState
 * watching/live/actionable) remain in storage for backwards compatibility
 * but the live UX MUST always use HrRadarStage derived via mapDynamicStateToStage.
 */
export type HrRadarStage = "watch" | "building" | "attack" | "cooling" | "closed";

export function mapDynamicStateToStage(s: DynamicHRState): HrRadarStage {
  switch (s) {
    case "BET_NOW":    return "attack";
    case "PREPARE":    return "building";
    case "WATCH":      return "watch";
    case "COOLED_OFF": return "cooling";
    case "CLOSED":     return "closed";
  }
}

/** Numeric rank for ladder progression — used to detect auto-advance transitions. */
export const STAGE_RANK: Record<HrRadarStage, number> = {
  closed:   -1,
  watch:     0,
  cooling:   1, // peer of building (sideways from attack), but not below watch
  building:  1,
  attack:    2,
};

export function isStageAdvance(prev: HrRadarStage | null | undefined, next: HrRadarStage): boolean {
  if (!prev) return next !== "watch" && next !== "closed";
  return STAGE_RANK[next] > STAGE_RANK[prev];
}

/**
 * Canonical HR Radar score contract.
 *
 * These three score domains are NEVER interchangeable:
 *   - buildScore                : 0–10 formation score (HRSignalBuilder)
 *   - readinessScore            : 0–100 execution-readiness score (board ranking)
 *   - conversionProbability     : 0–1 calibrated HR conversion probability (analytics)
 *
 * The previous ambiguous "peakScore" field is kept only as a deprecated alias
 * for backwards compatibility with persisted/external readers; new code MUST
 * use the explicit names below.
 */
export interface HRAlertSnapshot {
  // Lifecycle
  isInitialized: boolean;
  currentState: DynamicHRState;
  detectedInning: number | null;
  /**
   * Half-inning of first detection ("top" | "bottom"). Frozen at first
   * non-WATCH transition; never advances even if score climbs later.
   */
  detectedHalf: "top" | "bottom" | null;
  /**
   * Wall-clock millis when this player first crossed the WATCH threshold.
   * Used by storage CREATE to backfill the persisted detectedAt so the DB
   * row reflects the engine's earliest observation, not the inning when
   * persistence finally fired.
   */
  detectedAtMs: number | null;
  currentInning: number;
  lastStateChangeAt: number;
  dataFreshnessMs: number;
  tickCount: number;
  lastRecomputeAt: number;
  decayFactor: number;

  // Canonical score contract
  buildScore: number | null;
  hrReadinessScore: number;
  peakReadinessScore: number;
  hrConversionProbabilityRaw: number;
  hrConversionProbabilityCalibrated: number;
  peakConversionProbability: number;
  /** @deprecated Use peakConversionProbability for probabilities or peakReadinessScore for readiness. */
  peakScore: number;

  // Drivers / context
  remainingPAExpectation: number;
  positiveDrivers: string[];
  negativeSuppressors: string[];
  cooldownReason: string | null;
  pitcherHrVulnerability: number;
  peakState: DynamicHRState;
  peakAt: number;
  alertResult: HRAlertResult;
}

interface BatterHRState {
  playerId: string;
  playerName: string;
  gameId: string;
  currentState: DynamicHRState;
  lastStateChangeAt: number;
  peakConversionProbability: number;
  peakReadinessScore: number;
  peakState: DynamicHRState;
  peakAt: number;
  detectedInning: number | null;
  detectedHalf: "top" | "bottom" | null;
  detectedAtMs: number | null;
  tickCount: number;
  lastRecomputeAt: number;
  contactEventsAtLastRecompute: number;
  lastAlertResult: HRAlertResult | null;
  previousPitcherId: string | null;
  consecutiveDeclineTicks: number;
  lastSnapshot: HRAlertSnapshot | null;
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
      peakConversionProbability: 0,
      peakReadinessScore: 0,
      peakState: "WATCH",
      peakAt: now,
      detectedInning: null,
      detectedHalf: null,
      detectedAtMs: null,
      tickCount: 0,
      lastRecomputeAt: 0,
      contactEventsAtLastRecompute: 0,
      lastAlertResult: null,
      previousPitcherId: options.currentPitcherId ?? null,
      consecutiveDeclineTicks: 0,
      lastSnapshot: null,
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
  // Readiness is a 0–100 composite:
  //   * up to 40 points from confidenceScore (engine 0–10 scale → /10 * 40)
  //   * up to 60 points from calibrated HR-conversion probability scaled
  //     against BET_NOW_THRESHOLD. Both `effectiveCalibrated` and
  //     `BET_NOW_THRESHOLD` are 0–1 probabilities, so we divide directly
  //     (NO extra *100 — that previously inflated the term ~100x and
  //     pinned every batter at readiness=100, killing the dynamic display).
  const confidencePts = Math.max(0, Math.min(40, (alertResult.confidenceScore / 10) * 40));
  const conversionPts = Math.max(0, Math.min(60, (effectiveCalibrated / BET_NOW_THRESHOLD) * 60));
  const readinessScore = Math.round(confidencePts + conversionPts);
  const clampedReadiness = Math.min(100, Math.max(0, readinessScore));

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

  // Track explicit per-domain peaks separately
  if (effectiveCalibrated > prev.peakConversionProbability || newState === "BET_NOW") {
    prev.peakConversionProbability = Math.max(prev.peakConversionProbability, effectiveCalibrated);
    if (newState === "BET_NOW" || newState === "PREPARE") {
      prev.peakState = newState;
      prev.peakAt = now;
    }
  }
  if (clampedReadiness > prev.peakReadinessScore) {
    prev.peakReadinessScore = clampedReadiness;
  }

  if (stateChanged) {
    prev.lastStateChangeAt = now;
    prev.currentState = newState;
    if (newState !== "WATCH" && newState !== "CLOSED" && newState !== "COOLED_OFF" && prev.detectedInning == null) {
      prev.detectedInning = input.inning;
      prev.detectedHalf = input.isTopInning === false ? "bottom" : "top";
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

  const buildScore = (alertResult.diagnostics as any)?.hrBuildScore ?? null;

  const snapshot: HRAlertSnapshot = {
    isInitialized: true,
    currentState: newState,
    detectedInning: prev.detectedInning,
    detectedHalf: prev.detectedHalf,
    detectedAtMs: prev.detectedAtMs,
    currentInning: input.inning,
    lastStateChangeAt: prev.lastStateChangeAt,
    dataFreshnessMs,
    tickCount: prev.tickCount,
    lastRecomputeAt: now,
    decayFactor,
    buildScore,
    hrReadinessScore: clampedReadiness,
    peakReadinessScore: prev.peakReadinessScore,
    hrConversionProbabilityRaw: rawProb,
    hrConversionProbabilityCalibrated: effectiveCalibrated,
    peakConversionProbability: prev.peakConversionProbability,
    peakScore: prev.peakConversionProbability, // deprecated alias
    remainingPAExpectation: remainingPA,
    positiveDrivers,
    negativeSuppressors,
    cooldownReason,
    pitcherHrVulnerability: pitcherVuln,
    peakState: prev.peakState,
    peakAt: prev.peakAt,
    alertResult,
  };

  prev.lastSnapshot = snapshot;
  return snapshot;
}

/**
 * Returns the latest real persisted snapshot for a batter+game pair.
 *
 * If no snapshot has ever been computed for this key, returns a null-safe
 * placeholder with `isInitialized: false`. Consumers MUST check this flag
 * before treating numeric fields as live measurements — previously this
 * accessor returned a fake "all zeros" snapshot which downstream code
 * misread as a real live state.
 */
export function getHrAlertState(gameId: string, playerId: string): HRAlertSnapshot | null {
  const prev = stateMap.get(stateKey(gameId, playerId));
  if (!prev) return null;
  if (prev.lastSnapshot) return prev.lastSnapshot;
  if (!prev.lastAlertResult) {
    return {
      isInitialized: false,
      currentState: prev.currentState,
      detectedInning: prev.detectedInning,
      detectedHalf: prev.detectedHalf,
      detectedAtMs: prev.detectedAtMs,
      currentInning: 0,
      lastStateChangeAt: prev.lastStateChangeAt,
      dataFreshnessMs: prev.lastRecomputeAt > 0 ? Date.now() - prev.lastRecomputeAt : 0,
      tickCount: prev.tickCount,
      lastRecomputeAt: prev.lastRecomputeAt,
      decayFactor: 1,
      buildScore: null,
      hrReadinessScore: 0,
      peakReadinessScore: prev.peakReadinessScore,
      hrConversionProbabilityRaw: 0,
      hrConversionProbabilityCalibrated: 0,
      peakConversionProbability: prev.peakConversionProbability,
      peakScore: prev.peakConversionProbability,
      remainingPAExpectation: 0,
      positiveDrivers: [],
      negativeSuppressors: [],
      cooldownReason: null,
      pitcherHrVulnerability: 0,
      peakState: prev.peakState,
      peakAt: prev.peakAt,
      alertResult: null as any,
    };
  }
  // Reconstruct from last alert result if snapshot lost (defensive)
  return prev.lastSnapshot;
}

/**
 * Task #121 Step 1 — restart-safe detection persistence.
 *
 * Seeds the in-memory state for (gameId, playerId) with the row's previously
 * persisted `detectedInning/detectedHalf/detectedAtMs` so a server restart
 * does not let `recomputeHrAlertState` re-stamp detection at the current
 * inning. Idempotent: existing detection is NEVER overwritten — once frozen,
 * it is the source of truth for the lifetime of the alert row.
 *
 * Pure state seeding — no scoring, no math, no thresholds. Safe under the
 * "do not touch HR engines/scoring math/calibration" constraint.
 */
export function seedHrAlertDetection(
  gameId: string,
  playerId: string,
  playerName: string,
  detection: { detectedInning: number | null; detectedHalf: "top" | "bottom" | null; detectedAtMs: number | null },
): void {
  if (detection.detectedInning == null || detection.detectedAtMs == null) return;
  const key = stateKey(gameId, playerId);
  const existing = stateMap.get(key);
  if (existing) {
    if (existing.detectedInning != null) return; // never overwrite
    existing.detectedInning = detection.detectedInning;
    existing.detectedHalf = detection.detectedHalf;
    existing.detectedAtMs = detection.detectedAtMs;
    return;
  }
  stateMap.set(key, {
    playerId,
    playerName,
    gameId,
    currentState: "WATCH",
    lastStateChangeAt: detection.detectedAtMs,
    peakConversionProbability: 0,
    peakReadinessScore: 0,
    peakState: "WATCH",
    peakAt: detection.detectedAtMs,
    detectedInning: detection.detectedInning,
    detectedHalf: detection.detectedHalf,
    detectedAtMs: detection.detectedAtMs,
    tickCount: 0,
    lastRecomputeAt: 0,
    contactEventsAtLastRecompute: 0,
    lastAlertResult: null,
    previousPitcherId: null,
    consecutiveDeclineTicks: 0,
    lastSnapshot: null,
  });
}

export function clearGameHrStates(gameId: string): void {
  for (const key of Array.from(stateMap.keys())) {
    if (key.startsWith(`${gameId}_`)) stateMap.delete(key);
  }
}

export function getAllGameHrSnapshots(gameId: string): Map<string, HRAlertSnapshot> {
  const results = new Map<string, HRAlertSnapshot>();
  for (const [key, state] of Array.from(stateMap.entries())) {
    if (!key.startsWith(`${gameId}_`)) continue;
    if (!state.lastAlertResult) continue;
    const snap = getHrAlertState(gameId, state.playerId);
    if (snap && snap.isInitialized) results.set(state.playerId, snap);
  }
  return results;
}
