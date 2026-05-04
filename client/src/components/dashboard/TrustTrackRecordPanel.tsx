import { usePublicAnalytics } from "@/hooks/usePublicAnalytics";

const RESULT_STYLES: Record<string, string> = {
  hit: "bg-green-500/15 text-green-400 border-green-500/30",
  miss: "bg-red-500/15 text-red-400 border-red-500/30",
  push: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
};

const SPORT_COLORS: Record<string, string> = {
  NBA: "bg-orange-500/15 text-orange-400",
  NCAAB: "bg-blue-500/15 text-blue-400",
  MLB: "bg-green-500/15 text-green-400",
};

export function TrustTrackRecordPanel() {
  const { data, isLoading, isError } = usePublicAnalytics();

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/40 bg-card p-4 animate-pulse" data-testid="panel-trust-loading">
        <div className="h-4 w-32 bg-muted rounded mb-3" />
        <div className="grid grid-cols-3 gap-3">
          <div className="h-16 bg-muted rounded-lg" />
          <div className="h-16 bg-muted rounded-lg" />
          <div className="h-16 bg-muted rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-border/40 bg-card p-4" data-testid="panel-trust-error">
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-2">Engine Track Record</h3>
        <p className="text-xs text-muted-foreground">Unable to load track record. Retrying shortly.</p>
      </div>
    );
  }

  const { last7Days, bySport, recentResults } = data;

  // [PRIMARY ROI EXCLUSION v1] last7Days.roi/winRate are the Core Engine
  // numbers — the server already filters out home_runs + batter_strikeouts.
  // We surface the exclusion via a hover tooltip so users understand why
  // the headline differs from the all-markets number.
  const coreEngineHelp =
    "Core Engine ROI: excludes high-variance Home Run and Batter Strikeout props " +
    "(tracked separately in HR Radar). Reflects markets the engine is optimized for.";

  return (
    <div className="rounded-xl border border-border/40 bg-card overflow-hidden" data-testid="panel-trust-record">
      <div className="p-4 border-b border-border/30">
        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Engine Track Record</h3>
      </div>

      <div className="p-4 grid grid-cols-3 gap-3">
        <div className="bg-secondary/30 rounded-lg p-3 text-center" title={coreEngineHelp}>
          <div className="text-[10px] text-muted-foreground" data-testid="label-trust-winrate">7d Win Rate</div>
          <div
            data-testid="text-trust-winrate"
            className={`text-xl font-bold ${last7Days.winRate >= 55 ? "text-green-400" : "text-foreground"}`}
          >
            {last7Days.winRate}%
          </div>
        </div>
        <div className="bg-secondary/30 rounded-lg p-3 text-center" title={coreEngineHelp}>
          <div className="text-[10px] text-muted-foreground" data-testid="label-trust-roi">Core Engine ROI</div>
          <div
            data-testid="text-trust-roi"
            className={`text-xl font-bold ${last7Days.roi > 0 ? "text-green-400" : last7Days.roi < 0 ? "text-red-400" : "text-foreground"}`}
          >
            {last7Days.roi > 0 ? "+" : ""}{last7Days.roi}%
          </div>
        </div>
        <div className="bg-secondary/30 rounded-lg p-3 text-center" title={coreEngineHelp}>
          <div className="text-[10px] text-muted-foreground" data-testid="label-trust-plays">Plays (7d)</div>
          <div className="text-xl font-bold text-foreground" data-testid="text-trust-plays">{last7Days.plays}</div>
        </div>
      </div>

      <div
        className="px-4 -mt-1 pb-2 text-[10px] text-muted-foreground/80 italic"
        data-testid="text-trust-exclusion-footnote"
        title={coreEngineHelp}
      >
        Core Engine — excludes HR &amp; K props (see HR Radar)
      </div>

      {bySport.length > 0 && (
        <div className="px-4 pb-3 flex gap-2 flex-wrap">
          {bySport.map((s) => (
            <span key={s.sport} className={`text-[10px] font-semibold px-2 py-1 rounded-full ${SPORT_COLORS[s.sport] ?? "bg-muted text-muted-foreground"}`}>
              {s.sport}: {s.winRate}% ({s.plays})
            </span>
          ))}
        </div>
      )}

      {recentResults.length > 0 && (
        <div className="border-t border-border/30">
          <div className="px-4 py-2">
            <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Recent Results</div>
            <div className="space-y-1.5">
              {recentResults.slice(0, 3).map((r) => (
                <div key={r.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${RESULT_STYLES[r.result] ?? RESULT_STYLES.push}`}>
                      {r.result.toUpperCase()}
                    </span>
                    <span className="text-foreground font-medium truncate">{r.player}</span>
                    <span className="text-muted-foreground">{r.side} {r.market} {r.line}</span>
                  </div>
                  {r.finalStat != null && (
                    <span className="text-muted-foreground shrink-0">Final: {r.finalStat}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
