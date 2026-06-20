import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X, Zap, ListFilter } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { type HrRadarLadderEntry, type HrRadarLadderResponse } from "@/components/mlb/HrRadarLadder";
import { hrEntryCurrentScore10 } from "@/components/mlb/hrRadarScore";

// Session key format mirrors HrRadarLadder.tsx exactly so Quick Decide and
// Full Ladder share the same accept/dismiss state across view toggles.
function dismissKey(date: string) { return `hr-radar-pass:${date}`; }
function acceptKey(date: string) { return `hr-radar-accept:${date}`; }
function entryKey(playerId: string, gameId: string) { return `${playerId}|${gameId}`; }
function readSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch { return new Set(); }
}
function writeSet(key: string, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch {}
}

interface HrQuickDecideProps {
  onAddToSlip?: (sig: MlbSignalData) => void;
  onSwitchToLadder?: () => void;
}

const STAGE_CONFIG = {
  fire: {
    label: "FIRE",
    border: "border-red-500/50",
    badgeBg: "bg-red-500/20",
    badgeText: "text-red-400",
  },
  ready: {
    label: "READY",
    border: "border-orange-500/50",
    badgeBg: "bg-orange-500/20",
    badgeText: "text-orange-400",
  },
} as const;

type ActionableStage = "fire" | "ready";

function getDisplayScore(entry: HrRadarLadderEntry): number | null {
  return hrEntryCurrentScore10(entry);
}

function getReasons(entry: HrRadarLadderEntry): string[] {
  // Prefer the jargon-stripped cleanReasons; fall back to supportingReasons,
  // then a single headline/stage line. Rendered verbatim (CLAUDE.md §3.5).
  const source = entry.cleanReasons?.length
    ? entry.cleanReasons
    : (entry.supportingReasons?.length ? entry.supportingReasons : []);
  const reasons = source.length
    ? source
    : [entry.headlineReason ?? entry.stageDescription ?? ""].filter(Boolean);
  return reasons.slice(0, 2);
}

// Compact decision metrics — reuse the exact field formulas the Full Ladder's
// HR Breakdown panel uses (HrRadarLadder.tsx HR Breakdown), shown as chips so
// the quick decision has a visible, quantified basis. All server-stamped values
// (formatted only, never re-derived).
type WhyChip = { label: string; tone: "neutral" | "success" | "warning" };

function getWhyChips(entry: HrRadarLadderEntry): WhyChip[] {
  const chips: WhyChip[] = [];
  if (entry.conversionProbability != null) {
    chips.push({ label: `HR ${Math.min(100, Math.round(entry.conversionProbability * 100))}%`, tone: "success" });
  }
  if (entry.pitcherHrVulnerability != null) {
    chips.push({ label: `Vuln ${Math.min(100, Math.round(entry.pitcherHrVulnerability))}`, tone: "neutral" });
  }
  if (entry.currentReadinessScore != null) {
    chips.push({ label: `Ready ${Math.min(100, Math.round(entry.currentReadinessScore))}`, tone: "neutral" });
  }
  switch (entry.momentumLabel) {
    case "heating_up":
      chips.push({ label: "Heating up", tone: "success" });
      break;
    case "cooling_off":
      chips.push({ label: "Cooling", tone: "warning" });
      break;
    case "holding_strong":
      chips.push({ label: "Holding", tone: "neutral" });
      break;
    // "flat" / undefined → no momentum chip
  }
  return chips;
}

const CHIP_TONE: Record<WhyChip["tone"], string> = {
  neutral: "bg-muted/50 text-muted-foreground border-border/40",
  success: "bg-success/15 text-success border-success/30",
  warning: "bg-warning/15 text-warning border-warning/30",
};

function formatPA(pa: number | null | undefined): string {
  if (pa == null || pa <= 0) return "";
  return `~${pa.toFixed(1)} PA left`;
}

function formatInning(inning: number | null | undefined, half?: string | null): string {
  if (inning == null) return "";
  const prefix = half === "bottom" ? "B" : "T";
  return `${prefix}${inning}`;
}

function QuickCard({
  entry,
  stage,
  onAccept,
  onDismiss,
}: {
  entry: HrRadarLadderEntry;
  stage: ActionableStage;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const cfg = STAGE_CONFIG[stage];
  const score = getDisplayScore(entry);
  const reasons = getReasons(entry);
  const whyChips = getWhyChips(entry);
  const pa = formatPA(entry.remainingPAExpectation);
  const inning = formatInning(
    entry.currentInning ?? entry.detectedInning,
    entry.detectedHalf,
  );
  const timing = [pa, inning].filter(Boolean).join(" · ");

  return (
    <div
      className={`rounded-xl border ${cfg.border} bg-card p-4 space-y-3`}
      data-testid={`quick-decide-card-${entry.playerId}`}
    >
      {/* Stage badge + score */}
      <div className="flex items-center justify-between">
        <span
          className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${cfg.badgeBg} ${cfg.badgeText} tracking-widest uppercase`}
        >
          {cfg.label}
        </span>
        {score != null && (
          <span className={`text-xl font-bold tabular-nums ${cfg.badgeText}`}>
            {score.toFixed(1)}
            <span className="text-sm font-normal text-muted-foreground"> / 10</span>
          </span>
        )}
      </div>

      {/* Player + team */}
      <div className="flex items-baseline gap-2">
        <span
          className="text-base font-bold text-foreground leading-tight"
          data-testid={`text-quick-player-${entry.playerId}`}
        >
          {entry.playerName}
        </span>
        <span className="text-xs text-muted-foreground uppercase tracking-wide shrink-0">
          {entry.team}
        </span>
      </div>

      {/* Why — top reasons (verbatim server evidence) */}
      {reasons.length > 0 && (
        <div className="space-y-1">
          {reasons.map((r, i) => (
            <p
              key={i}
              className="text-sm text-muted-foreground leading-snug"
              data-testid={`text-quick-reason-${entry.playerId}-${i}`}
            >
              {reasons.length > 1 ? "• " : '"'}{r}{reasons.length > 1 ? "" : '"'}
            </p>
          ))}
        </div>
      )}

      {/* Why — quantified decision metrics (server-stamped, formatted only) */}
      {whyChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`chips-quick-why-${entry.playerId}`}>
          {whyChips.map((chip, i) => (
            <span
              key={i}
              className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border tabular-nums ${CHIP_TONE[chip.tone]}`}
            >
              {chip.label}
            </span>
          ))}
        </div>
      )}

      {/* Timing */}
      {timing && (
        <p className="text-xs text-muted-foreground/70">{timing}</p>
      )}

      {/* Action buttons */}
      <div className="grid grid-cols-2 gap-2 pt-0.5">
        <button
          data-testid={`button-quick-take-${entry.playerId}`}
          onClick={onAccept}
          className="flex items-center justify-center gap-1.5 py-3 rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 text-sm font-semibold hover:bg-emerald-500/30 active:scale-[0.97] transition-all"
        >
          <Check className="w-4 h-4" /> Take It
        </button>
        <button
          data-testid={`button-quick-pass-${entry.playerId}`}
          onClick={onDismiss}
          className="flex items-center justify-center gap-1.5 py-3 rounded-lg bg-muted/40 border border-border text-muted-foreground text-sm font-semibold hover:text-foreground hover:bg-muted/60 active:scale-[0.97] transition-all"
        >
          <X className="w-4 h-4" /> Pass
        </button>
      </div>
    </div>
  );
}

export function HrQuickDecide({ onAddToSlip, onSwitchToLadder }: HrQuickDecideProps) {
  const { data, isLoading } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    placeholderData: (prev) => prev,
  });

  const sessionDate = data?.sessionDate ?? "";

  const [dismissed, setDismissed] = useState<Set<string>>(
    () => readSet(dismissKey(sessionDate)),
  );
  const [accepted, setAccepted] = useState<Set<string>>(
    () => readSet(acceptKey(sessionDate)),
  );
  const [prevDate, setPrevDate] = useState(sessionDate);

  // Re-sync when the session date rolls over (day boundary).
  if (sessionDate !== prevDate && sessionDate !== "") {
    setPrevDate(sessionDate);
    setDismissed(readSet(dismissKey(sessionDate)));
    setAccepted(readSet(acceptKey(sessionDate)));
  }

  const attackNow = data?.sections?.attackNow ?? [];
  const ready = data?.sections?.ready ?? [];
  const building = data?.sections?.building ?? [];
  const watch = data?.sections?.watch ?? [];

  const undecidedFire = attackNow.filter((e) => {
    const k = entryKey(e.playerId, e.gameId);
    return !dismissed.has(k) && !accepted.has(k);
  });
  const undecidedReady = ready.filter((e) => {
    const k = entryKey(e.playerId, e.gameId);
    return !dismissed.has(k) && !accepted.has(k);
  });

  const totalUndecided = undecidedFire.length + undecidedReady.length;
  const buildingCount = building.length + watch.length;

  const handleAccept = (entry: HrRadarLadderEntry) => {
    const k = entryKey(entry.playerId, entry.gameId);
    const next = new Set(accepted).add(k);
    setAccepted(next);
    writeSet(acceptKey(sessionDate), next);
    onAddToSlip?.({
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

  const handleDismiss = (entry: HrRadarLadderEntry) => {
    const k = entryKey(entry.playerId, entry.gameId);
    const next = new Set(dismissed).add(k);
    setDismissed(next);
    writeSet(dismissKey(sessionDate), next);
  };

  if (isLoading && !data) {
    return (
      <div className="flex justify-center p-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (totalUndecided === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-card/50 p-10 text-center space-y-3">
        <div className="text-3xl text-emerald-400">✓</div>
        <p className="font-semibold text-foreground">All caught up</p>
        <p className="text-sm text-muted-foreground">
          {buildingCount > 0
            ? `${buildingCount} signal${buildingCount !== 1 ? "s" : ""} still building — check the Full Ladder`
            : "No active HR signals right now"}
        </p>
        {onSwitchToLadder && (
          <button
            data-testid="button-switch-to-ladder"
            onClick={onSwitchToLadder}
            className="text-xs text-primary hover:text-primary/80 underline transition-colors mt-1"
          >
            View Full Ladder
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-yellow-400" />
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {totalUndecided} signal{totalUndecided !== 1 ? "s" : ""} need a decision
          </span>
        </div>
        {onSwitchToLadder && (
          <button
            data-testid="button-view-full-ladder"
            onClick={onSwitchToLadder}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ListFilter className="w-3 h-3" /> Full Ladder
          </button>
        )}
      </div>

      {/* FIRE signals first, then READY */}
      {undecidedFire.map((entry) => (
        <QuickCard
          key={`${entry.playerId}|${entry.gameId}`}
          entry={entry}
          stage="fire"
          onAccept={() => handleAccept(entry)}
          onDismiss={() => handleDismiss(entry)}
        />
      ))}
      {undecidedReady.map((entry) => (
        <QuickCard
          key={`${entry.playerId}|${entry.gameId}`}
          entry={entry}
          stage="ready"
          onAccept={() => handleAccept(entry)}
          onDismiss={() => handleDismiss(entry)}
        />
      ))}
    </div>
  );
}
