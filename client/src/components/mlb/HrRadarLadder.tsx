import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Flame, Zap, Eye, CheckCircle2, XCircle, Plus, AlertTriangle, RefreshCw, Eraser } from "lucide-react";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";

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
}

export interface HrRadarLadderResponse {
  sessionDate: string;
  sections: {
    attackNow: HrRadarLadderEntry[];
    building: HrRadarLadderEntry[];
    watch: HrRadarLadderEntry[];
    cashed: HrRadarLadderEntry[];
    dead: HrRadarLadderEntry[];
  };
  counts: { attackNow: number; building: number; watch: number; cashed: number; dead: number; total: number };
}

type SectionKey = keyof HrRadarLadderResponse["sections"];

const SECTION_META: Record<SectionKey, {
  label: string;
  icon: typeof Flame;
  accent: string;
  badge: string;
  description: string;
  defaultCollapsed: boolean;
}> = {
  attackNow: {
    label: "ATTACK NOW",
    icon: Flame,
    accent: "border-red-500/40 bg-red-500/5",
    badge: "bg-red-500 text-white",
    description: "Highest-conviction HR signals firing right now.",
    defaultCollapsed: false,
  },
  building: {
    label: "BUILDING",
    icon: Zap,
    accent: "border-amber-500/40 bg-amber-500/5",
    badge: "bg-amber-500 text-white",
    description: "Momentum gathering — could escalate to an attack soon.",
    defaultCollapsed: false,
  },
  watch: {
    label: "WATCH",
    icon: Eye,
    accent: "border-blue-500/30 bg-blue-500/5",
    badge: "bg-blue-500 text-white",
    description: "Tracking but not actionable yet.",
    defaultCollapsed: true,
  },
  cashed: {
    label: "CASHED",
    icon: CheckCircle2,
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
}

function LadderCard({ entry, section, onAddToSlip, onOpenDetails }: CardProps) {
  const detected = formatHalfInning(entry.detectedInning, entry.detectedHalf);
  const hit = formatHalfInning(entry.hitInning, entry.hitHalf);
  const score = entry.signalStrengthScore ?? entry.peakScore;
  const isAttack = section === "attackNow";
  // Goldmaster Phase 5 — derive live vs resolved mode. Resolved cards must
  // never carry "next AB" copy or any live-only verbiage.
  const isResolved =
    entry.currentStatus === "resolved" || section === "cashed" || section === "dead";
  const canAdd = !isResolved && (section === "attackNow" || section === "building") && !!onAddToSlip;
  // Goldmaster Phase 7 — pregame indicator for 0-AB rows.
  const isPregameOnly =
    entry.hasLiveABContext === false ||
    (entry.plateAppearancesTracked != null && entry.plateAppearancesTracked === 0);
  // Prefer canonical userReasons; fall back to legacy whyNowReasons. Apply a
  // final UI-side jargon strip in case a stale legacy row leaks through.
  const reasonsRaw =
    (entry.userReasons && entry.userReasons.length > 0)
      ? entry.userReasons
      : entry.whyNowReasons;
  const reasons = (reasonsRaw ?? []).filter(isUserSafeReason);
  // Outcome label for resolved rows uses the canonical outcome when present.
  const resolvedOutcomeKey = entry.outcome ?? entry.outcomeStatus;

  const handleAdd = () => {
    if (!onAddToSlip) return;
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
        <div className="flex flex-col items-end gap-1 shrink-0 max-w-[40%]">
          {score != null && !isResolved && (
            <span
              className={`text-xs font-mono font-bold ${isAttack ? "text-red-400" : "text-foreground/80"}`}
              data-testid={`text-ladder-score-${entry.playerId}`}
            >
              {Math.round(score)}
            </span>
          )}
          {isResolved && section === "dead" && (
            <Badge className={`text-[9px] px-1.5 py-0 whitespace-nowrap ${deadOutcomeLabel(resolvedOutcomeKey).color}`}>
              {deadOutcomeLabel(resolvedOutcomeKey).label}
            </Badge>
          )}
          {section === "cashed" && entry.alertPath === "early" && (
            <Badge className="text-[9px] px-1.5 py-0 whitespace-nowrap bg-emerald-600 text-white">Early call</Badge>
          )}
        </div>
      </div>

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
      {!isResolved && reasons.length > 0 && (
        <ul className="mt-2 space-y-0.5" data-testid={`list-why-now-${entry.playerId}`}>
          {reasons.slice(0, 3).map((r, i) => (
            <li key={i} className="text-[11px] text-foreground/70 flex gap-1">
              <span className="text-muted-foreground">•</span>
              <span className="truncate">{r}</span>
            </li>
          ))}
        </ul>
      )}

      {canAdd && (
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] gap-1"
            onClick={handleAdd}
            data-testid={`button-add-slip-ladder-${entry.playerId}`}
          >
            <Plus className="w-3 h-3" /> Add HR Over 0.5
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
}

function LadderSection({ sectionKey, entries, onAddToSlip, onOpenDetails }: LadderSectionProps) {
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
            entries.map(e => (
              <LadderCard
                key={`${sectionKey}-${e.playerId}-${e.gameId}`}
                entry={e}
                section={sectionKey}
                onAddToSlip={onAddToSlip}
                onOpenDetails={onOpenDetails}
              />
            ))
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
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hideFinished, setHideFinished] = useState(false);
  const { data, isLoading, isFetching, error, dataUpdatedAt } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    refetchInterval: 20_000,
    placeholderData: (prev) => prev,
  });

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

  const sections = data?.sections ?? { attackNow: [], building: [], watch: [], cashed: [], dead: [] };
  const counts = data?.counts ?? { attackNow: 0, building: 0, watch: 0, cashed: 0, dead: 0, total: 0 };
  const allOrder: SectionKey[] = ["attackNow", "building", "watch", "cashed", "dead"];
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
