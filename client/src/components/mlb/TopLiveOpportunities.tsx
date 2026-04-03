import { Zap, TrendingUp, Flame, Activity } from "lucide-react";
import type { MLBSignal } from "@shared/mlbSignal";

const MARKET_SHORT: Record<string, string> = {
  hits: "Hits", total_bases: "TB", home_runs: "HR", rbi: "RBI",
  runs: "Runs", stolen_bases: "SB", batter_strikeouts: "Ks",
  pitcher_strikeouts: "Pitcher K", pitcher_outs: "Outs",
  hits_allowed: "Hits Alwd", walks_allowed: "BB Alwd", hr_allowed: "HR Alwd", hrr: "H+R+RBI",
  hr: "HR", pitcher_k: "Pitcher K", earned_runs: "ER",
};

const PITCHER_SIGNAL_DISPLAY: Record<string, { label: string; color: string }> = {
  DOMINANT: { label: "Dominant", color: "#ef4444" },
  K_STREAK: { label: "K Streak", color: "#f59e0b" },
  COMMAND_LOCKED: { label: "Locked In", color: "#22c55e" },
  VELOCITY_DROP: { label: "Velo Drop", color: "#f97316" },
  FATIGUE_RISK: { label: "Fatigued", color: "#f97316" },
  HARD_CONTACT: { label: "Hard Hit", color: "#ef4444" },
};

function liveScoreGrade(score: number): { grade: string; color: string } {
  const pct = Math.min(Math.round(score * 100 * 5), 100);
  if (pct >= 80) return { grade: "A+", color: "#22c55e" };
  if (pct >= 65) return { grade: "A", color: "#22c55e" };
  if (pct >= 50) return { grade: "B+", color: "#a3e635" };
  if (pct >= 35) return { grade: "B", color: "#f59e0b" };
  if (pct >= 20) return { grade: "C+", color: "#f59e0b" };
  return { grade: "C", color: "#94a3b8" };
}

function liveScoreColor(score: number): string {
  return liveScoreGrade(score).color;
}

function oppGrade(score: number): string {
  if (score >= 80) return "A+";
  if (score >= 65) return "A";
  if (score >= 50) return "B+";
  if (score >= 35) return "B";
  if (score >= 20) return "C+";
  return "C";
}

export function TopLiveOpportunities({
  signals,
  onAddToSlip,
}: {
  signals: MLBSignal[];
  onAddToSlip?: (sig: MLBSignal) => void;
}) {
  const ranked = [...signals]
    .filter(s => s.actionable && !s.alreadyHit && (s.liveScore ?? 0) > 0)
    .sort((a, b) => (b.liveScore ?? 0) - (a.liveScore ?? 0))
    .slice(0, 5);

  if (ranked.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/40 overflow-hidden" style={{ background: "#0a0a0a" }} data-testid="top-live-opportunities">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-border/30" style={{ background: "linear-gradient(135deg, rgba(34,197,94,0.08), rgba(59,130,246,0.05))" }}>
        <Zap className="w-4 h-4 text-green-400" />
        <span className="text-sm font-bold text-foreground">Top Live Opportunities</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-400 font-semibold">{ranked.length}</span>
      </div>

      <div className="divide-y divide-border/20">
        {ranked.map((sig, idx) => {
          const ls = sig.liveScore ?? 0;
          const grade = liveScoreGrade(ls);
          const color = grade.color;
          const pitcherSigs = sig.pitcherSignals ?? [];
          const mktShort = MARKET_SHORT[sig.market] ?? sig.market;
          const hasEventBoost = (sig.eventBoost ?? 0) > 30;

          return (
            <div
              key={`${sig.playerId}-${sig.market}-${sig.gameId}`}
              data-testid={`top-opp-${idx}`}
              className="px-4 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors cursor-pointer"
              onClick={() => onAddToSlip?.(sig)}
            >
              <div className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-black shrink-0" style={{ background: `${color}20`, color }}>
                {idx + 1}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-bold text-foreground truncate">{sig.playerName}</span>
                  {sig.awayAbbr && sig.homeAbbr && (
                    <span className="text-[9px] text-muted-foreground/60">{sig.awayAbbr}@{sig.homeAbbr}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  <span className={`text-[10px] font-black ${sig.recommendedSide === "OVER" ? "text-green-400" : "text-blue-400"}`}>
                    {mktShort} {sig.recommendedSide} {sig.bookLine}
                  </span>
                  <span className="text-[10px] font-bold tabular-nums text-foreground/80">{sig.enginePct.toFixed(0)}%</span>
                  {sig.edge != null && sig.edge > 0 && (
                    <span className="text-[9px] text-green-400/70">+{sig.edge.toFixed(1)}%</span>
                  )}
                  {hasEventBoost && (
                    <span className="text-[8px] px-1 py-0.5 rounded bg-yellow-500/10 text-yellow-400 font-bold flex items-center gap-0.5">
                      <Flame className="w-2.5 h-2.5" /> BOOST
                    </span>
                  )}
                  {pitcherSigs.slice(0, 2).map(ps => {
                    const display = PITCHER_SIGNAL_DISPLAY[ps];
                    if (!display) return null;
                    return (
                      <span key={ps} className="text-[8px] font-black px-1 py-0.5 rounded-full border" style={{ borderColor: `${display.color}40`, color: display.color, background: `${display.color}10` }}>
                        {display.label}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col items-end shrink-0">
                <div className="flex items-center gap-1">
                  <Activity className="w-3 h-3" style={{ color }} />
                  <span className="text-[13px] font-black" style={{ color }}>
                    {grade.grade}
                  </span>
                </div>
                {sig.opportunityScore != null && sig.opportunityScore > 0 && (
                  <span className="text-[8px] font-semibold mt-0.5" style={{ color: `${color}99` }}>
                    Opp {oppGrade(sig.opportunityScore)}
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
