/**
 * SAFE ADDITIVE MODULE.
 *
 * Pure HR Radar review classifier.
 * No DB access.
 * No API access.
 * No engine mutation.
 * No probability mutation.
 * No alert threshold mutation.
 *
 * Classifies WHY an HR was or was not caught using only pre-HR evidence.
 *
 * The classifier explains outcomes; it never decides W/L. The existing
 * `gradingStatus` / `HrRadarOutcomeStatus` stays authoritative — review buckets
 * are a strictly finer-grained, orthogonal diagnostic stored alongside it.
 *
 * Hard rules honored here:
 *   - The HR swing is NEVER counted as pre-HR evidence (filterStrictPreHrAbs).
 *   - Missing / ambiguous review data resolves to `insufficient_review_data`,
 *     never `true_uncalled_hr` — so data failures cannot pollute the true-miss
 *     bucket.
 *   - Raw conversion probability is metadata only; it never marks `called_hit`.
 *   - Internal, non-surfaced engine records never prove `attribution_miss`.
 *   - Power profile alone never creates `context_miss` (it is an amplifier).
 */

// ── Public types ────────────────────────────────────────────────────────────

export type HrPreSignalStage = "inactive" | "watch" | "build" | "ready" | "fire";

export type HrReviewDataQuality = "complete" | "partial" | "missing" | "ambiguous";

export type HrReviewBucket =
  | "called_hit"
  | "late_signal"
  | "attribution_miss"
  | "same_pa_hr_no_prior_live_signal"
  | "early_window_hr"
  | "live_promotion_miss"
  | "context_miss"
  | "true_uncalled_hr"
  | "insufficient_review_data";

/** A single completed pre-HR plate appearance / batted-ball event. */
export interface HrContactEvent {
  abIndex?: number | null;
  eventTimeMs?: number | null;
  inning?: number | null;
  half?: string | null;
  exitVelocity?: number | null;
  launchAngle?: number | null;
  distance?: number | null;
  xba?: number | null;
  isBarrel?: boolean | null;
  contactQuality?: string | null;
  outcome?: string | null;
  hitType?: string | null;
}

export interface HrPreSignalSnapshot {
  dataQuality: HrReviewDataQuality;
  dataQualityReasons: string[];

  preHrPeakScore10: number | null;
  preHrPeakStage: HrPreSignalStage;
  preHrPeakAtMs: number | null;
  preHrPeakInning: number | null;

  firstReadyAtMs: number | null;
  firstFireAtMs: number | null;
  firstOfficialSignalAtMs: number | null;

  currentScore10: number | null;
  currentStage: HrPreSignalStage;

  firstQualifyingSignalAtMs: number | null;
  firstQualifyingSignalInning: number | null;

  sourceAbIndex: number | null;
  completedAbsBeforeHr: number;

  hadPregameWatch: boolean;
  hadPregameTargetTag: boolean;

  hadHardHitBeforeHr: boolean;
  hadHrCandidateContactBeforeHr: boolean;
  hadNearHrBeforeHr: boolean;
  hadBarrelBeforeHr: boolean;
  hadPitcherCollapseBeforeHr: boolean;

  signalBusHadPreHrRecord: boolean;
  lifecycleHadPreHrRecord: boolean;
  persistedAlertHadPreHrOfficialState: boolean;
  /** Diagnostic only — internal engine generation before HR. NEVER proves attribution. */
  engineGeneratedBeforeHr: boolean;

  matchedBeforeHr: boolean | null;
  matchMethod: string | null;

  checkedSignalIds: string[];
  preHrEventSource: "live_cache" | "persisted_snapshot" | "mixed" | "none";
}

export interface HrReviewClassifierInput {
  // Existing settled status (W/L authoritative) — short-circuits classification.
  existingOutcomeStatus?: string | null;

  // Identity (used only for data-quality evaluation).
  playerId?: string | number | null;
  playerName?: string | null;

  // Pre-HR engine snapshot.
  peakState?: string | null;
  peakConversionProbability?: number | null;
  peakReadinessScore?: number | null;
  peakScore10?: number | null;
  peakAtMs?: number | null;
  detectedInning?: number | null;

  firstReadyAtMs?: number | null;
  firstFireAtMs?: number | null;
  firstOfficialSignalAtMs?: number | null;

  currentReadinessScore?: number | null;
  currentScore10?: number | null;
  currentStage?: string | null;
  currentSignalState?: string | null;
  currentAlertTier?: string | null;
  canonicalStage?: string | null;

  // Tier taxonomy (current alert).
  alertTier?: string | null;
  signalState?: string | null;
  confidenceTier?: string | null;

  // Qualifying signal event timing.
  firstQualifyingSignalAtMs?: number | null;
  firstQualifyingSignalInning?: number | null;
  matchedBeforeHr?: boolean | null;
  matchMethod?: string | null;

  // HR event facts.
  hrEndTimeMs?: number | null;
  hrInning?: number | null;
  hrAtBatIndex?: number | null;
  hrPlayId?: string | null;
  hrEventWasBarrelOrHrShaped?: boolean | null;

  // Pre-HR AB timeline (resolver output) + its status.
  preHrAbs?: HrContactEvent[];
  preHrResolverStatus?: "complete" | "partial" | "missing" | "ambiguous" | null;
  preHrEventSource?: "live_cache" | "persisted_snapshot" | "mixed" | "none" | null;

  // Near-HR window peak (detectNearHrContactPeak over preHrAbs).
  nearHrPeakTier?: "watch" | "lean" | null;
  nearHrSourceAbIndex?: number | null;

  // Pregame radar lookup.
  hadPregameWatch?: boolean | null;
  hadPregameTargetTag?: boolean | null;

  // Pitcher / environment / batter context.
  pitcherCollapsing?: boolean | null;
  hrPronePitcher?: boolean | null;
  bullpenDepleted?: boolean | null;
  parkWeatherBoost?: boolean | null;
  powerProfile?: boolean | null;

  // Bus / lifecycle / persisted-alert pre-HR evidence (caller-computed).
  signalBusHadPreHrRecord?: boolean | null;
  lifecycleHadPreHrRecord?: boolean | null;
  persistedAlertHadPreHrOfficialState?: boolean | null;
  engineGeneratedBeforeHr?: boolean | null;
  checkedSignalIds?: string[];
}

export interface HrReviewResult {
  bucket: HrReviewBucket;
  reason: string;
  snapshot: HrPreSignalSnapshot;
}

// ── Constants (review classification only — never engine math) ───────────────

/** Calibrated-conversion floor — METADATA ONLY. Never marks `called_hit`. */
export const OFFICIAL_HR_CONVERSION_FLOOR = 0.12;
/** "Detected but not promoted" peak floor that makes a watch/build a promotion miss. */
export const LIVE_PROMOTION_SCORE_FLOOR_10 = 4.5;
const HARD_HIT_EV_FLOOR = 95;
const HR_CANDIDATE_MIN_EV = 98;
const HR_CANDIDATE_MIN_LA = 20;
const HR_CANDIDATE_MAX_LA = 38;
const HR_CANDIDATE_MIN_DISTANCE = 330;
const EARLY_WINDOW_MAX_COMPLETED_ABS = 1;
const EARLY_WINDOW_MAX_INNING = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize any engine/stage label into the 5-value pre-HR stage vocabulary.
 * PREPARE maps to `build`, NOT `ready`.
 */
export function normalizeHrStage(value: unknown): HrPreSignalStage {
  const v = norm(value);
  if (["fire", "attack", "bet_now", "betnow", "elite"].includes(v)) return "fire";
  if (["ready", "officialalert", "official_alert", "strong"].includes(v)) return "ready";
  if (["build", "building", "prepare"].includes(v)) return "build";
  if (["watch", "track", "monitor", "watching", "live"].includes(v)) return "watch";
  return "inactive";
}

/**
 * Drop any AB at or after the HR — the HR swing can never be its own pre-HR
 * evidence. Belt-and-suspenders even if the resolver already filtered.
 */
function filterStrictPreHrAbs(
  abs: HrContactEvent[],
  hrAtBatIndex: number | null,
  hrEndTimeMs: number | null,
): HrContactEvent[] {
  return abs.filter((ab) => {
    if (hrAtBatIndex != null && ab.abIndex != null && ab.abIndex >= hrAtBatIndex) return false;
    if (hrEndTimeMs != null && ab.eventTimeMs != null && ab.eventTimeMs >= hrEndTimeMs) return false;
    return true;
  });
}

/**
 * Map existing settled W/L statuses directly onto a review bucket. Returns null
 * when the status is not authoritative (i.e. needs full classification).
 */
export function classifyAuthoritativeExistingStatus(
  existingOutcomeStatus?: string | null,
): HrReviewBucket | null {
  switch (norm(existingOutcomeStatus)) {
    case "called_hit":
    case "called_hit_attack":
    case "called_hit_ready":
    case "called_hit_build":
    case "called_hit_watch":
    case "called_near_hr":
      return "called_hit";
    case "late_signal":
      return "late_signal";
    case "early_hr_insufficient_sample":
      return "early_window_hr";
    default:
      return null;
  }
}

/** Returns all four data-quality states intentionally. */
function evaluateReviewDataQuality(input: HrReviewClassifierInput): {
  dataQuality: HrReviewDataQuality;
  reasons: string[];
} {
  const hasAnyInput =
    input.hrEndTimeMs != null ||
    input.hrAtBatIndex != null ||
    input.hrPlayId != null ||
    input.playerId != null ||
    input.playerName != null ||
    Boolean(input.preHrAbs?.length) ||
    input.peakState != null ||
    input.canonicalStage != null ||
    input.alertTier != null ||
    input.signalState != null ||
    input.confidenceTier != null ||
    input.firstReadyAtMs != null ||
    input.firstFireAtMs != null ||
    input.signalBusHadPreHrRecord === true ||
    input.lifecycleHadPreHrRecord === true ||
    input.persistedAlertHadPreHrOfficialState === true;

  if (!hasAnyInput) {
    return { dataQuality: "missing", reasons: ["empty_classifier_input"] };
  }

  const reasons: string[] = [];
  if (input.hrEndTimeMs == null) reasons.push("missing_hr_timestamp");
  if (input.hrAtBatIndex == null && input.hrPlayId == null) reasons.push("missing_hr_event_identity");
  if (!input.playerId && !input.playerName) reasons.push("missing_player_identity");
  if (input.preHrResolverStatus === "ambiguous") reasons.push("ambiguous_pre_hr_event_ordering");
  if (input.preHrResolverStatus === "missing") reasons.push("missing_pre_hr_event_source");

  const hasAnySignalState =
    input.peakState != null ||
    input.canonicalStage != null ||
    input.alertTier != null ||
    input.signalState != null ||
    input.confidenceTier != null ||
    input.firstReadyAtMs != null ||
    input.firstFireAtMs != null ||
    input.firstOfficialSignalAtMs != null ||
    input.signalBusHadPreHrRecord === true ||
    input.lifecycleHadPreHrRecord === true ||
    input.persistedAlertHadPreHrOfficialState === true;
  if (!hasAnySignalState) reasons.push("missing_signal_state_history");

  if (reasons.length === 0) return { dataQuality: "complete", reasons };

  if (
    reasons.includes("missing_hr_timestamp") ||
    reasons.includes("missing_player_identity") ||
    reasons.includes("ambiguous_pre_hr_event_ordering")
  ) {
    return { dataQuality: "ambiguous", reasons };
  }

  if (
    reasons.includes("missing_pre_hr_event_source") &&
    reasons.includes("missing_signal_state_history")
  ) {
    return { dataQuality: "missing", reasons };
  }

  return { dataQuality: "partial", reasons };
}

// ── Snapshot builder ─────────────────────────────────────────────────────────

export function buildHrPreSignalSnapshot(input: HrReviewClassifierInput): HrPreSignalSnapshot {
  const { dataQuality, reasons } = evaluateReviewDataQuality(input);

  const preHrAbs = filterStrictPreHrAbs(
    input.preHrAbs ?? [],
    input.hrAtBatIndex ?? null,
    input.hrEndTimeMs ?? null,
  );

  const hadHardHitBeforeHr = preHrAbs.some((ab) => (num(ab.exitVelocity) ?? 0) >= HARD_HIT_EV_FLOOR);

  const hadBarrelBeforeHr = preHrAbs.some(
    (ab) => ab.isBarrel === true || norm(ab.contactQuality) === "barrel",
  );

  const hadHrCandidateContactBeforeHr = preHrAbs.some((ab) => {
    const ev = num(ab.exitVelocity) ?? 0;
    const la = num(ab.launchAngle) ?? -999;
    const distance = num(ab.distance);
    const shapeOk = ev >= HR_CANDIDATE_MIN_EV && la >= HR_CANDIDATE_MIN_LA && la <= HR_CANDIDATE_MAX_LA;
    if (!shapeOk) return false;
    if (distance != null && distance > 0) return distance >= HR_CANDIDATE_MIN_DISTANCE;
    return true;
  });

  return {
    dataQuality,
    dataQualityReasons: reasons,

    preHrPeakScore10: num(input.peakReadinessScore ?? input.peakScore10),
    preHrPeakStage: normalizeHrStage(input.peakState ?? input.canonicalStage ?? input.alertTier),
    preHrPeakAtMs: num(input.peakAtMs),
    preHrPeakInning: num(input.detectedInning),

    firstReadyAtMs: num(input.firstReadyAtMs),
    firstFireAtMs: num(input.firstFireAtMs),
    firstOfficialSignalAtMs: num(input.firstOfficialSignalAtMs),

    currentScore10: num(input.currentReadinessScore ?? input.currentScore10),
    currentStage: normalizeHrStage(
      input.currentStage ?? input.canonicalStage ?? input.currentSignalState ?? input.currentAlertTier,
    ),

    firstQualifyingSignalAtMs: num(input.firstQualifyingSignalAtMs),
    firstQualifyingSignalInning: num(input.firstQualifyingSignalInning),

    sourceAbIndex: num(input.nearHrSourceAbIndex),
    completedAbsBeforeHr: preHrAbs.length,

    hadPregameWatch: Boolean(input.hadPregameWatch),
    hadPregameTargetTag: Boolean(input.hadPregameTargetTag),

    hadHardHitBeforeHr,
    hadHrCandidateContactBeforeHr,
    hadNearHrBeforeHr: input.nearHrPeakTier != null,
    hadBarrelBeforeHr,
    hadPitcherCollapseBeforeHr: Boolean(input.pitcherCollapsing),

    signalBusHadPreHrRecord: Boolean(input.signalBusHadPreHrRecord),
    lifecycleHadPreHrRecord: Boolean(input.lifecycleHadPreHrRecord),
    persistedAlertHadPreHrOfficialState: Boolean(input.persistedAlertHadPreHrOfficialState),
    engineGeneratedBeforeHr: Boolean(input.engineGeneratedBeforeHr),

    matchedBeforeHr: input.matchedBeforeHr ?? null,
    matchMethod: input.matchMethod ?? null,

    checkedSignalIds: input.checkedSignalIds ?? [],
    preHrEventSource: input.preHrEventSource ?? "none",
  };
}

// ── Classifier ───────────────────────────────────────────────────────────────

export function classifyHrReview(input: HrReviewClassifierInput): HrReviewResult {
  // Step 0 — authoritative existing W/L status wins, even with missing timestamps.
  const authoritativeBucket = classifyAuthoritativeExistingStatus(input.existingOutcomeStatus);
  if (authoritativeBucket) {
    return {
      bucket: authoritativeBucket,
      reason: `Existing authoritative HR Radar status maps directly to ${authoritativeBucket}.`,
      snapshot: buildHrPreSignalSnapshot(input),
    };
  }

  const snapshot = buildHrPreSignalSnapshot(input);
  const hrEndTimeMs = num(input.hrEndTimeMs);

  // Reconciliation failure — the signal did NOT cleanly attach to this HR. When
  // true, an inferred pre-HR official signal is an attribution bug, not a clean
  // called_hit, so it must fall through to the attribution_miss branch.
  const reconciliationFailed =
    snapshot.matchedBeforeHr === false || norm(input.matchMethod) === "player_game_only";

  // Step 1 — called_hit: a surfaced/official pre-HR signal that actually reconciled.
  // Raw conversion is NOT enough; failed reconciliation is NOT a called_hit.
  const officialSignalBeforeHr =
    hrEndTimeMs != null &&
    ((snapshot.firstReadyAtMs != null && snapshot.firstReadyAtMs < hrEndTimeMs) ||
      (snapshot.firstFireAtMs != null && snapshot.firstFireAtMs < hrEndTimeMs) ||
      (snapshot.firstOfficialSignalAtMs != null && snapshot.firstOfficialSignalAtMs < hrEndTimeMs) ||
      snapshot.persistedAlertHadPreHrOfficialState ||
      snapshot.lifecycleHadPreHrRecord ||
      (snapshot.signalBusHadPreHrRecord &&
        (snapshot.preHrPeakStage === "ready" || snapshot.preHrPeakStage === "fire")));

  if (officialSignalBeforeHr && !reconciliationFailed) {
    return {
      bucket: "called_hit",
      reason: "A surfaced official HR Radar signal existed before the HR.",
      snapshot,
    };
  }

  // Step 2 — late_signal: qualifying signal at/after the HR.
  const firstSignalWasAfterOrAtHr =
    hrEndTimeMs != null &&
    snapshot.firstQualifyingSignalAtMs != null &&
    snapshot.firstQualifyingSignalAtMs >= hrEndTimeMs;
  if (firstSignalWasAfterOrAtHr || norm(input.matchMethod) === "post_hr_fallback") {
    return {
      bucket: "late_signal",
      reason: "The qualifying signal appeared at or after the HR event.",
      snapshot,
    };
  }

  // Step 3 — attribution_miss: a real pre-HR signal existed but did not reconcile.
  const hasPreHrSignalEvidence =
    snapshot.signalBusHadPreHrRecord ||
    snapshot.lifecycleHadPreHrRecord ||
    snapshot.persistedAlertHadPreHrOfficialState;
  const signalExistedButDidNotMatch = hasPreHrSignalEvidence && reconciliationFailed;
  if (signalExistedButDidNotMatch) {
    return {
      bucket: "attribution_miss",
      reason: "A pre-HR signal existed but did not reconcile cleanly to the HR outcome.",
      snapshot,
    };
  }

  // Step 4 — insufficient_review_data: data failures never become a true miss.
  if (snapshot.dataQuality === "missing" || snapshot.dataQuality === "ambiguous") {
    return {
      bucket: "insufficient_review_data",
      reason: `Insufficient or ambiguous review data: ${snapshot.dataQualityReasons.join(", ")}`,
      snapshot,
    };
  }

  const hasLiveEvidenceBeforeHr =
    snapshot.hadNearHrBeforeHr ||
    snapshot.hadBarrelBeforeHr ||
    snapshot.hadHrCandidateContactBeforeHr;

  // Step 5 — same_pa_hr: HR swing was the first meaningful HR-shaped contact.
  if (!hasLiveEvidenceBeforeHr && Boolean(input.hrEventWasBarrelOrHrShaped)) {
    return {
      bucket: "same_pa_hr_no_prior_live_signal",
      reason: "The HR swing appears to be the first meaningful HR-shaped contact event.",
      snapshot,
    };
  }

  // Context evidence (powerProfile is an amplifier, never standalone).
  const hasPregameContext = snapshot.hadPregameTargetTag || snapshot.hadPregameWatch;
  const hasPitcherOrEnvironmentContext =
    snapshot.hadPitcherCollapseBeforeHr ||
    Boolean(input.hrPronePitcher) ||
    Boolean(input.bullpenDepleted) ||
    Boolean(input.parkWeatherBoost);
  const hasContextEvidenceBeforeHr =
    hasPregameContext ||
    hasPitcherOrEnvironmentContext ||
    (Boolean(input.powerProfile) && hasPitcherOrEnvironmentContext);

  // Step 6 — early_window_hr.
  const earlyWindow =
    ((num(input.hrInning) ?? 99) <= EARLY_WINDOW_MAX_INNING ||
      snapshot.completedAbsBeforeHr <= EARLY_WINDOW_MAX_COMPLETED_ABS) &&
    snapshot.preHrPeakStage !== "ready" &&
    snapshot.preHrPeakStage !== "fire";
  if (earlyWindow && !hasContextEvidenceBeforeHr) {
    return {
      bucket: "early_window_hr",
      reason: "The HR occurred too early for live confirmation and no context/pregame tag existed.",
      snapshot,
    };
  }

  // Step 7 — live_promotion_miss: meaningful live evidence/peak but never promoted.
  if (
    hasLiveEvidenceBeforeHr ||
    ((snapshot.preHrPeakStage === "watch" || snapshot.preHrPeakStage === "build") &&
      (snapshot.preHrPeakScore10 ?? 0) >= LIVE_PROMOTION_SCORE_FLOOR_10)
  ) {
    return {
      bucket: "live_promotion_miss",
      reason:
        "The radar had meaningful pre-HR live evidence or a meaningful pre-HR peak but did not promote to official status.",
      snapshot,
    };
  }

  // Step 8 — context_miss.
  if (hasContextEvidenceBeforeHr) {
    return {
      bucket: "context_miss",
      reason: "Context suggested HR risk before the HR, but the live radar did not promote strongly enough.",
      snapshot,
    };
  }

  // Step 9 — true_uncalled_hr (only reachable with sufficient data quality).
  return {
    bucket: "true_uncalled_hr",
    reason: "No qualifying pre-HR live signal, context flag, pregame tag, or attribution issue was found.",
    snapshot,
  };
}
