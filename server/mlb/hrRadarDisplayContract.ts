// HR Radar — user-facing display contract (presentation-layer only).
//
// Why this exists: the ladder card used to lead with a raw readiness `/10`
// number while the SECTION the row landed in was decided by a separate
// commitment/actionability axis. That made the UI look backwards — a BUILDING
// card could show 8.0 while a TOP WINDOW card showed 7.0. This module stamps a
// truthful, tier-banded display contract so the hierarchy is impossible to
// misread, while the true HR probability stays uncapped.
//
// PURE + DB-free so it is unit-testable without wiring the database. It NEVER
// mutates engine fields, grading, qualification, calibration, or W/L logic — it
// only derives display values from existing row data.

export type LiveHrSectionKey = "attackNow" | "ready" | "building" | "watch";
export type DisplayStageLabel = "TOP WINDOW" | "ALMOST" | "WATCHING";

export type HrRadarDisplayContract = {
  /** True calibrated HR probability as a whole percent. Never tier-capped. */
  displayHrChancePct: number | null;
  /** Raw current readiness on the 0-10 scale (NOT path/section-capped). */
  displayReadinessScore10: number | null;
  /** Tier-banded actionability score on the 0-10 scale. */
  displayActionScore10: number | null;
  /** Tier-banded actionability as a whole percent (drives the bar width). */
  displayActionPct: number | null;
  displayStageLabel: DisplayStageLabel;
  displayStageSubLabel: string;
  displayPrimaryReason: string | null;
  displayWhyNotTopWindow: string | null;
  /** Display-only: derived from officialSignalStage. Not a grading write. */
  displayRecordEligible: boolean;
};

// Minimal structural view of a ladder entry — kept local so this module has no
// import cycle with storage.ts (which owns the full HrRadarLadderEntry type).
type DisplayContractInput = {
  conversionProbability?: number | null;
  currentSignalScore10?: number | null;
  currentReadinessScore?: number | null;
  signalStrengthScore?: number | null;
  peakSignalScore10?: number | null;
  displayCurrentScore10?: number | null;
  displayCapReason?: string | null;
  displayCapBadgeLabel?: string | null;
  headlineReason?: string | null;
  supportingReasons?: string[];
  userReasons?: string[];
  whyNowReasons?: string[];
  isCoolingOff?: boolean;
  hasLiveABContext?: boolean | null;
  plateAppearancesTracked?: number | null;
  officialSignalStage?: "fire" | null;
};

/**
 * Normalize a probability-like value to a whole percent, or null.
 *
 * Guards null/empty FIRST — `Number(null) === 0` and `Number("") === 0`, which
 * would otherwise surface a false `0%` HR chance for rows that simply have no
 * probability yet.
 *
 * Accepts the engine's 0-1 convention and defensively supports older/stale
 * 0-100 payloads. Out-of-range (e.g. 1600) → null. Never tier-clamped.
 */
export function normalizeProbabilityPct(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n >= 0 && n <= 1) return Math.round(n * 100);
  if (n > 1 && n <= 100) return Math.round(n);
  return null;
}

/**
 * Normalize a score to the 0-10 scale (one decimal), or null.
 * Guards null/empty first (see normalizeProbabilityPct). Values >10 are treated
 * as a 0-100 readiness scale and divided down.
 */
export function normalizeScore10(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const score10 = n > 10 ? n / 10 : n;
  return Math.max(0, Math.min(10, Math.round(score10 * 10) / 10));
}

/**
 * Current readiness on the 0-10 scale, used for sorting and action-strength
 * mapping. Intentionally does NOT fall back to peakSignalScore10 — peak is what
 * caused the original "backwards" sort bug — and does NOT read
 * displayCurrentScore10 (already path-capped; raw readiness must stay raw). Peak
 * is only surfaced in expanded diagnostics.
 */
export function getRawCurrentReadinessScore10(entry: DisplayContractInput): number | null {
  return (
    normalizeScore10(entry.currentSignalScore10) ??
    normalizeScore10(entry.currentReadinessScore) ??
    normalizeScore10(entry.signalStrengthScore) ??
    null
  );
}

type ActionBand = {
  minPct: number;
  maxPct: number;
  label: DisplayStageLabel;
  subLabel: string;
};

const ACTION_BANDS: Record<LiveHrSectionKey, ActionBand> = {
  attackNow: { minPct: 70, maxPct: 100, label: "TOP WINDOW", subLabel: "Strongest HR window right now" },
  ready: { minPct: 70, maxPct: 100, label: "TOP WINDOW", subLabel: "Strongest HR window right now" },
  building: { minPct: 55, maxPct: 69, label: "ALMOST", subLabel: "Heating up, waiting on confirmation" },
  watch: { minPct: 0, maxPct: 54, label: "WATCHING", subLabel: "Setup is forming, not a play yet" },
};

const clampNumber = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

/**
 * Converts path-capped readiness into a user-facing actionability band.
 *
 * This is intentionally NOT raw readiness.
 *
 * Purpose:
 * - preserve true HR chance separately
 * - preserve raw readiness separately
 * - make actionability visually monotonic by tier
 *
 * WATCHING:   0-54
 * ALMOST:     55-69
 * TOP WINDOW: 70-100
 */
function mapScoreIntoBand(
  score10: number | null,
  sectionKey: LiveHrSectionKey,
): { actionPct: number | null; actionScore10: number | null } {
  const band = ACTION_BANDS[sectionKey];
  // A live row with no score still belongs to its tier — anchor at the floor.
  const sourcePct = score10 == null ? 0 : clampNumber(Math.round(score10 * 10), 0, 100);
  const bandWidth = band.maxPct - band.minPct;
  const actionPct = clampNumber(
    Math.round(band.minPct + (sourcePct / 100) * bandWidth),
    band.minPct,
    band.maxPct,
  );
  return { actionPct, actionScore10: Math.round((actionPct / 10) * 10) / 10 };
}

/**
 * Display-only record eligibility. FIRE-ONLY (2026-06): only a committed FIRE
 * call is part of the official HR record, so only FIRE rows are record-eligible.
 * READY is high-watch context and is intentionally excluded.
 */
function deriveDisplayRecordEligible(entry: DisplayContractInput): boolean {
  return entry.officialSignalStage === "fire";
}

/** Humanize an existing reason string — strips obvious engine-token formatting. */
function cleanReasonText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s
    .replace(/_/g, " ")
    .replace(/\bhr\b/gi, "HR")
    .replace(/\s+/g, " ")
    .trim();
}

/** First user-safe reason from existing evidence only — never fabricated. */
function buildDisplayPrimaryReason(entry: DisplayContractInput): string {
  const candidates = [
    entry.headlineReason,
    ...(entry.supportingReasons ?? []),
    ...(entry.userReasons ?? []),
    ...(entry.whyNowReasons ?? []),
  ];
  for (const candidate of candidates) {
    const clean = cleanReasonText(candidate);
    if (clean) return clean;
  }
  return "HR setup is forming, but the signal is still early.";
}

/**
 * Why a lower-tier card is not (yet) a top-window play. This copy is what
 * reconciles a WATCHING card legitimately showing a HIGHER true HR chance than
 * a TOP WINDOW card — HR chance is truthful; the tier + this line make the
 * decision state unmistakable.
 */
function buildWhyNotTopWindow(
  entry: DisplayContractInput,
  sectionKey: "building" | "watch",
): string {
  if (entry.hasLiveABContext === false || entry.plateAppearancesTracked === 0) {
    return "Waiting for live at-bat evidence before this can become a top-window play.";
  }
  if (entry.isCoolingOff) {
    return "The signal has cooled from its peak, so it is being monitored instead of pushed.";
  }
  if (entry.displayCapReason) {
    return entry.displayCapReason;
  }
  if (entry.displayCapBadgeLabel) {
    return "The engine sees the setup, but capped it below top-window conviction.";
  }
  if (sectionKey === "building") {
    return "Close, but waiting for one more confirmation before this becomes a top-window play.";
  }
  return "Watch only for now — the setup is forming, but it has not confirmed enough for the top window.";
}

/**
 * Build the full display contract for a live ladder entry given its FINAL live
 * section. Action strength composes: raw readiness → existing alert-path
 * conviction cap (displayCurrentScore10) → tier band. HR chance stays uncapped.
 */
export function buildHrRadarDisplayContract(
  entry: DisplayContractInput,
  sectionKey: LiveHrSectionKey,
): HrRadarDisplayContract {
  const band = ACTION_BANDS[sectionKey];
  const rawReadiness10 = getRawCurrentReadinessScore10(entry);
  // displayCurrentScore10 already carries the path conviction cap
  // (e.g. PATH_F_BLOCKED_BRIDGE → 6.0/10). Fall back to raw when absent.
  const pathCapped10 = normalizeScore10(entry.displayCurrentScore10) ?? rawReadiness10;
  const action = mapScoreIntoBand(pathCapped10, sectionKey);

  return {
    displayHrChancePct: normalizeProbabilityPct(entry.conversionProbability),
    displayReadinessScore10: rawReadiness10,
    displayActionScore10: action.actionScore10,
    displayActionPct: action.actionPct,
    displayStageLabel: band.label,
    displayStageSubLabel: band.subLabel,
    displayPrimaryReason: buildDisplayPrimaryReason(entry),
    displayWhyNotTopWindow:
      sectionKey === "attackNow" || sectionKey === "ready"
        ? null
        : buildWhyNotTopWindow(entry, sectionKey),
    displayRecordEligible: deriveDisplayRecordEligible(entry),
  };
}
