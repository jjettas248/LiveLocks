// HR Radar Live — v2 Shadow Model: adapter + on-demand compute.
// ─────────────────────────────────────────────────────────────────────────
// SHADOW MODE ONLY. This module:
//   1. `buildHrRadarV2InputFromCanonicalState` — the SOLE bridge from the
//      existing CanonicalHrRadarState to the v2 input. No orchestrator
//      import, no hot-path call, no DB join, no mutation.
//   2. `computeHrRadarV2Shadow` — pure compute returning HRRadarV2Shadow.
//      Writes NOTHING. Calls no bus / lifecycle / grading / orchestrator.
//
// Invariants enforced here:
//   • LIVE-ONLY: `!hasLiveEvidence` ⇒ suppressed (no suggested stage). No
//     amount of advanced context / market / pitch-type / park-wind /
//     historical context can create a row.
//   • FIRE-ONLY OFFICIAL: only the v2 Fire gate sets v2OfficialSignalStage =
//     "fire". track / build / ready never set it.
//   • SCORE UNITS: core/gates/confidence in Score100; advanced context,
//     interactions, suppressors in signed ScorePoints.

import type { CanonicalHrRadarState } from "./hrRadarCanonicalStore";
import { detectNearHrContactPeak, type NearHrContactEvent } from "./nearHrContact";
import { buildAdvancedContext } from "./hrRadarAdvancedContext";
import {
  clampScore100,
  scoreContactGeometry,
  scoreDataQuality,
  scoreFreshnessDecay,
  scoreLiveSwingTrend,
  scoreNearHrGeometry,
  scorePitcherDeterioration,
  scoreCountLeverage,
} from "./hrRadarAdvancedScoring";
import {
  V2_SHADOW_MODEL_VERSION,
  type HRRadarV2Input,
  type HRRadarV2Shadow,
  type Score01,
  type V2ContactEvidence,
  type V2SuggestedStage,
} from "./hrRadarV2Types";

// Core component weights (Score100; sum = 1.0). Advanced context is NOT in
// this sum — it is added separately as signed points.
const CORE_WEIGHTS = {
  liveContactGeometry: 0.3,
  nearHrSignal: 0.22,
  pitcherDeterioration: 0.16,
  liveSwingTrend: 0.1,
  opportunity: 0.08,
  countLeverage: 0.07,
  liveEnvironmentFit: 0.07,
} as const;

// Stage thresholds (Score100).
const FIRE_SCORE_MIN = 85;
const READY_SCORE_MIN = 72;
const BUILD_SCORE_MIN = 55;
const FIRE_MODEL_CONFIDENCE_MIN = 70;
const FIRE_CORE_CONFIDENCE_MIN = 75;

// Historical / season context that is intentionally diagnostics-only (never
// scored as live evidence, and not endpoint-accessible anyway).
const DIAGNOSTICS_ONLY_STATS = [
  "season_pull_pct",
  "bvp_history",
  "hr_trend_windows",
  "rolling_form",
  "handedness_splits",
  "season_pitcher_era_whip_k9_bb9",
];

// ── Adapter: CanonicalHrRadarState → HRRadarV2Input (sole bridge) ───────────

export interface BuildV2InputOptions {
  /** Deterministic "now" for freshness. The route handler injects this. */
  referenceTimeIso?: string | null;
  /** Optional current inning if the caller knows it (else null). */
  currentInning?: number | null;
}

export function buildHrRadarV2InputFromCanonicalState(
  state: CanonicalHrRadarState,
  options: BuildV2InputOptions = {},
): HRRadarV2Input {
  const contactEvidence = mapContactEvidence(state.contactEvidence);

  // LIVE-ONLY: canonical active states are created only from live in-game
  // evidence. Terminal / inactive rows carry no current live evidence.
  const hasLiveEvidence = state.active === true && !state.terminal;

  const availableStats = ["lifecycleState", "userStage", "displayScore10", "peakScore10"];
  if (state.detectedInning != null) availableStats.push("detectedInning");
  if (state.latestEvidenceInning != null) availableStats.push("latestEvidenceInning");
  if (state.detectedAt) availableStats.push("detectedAt");
  if (state.latestEvidenceAt) availableStats.push("latestEvidenceAt");
  if (contactEvidence.some((e) => e.ev != null)) availableStats.push("contact_ev");
  if (contactEvidence.some((e) => e.la != null)) availableStats.push("contact_la");
  if (contactEvidence.some((e) => e.distance != null)) availableStats.push("contact_distance");
  if (contactEvidence.some((e) => e.xba != null)) availableStats.push("contact_xba");
  if (contactEvidence.some((e) => e.isBarrel)) availableStats.push("contact_barrel_flag");
  if (contactEvidence.some((e) => e.outcome != null)) availableStats.push("contact_outcome");

  const derivableStats: string[] = [];
  if (contactEvidence.length >= 2) {
    derivableStats.push("ev_trend", "la_trend");
  }
  if (contactEvidence.length >= 1) {
    derivableStats.push("contact_geometry", "near_hr_tier", "repeated_hard_hit_count", "data_quality");
  }
  if ((state.latestEvidenceAt && options.referenceTimeIso) || state.latestEvidenceInning != null) {
    derivableStats.push("freshness_decay");
  }

  return {
    signalId: null,
    gameId: state.gameId,
    playerId: state.playerId,
    playerName: state.playerName,

    currentStage: state.userStage ?? null,
    currentScore10: state.displayScore10,
    peakScore10: state.peakScore10,

    lifecycleState: state.lifecycleState ?? null,
    active: state.active,
    terminal: state.terminal,

    hasLiveEvidence,
    contactEvidence,
    triggerReasons: [...(state.triggerReasons ?? [])],
    triggerTags: [...(state.triggerTags ?? [])],

    detectedInning: state.detectedInning,
    latestEvidenceInning: state.latestEvidenceInning,
    detectedAtIso: state.detectedAt ?? null,
    latestEvidenceAtIso: state.latestEvidenceAt ?? null,
    referenceTimeIso: options.referenceTimeIso ?? null,

    availableStats,
    derivableStats,
    missingStats: [], // advanced future-feed list is added by buildAdvancedContext
    diagnosticsOnlyStats: [...DIAGNOSTICS_ONLY_STATS],
  };
}

function mapContactEvidence(raw: Array<Record<string, unknown>> | null | undefined): V2ContactEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    abIndex: numOrNull(r.abIndex),
    ev: numOrNull(r.ev),
    la: numOrNull(r.la),
    distance: numOrNull(r.distance),
    xba: numOrNull(r.xba),
    isBarrel: r.isBarrel === true,
    outcome: strOrNull(r.outcome),
    hitType: strOrNull(r.hitType),
  }));
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

// ── Compute: HRRadarV2Input → HRRadarV2Shadow (pure, writes nothing) ────────

export function computeHrRadarV2Shadow(input: HRRadarV2Input): HRRadarV2Shadow {
  const advancedContext = buildAdvancedContext(input);

  // LIVE-ONLY GATE — first. Advanced context can never create a row.
  if (!input.hasLiveEvidence) {
    return suppressedShadow(input, advancedContext, "no_live_evidence");
  }

  const evidence = input.contactEvidence;

  // Near-HR peak from the real batted-ball window.
  const nearHrEvents: NearHrContactEvent[] = evidence.map((e) => ({
    ev: e.ev,
    la: e.la,
    distance: e.distance,
    xba: e.xba,
    isBarrel: e.isBarrel,
    outcome: e.outcome,
    hitType: e.hitType ?? null,
  }));
  const peak = detectNearHrContactPeak(nearHrEvents);

  // ── Core components (Score01 | null) ──────────────────────────────────────
  // Contact geometry / near-HR / swing trend are ALWAYS derived from real
  // contactEvidence. The remaining four come from supplementalCore (real
  // future-feed values) when present, else null → 0 contribution. The
  // canonical-state adapter never sets supplementalCore, so today they are
  // null. Weights are NEVER renormalized for missing components.
  const sup = input.supplementalCore ?? null;
  const contactGeometry01 = scoreContactGeometry(evidence);
  const nearHr01 = scoreNearHrGeometry(peak.tier, peak.repeatedDanger);
  const pitcherDet01 = sup?.pitcherDeterioration ?? scorePitcherDeterioration(null);
  const swingTrend01 = scoreLiveSwingTrend(evidence);
  const opportunity01: Score01 | null = sup?.opportunity ?? null;
  const countLev01 = sup?.countLeverage ?? scoreCountLeverage(null);
  const environment01: Score01 | null = sup?.liveEnvironmentFit ?? null;

  const coreLiveDangerScore100 = clampScore100(
    to100(contactGeometry01) * CORE_WEIGHTS.liveContactGeometry +
      to100(nearHr01) * CORE_WEIGHTS.nearHrSignal +
      to100(pitcherDet01) * CORE_WEIGHTS.pitcherDeterioration +
      to100(swingTrend01) * CORE_WEIGHTS.liveSwingTrend +
      to100(opportunity01) * CORE_WEIGHTS.opportunity +
      to100(countLev01) * CORE_WEIGHTS.countLeverage +
      to100(environment01) * CORE_WEIGHTS.liveEnvironmentFit,
  );

  // ── Availability-gated interactions (signed → clamped 0..10) ──────────────
  let rawInteraction = 0;
  if (contactGeometry01 != null && pitcherDet01 != null) {
    rawInteraction += contactGeometry01 * pitcherDet01 * 6;
  }
  // All other interaction pairs require feeds that are null today (park,
  // zone, pitch-type, wind-spray) — they contribute nothing.
  const interactionBoostPoints = Math.max(0, Math.min(10, rawInteraction));

  // ── Suppressors (ScorePoints, non-negative magnitude, subtracted) ─────────
  const freshness01 = scoreFreshnessDecay({
    latestEvidenceAtIso: input.latestEvidenceAtIso,
    referenceTimeIso: input.referenceTimeIso,
    latestEvidenceInning: input.latestEvidenceInning,
    currentInning: input.latestEvidenceInning, // inning fallback unused unless caller supplies a newer inning
  });
  const dataQuality01 = scoreDataQuality(evidence);

  const suppressors: string[] = [];
  let suppressionPenaltyPoints = 0;
  if (freshness01 != null && freshness01 < 0.8) {
    const pen = (1 - freshness01) * 25;
    suppressionPenaltyPoints += pen;
    if (freshness01 < 0.5) suppressors.push("Stale live evidence (no recent contact)");
  }
  if (contactGeometry01 != null && contactGeometry01 < 0.4) {
    suppressionPenaltyPoints += (0.4 - contactGeometry01) * 20;
    suppressors.push("Weak contact quality");
  }
  if (dataQuality01 != null && dataQuality01 < 0.5) {
    suppressionPenaltyPoints += (0.5 - dataQuality01) * 10;
    suppressors.push("Incomplete batted-ball data");
  }

  // ── Final score ───────────────────────────────────────────────────────────
  const finalLiveHrDangerScore100 = clampScore100(
    coreLiveDangerScore100 +
      advancedContext.advancedContextBoostPoints +
      interactionBoostPoints -
      suppressionPenaltyPoints,
  );
  const readinessScore10 = Math.round((finalLiveHrDangerScore100 / 10) * 10) / 10;

  // ── Split confidence (Score100) ───────────────────────────────────────────
  const coreComponents01 = [
    contactGeometry01,
    nearHr01,
    pitcherDet01,
    swingTrend01,
    opportunity01,
    countLev01,
    environment01,
  ];
  const coreNonNull = coreComponents01.filter((c) => c != null) as number[];

  const liveEvidenceVolume100 = clampScore100(
    100 * Math.min(1, evidence.length / 3) * 0.7 + (peak.tier != null ? 30 : 0),
  );
  const dataFreshness100 = freshness01 != null ? freshness01 * 100 : 50; // unknown → neutral, don't crush
  const coreFieldCompleteness100 = (coreNonNull.length / coreComponents01.length) * 100;
  const signalAgreement100 = computeSignalAgreement100(contactGeometry01, nearHr01, swingTrend01);

  const coreLiveEvidenceConfidence = clampScore100(
    liveEvidenceVolume100 * 0.35 +
      dataFreshness100 * 0.25 +
      coreFieldCompleteness100 * 0.2 +
      signalAgreement100 * 0.2,
  );
  const advancedContextCoverage = clampScore100(
    advancedContext.totalComponentCount > 0
      ? (100 * advancedContext.availableComponentCount) / advancedContext.totalComponentCount
      : 0,
  );
  const v2Confidence = clampScore100(coreLiveEvidenceConfidence * 0.8 + advancedContextCoverage * 0.2);

  // ── Drivers (real evidence only) ──────────────────────────────────────────
  const drivers = buildDrivers(peak.drivers, evidence, contactGeometry01, swingTrend01, peak.repeatedDanger);
  if (advancedContextCoverage < 100) {
    suppressors.push(
      `Advanced context coverage ${Math.round(advancedContextCoverage)}% (future-feed stats unavailable)`,
    );
  }

  // ── Fire gate v2 (Score100 only) + stage ladder ───────────────────────────
  const hasEliteBarrel = evidence.some((e) => e.isBarrel && (e.ev ?? 0) >= 103) || (peak.tier === "lean" && evidence.some((e) => e.isBarrel));
  const hasMassiveContact = evidence.some((e) => (e.ev ?? 0) >= 108);
  const hasNearHrSignal = peak.tier != null;
  const hasRepeatedHrShapeContact = peak.repeatedDanger === true;
  const hasCurrentLiveEvidence = freshness01 != null ? freshness01 >= 0.5 : evidence.length > 0;
  const isStalePeak = freshness01 != null && freshness01 < 0.4;
  const driverCategories = countDriverCategories(contactGeometry01, hasNearHrSignal, swingTrend01, hasEliteBarrel || hasMassiveContact);
  const hasConvergingDrivers = driverCategories >= 2;
  const hasStrongLiveEvidence = peak.tier === "lean" || hasEliteBarrel || hasMassiveContact;
  const hasMeaningfulLiveEvidence = hasNearHrSignal || (contactGeometry01 != null && contactGeometry01 >= 0.4);

  const canFire =
    input.hasLiveEvidence &&
    hasCurrentLiveEvidence &&
    finalLiveHrDangerScore100 >= FIRE_SCORE_MIN &&
    v2Confidence >= FIRE_MODEL_CONFIDENCE_MIN &&
    coreLiveEvidenceConfidence >= FIRE_CORE_CONFIDENCE_MIN &&
    hasConvergingDrivers &&
    !isStalePeak &&
    (hasEliteBarrel || hasNearHrSignal || hasMassiveContact || hasRepeatedHrShapeContact);

  let v2SuggestedStage: V2SuggestedStage | null;
  let v2OfficialSignalStage: "fire" | null = null;
  if (canFire) {
    v2SuggestedStage = "fire";
    v2OfficialSignalStage = "fire";
  } else if (finalLiveHrDangerScore100 >= READY_SCORE_MIN && hasStrongLiveEvidence) {
    v2SuggestedStage = "ready";
  } else if (finalLiveHrDangerScore100 >= BUILD_SCORE_MIN && hasMeaningfulLiveEvidence) {
    v2SuggestedStage = "build";
  } else {
    v2SuggestedStage = "track"; // has live evidence (gate passed) but below build
  }

  return {
    modelVersion: V2_SHADOW_MODEL_VERSION,
    signalId: input.signalId,
    gameId: input.gameId,
    playerId: input.playerId,
    playerName: input.playerName,
    currentStage: input.currentStage,
    currentScore: input.currentScore10,

    v2CoreScore: Math.round(coreLiveDangerScore100 * 10) / 10,
    v2AdvancedContextBoost: Math.round(advancedContext.advancedContextBoostPoints * 100) / 100,
    v2InteractionBoost: Math.round(interactionBoostPoints * 100) / 100,
    v2SuppressionPenalty: Math.round(suppressionPenaltyPoints * 100) / 100,
    v2FinalScore: Math.round(finalLiveHrDangerScore100 * 10) / 10,
    v2ReadinessScore10: readinessScore10,

    coreLiveEvidenceConfidence: Math.round(coreLiveEvidenceConfidence * 10) / 10,
    advancedContextCoverage: Math.round(advancedContextCoverage * 10) / 10,
    v2Confidence: Math.round(v2Confidence * 10) / 10,

    v2SuggestedStage,
    v2OfficialSignalStage,

    advancedContext,
    drivers,
    suppressors,
    missingStats: advancedContext.missingStats,
    diagnostics: {
      core: {
        contactGeometry01,
        nearHr01,
        pitcherDet01,
        swingTrend01,
        opportunity01,
        countLev01,
        environment01,
        coreLiveDangerScore100,
      },
      nearHr: { tier: peak.tier, repeatedDanger: peak.repeatedDanger, matchedPath: peak.matchedPath },
      freshness01,
      dataQuality01,
      gates: {
        hasEliteBarrel,
        hasMassiveContact,
        hasNearHrSignal,
        hasRepeatedHrShapeContact,
        hasCurrentLiveEvidence,
        isStalePeak,
        hasConvergingDrivers,
        driverCategories,
        canFire,
      },
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function to100(s01: Score01 | null): number {
  return s01 == null ? 0 : s01 * 100;
}

function suppressedShadow(
  input: HRRadarV2Input,
  advancedContext: ReturnType<typeof buildAdvancedContext>,
  reason: string,
): HRRadarV2Shadow {
  return {
    modelVersion: V2_SHADOW_MODEL_VERSION,
    signalId: input.signalId,
    gameId: input.gameId,
    playerId: input.playerId,
    playerName: input.playerName,
    currentStage: input.currentStage,
    currentScore: input.currentScore10,

    v2CoreScore: 0,
    v2AdvancedContextBoost: 0,
    v2InteractionBoost: 0,
    v2SuppressionPenalty: 0,
    v2FinalScore: 0,
    v2ReadinessScore10: 0,

    coreLiveEvidenceConfidence: 0,
    advancedContextCoverage: Math.round(
      (advancedContext.totalComponentCount > 0
        ? (100 * advancedContext.availableComponentCount) / advancedContext.totalComponentCount
        : 0) * 10,
    ) / 10,
    v2Confidence: 0,

    v2SuggestedStage: null,
    v2OfficialSignalStage: null,

    advancedContext,
    drivers: [],
    suppressors: [`Suppressed: ${reason}`],
    missingStats: advancedContext.missingStats,
    diagnostics: { suppressed: true, reason },
  };
}

function computeSignalAgreement100(
  contactGeometry01: Score01 | null,
  nearHr01: Score01 | null,
  swingTrend01: Score01 | null,
): number {
  const present = [contactGeometry01, nearHr01, swingTrend01].filter((c) => c != null) as number[];
  if (present.length === 0) return 0;
  if (present.length === 1) return 55; // single signal — moderate agreement
  // Lower spread = higher agreement.
  const max = Math.max(...present);
  const min = Math.min(...present);
  const spread = max - min;
  return clampScore100((1 - spread) * 100);
}

function buildDrivers(
  nearHrDrivers: string[],
  evidence: V2ContactEvidence[],
  contactGeometry01: Score01 | null,
  swingTrend01: Score01 | null,
  repeatedDanger: boolean,
): string[] {
  const out = new Set<string>();
  for (const d of nearHrDrivers) if (d) out.add(d);
  const maxEv = Math.max(...evidence.map((e) => e.ev ?? 0), 0);
  if (maxEv >= 108) out.add(`Massive contact (${maxEv.toFixed(1)} mph)`);
  else if (maxEv >= 103) out.add(`Elite exit velocity (${maxEv.toFixed(1)} mph)`);
  if (evidence.some((e) => e.isBarrel)) out.add("Statcast barrel this game");
  if (repeatedDanger) out.add("Repeated HR-danger contact");
  if (swingTrend01 != null && swingTrend01 > 0.6) out.add("Exit velocity trending up");
  if (contactGeometry01 != null && contactGeometry01 >= 0.7) out.add("HR-shaped batted-ball geometry");
  return Array.from(out);
}

function countDriverCategories(
  contactGeometry01: Score01 | null,
  hasNearHrSignal: boolean,
  swingTrend01: Score01 | null,
  hasPowerContact: boolean,
): number {
  let n = 0;
  if (contactGeometry01 != null && contactGeometry01 >= 0.4) n += 1;
  if (hasNearHrSignal) n += 1;
  if (swingTrend01 != null && swingTrend01 > 0.6) n += 1;
  if (hasPowerContact) n += 1;
  return n;
}
