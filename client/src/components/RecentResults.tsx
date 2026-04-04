import { useQuery } from "@tanstack/react-query";
import { CheckCircle, XCircle, Loader2, TrendingUp } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";

interface RecentResult {
  id: string;
  playerName: string;
  team: string | null;
  sport: string;
  market: string;
  direction: string;
  line: string;
  prob?: string;
  result: string | null;
  finalStat?: string | null;
  gameDate: string;
  settledAt: string | null;
  confidenceTier: string | null;
}

const MARKET_LABELS: Record<string, string> = {
  points: "PTS", rebounds: "REB", assists: "AST", steals: "STL", blocks: "BLK",
  threes: "3PM", pts_reb: "P+R", pts_ast: "P+A", reb_ast: "R+A", pts_reb_ast: "PRA",
  hits: "Hits", total_bases: "TB", home_runs: "HR", batter_strikeouts: "Ks",
  pitcher_strikeouts: "Pitcher K", rbis: "RBI", rbi: "RBI", walks: "BB",
  stolen_bases: "SB", earned_runs: "ER", hrr: "H+R+RBI", runs: "Runs",
  hits_allowed: "HA", walks_allowed: "WA", hr_allowed: "HRA", outs_recorded: "Outs",
  total: "Total", spread: "Spread",
};

const SPORT_COLORS: Record<string, string> = {
  mlb: "text-green-400",
  nba: "text-orange-400",
  ncaab: "text-blue-400",
};

export function RecentResults() {
  const { user } = useAuth();
  const { data, isLoading } = useQuery<{ results: RecentResult[]; canViewFullResults: boolean }>({
    queryKey: ["/api/recent-results"],
    refetchInterval: 60000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8" data-testid="recent-results-loading">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const results = data?.results ?? [];
  const canViewFullResults = data?.canViewFullResults ?? false;
  const isFreeUser = user && !user.isAdmin && !user.subscriptionTier;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8" data-testid="recent-results-loading">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground text-sm" data-testid="recent-results-empty">
        No recent results yet
      </div>
    );
  }

  const renderResults = () => (
    <div data-testid="recent-results-feed" className="space-y-2">
      <div className="flex items-center gap-2 px-1 mb-2">
        <TrendingUp className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Recent Results</span>
        <span className="text-[10px] text-muted-foreground ml-auto">{results.length} graded</span>
      </div>
      {results.map((r) => {
        const isHit = r.result === "hit";
        const isMiss = r.result === "miss";
        const isPush = r.result === "push";
        const marketLabel = MARKET_LABELS[r.market] ?? r.market;
        const sportColor = SPORT_COLORS[r.sport] ?? "text-muted-foreground";
        const prob = r.prob ? parseFloat(r.prob) : undefined;

        return (
          <div
            key={r.id}
            data-testid={`result-row-${r.id}`}
            className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
              isHit ? "border-green-500/20 bg-green-500/5" :
              isMiss ? "border-red-500/20 bg-red-500/5" :
              "border-border bg-card"
            }`}
          >
            <div className="shrink-0">
              {isHit && <CheckCircle className="w-4 h-4 text-green-400" />}
              {isMiss && <XCircle className="w-4 h-4 text-red-400" />}
              {isPush && <span className="w-4 h-4 rounded-full bg-yellow-500/30 flex items-center justify-center text-[8px] text-yellow-400 font-bold">P</span>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground truncate">{r.playerName}</span>
                <span className={`text-[9px] font-bold uppercase ${sportColor}`}>{r.sport.toUpperCase()}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-muted-foreground">{marketLabel}</span>
                <span className={`text-[10px] font-bold ${r.direction.toUpperCase() === "OVER" ? "text-green-400" : "text-blue-400"}`}>
                  {r.direction.toUpperCase()} {r.line}
                </span>
              </div>
            </div>
            <div className="text-right shrink-0">
              {prob !== undefined && (
                <div className="text-[10px] font-bold tabular-nums text-foreground">{prob.toFixed(0)}%</div>
              )}
              {r.finalStat != null && canViewFullResults && (
                <div className="text-[9px] text-muted-foreground tabular-nums">
                  Actual: {parseFloat(r.finalStat).toFixed(0)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  if (isFreeUser && !canViewFullResults) {
    return (
      <div className="relative">
        <div className="opacity-60 pointer-events-none">
          {renderResults()}
        </div>
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-background/20 to-background/60 rounded-lg backdrop-blur-sm">
          <div className="text-center">
            <p className="text-sm font-semibold text-foreground mb-2">Unlock Full Results</p>
            <p className="text-[11px] text-muted-foreground mb-3">Subscribe to see probabilities &amp; outcomes</p>
            <button
              data-testid="button-upgrade-recent-results"
              onClick={() => window.location.hash = "#upgrade"}
              className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-bold hover:opacity-90 transition-opacity"
            >
              Upgrade Now
            </button>
          </div>
        </div>
      </div>
    );
  }

  return renderResults();
}
