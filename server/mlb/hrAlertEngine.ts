import type { HRAlertInput, HRAlertResult } from "./evaluateHRAlert";
import { evaluateHRAlert } from "./evaluateHRAlert";
import type { HrRadarLifecycleEvent, HrRadarLifecycleState } from "./hrRadarStateMachine";

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
 * Phase 5 — Unified canonical stage computation.
 *
 * Single source of truth that merges the dynamic state machine and the PATH
 * evaluator into ONE canonical stage. Replaces the orchestrator-level
 * `bridgeCanonicalStage` band-aid so the engine's snapshot already carries
 * the user-facing stage and downstream code can stop running parallel logic.
 *
 * Rules:
 *   - CLOSED is terminal. A PATH PEAK arriving after game-final / post-hit
 *     closure must NEVER reopen the alert.
 *   - PATH PEAK is treated as `attack` rank; PATH BUILDING as `building`.
 *   - We take the MAX rank of (dynamic stage, path stage). Cooling and
 *     building are peers — a PATH BUILDING does not override an active
 *     cool-off; only a stronger PATH PEAK can outrank cooling.
 *
 * Note: pathSignalState is the PATH evaluator's `signalState` field. Engine
 * callers should always pass `alertResult.signalState` from the same alert
 * result that produced the dynamic state.
 */
const CANONICAL_STAGE_RANK: Record<HrRadarStage, number> = {
  closed: -1, watch: 0, cooling: 1, building: 1, attack: 2,
};
export function computeUnifiedCanonicalStage(
  dynamicStage: HrRadarStage,
  pathSignalState: string | null | undefined,
): HrRadarStage {
  // Terminal-state guard — closed must not be reopened by PATH evaluator.
  if (dynamicStage === "closed") return "closed";
  const pathStage: HrRadarStage | null =
    pathSignalState === "PEAK" ? "attack"
    : pathSignalState === "BUILDING" ? "building"
    : null;
  if (!pathStage) return dynamicStage;
  // Strict greater-than so peers (cooling vs building) do not override.
  return CANONICAL_STAGE_RANK[pathStage] > CANONICAL_STAGE_RANK[dynamicStage]
    ? pathStage
    : dynamicStage;
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
  /**
   * Phase 5 — Unified canonical stage. The single user-facing stage produced
   * by merging the dynamic state machine and the PATH evaluator's signalState
   * via `computeUnifiedCanonicalStage`. Downstream code (orchestrator,
   * storage) MUST consume this directly instead of recomputing the bridge.
   */
  canonicalStage: HrRadarStage;
  /**
   * Lane 1.2 — consecutive ticks the dynamic state has supported an up-rank
   * promotion (PREPARE/BET_NOW). Hysteresis input for the canonical promotion
   * mapper and the ready→fire gate. Resets to 0 on watch/cooled/closed.
   */
  consecutivePromoteTicks: number;
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
  // HR Radar audit fix #6 — wall-clock ms of the last observed contact event
  // (PA), used by the staleness decay rail. Null until first observation.
  lastContactEventAtMs: number | null;
  lastAlertResult: HRAlertResult | null;
  previousPitcherId: string | null;
  consecutiveDeclineTicks: number;
  // Lane 1.2 — symmetric promote-sustain counter (mirror of decline ticks).
  consecutivePromoteTicks: number;
  lastSnapshot: HRAlertSnapshot | null;
}

const stateMap = new Map<string, BatterHRState>();

function stateKey(gameId: string, playerId: string): string {
  return `${gameId}_${playerId}`;
}

// Phase 5 (Goldmaster unification, 2026-05-01): the dynamic state machine
// previously sat at WATCH for batters whom the PATH evaluator was actively
// calling PEAK because the calibrated probability hadn't crossed 0.14. The
// orchestrator-level `bridgeCanonicalStage` band-aid promoted those rows on
// the canonical ladder but the dynamic state itself stayed cold, which caused
// the user-facing tier to silently revert on the next tick when PATH cooled.
//
// We now run ONE unified scoring pipeline (see `computeUnifiedCanonicalStage`
// below):
//   1. Lower thresholds — calibrated 0.10 = BET_NOW, 0.06 = PREPARE — so the
//      probability rail agrees with PATH more often (catches more HRs at the
//      cost of some false positives, per product directive).
//   2. PATH PEAK / BUILDING is folded into the engine result as a hard
//      override on the canonical stage (terminal CLOSED still wins).
const BET_NOW_THRESHOLD = 0.10;
const PREPARE_THRESHOLD = 0.06;
const WATCH_THRESHOLD = 0.05;

const DECAY_HALF_LIFE_MINUTES = 12;
const DECAY_PA_HALF_LIFE = 3;
const CONSECUTIVE_DECLINE_COOLDOWN = 3;

// HR Radar audit fix #6 — stale-since-last-contact-event decay rail.
// Once a card has been live for STALE_PA_GRACE_MINUTES without observing a
// new PA, every additional STALE_PA_HALF_LIFE_MINUTES halves the multiplier.
// This makes the radar feel dynamic again — a player who was hot 20 minutes
// ago but hasn't batted will visibly slide out of BET_NOW.
const STALE_PA_GRACE_MINUTES = 8;
const STALE_PA_HALF_LIFE_MINUTES = 8;

// ── Lane 1 — promotion-path unification ────────────────────────────────────
// The dynamic HR state already blends calibrated probability × decay × pitcher
// vulnerability, so it is the single conviction signal we feed into the
// canonical FSM (see `deriveCanonicalPromotionIntent`). Two tunable knobs:
//   * FADE_VULN_THRESHOLD — pitcher HR-vulnerability (0–100) at/above which the
//     previously-dead PITCHER_FADE lifecycle event is emitted while a batter is
//     already building. Reuses `computePitcherHrVulnerability` output.
//   * PROMOTE_SUSTAIN_TICKS — an up-rank promotion to `ready` must persist this
//     many consecutive ticks before the mapper emits it, so a single noisy tick
//     can't flap the ladder.
const FADE_VULN_THRESHOLD = 78;
const PROMOTE_SUSTAIN_TICKS = 2;

function computeDecayFactor(
  minutesSinceDetection: number,
  pasSinceDetection: number,
  minutesSinceLastContactEvent: number,
): number {
  const timeDecay = Math.pow(0.5, minutesSinceDetection / DECAY_HALF_LIFE_MINUTES);
  const paDecay = Math.pow(0.5, pasSinceDetection / DECAY_PA_HALF_LIFE);
  const staleness = Math.max(0, minutesSinceLastContactEvent - STALE_PA_GRACE_MINUTES);
  const staleDecay = staleness > 0
    ? Math.pow(0.5, staleness / STALE_PA_HALF_LIFE_MINUTES)
    : 1.0;
  return Math.min(timeDecay, paDecay, staleDecay);
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

  // HR Radar audit fix #3 — CLOSED is terminal. Once `closeHrAlertOnHit`
  // (or game-final) sets CLOSED, subsequent recomputes must NOT revive the
  // alert. Without this guard, the threshold checks below could push a
  // hit-resolved batter back into BET_NOW on the next tick.
  if (prevState === "CLOSED") return "CLOSED";

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
      lastContactEventAtMs: null,
      lastAlertResult: null,
      previousPitcherId: options.currentPitcherId ?? null,
      consecutiveDeclineTicks: 0,
      consecutivePromoteTicks: 0,
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
  // HR Radar audit fix #6 — wall-clock minutes since last contact event was
  // observed. If the player gains a new PA this tick, reset to 0; otherwise
  // grow by the time delta since the last recompute. This becomes the
  // staleness signal that drops cards out of BET_NOW when nothing's happening.
  if (currentContactEvents > prev.contactEventsAtLastRecompute) {
    prev.lastContactEventAtMs = now;
  } else if (prev.lastContactEventAtMs == null) {
    // First-ever recompute: seed off detection or now to avoid staleness=0
    // accumulating from the unix epoch.
    prev.lastContactEventAtMs = prev.detectedAtMs ?? now;
  }
  const minutesSinceLastContact = (now - prev.lastContactEventAtMs) / 60000;
  const decayFactor = prev.detectedAtMs != null
    ? computeDecayFactor(minutesSinceDetection, pasSinceDetection, minutesSinceLastContact)
    : 1.0;

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
  // Lane 1.2 — track consecutive ticks the dynamic state supports an up-rank
  // promotion (PREPARE/BET_NOW). Resets the instant the state falls back to
  // watch/cooled/closed so the sustain gate measures *current* conviction.
  const supportsPromote = newState === "PREPARE" || newState === "BET_NOW";
  prev.consecutivePromoteTicks = supportsPromote ? prev.consecutivePromoteTicks + 1 : 0;
  if (options.currentPitcherId != null) {
    prev.previousPitcherId = options.currentPitcherId;
  }

  const buildScore = (alertResult.diagnostics as any)?.hrBuildScore ?? null;

  // Phase 5 — Unified canonical stage. Merge the dynamic state machine and
  // the PATH evaluator's signalState into ONE stage at the engine boundary
  // so every downstream consumer sees the same value.
  const dynamicStage = mapDynamicStateToStage(newState);
  const canonicalStage = computeUnifiedCanonicalStage(dynamicStage, alertResult.signalState);

  // Observability: emit when the unified stage promotes above the dynamic
  // stage so we can audit how often PATH override is firing.
  if (canonicalStage !== dynamicStage) {
    console.log(
      `[HR_UNIFIED_STAGE] ${input.playerName} game=${input.gameId} ` +
      `dynamic=${dynamicStage} pathSignal=${alertResult.signalState ?? "null"} ` +
      `canonical=${canonicalStage} calProb=${effectiveCalibrated.toFixed(3)} ` +
      `path=${alertResult.diagnostics?.alertPath ?? "n/a"}`
    );
  }

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
    canonicalStage,
    consecutivePromoteTicks: prev.consecutivePromoteTicks,
  };

  prev.lastSnapshot = snapshot;
  return snapshot;
}

// ── Lane 1.1 — probability→canonical-event mapper ──────────────────────────
export interface CanonicalPromotionIntent {
  /** Lifecycle event to apply, or null for a no-op (no promotion this tick). */
  event: HrRadarLifecycleEvent | null;
  /** Explicit target for a PROMOTE event (omitted for floor events). */
  promoteTo?: HrRadarLifecycleState;
  /**
   * Minimum lifecycle state this event guarantees. Lets the orchestrator
   * rank-compare against the current FSM state and skip the upsert when it
   * wouldn't advance the ladder — avoiding per-tick log spam and PROMOTE
   * not-strictly-higher rejections. Null when no event.
   */
  floor: HrRadarLifecycleState | null;
  reason: string;
}

/**
 * Translate the dynamic HR-state snapshot — which already blends calibrated
 * probability × decay × pitcher vulnerability — into a canonical FSM lifecycle
 * event so the ladder tracks the model instead of contact luck alone. Pure: no
 * I/O, no mutation. Returns `{ event: null }` when the snapshot is
 * uninitialized or the state warrants no promotion, so it is a safe no-op when
 * data is absent.
 *
 * Hysteresis: an up-rank PROMOTE to `ready` (and PITCHER_FADE, which floors at
 * `ready`) is only emitted once the dynamic state has supported promotion for
 * >= PROMOTE_SUSTAIN_TICKS consecutive ticks. Terminal stickiness,
 * contact-evidence floors, and FSM decay are owned by the state machine — this
 * mapper never emits DECAY (it returns null on cool-off / closed).
 */
export function deriveCanonicalPromotionIntent(
  snap: HRAlertSnapshot | null | undefined,
): CanonicalPromotionIntent {
  if (!snap || !snap.isInitialized) return { event: null, floor: null, reason: "uninitialized" };

  const state = snap.currentState;
  const stage = snap.canonicalStage;
  const sustained = (snap.consecutivePromoteTicks ?? 0) >= PROMOTE_SUSTAIN_TICKS;

  // Cool-off / closed — let the FSM own decay + terminal stickiness.
  if (state === "COOLED_OFF" || state === "CLOSED") {
    return { event: null, floor: null, reason: `no_promote_from_${state.toLowerCase()}` };
  }

  // Pitcher fade — wire the previously-dead PITCHER_FADE event. A fading /
  // fatigued pitcher (vuln >= floor) while the batter is already building is a
  // ready-grade promotion regardless of contact. Gated by sustain.
  if (
    snap.pitcherHrVulnerability >= FADE_VULN_THRESHOLD &&
    (state === "PREPARE" || state === "BET_NOW")
  ) {
    if (!sustained) return { event: null, floor: null, reason: "pitcher_fade_awaiting_sustain" };
    return {
      event: "PITCHER_FADE",
      floor: "ready",
      reason: `pitcher_fade_vuln_${Math.round(snap.pitcherHrVulnerability)}`,
    };
  }

  // Top conviction + attack window → ready (fire is gated separately in the
  // user-stage layer). Requires sustain to avoid single-tick flapping.
  if (state === "BET_NOW" && stage === "attack") {
    if (!sustained) return { event: null, floor: null, reason: "bet_now_attack_awaiting_sustain" };
    return { event: "PROMOTE", promoteTo: "ready", floor: "ready", reason: "bet_now_attack_sustained" };
  }

  // Building conviction → build (lower-stakes; emitted immediately).
  if (state === "BET_NOW" || state === "PREPARE") {
    return { event: "PROMOTE", promoteTo: "build", floor: "build", reason: `dynamic_${state.toLowerCase()}_build` };
  }

  // Watch-grade probability → at least watch.
  if (state === "WATCH") {
    return { event: "CONTACT_EVIDENCE", floor: "watch", reason: "dynamic_watch" };
  }

  return { event: null, floor: null, reason: "no_intent" };
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
      canonicalStage: mapDynamicStateToStage(prev.currentState),
      consecutivePromoteTicks: prev.consecutivePromoteTicks ?? 0,
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
    lastContactEventAtMs: detection.detectedAtMs ?? null,
    lastAlertResult: null,
    previousPitcherId: null,
    consecutiveDeclineTicks: 0,
    consecutivePromoteTicks: 0,
    lastSnapshot: null,
  });
}

// Daily slate-reset helper. Drops every state-map entry whose gameId is not
// in the supplied active set. Mirrors `clearStaleNonHrStates` in nonHrSignalState
// and `pruneStaleSessionDates` in mlbSessionDate so a single slate-reset cron
// can sweep every leaky in-memory cache the radar pipeline owns.
export function clearStaleHrAlertStates(activeGameIds: ReadonlySet<string>): number {
  let removed = 0;
  for (const key of Array.from(stateMap.keys())) {
    // stateKey format: `${gameId}_${playerId}` — split on FIRST underscore
    const sepIdx = key.indexOf("_");
    const gameId = sepIdx > 0 ? key.slice(0, sepIdx) : key;
    if (!activeGameIds.has(gameId)) {
      stateMap.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[MLB_SLATE_RESET] hrAlertEngine.stateMap pruned=${removed} kept=${stateMap.size}`);
  }
  return removed;
}

export function getHrAlertStateMapSize(): number {
  return stateMap.size;
}

export function clearGameHrStates(gameId: string): void {
  for (const key of Array.from(stateMap.keys())) {
    if (key.startsWith(`${gameId}_`)) stateMap.delete(key);
  }
}

/**
 * HR Radar audit fix #3 — terminal close on observed HR.
 *
 * Called from `gradeSingleHRPlay` the moment the play feed reports a HR for
 * (gameId, playerId). Forces the in-memory engine state to CLOSED so that
 * subsequent recompute ticks short-circuit past `deriveState` and the player
 * cannot re-enter BET_NOW. Peak fields are preserved so post-mortem displays
 * still show the readiness/state at the time of detection.
 *
 * Idempotent — repeated calls are no-ops.
 */
export function closeHrAlertOnHit(gameId: string, playerId: string): boolean {
  const key = stateKey(gameId, playerId);
  const prev = stateMap.get(key);
  if (!prev) return false;
  if (prev.currentState === "CLOSED") return false;
  const oldState = prev.currentState;
  prev.currentState = "CLOSED";
  prev.lastStateChangeAt = Date.now();
  if (prev.lastSnapshot) {
    prev.lastSnapshot = {
      ...prev.lastSnapshot,
      currentState: "CLOSED",
      lastStateChangeAt: prev.lastStateChangeAt,
      cooldownReason: "HR observed — alert closed",
    };
  }
  console.log(`[HR_ALERT_CLOSED_ON_HIT] gameId=${gameId} playerId=${playerId} oldState=${oldState} newState=CLOSED`);
  return true;
}

/** Read-only check used by feed-tag derivation and routes for hard guards. */
export function isHrAlertClosed(gameId: string, playerId: string): boolean {
  const prev = stateMap.get(stateKey(gameId, playerId));
  return !!prev && prev.currentState === "CLOSED";
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
