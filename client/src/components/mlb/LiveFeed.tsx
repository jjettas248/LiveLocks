// ── MLB Live Feed (signal-first surface) ──────────────────────────────
// Renders the four canonical display groups (ACTION NOW / BUILDING /
// MONITOR / RESOLVED) coming from /api/mlb/edge-feed?view=market-signals.
// This component is a pure renderer — no engine math, no thresholds,
// no calibration. Inning pills + actionability badges are read straight
// from the server-stamped MarketSignalViewModel.

import { useState } from "react";
import { ChevronDown, ChevronUp, Flame, TrendingUp, Eye, CheckCircle2 } from "lucide-react";
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
}> = [
  { key: "ACTION_NOW", label: "Action Now", color: "#ef4444", bg: "rgba(239,68,68,0.06)",   border: "rgba(239,68,68,0.30)",   icon: Flame,         emptyCopy: "No urgent signals right now." },
  { key: "BUILDING",   label: "Building",   color: "#f59e0b", bg: "rgba(245,158,11,0.06)",  border: "rgba(245,158,11,0.30)",  icon: TrendingUp,    emptyCopy: "No signals are building yet." },
  { key: "MONITOR",    label: "Monitor",    color: "#94a3b8", bg: "rgba(148,163,184,0.06)", border: "rgba(148,163,184,0.30)", icon: Eye,           emptyCopy: "Nothing on the watch list." },
  { key: "RESOLVED",   label: "Resolved",   color: "#22c55e", bg: "rgba(34,197,94,0.06)",   border: "rgba(34,197,94,0.30)",   icon: CheckCircle2,  emptyCopy: "No graded signals yet today." },
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const grouped: Record<MarketDisplayGroup, MarketSignalViewModelClient[]> = {
    ACTION_NOW: [],
    BUILDING: [],
    MONITOR: [],
    RESOLVED: [],
  };
  for (const r of rows) grouped[r.displayGroup].push(r);

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

      {GROUPS.map((g) => {
        const items = grouped[g.key];
        const isCollapsed = collapsed[g.key] ?? false;
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
