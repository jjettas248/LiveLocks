import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Minus, RefreshCw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface BucketStat {
  label: string;
  min: number;
  max: number;
  total: number;
  hits: number;
  winRate: number;
  roi: number;
}

interface AnalyticsSummary {
  buckets: BucketStat[];
  totalPlays: number;
  overallWinRate: number;
}

interface PlayAlert {
  id: number;
  gameId: string;
  gameDate: string;
  playerName: string;
  team: string;
  opponent: string;
  statType: string;
  halftimeStat: string;
  line: string;
  probability: string;
  betDirection: string;
  createdAt: string;
  actualStat: string | null;
  hit: boolean | null;
  resolvedAt: string | null;
}

const STAT_LABELS: Record<string, string> = {
  points: "PTS",
  rebounds: "REB",
  assists: "AST",
  threes: "3PM",
  steals: "STL",
  blocks: "BLK",
  pts_reb: "P+R",
  pts_ast: "P+A",
  pts_reb_ast: "P+R+A",
  reb_ast: "R+A",
  stl_blk: "S+B",
};

function getBucketColor(winRate: number, total: number) {
  if (total < 10) return "border-gray-700 bg-gray-800/50";
  if (winRate >= 60) return "border-green-600 bg-green-900/20";
  if (winRate >= 50) return "border-yellow-500 bg-yellow-900/20";
  return "border-red-600 bg-red-900/20";
}

function getBucketTextColor(winRate: number, total: number) {
  if (total < 10) return "text-gray-400";
  if (winRate >= 60) return "text-green-400";
  if (winRate >= 50) return "text-yellow-400";
  return "text-red-400";
}

function RoiIcon({ roi }: { roi: number }) {
  if (roi > 0) return <TrendingUp className="w-3 h-3 text-green-400 inline mr-1" />;
  if (roi < 0) return <TrendingDown className="w-3 h-3 text-red-400 inline mr-1" />;
  return <Minus className="w-3 h-3 text-gray-400 inline mr-1" />;
}

export function AnalyticsTab() {
  const queryClient = useQueryClient();
  const [isSettling, setIsSettling] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);

  const { data: summary, isLoading: summaryLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["/api/analytics/summary"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: alertsData, isLoading: alertsLoading } = useQuery<{ alerts: PlayAlert[] }>({
    queryKey: ["/api/analytics/alerts"],
    refetchInterval: 5 * 60 * 1000,
  });

  const alerts = alertsData?.alerts ?? [];

  async function handleManualSettle() {
    setIsSettling(true);
    try {
      const result = await apiRequest("POST", "/api/analytics/settle");
      const data = await result.json() as { settled: number; stillPending: number };
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/summary"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/alerts"] });
      setLastSynced(new Date().toLocaleTimeString());
      if (data.settled > 0) {
        console.log(`[settle] ${data.settled} play(s) settled, ${data.stillPending} still pending`);
      }
    } catch (err) {
      console.warn("[settle] Failed:", err);
    } finally {
      setIsSettling(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="analytics-tab">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white" data-testid="analytics-title">
            Model Performance
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            NBA Live 2H Plays — settled automatically from final box scores
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            data-testid="button-settle-now"
            onClick={handleManualSettle}
            disabled={isSettling}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
            style={{ background: "#181818", border: "1px solid #3f3f46", color: "#a1a1aa" }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#71717a"; (e.currentTarget as HTMLElement).style.color = "#ffffff"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#3f3f46"; (e.currentTarget as HTMLElement).style.color = "#a1a1aa"; }}
          >
            <RefreshCw className={`w-3 h-3 ${isSettling ? "animate-spin" : ""}`} />
            {isSettling ? "Settling..." : "↻ Settle Now"}
          </button>
          {lastSynced && (
            <span className="text-[10px]" style={{ color: "#52525b" }}>Last synced: {lastSynced}</span>
          )}
        </div>
      </div>

      {summaryLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0,1,2,3].map((i) => (
            <div key={i} className="rounded-xl border border-gray-700 bg-gray-800/50 p-4 animate-pulse h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {(summary?.buckets ?? []).map((bucket) => (
            <div
              key={bucket.label}
              data-testid={`bucket-card-${bucket.label.replace(/[^a-z0-9]/gi, "")}`}
              className={`rounded-xl border p-4 flex flex-col gap-1 ${getBucketColor(bucket.winRate, bucket.total)}`}
            >
              <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {bucket.label}
              </div>
              <div className={`text-3xl font-bold ${getBucketTextColor(bucket.winRate, bucket.total)}`}>
                {bucket.total < 10 ? "—" : `${bucket.winRate}%`}
              </div>
              <div className="text-xs text-gray-500">
                {bucket.total < 10 ? (
                  <span>{bucket.total} play{bucket.total !== 1 ? "s" : ""} (need 10+)</span>
                ) : (
                  <span>{bucket.hits}/{bucket.total} wins</span>
                )}
              </div>
              {bucket.total >= 10 && (
                <div className={`text-xs font-medium ${bucket.roi >= 0 ? "text-green-400" : "text-red-400"}`}>
                  <RoiIcon roi={bucket.roi} />
                  {bucket.roi >= 0 ? "+" : ""}{bucket.roi}% ROI
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="flex items-center gap-4 text-sm text-gray-400" data-testid="analytics-summary">
          <span>
            Total settled:{" "}
            <span className="text-white font-medium">{summary.totalPlays}</span>
          </span>
          {summary.totalPlays > 0 && (
            <span>
              Overall win rate:{" "}
              <span className={`font-medium ${summary.overallWinRate >= 60 ? "text-green-400" : summary.overallWinRate >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                {summary.overallWinRate}%
              </span>
            </span>
          )}
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Plays (last 100)</h3>
        {alertsLoading ? (
          <div className="space-y-2">
            {[0,1,2,3,4].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-gray-800/50 animate-pulse" />
            ))}
          </div>
        ) : alerts.length === 0 ? (
          <div className="text-center py-12 text-gray-500" data-testid="no-alerts-message">
            No plays recorded yet. Plays are captured automatically when NBA halftime plays are loaded.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-700">
            <table className="w-full text-sm" data-testid="alerts-table">
              <thead>
                <tr className="border-b border-gray-700 bg-gray-800/60">
                  <th className="text-left px-3 py-2 text-gray-400 font-medium">Date</th>
                  <th className="text-left px-3 py-2 text-gray-400 font-medium">Player</th>
                  <th className="text-left px-3 py-2 text-gray-400 font-medium">Stat</th>
                  <th className="text-center px-3 py-2 text-gray-400 font-medium">Dir</th>
                  <th className="text-center px-3 py-2 text-gray-400 font-medium">Line</th>
                  <th className="text-center px-3 py-2 text-gray-400 font-medium">Prob</th>
                  <th className="text-center px-3 py-2 text-gray-400 font-medium">Final</th>
                  <th className="text-center px-3 py-2 text-gray-400 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((alert, idx) => {
                  const prob = Number(alert.probability);
                  const conf = alert.betDirection === "over" ? prob : 100 - prob;
                  const rowBg =
                    alert.hit === true
                      ? "bg-green-900/10"
                      : alert.hit === false
                      ? "bg-red-900/10"
                      : "";
                  return (
                    <tr
                      key={alert.id}
                      data-testid={`alert-row-${alert.id}`}
                      className={`border-b border-gray-800 last:border-0 hover:bg-gray-800/30 transition-colors ${rowBg}`}
                    >
                      <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{alert.gameDate}</td>
                      <td className="px-3 py-2 text-white font-medium whitespace-nowrap">
                        {alert.playerName}
                        <span className="text-gray-500 text-xs ml-1">{alert.team}</span>
                      </td>
                      <td className="px-3 py-2 text-gray-300">{STAT_LABELS[alert.statType] ?? alert.statType}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`font-semibold ${alert.betDirection === "over" ? "text-green-400" : "text-red-400"}`}>
                          {alert.betDirection === "over" ? "O" : "U"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-white">{Number(alert.line).toFixed(1)}</td>
                      <td className="px-3 py-2 text-center text-gray-300">{conf.toFixed(0)}%</td>
                      <td className="px-3 py-2 text-center text-gray-300">
                        {alert.actualStat != null ? Number(alert.actualStat).toFixed(1) : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {alert.hit === true ? (
                          <span className="text-green-400 font-bold" data-testid={`result-hit-${alert.id}`}>HIT</span>
                        ) : alert.hit === false ? (
                          <span className="text-red-400 font-bold" data-testid={`result-miss-${alert.id}`}>MISS</span>
                        ) : (
                          <span className="text-gray-500" data-testid={`result-pending-${alert.id}`}>Pending</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
