// ── MLB Action Feed (signal-first surface) ────────────────────────────
// Renders the four canonical display groups as the signal-first stack:
//   LIVE ATTACK WINDOWS (hero) · BUILDING SIGNALS · MONITORING · RESOLVED
// from /api/mlb/edge-feed?view=market-signals.
// Pure renderer — no engine math, no thresholds, no calibration.
// Inning pills + actionability badges are read straight from the
// server-stamped MarketSignalViewModel.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Flame, TrendingUp, Eye, CheckCircle2, Activity } from "lucide-react";
import { MlbSignalCard, type MlbSignalData } from "./MlbSignalCard";

export type MarketActionability = "urgent" | "actionable" | "forming" | "monitor" | "resolved";
export type MarketDisplayGroup = "ACTION_NOW" | "BUILDING" | "MONITOR" | "RESOLVED";
export type MlbInningWindow = "all" | "early" | "mid" | "late" | "unknown";

export interface MarketSignalViewModelClient {
  signalId: string;
  gameId: string;
  playerId: string;
  playerName: string;
  market: string;
  side: "OVER" | "UNDER";
  line: number | null;
  odds: number | null;
  probability: number;
  edge: number | null;
  signalTier: "watch" | "lean" | "strong" | "elite";
  lifecycleState: string;
  inning: number | null;
  inningWindow: MlbInningWindow;
  inningSource: string;
  marketActionability: MarketActionability;
  primarySignalLabel: string;
  secondarySignalLabel: string | null;
  drivers: any[];
  triggerSummary: string | null;
  displayGroup: MarketDisplayGroup;
}

const GROUPS: Array<{
  key: MarketDisplayGroup;
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: typeof Flame;
  emptyCopy: string;
  /** Sections collapsed by default — Monitor + Resolved per signal-first spec. */
  defaultCollapsed: boolean;
}> = [
  { key: "ACTION_NOW", label: "Live Attack Windows", color: "#ef4444", bg: "rgba(239,68,68,0.06)",   border: "rgba(239,68,68,0.30)",   icon: Flame,         emptyCopy: "No live attack window right now — the engine is still scoring contact and matchups.", defaultCollapsed: false },
  { key: "BUILDING",   label: "Building Signals",    color: "#f59e0b", bg: "rgba(245,158,11,0.06)",  border: "rgba(245,158,11,0.30)",  icon: TrendingUp,    emptyCopy: "No signals are forming yet — checking pitcher fatigue, contact streaks, and lineup leverage.", defaultCollapsed: false },
  { key: "MONITOR",    label: "Monitoring",          color: "#94a3b8", bg: "rgba(148,163,184,0.06)", border: "rgba(148,163,184,0.30)", icon: Eye,           emptyCopy: "Nothing on the watch list.", defaultCollapsed: true },
  { key: "RESOLVED",   label: "Resolved",            color: "#22c55e", bg: "rgba(34,197,94,0.06)",   border: "rgba(34,197,94,0.30)",   icon: CheckCircle2,  emptyCopy: "No graded signals yet today.", defaultCollapsed: true },
];

export interface LiveFeedProps {
  rows: MarketSignalViewModelClient[];
  /** Find the underlying MLBSignal so the existing card renders unchanged. */
  resolveSignal: (vm: MarketSignalViewModelClient) => MlbSignalData | null;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenCalculator?: (sig: MlbSignalData) => void;
  onPlayerClick?: (gameId: string, playerId: string) => void;
  /** Optional gating tail blur for non-elite users. */
  isElite?: boolean;
  unknownInningCount?: number;
}

export function LiveFeed({
  rows,
  resolveSignal,
  onAddToSlip,
  onOpenCalculator,
  onPlayerClick,
  isElite = true,
  unknownInningCount,
}: LiveFeedProps) {
  // Initialize collapsed state from each group's defaultCollapsed flag so
  // Monitoring + Resolved are tucked away by default. Users can expand.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of GROUPS) init[g.key] = g.defaultCollapsed;
    return init;
  });
  const grouped: Record<MarketDisplayGroup, MarketSignalViewModelClient[]> = {
    ACTION_NOW: [],
    BUILDING: [],
    MONITOR: [],
    RESOLVED: [],
  };
  for (const r of rows) grouped[r.displayGroup].push(r);

  // Signal-first empty state: when there are NO actionable rows at all
  // (action + building + monitor all 0), the feed should NOT render four
  // empty buckets. Resolved is allowed to be non-empty without triggering
  // the narrative state — graded outcomes are real activity.
  const liveCount = grouped.ACTION_NOW.length + grouped.BUILDING.length + grouped.MONITOR.length;
  const lateActionCount = grouped.ACTION_NOW.filter((r) => r.inningWindow === "late").length;
  const buildingLiveCount = grouped.BUILDING.length;
  const isFullyEmpty = liveCount === 0;

  // ── Diagnostics: signal-first surface tags ──────────────────────────
  // Emitted once per render to keep [MLB_ACTION_FEED] / [MLB_LATE_WINDOW] /
  // [MLB_BUILDING_SIGNAL] / [MLB_EMPTY_STATE] visible in the browser
  // console for the spec's required admin debug surface. Pure logging.
  useEffect(() => {
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[MLB_ACTION_FEED] live=${liveCount} action=${grouped.ACTION_NOW.length} ` +
          `building=${grouped.BUILDING.length} monitor=${grouped.MONITOR.length} ` +
          `resolved=${grouped.RESOLVED.length} unknownInning=${unknownInningCount ?? 0}`,
      );
      if (lateActionCount > 0) console.log(`[MLB_LATE_WINDOW] count=${lateActionCount}`);
      if (buildingLiveCount > 0) console.log(`[MLB_BUILDING_SIGNAL] count=${buildingLiveCount}`);
      if (isFullyEmpty) console.log(`[MLB_EMPTY_STATE] action+building+monitor=0 narrative=engine_building_conviction`);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length, liveCount, lateActionCount, buildingLiveCount]);

  return (
    <div className="space-y-4" data-testid="mlb-live-feed">
      {unknownInningCount != null && unknownInningCount > 0 && (
        <div
          className="text-[10px] text-muted-foreground/70 px-2"
          data-testid="text-unknown-inning-count"
          title="Signals where the engine could not resolve the inning. Still surfaced; de-prioritized in sort."
        >
          {unknownInningCount} signal{unknownInningCount === 1 ? "" : "s"} with unknown inning
        </div>
      )}

      {/* Signal-first narrative empty state — replaces "0 / 0 / 0 / 0"
          dead-bucket rendering with an active, alive system message that
          tells the user what the engine is doing right now. */}
      {isFullyEmpty && (
        <div
          data-testid="mlb-action-feed-empty-narrative"
          className="rounded-xl border border-primary/20 bg-gradient-to-b from-primary/5 to-transparent p-5 sm:p-6 text-center space-y-3"
        >
          <div className="flex items-center justify-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <Activity className="w-4 h-4 text-primary" />
            <span className="text-sm font-bold tracking-tight text-foreground">Engine Building Conviction</span>
          </div>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
            Live games are being scored — pitcher fatigue, lineup leverage, and contact streaks
            are still developing. Live Attack Windows fire when the evidence escalates.
          </p>
        </div>
      )}

      {GROUPS.map((g) => {
        const items = grouped[g.key];
        // Hide empty Monitor + Resolved entirely when the feed is fully empty
        // so we don't show four empty rows under the narrative card.
        if (isFullyEmpty && (g.key === "MONITOR" || g.key === "RESOLVED") && items.length === 0) {
          return null;
        }
        const isCollapsed = collapsed[g.key] ?? g.defaultCollapsed;
        const Icon = g.icon;
        const visible = isElite ? items : items.slice(0, g.key === "ACTION_NOW" ? 1 : 0);
        const blurred = isElite ? [] : items.slice(visible.length, visible.length + 2);

        return (
          <div key={g.key} data-testid={`mlb-group-${g.key.toLowerCase()}`}>
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
              data-testid={`button-toggle-group-${g.key.toLowerCase()}`}
              className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg transition-colors hover:opacity-80"
              style={{ background: g.bg, border: `1px solid ${g.border}` }}
            >
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5" style={{ color: g.color }} />
                <span className="text-xs font-bold uppercase tracking-wide" style={{ color: g.color }}>
                  {g.label}
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                  style={{ background: g.bg, color: g.color, border: `1px solid ${g.border}` }}
                >
                  {items.length}
                </span>
              </div>
              {isCollapsed
                ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>

            {!isCollapsed && (
              <div className="mt-2 space-y-2">
                {items.length === 0 ? (
                  <div className="py-3 text-center" data-testid={`text-group-empty-${g.key.toLowerCase()}`}>
                    <span className="text-[11px] text-muted-foreground/60">{g.emptyCopy}</span>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {visible.map((vm) => {
                        const sig = resolveSignal(vm);
                        if (!sig) return null;
                        return (
                          <MlbSignalCard
                            key={vm.signalId}
                            sig={sig}
                            inningWindow={vm.inningWindow}
                            marketActionability={vm.marketActionability}
                            primarySignalLabel={vm.primarySignalLabel}
                            onAddToSlip={onAddToSlip}
                            onOpenCalculator={onOpenCalculator}
                            onPlayerClick={onPlayerClick}
                          />
                        );
                      })}
                    </div>
                    {blurred.length > 0 && (
                      <div className="relative">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 filter blur-[6px] pointer-events-none select-none" aria-hidden="true">
                          {blurred.map((vm) => {
                            const sig = resolveSignal(vm);
                            if (!sig) return null;
                            return (
                              <MlbSignalCard
                                key={`blur-${vm.signalId}`}
                                sig={sig}
                                inningWindow={vm.inningWindow}
                                marketActionability={vm.marketActionability}
                                primarySignalLabel={vm.primarySignalLabel}
                              />
                            );
                          })}
                        </div>
                        <div className="absolute inset-0 flex items-center justify-center z-10">
                          <div className="rounded-xl border border-primary/30 bg-card/95 backdrop-blur-sm px-4 py-3 text-center">
                            <div className="text-xs font-bold text-foreground">
                              {items.length - visible.length} more signal{items.length - visible.length === 1 ? "" : "s"}
                            </div>
                            <a href="/upgrade"
                              data-testid={`link-mlb-feed-upgrade-${g.key.toLowerCase()}`}
                              className="inline-block mt-2 px-4 py-1.5 rounded-md bg-primary text-primary-foreground font-semibold text-[11px] hover:bg-primary/90 transition-colors">
                              Upgrade →
                            </a>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
