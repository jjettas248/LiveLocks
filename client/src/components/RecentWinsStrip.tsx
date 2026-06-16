import { useQuery } from "@tanstack/react-query";
import { CheckCircle, TrendingUp } from "lucide-react";

// Real recent results from the public analytics summary (last graded plays).
// Shape mirrors publicAnalyticsService.recentResults.
interface PublicRecentResult {
  id: string;
  sport: string;
  player: string;
  market: string;
  side: string;
  line: string;
  probability: number;
  result: string;
  finalStat: number | null;
  settledAt: string;
}

const MARKET_LABELS: Record<string, string> = {
  points: "Pts", rebounds: "Reb", assists: "Ast", steals: "Stl", blocks: "Blk",
  threes: "3PM", pts_reb: "P+R", pts_ast: "P+A", reb_ast: "R+A", pts_reb_ast: "PRA",
  hits: "Hits", total_bases: "TB", home_runs: "HR", batter_strikeouts: "Ks",
  pitcher_strikeouts: "Pitcher K", rbis: "RBI", rbi: "RBI", walks: "BB",
  stolen_bases: "SB", earned_runs: "ER", hrr: "H+R+RBI", runs: "Runs",
  hits_allowed: "HA", walks_allowed: "WA", hr_allowed: "HRA", outs_recorded: "Outs",
  total: "Total", spread: "Spread",
};

export function RecentWinsStrip() {
  const { data } = useQuery<{ recentResults?: PublicRecentResult[] }>({
    queryKey: ["/api/public-analytics/summary"],
    staleTime: 5 * 60 * 1000,
  });

  const settled = (data?.recentResults ?? []).filter(
    (r) => r.result === "hit" || r.result === "miss",
  );
  const wins = settled.filter((r) => r.result === "hit");

  // Only surface the strip when there are real recent wins to show — no
  // fabricated data, nothing rendered off-season or before any plays grade.
  if (wins.length === 0) return null;

  const shown = wins.slice(0, 3);

  return (
    <div className="animate-fade-in-up" style={{ animationDelay: "400ms", animationFillMode: "both" }}>
      <div className="flex items-center gap-1.5 mb-2.5" data-testid="text-momentum-label">
        <TrendingUp className="w-3.5 h-3.5 text-emerald-400/70" />
        <span className="text-xs font-medium text-muted-foreground/80">
          Model is {wins.length}/{settled.length} on recent graded plays
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="strip-recent-wins">
        {shown.map((win, idx) => {
          const marketLabel = MARKET_LABELS[win.market] ?? win.market;
          const prob = Math.round(win.probability);
          return (
            <div
              key={win.id}
              data-testid={`card-recent-win-${idx}`}
              className="flex items-center gap-3 rounded-lg border border-border/30 bg-card/60 px-3 py-2.5 opacity-75"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground/80 truncate">{win.player}</p>
                <p className="text-xs text-muted-foreground/70 truncate">
                  {win.side?.toUpperCase()} {win.line} {marketLabel}
                  {prob > 0 ? ` · ${prob}%` : ""}
                </p>
              </div>
              <span className="inline-flex items-center gap-1 shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400/80">
                <CheckCircle className="w-3 h-3" />
                Won
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
