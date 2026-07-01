import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Flame, Zap, Eye, Trophy, XCircle, Plus, AlertTriangle, RefreshCw, Eraser, X, ArrowRight, Clock, DollarSign, Share2, Target } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AbLogRows, abChipSummary, type AbRow } from "@/components/mlb/AbLogRows";
import { hrEntryCurrentScore10, hrEntryInitialScore10, hrEntryPeakScore10, hrEntryActionPct, hrEntryActionScore10 } from "@/components/mlb/hrRadarScore";
import { deriveCalibratedHrChancePct, buildHrRadarBreakdownBars, formatBreakdownBarValue, isPregameOnlyRow, mapHrRadarRowToDisplayState, type HrRadarRowInput } from "@/components/mlb/hrRadarDisplayState";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { getMlbInningWindow, getMlbInningWindowLabel, type MlbInningWindow } from "@shared/mlbInningWindow";
import { type HrRadarBadge } from "@shared/hrRadarStage";
import { buildHrRadarCardViewModel, buildDriverChips, type HrRadarCardViewModel } from "@/lib/mlb/hrRadarViewModel";
import { HrRadarFullLadderTable } from "@/components/mlb/hr-radar/HrRadarFullLadderTable";
import { hrTierTheme, TierRail, tierFromLadderSection, badgeToneClasses } from "@/components/mlb/hrRadarVisuals";

// ── Signal-first inning pill (LiveLocks MLB UX Phase 1) ───────────────
// Pure read of the row's currentInning (preferred) or detectedInning.
// Surfacing-only — does NOT change ladder thresholds, sectioning, or scoring.
const HR_INNING_WINDOW_PILL: Record<MlbInningWindow, { label: string; color: string }> = {
  late:    { label: "Late attack",    color: "#ef4444" },
  early:   { label: "Early build",    color: "#a78bfa" },
  mid:     { label: "Mid watch",      color: "#94a3b8" },
  unknown: { label: "Unknown inning", color: "#64748b" },
  all:     { label: "",               color: "#94a3b8" },
};

// Task #121 Step 3 — per-session dismiss + accept lists. Both keyed by
// sessionDate so tomorrow's session starts clean. Pass = dismissed (hidden).
// Take-it = accepted (kept visible with an "Accepted" badge so the user can
// see they already acted on it across page refreshes within the same day).
function dismissStorageKey(sessionDate: string): string {
  return `hr-radar-pass:${sessionDate}`;
}
function acceptStorageKey(sessionDate: string): string {
  return `hr-radar-accept:${sessionDate}`;
}
function readSessionSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}
function writeSessionSet(key: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    // Storage quota / private mode — best effort, ignore.
  }
}
function readDismissed(sessionDate: string): Set<string> {
  return readSessionSet(dismissStorageKey(sessionDate));
}
function writeDismissed(sessionDate: string, set: Set<string>): void {
  writeSessionSet(dismissStorageKey(sessionDate), set);
}
function readAccepted(sessionDate: string): Set<string> {
  return readSessionSet(acceptStorageKey(sessionDate));
}
function writeAccepted(sessionDate: string, set: Set<string>): void {
  writeSessionSet(acceptStorageKey(sessionDate), set);
}
function entryDismissKey(playerId: string, gameId: string): string {
  return `${playerId}|${gameId}`;
}

export type HrRadarStageLabel = "watch" | "building" | "attack" | "cooling" | "closed";
export type HrRadarOutcomeLabel =
  | "pending"
  | "called_hit"
  | "miss"
  | "early_window_hr"
  | "uncalled_hr"
  | "late_signal"
  | "expired";

export interface HrRadarLadderEntry {
  playerId: string;
  playerName: string;
  team: string;
  gameId: string;
  // Goldmaster canonical entity fields (Phase 1).
  currentStage?: HrRadarStageLabel;
  currentStatus?: "live" | "resolved";
  outcome?: HrRadarOutcomeLabel;
  plateAppearancesTracked?: number | null;
  hasLiveABContext?: boolean;
  userReasons?: string[];
  adminReasons?: string[];
  summary?: string;
  // Goldmaster Phase 1 — canonical 0-100 wire scale numbers (INTERNAL).
  initialReadinessScore?: number | null;
  currentReadinessScore?: number | null;
  peakReadinessScore?: number | null;
  buildScore?: number | null;
  conversionProbability?: number | null;
  pitcherHrVulnerability?: number | null;
  // Goldmaster RESTORE — 10-point USER-FACING signal score (0.0-10.0).
  initialSignalScore10?: number | null;
  currentSignalScore10?: number | null;
  peakSignalScore10?: number | null;
  // Conviction-aware DISPLAY scores — capped to engine's actual conviction
  // ceiling for the row's alertPath (e.g. PATH_F_BLOCKED_BRIDGE → 6.0/10).
  // The card's headline /10 number SHOULD prefer these so the displayed
  // score matches the engine's section verdict for the row.
  displayInitialScore10?: number | null;
  displayCurrentScore10?: number | null;
  displayPeakScore10?: number | null;
  displayCap10?: number | null;
  displayCapBadgeLabel?: string | null;
  displayCapReason?: string | null;
  deltaFromInitial10?: number | null;
  deltaFromPeak10?: number | null;
  isHeatingUp?: boolean;
  isCoolingOff?: boolean;
  momentumLabel?: "heating_up" | "holding_strong" | "cooling_off" | "flat";
  // Goldmaster Phase 2+3 — frozen detection vs HR-event truth.
  detectedLabel?: string | null;
  hitLabel?: string | null;
  // Goldmaster Phase 4-7 — canonical stage drives copy.
  stageExplanation?: string;
  headlineReason?: string | null;
  supportingReasons?: string[];
  // Pregame seed (presence-floor rows) — additive, display-only.
  pregameSeedScore10?: number | null;
  pregameDrivers?: string[];
  pregameSeedTier?: string | null;
  // Pre-Game Power Radar bridge (additive, display-only; from the separate
  // Pre-Game Power Radar, not the seed above).
  pregamePowerTarget?: boolean;
  pregamePowerTier?: string | null;
  pregamePowerScore10?: number | null;
  pregamePowerMarket?: string | null;
  // Legacy fields (still populated for backwards compat).
  state: string | null;
  confidenceTier: string | null;
  peakScore: number | null;
  signalStrengthScore: number | null;
  whyNowReasons: string[];
  nextAbEstimate: string | null;
  detectedInning: number | null;
  detectedHalf: string | null;
  hitInning: number | null;
  hitHalf: string | null;
  outcomeStatus: string;
  userVisible: boolean;
  signalDetectedAt: string | null;
  hitDetectedAt: string | null;
  resolvedAt: string | null;
  alertPath: string | null;
  // Task #121 Step 4 — remaining-window urgency line.
  remainingPAExpectation?: number | null;
  currentInning?: number | null;
  // Task #121 Step 5 — Statcast (OnlyHomers) stats for cashed cards.
  onlyHomersVerified?: boolean;
  ohExitVelocity?: number | null;
  ohLaunchAngle?: number | null;
  ohDistance?: number | null;
  ohPitchType?: string | null;
  // Compact per-PA At-Bat Log projection (additive, transport-only). Powers
  // the collapsed chip summary + the inline expand on live cards. Absent on
  // older cached rows → card falls back to the plateAppearancesTracked count.
  recentABs?: AbRow[];
  // Server-stamped (routes.ts) — true once the game is Final, so the client
  // hides live-only CTAs / timing copy even if the row briefly sat in a live
  // section. Optional; absent on older cached rows.
  isGameFinal?: boolean;

  // ── Goldmaster v1 — additive user-facing stage layer (optional). ──────────
  userStage?: "track" | "build" | "ready" | "fire" | "resolved";
  stageLabel?: string;
  stageDescription?: string;
  qualifyingSignals?: string[];
  // Step 5 — canonical badge set, server-derived; rendered verbatim.
  badges?: HrRadarBadge[];
  cleanReasons?: string[];
  officialSignalStage?: "fire" | null;
  officialSignalAt?: string | null;
  officialSignalInning?: number | null;
  firstTrackedAt?: string | null;
  firstTrackedInning?: number | null;
  firstBuiltAt?: string | null;
  firstBuiltInning?: number | null;
  firstReadyAt?: string | null;
  firstReadyInning?: number | null;
  firstFireAt?: string | null;
  firstFireInning?: number | null;
  hrOccurredAt?: string | null;
  hrOccurredInning?: number | null;
  debugReasons?: string[];
  enginePath?: string | null;

  // ── HR Radar display contract (presentation-only, server-stamped). ────────
  // Render these verbatim — do not recompute probability, infer tier, or
  // rebuild the action bands on the client.
  displayHrChancePct?: number | null;
  displayReadinessScore10?: number | null;
  displayActionScore10?: number | null;
  displayActionPct?: number | null;
  displayStageLabel?: "TOP WINDOW" | "ALMOST" | "WATCHING";
  displayStageSubLabel?: string;
  displayPrimaryReason?: string | null;
  displayWhyNotTopWindow?: string | null;
  displayRecordEligible?: boolean;
}

export interface HrRadarLadderResponse {
  sessionDate: string;
  sections: {
    attackNow: HrRadarLadderEntry[];
    building: HrRadarLadderEntry[];
    watch: HrRadarLadderEntry[];
    cashed: HrRadarLadderEntry[];
    dead: HrRadarLadderEntry[];
    // Goldmaster v1 — additive Ready bucket. Optional so older API responses
    // still type-check.
    ready?: HrRadarLadderEntry[];
  };
  counts: { attackNow: number; building: number; watch: number; cashed: number; dead: number; total: number; ready?: number };
}

// Phase 6 — `noAbYet` is an additive parking lot for live games where the
// player still has zero tracked PAs. Keeps the engine's bucket assignment
// intact server-side; only the UI re-shelves these rows so the live decision
// sections (FIRE/READY/BUILD/WATCH) stop showing 0.0/10 pregame noise.
// Batch A — `modelReview` is an admin-only bucket that holds uncalled_hr /
// early_hr_insufficient_sample rows so they don't pollute MISSED.
export type SectionKey =
  | "attackNow"
  | "building"
  | "ready"
  | "watch"
  | "noAbYet"
  | "cashed"
  | "dead"
  | "modelReview";

export const SECTION_META: Record<SectionKey, {
  label: string;
  icon: typeof Flame;
  accent: string;
  badge: string;
  description: string;
  sublabel: string;
  defaultCollapsed: boolean;
}> = {
  attackNow: {
    label: "FIRE",
    icon: Flame,
    accent: "border-red-500/40 bg-red-500/5",
    badge: "bg-red-500 text-white",
    description: "Highest-conviction HR signals firing right now.",
    sublabel: "Act now — conviction confirmed",
    defaultCollapsed: false,
  },
  ready: {
    label: "READY",
    icon: Zap,
    accent: "border-orange-500/40 bg-orange-500/5",
    badge: "bg-orange-500 text-white",
    description: "Strong HR setup forming — high-conviction watch context, not an official call until it fires.",
    sublabel: "High conviction, waiting for final trigger",
    defaultCollapsed: false,
  },
  building: {
    label: "ALMOST",
    icon: Zap,
    accent: "border-amber-500/40 bg-amber-500/5",
    badge: "bg-amber-500 text-white",
    description: "Heating up, waiting on confirmation — context only, not graded to the record yet.",
    sublabel: "Heating up, waiting on confirmation",
    defaultCollapsed: false,
  },
  watch: {
    label: "TRACK",
    icon: Eye,
    accent: "border-blue-500/30 bg-blue-500/5",
    badge: "bg-blue-500 text-white",
    description: "Tracking. HR conditions are forming, not actionable yet.",
    sublabel: "Early formation detected",
    defaultCollapsed: false,
  },
  noAbYet: {
    label: "NO AB YET",
    icon: Eye,
    accent: "border-zinc-500/30 bg-zinc-500/5",
    badge: "bg-zinc-600 text-white",
    description: "Game is live, no plate appearance tracked yet — parked here until the first AB.",
    sublabel: "Live game, no at-bats yet",
    defaultCollapsed: true,
  },
  cashed: {
    label: "CASHED",
    icon: Trophy,
    accent: "border-emerald-500/40 bg-emerald-500/5",
    badge: "bg-emerald-500 text-white",
    description: "HR confirmed after a called signal.",
    sublabel: "Called it ✓",
    defaultCollapsed: false,
  },
  dead: {
    label: "MISSED",
    icon: XCircle,
    accent: "border-zinc-500/30 bg-zinc-500/5",
    badge: "bg-zinc-500 text-white",
    description: "Signals that resolved without an HR.",
    sublabel: "Resolved without HR",
    defaultCollapsed: true,
  },
  modelReview: {
    label: "MODEL REVIEW",
    icon: AlertTriangle,
    accent: "border-purple-500/30 bg-purple-500/5",
    badge: "bg-purple-600 text-white",
    description: "Admin-only. Uncalled HRs and first-AB HRs flagged for engine calibration.",
    sublabel: "Engine calibration review",
    defaultCollapsed: true,
  },
};


// Batch A — Phase 2: client-side jargon→plain-English mapper. The server
// strips most engine debug tokens via buildHrRadarReasonSets, but legacy
// tokens like "FAST PROMOTE:Single Elite Hr Contact" still leak through on
// older cached rows. This is a final user-facing polish layer that runs
// AFTER the server's strip and the existing isUserSafeReason filter.
const REASON_REPLACEMENTS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /^FAST[ _]PROMOTE:?\s*single[ _]elite[ _]hr[ _]contact/i, replacement: "Elite HR-shaped contact" },
  { pattern: /^FAST[ _]PROMOTE:?\s*elite[ _]barrel/i, replacement: "Elite barrel detected" },
  { pattern: /^FAST[ _]PROMOTE:?\s*massive[ _]single[ _]contact/i, replacement: "Massive single contact" },
  { pattern: /^FAST[ _]PROMOTE:?\s*two[ _]hard[ _]hit[ _]balls/i, replacement: "Two hard-hit balls in a row" },
  { pattern: /^FAST[ _]PROMOTE:?\s*pitcher[ _]collapse[ _]power/i, replacement: "Pitcher fatigue + power matchup" },
  { pattern: /^FAST[ _]PROMOTE:?\s*barrel[ _]xba/i, replacement: "Barrel-quality xBA contact" },
  { pattern: /^FAST[ _]PROMOTE:?\s*/i, replacement: "Strong promote: " },
  { pattern: /^elite[ _]barrel/i, replacement: "Elite barrel" },
  { pattern: /^two[ _]hard[ _]hit[ _]balls/i, replacement: "Two hard-hit balls" },
  { pattern: /^massive[ _]single[ _]contact/i, replacement: "Massive single contact" },
  { pattern: /^pitcher[ _]collapse[ _]power/i, replacement: "Pitcher fatigue + power matchup" },
  { pattern: /^near[ _]hr[ _]contact/i, replacement: "Near-HR contact in last 5 ABs" },
  { pattern: /^hr[ _]watch/i, replacement: "HR watch contact" },
  { pattern: /^velocity[ _]drop/i, replacement: "Pitcher velocity dropping" },
  { pattern: /^park[ _]boost/i, replacement: "Hitter-friendly park" },
  { pattern: /^wind[ _]out/i, replacement: "Wind blowing out" },
  { pattern: /^handedness[ _]edge/i, replacement: "Handedness matchup edge" },
  { pattern: /^signal[ _]climb/i, replacement: "Signal score climbing" },
];

function humanizeReason(s: string): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed) return trimmed;
  for (const { pattern, replacement } of REASON_REPLACEMENTS) {
    if (pattern.test(trimmed)) {
      // If the replacement ends with a colon or space, append the
      // remainder of the original string (preserves any payload after the
      // prefix). Otherwise, return the replacement as-is.
      if (replacement.endsWith(": ") || replacement.endsWith(" ")) {
        return replacement + trimmed.replace(pattern, "").trim();
      }
      return replacement;
    }
  }
  // Convert a space-free snake_case / SCREAMING_CASE / colon token to
  // "Sentence case" (e.g. "near_hr_contact" → "Near hr contact"). Only single
  // tokens are transformed — real multi-word copy (has spaces) is left as-is so
  // a legitimate sentence containing a colon is never lowercased/mangled.
  if (!/\s/.test(trimmed) && (/^[A-Z0-9_]+$/.test(trimmed) || /[_:]/.test(trimmed))) {
    const sentence = trimmed
      .replace(/[_:]/g, " ")
      .toLowerCase()
      .replace(/^\w/, (c) => c.toUpperCase());
    return sentence;
  }
  return trimmed;
}

function formatHalfInning(inning: number | null, half: string | null): string | null {
  if (inning == null) return null;
  const h = (half ?? "").toLowerCase();
  const prefix = h.startsWith("t") || h === "top" ? "T" : h.startsWith("b") || h === "bottom" ? "B" : "";
  return prefix ? `${prefix}${inning}` : `Inn ${inning}`;
}

function deadOutcomeLabel(status: string): { label: string; color: string } {
  switch (status) {
    case "uncalled_hr": return { label: "Uncalled HR", color: "bg-zinc-700 text-zinc-100" };
    case "late_signal": return { label: "Late signal", color: "bg-orange-700 text-orange-100" };
    case "called_miss":
    case "miss":
      return { label: "Called miss", color: "bg-zinc-600 text-zinc-100" };
    // Goldmaster Phase 4 + 8 — early-window HR is its OWN outcome bucket; it
    // must never share copy with a regular miss or with an uncalled HR.
    case "early_hr_no_window":
    case "early_window_hr":
    // Phase 2 — first-AB HRs (insufficient sample) join this bucket so they
    // share the purple "early window" treatment when shown to admins.
    case "early_hr_insufficient_sample":
      return { label: "Early HR (no window)", color: "bg-purple-700 text-purple-100" };
    case "expired": return { label: "Expired", color: "bg-zinc-600 text-zinc-100" };
    default: return { label: "Resolved", color: "bg-zinc-600 text-zinc-100" };
  }
}

/**
 * Phase 4 — pre-HR detection tier label for cashed rows. Returns null for
 * legacy untiered `called_hit` (renders as plain "Cashed") and for
 * non-called statuses. Mirrors `getCashedFromTierLabel` on the server.
 */
function cashedFromTierLabel(
  status: string | null | undefined,
): "Attack" | "Ready" | "Build" | "Watch" | null {
  switch (status) {
    case "called_hit_attack": return "Attack";
    case "called_hit_ready": return "Ready";
    case "called_hit_build": return "Build";
    case "called_hit_watch": return "Watch";
    default: return null;
  }
}

/**
 * Phase 4 — outcome statuses that should be HIDDEN from non-admin users in
 * the user-facing dead/missed section. Admins still see them for calibration.
 *   - `uncalled_hr`: HR happened with no pre-HR signal at all (admin debug)
 *   - `early_hr_insufficient_sample`: first-AB / no-live-sample HR (Phase 2)
 */
const ADMIN_ONLY_DEAD_STATUSES: ReadonlySet<string> = new Set([
  "uncalled_hr",
  "early_hr_insufficient_sample",
  // Legacy alias — older rows may still carry the pre-rename token.
  "early_hr_no_window",
]);

/**
 * Goldmaster Phase 6 — final UI fallback for jargon stripping. The server's
 * buildHrRadarReasonSets already filters out PATH, BsZ, Score tokens, but a
 * stale legacy row may still have raw tags. We never render anything that
 * starts with engine debug prefixes.
 */
function isUserSafeReason(s: string): boolean {
  const t = s.trim();
  // Engine debug prefixes / inline tokens.
  if (/^(PATH[_ ]?[A-Z0-9_]+|WATCH:|BUILD:|FORM:|PRE[_ ]HR[_ ]DANGER|HrShaped|BsZ|Score\d|Conv\s+\d+%|Profile\d|Danger\d)/i.test(t)) return false;
  // FSM / prob-rail promotion reason codes that leak as a "reason".
  if (/(prob[_ ]?rail|bet[_ ]?now|dynamic_|pitcher_fade|attack_sustained|_sustained|_awaiting)/i.test(t)) return false;
  // Bare engine identifier code: lowercase snake_case / colon-joined, no spaces
  // (e.g. "prob_rail:bet_now_attack_sustained"). Real user copy has spaces.
  if (/^[a-z][a-z0-9]*([_:][a-z0-9]+)+$/.test(t)) return false;
  return true;
}

/**
 * Run a server-stamped reason string through the same user-safety gate the
 * bullet list uses, then humanize. Returns null when the value is unsafe (a raw
 * engine/FSM code) or empty — callers fall back to clean copy or render nothing.
 */
function cleanReason(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t || !isUserSafeReason(t)) return null;
  const human = humanizeReason(t);
  return human.length > 0 ? human : null;
}

export interface CardProps {
  entry: HrRadarLadderEntry;
  section: SectionKey;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  onPass?: (entry: HrRadarLadderEntry) => void;
  onAccept?: (entry: HrRadarLadderEntry) => void;
  isAccepted?: boolean;
  /** List-only affordance — opens the full-screen drawer (adds admin diagnostics
   * on top of this same card). Omitted when LadderCard already IS the drawer. */
  onOpenDrawer?: () => void;
}

/**
 * HeatingUpMeter — compact 3-stop indicator on the 0-10 scale.
 * Shows initial → current → peak as positioned dots on a thin track.
 * Pure presentational; takes already-clamped 0-10 values.
 */
function HeatingUpMeter({
  initial,
  current,
  peak,
  playerId,
  isPregame = false,
}: {
  initial: number;
  current: number;
  peak: number;
  playerId: string;
  // When true the row is a pre-contact PRIOR (no live AB yet): render a dashed,
  // unfilled track with a hollow "current" marker so users can tell a seeded
  // estimate apart from a live-earned score. Flips to the solid treatment once
  // live contact arrives.
  isPregame?: boolean;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(10, n));
  const ci = clamp(initial);
  const cc = clamp(current);
  const cp = clamp(peak);
  const pct = (n: number) => `${(n / 10) * 100}%`;
  const climb = cc - ci;
  const trackColor =
    climb >= 0.5 ? "bg-emerald-500/30" : climb <= -0.5 ? "bg-orange-500/30" : "bg-muted";

  if (isPregame) {
    // Pregame seed (prior): dashed outline track, hollow current marker — no
    // live journey envelope to draw because there's no trajectory yet.
    return (
      <div
        className="relative w-24 h-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-transparent overflow-visible"
        data-testid={`meter-heating-${playerId}`}
        data-pregame="true"
        title={`Pregame seed ${cc.toFixed(1)} — prior, no live at-bats yet`}
      >
        {/* Current marker as a hollow ring (◌) — a prior, not a live read. */}
        <div
          className="absolute -top-1 w-2.5 h-2.5 rounded-full border-[1.5px] border-muted-foreground/70 bg-transparent"
          style={{ left: `calc(${pct(cc)} - 5px)` }}
        />
      </div>
    );
  }

  return (
    <div
      className="relative w-24 h-1.5 rounded-full bg-muted/40 overflow-visible"
      data-testid={`meter-heating-${playerId}`}
      title={`Initial ${ci.toFixed(1)} → Current ${cc.toFixed(1)} → Peak ${cp.toFixed(1)}`}
    >
      {/* Filled track from initial to peak shows the journey envelope. */}
      <div
        className={`absolute top-0 h-1.5 rounded-full ${trackColor}`}
        style={{
          left: pct(Math.min(ci, cp)),
          width: pct(Math.abs(cp - ci)),
        }}
      />
      {/* Initial marker (gray). */}
      <div
        className="absolute -top-0.5 w-1 h-2.5 rounded-sm bg-muted-foreground/60"
        style={{ left: `calc(${pct(ci)} - 2px)` }}
      />
      {/* Peak marker (amber). */}
      <div
        className="absolute -top-0.5 w-1 h-2.5 rounded-sm bg-amber-400"
        style={{ left: `calc(${pct(cp)} - 2px)` }}
      />
      {/* Current marker (emerald, larger) — the user's "you are here". */}
      <div
        className="absolute -top-1 w-2 h-3.5 rounded-sm bg-emerald-400 ring-1 ring-emerald-300/50"
        style={{ left: `calc(${pct(cc)} - 4px)` }}
      />
    </div>
  );
}

function hrBreakdownBar(pct: number, isHrProb = false): string {
  if (isHrProb) {
    if (pct >= 35) return "#22c55e";
    if (pct >= 20) return "#a3e635";
    if (pct >= 12) return "#94a3b8";
    if (pct >= 6)  return "#f59e0b";
    return "#ef4444";
  }
  if (pct >= 70) return "#22c55e";
  if (pct >= 55) return "#a3e635";
  if (pct >= 45) return "#94a3b8";
  if (pct >= 35) return "#f59e0b";
  return "#ef4444";
}

/**
 * Compact always-visible HR breakdown strip — tiny labelled bars in one row.
 * Reads the GATED canonical breakdown builder (hrRadarDisplayState): the
 * HR-chance bar is the only percent and only when calibrated; every other
 * metric renders on the /10 scale, so a raw readiness/score (e.g. 95) can never
 * surface as "95%". Renders nothing when fewer than 2 metrics are present.
 */
function HrBreakdownStrip({ entry }: { entry: HrRadarLadderEntry }) {
  const bars = buildHrRadarBreakdownBars(entry as unknown as HrRadarRowInput);
  if (bars.length < 2) return null;
  return (
    <div
      className="mt-2 grid grid-cols-4 gap-1.5"
      data-testid={`strip-hr-breakdown-${entry.playerId}`}
    >
      {bars.map((bar) => {
        const color = hrBreakdownBar(bar.magnitude, bar.isHrProb);
        const valueText = formatBreakdownBarValue(bar);
        return (
          <div key={bar.key} className="flex flex-col gap-0.5 min-w-0" title={`${bar.short} ${valueText}`}>
            <div className="flex items-center justify-between gap-1">
              <span className="text-[8px] text-muted-foreground/80 tracking-wide">{bar.short}</span>
              <span className="text-[8px] font-bold tabular-nums" style={{ color }}>{valueText}</span>
            </div>
            <div className="h-1 rounded-full bg-secondary/60 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${bar.magnitude}%`, backgroundColor: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Pregame "why" driver chips — verbatim server-stamped power-profile drivers
 * (e.g. "Hitter park", "Elite xISO", "Slot 2"). Renders nothing when absent.
 */
function PregameDriverChips({ entry }: { entry: HrRadarLadderEntry }) {
  const drivers = entry.pregameDrivers ?? [];
  if (drivers.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1" data-testid={`chips-pregame-drivers-${entry.playerId}`}>
      {drivers.slice(0, 4).map((d, i) => (
        <span
          key={i}
          className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-300 border border-orange-500/20"
          data-testid={`chip-pregame-driver-${entry.playerId}-${i}`}
        >
          {d}
        </span>
      ))}
    </div>
  );
}

export function LadderCard({ entry, section, onAddToSlip, onOpenDetails, onPass, onAccept, isAccepted, onOpenDrawer }: CardProps) {
  // Goldmaster Phase 2+3 — prefer the FROZEN server-stamped detectedLabel /
  // hitLabel (these never advance on score climbs). Fall back to formatting
  // the (inning, half) pair for legacy rows that pre-date the label fields.
  const detected = entry.detectedLabel ?? formatHalfInning(entry.detectedInning, entry.detectedHalf);
  const hit = entry.hitLabel ?? formatHalfInning(entry.hitInning, entry.hitHalf);
  // Signal-first inning pill — read the row's live currentInning first,
  // fall back to the frozen detectedInning for resolved rows. Pure surfacing.
  const inningWindowSource: number | null =
    (typeof entry.currentInning === "number" && entry.currentInning >= 1 ? entry.currentInning : null) ??
    (typeof entry.detectedInning === "number" && entry.detectedInning >= 1 ? entry.detectedInning : null);
  const inningWindow: MlbInningWindow = getMlbInningWindow(inningWindowSource);
  const inningWindowPill = HR_INNING_WINDOW_PILL[inningWindow];
  // Headline /10 score — prefer the conviction-aware DISPLAY score so the
  // number renders coherent with the section the engine assigned the row to
  // (e.g. PATH_F_BLOCKED_BRIDGE caps at 6.0/10 while sitting in Track).
  // Fall back to raw signalScore10 → 0-100 readiness → legacy mirrors so an
  // older cached row never blanks the headline.
  const score10 = hrEntryCurrentScore10(entry);
  const initial10 = hrEntryInitialScore10(entry);
  const peak10 = hrEntryPeakScore10(entry);
  // Watch-only pill — true iff the engine intentionally locked this row at
  // a sub-fire conviction ceiling (server-derived; null on uncapped rows).
  const convictionBadgeLabel = entry.displayCapBadgeLabel ?? null;
  const convictionBadgeReason = entry.displayCapReason ?? null;
  const momentum = entry.momentumLabel ?? "flat";
  const momentumDisplay =
    momentum === "heating_up" ? { label: "Heating up", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" }
    : momentum === "holding_strong" ? { label: "Holding strong", color: "text-amber-400 bg-amber-500/10 border-amber-500/30" }
    : momentum === "cooling_off" ? { label: "Cooling off", color: "text-orange-400 bg-orange-500/10 border-orange-500/30" }
    : null;
  // Compact momentum arrow shown next to the headline score — replaces the
  // always-on Initial/Current/Peak rows + "Score increased" line. The full
  // numeric trajectory + heating meter move into the collapsible detail.
  const momentumArrow =
    momentum === "heating_up" ? { glyph: "↑", color: "text-emerald-400" }
    : momentum === "cooling_off" ? { glyph: "↓", color: "text-orange-400" }
    : momentum === "holding_strong" ? { glyph: "→", color: "text-amber-400" }
    : null;
  // Fire and Ready share the high-conviction "HR Max Window" visual treatment,
  // but ONLY Fire is an official, graded call (officialSignalStage="fire" /
  // displayRecordEligible). Ready is high-conviction watch context and never
  // counts toward the official record. They are distinct ladder stages
  // (Track → Build → Ready → Fire); "HR Max Window" is a contextual badge on
  // these two, not a stage of its own.
  const isAttack = section === "attackNow" || section === "ready";
  // Goldmaster Phase 5 — derive live vs resolved mode. Resolved cards must
  // never carry "next AB" copy or any live-only verbiage.
  // HR Radar Final-Game Reconciliation — Phase 5: a card whose game is
  // already Final must also be treated as resolved so the Take it / Pass /
  // ~X PA left / expires after T… CTAs are hidden, even if the card briefly
  // slipped through with section=watch/building/attackNow. The server
  // stamps `isGameFinal` on every ladder card from `mlbGameCache.gameState`.
  const isResolved =
    entry.currentStatus === "resolved" ||
    section === "cashed" ||
    section === "dead" ||
    entry.isGameFinal === true;
  // Task #121 Step 3 — Take it / Pass are available on every LIVE card
  // (Attack Now / Building / Watch). Resolved sections (cashed/dead) get
  // no actions.
  const isLiveSection = section === "attackNow" || section === "ready" || section === "building" || section === "watch";
  const canAdd = !isResolved && isLiveSection && !!onAddToSlip;
  // Goldmaster Phase 7 — pregame indicator for 0-AB rows.
  const isPregameOnly =
    entry.hasLiveABContext === false ||
    (entry.plateAppearancesTracked != null && entry.plateAppearancesTracked === 0);
  // Goldmaster Phase 4-7 — prefer the server's canonical headlineReason +
  // supportingReasons split. They are already pregame-aware (empty for
  // zero-AB) and engine-jargon-stripped on the server. Fall back to
  // userReasons / legacy whyNowReasons only when those new fields are absent
  // (older cached row). Final UI-side jargon strip is kept as belt-and-braces
  // for any stale row that pre-dates the server filter.
  const headline = entry.headlineReason ?? null;
  const supporting = (entry.supportingReasons && entry.supportingReasons.length > 0)
    ? entry.supportingReasons
    : ((entry.userReasons && entry.userReasons.length > 0) ? entry.userReasons : entry.whyNowReasons);
  const reasonsRaw = headline ? [headline, ...(supporting ?? [])] : (supporting ?? []);
  // Batch A — Phase 2: run safe reasons through humanizeReason() so legacy
  // SCREAMING_CASE / "FAST PROMOTE:..." tokens render as plain English.
  // Dedupe AFTER humanization so two different raw tokens that humanize to
  // the same phrase only show once.
  const reasons = Array.from(
    new Set(
      (reasonsRaw ?? [])
        .filter(isUserSafeReason)
        .map(humanizeReason)
        .filter((r) => r.length > 0),
    ),
  );
  // Pregame zero-AB rows must not render any contact-implying bullets — the
  // server already empties supportingReasons, but defend against legacy data.
  const reasonsForRender = isPregameOnly ? reasons.slice(0, 1) : reasons;
  // ── HR Radar display contract (server-stamped, formatting-only). The card
  // leads with the TRUE HR chance %; action strength is the tier-banded bar.
  // GATE the percent through the canonical calibrated check so a raw 0-100
  // readiness/score value can never leak into the hero as a misleading "95%".
  // When it is not a plausible calibrated probability, the card falls back to
  // the tier-banded /10 strength below.
  const hrChancePct = deriveCalibratedHrChancePct(entry as unknown as HrRadarRowInput);
  const actionPct = hrEntryActionPct(entry);
  const actionScore10 = hrEntryActionScore10(entry);
  // Sanitize every server-stamped reason string through the same user-safety
  // gate the bullet list uses, so a raw engine/FSM code (e.g.
  // "prob_rail:bet_now_attack_sustained") can never reach the headline/summary.
  const cleanStageExplanation = cleanReason(entry.stageExplanation);
  const primaryReason =
    cleanReason(entry.displayPrimaryReason) ??
    cleanReason(entry.headlineReason) ??
    cleanStageExplanation ??
    "HR setup is forming.";
  const whyNotTopWindow = cleanReason(entry.displayWhyNotTopWindow);
  const cleanSummary = cleanReason(entry.summary);
  // Only FIRE leads with the calibrated HR-chance %. READY/ALMOST/TRACK lead
  // with the /10 strength so the Full Ladder and Quick Decide agree (Quick
  // Decide already shows % only on the FIRE Live Call card).
  const showHrChanceHero = hrChancePct != null && section === "attackNow";
  const heroScore10 = actionScore10 ?? score10;
  const recordEligible = entry.displayRecordEligible === true;
  // Premium shell — tier-driven glow/tint/border (Pre-Game Power treatment),
  // keyed off the same tier theme used everywhere else in HR Radar so a card
  // opened from the list and a card opened from the drawer are identical.
  const t = hrTierTheme(tierFromLadderSection(section));
  // Driver chips (Pre-Game Power treatment) — the same badge+reformat chip
  // builder Quick Decide's Hero Card already uses, so this card and that one
  // never show different evidence for the same signal. Each chip carries its
  // own tone (fire/warn/info/good); pure display formatting of server data.
  const driverChips = isResolved
    ? []
    : buildDriverChips(entry, mapHrRadarRowToDisplayState(entry as unknown as HrRadarRowInput).drivers);
  // Big stage icon — reuse the section's SECTION_META icon (Flame/Zap/Eye).
  const StageIcon = SECTION_META[section]?.icon ?? null;
  // Outcome label for resolved rows uses the canonical outcome when present.
  const resolvedOutcomeKey = entry.outcome ?? entry.outcomeStatus;

  const [shareLoading, setShareLoading] = useState(false);
  // Per-card inline expand — compact summary by default, full At-Bat Log +
  // trajectory + breakdown on tap. Live rows only.
  const [detailOpen, setDetailOpen] = useState(false);
  const recentABs = entry.recentABs ?? [];
  const abChip = abChipSummary(recentABs, entry.plateAppearancesTracked);
  const handleShare = async () => {
    if (shareLoading) return;
    setShareLoading(true);
    try {
      const score10Val = hrEntryCurrentScore10(entry);
      const stage = entry.userStage ?? entry.currentStage ?? "track";
      const stageEmoji: Record<string, string> = { fire: "🔥", ready: "⚡", build: "📈", track: "👀" };
      const emoji = stageEmoji[stage] ?? "🔥";
      // GATE the HR probability through the same calibrated check used
      // everywhere else, so a raw readiness/score leak can never be shared as a
      // "%". Conviction (raw readiness) is shared on the /10 scale, never as a
      // percent — only a calibrated HR probability earns a "%".
      const hrProbPct = deriveCalibratedHrChancePct(entry as unknown as HrRadarRowInput);
      const readPct   = entry.currentReadinessScore != null ? Math.round(entry.currentReadinessScore) : null;
      const convict10 = readPct != null ? (readPct / 10).toFixed(1) : null;
      const scoreStr  = score10Val != null ? ` | Score: ${Number(score10Val).toFixed(1)}/10` : "";
      const readStr   = convict10 != null ? ` | Conviction: ${convict10}/10` : "";
      const probStr   = hrProbPct != null ? ` | HR Prob: ${hrProbPct}%` : "";
      const hdLine    = entry.headlineReason ? `\n"${entry.headlineReason.slice(0, 80)}"` : "";
      const tweetText = `${emoji} HR Radar: ${entry.playerName} (${entry.team})${scoreStr}${readStr}${probStr}${hdLine}\n\n#MLB #HRRadar #LiveLocks`;

      const pitcherVulnPct = entry.pitcherHrVulnerability != null ? Math.min(100, Math.round(entry.pitcherHrVulnerability)) : null;
      const params = new URLSearchParams({
        playerName: entry.playerName,
        team: entry.team,
        stage,
        ...(score10Val != null                   ? { score10:      String(score10Val) }                             : {}),
        ...(readPct != null                      ? { readinessPct: String(readPct) }                                : {}),
        ...(hrProbPct != null                    ? { hrProbPct:    String(hrProbPct) }                              : {}),
        ...(entry.headlineReason                 ? { headline:     entry.headlineReason }                           : {}),
        ...(entry.buildScore != null             ? { buildScore:   String(entry.buildScore) }                       : {}),
        ...(pitcherVulnPct != null               ? { pitcherVuln:  String(pitcherVulnPct) }                        : {}),
      });

      const resp = await fetch(`/api/mlb/hr-radar/share-card?${params.toString()}`);
      if (!resp.ok) throw new Error("share-card failed");
      const blob = await resp.blob();
      const file = new File([blob], `hr-radar-${entry.playerName.replace(/\s+/g, "-")}.png`, { type: "image/png" });

      // Mobile / supported browser: attach image directly (no URL leaves the platform)
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: tweetText });
      } else {
        // Desktop fallback: download the image, then open compose with text only
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(blobUrl);
        window.open(
          `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
          "_blank",
          "noopener,noreferrer,width=600,height=450",
        );
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setShareLoading(false);
    }
  };

  const handleAdd = () => {
    if (!onAddToSlip) return;
    onAccept?.(entry);
    onAddToSlip({
      playerId: entry.playerId,
      playerName: entry.playerName,
      market: "home_runs",
      bookLine: 0.5,
      recommendedSide: "OVER",
      sportsbook: "draftkings",
      edge: null,
      enginePct: null,
      gameId: entry.gameId,
      overOdds: null,
      underOdds: null,
    } as unknown as MlbSignalData);
  };

  return (
    <div
      className={`flex gap-3 rounded-2xl border ${t.cardTint} bg-card p-3.5 transition-all hover:brightness-110 ${t.tier === "fire" && !isResolved ? "hr-fire-pulse" : ""}`}
      style={{ boxShadow: `0 0 14px ${t.hex}${t.hot ? "59" : "26"}`, borderColor: `${t.hex}55` }}
      data-testid={`ladder-card-${section}-${entry.playerId}`}
    >
      <TierRail tier={t.tier} />
      <div className="flex items-start justify-between gap-2 min-w-0 flex-1">
        {/* Small stage icon — instant visual tier recognition, paired with the
            hero number below (Pre-Game Power treatment: icon + label under the
            score, not a large floating icon competing with the header row). */}
        <button
          className="text-left min-w-0 flex-1 overflow-hidden"
          onClick={() => onOpenDetails?.(entry)}
          data-testid={`button-open-ladder-details-${entry.playerId}`}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-0.5 min-w-0">
            <span className="font-bold text-sm truncate min-w-0" data-testid={`text-ladder-player-${entry.playerId}`}>
              {entry.playerName}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0">
              {entry.team}
            </span>
            {/* Record-eligibility tag — orthogonal to the driver chips below;
                marks signals that count toward the official record. */}
            {recordEligible && (
              <span
                className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-500/30 shrink-0"
                data-testid={`badge-record-eligible-${entry.playerId}`}
                title="This signal counts toward the official HR Radar record"
              >
                Counts in record
              </span>
            )}
          </div>
          {/* Driver chips — Pre-Game Power treatment: a dedicated, legible row
              (not crammed inline with the player name) so "why this matters"
              reads as evidence, not a footnote. Step 5 canonical badges +
              reformat-only chips (shared/hrRadarStage.ts), each in its own
              tone (fire/warn/info/good) via buildDriverChips(). */}
          {driverChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-1" data-testid={`driver-chips-${entry.playerId}`}>
              {driverChips.map((c) => (
                <span
                  key={c.label}
                  className={`text-[10px] font-bold px-2 py-0.5 rounded-md border shrink-0 whitespace-nowrap ${badgeToneClasses(c.tone)}`}
                  data-testid={`chip-${c.label.replace(/\s+/g, "-").toLowerCase()}-${entry.playerId}`}
                >
                  {c.label}
                </span>
              ))}
            </div>
          )}
          {/* Plain-English reason — why this card matters now. */}
          {!isResolved && (
            <p
              className="text-xs font-medium leading-snug text-foreground/90 mb-0.5"
              data-testid={`text-primary-reason-${entry.playerId}`}
            >
              {primaryReason}
            </p>
          )}
          {!isResolved && whyNotTopWindow && (
            <p
              className="text-[11px] text-muted-foreground leading-snug mb-0.5"
              data-testid={`text-why-not-top-${entry.playerId}`}
            >
              {whyNotTopWindow}
            </p>
          )}
          {/* HR Radar contract: `detected` is frozen first-detection inning;
              never substitute `signalInning` or `scoreIncreaseInning` here. */}
          <div className="flex items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground flex-wrap">
            {detected && (
              <span data-testid={`text-ladder-detected-${entry.playerId}`}>
                {isResolved ? `Called ${detected}` : `Detected ${detected}`}
              </span>
            )}
            {inningWindowPill.label && (
              <span
                data-testid={`hr-inning-window-pill-${entry.playerId}-${inningWindow}`}
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap"
                style={{ color: inningWindowPill.color, borderColor: `${inningWindowPill.color}40`, background: `${inningWindowPill.color}15` }}
                title={getMlbInningWindowLabel(inningWindow)}
              >
                {inningWindowPill.label}
              </span>
            )}
            {/* Live-mode only: pregame indicator + next-AB estimate. */}
            {!isResolved && isPregameOnly && (
              <span
                className="text-amber-400 font-medium"
                data-testid={`badge-pregame-only-${entry.playerId}`}
              >
                Pregame only · 0 AB
              </span>
            )}
            {!isResolved && entry.nextAbEstimate && !isPregameOnly && (
              <span className="text-blue-400" data-testid={`text-ladder-nextab-${entry.playerId}`}>{entry.nextAbEstimate}</span>
            )}
            {/* Resolved-mode only: HR location for cashed rows. */}
            {isResolved && hit && section === "cashed" && (
              <span className="text-emerald-500 font-semibold" data-testid={`text-ladder-hit-${entry.playerId}`}>HR {hit}</span>
            )}
            {isResolved && hit && resolvedOutcomeKey === "early_window_hr" && (
              <span className="text-purple-400 font-semibold" data-testid={`text-ladder-early-hr-${entry.playerId}`}>HR {hit}</span>
            )}
          </div>
        </button>
        <div className="flex flex-col items-end gap-1 shrink-0 max-w-[45%]">
          {!isResolved && (showHrChanceHero || heroScore10 != null) && (
            <div className="flex items-center gap-1.5">
              <div className="flex flex-col items-end">
                {/* HERO = calibrated HR chance % for FIRE only; every other tier
                    leads with the /10 strength so the two surfaces agree. */}
                {showHrChanceHero ? (
                  <div className="flex items-baseline gap-1">
                    <span
                      className={`text-xl font-extrabold leading-none ${t.text}`}
                      data-testid={`text-hr-chance-${entry.playerId}`}
                    >
                      {hrChancePct}%
                    </span>
                    {!isPregameOnly && momentumArrow && (
                      <span
                        className={`text-sm font-bold leading-none ${momentumArrow.color}`}
                        data-testid={`text-momentum-arrow-${entry.playerId}`}
                        title={momentumDisplay?.label ?? undefined}
                      >
                        {momentumArrow.glyph}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="flex items-baseline gap-1">
                    <span
                      className={`text-xl font-extrabold leading-none ${t.text}`}
                      data-testid={`text-action-strength-${entry.playerId}`}
                    >
                      {heroScore10!.toFixed(1)}
                    </span>
                    {!isPregameOnly && momentumArrow && (
                      <span
                        className={`text-sm font-bold leading-none ${momentumArrow.color}`}
                        data-testid={`text-momentum-arrow-${entry.playerId}`}
                        title={momentumDisplay?.label ?? undefined}
                      >
                        {momentumArrow.glyph}
                      </span>
                    )}
                  </div>
                )}
                <span className={`inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide leading-none mt-0.5 ${t.text}`}>
                  {StageIcon && <StageIcon className="w-2.5 h-2.5" />}
                  {showHrChanceHero ? "HR chance" : "strength"}
                </span>
                {onOpenDrawer && (
                  <button
                    onClick={onOpenDrawer}
                    className="mt-1 text-muted-foreground/50 hover:text-foreground transition-colors"
                    aria-label="Open full signal detail"
                    data-testid={`button-open-drawer-${entry.playerId}`}
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
                {/* Mark a pre-contact PRIOR so a seed is never mistaken for a
                    live-earned read. Suppressed once live contact arrives. */}
                {!isResolved && isPregameOnly && (
                  <span
                    className="text-[9px] font-medium leading-none text-muted-foreground/80 mt-0.5"
                    data-testid={`tag-pregame-seed-${entry.playerId}`}
                    title="Pregame seed — prior estimate, no live at-bats yet"
                  >
                    Pregame
                  </span>
                )}
              </div>
              {inningWindowPill.label && (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full border whitespace-nowrap"
                  style={{ color: inningWindowPill.color, borderColor: `${inningWindowPill.color}40`, background: `${inningWindowPill.color}15` }}
                  title={getMlbInningWindowLabel(inningWindow)}
                >
                  {inningWindowPill.label}
                </span>
              )}
            </div>
          )}
          {!isResolved && convictionBadgeLabel && (
            <span
              className="text-[9px] font-medium px-1.5 py-0 rounded border whitespace-nowrap text-amber-300 bg-amber-500/10 border-amber-500/30"
              data-testid={`badge-conviction-cap-${entry.playerId}`}
              title={convictionBadgeReason ?? undefined}
            >
              {convictionBadgeLabel}
            </span>
          )}
          {/* Display-only tier lift for a pregame-seeded power threat. Lives
              alongside the canonical section; never changes placement/grading. */}
          {!isResolved && entry.pregameSeedTier && (
            <span
              className="text-[9px] font-semibold px-1.5 py-0 rounded-full border whitespace-nowrap text-orange-300 bg-orange-500/10 border-orange-500/30"
              data-testid={`badge-pregame-tier-${entry.playerId}`}
              title="Pregame power profile — display-only tier"
            >
              {entry.pregameSeedTier}
            </span>
          )}
          {/* Pre-Game Power Radar bridge — this live row was flagged pre-game.
              Additive/display-only; distinct from the seed tier above. */}
          {!isResolved && entry.pregamePowerTarget && (
            <span
              className="text-[9px] font-semibold px-1.5 py-0 rounded-full border whitespace-nowrap text-amber-200 bg-amber-500/15 border-amber-400/40"
              data-testid={`badge-pregame-power-${entry.playerId}`}
              title={`Pre-game power target — score ${typeof entry.pregamePowerScore10 === "number" ? entry.pregamePowerScore10.toFixed(1) : "?"}${entry.pregamePowerMarket ? ` · ${entry.pregamePowerMarket === "home_runs" ? "HR" : entry.pregamePowerMarket === "total_bases" ? "TB" : entry.pregamePowerMarket}` : ""}`}
            >
              {`Pre-Game ${entry.pregamePowerTier ? entry.pregamePowerTier.charAt(0).toUpperCase() + entry.pregamePowerTier.slice(1) : "Target"}`}
              {entry.pregamePowerMarket ? ` · ${entry.pregamePowerMarket === "home_runs" ? "HR" : entry.pregamePowerMarket === "total_bases" ? "TB" : ""}` : ""}
            </span>
          )}
          {isResolved && section === "dead" && (
            <Badge className={`text-[9px] px-1.5 py-0 whitespace-nowrap ${deadOutcomeLabel(resolvedOutcomeKey).color}`}>
              {deadOutcomeLabel(resolvedOutcomeKey).label}
            </Badge>
          )}
          {section === "cashed" && entry.alertPath === "early" && (
            <Badge className="text-[9px] px-1.5 py-0 whitespace-nowrap bg-amber-500 text-zinc-950 gap-0.5 flex items-center" data-testid={`badge-early-call-${entry.playerId}`}>
              <DollarSign className="w-2.5 h-2.5" /> Early Call
            </Badge>
          )}
        </div>
      </div>

      {/* Window strength — tier-banded actionability bar. Mapped server-side so
          WATCHING ≤54%, ALMOST 55-69%, TOP WINDOW ≥70% — a lower tier can never
          visually outrank a higher one. This is NOT the true HR chance %. */}
      {!isResolved && actionPct != null && (
        <div className="mt-2" data-testid={`window-strength-${entry.playerId}`}>
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>Window strength</span>
            {/* Render the tier-banded strength on the /10 scale — NOT a "%".
                Only a calibrated HR probability may render a percent. */}
            <span data-testid={`text-window-strength-${entry.playerId}`}>
              {(actionScore10 ?? actionPct / 10).toFixed(1)}/10
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full ${isAttack ? "bg-red-400" : section === "building" ? "bg-amber-400" : "bg-blue-400"}`}
              style={{ width: `${actionPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Task #121 Step 5 — cashed cards: "Called T{d} → Hit T{h}" arc with
          inning delta + Statcast (EV / dist / LA / pitch) row when verified. */}
      {section === "cashed" && (detected || hit) && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px]" data-testid={`text-cashed-arc-${entry.playerId}`}>
          <span className="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 font-mono font-semibold">
            Called {detected ?? "—"}
          </span>
          <ArrowRight className="w-3 h-3 text-emerald-400" />
          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono font-semibold">
            Hit {hit ?? "—"}
          </span>
          {entry.detectedInning != null && entry.hitInning != null && (
            <span className="text-muted-foreground text-[10px]">
              ({Math.max(0, entry.hitInning - entry.detectedInning)} inn{Math.abs(entry.hitInning - entry.detectedInning) === 1 ? "" : "s"} later)
            </span>
          )}
        </div>
      )}
      {/* Phase 4 — credit lower-tier pre-HR detections. When the cashed
          row carries a tiered called_hit_* status, surface which tier the
          engine was at when the HR landed so users see Watch/Build/Ready
          calls counted as wins instead of buried as misses. Falls back to
          rendering nothing for legacy plain `called_hit` rows.
          Batch A — Phase 4: extended to also surface the peak /10 score so
          users can see how strong the call got before it cashed. */}
      {section === "cashed" && (cashedFromTierLabel(entry.outcomeStatus) || peak10 != null) && (
        <div
          className="mt-1 flex items-center gap-2 text-[10px] text-emerald-300/80"
          data-testid={`text-cashed-from-tier-${entry.playerId}`}
        >
          {cashedFromTierLabel(entry.outcomeStatus) && (
            <span>Cashed from {cashedFromTierLabel(entry.outcomeStatus)}</span>
          )}
          {peak10 != null && (
            <span className="text-emerald-400/90 font-mono font-semibold">
              · Peak {peak10.toFixed(1)}/10
            </span>
          )}
        </div>
      )}
      {/* Batch A — Phase 4: cashed cards show the headline reason as a brief
          "Why" line so users see the signal that triggered the call. Pulled
          from the same human-friendly reasons[] used in live cards. */}
      {section === "cashed" && reasons.length > 0 && (
        <div
          className="mt-1 text-[10px] text-emerald-200/70 italic"
          data-testid={`text-cashed-why-${entry.playerId}`}
        >
          Why: {reasons.slice(0, 2).join(" · ")}
        </div>
      )}
      {section === "cashed" && entry.onlyHomersVerified && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-foreground/80" data-testid={`row-cashed-stats-${entry.playerId}`}>
          {entry.ohExitVelocity != null && (
            <span data-testid={`text-stat-ev-${entry.playerId}`}>
              <span className="text-muted-foreground">EV</span> <span className="font-mono font-semibold">{entry.ohExitVelocity.toFixed(1)}</span>
            </span>
          )}
          {entry.ohDistance != null && (
            <span data-testid={`text-stat-distance-${entry.playerId}`}>
              <span className="text-muted-foreground">Dist</span> <span className="font-mono font-semibold">{Math.round(entry.ohDistance)}ft</span>
            </span>
          )}
          {entry.ohLaunchAngle != null && (
            <span data-testid={`text-stat-la-${entry.playerId}`}>
              <span className="text-muted-foreground">LA</span> <span className="font-mono font-semibold">{entry.ohLaunchAngle.toFixed(0)}°</span>
            </span>
          )}
          {entry.ohPitchType && (
            <span data-testid={`text-stat-pitch-${entry.playerId}`}>
              <span className="text-muted-foreground">Pitch</span> <span className="font-mono font-semibold">{entry.ohPitchType}</span>
            </span>
          )}
        </div>
      )}

      {/* Goldmaster Phase 5 + 6 — prefer canonical summary on resolved rows;
          show plain-English reasons (jargon stripped) on live rows. */}
      {isResolved && cleanSummary && (
        <p
          className="mt-2 text-[11px] text-foreground/70 leading-snug"
          data-testid={`text-resolved-summary-${entry.playerId}`}
        >
          {cleanSummary}
        </p>
      )}
      {/* Goldmaster Phase 4-7 — for live rows, render the canonical
          stageExplanation as a single-line summary (server is the source of
          truth). Then list the deduplicated headline + supporting reasons.
          Pregame zero-AB rows show the pregame headline only — no contact
          bullets. */}
      {!isResolved && cleanStageExplanation && cleanStageExplanation !== primaryReason && (
        <p
          className="mt-2 text-[11px] text-foreground/70 leading-snug"
          data-testid={`text-stage-explanation-${entry.playerId}`}
        >
          {cleanStageExplanation}
        </p>
      )}
      {!isResolved && reasonsForRender.length > 0 && (
        <ul className="mt-2 space-y-0.5" data-testid={`list-why-now-${entry.playerId}`}>
          {reasonsForRender.slice(0, 3).map((r, i) => (
            <li key={i} className="text-[11px] text-foreground/70 flex gap-1">
              <span className="text-muted-foreground">•</span>
              <span className="truncate">{r}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Always-visible HR breakdown (moved up from the expand). Pregame driver
          chips explain a seeded score; the mini 4-metric strip shows the live
          formation/readiness/HR%/pitcher-vuln at a glance; the compact
          trajectory shows initial → current · peak without expanding. Full
          versions remain inside the tap-to-expand detail below. */}
      {!isResolved && (
        <>
          <PregameDriverChips entry={entry} />
          <HrBreakdownStrip entry={entry} />
          {score10 != null && initial10 != null && peak10 != null && (
            isPregameOnly ? (
              // Pregame seed: a prior has no initial→current→peak journey, so
              // show the seed value once with the dashed meter instead of a
              // redundant "x → x · peak x" trajectory.
              <div
                className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono"
                data-testid={`text-trajectory-compact-${entry.playerId}`}
              >
                <span className="text-foreground/80 font-semibold">{score10.toFixed(1)}</span>
                <span className="text-muted-foreground/60">pregame seed</span>
                <HeatingUpMeter initial={initial10} current={score10} peak={peak10} playerId={entry.playerId} isPregame />
              </div>
            ) : (
              <div
                className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono"
                data-testid={`text-trajectory-compact-${entry.playerId}`}
              >
                <span>{initial10.toFixed(1)}</span>
                <ArrowRight className="w-3 h-3" />
                <span className="text-foreground/90 font-semibold">{score10.toFixed(1)}</span>
                <span className="text-muted-foreground/60">· peak {peak10.toFixed(1)}</span>
                <HeatingUpMeter initial={initial10} current={score10} peak={peak10} playerId={entry.playerId} />
              </div>
            )
          )}
        </>
      )}

      {/* Batch A — Phase 3: "Game final — resolved" stays always-visible
          (status, not detail) when a card briefly slipped into a live
          section after its game ended. */}
      {entry.isGameFinal && !isResolved && (
        <div
          className="mt-2 flex items-center gap-1 text-[11px] text-zinc-400"
          data-testid={`text-game-final-${entry.playerId}`}
        >
          <Clock className="w-3 h-3" />
          <span>Game final — resolved</span>
        </div>
      )}

      {/* Compact card + tap-to-expand detail (live rows only). The collapsed
          chip summarizes the At-Bat activity; expanding reveals the full
          At-Bat Log, score trajectory, heating meter, HR breakdown bars, and
          remaining-window timing — all moved out of the always-on view to
          keep the default card scannable. */}
      {!isResolved && (
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen} className="mt-2">
          <CollapsibleTrigger
            className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            data-testid={`button-toggle-ab-detail-${entry.playerId}`}
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${detailOpen ? "rotate-90" : ""}`} />
            <Target className="w-3 h-3" />
            <span>{abChip ?? "Details"}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2">
            {recentABs.length > 0 && <AbLogRows abs={recentABs} />}

            {/* Momentum label detail (the compact trajectory + heating meter are
                now always-on above; this expands it with the momentum bucket). */}
            {score10 != null && momentumDisplay && (
              <div
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                data-testid={`text-momentum-detail-${entry.playerId}`}
              >
                <span>Momentum</span>
                <span className={`px-1.5 py-0 rounded border text-[9px] font-medium ${momentumDisplay.color}`}>
                  {momentumDisplay.label}
                </span>
              </div>
            )}

            {/* HR Breakdown — full labelled 4-bar panel (shares buildHrRadarBreakdownBars
                with the always-on compact strip so the two can't disagree). */}
            {(() => {
              // GATED breakdown (hrRadarDisplayState): HR-chance is the only
              // percent and only when calibrated; all other metrics render /10,
              // so a raw readiness/score can never display as "95%".
              const bars = buildHrRadarBreakdownBars(entry as unknown as HrRadarRowInput);
              if (bars.length < 2) return null;
              return (
                <div
                  className="rounded-lg p-2.5 bg-secondary/20 border border-border/20"
                  data-testid={`panel-hr-breakdown-${entry.playerId}`}
                >
                  <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                    HR Breakdown
                  </div>
                  <div className="space-y-1">
                    {bars.map((bar) => {
                      const color = hrBreakdownBar(bar.magnitude, bar.isHrProb);
                      const valueText = formatBreakdownBarValue(bar);
                      return (
                        <div key={bar.key} className="flex items-center justify-between gap-2">
                          <span className="text-[9px] text-muted-foreground truncate">
                            {bar.label}{bar.unit === "score10" ? <span className="text-muted-foreground/50"> /10</span> : null}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <div className="w-16 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{ width: `${bar.magnitude}%`, backgroundColor: color }}
                              />
                            </div>
                            <span
                              className="text-[8px] font-bold tabular-nums w-7 text-right"
                              style={{ color }}
                              data-testid={`breakdown-value-${bar.key}-${entry.playerId}`}
                            >
                              {valueText}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Remaining-window timing copy. */}
            {!entry.isGameFinal && entry.remainingPAExpectation != null && entry.remainingPAExpectation > 0 && (() => {
              const pa = entry.remainingPAExpectation!;
              // Use live game-state inning (currentInning) for late-inning copy —
              // detectedInning is frozen and would misstate urgency for signals
              // detected early but now in the bottom of the order.
              const inn = entry.currentInning ?? entry.detectedInning ?? null;
              const lateInning = inn != null && inn >= 7;
              const veryLate = inn != null && inn >= 8;
              const lowPA = pa <= 2;
              const critical = pa <= 1;
              const nextSoon = pa >= 0.5 && pa <= 1.5;
              const urgent = critical || lowPA || lateInning;
              const tone = critical
                ? "text-amber-300"
                : urgent
                ? "text-amber-400"
                : "text-muted-foreground";
              // Pick the SINGLE most informative label rather than stacking.
              let label: string;
              if (veryLate && lowPA) {
                label = "Late-window only";
              } else if (nextSoon) {
                label = "Next PA likely soon";
              } else {
                const paText = `~${pa < 1 ? pa.toFixed(1) : Math.round(pa)} PA left`;
                const expiresLabel = lateInning ? ` · expires after T${Math.max(8, inn ?? 8)}` : "";
                label = `${paText}${expiresLabel}`;
              }
              return (
                <div
                  className={`flex items-center gap-1 text-[11px] ${tone}`}
                  data-testid={`text-remaining-window-${entry.playerId}`}
                >
                  <Clock className="w-3 h-3" />
                  <span>{label}</span>
                </div>
              );
            })()}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Task #121 Step 3 — Take it / Pass dual control on live cards
          (Attack Now / Building / Watch). Once the user has taken it, the
          buttons collapse into a persistent "Accepted" badge so the choice
          survives refresh within the same session. */}
      {canAdd && isAccepted && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Badge
            className="text-[10px] px-2 py-0.5 bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 gap-1 flex items-center"
            data-testid={`badge-accepted-${entry.playerId}`}
          >
            <Plus className="w-2.5 h-2.5" /> Accepted this session
          </Badge>
        </div>
      )}
      {canAdd && !isAccepted && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] gap-1 text-muted-foreground/60 hover:text-muted-foreground"
            onClick={handleShare}
            disabled={shareLoading}
            data-testid={`button-share-ladder-${entry.playerId}`}
            title="Share on X (Twitter)"
          >
            <Share2 className="w-3 h-3" />
            {shareLoading ? "Sharing…" : "Share"}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] gap-1 text-muted-foreground hover:text-foreground"
              onClick={() => onPass?.(entry)}
              data-testid={`button-pass-ladder-${entry.playerId}`}
              title="Dismiss this card for the rest of today's session"
            >
              <X className="w-3 h-3" /> Pass
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] gap-1 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
              onClick={handleAdd}
              data-testid={`button-take-it-ladder-${entry.playerId}`}
            >
              <Plus className="w-3 h-3" /> Take it
            </Button>
          </div>
        </div>
      )}
      {(!canAdd) && (
        <div className="mt-2 flex items-center justify-end">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[11px] gap-1 text-muted-foreground/60 hover:text-muted-foreground"
            onClick={handleShare}
            disabled={shareLoading}
            data-testid={`button-share-ladder-${entry.playerId}`}
            title="Share on X (Twitter)"
          >
            <Share2 className="w-3 h-3" />
            {shareLoading ? "Sharing…" : "Share"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function stageToSectionKey(stage: HrRadarCardViewModel["stage"]): SectionKey {
  switch (stage) {
    case "fire": return "attackNow";
    case "ready": return "ready";
    case "build": return "building";
    case "track": return "watch";
    case "cashed": return "cashed";
    case "missed": return "dead";
  }
}

// Admin-only raw diagnostics — the RDY / HR% / PVUL / peak / engine-path values
// that used to clutter every card now live ONLY here, behind the drawer and the
// admin gate (spec: raw labels hidden unless admin/debug).
function DrawerAdminDiagnostics({ entry }: { entry: HrRadarLadderEntry }) {
  const rows: Array<[string, string]> = [];
  const num = (v: number | null | undefined, d = 1) => (v == null ? null : Number(v).toFixed(d));
  const rdy = num(entry.currentReadinessScore, 0);
  const bld = num(entry.buildScore, 0);
  const conv = num(entry.conversionProbability != null && entry.conversionProbability <= 1 ? entry.conversionProbability * 100 : entry.conversionProbability, 0);
  const pvul = num(entry.pitcherHrVulnerability, 0);
  const peak = num(entry.peakSignalScore10 ?? entry.peakScore, 1);
  if (rdy != null) rows.push(["RDY", rdy]);
  if (bld != null) rows.push(["BUILD", bld]);
  if (conv != null) rows.push(["HR%", `${conv}%`]);
  if (pvul != null) rows.push(["PVUL", pvul]);
  if (peak != null) rows.push(["PEAK", `${peak}/10`]);
  if (entry.enginePath) rows.push(["PATH", entry.enginePath]);
  if (rows.length === 0 && !(entry.debugReasons && entry.debugReasons.length)) return null;
  return (
    <div className="mt-3 rounded-lg border border-purple-500/30 bg-purple-500/5 p-2.5" data-testid="drawer-admin-diagnostics">
      <div className="text-[9px] font-bold uppercase tracking-wider text-purple-300 mb-1.5">Admin · raw diagnostics</div>
      <div className="grid grid-cols-3 gap-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-1 rounded bg-background/40 px-1.5 py-1">
            <span className="text-[9px] text-muted-foreground">{k}</span>
            <span className="text-[10px] font-mono font-semibold text-foreground">{v}</span>
          </div>
        ))}
      </div>
      {entry.debugReasons && entry.debugReasons.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {entry.debugReasons.slice(0, 6).map((r, i) => (
            <li key={i} className="text-[9px] font-mono text-muted-foreground/80 truncate">• {r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Signal drawer — the deep diagnostic card. Opens on a table-row click and
// reuses the full LadderCard (drivers, distance-to-fire, breakdown, AB log,
// trajectory) so power users keep every detail, scoped to one player. ────────
function HrRadarSignalDrawer({
  row,
  isAdmin,
  onClose,
  onAddToSlip,
  onOpenDetails,
  onPass,
  onAccept,
  isAccepted,
}: {
  row: HrRadarCardViewModel | null;
  isAdmin: boolean;
  onClose: () => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  onPass: (entry: HrRadarLadderEntry) => void;
  onAccept: (entry: HrRadarLadderEntry) => void;
  isAccepted: boolean;
}) {
  if (!row) return null;
  const section = stageToSectionKey(row.stage);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" data-testid="hr-signal-drawer">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} data-testid="drawer-backdrop" />
      <div
        className="relative w-full sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-border bg-background p-4 shadow-2xl animate-fade-in-up"
        style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom, 16px))" }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Signal detail</span>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted/50 text-muted-foreground hover:text-foreground" data-testid="button-drawer-close" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <LadderCard
          entry={row.entry}
          section={section}
          onAddToSlip={onAddToSlip}
          onOpenDetails={onOpenDetails}
          onPass={onPass}
          onAccept={onAccept}
          isAccepted={isAccepted}
        />
        {isAdmin && <DrawerAdminDiagnostics entry={row.entry} />}
      </div>
    </div>
  );
}

interface HrRadarLadderProps {
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  // Phase 4 — viewer is an admin. Used to gate calibration-only rows
  // (uncalled_hr, early_hr_insufficient_sample) in the dead section so
  // regular users don't see admin diagnostics. Defaults to false.
  isAdmin?: boolean;
  // Slate ribbon deep-link. When set, the ladder shows only rows for this
  // gameId — a pure presentational filter (no engine/scoring change). Null /
  // undefined = show all games (no-op).
  selectedGameId?: string | null;
}

export function HrRadarLadder({ onAddToSlip, onOpenDetails, isAdmin = false, selectedGameId = null }: HrRadarLadderProps) {
  // ── HOOKS — all hook calls live above ANY early return so the call
  // count is identical between renders (React invariant; violating it
  // throws "Rendered more hooks than during the previous render").
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hideFinished, setHideFinished] = useState(false);
  // Open diagnostic drawer (compact-table row click). Must sit with the other
  // hooks, above any early return, to keep the hook order stable.
  const [drawerRow, setDrawerRow] = useState<HrRadarCardViewModel | null>(null);
  const { data, isLoading, isFetching, error, dataUpdatedAt } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    // Master Fix Step 15 — short poll for live decision-engine cadence,
    // refetch on focus/reconnect so a backgrounded tab snaps back to truth
    // without manual reload.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev,
  });

  // Derived shapes — safe defaults so dependent hooks below run cleanly
  // even before data has arrived.
  const rawSections = data?.sections ?? { attackNow: [], building: [], watch: [], cashed: [], dead: [] };
  const sessionDate = data?.sessionDate ?? "";

  // Task #121 Step 3 — per-session "Pass" dismiss list, persisted in
  // localStorage. Re-read on session-date change so tomorrow's session is
  // clean. Live (Watch / Building / AttackNow) entries dismissed by the
  // user are filtered out; cashed / dead are never auto-hidden by Pass.
  //
  // Synchronous re-derivation pattern: when `sessionDate` changes (first
  // load, or day rollover), we update the sets *during* render via the
  // tracked-prop guard. This avoids the one-frame unfiltered flicker that
  // would happen if we waited for a useEffect to re-sync after commit.
  // See: react.dev/reference/react/useState#storing-information-from-previous-renders
  const [trackedSessionDate, setTrackedSessionDate] = useState<string>(sessionDate);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissed(sessionDate));
  const [accepted, setAccepted] = useState<Set<string>>(() => readAccepted(sessionDate));

  // Task #121 Step 5 — one-time pulse when an entry transitions into cashed.
  // The `cashedInitializedRef` baseline guard prevents the pulse from firing
  // on the FIRST payload (otherwise every cashed card on initial load would
  // animate). Pulse fires only on subsequent additions during the session.
  //
  // IMPORTANT: do NOT seed the baseline against the empty default
  // `rawSections` we expose during the loading state — that would treat
  // every real cashed row as "newly added" once data arrives. We gate on
  // `sessionDate` (truthy only after real data is hydrated) so the
  // baseline is captured from the first REAL payload, not the placeholder.
  const previousCashedKeysRef = useRef<Set<string>>(new Set());
  const cashedInitializedRef = useRef<boolean>(false);
  const [freshlyCashedKeys, setFreshlyCashedKeys] = useState<Set<string>>(new Set());

  // Session rollover handler — runs synchronously during render whenever
  // sessionDate changes (first hydration OR day rollover). Re-derives
  // persisted Pass/Accept sets and resets the cashed-pulse baseline so a
  // new day's first payload doesn't animate prior-day cashed entries.
  if (sessionDate !== trackedSessionDate) {
    setTrackedSessionDate(sessionDate);
    setDismissed(readDismissed(sessionDate));
    setAccepted(readAccepted(sessionDate));
    cashedInitializedRef.current = false;
    previousCashedKeysRef.current = new Set();
    setFreshlyCashedKeys(new Set());
  }

  const sections = useMemo(() => {
    // Slate-ribbon deep-link filter — presentational only. No-op when null.
    const filterByGame = (list: HrRadarLadderEntry[]): HrRadarLadderEntry[] =>
      selectedGameId ? list.filter(e => e.gameId === selectedGameId) : list;
    const filterDismissed = (list: HrRadarLadderEntry[]): HrRadarLadderEntry[] =>
      filterByGame(list).filter(e => !dismissed.has(entryDismissKey(e.playerId, e.gameId)));
    // Phase 6 — predicate for "live game, no AB tracked yet". Engine score
    // is necessarily 0.0/10 for these rows, so they pollute the live decision
    // sections. We only re-shelve when the game is KNOWN to be live
    // (`hasLiveABContext === true`); pure pregame entries (game not started,
    // hasLiveABContext === false / undefined) keep their normal placement.
    const isLiveButNoAb = (e: HrRadarLadderEntry): boolean =>
      e.hasLiveABContext === true && (e.plateAppearancesTracked ?? 0) === 0;
    const partitionLive = (list: HrRadarLadderEntry[]): {
      keep: HrRadarLadderEntry[];
      parked: HrRadarLadderEntry[];
    } => {
      const keep: HrRadarLadderEntry[] = [];
      const parked: HrRadarLadderEntry[] = [];
      for (const e of list) (isLiveButNoAb(e) ? parked : keep).push(e);
      return { keep, parked };
    };
    // Batch A — Phase 8: final-game reconciliation guard. Any row whose
    // game has gone final must NOT appear in an active live section
    // (FIRE/READY/BUILD/WATCH) — even if the server briefly flagged it
    // there before the next reconcile tick. The server already stamps
    // isGameFinal at the request boundary; we enforce the contract here
    // by filtering out final-game rows from active sections.
    const filterActiveLive = (list: HrRadarLadderEntry[]): HrRadarLadderEntry[] =>
      list.filter((e) => e.isGameFinal !== true);
    // Hide pregame-only rows (no live at-bat yet) from the live decision
    // sections — they carry a generic pregame seed score and flood READY with
    // near-identical rows. They reappear automatically once the player bats.
    const filterPregame = (list: HrRadarLadderEntry[]): HrRadarLadderEntry[] =>
      list.filter((e) => !isPregameOnlyRow(e as unknown as HrRadarRowInput));
    const attackP = partitionLive(filterPregame(filterActiveLive(filterDismissed(rawSections.attackNow ?? []))));
    const readyP = partitionLive(filterPregame(filterActiveLive(filterDismissed((rawSections as any).ready ?? []))));
    const buildingP = partitionLive(filterPregame(filterActiveLive(filterDismissed(rawSections.building ?? []))));
    const watchP = partitionLive(filterPregame(filterActiveLive(filterDismissed(rawSections.watch ?? []))));
    // Batch A — Phase 5: split admin-only outcomes (uncalled_hr,
    // early_hr_insufficient_sample) into a separate Model Review bucket
    // so they don't pollute the user-facing MISSED column. Non-admins
    // never see Model Review at all (controlled by `order` array below).
    const allDead = filterByGame(rawSections.dead ?? []);
    const userMissed = allDead.filter(
      (e) => !ADMIN_ONLY_DEAD_STATUSES.has((e.outcomeStatus ?? "") as string),
    );
    const adminModelReview = allDead.filter((e) =>
      ADMIN_ONLY_DEAD_STATUSES.has((e.outcomeStatus ?? "") as string),
    );
    return {
      attackNow: attackP.keep,
      // Goldmaster v1 — additive Ready bucket (filtered like other live sections).
      ready: readyP.keep,
      building: buildingP.keep,
      watch: watchP.keep,
      // Phase 6 — collapsed parking lot for live-but-no-AB rows. Single
      // bucket so users see all parked entries together instead of each
      // tier carrying a 0.0 zombie row. CTAs are disabled (see canAdd
      // gating in LadderCard via `isLiveSection` check).
      noAbYet: [
        ...attackP.parked,
        ...readyP.parked,
        ...buildingP.parked,
        ...watchP.parked,
      ],
      cashed: filterByGame(rawSections.cashed ?? []),
      dead: userMissed,
      modelReview: adminModelReview,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSections, dismissed, isAdmin, selectedGameId]);

  useEffect(() => {
    if (!sessionDate) return;
    const currentKeys = new Set(sections.cashed.map(e => entryDismissKey(e.playerId, e.gameId)));
    if (!cashedInitializedRef.current) {
      // Seed baseline silently on the first REAL payload — no animation.
      previousCashedKeysRef.current = currentKeys;
      cashedInitializedRef.current = true;
      return;
    }
    const newlyAdded = new Set<string>();
    for (const k of Array.from(currentKeys)) {
      if (!previousCashedKeysRef.current.has(k)) newlyAdded.add(k);
    }
    previousCashedKeysRef.current = currentKeys;
    if (newlyAdded.size > 0) {
      setFreshlyCashedKeys(newlyAdded);
      const t = window.setTimeout(() => setFreshlyCashedKeys(new Set()), 2400);
      return () => window.clearTimeout(t);
    }
  }, [sessionDate, sections.cashed]);

  // ── EARLY RETURNS — only after every hook above has been called.
  if (isLoading && !data) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-24 rounded-lg bg-muted/20 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-4 border-destructive/40 bg-destructive/5" data-testid="ladder-error">
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="w-4 h-4" />
          <span>Failed to load HR radar ladder.</span>
        </div>
      </Card>
    );
  }

  // ── Plain helpers / derived values (no hooks).
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar/ladder"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/mlb/hr-radar"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/mlb/alerts"] }),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const lastUpdatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;

  const handlePass = (entry: HrRadarLadderEntry) => {
    const key = entryDismissKey(entry.playerId, entry.gameId);
    setDismissed(prev => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      writeDismissed(sessionDate, next);
      return next;
    });
  };
  const handleAccept = (entry: HrRadarLadderEntry) => {
    const key = entryDismissKey(entry.playerId, entry.gameId);
    setAccepted(prev => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      writeAccepted(sessionDate, next);
      return next;
    });
  };

  const counts = {
    attackNow: sections.attackNow.length,
    ready: sections.ready.length,
    building: sections.building.length,
    watch: sections.watch.length,
    cashed: sections.cashed.length,
    dead: sections.dead.length,
    // Phase 6 — `noAbYet` not surfaced in the public counts shape (the
    // header summary displayed to users only counts actionable sections).
    total: sections.attackNow.length + sections.ready.length + sections.building.length + sections.watch.length + sections.cashed.length + sections.dead.length,
  };

  // Phase 6 — `noAbYet` slots between the active live tiers and resolved
  // sections so users see the parking lot only after scrolling past
  // actionable rows. Hidden when empty (handled by LadderSection's
  // empty-state branch already).
  // Batch A — Phase 5: `modelReview` only appears for admins, at the very
  // bottom (after CASHED + MISSED) so it never competes with user-facing
  // sections. Hidden completely when not admin.
  // Single user-facing ladder, rendered top-down in order of conviction:
  // Fire → Ready → Build → Track. (Fire + Ready are the graded "HR Max Window"
  // tier, surfaced via a per-card badge rather than a merged section.)
  const allOrder: SectionKey[] = isAdmin
    ? ["attackNow", "ready", "building", "watch", "noAbYet", "cashed", "dead", "modelReview"]
    : ["attackNow", "ready", "building", "watch", "noAbYet", "cashed", "dead"];
  const order: SectionKey[] = hideFinished
    ? allOrder.filter(k => k !== "cashed" && k !== "dead" && k !== "modelReview")
    : allOrder;
  const finishedCount = counts.cashed + counts.dead;
  const refreshSpinning = isRefreshing || isFetching;

  // Flatten the (already-filtered) sections into one compact-table row set,
  // sorted in-table by stage→score. `noAbYet` parking-lot rows stay out of the
  // table (pregame 0-AB noise); resolved rows carry their authoritative
  // cashed/missed section hint so the public stage is engine truth.
  const sectionHintFor = (k: SectionKey): "cashed" | "missed" | undefined =>
    k === "cashed" ? "cashed" : k === "dead" || k === "modelReview" ? "missed" : undefined;
  const tableRows: HrRadarCardViewModel[] = [];
  for (const k of order) {
    if (k === "noAbYet") continue;
    for (const e of (sections as Record<SectionKey, HrRadarLadderEntry[]>)[k] ?? []) {
      tableRows.push(buildHrRadarCardViewModel(e, { sectionHint: sectionHintFor(k) }));
    }
  }
  const drawerAccepted = drawerRow
    ? accepted.has(entryDismissKey(drawerRow.playerId, drawerRow.gameId))
    : false;

  return (
    <div className="space-y-3" data-testid="hr-radar-ladder">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground px-1">
        <div className="flex items-center gap-2 min-w-0">
          <span data-testid="text-ladder-session-date" className="truncate">
            Session: {data?.sessionDate || "—"}
          </span>
          {lastUpdatedLabel && (
            <span className="text-muted-foreground/60 hidden sm:inline" data-testid="text-ladder-last-updated">
              · updated {lastUpdatedLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span data-testid="text-ladder-total" title="Live HR Radar signals this session.">
            {counts.attackNow + counts.ready + counts.building + counts.watch} live
            {counts.cashed > 0 && <span className="text-emerald-400/80"> · {counts.cashed} cashed</span>}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1 text-[11px]"
            onClick={() => setHideFinished(v => !v)}
            disabled={finishedCount === 0 && !hideFinished}
            data-testid="button-ladder-clear-finished"
            title={hideFinished ? "Show finished games" : "Hide cashed and missed games"}
          >
            <Eraser className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">
              {hideFinished ? `Show finished (${finishedCount})` : `Clear finished${finishedCount > 0 ? ` (${finishedCount})` : ""}`}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 gap-1 text-[11px]"
            onClick={handleRefresh}
            disabled={refreshSpinning}
            data-testid="button-ladder-refresh"
            title="Refresh HR radar"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshSpinning ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>
      {/* Section count summary — sticky so the radar state is always visible
          while scrolling through the sections. Only shows non-zero counts. */}
      {counts.total > 0 && (
        <div
          className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm pb-1"
          data-testid="ladder-summary-bar-wrapper"
        >
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 rounded-lg bg-card border border-border/40"
          data-testid="ladder-summary-bar"
        >
          {/* Unified public ladder vocabulary — FIRE · READY · BUILD · TRACK. */}
          {counts.attackNow > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-bold whitespace-nowrap text-red-400" data-testid="summary-fire">
              <Flame className="w-3 h-3" /> FIRE {counts.attackNow}
            </span>
          )}
          {counts.ready > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-bold whitespace-nowrap text-orange-400" data-testid="summary-ready">
              <Zap className="w-3 h-3" /> READY {counts.ready}
            </span>
          )}
          {counts.building > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-blue-400" data-testid="summary-build">
              <Zap className="w-3 h-3" /> BUILD {counts.building}
            </span>
          )}
          {counts.watch > 0 && (
            <span className="flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-slate-400" data-testid="summary-track">
              <Eye className="w-3 h-3" /> TRACK {counts.watch}
            </span>
          )}
          {counts.cashed > 0 && (
            <>
              <span className="text-muted-foreground/30 text-[11px]">·</span>
              <span className="flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap text-emerald-400" data-testid="summary-cashed">
                <Trophy className="w-3 h-3" /> {counts.cashed} HR
              </span>
            </>
          )}
          {counts.dead > 0 && (
            <span className="text-[11px] text-muted-foreground/50 whitespace-nowrap" data-testid="summary-missed">
              {counts.dead} missed
            </span>
          )}
        </div>
        </div>
      )}
      {/* Compact command table — sortable rows, click to open the deep
          diagnostic drawer. Replaces the stack of giant expanded section
          cards. */}
      {tableRows.length > 0 && (
        <HrRadarFullLadderTable
          rows={tableRows}
          onRowClick={setDrawerRow}
          onAddToSlip={onAddToSlip}
          onOpenDetails={onOpenDetails}
          onPass={handlePass}
          onAccept={handleAccept}
          isAccepted={(entry) => accepted.has(entryDismissKey(entry.playerId, entry.gameId))}
        />
      )}
      {counts.total === 0 && (
        <Card className="p-6 text-center" data-testid="ladder-empty-state">
          <div className="text-sm text-muted-foreground">
            No HR radar activity yet for this session.
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            Signals will appear here as games progress.
          </div>
        </Card>
      )}

      <HrRadarSignalDrawer
        row={drawerRow}
        isAdmin={isAdmin}
        onClose={() => setDrawerRow(null)}
        onAddToSlip={onAddToSlip}
        onOpenDetails={onOpenDetails}
        onPass={(entry) => { handlePass(entry); setDrawerRow(null); }}
        onAccept={handleAccept}
        isAccepted={drawerAccepted}
      />
    </div>
  );
}
