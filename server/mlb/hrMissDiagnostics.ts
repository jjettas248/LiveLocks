/**
 * HR Miss Diagnostic Payload Generator — pure builders (no I/O).
 *
 * Assembles an LLM-ready diagnostic payload for HR Radar misses so an admin
 * can hand the engine's failure evidence to an external model and ask "why
 * did we miss, and what should change?". Read-only over already-persisted
 * grading truth: it never mutates the engine, the bus, lifecycle state, or
 * any canonical field, and it never re-grades an outcome — `gradingStatus`
 * stays authoritative.
 *
 * Two miss families are covered:
 *   - false positives: `called_miss` rows (we tracked/fired, no HR), split by
 *     the FIRE-only record contract into `fired_miss` (official, FIRE-committed)
 *     and `ready_only_miss` (high-watch shadow record, never FIRE-committed).
 *   - false negatives: `uncalled_hr` and `late_signal` rows (an HR happened
 *     without a timely call).
 * Early-window HRs (`early_hr_no_window` / `early_hr_insufficient_sample`)
 * are exempt from the record and only included when explicitly requested.
 *
 * The gatherer that feeds these builders from the DB lives in
 * `hrMissDiagnosticsService.ts`; this module stays pure for unit tests.
 *
 * Run tests: npx tsx server/mlb/hrMissDiagnostics.test.ts
 */

import { MLB_GOLDMASTER_VERSION } from "./goldmasterGuard";
import {
  reachedFireCommitment,
  extractPeakConversionProbability,
  FIRE_BET_NOW_CONV_THRESHOLD,
} from "./hrRadarSection";
import {
  OFFICIAL_HR_CONVERSION_FLOOR,
  LIVE_PROMOTION_SCORE_FLOOR_10,
} from "./hrReviewClassifier";

// ── Categories ───────────────────────────────────────────────────────────────

export type HrMissCategory =
  | "fired_miss" // called_miss that reached FIRE commitment — official false positive
  | "ready_only_miss" // called_miss that never reached FIRE — shadow/high-watch false positive
  | "uncalled_hr" // HR with no pre-HR alert/qualifying signal — false negative
  | "late_signal" // qualifying signal arrived at/after the HR — false negative
  | "early_window_exempt"; // 1st-inning / insufficient-sample HR — exempt from the record

export type HrMissKind = "false_positive" | "false_negative" | "exempt";

export const ALL_MISS_CATEGORIES: readonly HrMissCategory[] = [
  "fired_miss",
  "ready_only_miss",
  "uncalled_hr",
  "late_signal",
  "early_window_exempt",
];

/** Default payload scope — the four counted miss families, exempt excluded. */
export const DEFAULT_MISS_CATEGORIES: readonly HrMissCategory[] = [
  "fired_miss",
  "ready_only_miss",
  "uncalled_hr",
  "late_signal",
];

/** Grading statuses that map onto a miss category. */
export const MISS_GRADING_STATUSES = ["called_miss", "uncalled_hr", "late_signal"] as const;
export const EXEMPT_GRADING_STATUSES = [
  "early_hr_no_window",
  "early_hr_insufficient_sample",
  "early_window_hr",
] as const;

// ── Inputs (subset of the persisted hr_radar_alerts / hr_radar_signal_events rows) ──

export interface HrMissAlertRowInput {
  id: string;
  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team?: string | null;
  opponent?: string | null;

  gradingStatus: string;
  gradingReason?: string | null;
  matchMethod?: string | null;
  matchedBeforeHr?: boolean | null;
  status?: string | null;

  alertPath?: string | null;
  alertTier?: string | null;
  confidenceTier?: string | null;
  signalState?: string | null;
  triggerTags?: string[] | null;
  summaryText?: string | null;

  detectedInning?: number | null;
  detectedHalf?: string | null;
  signalInning?: number | null;
  signalHalf?: string | null;
  signalDetectedAt?: Date | string | null;
  hitInning?: number | null;
  hitHalf?: string | null;
  resolvedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
  promotedAt?: Date | string | null;
  alertSentAt?: Date | string | null;

  // numeric() columns arrive as strings from Drizzle — tolerated here.
  initialReadinessScore?: string | number | null;
  currentReadinessScore?: string | number | null;
  peakReadinessScore?: string | number | null;
  rawPreCapScore?: string | number | null;
  finalScore?: string | number | null;
  capReason?: string | null;
  suppressionReason?: string | null;
  missingInputs?: string[] | null;
  confidence?: string | number | null;
  dataQualityFlags?: string[] | null;

  contactSnapshot?: unknown;
  diagnosticsSnapshot?: unknown;
}

export interface HrMissSignalEventInput {
  eventType: string;
  signalState?: string | null;
  score?: string | number | null;
  confidenceTier?: string | null;
  detectedAt?: Date | string | null;
  inning?: number | null;
  half?: string | null;
}

// ── Record output ────────────────────────────────────────────────────────────

export interface HrMissTimelineEvent {
  at: string | null;
  eventType: string;
  signalState: string | null;
  score: number | null;
  inning: number | null;
  half: string | null;
}

export interface HrMissDiagnosticRecord {
  category: HrMissCategory;
  missKind: HrMissKind;

  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string | null;
  opponent: string | null;

  grading: {
    gradingStatus: string;
    gradingReason: string | null;
    matchMethod: string | null;
    matchedBeforeHr: boolean | null;
    fireCommitted: boolean;
    /** Derived recall gate from the analytics miss tracer, when available. */
    blockedGate: string | null;
  };

  timing: {
    detectedInning: number | null;
    detectedHalf: string | null;
    signalInning: number | null;
    signalHalf: string | null;
    signalDetectedAt: string | null;
    hitInning: number | null;
    hitHalf: string | null;
    firstSeenAt: string | null;
    promotedAt: string | null;
    alertSentAt: string | null;
    resolvedAt: string | null;
  };

  scores: {
    initialReadiness: number | null;
    currentReadiness: number | null;
    peakReadiness: number | null;
    rawPreCapScore: number | null;
    finalScore: number | null;
    capReason: string | null;
    confidence: number | null;
  };

  engine: {
    alertPath: string | null;
    alertTier: string | null;
    confidenceTier: string | null;
    signalState: string | null;
    canonicalStage: string | null;
    dynamicState: string | null;
    consecutivePromoteTicks: number | null;
    buildScore: number | null;
    conversionProbabilityRaw: number | null;
    conversionProbability: number | null;
    peakConversionProbability: number | null;
    plateAppearancesTracked: number | null;
    hasLiveABContext: boolean | null;
  };

  dataQuality: {
    suppressionReason: string | null;
    missingInputs: string[];
    dataQualityFlags: string[];
  };

  evidence: {
    triggerTags: string[];
    summaryText: string | null;
    contactSnapshot: Record<string, unknown> | null;
  };

  /** Persisted review-bucket taxonomy (diagnosticsSnapshot.hrReview), when stamped. */
  review: {
    bucket: string | null;
    reason: string | null;
    dataQuality: string | null;
    preHrPeakStage: string | null;
    preHrPeakScore10: number | null;
    completedAbsBeforeHr: number | null;
    hadNearHrBeforeHr: boolean | null;
    hadBarrelBeforeHr: boolean | null;
    hadHardHitBeforeHr: boolean | null;
    hadPregameWatch: boolean | null;
  } | null;

  timeline: HrMissTimelineEvent[];
  timelineTruncated: number;
}

// ── Payload output ───────────────────────────────────────────────────────────

export interface HrMissDiagnosticSummary {
  totalRecords: number;
  falsePositives: number;
  falseNegatives: number;
  exempt: number;
  byCategory: Record<string, number>;
  byReviewBucket: Record<string, number>;
  byAlertPath: Record<string, number>;
  bySuppressionReason: Record<string, number>;
  byCapReason: Record<string, number>;
  byMissingInput: Record<string, number>;
  byBlockedGate: Record<string, number>;
  avgPeakReadinessOnFalsePositives: number | null;
  avgPeakConversionOnFalsePositives: number | null;
}

export interface HrMissDiagnosticPayload {
  generatedAt: string;
  engineVersion: string;
  window: { days: number; fromDateET: string; toDateET: string };
  requestedCategories: HrMissCategory[];
  /** Total qualifying rows found before the limit was applied. */
  totalMissesInWindow: number;
  recordLimit: number;
  truncated: boolean;
  modelContext: typeof HR_MISS_MODEL_CONTEXT;
  analysisInstructions: string;
  summary: HrMissDiagnosticSummary;
  records: HrMissDiagnosticRecord[];
}

// ── Static model context handed to the LLM ───────────────────────────────────
// Describes the system in engine-layer vocabulary so the external model's
// suggestions land in the right layer. Display/diagnostic only — the runtime
// never reads any of this back.

export const HR_MISS_MODEL_CONTEXT = {
  system:
    "LiveLocks HR Radar — a live MLB home-run signal engine. Per game tick it scores every batter's " +
    "chance of homering from live contact quality (exit velocity, launch angle, distance, barrels, xBA), " +
    "pitcher fatigue/collapse, pitch-mix vs handedness, park/weather fit, pregame power priors, and a " +
    "calibrated HR-conversion probability model.",
  lifecycle:
    "Canonical lifecycle: inactive → watch → build → ready → fire, terminal: cashed | missed | " +
    "model_review | expired (terminal states are sticky). Only rows that reached user-stage FIRE " +
    "count in the official W/L record; READY-only rows are shadow/high-watch.",
  gradingStatuses: {
    called_miss: "We tracked the batter at an actionable tier and they did not homer (false positive).",
    uncalled_hr: "The batter homered and no alert row / qualifying pre-HR signal existed (false negative).",
    late_signal: "A qualifying signal appeared at or after the HR (false negative).",
    early_hr_no_window:
      "First-inning HR with no realistic pre-signal window — exempt from the miss record.",
  },
  reviewBuckets:
    "Persisted per-HR review taxonomy (diagnosticsSnapshot.hrReview.bucket): called_hit, late_signal, " +
    "attribution_miss, same_pa_hr_no_prior_live_signal, early_window_hr, live_promotion_miss, " +
    "context_miss, true_uncalled_hr, insufficient_review_data.",
  thresholds: {
    fireBetNowConversionThreshold: FIRE_BET_NOW_CONV_THRESHOLD,
    officialHrConversionFloor: OFFICIAL_HR_CONVERSION_FLOOR,
    livePromotionScoreFloor10: LIVE_PROMOTION_SCORE_FLOOR_10,
  },
  scoreScales: {
    readinessScores: "0–100 canonical readiness scale (initial/current/peak/rawPreCap/final).",
    conversionProbabilities: "0–1 per-game calibrated HR-conversion probabilities.",
    reviewScore10: "0–10 user-facing conviction scale used by the review taxonomy.",
  },
  fieldNotes: {
    fireCommitted:
      "True when the row took the FAST_PROMOTE_ELITE path or its peak conversion crossed the BET_NOW band — " +
      "the FIRE-only official-record gate.",
    blockedGate:
      "For false negatives: derived reason no fire happened (no_alert / conv_low / below_prepare / " +
      "below_bet_now / suppressed:<reason> / decayed / late_signal). Best-effort from the in-memory " +
      "miss tracer; null when the process restarted since grading.",
    rawPreCapScore_finalScore:
      "Readiness before and after data-quality caps; capReason names the binding cap when they differ.",
    missingInputs:
      "Engine inputs absent at score time (missing_statcast, degraded_contact_data, missing_batter_power, " +
      "missing_handedness_splits, ...). Separates model weakness from missing data.",
    timeline: "Chronological qualifying signal events persisted for the row (event, state, score, inning).",
  },
  changeDiscipline:
    "Probability/behavior improvements belong in the engine layer (hrConversionModel, evaluateHRAlert, " +
    "hrAlertEngine, signalScore, probabilityEngine, nearHrContact) before the signal bus. New model inputs " +
    "must be additive and no-op when absent; single-feature probability effects must stay capped; engine " +
    "changes require a goldmaster re-baseline and the regression suites.",
} as const;

export const DEFAULT_ANALYSIS_INSTRUCTIONS =
  "You are auditing the HR Radar's misses. Using ONLY the evidence in this payload: " +
  "(1) Group the records into recurring root-cause patterns (cite gameId/playerId per pattern; do not invent data). " +
  "(2) For false negatives, separate model weakness (strong pre-HR evidence present but under-scored, e.g. " +
  "live_promotion_miss with barrels/near-HRs) from data gaps (missingInputs / degraded dataQualityFlags / " +
  "insufficient_review_data) and no-window cases. " +
  "(3) For false positives, identify what the engine over-weighted (drivers, paths, park/pitcher context) and " +
  "whether peak conversion probabilities were systematically optimistic. " +
  "(4) Propose concrete, engine-layer changes — threshold shifts, new capped features, gate adjustments — each " +
  "tied to the specific records it would have fixed, with an estimate of how many misses in this payload it " +
  "addresses and any called hits it might cost. " +
  "(5) Rank proposals by expected impact and flag any where the payload's sample is too small to act on.";

// ── Helpers ──────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function bump(map: Record<string, number>, key: string | null | undefined): void {
  const k = key && key.length ? key : null;
  if (!k) return;
  map[k] = (map[k] ?? 0) + 1;
}

// ── Category derivation ──────────────────────────────────────────────────────

/**
 * Map a persisted row's authoritative gradingStatus onto a miss category.
 * Returns null for anything that is not a miss (active, called_hit*, expired) —
 * the generator never re-grades, it only categorizes existing grades.
 */
export function deriveMissCategory(row: HrMissAlertRowInput): HrMissCategory | null {
  const status = norm(row.gradingStatus);
  if (status === "called_miss") {
    const fireCommitted = reachedFireCommitment({
      alertPath: row.alertPath ?? null,
      peakConversionProbability: extractPeakConversionProbability(row.diagnosticsSnapshot),
    });
    return fireCommitted ? "fired_miss" : "ready_only_miss";
  }
  if (status === "uncalled_hr") return "uncalled_hr";
  if (status === "late_signal") return "late_signal";
  if ((EXEMPT_GRADING_STATUSES as readonly string[]).includes(status)) return "early_window_exempt";
  return null;
}

export function missKindOf(category: HrMissCategory): HrMissKind {
  if (category === "fired_miss" || category === "ready_only_miss") return "false_positive";
  if (category === "early_window_exempt") return "exempt";
  return "false_negative";
}

// ── Record builder ───────────────────────────────────────────────────────────

const MAX_TIMELINE_EVENTS = 12;

export function buildHrMissDiagnosticRecord(
  row: HrMissAlertRowInput,
  events: HrMissSignalEventInput[] = [],
  extras: { blockedGate?: string | null } = {},
): HrMissDiagnosticRecord | null {
  const category = deriveMissCategory(row);
  if (!category) return null;

  const diag = (row.diagnosticsSnapshot ?? {}) as Record<string, any>;
  const scoreContract = (diag.scoreContract ?? {}) as Record<string, unknown>;
  const stageContract = (diag.stageContract ?? {}) as Record<string, unknown>;
  const abContext = (diag.abContext ?? {}) as Record<string, unknown>;
  const hrReview = diag.hrReview as
    | { bucket?: unknown; reason?: unknown; snapshot?: Record<string, any> }
    | undefined;
  const reviewSnap = (hrReview?.snapshot ?? {}) as Record<string, any>;

  const peakConversionProbability = extractPeakConversionProbability(row.diagnosticsSnapshot);
  const fireCommitted = reachedFireCommitment({
    alertPath: row.alertPath ?? null,
    peakConversionProbability,
  });

  const sorted = [...events].sort((a, b) => {
    const ta = iso(a.detectedAt) ?? "";
    const tb = iso(b.detectedAt) ?? "";
    return ta.localeCompare(tb);
  });
  const truncatedCount = Math.max(0, sorted.length - MAX_TIMELINE_EVENTS);
  // Keep the earliest 2 (how the signal started) + the most recent remainder
  // (how it ended) when a long timeline must be cut.
  const kept =
    truncatedCount > 0
      ? [...sorted.slice(0, 2), ...sorted.slice(sorted.length - (MAX_TIMELINE_EVENTS - 2))]
      : sorted;

  return {
    category,
    missKind: missKindOf(category),

    sessionDate: row.sessionDate,
    gameId: row.gameId,
    playerId: row.playerId,
    playerName: row.playerName,
    team: row.team ?? null,
    opponent: row.opponent ?? null,

    grading: {
      gradingStatus: row.gradingStatus,
      gradingReason: row.gradingReason ?? null,
      matchMethod: row.matchMethod ?? null,
      matchedBeforeHr: row.matchedBeforeHr ?? null,
      fireCommitted,
      blockedGate: extras.blockedGate ?? null,
    },

    timing: {
      detectedInning: row.detectedInning ?? null,
      detectedHalf: row.detectedHalf ?? null,
      signalInning: row.signalInning ?? null,
      signalHalf: row.signalHalf ?? null,
      signalDetectedAt: iso(row.signalDetectedAt),
      hitInning: row.hitInning ?? null,
      hitHalf: row.hitHalf ?? null,
      firstSeenAt: iso(row.firstSeenAt),
      promotedAt: iso(row.promotedAt),
      alertSentAt: iso(row.alertSentAt),
      resolvedAt: iso(row.resolvedAt),
    },

    scores: {
      initialReadiness: num(row.initialReadinessScore),
      currentReadiness: num(row.currentReadinessScore),
      peakReadiness: num(row.peakReadinessScore),
      rawPreCapScore: num(row.rawPreCapScore),
      finalScore: num(row.finalScore),
      capReason: row.capReason ?? null,
      confidence: num(row.confidence),
    },

    engine: {
      alertPath: row.alertPath ?? null,
      alertTier: row.alertTier ?? null,
      confidenceTier: row.confidenceTier ?? null,
      signalState: row.signalState ?? null,
      canonicalStage: (stageContract.currentCanonicalStage as string | null) ?? null,
      dynamicState: (stageContract.dynamicState as string | null) ?? null,
      consecutivePromoteTicks: num(stageContract.consecutivePromoteTicks),
      buildScore: num(scoreContract.buildScore),
      conversionProbabilityRaw: num(scoreContract.conversionProbabilityRaw),
      conversionProbability: num(scoreContract.conversionProbability),
      peakConversionProbability,
      plateAppearancesTracked: num(abContext.plateAppearancesTracked),
      hasLiveABContext:
        typeof abContext.hasLiveABContext === "boolean" ? abContext.hasLiveABContext : null,
    },

    dataQuality: {
      suppressionReason: row.suppressionReason ?? null,
      missingInputs: Array.isArray(row.missingInputs) ? row.missingInputs : [],
      dataQualityFlags: Array.isArray(row.dataQualityFlags) ? row.dataQualityFlags : [],
    },

    evidence: {
      triggerTags: Array.isArray(row.triggerTags) ? row.triggerTags : [],
      summaryText: row.summaryText ?? null,
      contactSnapshot:
        row.contactSnapshot && typeof row.contactSnapshot === "object"
          ? (row.contactSnapshot as Record<string, unknown>)
          : null,
    },

    review: hrReview
      ? {
          bucket: typeof hrReview.bucket === "string" ? hrReview.bucket : null,
          reason: typeof hrReview.reason === "string" ? hrReview.reason : null,
          dataQuality: typeof reviewSnap.dataQuality === "string" ? reviewSnap.dataQuality : null,
          preHrPeakStage:
            typeof reviewSnap.preHrPeakStage === "string" ? reviewSnap.preHrPeakStage : null,
          preHrPeakScore10: num(reviewSnap.preHrPeakScore10),
          completedAbsBeforeHr: num(reviewSnap.completedAbsBeforeHr),
          hadNearHrBeforeHr:
            typeof reviewSnap.hadNearHrBeforeHr === "boolean" ? reviewSnap.hadNearHrBeforeHr : null,
          hadBarrelBeforeHr:
            typeof reviewSnap.hadBarrelBeforeHr === "boolean" ? reviewSnap.hadBarrelBeforeHr : null,
          hadHardHitBeforeHr:
            typeof reviewSnap.hadHardHitBeforeHr === "boolean" ? reviewSnap.hadHardHitBeforeHr : null,
          hadPregameWatch:
            typeof reviewSnap.hadPregameWatch === "boolean" ? reviewSnap.hadPregameWatch : null,
        }
      : null,

    timeline: kept.map((e) => ({
      at: iso(e.detectedAt),
      eventType: e.eventType,
      signalState: e.signalState ?? null,
      score: num(e.score),
      inning: e.inning ?? null,
      half: e.half ?? null,
    })),
    timelineTruncated: truncatedCount,
  };
}

// ── Summary + payload builders ───────────────────────────────────────────────

export function buildHrMissDiagnosticSummary(
  records: HrMissDiagnosticRecord[],
): HrMissDiagnosticSummary {
  const byCategory: Record<string, number> = {};
  const byReviewBucket: Record<string, number> = {};
  const byAlertPath: Record<string, number> = {};
  const bySuppressionReason: Record<string, number> = {};
  const byCapReason: Record<string, number> = {};
  const byMissingInput: Record<string, number> = {};
  const byBlockedGate: Record<string, number> = {};

  let falsePositives = 0;
  let falseNegatives = 0;
  let exempt = 0;
  const fpPeakReadiness: number[] = [];
  const fpPeakConversion: number[] = [];

  for (const r of records) {
    bump(byCategory, r.category);
    bump(byReviewBucket, r.review?.bucket ?? null);
    bump(byAlertPath, r.engine.alertPath);
    bump(bySuppressionReason, r.dataQuality.suppressionReason);
    bump(byCapReason, r.scores.capReason);
    bump(byBlockedGate, r.grading.blockedGate);
    for (const mi of r.dataQuality.missingInputs) bump(byMissingInput, mi);

    if (r.missKind === "false_positive") {
      falsePositives++;
      if (r.scores.peakReadiness != null) fpPeakReadiness.push(r.scores.peakReadiness);
      if (r.engine.peakConversionProbability != null)
        fpPeakConversion.push(r.engine.peakConversionProbability);
    } else if (r.missKind === "false_negative") {
      falseNegatives++;
    } else {
      exempt++;
    }
  }

  const avg = (xs: number[]): number | null =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10000) / 10000 : null;

  return {
    totalRecords: records.length,
    falsePositives,
    falseNegatives,
    exempt,
    byCategory,
    byReviewBucket,
    byAlertPath,
    bySuppressionReason,
    byCapReason,
    byMissingInput,
    byBlockedGate,
    avgPeakReadinessOnFalsePositives: avg(fpPeakReadiness),
    avgPeakConversionOnFalsePositives: avg(fpPeakConversion),
  };
}

export interface BuildHrMissPayloadOptions {
  generatedAt: string;
  days: number;
  fromDateET: string;
  toDateET: string;
  requestedCategories: HrMissCategory[];
  totalMissesInWindow: number;
  recordLimit: number;
  analysisInstructions?: string;
}

export function buildHrMissDiagnosticPayload(
  records: HrMissDiagnosticRecord[],
  opts: BuildHrMissPayloadOptions,
): HrMissDiagnosticPayload {
  return {
    generatedAt: opts.generatedAt,
    engineVersion: MLB_GOLDMASTER_VERSION,
    window: { days: opts.days, fromDateET: opts.fromDateET, toDateET: opts.toDateET },
    requestedCategories: opts.requestedCategories,
    totalMissesInWindow: opts.totalMissesInWindow,
    recordLimit: opts.recordLimit,
    truncated: opts.totalMissesInWindow > records.length,
    modelContext: HR_MISS_MODEL_CONTEXT,
    analysisInstructions: opts.analysisInstructions ?? DEFAULT_ANALYSIS_INSTRUCTIONS,
    summary: buildHrMissDiagnosticSummary(records),
    records,
  };
}

// ── LLM prompt rendering ─────────────────────────────────────────────────────

/**
 * Render the payload as a single self-contained markdown prompt for direct
 * copy-paste into an external LLM. Prose preamble + fenced JSON blocks.
 */
export function renderHrMissDiagnosticPayloadAsMarkdown(
  payload: HrMissDiagnosticPayload,
): string {
  const lines: string[] = [];
  lines.push("# LiveLocks HR Radar — Miss Diagnostic Payload");
  lines.push("");
  lines.push(
    `Generated ${payload.generatedAt} · engine ${payload.engineVersion} · window ` +
      `${payload.window.fromDateET} → ${payload.window.toDateET} (${payload.window.days}d) · ` +
      `${payload.records.length} of ${payload.totalMissesInWindow} misses included` +
      (payload.truncated ? ` (truncated to the ${payload.recordLimit} most recent)` : ""),
  );
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(payload.analysisInstructions);
  lines.push("");
  lines.push("## System context");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(payload.modelContext, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Aggregate summary");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(payload.summary, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Miss records (${payload.records.length})`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(payload.records, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
