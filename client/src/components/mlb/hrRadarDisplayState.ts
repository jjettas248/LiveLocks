// HR Radar — canonical CLIENT display-state mapper (presentation-only, PURE).
//
// Why this exists: Quick Decide and the Full Ladder each used to derive their
// own sections, score formatting, and admin gating. They drifted — Quick Decide
// could say "No live HR calls" while the Watchlist showed a player at "95%",
// and a raw 0-100 readiness score leaked into the UI as a percent. This module
// is the SINGLE source of truth both surfaces read so they can never disagree.
//
// Hard contract (CLAUDE.md §3.3, §7.4):
//   - It NEVER recomputes engine probability, readiness, confidence, or tier.
//   - It only READS server-stamped fields and formats them for display.
//   - It is React-free and DB-free so it is unit-testable with `npx tsx`.

// ── Canonical user-facing sections ──────────────────────────────────────────
// Live decision sections (top-down by conviction) + resolved + admin-only.
export type HrRadarUserSection =
  | "fire" // LIVE CALL — official, actionable, counts toward the record
  | "ready" // READY — high-conviction setup, NOT an official call yet
  | "watching" // WATCHING — developing setup with real evidence (build)
  | "developing" // DEVELOPING — earliest formation (track)
  | "resolved" // RESOLVED — cashed / missed official call
  | "noAbYet" // admin/devtools — live game, no plate appearance yet
  | "modelReview"; // admin/devtools — uncalled / calibration buckets

export const ADMIN_ONLY_SECTIONS: ReadonlySet<HrRadarUserSection> = new Set<HrRadarUserSection>([
  "noAbYet",
  "modelReview",
]);

export type CanonicalUserStage = "track" | "build" | "ready" | "fire" | "resolved";

// True calibrated single-game HR probability never approaches readiness/score
// magnitudes. A "95" surfacing as a percent is a raw readiness/score leak, not
// a probability. Anything above this ceiling is rejected as "not a calibrated
// HR probability" so the UI falls back to the /10 score instead of a misleading
// "95% HR chance". Elite real-world HR probabilities top out well under this.
export const CALIBRATED_HR_PROB_CEILING_PCT = 60;

// Structural view of a ladder row — kept local so this module has no import
// cycle with HrRadarLadder.tsx (which owns the full HrRadarLadderEntry type).
// Every field optional/permissive: rows arrive from several server versions.
export interface HrRadarRowInput {
  playerId?: string;
  playerName?: string;
  team?: string | null;
  gameId?: string;
  // Stage / lifecycle signals (server-stamped).
  userStage?: string | null;
  officialSignalStage?: string | null;
  // Legacy canonical-entity stage ("watch"|"building"|"attack"|"cooling"|"closed").
  // Older/cached rows may carry this without a `userStage`.
  currentStage?: string | null;
  state?: string | null;
  stageLabel?: string | null;
  currentStatus?: string | null;
  outcome?: string | null;
  outcomeStatus?: string | null;
  isGameFinal?: boolean | null;
  hasLiveABContext?: boolean | null;
  plateAppearancesTracked?: number | null;
  // Server-computed letter grade (stage x displayCurrentScore10). Passed
  // through verbatim — this module never derives a grade from stage/score.
  displayGrade?: string | null;
  // Score fields (0-10 preferred, 0-100 readiness fallback).
  displayCurrentScore10?: number | null;
  currentSignalScore10?: number | null;
  displayReadinessScore10?: number | null;
  currentReadinessScore?: number | null;
  signalStrengthScore?: number | null;
  peakSignalScore10?: number | null;
  peakReadinessScore?: number | null;
  peakScore?: number | null;
  buildScore?: number | null;
  pitcherHrVulnerability?: number | null;
  // Probability (true calibrated HR chance only).
  displayHrChancePct?: number | null;
  conversionProbability?: number | null;
  // Explainability.
  cleanReasons?: string[] | null;
  supportingReasons?: string[] | null;
  userReasons?: string[] | null;
  whyNowReasons?: string[] | null;
  headlineReason?: string | null;
  displayPrimaryReason?: string | null;
  stageDescription?: string | null;
  // Timing context.
  currentInning?: number | null;
  detectedInning?: number | null;
  detectedHalf?: string | null;
  remainingPAExpectation?: number | null;
}

// ── Score helpers — formatting only, never recompute. ───────────────────────

/** Normalize any score to the 0-10 scale (one decimal), or null. Values >10 are
 *  treated as a 0-100 readiness scale and divided down. Guards null/"" first so
 *  a missing value never coerces to a false 0. */
export function toScore10(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const s = n > 10 ? n / 10 : n;
  return Math.max(0, Math.min(10, Math.round(s * 10) / 10));
}

/** Canonical user-facing /10 score. Prefers the conviction-aware display score
 *  so the number matches the section the engine assigned, then raw signal /10,
 *  then 0-100 readiness mirrors. Mirrors hrRadarScore.hrEntryCurrentScore10. */
export function deriveDisplayScore10(row: HrRadarRowInput): number | null {
  return (
    toScore10(row.displayCurrentScore10) ??
    toScore10(row.currentSignalScore10) ??
    toScore10(row.displayReadinessScore10) ??
    toScore10(row.currentReadinessScore) ??
    toScore10(row.signalStrengthScore) ??
    toScore10(row.peakSignalScore10) ??
    toScore10(row.peakReadinessScore) ??
    toScore10(row.peakScore) ??
    null
  );
}

/** "9.5/10" — the only sanctioned headline number for a non-official setup. */
export function formatScore10Label(score10: number | null): string | null {
  if (score10 == null) return null;
  return `${score10.toFixed(1)}/10`;
}

/**
 * The TRUE calibrated HR probability as a whole percent — or null when the
 * available field is not a plausible calibrated probability (e.g. a raw 0-100
 * readiness/score that would otherwise render as a misleading "95%").
 *
 * Accepts the engine's 0-1 convention and a server-stamped 0-100 percent, but
 * REJECTS anything above CALIBRATED_HR_PROB_CEILING_PCT — those are score/
 * readiness leaks, not probabilities. This is what stops "95%" watchlist labels.
 */
export function deriveCalibratedHrChancePct(row: HrRadarRowInput): number | null {
  const candidate = row.displayHrChancePct ?? row.conversionProbability;
  if (candidate == null || candidate === ("" as unknown)) return null;
  const n = Number(candidate);
  if (!Number.isFinite(n)) return null;
  let pct: number;
  if (n >= 0 && n <= 1) pct = Math.round(n * 100); // 0-1 probability
  else if (n > 1 && n <= 100) pct = Math.round(n); // already a percent
  else return null; // out of any sane range
  if (pct < 0 || pct > CALIBRATED_HR_PROB_CEILING_PCT) return null;
  return pct;
}

// ── HR breakdown bars (expanded panel) — gated, presentation-only. ──────────
// The expanded Full Ladder breakdown used to render every metric on a raw
// 0-100 scale, so a readiness/conviction value of 95 read as "95". This builder
// is the single gated source: the HR-chance bar is the ONLY bar allowed to be a
// percent and it MUST pass deriveCalibratedHrChancePct (a raw readiness/score
// leak is rejected → the bar is omitted). Every other metric is emitted on the
// /10 signal-score scale so no raw 0-100 value can surface as "95%".
export type HrBreakdownUnit = "pct" | "score10";

export interface HrRadarBreakdownBar {
  key: string;
  label: string;
  short: string;
  /** Display value in its unit: pct → 0-100, score10 → 0-10. */
  value: number;
  unit: HrBreakdownUnit;
  /** 0-100 magnitude used for the bar fill width + color band. */
  magnitude: number;
  /** Only the calibrated HR-chance bar is the true HR probability. */
  isHrProb: boolean;
}

export function buildHrRadarBreakdownBars(row: HrRadarRowInput): HrRadarBreakdownBar[] {
  const bars: HrRadarBreakdownBar[] = [];
  const form = toScore10(row.buildScore);
  if (form != null) {
    bars.push({ key: "form", label: "Formation", short: "FORM", value: form, unit: "score10", magnitude: Math.round(form * 10), isHrProb: false });
  }
  const rdy = toScore10(row.currentReadinessScore);
  if (rdy != null) {
    bars.push({ key: "rdy", label: "Readiness", short: "RDY", value: rdy, unit: "score10", magnitude: Math.round(rdy * 10), isHrProb: false });
  }
  // HR chance — the ONLY percent bar, and only when it is a calibrated
  // probability. A leaked readiness/score (e.g. 95) fails the gate → omitted.
  const hr = deriveCalibratedHrChancePct(row);
  if (hr != null) {
    bars.push({ key: "hr", label: "HR Chance", short: "HR%", value: hr, unit: "pct", magnitude: hr, isHrProb: true });
  }
  const pvul = toScore10(row.pitcherHrVulnerability);
  if (pvul != null) {
    bars.push({ key: "pvul", label: "Pitcher Vuln", short: "PVUL", value: pvul, unit: "score10", magnitude: Math.round(pvul * 10), isHrProb: false });
  }
  return bars;
}

/** Format a breakdown bar's value for display. ONLY the gated HR-chance bar
 *  (unit "pct") may render a "%"; every other bar renders on the /10 scale. */
export function formatBreakdownBarValue(bar: HrRadarBreakdownBar): string {
  return bar.unit === "pct" ? `${bar.value}%` : bar.value.toFixed(1);
}

// ── Stage + section derivation (single source of truth). ────────────────────

const RESOLVED_OUTCOMES: ReadonlySet<string> = new Set([
  "called_hit",
  "called_hit_attack",
  "called_hit_ready",
  "called_hit_build",
  "called_hit_watch",
  "called_near_hr",
  "called_miss",
  "miss",
  "missed",
  "uncalled_hr",
  "late_signal",
  "early_window_hr",
  "early_hr_no_window",
  "early_hr_insufficient_sample",
  "expired",
]);

const ADMIN_ONLY_OUTCOMES: ReadonlySet<string> = new Set([
  "uncalled_hr",
  "early_hr_insufficient_sample",
  "early_hr_no_window",
]);

function lower(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

/**
 * Canonical user stage for a row. Strict priority: resolved → fire → ready →
 * build → track. Reads the server's `userStage` first, then falls back to
 * official/lifecycle signals so older payloads (no userStage) still map.
 */
export function deriveUserStage(row: HrRadarRowInput): CanonicalUserStage {
  const outcome = lower(row.outcome) || lower(row.outcomeStatus);
  if (
    lower(row.currentStatus) === "resolved" ||
    (outcome && RESOLVED_OUTCOMES.has(outcome))
  ) {
    return "resolved";
  }

  const stage = lower(row.userStage);
  if (stage === "resolved") return "resolved";
  if (stage === "fire") return "fire";

  // Official FIRE / BET_NOW commitment is always a fire-level call.
  if (lower(row.officialSignalStage) === "fire") return "fire";
  if (lower(row.state) === "bet_now" || lower(row.stageLabel) === "bet_now") return "fire";

  if (stage === "ready") return "ready";
  if (stage === "build" || stage === "building") return "build";
  if (stage === "track" || stage === "watch") return "track";

  // Legacy rows with no `userStage`: fall back to the canonical entity stage so
  // an older/cached FIRE row (currentStage="attack") still lands in fire and
  // keeps its Live Call / Take-Pass treatment instead of decaying to track.
  const cs = lower(row.currentStage);
  if (cs === "attack") return "fire";
  if (cs === "building") return "build";
  if (cs === "watch" || cs === "cooling") return "track";
  if (cs === "closed") return "resolved";

  // Last resort: legacy lifecycle `state`.
  const state = lower(row.state);
  if (state.includes("ready")) return "ready";
  if (state.includes("build")) return "build";
  return "track";
}

/** Map a canonical user stage to its user-facing section. */
export function userSectionForStage(stage: CanonicalUserStage): HrRadarUserSection {
  switch (stage) {
    case "fire":
      return "fire";
    case "ready":
      return "ready";
    case "build":
      return "watching";
    case "track":
      return "developing";
    case "resolved":
      return "resolved";
  }
}

/**
 * A row with no live at-bat yet — a pregame "power profile" seed or a live game
 * where the player hasn't batted. The engine necessarily scores these 0/pregame,
 * so they flood the live decision sections with near-identical generic rows.
 * Both the Full Ladder and Quick Decide hide them until the player actually bats
 * (resolved rows are never pregame). Single source of truth so the two surfaces
 * can't drift.
 */
export function isPregameOnlyRow(row: HrRadarRowInput): boolean {
  if (deriveUserStage(row) === "resolved") return false;
  return (row.plateAppearancesTracked ?? 0) === 0;
}

// ── Reason / driver formatting. ─────────────────────────────────────────────
// The server already strips most engine jargon; this is a final, light polish
// so a stale SCREAMING_CASE / snake_case token still reads as plain English.
// It NEVER invents a driver — it only formats existing evidence strings.
function isUserSafeReason(s: string): boolean {
  const t = s.trim();
  if (/^(PATH[_ ]?[A-Z0-9_]+|WATCH:|BUILD:|FORM:|PRE[_ ]HR[_ ]DANGER|HrShaped|BsZ|Score\d|Conv\s+\d+%|Profile\d|Danger\d)/i.test(t)) return false;
  // FSM / prob-rail promotion reason codes that leak as a "reason".
  if (/(prob[_ ]?rail|bet[_ ]?now|dynamic_|pitcher_fade|attack_sustained|_sustained|_awaiting)/i.test(t)) return false;
  // Bare engine identifier code: lowercase snake_case / colon-joined, no spaces.
  if (/^[a-z][a-z0-9]*([_:][a-z0-9]+)+$/.test(t)) return false;
  return true;
}

function humanizeReason(s: string): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed) return trimmed;
  // Only transform space-free single tokens; real multi-word copy is left as-is.
  if (!/\s/.test(trimmed) && (/^[A-Z0-9_]+$/.test(trimmed) || /[_:]/.test(trimmed))) {
    return trimmed
      .replace(/[_:]/g, " ")
      .toLowerCase()
      .replace(/^\w/, (c) => c.toUpperCase());
  }
  return trimmed;
}

/** Top 2-4 human-readable drivers from existing server evidence only. */
export function deriveDrivers(row: HrRadarRowInput, max = 4): string[] {
  const source =
    (row.cleanReasons && row.cleanReasons.length ? row.cleanReasons : null) ??
    (row.supportingReasons && row.supportingReasons.length ? row.supportingReasons : null) ??
    (row.userReasons && row.userReasons.length ? row.userReasons : null) ??
    (row.whyNowReasons && row.whyNowReasons.length ? row.whyNowReasons : null) ??
    [];
  const headline = row.headlineReason ? [row.headlineReason] : [];
  const all = [...headline, ...source];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    if (typeof raw !== "string") continue;
    if (!isUserSafeReason(raw)) continue;
    const clean = humanizeReason(raw);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

// Per-stage escalation hint. This is static UI copy keyed off the stage, NOT a
// recomputed probability or threshold — it tells the user what the engine is
// waiting on to promote the row.
const NEXT_ESCALATION: Record<CanonicalUserStage, string | null> = {
  track: "Tracking — needs harder contact and a confirming swing to develop.",
  build: "Developing — one more barrel / hard fly can push this to READY.",
  ready: "High-conviction setup — one more barrel / hard fly becomes a LIVE CALL.",
  fire: null,
  resolved: null,
};

const ACTION_STRENGTH_LABEL: Record<CanonicalUserStage, string> = {
  fire: "Live call",
  ready: "Strong setup",
  build: "Developing setup",
  track: "Early formation",
  resolved: "Resolved",
};

function formatInning(inning: number | null | undefined, half?: string | null): string | null {
  if (inning == null) return null;
  const h = lower(half);
  const prefix = h.startsWith("b") ? "B" : h.startsWith("t") ? "T" : "T";
  return `${prefix}${inning}`;
}

export interface HrRadarDisplayState {
  playerId: string;
  playerName: string;
  team: string | null;
  gameId: string;
  userStage: CanonicalUserStage;
  /** Canonical user-facing section (live decision surface). */
  section: HrRadarUserSection;
  /** True when this section must be hidden from non-admin users. */
  isAdminOnly: boolean;
  /** True when this row is an official, record-eligible FIRE call. */
  isOfficialCall: boolean;
  recordEligible: boolean;
  /** Canonical /10 score (0.0-10.0) — the sanctioned headline number. */
  displayScore10: number | null;
  /** "9.5/10" or null. */
  scoreLabel: string | null;
  /**
   * Server-computed letter grade, read verbatim (never re-derived here).
   * Null for resolved rows or when the server hasn't stamped one yet.
   */
  displayGrade: string | null;
  /** Human action-strength label ("Strong setup", "Live call", …). */
  actionStrengthLabel: string;
  /**
   * Calibrated HR probability as a whole percent, or null. NULL means "do not
   * render a percent" — the UI must fall back to the /10 score. This is the
   * gate that prevents raw readiness (e.g. 95) rendering as "95%".
   */
  hrChancePct: number | null;
  /** Top 2-4 human-readable drivers (verbatim server evidence, formatted). */
  drivers: string[];
  /** What the engine is waiting on to promote this row, or null. */
  nextEscalation: string | null;
  /** "T4" style inning context, or null. */
  inningLabel: string | null;
}

/**
 * Canonical row → display state. The ONLY mapper both Quick Decide and the Full
 * Ladder use. Pass the viewer's admin flag; admin-only sections still map but
 * are flagged `isAdminOnly` so non-admin surfaces can drop them.
 */
export function mapHrRadarRowToDisplayState(
  row: HrRadarRowInput,
  isAdmin = false,
): HrRadarDisplayState {
  const stage = deriveUserStage(row);
  let section = userSectionForStage(stage);

  // Admin re-shelving: resolved calibration/uncalled buckets and live-but-no-AB
  // parking rows are surfaced only to admins. (Non-admins get a cleaner view;
  // they are still mapped so admin tooling can show them.)
  const outcome = lower(row.outcome) || lower(row.outcomeStatus);
  if (stage === "resolved" && ADMIN_ONLY_OUTCOMES.has(outcome)) {
    section = "modelReview";
  } else if (
    section !== "resolved" &&
    row.hasLiveABContext === true &&
    (row.plateAppearancesTracked ?? 0) === 0
  ) {
    section = "noAbYet";
  }

  const isAdminOnly = ADMIN_ONLY_SECTIONS.has(section);
  const isOfficialCall = stage === "fire" && lower(row.officialSignalStage) === "fire";
  const displayScore10 = deriveDisplayScore10(row);
  const hrChancePct = deriveCalibratedHrChancePct(row);

  return {
    playerId: String(row.playerId ?? ""),
    playerName: String(row.playerName ?? ""),
    team: row.team ?? null,
    gameId: String(row.gameId ?? ""),
    userStage: stage,
    section,
    isAdminOnly,
    isOfficialCall,
    recordEligible: lower(row.officialSignalStage) === "fire",
    displayScore10,
    scoreLabel: formatScore10Label(displayScore10),
    displayGrade: row.displayGrade ?? null,
    actionStrengthLabel: ACTION_STRENGTH_LABEL[stage],
    hrChancePct,
    drivers: deriveDrivers(row),
    nextEscalation: NEXT_ESCALATION[stage],
    inningLabel: formatInning(row.currentInning ?? row.detectedInning, row.detectedHalf),
  };

  // Note: `isAdmin` is accepted for API symmetry / future per-viewer copy. The
  // section it returns is viewer-independent (the same canonical mapping for
  // everyone); callers use `isAdminOnly` to decide what to render.
}
