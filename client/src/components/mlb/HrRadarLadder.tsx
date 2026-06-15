import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Flame, Zap, Eye, Trophy, XCircle, Plus, AlertTriangle, RefreshCw, Eraser, X, ArrowRight, Clock, DollarSign, Share2 } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { getMlbInningWindow, getMlbInningWindowLabel, type MlbInningWindow } from "@shared/mlbInningWindow";

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

  // ── Goldmaster v1 — additive user-facing stage layer (optional). ──────────
  userStage?: "track" | "build" | "ready" | "fire" | "resolved";
  stageLabel?: string;
  stageDescription?: string;
  qualifyingSignals?: string[];
  cleanReasons?: string[];
  officialSignalStage?: "ready" | "fire" | null;
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
  // Phase 2.5 HR Watch Bridge — additive surface for near-HR contact
  // detections that the engine has stamped on a qualified signal but that
  // don't (yet) live in the canonical ladder buckets. Optional so older
  // server payloads still type-check.
  hrWatch?: HrWatchBridgeEntry[];
}

export interface HrWatchBridgeEntry {
  playerId: string;
  playerName: string;
  team: string | null;
  gameId: string;
  market: string;
  signalScore: number | null;
  signalTier: string | null;
  nearHrEv: number | null;
  nearHrLa: number | null;
  nearHrDistance: number | null;
  nearHrXba: number | null;
  engineGeneratedAt: number | null;
}

// Phase 6 — `noAbYet` is an additive parking lot for live games where the
// player still has zero tracked PAs. Keeps the engine's bucket assignment
// intact server-side; only the UI re-shelves these rows so the live decision
// sections (FIRE/READY/BUILD/WATCH) stop showing 0.0/10 pregame noise.
// Batch A — `modelReview` is an admin-only bucket that holds uncalled_hr /
// early_hr_insufficient_sample rows so they don't pollute MISSED.
type SectionKey =
  | "attackNow"
  | "building"
  | "ready"
  | "watch"
  | "noAbYet"
  | "cashed"
  | "dead"
  | "modelReview";

const SECTION_META: Record<SectionKey, {
  label: string;
  icon: typeof Flame;
  accent: string;
  badge: string;
  description: string;
  defaultCollapsed: boolean;
}> = {
  attackNow: {
    // Batch A — display label is FIRE per product brief. Server enum stays attackNow.
    label: "FIRE",
    icon: Flame,
    accent: "border-red-500/40 bg-red-500/5",
    badge: "bg-red-500 text-white",
    description: "Highest-conviction HR signals firing right now.",
    defaultCollapsed: false,
  },
  ready: {
    label: "READY",
    icon: Zap,
    accent: "border-orange-500/40 bg-orange-500/5",
    badge: "bg-orange-500 text-white",
    description: "Playable HR setup — contact quality and matchup are aligned.",
    defaultCollapsed: false,
  },
  building: {
    // Batch A — display label is BUILD per product brief.
    label: "BUILD",
    icon: Zap,
    accent: "border-amber-500/40 bg-amber-500/5",
    badge: "bg-amber-500 text-white",
    description: "Pattern is building — one more quality contact could move this up.",
    defaultCollapsed: false,
  },
  watch: {
    // Batch A — display label is WATCH per product brief (was "TRACK").
    label: "WATCH",
    icon: Eye,
    accent: "border-blue-500/30 bg-blue-500/5",
    badge: "bg-blue-500 text-white",
    description: "Watching. HR conditions are forming, not actionable yet.",
    defaultCollapsed: false, // dynamic — collapses when >8 entries (see LadderSection)
  },
  // Phase 6 — additive bucket. Holds rows whose game is live but the player
  // has zero tracked PAs yet (engine score is necessarily 0.0/10). Hidden by
  // default and CTA-disabled so the live decision sections stay clean.
  noAbYet: {
    label: "NO AB YET",
    icon: Eye,
    accent: "border-zinc-500/30 bg-zinc-500/5",
    badge: "bg-zinc-600 text-white",
    description: "Game is live, no plate appearance tracked yet — parked here until the first AB.",
    defaultCollapsed: true,
  },
  cashed: {
    label: "CASHED",
    icon: Trophy,
    accent: "border-emerald-500/40 bg-emerald-500/5",
    badge: "bg-emerald-500 text-white",
    description: "HR confirmed after a called signal.",
    defaultCollapsed: false,
  },
  dead: {
    // Batch A — display label is MISSED (was "DEAD / MISSED"). Per the
    // product brief, dead/missed should be minimized and collapsed by
    // default so it doesn't dominate the screen.
    label: "MISSED",
    icon: XCircle,
    accent: "border-zinc-500/30 bg-zinc-500/5",
    badge: "bg-zinc-500 text-white",
    description: "Signals that resolved without an HR.",
    defaultCollapsed: true,
  },
  // Batch A — admin-only Model Review bucket. Surfaces uncalled_hr +
  // early_hr_insufficient_sample so admins can review WHY the engine missed
  // them, without polluting the user-facing MISSED column.
  modelReview: {
    label: "MODEL REVIEW",
    icon: AlertTriangle,
    accent: "border-purple-500/30 bg-purple-500/5",
    badge: "bg-purple-600 text-white",
    description: "Admin-only. Uncalled HRs and first-AB HRs flagged for engine calibration.",
    defaultCollapsed: true,
  },
};

// Batch A — Phase 1: per-section visible-by-default card caps. When the
// section has more entries than the cap, the rest are collapsed behind a
// "Show all (N)" button so users see the most important rows first.
// FIRE 5 / READY 8 / BUILD 5 / WATCH 8. Cashed/missed/modelReview/noAbYet
// don't need card-cap (they're already collapsed sections).
const SECTION_CARD_CAPS: Partial<Record<SectionKey, number>> = {
  attackNow: 5,
  ready: 8,
  building: 5,
  watch: 8,
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
  // Convert snake_case / SCREAMING_CASE leftovers to "Sentence case".
  if (/^[A-Z0-9_]+$/.test(trimmed) || /_/.test(trimmed)) {
    const sentence = trimmed
      .replace(/_/g, " ")
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
  return !/^(PATH[_ ]?[A-Z0-9_]+|WATCH:|BUILD:|FORM:|PRE[_ ]HR[_ ]DANGER|HrShaped|BsZ|Score\d|Conv\s+\d+%|Profile\d|Danger\d)/i.test(s.trim());
}

interface CardProps {
  entry: HrRadarLadderEntry;
  section: SectionKey;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  onPass?: (entry: HrRadarLadderEntry) => void;
  onAccept?: (entry: HrRadarLadderEntry) => void;
  isAccepted?: boolean;
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
}: {
  initial: number;
  current: number;
  peak: number;
  playerId: string;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(10, n));
  const ci = clamp(initial);
  const cc = clamp(current);
  const cp = clamp(peak);
  const pct = (n: number) => `${(n / 10) * 100}%`;
  const climb = cc - ci;
  const trackColor =
    climb >= 0.5 ? "bg-emerald-500/30" : climb <= -0.5 ? "bg-orange-500/30" : "bg-muted";
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

function LadderCard({ entry, section, onAddToSlip, onOpenDetails, onPass, onAccept, isAccepted }: CardProps) {
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
  const score10 =
    entry.displayCurrentScore10 ??
    entry.currentSignalScore10 ??
    (entry.currentReadinessScore != null ? Math.round(entry.currentReadinessScore) / 10 : null) ??
    (entry.signalStrengthScore != null ? Math.round(entry.signalStrengthScore) / 10 : null) ??
    (entry.peakSignalScore10 ?? null);
  const initial10 =
    entry.displayInitialScore10 ??
    entry.initialSignalScore10 ??
    (entry.initialReadinessScore != null ? Math.round(entry.initialReadinessScore) / 10 : null);
  const peak10 =
    entry.displayPeakScore10 ??
    entry.peakSignalScore10 ??
    (entry.peakReadinessScore != null ? Math.round(entry.peakReadinessScore) / 10 : null) ??
    (entry.peakScore != null ? Math.round(entry.peakScore) / 10 : null);
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
  const isAttack = section === "attackNow";
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
    (entry as any).isGameFinal === true;
  // Task #121 Step 3 — Take it / Pass are available on every LIVE card
  // (Attack Now / Building / Watch). Resolved sections (cashed/dead) get
  // no actions.
  const isLiveSection = section === "attackNow" || section === "building" || section === "watch";
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
  // Outcome label for resolved rows uses the canonical outcome when present.
  const resolvedOutcomeKey = entry.outcome ?? entry.outcomeStatus;

  const [shareLoading, setShareLoading] = useState(false);
  const handleShare = async () => {
    if (shareLoading) return;
    setShareLoading(true);
    try {
      const score10Val = entry.displayCurrentScore10 ?? entry.currentSignalScore10 ?? null;
      const params = new URLSearchParams({
        playerName: entry.playerName,
        team: entry.team,
        stage: entry.userStage ?? entry.currentStage ?? "track",
        ...(score10Val != null       ? { score10:      String(score10Val) }                                       : {}),
        ...(entry.currentReadinessScore != null ? { readinessPct: String(entry.currentReadinessScore) }          : {}),
        ...(entry.conversionProbability != null ? { hrProbPct:    String(entry.conversionProbability * 100) }    : {}),
        ...(entry.headlineReason        ? { headline:     entry.headlineReason }                                  : {}),
      });
      const resp = await fetch(`/api/mlb/hr-radar/share-card?${params.toString()}`);
      if (!resp.ok) throw new Error("share-card failed");
      const { shareId, tweetText } = await resp.json() as { shareId: string; tweetText: string };
      const shareUrl = `${window.location.origin}/share/hr/${shareId}`;
      const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(shareUrl)}`;
      window.open(intent, "_blank", "noopener,noreferrer,width=600,height=450");
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
      className="rounded-lg border border-border/60 bg-background/50 p-3 hover:bg-background/80 transition-colors"
      data-testid={`ladder-card-${section}-${entry.playerId}`}
    >
      <div className="flex items-start justify-between gap-2 min-w-0">
        <button
          className="text-left min-w-0 flex-1 overflow-hidden"
          onClick={() => onOpenDetails?.(entry)}
          data-testid={`button-open-ladder-details-${entry.playerId}`}
        >
          <div className="flex items-center gap-2 mb-0.5 min-w-0">
            <span className="font-bold text-sm truncate min-w-0" data-testid={`text-ladder-player-${entry.playerId}`}>
              {entry.playerName}
            </span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0">
              {entry.team}
            </span>
          </div>
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
                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap"
                style={{ color: inningWindowPill.color, borderColor: `${inningWindowPill.color}40`, background: `${inningWindowPill.color}10` }}
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
          {score10 != null && !isResolved && (
            <div className="flex items-baseline gap-1">
              <span
                className={`text-base font-mono font-bold leading-none ${isAttack ? "text-red-400" : "text-foreground/90"}`}
                data-testid={`text-signal-score-10-${entry.playerId}`}
              >
                {/* Goldmaster RESTORE — USER-FACING 10-point score with one
                    decimal. Internal 0-100 is never shown as the primary
                    number on the user surface. */}
                {score10.toFixed(1)}
              </span>
              <span className="text-[9px] text-muted-foreground leading-none">/ 10</span>
            </div>
          )}
          {/* Heating-up meter (live rows only). Three-stop indicator showing
              initial → current → peak on the 10-point scale. */}
          {!isResolved && score10 != null && initial10 != null && peak10 != null && (
            <HeatingUpMeter
              initial={initial10}
              current={score10}
              peak={peak10}
              playerId={entry.playerId}
            />
          )}
          {!isResolved && momentumDisplay && (
            <span
              className={`text-[9px] font-medium px-1.5 py-0 rounded border ${momentumDisplay.color}`}
              data-testid={`text-momentum-${entry.playerId}`}
            >
              {momentumDisplay.label}
            </span>
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
      {isResolved && entry.summary && (
        <p
          className="mt-2 text-[11px] text-foreground/70 leading-snug"
          data-testid={`text-resolved-summary-${entry.playerId}`}
        >
          {entry.summary}
        </p>
      )}
      {/* Goldmaster Phase 4-7 — for live rows, render the canonical
          stageExplanation as a single-line summary (server is the source of
          truth). Then list the deduplicated headline + supporting reasons.
          Pregame zero-AB rows show the pregame headline only — no contact
          bullets. */}
      {!isResolved && entry.stageExplanation && (
        <p
          className="mt-2 text-[11px] text-foreground/70 leading-snug"
          data-testid={`text-stage-explanation-${entry.playerId}`}
        >
          {entry.stageExplanation}
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

      {/* HR Breakdown — 4-bar mini panel */}
      {!isResolved && (() => {
        const bars: Array<{ label: string; pct: number | null; isHrProb?: boolean }> = [
          { label: "Formation",    pct: entry.buildScore != null ? Math.min(100, Math.round(entry.buildScore * 10)) : null },
          { label: "Readiness",    pct: entry.currentReadinessScore != null ? Math.min(100, Math.round(entry.currentReadinessScore)) : null },
          { label: "HR Prob",      pct: entry.conversionProbability != null ? Math.min(100, Math.round(entry.conversionProbability * 100)) : null, isHrProb: true },
          { label: "Pitcher Vuln", pct: entry.pitcherHrVulnerability != null ? Math.min(100, Math.round(entry.pitcherHrVulnerability)) : null },
        ];
        if (bars.filter(b => b.pct != null).length < 2) return null;
        return (
          <div
            className="mt-2 rounded-lg p-2.5 bg-secondary/20 border border-border/20"
            data-testid={`panel-hr-breakdown-${entry.playerId}`}
          >
            <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
              HR Breakdown
            </div>
            <div className="space-y-1">
              {bars.map(({ label, pct, isHrProb }) => {
                if (pct == null) return null;
                const color = hrBreakdownBar(pct, isHrProb);
                return (
                  <div key={label} className="flex items-center justify-between gap-2">
                    <span className="text-[9px] text-muted-foreground truncate">{label}</span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-full bg-secondary/60 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                      <span
                        className="text-[8px] font-bold tabular-nums w-5 text-right"
                        style={{ color }}
                      >
                        {pct}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Batch A — Phase 3: timing labels. "Game final — resolved" beats
          everything when isGameFinal is true on a card that briefly slipped
          into a live section. Otherwise we show the remaining-PA / late-window
          / next-PA-soon / expires-after copy based on currentInning + PA. */}
      {(entry as any).isGameFinal && !isResolved && (
        <div
          className="mt-2 flex items-center gap-1 text-[11px] text-zinc-400"
          data-testid={`text-game-final-${entry.playerId}`}
        >
          <Clock className="w-3 h-3" />
          <span>Game final — resolved</span>
        </div>
      )}
      {!isResolved && !(entry as any).isGameFinal && entry.remainingPAExpectation != null && entry.remainingPAExpectation > 0 && (() => {
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
        // Phase 3 timing-label copy. We pick the SINGLE most informative
        // label rather than stacking — e.g. "Late-window only" already
        // implies short PA, so we don't add "~1 PA left" on top.
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
            className={`mt-2 flex items-center gap-1 text-[11px] ${tone}`}
            data-testid={`text-remaining-window-${entry.playerId}`}
          >
            <Clock className="w-3 h-3" />
            <span>{label}</span>
          </div>
        );
      })()}

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

interface LadderSectionProps {
  sectionKey: SectionKey;
  entries: HrRadarLadderEntry[];
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  onPass?: (entry: HrRadarLadderEntry) => void;
  onAccept?: (entry: HrRadarLadderEntry) => void;
  acceptedKeys?: Set<string>;
  freshlyCashedKeys?: Set<string>;
}

function LadderSection({ sectionKey, entries, onAddToSlip, onOpenDetails, onPass, onAccept, acceptedKeys, freshlyCashedKeys }: LadderSectionProps) {
  const meta = SECTION_META[sectionKey];
  // Batch A — Phase 1: WATCH defaults to collapsed when it's holding more
  // than 8 entries (per spec). All other sections honor SECTION_META.
  const dynamicDefaultCollapsed =
    sectionKey === "watch" && entries.length > 8 ? true : meta.defaultCollapsed;
  const [collapsed, setCollapsed] = useState(dynamicDefaultCollapsed);
  // Batch A — Phase 1 (reactive): track whether the user has explicitly
  // toggled the section. If they have, auto-collapse never overrides their
  // choice. If they haven't, WATCH re-evaluates the threshold whenever the
  // entry count crosses 8 (in either direction) so a slowly-growing
  // WATCH list will auto-collapse the moment it exceeds the cap.
  const userToggledRef = useRef(false);
  const handleToggle = () => {
    userToggledRef.current = true;
    setCollapsed((c) => !c);
  };
  useEffect(() => {
    if (sectionKey !== "watch") return;
    if (userToggledRef.current) return;
    const shouldCollapse = entries.length > 8;
    setCollapsed((prev) => (prev === shouldCollapse ? prev : shouldCollapse));
  }, [sectionKey, entries.length]);
  // Batch A — Phase 1: per-section visible-by-default card caps. Anything
  // beyond the cap is hidden behind a "Show all (N)" expander so the user
  // sees the most important rows first without flooding the screen.
  const cap = SECTION_CARD_CAPS[sectionKey] ?? null;
  const [showAll, setShowAll] = useState(false);
  const visibleEntries = cap != null && !showAll && entries.length > cap
    ? entries.slice(0, cap)
    : entries;
  const hiddenCount = entries.length - visibleEntries.length;
  const Icon = meta.icon;

  return (
    <Card className={`${meta.accent} border-2`} data-testid={`section-ladder-${sectionKey}`}>
      <button
        className="w-full flex items-center justify-between gap-2 p-3 text-left min-w-0"
        onClick={handleToggle}
        data-testid={`button-toggle-section-${sectionKey}`}
      >
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          {collapsed ? <ChevronRight className="w-4 h-4 shrink-0" /> : <ChevronDown className="w-4 h-4 shrink-0" />}
          <Icon className="w-4 h-4 shrink-0" />
          <span className="font-bold text-sm tracking-wide whitespace-nowrap">{meta.label}</span>
          <Badge className={`${meta.badge} text-[10px] px-1.5 py-0 shrink-0`} data-testid={`badge-count-${sectionKey}`}>
            {entries.length}
          </Badge>
        </div>
        <span className="text-[10px] text-muted-foreground hidden lg:block truncate min-w-0">
          {meta.description}
        </span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 space-y-2">
          {entries.length === 0 ? (
            <div className="text-[11px] text-muted-foreground italic p-2" data-testid={`text-empty-${sectionKey}`}>
              No entries.
            </div>
          ) : (
            <>
              {visibleEntries.map(e => {
                const dismissKey = entryDismissKey(e.playerId, e.gameId);
                const justCashed = sectionKey === "cashed" && (freshlyCashedKeys?.has(dismissKey) ?? false);
                return (
                  <div
                    key={`${sectionKey}-${e.playerId}-${e.gameId}`}
                    className={justCashed ? "animate-pulse-once" : undefined}
                    data-testid={justCashed ? `wrap-cashed-pulse-${e.playerId}` : undefined}
                  >
                    <LadderCard
                      entry={e}
                      section={sectionKey}
                      onAddToSlip={onAddToSlip}
                      onOpenDetails={onOpenDetails}
                      onPass={onPass}
                      onAccept={onAccept}
                      isAccepted={acceptedKeys?.has(dismissKey) ?? false}
                    />
                  </div>
                );
              })}
              {hiddenCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAll(true)}
                  data-testid={`button-show-all-${sectionKey}`}
                >
                  <ChevronDown className="w-3 h-3 mr-1" />
                  Show all ({hiddenCount} more)
                </Button>
              )}
              {showAll && cap != null && entries.length > cap && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAll(false)}
                  data-testid={`button-show-less-${sectionKey}`}
                >
                  <ChevronRight className="w-3 h-3 mr-1 rotate-90" />
                  Show less
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

interface HrRadarLadderProps {
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  // Phase 4 — viewer is an admin. Used to gate calibration-only rows
  // (uncalled_hr, early_hr_insufficient_sample) in the dead section so
  // regular users don't see admin diagnostics. Defaults to false.
  isAdmin?: boolean;
}

export function HrRadarLadder({ onAddToSlip, onOpenDetails, isAdmin = false }: HrRadarLadderProps) {
  // ── HOOKS — all hook calls live above ANY early return so the call
  // count is identical between renders (React invariant; violating it
  // throws "Rendered more hooks than during the previous render").
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hideFinished, setHideFinished] = useState(false);
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
    const filterDismissed = (list: HrRadarLadderEntry[]): HrRadarLadderEntry[] =>
      list.filter(e => !dismissed.has(entryDismissKey(e.playerId, e.gameId)));
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
      list.filter((e) => (e as any).isGameFinal !== true);
    const attackP = partitionLive(filterActiveLive(filterDismissed(rawSections.attackNow ?? [])));
    const readyP = partitionLive(filterActiveLive(filterDismissed((rawSections as any).ready ?? [])));
    const buildingP = partitionLive(filterActiveLive(filterDismissed(rawSections.building ?? [])));
    const watchP = partitionLive(filterActiveLive(filterDismissed(rawSections.watch ?? [])));
    // Batch A — Phase 5: split admin-only outcomes (uncalled_hr,
    // early_hr_insufficient_sample) into a separate Model Review bucket
    // so they don't pollute the user-facing MISSED column. Non-admins
    // never see Model Review at all (controlled by `order` array below).
    const allDead = rawSections.dead ?? [];
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
      cashed: rawSections.cashed ?? [],
      dead: userMissed,
      modelReview: adminModelReview,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSections, dismissed, isAdmin]);

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
  const allOrder: SectionKey[] = isAdmin
    ? ["attackNow", "ready", "building", "watch", "noAbYet", "cashed", "dead", "modelReview"]
    : ["attackNow", "ready", "building", "watch", "noAbYet", "cashed", "dead"];
  const order: SectionKey[] = hideFinished
    ? allOrder.filter(k => k !== "cashed" && k !== "dead" && k !== "modelReview")
    : allOrder;
  const finishedCount = counts.cashed + counts.dead;
  const refreshSpinning = isRefreshing || isFetching;

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
          <span data-testid="text-ladder-total">
            {counts.total} tracked
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
      {/* Phase 2.5 HR Watch Bridge — surfaces engine-stamped near-HR
          contact detections (signalType="hr_watch") so admins/users can see
          that the engine IS detecting near-HR plays even when the ladder
          buckets are empty. Pure additive read; never affects bucket order. */}
      {(data?.hrWatch?.length ?? 0) > 0 && (
        <Card className="p-3 border-amber-500/30 bg-amber-500/5" data-testid="hr-watch-bridge-section">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">HR Watch · Near-HR Contact</span>
            <span className="text-[10px] text-muted-foreground">
              {data!.hrWatch!.length} live · engine-detected near-HR drivers
            </span>
          </div>
          <div className="space-y-1">
            {data!.hrWatch!.slice(0, 12).map((w, i) => (
              <div
                key={`${w.playerId}-${w.gameId}-${w.market}-${i}`}
                className="flex items-center justify-between gap-2 text-[11px] px-2 py-1.5 rounded border border-border/40 bg-background/40"
                data-testid={`row-hr-watch-bridge-${w.playerId}`}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="font-semibold truncate">{w.playerName || w.playerId}</span>
                  {w.team && <span className="text-muted-foreground shrink-0">{w.team}</span>}
                  <span className="text-muted-foreground shrink-0">· {w.market}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {w.nearHrEv != null && <span className="text-muted-foreground">EV {w.nearHrEv.toFixed(0)}</span>}
                  {w.nearHrLa != null && <span className="text-muted-foreground">LA {w.nearHrLa.toFixed(0)}°</span>}
                  {w.nearHrDistance != null && <span className="text-muted-foreground">{w.nearHrDistance.toFixed(0)}ft</span>}
                  {w.signalTier && <span className="text-amber-400 font-bold uppercase">{w.signalTier}</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {order.map(key => {
        // Phase 6 — never render the parking lot section when empty;
        // its only value is grouping, so an empty "NO AB YET" header
        // would just be noise in its own right.
        if (key === "noAbYet" && sections.noAbYet.length === 0) return null;
        // Batch A — Phase 5: same rule for admin Model Review — empty
        // section adds no signal, hide it.
        if (key === "modelReview" && (sections as any).modelReview?.length === 0) return null;
        return (
          <LadderSection
            key={key}
            sectionKey={key}
            entries={sections[key]}
            onAddToSlip={onAddToSlip}
            onOpenDetails={onOpenDetails}
            onPass={handlePass}
            onAccept={handleAccept}
            acceptedKeys={accepted}
            freshlyCashedKeys={freshlyCashedKeys}
          />
        );
      })}
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
    </div>
  );
}
