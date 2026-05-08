import { convictionDisplayCeiling10, convictionDisplayBadge } from "@shared/hrRadarConviction";

/**
 * MLB HR Radar — Goldmaster v1 user-facing stage layer.
 *
 * SAFE ADDITIVE upgrade. This module never mutates the engine, never rewrites
 * existing canonical stages (`watch | building | attack | cooling | closed`),
 * and never replaces existing readiness numbers. It produces a parallel
 * USER-FACING ladder (`track | build | ready | fire | resolved`) that can be
 * attached to ladder entries and board rows alongside everything that already
 * exists.
 *
 * Phases implemented here (per spec):
 *  - Phase 0  : feature flag HR_RADAR_GOLDMASTER_V1
 *  - Phase 1  : mapToUserStage from legacy tier/state/dynamic state/outcome
 *  - Phase 2  : toSignalScore10 — 0-100 ↔ 0-10 compatibility helper
 *  - Phase 3  : fallbackScoreForStage — display-only, never used for grading
 *  - Phase 5  : getUserStageCopy — clean user-facing copy
 *  - Phase 6  : HrQualifyingSignalType + deriveQualifyingSignals
 *  - Phase 7  : deriveSuggestedUserStageFromSignals (additive, takes the
 *               STRONGER of the legacy-mapped stage and the suggested stage)
 *
 * Phases 4 / 8 / 9 / 12 are wired by the route/ladder builders — they call
 * `enrichWithUserStage` which combines all of the above and returns the
 * additive payload.
 */

// ── Phase 0 ────────────────────────────────────────────────────────────────
// Default ON, but structured so a `false` env value forces it off and a
// caller can also flip it programmatically. Never throw — radar must keep
// serving even if env parsing is weird.
export const HR_RADAR_GOLDMASTER_V1: boolean = (() => {
  const raw = (process.env.HR_RADAR_GOLDMASTER_V1 ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off" || raw === "no") return false;
  return true;
})();

// ── Phase 1 ────────────────────────────────────────────────────────────────
export type HrRadarUserStage = "track" | "build" | "ready" | "fire" | "resolved";

// ── Path-based promotion table ─────────────────────────────────────────────
// The HR Radar runs two parallel scoring tracks. The dynamic state machine
// (WATCH/PREPARE/BET_NOW) keys off calibrated HR conversion probability
// thresholds (PREPARE >= 8%, BET_NOW >= 14%) which are very rarely crossed
// in-game. The alert-path engine emits a parallel signal — the alertPath
// identity (FAST_PROMOTE_*, LEI_ESCALATION, PATH_A..PATH_E_CONVICTION) plus
// a tier the engine surfaces as signal_state ("watching" / "live" /
// "actionable"). When the engine itself emits a signal at "live" or
// "actionable" on a real promotion path, that IS the engine declaring the
// row is above watch-grade. Surfacing that declaration as Ready (and
// FAST_PROMOTE_ELITE@actionable as Fire) is the engine deciding — the UI
// just renders it. No fabrication.
//
// BLOCKED paths (PATH_F_BLOCKED_BRIDGE, WATCH, WATCH_POWER) are explicitly
// excluded because the engine itself surfaces them as a "watching" signal
// only — they should stay in Track regardless of how the dynamic state
// machine's separate readiness accumulator behaves.
const PATH_PROMOTES_TO_READY: Record<string, true> = {
  FAST_PROMOTE_ELITE: true,
  FAST_PROMOTE_BARREL_PLUS: true,
  FAST_PROMOTE_BARREL_CTX: true,
  FAST_PROMOTE_2HH: true,
  LEI_ESCALATION: true,
  PATH_A: true,
  PATH_B: true,
  PATH_C: true,
  PATH_D: true,
  PATH_E_CONVICTION: true,
  PATH_PRE_HR_DANGER: true,
};

const PATH_PROMOTES_TO_FIRE: Record<string, true> = {
  FAST_PROMOTE_ELITE: true,
};

// Module-scope set so the drift-guard log only fires once per unknown path
// per process (avoids log spam every poll cycle).
const loggedUnknownPaths = new Set<string>();

export interface MapToUserStageTrace {
  signalId?: string | null;
  gameId?: string | number | null;
  playerId?: string | number | null;
  player?: string | null;
  prev?: HrRadarUserStage | null;
}

export function mapToUserStage(input: {
  legacyTier?: string | null;
  legacyState?: string | null;
  dynamicState?: string | null;
  canonicalStage?: string | null;
  outcome?: string | null;
  confidenceScore?: number | null;
  convProb?: number | null;
  alertPath?: string | null;
}, trace?: MapToUserStageTrace): HrRadarUserStage {
  const outcome = (input.outcome ?? "").toLowerCase();
  if (outcome && outcome !== "pending" && outcome !== "active") {
    return emitTrace(trace, "resolved", "outcome_resolved");
  }

  const dyn = (input.dynamicState ?? "").toUpperCase();
  const tier = (input.legacyTier ?? "").toLowerCase();
  const state = (input.legacyState ?? "").toLowerCase();
  const canonical = (input.canonicalStage ?? "").toLowerCase();
  const conf = typeof input.confidenceScore === "number" ? input.confidenceScore : null;
  const conv = typeof input.convProb === "number" ? input.convProb : null;
  const alertPath = (input.alertPath ?? "").toUpperCase();

  // ── HR Radar Lifecycle Repair Fix #1 — strict ordering ──────────────────
  // Forensic finding: the prior order had `BET_NOW → fire` BEFORE any READY
  // checks, which made READY structurally unreachable. The new order is:
  //   1. resolved
  //   2. explicit FIRE path confirmation (engine declared via actionable
  //      officialAlert + FAST_PROMOTE_ELITE)
  //   3. READY qualification (path-based / PREPARE escalation / strong tier)
  //   4. BET_NOW-only fallback (calibrated-prob track promotes to fire when
  //      no path/tier signal earned READY)
  //   5. BUILD
  //   6. TRACK
  // No engine math, thresholds, or paths were changed — only the ladder
  // collapse order. READY can now exist as a real lifecycle state.

  // Step 2 — explicit FIRE path confirmation.
  if (state === "actionable" && PATH_PROMOTES_TO_FIRE[alertPath]) {
    return emitTrace(trace, "fire", "path_promotes_fire");
  }

  // Step 3 — READY qualification.
  // 3a) Engine surfaced a real promotion path at signal_state live|actionable.
  if ((state === "actionable" || state === "live") && PATH_PROMOTES_TO_READY[alertPath]) {
    return emitTrace(trace, "ready", "path_promotes_ready");
  }
  // 3b) PREPARE escalation by confidence/conv.
  if (dyn === "PREPARE" && ((conf !== null && conf >= 7) || (conv !== null && conv >= 0.18))) {
    return emitTrace(trace, "ready", "prepare_escalation");
  }
  // 3c) Legacy strong tier.
  if (tier === "strong") {
    return emitTrace(trace, "ready", "legacy_strong_tier");
  }

  // Drift guard for unrecognized promotable paths — log once per path.
  if (
    alertPath &&
    (state === "actionable" || state === "live") &&
    !PATH_PROMOTES_TO_READY[alertPath] &&
    !PATH_PROMOTES_TO_FIRE[alertPath] &&
    alertPath !== "WATCH" &&
    alertPath !== "WATCH_POWER" &&
    alertPath !== "PATH_F_BLOCKED_BRIDGE"
  ) {
    if (!loggedUnknownPaths.has(alertPath)) {
      loggedUnknownPaths.add(alertPath);
      console.warn(
        `[HR_RADAR_USER_STAGE_UNKNOWN_PATH] alertPath=${alertPath} state=${state} — not in PATH_PROMOTES_TO_READY/FIRE; row will fall through to dynamic-state branches`,
      );
    }
  }

  // Step 4 — BET_NOW-only fallback. The dynamic-state track gets to fire
  // ONLY after READY qualification has been considered. This is the
  // "calibrated probability is hot but no specific promotion path / tier
  // earned READY" case.
  if (dyn === "BET_NOW" || state === "attack" || canonical === "attack") {
    return emitTrace(trace, "fire", "betnow_fallback");
  }

  // Step 5 — BUILD.
  if (dyn === "PREPARE" || tier === "building" || canonical === "building") {
    return emitTrace(trace, "build", "build_default");
  }

  // Step 6 — TRACK default.
  return emitTrace(trace, "track", "track_default");
}

function emitTrace(
  trace: MapToUserStageTrace | undefined,
  next: HrRadarUserStage,
  rule: string,
): HrRadarUserStage {
  if (!trace) return next;
  const prev = trace.prev ?? null;
  if (prev === next) return next;
  const sid = trace.signalId ?? "?";
  const gid = trace.gameId ?? "?";
  const pid = trace.playerId ?? "?";
  const pname = trace.player ?? "?";
  console.log(
    `[HR_RADAR_TRANSITION] from=${prev ?? "none"} to=${next} rule=${rule} ` +
    `signalId=${sid} gameId=${gid} playerId=${pid} player=${pname}`,
  );
  if (next === "ready") {
    console.log(`[HR_RADAR_READY] signalId=${sid} gameId=${gid} playerId=${pid} player=${pname} rule=${rule}`);
  } else if (next === "fire") {
    console.log(`[HR_RADAR_FIRE] signalId=${sid} gameId=${gid} playerId=${pid} player=${pname} rule=${rule}`);
  }
  return next;
}

// ── Phase 2 ────────────────────────────────────────────────────────────────
/**
 * Convert ANY readiness/build score (legacy 0-100 or already 0-10) into a
 * 0.0-10.0 user-facing number rounded to one decimal. Pure; never mutates.
 */
export function toSignalScore10(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value as number)) return 0;
  const v = Number(value);
  // Treat anything > 10 as 0-100 wire scale (which is the canonical storage).
  if (v > 10) {
    return Math.round(Math.min(10, Math.max(0, v / 10)) * 10) / 10;
  }
  return Math.round(Math.min(10, Math.max(0, v)) * 10) / 10;
}

// ── Phase 3 ────────────────────────────────────────────────────────────────
/**
 * Display-only fallback. Used to keep Track rows from showing a meaningless
 * 0.0 in the UI when the engine has not yet emitted a readiness number. NEVER
 * use this for grading — only for the score badge.
 */
export function fallbackScoreForStage(stage: HrRadarUserStage): number {
  if (stage === "track") return 2.5;
  if (stage === "build") return 5.5;
  if (stage === "ready") return 7.5;
  if (stage === "fire") return 9.0;
  return 0;
}

// ── Phase 5 ────────────────────────────────────────────────────────────────
export function getUserStageLabel(stage: HrRadarUserStage): string {
  switch (stage) {
    case "track": return "Track";
    case "build": return "Build";
    case "ready": return "Ready";
    case "fire": return "Fire";
    case "resolved": return "Resolved";
  }
}

export function getUserStageCopy(stage: HrRadarUserStage): string {
  switch (stage) {
    case "track":
      return "Tracking. HR conditions are forming, but this is not actionable yet.";
    case "build":
      return "Pattern is building. One more quality contact or worsening pitcher context could make this playable.";
    case "ready":
      return "Playable HR setup. Contact quality and matchup context are aligned.";
    case "fire":
      return "Fire signal. Highest-conviction HR window is open now.";
    case "resolved":
      return "Signal has been resolved.";
  }
}

// ── Phase 6 ────────────────────────────────────────────────────────────────
export type HrQualifyingSignalType =
  | "elite_barrel"
  | "near_barrel"
  | "two_hard_hit_balls"
  | "deep_fly_warning"
  | "high_bat_speed_lift"
  | "pitcher_collapse_power"
  | "late_game_power_build"
  | "massive_single_contact"
  | "pre_hr_danger";

/**
 * Derive qualifying signals from the engine's existing diagnostic snapshot
 * and trigger tags, WITHOUT inventing new measurements. We only translate
 * what the engine has already exposed — this is purely a labeling layer.
 *
 * `factors` and `triggerTags` are best-effort optional inputs; missing data
 * just yields fewer signals.
 */
export function deriveQualifyingSignals(input: {
  factors?: {
    barrels?: number | null;
    hardHits?: number | null;
    deepFlyouts?: number | null;
    maxEV?: number | null;
    avgEV?: number | null;
    maxLA?: number | null;
    nearBarrels?: number | null;
    pitcherFatigueBoost?: number | null;
  } | null;
  triggerTags?: string[] | null;
  inning?: number | null;
  positiveDrivers?: string[] | null;
  conversionProbability?: number | null;
}): HrQualifyingSignalType[] {
  const out = new Set<HrQualifyingSignalType>();
  const f = input.factors ?? {};
  const tags = (input.triggerTags ?? []).map(t => String(t).toLowerCase());
  const drivers = (input.positiveDrivers ?? []).map(d => String(d).toLowerCase());
  const inning = input.inning ?? null;
  const conv = input.conversionProbability ?? null;

  const barrels = Number(f.barrels ?? 0);
  const hardHits = Number(f.hardHits ?? 0);
  const deepFly = Number(f.deepFlyouts ?? 0);
  const maxEV = Number(f.maxEV ?? 0);
  const avgEV = Number(f.avgEV ?? 0);
  const maxLA = Number(f.maxLA ?? 0);
  const nearBarrel = Number(f.nearBarrels ?? 0);
  const pFatigue = Number(f.pitcherFatigueBoost ?? 0);

  if (barrels >= 1) out.add("elite_barrel");
  if (nearBarrel >= 1 || tags.some(t => t.includes("near_barrel"))) out.add("near_barrel");
  if (hardHits >= 2) out.add("two_hard_hit_balls");
  if (deepFly >= 1 || (maxLA >= 28 && maxEV >= 95)) out.add("deep_fly_warning");
  if (avgEV >= 95 && maxEV >= 100) out.add("high_bat_speed_lift");
  if (pFatigue > 0 || tags.some(t => t.includes("fatigue") || t.includes("bullpen_downgrade")) ||
      drivers.some(d => d.includes("fatigue") || d.includes("collapse"))) {
    out.add("pitcher_collapse_power");
  }
  if (inning != null && inning >= 6 && (barrels >= 1 || hardHits >= 1 || deepFly >= 1 || (avgEV >= 92))) {
    out.add("late_game_power_build");
  }
  if (maxEV >= 108 || (barrels >= 1 && maxEV >= 105)) out.add("massive_single_contact");
  if (conv != null && conv >= 0.10) out.add("pre_hr_danger");
  if (tags.some(t => t.includes("pre_hr_danger") || t.includes("hrshaped") || t.includes("hr_shaped"))) {
    out.add("pre_hr_danger");
  }

  return Array.from(out);
}

// ── Phase 7 ────────────────────────────────────────────────────────────────
const STAGE_RANK: Record<HrRadarUserStage, number> = {
  resolved: 0,
  track: 1,
  build: 2,
  ready: 3,
  fire: 4,
};

export function deriveSuggestedUserStageFromSignals(args: {
  qualifyingSignals: HrQualifyingSignalType[];
}): HrRadarUserStage {
  const signals = new Set(args.qualifyingSignals ?? []);
  if (
    signals.has("massive_single_contact") ||
    (signals.has("elite_barrel") && signals.has("pitcher_collapse_power"))
  ) return "fire";
  if (
    signals.has("elite_barrel") ||
    signals.has("two_hard_hit_balls") ||
    signals.has("near_barrel") ||
    signals.has("late_game_power_build")
  ) return "ready";
  if (
    signals.has("deep_fly_warning") ||
    signals.has("high_bat_speed_lift") ||
    signals.has("pre_hr_danger") ||
    signals.has("pitcher_collapse_power")
  ) return "build";
  return "track";
}

/**
 * Choose the strongest of two stages (resolved < track < build < ready < fire).
 * Resolved is sticky — if either side says resolved, the result is resolved.
 */
export function strongerStage(a: HrRadarUserStage, b: HrRadarUserStage): HrRadarUserStage {
  if (a === "resolved" || b === "resolved") return "resolved";
  return STAGE_RANK[a] >= STAGE_RANK[b] ? a : b;
}

// ── Phase 4 / 8 / 9 / 12 — combined enrichment ─────────────────────────────
export interface UserStageEnrichment {
  userStage: HrRadarUserStage;
  stageLabel: string;       // "Track" / "Build" / "Ready" / "Fire" / "Resolved"
  stageDescription: string; // user-facing copy
  qualifyingSignals: HrQualifyingSignalType[];
  cleanReasons: string[];   // user-safe reasons (alias of provided userReasons)
  // 10-point user-facing scores (Phase 2/3). Falls back to fallbackScoreForStage
  // when the canonical score is null/zero AND useFallbackScore is true.
  initialSignalScore10: number | null;
  currentSignalScore10: number | null;
  peakSignalScore10: number | null;
  // ── Conviction-aware DISPLAY scores ────────────────────────────────────
  // Capped to the engine's actual conviction ceiling for the row's
  // alertPath. These are what the user-facing card SHOULD render as the
  // headline /10 number — they remain in lock-step with the section the
  // engine assigned the row to. The signal*10 fields above are kept
  // unchanged so admin/debug surfaces can still read raw readiness.
  // See `shared/hrRadarConviction.ts` for the cap rules.
  displayInitialScore10: number | null;
  displayCurrentScore10: number | null;
  displayPeakScore10: number | null;
  /** /10 ceiling applied (null when no cap was applied). */
  displayCap10: number | null;
  /** Pill label for capped rows (null when uncapped). */
  displayCapBadgeLabel: string | null;
  /** One-sentence why-capped explanation for the modal/tooltip. */
  displayCapReason: string | null;
  // Phase 8 — additive, in-memory grading shadow. Only set when userStage is
  // ready or fire. Never replaces gradingStatus on the row.
  officialSignalStage: "ready" | "fire" | null;
  officialSignalAt: string | null;       // ISO string
  officialSignalInning: number | null;
  // Phase 9 — write-once in-memory timestamps derived from the row. The
  // builder may persist these later; for now they are present on the wire so
  // the client can render "first ready at T6" etc.
  firstTrackedAt: string | null;
  firstTrackedInning: number | null;
  firstBuiltAt: string | null;
  firstBuiltInning: number | null;
  firstReadyAt: string | null;
  firstReadyInning: number | null;
  firstFireAt: string | null;
  firstFireInning: number | null;
  hrOccurredAt: string | null;
  hrOccurredInning: number | null;
  // Admin/debug — kept hidden from normal user copy.
  adminReasons: string[];
  debugReasons: string[];
  enginePath: string | null;
}

/**
 * Build the additive enrichment block for a single ladder entry / board row.
 * Pure function — never mutates inputs.
 *
 * Caller must have already extracted the legacy fields from the row. This
 * keeps the helper independent of the schema shape so the same enrichment
 * works for ladder rows, board rows, legacy /api/mlb/hr-radar rows, and
 * analyze-modal alerts.
 */
export function enrichWithUserStage(input: {
  legacyTier?: string | null;
  legacyState?: string | null;
  dynamicState?: string | null;
  canonicalStage?: string | null;
  outcome?: string | null;
  initialReadinessScore?: number | null;
  currentReadinessScore?: number | null;
  peakReadinessScore?: number | null;
  // Optional pre-computed 0-10 scores (the ladder builder already computes
  // these). When provided we use them as-is.
  initialSignalScore10?: number | null;
  currentSignalScore10?: number | null;
  peakSignalScore10?: number | null;
  factors?: any;
  triggerTags?: string[] | null;
  positiveDrivers?: string[] | null;
  conversionProbability?: number | null;
  confidenceScore?: number | null;
  inning?: number | null;
  detectedAt?: string | Date | null;
  detectedInning?: number | null;
  signalDetectedAt?: string | Date | null;
  signalInning?: number | null;
  hitDetectedAt?: string | Date | null;
  resolvedAt?: string | Date | null;
  hitInning?: number | null;
  userReasons?: string[] | null;
  adminReasons?: string[] | null;
  alertPath?: string | null;
  useFallbackScore?: boolean; // Phase 3: opt-in display fallback for zero rows
}): UserStageEnrichment {
  const legacyMapped = mapToUserStage({
    legacyTier: input.legacyTier,
    legacyState: input.legacyState,
    dynamicState: input.dynamicState,
    canonicalStage: input.canonicalStage,
    outcome: input.outcome,
    confidenceScore: input.confidenceScore,
    convProb: input.conversionProbability,
    alertPath: input.alertPath,
  });

  const qualifyingSignals = deriveQualifyingSignals({
    factors: input.factors,
    triggerTags: input.triggerTags,
    inning: input.inning ?? input.detectedInning ?? null,
    positiveDrivers: input.positiveDrivers,
    conversionProbability: input.conversionProbability,
  });

  // Phase 7 — combine. Resolved is sticky from legacy mapping.
  const suggested = deriveSuggestedUserStageFromSignals({ qualifyingSignals });
  const userStage: HrRadarUserStage =
    legacyMapped === "resolved" ? "resolved" : strongerStage(legacyMapped, suggested);

  // Phase 2 + 3 — user-facing 10-point scores.
  const initialFromInput = input.initialSignalScore10 ?? toSignalScore10(input.initialReadinessScore);
  const currentFromInput = input.currentSignalScore10 ?? toSignalScore10(input.currentReadinessScore);
  const peakFromInput = input.peakSignalScore10 ?? toSignalScore10(input.peakReadinessScore);
  const useFallback = input.useFallbackScore === true;
  const fallback = fallbackScoreForStage(userStage);
  const currentSignalScore10 =
    useFallback && (currentFromInput == null || currentFromInput === 0) ? fallback : currentFromInput;
  const initialSignalScore10 =
    useFallback && (initialFromInput == null || initialFromInput === 0) ? fallback : initialFromInput;
  const peakSignalScore10 =
    useFallback && (peakFromInput == null || peakFromInput === 0) ? fallback : peakFromInput;

  // ── Conviction-aware DISPLAY scores ────────────────────────────────────
  // For rows whose alertPath the engine intentionally locks at WATCH (e.g.
  // PATH_F_BLOCKED_BRIDGE, capped at confidenceScore 6), cap the displayed
  // /10 number so it never exceeds the engine's actual conviction. Never
  // applied to "resolved" rows — once a row is resolved the historical
  // score should render as it was at peak.
  const displayCap10 = userStage === "resolved" ? null : convictionDisplayCeiling10(input.alertPath);
  const displayBadge = userStage === "resolved" ? null : convictionDisplayBadge(input.alertPath);
  const capScore = (s: number | null): number | null => {
    if (s == null || displayCap10 == null) return s;
    return Math.min(s, displayCap10);
  };
  const displayInitialScore10 = capScore(initialSignalScore10);
  const displayCurrentScore10 = capScore(currentSignalScore10);
  const displayPeakScore10 = capScore(peakSignalScore10);
  const displayCapBadgeLabel = displayBadge?.label ?? null;
  const displayCapReason = displayBadge?.description ?? null;

  const isoOrNull = (d: string | Date | null | undefined): string | null => {
    if (d == null) return null;
    try {
      const dt = typeof d === "string" ? new Date(d) : d;
      if (isNaN(dt.getTime())) return null;
      return dt.toISOString();
    } catch { return null; }
  };

  // Phase 9 — derive write-once first*At from existing row timestamps. We
  // only know "first detected" reliably from detectedAt + signalDetectedAt;
  // for the others we conservatively reuse signalDetectedAt as the moment
  // the stage became achievable. This stays additive; nothing is overwritten.
  const detectedIso = isoOrNull(input.detectedAt);
  const signalIso = isoOrNull(input.signalDetectedAt) ?? detectedIso;
  const detectedInning = input.detectedInning ?? null;
  const signalInning = input.signalInning ?? detectedInning;

  const firstTrackedAt = detectedIso;
  const firstTrackedInning = detectedInning;
  // build/ready/fire markers only set when the user stage actually reached them.
  const firstBuiltAt = STAGE_RANK[userStage] >= STAGE_RANK.build ? signalIso : null;
  const firstBuiltInning = STAGE_RANK[userStage] >= STAGE_RANK.build ? signalInning : null;
  const firstReadyAt = STAGE_RANK[userStage] >= STAGE_RANK.ready ? signalIso : null;
  const firstReadyInning = STAGE_RANK[userStage] >= STAGE_RANK.ready ? signalInning : null;
  const firstFireAt = STAGE_RANK[userStage] >= STAGE_RANK.fire ? signalIso : null;
  const firstFireInning = STAGE_RANK[userStage] >= STAGE_RANK.fire ? signalInning : null;
  const hrOccurredAt = isoOrNull(input.hitDetectedAt) ?? isoOrNull(input.resolvedAt);
  const hrOccurredInning = input.hitInning ?? null;

  // Phase 8 — additive grading shadow (in-memory only).
  const officialSignalStage: "ready" | "fire" | null =
    userStage === "fire" ? "fire" : userStage === "ready" ? "ready" : null;
  const officialSignalAt = officialSignalStage ? signalIso : null;
  const officialSignalInning = officialSignalStage ? signalInning : null;

  return {
    userStage,
    stageLabel: getUserStageLabel(userStage),
    stageDescription: getUserStageCopy(userStage),
    qualifyingSignals,
    cleanReasons: input.userReasons ?? [],
    initialSignalScore10,
    currentSignalScore10,
    peakSignalScore10,
    displayInitialScore10,
    displayCurrentScore10,
    displayPeakScore10,
    displayCap10,
    displayCapBadgeLabel,
    displayCapReason,
    officialSignalStage,
    officialSignalAt,
    officialSignalInning,
    firstTrackedAt,
    firstTrackedInning,
    firstBuiltAt,
    firstBuiltInning,
    firstReadyAt,
    firstReadyInning,
    firstFireAt,
    firstFireInning,
    hrOccurredAt,
    hrOccurredInning,
    adminReasons: input.adminReasons ?? [],
    debugReasons: input.adminReasons ?? [],
    enginePath: input.alertPath ?? null,
  };
}

// ── Phase 12 — validation log helper ───────────────────────────────────────
export interface ValidationLogPayload {
  player: string;
  oldStage: string | null;
  newUserStage: HrRadarUserStage;
  score10: number | null;
  qualifyingSignals: HrQualifyingSignalType[];
  officialSignalStage: "ready" | "fire" | null;
  officialSignalAt: string | null;
  hrOccurredAt: string | null;
  wouldCountAsCalledHitV1: boolean;
}

/**
 * Build the validation payload for a single row. The caller decides whether
 * to actually console.log or persist it. We only emit a log when the FF is
 * on AND a debug env says so, so production noise stays bounded.
 */
export function buildValidationPayload(args: {
  player: string;
  oldStage: string | null;
  enrichment: UserStageEnrichment;
}): ValidationLogPayload {
  const e = args.enrichment;
  // Phase 12 hypothesis: a v1 "called hit" requires the official signal to
  // precede the HR. If hrOccurredAt is missing, we treat it as a non-event
  // (false). If the official stage was reached and either there's no HR or
  // the official precedes the HR, count it as v1 called hit.
  let wouldCountAsCalledHitV1 = false;
  if (e.officialSignalStage && e.officialSignalAt) {
    if (!e.hrOccurredAt) {
      wouldCountAsCalledHitV1 = false; // pending live row — don't claim a hit
    } else {
      const sig = new Date(e.officialSignalAt).getTime();
      const hr = new Date(e.hrOccurredAt).getTime();
      wouldCountAsCalledHitV1 = Number.isFinite(sig) && Number.isFinite(hr) && sig <= hr;
    }
  }
  return {
    player: args.player,
    oldStage: args.oldStage,
    newUserStage: e.userStage,
    score10: e.currentSignalScore10,
    qualifyingSignals: e.qualifyingSignals,
    officialSignalStage: e.officialSignalStage,
    officialSignalAt: e.officialSignalAt,
    hrOccurredAt: e.hrOccurredAt,
    wouldCountAsCalledHitV1,
  };
}
