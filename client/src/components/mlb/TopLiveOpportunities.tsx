import { Zap, Flame, Activity } from "lucide-react";
import type { SignalViewModel } from "@/lib/mlb/mlbViewModel";
import type { MLBSignal } from "@shared/mlbSignal";
import { buildSignalViewModel, buildTopOpportunitiesViewModel } from "@/lib/mlb/mlbViewModel";

export function TopLiveOpportunities({
  signals,
  onAddToSlip,
}: {
  signals: MLBSignal[];
  onAddToSlip?: (sig: MLBSignal) => void;
}) {
  const viewModels = signals.map(buildSignalViewModel);
  const ranked = buildTopOpportunitiesViewModel(viewModels);

  if (ranked.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/40 overflow-hidden" style={{ background: "#0a0a0a" }} data-testid="top-live-opportunities">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-border/30" style={{ background: "linear-gradient(135deg, rgba(34,197,94,0.08), rgba(59,130,246,0.05))" }}>
        <Zap className="w-4 h-4 text-green-400" />
        <span className="text-sm font-bold text-foreground">Top Live Opportunities</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 font-semibold">{ranked.length}</span>
      </div>

      <div className="divide-y divide-border/20">
        {ranked.map((vm, idx) => {
          // Display contract: server-owned grade (NEVER from liveScore).
          const color = vm.displayGradeColor;
          const grade = vm.displayGrade;
          const pitcherSigs = vm.pitcherSignals ?? [];
          const hasEventBoost = vm.eventBoost > 30;

          return (
            <div
              key={vm.id}
              data-testid={`top-opp-${idx}`}
              className="px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors cursor-pointer"
              onClick={() => onAddToSlip?.(vm.raw)}
            >
              <div className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-black shrink-0" style={{ background: `${color}20`, color }}>
                {idx + 1}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-bold text-foreground truncate">{vm.playerName}</span>
                  {vm.matchup && (
                    <span className="text-[9px] text-muted-foreground/60">{vm.matchup.replace(" @ ", "@")}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  <span className={`text-[10px] font-black`} style={{ color: vm.sideStyle.color }}>
                    {vm.marketShort} {vm.displaySide} {vm.bookLine}
                  </span>
                  <span className="text-[10px] font-bold tabular-nums text-foreground/80">{vm.displayProbabilityLabel}</span>
                  {vm.edgeDisplay && vm.edge != null && vm.edge > 0 && (
                    <span className="text-[9px] text-green-400/70">{vm.edgeDisplay}</span>
                  )}
                  {hasEventBoost && (
                    <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-400 font-bold flex items-center gap-0.5">
                      <Flame className="w-2.5 h-2.5" /> BOOST
                    </span>
                  )}
                  {pitcherSigs.slice(0, 2).map((ps, psIdx) => (
                    <span key={psIdx} className="text-[8px] font-black px-1 py-0.5 rounded-full border" style={{ borderColor: `${ps.color}40`, color: ps.color, background: `${ps.color}10` }}>
                      {ps.label}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex flex-col items-end shrink-0">
                <div className="flex items-center gap-1">
                  <Activity className="w-3 h-3" style={{ color }} />
                  <span className="text-[13px] font-black" style={{ color }}>
                    {grade}
                  </span>
                </div>
                {vm.oppGrade && (
                  <span className="text-[8px] font-semibold mt-0.5" style={{ color: `${color}99` }}>
                    Matchup {vm.oppGrade}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
