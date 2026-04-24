import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Flame, Zap, Eye, Trophy, XCircle, Plus, AlertTriangle, RefreshCw, Eraser, X, ArrowRight, Clock, DollarSign } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";

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
  // Goldmaster RESTORE — 10-point USER-FACING signal score (0.0-10.0).
  initialSignalScore10?: number | null;
  currentSignalScore10?: number | null;
  peakSignalScore10?: number | null;
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
}

type SectionKey = "attackNow" | "building" | "ready" | "watch" | "cashed" | "dead";

const SECTION_META: Record<SectionKey, {
  label: string;
  icon: typeof Flame;
  accent: string;
  badge: string;
  description: string;
  defaultCollapsed: boolean;
}> = {
  attackNow: {
    // Goldmaster v1 — relabeled from "ATTACK NOW" to "FIRE" for the new
    // Track / Build / Ready / Fire ladder. Color/icon untouched.
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
    // Goldmaster v1 — relabeled from "BUILDING" to "BUILD".
    label: "BUILD",
    icon: Zap,
    accent: "border-amber-500/40 bg-amber-500/5",
    badge: "bg-amber-500 text-white",
    description: "Pattern is building — one more quality contact could move this up.",
    defaultCollapsed: false,
  },
  watch: {
    // Goldmaster v1 — relabeled from "WATCH" to "TRACK".
    label: "TRACK",
    icon: Eye,
    accent: "border-blue-500/30 bg-blue-500/5",
    badge: "bg-blue-500 text-white",
    description: "Tracking. HR conditions are forming, not actionable yet.",
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
    label: "DEAD / MISSED",
    icon: XCircle,
    accent: "border-zinc-500/30 bg-zinc-500/5",
    badge: "bg-zinc-500 text-white",
    description: "Signals that resolved without conversion.",
    defaultCollapsed: true,
  },
};

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
      return { label: "Early HR (no window)", color: "bg-purple-700 text-purple-100" };
    case "expired": return { label: "Expired", color: "bg-zinc-600 text-zinc-100" };
    default: return { label: "Resolved", color: "bg-zinc-600 text-zinc-100" };
  }
}

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

function LadderCard({ entry, section, onAddToSlip, onOpenDetails, onPass, onAccept, isAccepted }: CardProps) {
  // Goldmaster Phase 2+3 — prefer the FROZEN server-stamped detectedLabel /
  // hitLabel (these never advance on score climbs). Fall back to formatting
  // the (inning, half) pair for legacy rows that pre-date the label fields.
  const detected = entry.detectedLabel ?? formatHalfInning(entry.detectedInning, entry.detectedHalf);
  const hit = entry.hitLabel ?? formatHalfInning(entry.hitInning, entry.hitHalf);
  // Goldmaster RESTORE — USER-FACING signal score is the 10-point scale
  // (one decimal). The 0-100 internal readiness is kept for admin/debug
  // and harness invariants but never displayed as the primary number.
  // Fall back: derive from canonical 0-100 if the new field is missing
  // (older cached row), then from legacy mirrors as a last resort.
  const score10 =
    entry.currentSignalScore10 ??
    (entry.currentReadinessScore != null ? Math.round(entry.currentReadinessScore) / 10 : null) ??
    (entry.signalStrengthScore != null ? Math.round(entry.signalStrengthScore) / 10 : null) ??
    (entry.peakSignalScore10 ?? null);
  const initial10 =
    entry.initialSignalScore10 ??
    (entry.initialReadinessScore != null ? Math.round(entry.initialReadinessScore) / 10 : null);
  const peak10 =
    entry.peakSignalScore10 ??
    (entry.peakReadinessScore != null ? Math.round(entry.peakReadinessScore) / 10 : null) ??
    (entry.peakScore != null ? Math.round(entry.peakScore) / 10 : null);
  const momentum = entry.momentumLabel ?? "flat";
  const momentumDisplay =
    momentum === "heating_up" ? { label: "Heating up", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" }
    : momentum === "holding_strong" ? { label: "Holding strong", color: "text-amber-400 bg-amber-500/10 border-amber-500/30" }
    : momentum === "cooling_off" ? { label: "Cooling off", color: "text-orange-400 bg-orange-500/10 border-orange-500/30" }
    : null;
  const isAttack = section === "attackNow";
  // Goldmaster Phase 5 — derive live vs resolved mode. Resolved cards must
  // never carry "next AB" copy or any live-only verbiage.
  const isResolved =
    entry.currentStatus === "resolved" || section === "cashed" || section === "dead";
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
  const reasons = Array.from(new Set((reasonsRaw ?? []).filter(isUserSafeReason)));
  // Pregame zero-AB rows must not render any contact-implying bullets — the
  // server already empties supportingReasons, but defend against legacy data.
  const reasonsForRender = isPregameOnly ? reasons.slice(0, 1) : reasons;
  // Outcome label for resolved rows uses the canonical outcome when present.
  const resolvedOutcomeKey = entry.outcome ?? entry.outcomeStatus;

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

      {/* Task #121 Step 4 — remaining-window urgency line. Lives directly
          above the actions so the user sees it just before deciding. */}
      {!isResolved && entry.remainingPAExpectation != null && entry.remainingPAExpectation > 0 && (() => {
        const pa = entry.remainingPAExpectation!;
        // Use live game-state inning (currentInning) for late-inning copy —
        // detectedInning is frozen and would misstate urgency for signals
        // detected early but now in the bottom of the order.
        const inn = entry.currentInning ?? entry.detectedInning ?? null;
        const lateInning = inn != null && inn >= 7;
        const lowPA = pa <= 2;
        const critical = pa <= 1;
        const urgent = critical || lowPA || lateInning;
        const tone = critical
          ? "text-amber-300"
          : urgent
          ? "text-amber-400"
          : "text-muted-foreground";
        const expiresLabel = lateInning ? `expires after T${Math.max(8, inn ?? 8)}` : null;
        return (
          <div
            className={`mt-2 flex items-center gap-1 text-[11px] ${tone}`}
            data-testid={`text-remaining-window-${entry.playerId}`}
          >
            <Clock className="w-3 h-3" />
            <span>~{pa < 1 ? pa.toFixed(1) : Math.round(pa)} PA left{expiresLabel ? ` · ${expiresLabel}` : ""}</span>
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
        <div className="mt-2 flex items-center justify-end gap-2">
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
  const [collapsed, setCollapsed] = useState(meta.defaultCollapsed);
  const Icon = meta.icon;

  return (
    <Card className={`${meta.accent} border-2`} data-testid={`section-ladder-${sectionKey}`}>
      <button
        className="w-full flex items-center justify-between gap-2 p-3 text-left min-w-0"
        onClick={() => setCollapsed(c => !c)}
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
            entries.map(e => {
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
            })
          )}
        </div>
      )}
    </Card>
  );
}

interface HrRadarLadderProps {
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
}

export function HrRadarLadder({ onAddToSlip, onOpenDetails }: HrRadarLadderProps) {
  // ── HOOKS — all hook calls live above ANY early return so the call
  // count is identical between renders (React invariant; violating it
  // throws "Rendered more hooks than during the previous render").
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hideFinished, setHideFinished] = useState(false);
  const { data, isLoading, isFetching, error, dataUpdatedAt } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    refetchInterval: 20_000,
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
    return {
      attackNow: filterDismissed(rawSections.attackNow ?? []),
      // Goldmaster v1 — additive Ready bucket (filtered like other live sections).
      ready: filterDismissed((rawSections as any).ready ?? []),
      building: filterDismissed(rawSections.building ?? []),
      watch: filterDismissed(rawSections.watch ?? []),
      cashed: rawSections.cashed ?? [],
      dead: rawSections.dead ?? [],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawSections, dismissed]);

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
    total: sections.attackNow.length + sections.ready.length + sections.building.length + sections.watch.length + sections.cashed.length + sections.dead.length,
  };

  const allOrder: SectionKey[] = ["attackNow", "ready", "building", "watch", "cashed", "dead"];
  const order: SectionKey[] = hideFinished
    ? allOrder.filter(k => k !== "cashed" && k !== "dead")
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
      {order.map(key => (
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
      ))}
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
