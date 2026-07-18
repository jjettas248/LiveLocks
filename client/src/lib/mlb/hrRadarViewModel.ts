// HR Radar — canonical CLIENT view model. PRESENTATION-ONLY, PURE, React-free.
//
// Quick Decide and the Full Ladder both read this one mapper so they can
// never disagree on stage, score, drivers, or CTA. Classification (stage,
// consumer action, canAddToSlip/canWatchNextAb, promotionRequirement) is
// sourced from the server's decision view (shared/hrRadarDecisionView.ts) —
// see `buildConsumerViewModels`. This module NEVER computes an engine score,
// infers a stage from raw stats, derives a probability, or reconstructs
// signal logic; it only reads server-stamped fields (either the decision
// view's consumer fields, or — for the one-time legacy-fallback path when a
// response predates `decisionView` — the older `mapHrRadarRowToDisplayState`
// adapter) and shapes them into what the UI renders (CLAUDE.md §3.3/§3.5/§7.4
// — UI renders engine truth only).

import type { HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";
import {
  mapHrRadarRowToDisplayState,
  type HrRadarRowInput,
} from "@/components/mlb/hrRadarDisplayState";
import { HR_RADAR_BADGE_META, type HrRadarBadge, type HrRadarBadgeTone } from "@shared/hrRadarStage";
import type { HrRadarConsumerEntry, HrRadarDecisionView, HrRadarLiveStage } from "@shared/hrRadarDecisionView";
import {
  HR_RADAR_STAGE_COPY,
  HR_RADAR_RESULT_COPY,
  HR_RADAR_PROMOTION_FALLBACK,
} from "@/components/mlb/hrRadarConsumerCopy";

// A driver chip's label alone lost its meaning (fire/warn/info/good) once it
// left the badge taxonomy — every chip then had to borrow its ROW's stage
// color instead of its own. Carrying tone alongside the label keeps that
// information intact all the way to the renderer.
export interface HrDriverChip {
  label: string;
  tone: HrRadarBadgeTone;
}

// ── The one public ladder, everywhere. ───────────────────────────────────────
export type HrPublicStage = "track" | "build" | "ready" | "fire" | "cashed" | "missed";

/** Mirrors the server's HrRadarConsumerAction — Build/Watch/resolved rows all
 *  get "none" (no primary CTA at all; callers must not render a button). */
export type HrPrimaryCta = "take_now" | "watch_next_ab" | "none";

export interface HrRadarCardViewModel {
  id: string;
  playerId: string;
  gameId: string;
  playerName: string;
  team: string;
  stage: HrPublicStage;
  /** Server-stamped /10 score (read, never computed). */
  score10: number;
  scoreLabel: string;
  /** Server-computed letter grade (stage x score10), read verbatim. */
  displayGrade: string | null;
  /** One-line "why now" — verbatim top server driver. */
  headline: string;
  /** Secondary context line (inning / next-PA), or "". */
  subhead: string;
  /** What the engine is waiting on to advance — anticipation copy. */
  nextEventLabel: string;
  /** ≤3 short, server-stamped trigger chips, each carrying its own tone. */
  driverChips: HrDriverChip[];
  primaryCta: HrPrimaryCta;
  primaryCtaLabel: string;
  /** True only for an official, record-eligible FIRE call. */
  isOfficialCall: boolean;
  /** Eligible to occupy the single Hot Seat (live FIRE/READY). */
  isHeroEligible: boolean;
  isResolved: boolean;
  /** Calibrated HR chance % — FIRE only, else null (gated upstream). */
  hrChancePct: number | null;
  recordEligible: boolean;
  inningLabel: string | null;
  nextPaLabel: string | null;
  /** Server-derived: true only when stage === "fire" && bet-payload valid. */
  canAddToSlip: boolean;
  /** Server-derived: true only when stage === "ready". */
  canWatchNextAb: boolean;
  /** What's needed to promote this row, verbatim from the server when
   *  supplied, else a stage-safe fallback. Null for Fire/resolved rows. */
  promotionRequirement: string | null;
  /** Higher = more important. Stage dominates, then score, then momentum/urgency. */
  sortRank: number;
  /** Raw entry passed through for the diagnostic drawer (admin/debug detail). */
  entry: HrRadarLadderEntry;
}

const STAGE_WEIGHT: Record<HrPublicStage, number> = {
  fire: 5,
  ready: 4,
  build: 3,
  track: 2,
  cashed: 1,
  missed: 0,
};

function lower(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

// Outcomes that mean the called signal CASHED (HR landed after a call). Anything
// else resolved is a miss. Read from the server outcome, never re-derived.
// Used only by the legacy fallback path (no decisionView available).
const CASHED_OUTCOMES = new Set([
  "called_hit",
  "called_hit_attack",
  "called_hit_ready",
  "called_hit_build",
  "called_hit_watch",
  "called_near_hr",
]);

function isCashedOutcome(entry: HrRadarLadderEntry): boolean {
  const o = lower(entry.outcome) || lower(entry.outcomeStatus);
  return CASHED_OUTCOMES.has(o);
}

// Map the canonical live user-stage onto the public ladder. Resolved rows are
// split into cashed/missed by the server outcome (or an explicit section hint).
// LEGACY FALLBACK ONLY — used when a ladder response predates `decisionView`.
function legacyPublicStage(
  stage: HrRadarRowInput["userStage"],
  entry: HrRadarLadderEntry,
  sectionHint?: "cashed" | "missed",
): HrPublicStage {
  const s = lower(stage);
  if (s === "resolved") {
    if (sectionHint) return sectionHint;
    return isCashedOutcome(entry) ? "cashed" : "missed";
  }
  if (s === "fire" || s === "ready" || s === "build" || s === "track") return s as HrPublicStage;
  return "track";
}

interface Classification {
  stage: HrPublicStage;
  primaryCta: HrPrimaryCta;
  isResolved: boolean;
  canAddToSlip: boolean;
  canWatchNextAb: boolean;
  promotionRequirement: string | null;
  isOfficialCall: boolean;
  recordEligible: boolean;
}

function publicStageFromLiveStage(liveStage: HrRadarLiveStage): HrPublicStage {
  if (liveStage === "watch") return "track";
  return liveStage ?? "track";
}

/** Classification sourced from the server's decision view — the normal path. */
function classifyFromConsumer(consumer: HrRadarConsumerEntry<HrRadarLadderEntry>): Classification {
  let stage: HrPublicStage;
  if (consumer.isResolved) {
    stage = consumer.resultType === "signal_hit" ? "cashed" : "missed";
  } else {
    stage = publicStageFromLiveStage(consumer.liveStage);
  }
  return {
    stage,
    primaryCta: consumer.consumerAction,
    isResolved: consumer.isResolved,
    canAddToSlip: consumer.canAddToSlip,
    canWatchNextAb: consumer.canWatchNextAb,
    promotionRequirement: consumer.promotionRequirement,
    isOfficialCall: !consumer.isResolved && consumer.liveStage === "fire" && consumer.hasFireCommitment,
    recordEligible: consumer.hasFireCommitment,
  };
}

/**
 * LEGACY FALLBACK classification — used only when a ladder response has no
 * `decisionView` (an old service-worker-cached API response, or a rollback).
 * Mirrors the server's own rules (Fire-only slip access, Ready-only watch)
 * so behavior matches even without the authoritative contract; emits one
 * bounded diagnostic via the caller (see hrRadarDecisionViewFallback below)
 * rather than silently reintroducing per-component count math.
 */
function classifyLegacy(
  d: ReturnType<typeof mapHrRadarRowToDisplayState>,
  entry: HrRadarLadderEntry,
  sectionHint?: "cashed" | "missed",
): Classification {
  const stage = legacyPublicStage(d.userStage, entry, sectionHint);
  const isResolved = stage === "cashed" || stage === "missed";
  const primaryCta: HrPrimaryCta =
    stage === "fire" && !isResolved ? "take_now" : stage === "ready" && !isResolved ? "watch_next_ab" : "none";
  const hasValidIdentity = Boolean(entry.playerId && entry.playerName && entry.gameId);
  const promotionRequirement =
    !isResolved && (stage === "ready" || stage === "build" || stage === "track")
      ? (d.nextEscalation ?? HR_RADAR_PROMOTION_FALLBACK[stage === "track" ? "watch" : stage])
      : null;
  return {
    stage,
    primaryCta,
    isResolved,
    canAddToSlip: stage === "fire" && !isResolved && hasValidIdentity,
    canWatchNextAb: stage === "ready" && !isResolved,
    promotionRequirement,
    isOfficialCall: d.isOfficialCall,
    recordEligible: d.recordEligible,
  };
}

let fallbackWarned = false;
/** Emits `[HR_RADAR_DECISION_VIEW_FALLBACK]` once per session, not per-render. */
function warnFallbackOnce(): void {
  if (fallbackWarned) return;
  fallbackWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[HR_RADAR_DECISION_VIEW_FALLBACK] ladder response has no decisionView — using the legacy client adapter. " +
    "This should be transient during rollout; if it persists, the server is not stamping decisionView.",
  );
}

// Build ≤3 short trigger chips from server-stamped evidence ONLY — the badge
// taxonomy first (already short, e.g. "NEAR HR", "PITCHER FATIGUE"), then a few
// reformat-only chips for pregame power and live contact. Never invents a tag.
// Formal badges keep their own tone (HR_RADAR_BADGE_META); the reformat-only
// chips aren't part of that taxonomy so they get a neutral "info" tone.
export function buildDriverChips(entry: HrRadarLadderEntry, drivers: string[]): HrDriverChip[] {
  const chips: HrDriverChip[] = [];
  const seen = new Set<string>();
  const push = (label: string, tone: HrRadarBadgeTone) => {
    const key = label.toUpperCase();
    if (!seen.has(key) && chips.length < 3) {
      seen.add(key);
      chips.push({ label: key, tone });
    }
  };

  for (const b of entry.badges ?? []) {
    const meta = HR_RADAR_BADGE_META[b as HrRadarBadge];
    if (meta) push(meta.label, meta.tone);
  }
  if (entry.pregamePowerTarget || entry.pregameSeedTier) push("PREGAME STRONG", "info");

  // Reformat-only: surface a couple of recognizable phrases already present in
  // the server drivers as compact chips (display formatting, not invention).
  for (const d of drivers) {
    const t = d.toLowerCase();
    if (t.includes("live contact")) push("LIVE CONTACT", "info");
    else if (t.includes("hard-hit") || t.includes("hard hit") || t.includes("barrel")) push("HARD CONTACT", "info");
    else if (t.includes("climb")) push("SIGNAL CLIMBING", "info");
  }
  return chips.slice(0, 3);
}

function nextEventFor(stage: HrPublicStage, nextEscalation: string | null): string {
  switch (stage) {
    case "fire":
      return "Live call active — act now.";
    case "ready":
    case "build":
    case "track":
      return nextEscalation ?? "";
    default:
      return "";
  }
}

function formatNextPa(entry: HrRadarLadderEntry): string | null {
  if (entry.nextAbEstimate) return entry.nextAbEstimate;
  const pa = entry.remainingPAExpectation;
  if (pa != null && pa > 0) {
    return `~${pa < 1 ? pa.toFixed(1) : Math.round(pa)} PA left`;
  }
  return null;
}

// ── Cross-tier priority fine-tuning. Stage dominates sortRank by a full 100
// points (see STAGE_WEIGHT), so these bonuses — capped well under that gap —
// can only ever break ties WITHIN a stage or across near-identical stages;
// they can never lift a TRACK row above a BUILD row's worst case, let alone
// above READY/FIRE. Presentation-only re-ranking of server-stamped fields —
// no engine/probability recompute (CLAUDE.md §3.3 Hard Rule 5).
function momentumBonus(entry: HrRadarLadderEntry): number {
  switch (entry.momentumLabel) {
    case "heating_up": return 1.5;
    case "holding_strong": return 0.3;
    case "cooling_off": return -1;
    default: return 0;
  }
}

function urgencyBonus(entry: HrRadarLadderEntry): number {
  let bonus = 0;
  const pa = entry.remainingPAExpectation;
  if (pa != null) {
    if (pa <= 1) bonus += 1;
    else if (pa <= 2) bonus += 0.5;
  }
  const inn = entry.currentInning ?? entry.detectedInning ?? null;
  if (inn != null) {
    if (inn >= 8) bonus += 0.5;
    else if (inn >= 7) bonus += 0.25;
  }
  return bonus;
}

/** Short, human "why it's ranked here" line for the top-priority callout. */
function priorityReasonFor(entry: HrRadarLadderEntry): string | null {
  const parts: string[] = [];
  if (entry.momentumLabel === "heating_up") parts.push("heating up");
  else if (entry.momentumLabel === "holding_strong") parts.push("holding strong");
  const pa = entry.remainingPAExpectation;
  const inn = entry.currentInning ?? entry.detectedInning ?? null;
  if (pa != null && pa <= 1) parts.push("~1 PA left");
  else if (inn != null && inn >= 8) parts.push("late innings");
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Map one server HR Radar row → display view model.
 *
 * `opts.consumer` — the matching `HrRadarConsumerEntry` from
 * `decisionView.entries[entryId]`. This is the NORMAL path: stage, CTA,
 * canAddToSlip/canWatchNextAb, and promotionRequirement all come verbatim
 * from the server. `opts.sectionHint` is legacy-fallback-only.
 */
export function buildHrRadarCardViewModel(
  entry: HrRadarLadderEntry,
  opts: { sectionHint?: "cashed" | "missed"; consumer?: HrRadarConsumerEntry<HrRadarLadderEntry> } = {},
): HrRadarCardViewModel {
  const d = mapHrRadarRowToDisplayState(entry as unknown as HrRadarRowInput);
  if (!opts.consumer) warnFallbackOnce();
  const classification = opts.consumer
    ? classifyFromConsumer(opts.consumer)
    : classifyLegacy(d, entry, opts.sectionHint);
  const { stage, primaryCta, isResolved, canAddToSlip, canWatchNextAb, promotionRequirement, isOfficialCall, recordEligible } = classification;

  const score10 = d.displayScore10 ?? 0;
  const drivers = d.drivers;
  const headline = drivers[0] ?? d.actionStrengthLabel;
  const subhead = drivers[1] ?? "";
  const primaryCtaLabel =
    primaryCta === "take_now" ? "Take Now" : primaryCta === "watch_next_ab" ? "Watch Next AB" : "";

  return {
    id: `${entry.playerId}|${entry.gameId}`,
    playerId: entry.playerId,
    gameId: entry.gameId,
    playerName: entry.playerName,
    team: entry.team ?? "",
    stage,
    score10,
    scoreLabel: score10.toFixed(1),
    displayGrade: d.displayGrade,
    headline,
    subhead,
    nextEventLabel: nextEventFor(stage, d.nextEscalation),
    driverChips: buildDriverChips(entry, drivers),
    primaryCta,
    primaryCtaLabel,
    isOfficialCall,
    isHeroEligible: !isResolved && (stage === "fire" || stage === "ready"),
    isResolved,
    hrChancePct: stage === "fire" ? d.hrChancePct : null,
    recordEligible,
    inningLabel: d.inningLabel,
    nextPaLabel: formatNextPa(entry),
    canAddToSlip,
    canWatchNextAb,
    promotionRequirement,
    // Stage bucket (×100) dominates; score is the primary in-tier ranking;
    // momentum/urgency are small tie-breakers so a heating-up, almost-out-of-
    // PAs signal edges out a flatter same-tier peer with an identical score.
    // Skipped for resolved (cashed/missed) rows — they no longer have a "live"
    // trajectory to break ties on.
    sortRank: STAGE_WEIGHT[stage] * 100 + score10 + (isResolved ? 0 : momentumBonus(entry) + urgencyBonus(entry)),
    entry,
  };
}

/**
 * Build view models for a list of `entryId`s from the decision view — the
 * standard way both Quick Decide and the Full Ladder should read a
 * `decisionView.groups.*` array. Skips any id that isn't present in
 * `entries` (should not happen; the decision view guarantees referential
 * integrity, but this stays defensive).
 */
export function buildConsumerViewModels(
  decisionView: HrRadarDecisionView<HrRadarLadderEntry> | null | undefined,
  entryIds: readonly string[],
): HrRadarCardViewModel[] {
  if (!decisionView) return [];
  const out: HrRadarCardViewModel[] = [];
  for (const id of entryIds) {
    const consumer = decisionView.entries[id];
    if (!consumer) continue;
    out.push(buildHrRadarCardViewModel(consumer.source, { consumer }));
  }
  return out;
}

/** Public stage → display label (the one vocabulary, hrRadarConsumerCopy.ts). */
export const HR_PUBLIC_STAGE_LABEL: Record<HrPublicStage, string> = {
  track: HR_RADAR_STAGE_COPY.watch.short,
  build: HR_RADAR_STAGE_COPY.build.short,
  ready: HR_RADAR_STAGE_COPY.ready.short,
  fire: HR_RADAR_STAGE_COPY.fire.short,
  cashed: HR_RADAR_RESULT_COPY.signal_hit.short,
  missed: HR_RADAR_RESULT_COPY.official_miss.short,
};

/** Sort live cards by importance (stage, then score) — highest first. */
export function compareByImportance(a: HrRadarCardViewModel, b: HrRadarCardViewModel): number {
  return b.sortRank - a.sortRank;
}

/**
 * Hot Seat selection — pure. Given the active (non-resolved, user-filtered) live
 * cards, pick the single Hero (highest FIRE, else highest READY) and the next
 * ≤5 Decision Queue cards. TRACK is hidden from the queue unless nothing higher
 * exists anywhere (so a quiet slate still shows what's forming). Extracted here
 * so the selection rules are unit-testable without rendering.
 */
export function selectQuickDecide(vms: HrRadarCardViewModel[]): {
  hero: HrRadarCardViewModel | null;
  queue: HrRadarCardViewModel[];
} {
  const sorted = [...vms].sort(compareByImportance);
  const hero = sorted.find((v) => v.isHeroEligible) ?? null;
  const rest = sorted.filter((v) => v.id !== hero?.id);
  const hasHigherThanTrack = sorted.some((v) => v.stage !== "track");
  const queue = rest.filter((v) => v.stage !== "track" || !hasHigherThanTrack).slice(0, 5);
  return { hero, queue };
}

/**
 * Full Ladder — cross-tier priority pick. Unlike `selectQuickDecide`'s hero
 * (FIRE/READY only), this blends EVERY live tier (FIRE/READY/BUILD/TRACK)
 * into one ranked feed via `sortRank` (stage → score → momentum/urgency), so
 * on a slate with no FIRE yet the single best BUILD/TRACK play is still
 * unmistakably called out as the board's #1 — not just #1 inside its own
 * section. The Full Ladder stays grouped by section visually; this only
 * identifies which one card earns the "top priority" callout/ribbon.
 */
export function selectTopPriority(vms: HrRadarCardViewModel[]): HrRadarCardViewModel | null {
  const live = vms.filter((v) => !v.isResolved);
  if (live.length === 0) return null;
  return [...live].sort(compareByImportance)[0];
}

/** Short "why it's #1" line for the top-priority callout — verbatim from
 * already-derived server fields (momentum, remaining PAs, inning); never
 * invents a reason. Falls back to the stage label alone when neither signal
 * is present. */
export function topPriorityReasonLabel(vm: HrRadarCardViewModel): string {
  const reason = priorityReasonFor(vm.entry);
  const stageLabel = HR_PUBLIC_STAGE_LABEL[vm.stage];
  return reason ? `${stageLabel} · ${reason}` : stageLabel;
}
