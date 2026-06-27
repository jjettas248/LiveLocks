// HR Radar Live — v2 Shadow Model: shared types.
// ─────────────────────────────────────────────────────────────────────────
// SHADOW MODE ONLY. Nothing here is read by production scoring, stages,
// alerts, grading, the bus, the lifecycle engine, or the UI. The v2 model
// is computed on-demand by an admin/debug endpoint from existing canonical
// HR Radar state and returned as a read-only diagnostic payload.
//
// SCORE-UNIT POLICY (never mix units inside a formula):
//   • Score01     — 0.0..1.0   feature scorers (or null when data is absent)
//   • Score100    — 0..100     core model, stage gates, confidence
//   • ScorePoints — signed     advanced context, interactions, suppressors
//                              (added/subtracted from the Score100 core)
//
// Live-only + FIRE-only invariants are preserved by the compute layer:
//   • No row may be SUGGESTED without live in-game evidence.
//   • Only "fire" may set v2OfficialSignalStage. Track/Build/Ready never do.

import type { CanonicalHrRadarStage } from "@shared/hrRadarStage";
import type { HrRadarLifecycleState } from "./hrRadarStateMachine";

// Bumped when the v2 SHADOW model behavior changes. This is NOT the
// production goldmaster version — v2 never touches production, so changing
// it must NOT bump MLB_GOLDMASTER_VERSION.
export const V2_SHADOW_MODEL_VERSION = "hr-radar-v2-shadow-2026-06-26";

// Unit aliases — documentation only (TS has no newtype, but these make the
// intent explicit at every call site).
export type Score01 = number; // 0.0..1.0
export type Score100 = number; // 0..100
export type ScorePoints = number; // signed point adjustment

/**
 * The 15 advanced-context components from the task spec. Each is a
 * `Score01 | null`; `null` means "no real endpoint-accessible data" and the
 * component is EXCLUDED from the weighted boost (never imputed to a neutral
 * 0.5, never renormalized away). Today the great majority are `null` because
 * the canonical HR Radar state does not carry the required feeds.
 */
export interface HRRadarAdvancedContext {
  batterPitchTypeDamageScore: Score01 | null;
  pitcherPitchTypeVulnerabilityScore: Score01 | null;
  zoneMistakeRiskScore: Score01 | null;
  pullAirIntentScore: Score01 | null;
  parkGeometryFitScore: Score01 | null;
  windSprayFitScore: Score01 | null;
  swingDecisionFormScore: Score01 | null;
  commandDeteriorationScore: Score01 | null;
  countLeverageScore: Score01 | null;
  gameStateAttackScore: Score01 | null;
  similarityMatchupScore: Score01 | null;
  umpCatcherContextScore: Score01 | null;
  batterFatigueSuppressor: Score01 | null;
  marketConfirmationScore: Score01 | null;
  driverCalibrationBoost: Score01 | null;

  /** Signed point adjustment built from non-null components, clamped. */
  advancedContextBoostPoints: ScorePoints;
  /** Count of components that were non-null (used for coverage confidence). */
  availableComponentCount: number;
  /** Total advanced components considered (denominator for coverage). */
  totalComponentCount: number;

  availableStats: string[];
  derivableStats: string[];
  missingStats: string[];
  diagnosticsOnlyStats: string[];
  diagnostics: Record<string, unknown>;
}

/**
 * A single batted-ball contact event, as it actually lands on
 * CanonicalHrRadarState.contactEvidence (the orchestrator stamps exactly
 * these fields). This is the richest live evidence the admin endpoint can
 * reach without hot-path imports or DB joins.
 */
export interface V2ContactEvidence {
  abIndex: number | null;
  ev: number | null;
  la: number | null;
  distance: number | null;
  xba: number | null;
  isBarrel: boolean;
  outcome: string | null;
  hitType?: string | null;
}

/**
 * The ONLY input shape the v2 model consumes. Built exclusively by
 * `buildHrRadarV2InputFromCanonicalState`. No raw field is assumed present
 * unless it actually appears on CanonicalHrRadarState.
 */
export interface HRRadarV2Input {
  signalId: string | null;
  gameId: string;
  playerId: string;
  playerName: string;

  // Production stage/score (read-only context, never mutated).
  currentStage: CanonicalHrRadarStage | null;
  currentScore10: number | null;
  peakScore10: number | null;

  lifecycleState: HrRadarLifecycleState | null;
  active: boolean;
  terminal: boolean;

  // Live evidence gate. True ONLY when there is real in-game evidence.
  hasLiveEvidence: boolean;
  contactEvidence: V2ContactEvidence[];
  triggerReasons: string[];
  triggerTags: string[];

  detectedInning: number | null;
  latestEvidenceInning: number | null;
  detectedAtIso: string | null;
  latestEvidenceAtIso: string | null;
  /**
   * Deterministic "now" for freshness scoring. Pure scoring NEVER calls
   * `new Date()` to fabricate the current time — the reference time is
   * injected here (and by tests). May be null (freshness falls back to
   * inning-based or returns null).
   */
  referenceTimeIso: string | null;

  // Inventory (5-section availability, endpoint-accessible scope).
  availableStats: string[];
  derivableStats: string[];
  missingStats: string[];
  diagnosticsOnlyStats: string[];

  /**
   * Pre-derived REAL Score01 values for core components the canonical state
   * cannot reach today (pitcher deterioration, opportunity, count leverage,
   * environment fit). These are NOT proxies — they are real feed values to
   * be supplied by a future data source. `buildHrRadarV2InputFromCanonicalState`
   * NEVER sets this (today's output stays honestly sparse → those components
   * are null → contribute 0). Present so the model is future-proof and the
   * full stage ladder is testable. Contact geometry / near-HR / swing trend
   * are always derived from real `contactEvidence` and are NOT overridable.
   */
  supplementalCore?: {
    pitcherDeterioration?: Score01 | null;
    opportunity?: Score01 | null;
    countLeverage?: Score01 | null;
    liveEnvironmentFit?: Score01 | null;
  } | null;
}

export type V2SuggestedStage = "track" | "build" | "ready" | "fire";

/**
 * The read-only shadow output. Returned by the admin endpoint; written
 * nowhere. `v2OfficialSignalStage` is "fire" only when the v2 Fire gate is
 * satisfied — never for track/build/ready.
 */
export interface HRRadarV2Shadow {
  modelVersion: string;

  signalId: string | null;
  gameId: string;
  playerId: string;
  playerName: string;

  currentStage: string | null;
  currentScore: number | null;

  // Core model (Score100) + signed point adjustments.
  v2CoreScore: Score100;
  v2AdvancedContextBoost: ScorePoints;
  v2InteractionBoost: ScorePoints;
  v2SuppressionPenalty: ScorePoints;
  v2FinalScore: Score100;
  v2ReadinessScore10: number;

  // Split confidence (Score100).
  coreLiveEvidenceConfidence: Score100;
  advancedContextCoverage: Score100;
  v2Confidence: Score100;

  v2SuggestedStage: V2SuggestedStage | null;
  v2OfficialSignalStage: "fire" | null;

  advancedContext: HRRadarAdvancedContext;
  drivers: string[];
  suppressors: string[];
  missingStats: string[];
  diagnostics: Record<string, unknown>;
}
