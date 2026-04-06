import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Minus, RefreshCw, Target, Trophy, X as XIcon } from "lucide-react";
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

interface PersistedPlay {
  id: string;
  createdAt: string;
  gameId: string;
  playerId: string | null;
  playerName: string;
  team: string | null;
  sport: string;
  market: string;
  direction: string;
  line: string;
  prob: string;
  engineProb: string | null;
  bookImplied: string | null;
  edgeGap: string | null;
  gameDate: string;
  timestamp: string;
  result: string | null;
  finalStat: string | null;
  settledAt: string | null;
  notificationSent: boolean | null;
  duplicateGuard: string | null;
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
  const [isDeduping, setIsDeduping] = useState(false);
  const [dedupeMsg, setDedupeMsg] = useState<string | null>(null);

  const { data: summary, isLoading: summaryLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["/api/analytics/summary"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: alertsData, isLoading: alertsLoading } = useQuery<{ alerts: PlayAlert[] }>({
    queryKey: ["/api/analytics/alerts"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: persistedPlaysData, isLoading: persistedPlaysLoading } = useQuery<{ plays: PersistedPlay[]; total: number }>({
    queryKey: ["/api/plays"],
    refetchInterval: 5 * 60 * 1000,
  });

  const alerts = alertsData?.alerts ?? [];

  async function handleDedupe() {
    setIsDeduping(true);
    setDedupeMsg(null);
    try {
      const res = await apiRequest("POST", "/api/plays/dedupe");
      const data = await res.json() as { plays: { removed: number }; alerts: { removed: number } };
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/summary"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/alerts"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/plays"] });
      setDedupeMsg(`Removed ${data.alerts.removed} dup alerts + ${data.plays.removed} dup plays`);
    } catch (err) {
      setDedupeMsg("Dedupe failed");
      console.warn("[dedupe] Failed:", err);
    } finally {
      setIsDeduping(false);
    }
  }

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
          <div className="flex gap-2">
            <button
              data-testid="button-dedupe"
              onClick={handleDedupe}
              disabled={isDeduping}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors disabled:opacity-50"
              style={{ background: "#181818", border: "1px solid #3f3f46", color: "#a1a1aa" }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#71717a"; (e.currentTarget as HTMLElement).style.color = "#ffffff"; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#3f3f46"; (e.currentTarget as HTMLElement).style.color = "#a1a1aa"; }}
            >
              <RefreshCw className={`w-3 h-3 ${isDeduping ? "animate-spin" : ""}`} />
              {isDeduping ? "Deduping..." : "✕ Dedupe"}
            </button>
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
          </div>
          {dedupeMsg && (
            <span className="text-[10px]" style={{ color: "#22c55e" }}>{dedupeMsg}</span>
          )}
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

      {/* ── PERSISTED PLAYS SECTION ───────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-300">
            Persisted Plays (new table — duplicateGuard UNIQUE)
          </h3>
          {persistedPlaysData && (
            <span className="text-xs text-gray-500">
              {persistedPlaysData.total} total
            </span>
          )}
        </div>
        {persistedPlaysLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="h-10 rounded-lg animate-pulse"
                style={{ background: "#18181b" }}
              />
            ))}
          </div>
        ) : !persistedPlaysData || persistedPlaysData.plays.length === 0 ? (
          <div
            className="text-center py-8 rounded-xl text-xs"
            data-testid="no-persisted-plays-message"
            style={{ background: "#111", border: "1px solid #27272a", color: "#52525b" }}
          >
            No persisted plays yet — plays record automatically when NBA halftime plays load.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl" style={{ border: "1px solid #27272a" }}>
            <table className="w-full text-xs" data-testid="persisted-plays-table">
              <thead>
                <tr style={{ borderBottom: "1px solid #27272a", background: "#111" }}>
                  {["Date", "Player", "Sport", "Market", "Dir", "Line", "Prob", "Edge", "Result"].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium" style={{ color: "#71717a" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(persistedPlaysData.plays).map((play, idx) => {
                  const prob = Number(play.prob);
                  const edge = play.edgeGap != null ? Number(play.edgeGap) : null;
                  const resultColor = play.result === "hit" ? "#22c55e" : play.result === "miss" ? "#ef4444" : "#71717a";
                  return (
                    <tr
                      key={play.id}
                      data-testid={`persisted-play-row-${play.id}`}
                      style={{
                        borderBottom: idx < (persistedPlaysData.plays.length - 1) ? "1px solid #1a1a1a" : undefined,
                        background: play.result === "hit" ? "rgba(34,197,94,0.04)" : play.result === "miss" ? "rgba(239,68,68,0.04)" : undefined,
                      }}
                    >
                      <td className="px-3 py-2" style={{ color: "#71717a", whiteSpace: "nowrap" }}>{play.gameDate}</td>
                      <td className="px-3 py-2 font-medium" style={{ color: "#e4e4e7", whiteSpace: "nowrap" }}>
                        {play.playerName}
                        {play.team && <span className="ml-1" style={{ color: "#52525b" }}>{play.team}</span>}
                      </td>
                      <td className="px-3 py-2" style={{ color: "#a1a1aa" }}>{play.sport.toUpperCase()}</td>
                      <td className="px-3 py-2" style={{ color: "#a1a1aa" }}>{STAT_LABELS[play.market] ?? play.market}</td>
                      <td className="px-3 py-2 font-semibold" style={{ color: play.direction === "over" ? "#00d4aa" : "#ef4444" }}>
                        {play.direction === "over" ? "O" : "U"}
                      </td>
                      <td className="px-3 py-2 text-center" style={{ color: "#e4e4e7" }}>{Number(play.line).toFixed(1)}</td>
                      <td className="px-3 py-2 text-center" style={{ color: "#a1a1aa" }}>{prob.toFixed(0)}%</td>
                      <td className="px-3 py-2 text-center" style={{ color: edge != null && edge >= 10 ? "#f59e0b" : "#52525b" }}>
                        {edge != null ? `+${edge.toFixed(1)}pp` : "—"}
                      </td>
                      <td className="px-3 py-2 text-center font-bold" style={{ color: resultColor }}>
                        {play.result === "hit" ? "HIT" : play.result === "miss" ? "MISS" : play.result === "push" ? "PUSH" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <HrRadarAnalyticsSection />
    </div>
  );
}

interface HrRadarAnalyticsRecord {
  id: number;
  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  detectedLabel: string | null;
  hitLabel: string | null;
  detectedScore: string | null;
  peakScore: string | null;
  scoreIncreaseAmount: string | null;
  result: string;
  confidenceTier: string;
  triggerTags: string[];
  createdAt: string | null;
}

function HrRadarAnalyticsSection() {
  const [filterResult, setFilterResult] = useState<string>("all");
  const [filterTier, setFilterTier] = useState<string>("all");

  const { data, isLoading } = useQuery<{
    records: HrRadarAnalyticsRecord[];
    summary: { total: number; hits: number; misses: number; hitRate: number };
  }>({
    queryKey: ["/api/admin/hr-radar-analytics"],
    refetchInterval: 5 * 60 * 1000,
  });

  const records = data?.records ?? [];
  const summary = data?.summary ?? { total: 0, hits: 0, misses: 0, hitRate: 0 };

  const filtered = records.filter(r => {
    if (filterResult !== "all" && r.result !== filterResult) return false;
    if (filterTier !== "all" && r.confidenceTier !== filterTier) return false;
    return true;
  });

  const filteredHits = filtered.filter(r => r.result === "hit").length;
  const filteredMisses = filtered.filter(r => r.result === "miss").length;
  const filteredRate = filtered.length > 0 ? Math.round((filteredHits / filtered.length) * 1000) / 10 : 0;

  return (
    <div className="space-y-4 mt-6" data-testid="section-hr-radar-analytics">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-orange-400" />
        <h3 className="text-sm font-bold text-foreground">HR Radar Analytics</h3>
        <span className="text-[10px] text-muted-foreground ml-auto">{summary.total} total calls</span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <div className="text-center p-2 rounded-lg bg-muted/20 border border-border/20">
          <div className="text-[9px] text-muted-foreground">Total</div>
          <div className="text-sm font-bold text-foreground">{summary.total}</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <div className="text-[9px] text-emerald-400">Hits</div>
          <div className="text-sm font-bold text-emerald-400">{summary.hits}</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-zinc-500/10 border border-zinc-500/20">
          <div className="text-[9px] text-zinc-400">Misses</div>
          <div className="text-sm font-bold text-zinc-400">{summary.misses}</div>
        </div>
        <div className="text-center p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <div className="text-[9px] text-blue-400">Hit Rate</div>
          <div className="text-sm font-bold text-blue-400">{summary.hitRate}%</div>
        </div>
      </div>

      {records.length > 0 && (() => {
        const tiers = ["monitor", "building", "strong"] as const;
        const tierData = tiers.map(tier => {
          const tierRecords = records.filter(r => r.confidenceTier === tier);
          const tierHits = tierRecords.filter(r => r.result === "hit").length;
          const tierRate = tierRecords.length > 0 ? Math.round((tierHits / tierRecords.length) * 1000) / 10 : 0;
          const tierWithPeak = tierRecords.filter(r => r.peakScore != null && parseFloat(r.peakScore) > 0);
          const avgPeak = tierWithPeak.length > 0
            ? Math.round(tierWithPeak.reduce((sum, r) => sum + parseFloat(r.peakScore!), 0) / tierWithPeak.length * 10) / 10
            : 0;
          return { tier, total: tierRecords.length, hits: tierHits, rate: tierRate, avgPeak };
        }).filter(t => t.total > 0);

        const scoreBuckets = [
          { label: "0-3", min: 0, max: 3 },
          { label: "3-5", min: 3, max: 5 },
          { label: "5-7", min: 5, max: 7 },
          { label: "7+", min: 7, max: 999 },
        ].map(b => {
          const bRecords = records.filter(r => {
            if (!r.peakScore || parseFloat(r.peakScore) <= 0) return false;
            const pk = parseFloat(r.peakScore);
            return pk >= b.min && pk < b.max;
          });
          const bHits = bRecords.filter(r => r.result === "hit").length;
          return { ...b, total: bRecords.length, hits: bHits, rate: bRecords.length > 0 ? Math.round((bHits / bRecords.length) * 1000) / 10 : 0 };
        }).filter(b => b.total > 0);

        return (
          <div className="space-y-3">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Hit Rate by Tier</div>
            <div className="grid grid-cols-3 gap-2">
              {tierData.map(t => (
                <div key={t.tier} className={`p-2 rounded-lg border ${
                  t.tier === "strong" ? "border-red-500/20 bg-red-500/5" :
                  t.tier === "building" ? "border-orange-500/20 bg-orange-500/5" :
                  "border-zinc-500/20 bg-zinc-500/5"
                }`} data-testid={`tier-stat-${t.tier}`}>
                  <div className={`text-[9px] font-bold uppercase ${
                    t.tier === "strong" ? "text-red-400" : t.tier === "building" ? "text-orange-400" : "text-zinc-400"
                  }`}>{t.tier}</div>
                  <div className="text-sm font-bold text-foreground">{t.rate}%</div>
                  <div className="text-[9px] text-muted-foreground">{t.hits}/{t.total} | avg peak {t.avgPeak}</div>
                </div>
              ))}
            </div>
            {scoreBuckets.length > 0 && (
              <>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Hit Rate by Peak Score</div>
                <div className="flex gap-2">
                  {scoreBuckets.map(b => (
                    <div key={b.label} className="flex-1 text-center p-2 rounded-lg border border-border/20 bg-muted/10" data-testid={`score-bucket-${b.label}`}>
                      <div className="text-[9px] text-muted-foreground">{b.label}</div>
                      <div className={`text-xs font-bold ${b.rate >= 30 ? "text-emerald-400" : b.rate >= 15 ? "text-yellow-400" : "text-zinc-400"}`}>{b.rate}%</div>
                      <div className="text-[9px] text-muted-foreground">{b.hits}/{b.total}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })()}

      <div className="flex gap-2">
        <select
          className="text-[10px] bg-muted/20 border border-border/30 rounded-lg px-2 py-1 text-foreground"
          value={filterResult}
          onChange={e => setFilterResult(e.target.value)}
          data-testid="select-hr-analytics-result"
        >
          <option value="all">All Results</option>
          <option value="hit">Hits Only</option>
          <option value="miss">Misses Only</option>
        </select>
        <select
          className="text-[10px] bg-muted/20 border border-border/30 rounded-lg px-2 py-1 text-foreground"
          value={filterTier}
          onChange={e => setFilterTier(e.target.value)}
          data-testid="select-hr-analytics-tier"
        >
          <option value="all">All Tiers</option>
          <option value="monitor">Monitor</option>
          <option value="building">Building</option>
          <option value="strong">Strong</option>
        </select>
        <span className="text-[10px] text-muted-foreground ml-auto self-center">
          Showing {filtered.length} | {filteredHits}W / {filteredMisses}L ({filteredRate}%)
        </span>
      </div>

      {isLoading ? (
        <div className="text-center text-sm text-muted-foreground py-6">Loading analytics...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-6">No HR radar analytics data yet</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/30">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-border/30 bg-muted/10">
                <th className="px-2 py-1.5 text-left text-muted-foreground font-semibold">Date</th>
                <th className="px-2 py-1.5 text-left text-muted-foreground font-semibold">Player</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Team</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Detected</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Score</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Peak</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Tier</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Result</th>
                <th className="px-2 py-1.5 text-center text-muted-foreground font-semibold">Hit At</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 100).map((r) => {
                const detScore = r.detectedScore ? parseFloat(r.detectedScore) : null;
                const pkScore = r.peakScore ? parseFloat(r.peakScore) : null;
                return (
                  <tr key={r.id} className="border-b border-border/10 hover:bg-muted/10" data-testid={`row-hr-analytics-${r.id}`}>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.sessionDate}</td>
                    <td className="px-2 py-1.5 text-foreground font-semibold">{r.playerName}</td>
                    <td className="px-2 py-1.5 text-center text-muted-foreground">{r.team}</td>
                    <td className="px-2 py-1.5 text-center text-muted-foreground">{r.detectedLabel ?? "—"}</td>
                    <td className="px-2 py-1.5 text-center text-foreground font-bold tabular-nums">{detScore != null ? detScore.toFixed(1) : "—"}</td>
                    <td className="px-2 py-1.5 text-center text-foreground tabular-nums">{pkScore != null ? pkScore.toFixed(1) : "—"}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`px-1.5 py-0.5 rounded-full text-[8px] font-bold ${
                        r.confidenceTier === "strong" ? "bg-red-500/15 text-red-400" :
                        r.confidenceTier === "building" ? "bg-orange-500/15 text-orange-400" :
                        "bg-zinc-500/15 text-zinc-400"
                      }`}>{r.confidenceTier.toUpperCase()}</span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`font-bold ${r.result === "hit" ? "text-emerald-400" : "text-zinc-400"}`}>
                        {r.result === "hit" ? "HIT" : "MISS"}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center text-muted-foreground">{r.hitLabel ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
