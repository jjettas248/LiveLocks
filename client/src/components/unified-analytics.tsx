import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getAuthToken } from "@/lib/queryClient";
import {
  TrendingUp, RefreshCw, Target, BarChart3, CheckCircle, XCircle,
  ArrowUp, ArrowDown, Activity, Loader2, Minus, Calendar
} from "lucide-react";

type SportFilter = "all" | "nba" | "mlb" | "ncaab";
type DirFilter = "all" | "over" | "under";
type RangeFilter = "1d" | "7d" | "30d" | "all";
type SubView = "dashboard" | "hr-radar";

interface PerformancePlay {
  id: string;
  sport: string;
  player: string;
  stat: string;
  direction: "O" | "U" | string;
  line: number;
  probability: number;
  edge: number;
  finalStat: number | null;
  result: "HIT" | "MISS" | "PUSH" | null;
  gameId: string;
  createdAt: string;
  settledAt: string | null;
  confidenceTier: string | null;
  team: string | null;
}

interface BucketStat {
  label: string;
  total: number;
  hits: number;
  winRate: number;
}

interface PerformanceSummary {
  total: number;
  hits: number;
  misses: number;
  pushes: number;
  winRate: number;
  avgEdge: number;
  avgProb: number;
}

interface PerformanceResponse {
  plays: PerformancePlay[];
  buckets: BucketStat[];
  summary: PerformanceSummary;
}

interface ConfidenceBucket {
  label: string;
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
}

interface BucketFilter { direction: string; marketType: string; archetype: string; flagship: string }

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

const STAT_LABELS: Record<string, string> = {
  points: "PTS", rebounds: "REB", assists: "AST", threes: "3PM",
  steals: "STL", blocks: "BLK", pts_reb: "P+R", pts_ast: "P+A",
  pts_reb_ast: "P+R+A", reb_ast: "R+A", stl_blk: "S+B",
};

const SPORT_OPTIONS: { value: SportFilter; label: string }[] = [
  { value: "all", label: "All Sports" },
  { value: "nba", label: "NBA" },
  { value: "mlb", label: "MLB" },
  { value: "ncaab", label: "NCAAB" },
];

const DIR_OPTIONS: { value: DirFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "over", label: "Overs" },
  { value: "under", label: "Unders" },
];

const RANGE_OPTIONS: { value: RangeFilter; label: string }[] = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All Time" },
];

function formatMarket(market: string): string {
  const map: Record<string, string> = {
    points: "Points", rebounds: "Rebounds", assists: "Assists",
    threes: "3PT Made", steals: "Steals", blocks: "Blocks",
    pts_rebs_asts: "PRA", pts_rebs: "Pts+Reb", pts_asts: "Pts+Ast",
    rebs_asts: "Reb+Ast", hits: "Hits", total_bases: "Total Bases",
    home_runs: "Home Runs", pitcher_strikeouts: "Strikeouts",
    rbi: "RBI", runs: "Runs", stolen_bases: "Stolen Bases", hrr: "H+R+RBI",
  };
  return map[market] ?? market.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function ToggleGroup({ options, value, onChange, testId }: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: any) => void;
  testId: string;
}) {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden" data-testid={testId}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "bg-card text-muted-foreground hover:bg-muted"
          }`}
          data-testid={`${testId}-${opt.value}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function DashboardSection() {
  const queryClient = useQueryClient();
  const [sport, setSport] = useState<SportFilter>("all");
  const [direction, setDirection] = useState<DirFilter>("all");
  const [range, setRange] = useState<RangeFilter>("all");
  const [page, setPage] = useState(0);
  const [isSettling, setIsSettling] = useState(false);
  const [isDeduping, setIsDeduping] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [bucketFilters, setBucketFilters] = useState<BucketFilter>({ direction: "", marketType: "", archetype: "", flagship: "" });
  const PAGE_SIZE = 50;

  const { data, isLoading } = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", sport, direction, range],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sport !== "all") params.set("sport", sport);
      if (direction !== "all") params.set("direction", direction);
      if (range !== "all") params.set("range", range);
      const res = await fetch(`/api/performance?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch performance data");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const bucketQueryStr = Object.entries(bucketFilters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("&");
  const sportForBuckets = sport === "all" ? "nba" : sport;
  const { data: confBucketData } = useQuery<{ buckets: ConfidenceBucket[] }>({
    queryKey: ["/api/analytics/confidence-buckets", sportForBuckets, range, bucketQueryStr],
    queryFn: async () => {
      const token = getAuthToken();
      let dateParams = "";
      if (range !== "all") {
        const now = new Date();
        const d = new Date(now);
        if (range === "1d") dateParams = `&startDate=${now.toISOString().slice(0, 10)}`;
        else if (range === "7d") { d.setDate(d.getDate() - 7); dateParams = `&startDate=${d.toISOString().slice(0, 10)}`; }
        else if (range === "30d") { d.setDate(d.getDate() - 30); dateParams = `&startDate=${d.toISOString().slice(0, 10)}`; }
      }
      const res = await fetch(`/api/analytics/confidence-buckets?sport=${sportForBuckets}${dateParams}${bucketQueryStr ? "&" + bucketQueryStr : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: sport === "nba" || sport === "ncaab" || sport === "all",
  });

  const summary = data?.summary;
  const probBuckets = data?.buckets ?? [];
  const allPlays = data?.plays ?? [];
  const pagedPlays = allPlays.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(allPlays.length / PAGE_SIZE);

  const roi = summary && (summary.hits + summary.misses) > 0
    ? Math.round(((summary.hits * 90.91 - summary.misses * 100) / (summary.hits + summary.misses)) * 10) / 10
    : 0;

  const overPlays = allPlays.filter(p => p.direction === "O");
  const underPlays = allPlays.filter(p => p.direction === "U");
  const overHits = overPlays.filter(p => p.result === "HIT").length;
  const underHits = underPlays.filter(p => p.result === "HIT").length;
  const overDecided = overPlays.filter(p => p.result === "HIT" || p.result === "MISS").length;
  const underDecided = underPlays.filter(p => p.result === "HIT" || p.result === "MISS").length;
  const overWinRate = overDecided > 0 ? Math.round((overHits / overDecided) * 1000) / 10 : 0;
  const underWinRate = underDecided > 0 ? Math.round((underHits / underDecided) * 1000) / 10 : 0;

  async function handleDedupe() {
    setIsDeduping(true); setActionMsg(null);
    try {
      const res = await apiRequest("POST", "/api/plays/dedupe");
      const d = await res.json() as { plays: { removed: number }; alerts: { removed: number } };
      await queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/confidence-buckets"] });
      setActionMsg(`Removed ${d.alerts.removed} dup alerts + ${d.plays.removed} dup plays`);
    } catch { setActionMsg("Dedupe failed"); }
    finally { setIsDeduping(false); }
  }

  async function handleSettle() {
    setIsSettling(true); setActionMsg(null);
    try {
      const res = await apiRequest("POST", "/api/analytics/settle");
      const d = await res.json() as { settled: number; stillPending: number };
      await queryClient.invalidateQueries({ queryKey: ["/api/performance"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/analytics/confidence-buckets"] });
      setActionMsg(`Settled ${d.settled} plays, ${d.stillPending} still pending`);
    } catch { setActionMsg("Settle failed"); }
    finally { setIsSettling(false); }
  }

  const filterBtn = (label: string, key: keyof BucketFilter, value: string) => (
    <button
      data-testid={`button-bucket-filter-${key}-${value || "all"}`}
      onClick={() => setBucketFilters(f => ({ ...f, [key]: f[key] === value ? "" : value }))}
      className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
        bucketFilters[key] === value
          ? "bg-primary/20 text-primary border-primary/30"
          : "bg-card text-muted-foreground border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-5" data-testid="analytics-dashboard">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <ToggleGroup options={SPORT_OPTIONS} value={sport} onChange={(v: SportFilter) => { setSport(v); setPage(0); }} testId="filter-sport" />
          <ToggleGroup options={RANGE_OPTIONS} value={range} onChange={(v: RangeFilter) => { setRange(v); setPage(0); }} testId="filter-range" />
          <ToggleGroup options={DIR_OPTIONS} value={direction} onChange={(v: DirFilter) => { setDirection(v); setPage(0); }} testId="filter-direction" />
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex gap-2">
            <button data-testid="button-dedupe" onClick={handleDedupe} disabled={isDeduping}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${isDeduping ? "animate-spin" : ""}`} />
              {isDeduping ? "Deduping..." : "Dedupe"}
            </button>
            <button data-testid="button-settle-now" onClick={handleSettle} disabled={isSettling}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground transition-colors disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${isSettling ? "animate-spin" : ""}`} />
              {isSettling ? "Settling..." : "Settle Now"}
            </button>
          </div>
          {actionMsg && <span className="text-[10px] text-green-400">{actionMsg}</span>}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" data-testid="kpi-row">
            <KpiCard icon={Target} label="Win Rate" value={`${summary.winRate}%`} sub={`${summary.hits}W - ${summary.misses}L`}
              color={summary.winRate >= 55 ? "text-emerald-500" : summary.winRate >= 50 ? "text-yellow-500" : "text-red-500"} />
            <KpiCard icon={Activity} label="Total Plays" value={summary.total.toLocaleString()} sub={`${summary.hits + summary.misses} decided`} />
            <KpiCard icon={TrendingUp} label="ROI (@ -110)" value={`${roi > 0 ? "+" : ""}${roi}%`}
              color={roi >= 0 ? "text-emerald-500" : "text-red-500"} />
            <KpiCard icon={BarChart3} label="Avg Edge" value={`${summary.avgEdge > 0 ? "+" : ""}${summary.avgEdge}%`}
              color={summary.avgEdge > 0 ? "text-emerald-500" : "text-red-500"} />
            <KpiCard icon={BarChart3} label="Avg Prob" value={`${summary.avgProb}%`} />
            <KpiCard icon={ArrowUp} label="O / U Split" value={direction === "all" ? `${overWinRate}% / ${underWinRate}%` : `${summary.winRate}%`}
              sub={direction === "all" ? "OVER / UNDER win%" : `${direction.toUpperCase()} only`} />
          </div>

          {probBuckets.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2" data-testid="prob-bucket-title">
                Probability Buckets
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2" data-testid="prob-bucket-grid">
                {probBuckets.map((b) => (
                  <div key={b.label} className="rounded-xl border border-border bg-card p-3" data-testid={`prob-bucket-${b.label}`}>
                    <p className="text-[10px] font-medium text-muted-foreground mb-0.5">{b.label}</p>
                    <p className={`text-lg font-bold ${
                      b.winRate >= 65 ? "text-emerald-500" : b.winRate >= 55 ? "text-yellow-500" : b.winRate > 0 ? "text-orange-500" : "text-muted-foreground"
                    }`}>{b.total > 0 ? `${b.winRate}%` : "—"}</p>
                    <p className="text-[10px] text-muted-foreground">{b.hits}/{b.total} hit</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {sport !== "mlb" && confBucketData?.buckets && confBucketData.buckets.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2" data-testid="conf-bucket-title">
                Confidence Buckets ({sportForBuckets.toUpperCase()})
              </h3>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {filterBtn("Over", "direction", "over")}
                {filterBtn("Under", "direction", "under")}
                <span className="w-px bg-border" />
                {filterBtn("Single", "marketType", "single")}
                {filterBtn("Combo", "marketType", "combo")}
                <span className="w-px bg-border" />
                {filterBtn("Flagship", "flagship", "flagship")}
                {filterBtn("Derivative", "flagship", "derivative")}
                <span className="w-px bg-border" />
                {filterBtn("Stable", "archetype", "stable_star")}
                {filterBtn("Volatile", "archetype", "volatile_starter")}
              </div>
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Bucket</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Total</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">W</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">L</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">P</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Win%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {confBucketData.buckets.map((b, i) => (
                      <tr key={b.label} data-testid={`row-conf-bucket-${b.label}`} className={`border-b border-border/50 ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
                        <td className="px-3 py-1.5 font-medium text-foreground">{b.label}</td>
                        <td className="px-3 py-1.5 text-center text-muted-foreground">{b.total}</td>
                        <td className="px-3 py-1.5 text-center text-green-400">{b.wins}</td>
                        <td className="px-3 py-1.5 text-center text-red-400">{b.losses}</td>
                        <td className="px-3 py-1.5 text-center text-muted-foreground">{b.pushes}</td>
                        <td className="px-3 py-1.5 text-center font-semibold" style={{ color: b.winRate >= 55 ? "#4ade80" : b.winRate >= 50 ? "#facc15" : "#f87171" }}>
                          {b.winRate > 0 ? `${b.winRate}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2" data-testid="play-table-title">
                <Calendar className="w-3.5 h-3.5" />
                Play History
                <span className="font-normal">({allPlays.length})</span>
              </h3>
              {totalPages > 1 && (
                <div className="flex items-center gap-2" data-testid="pagination">
                  <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="px-2 py-1 text-xs border border-border rounded disabled:opacity-30" data-testid="btn-prev">Prev</button>
                  <span className="text-xs text-muted-foreground">{page + 1}/{totalPages}</span>
                  <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="px-2 py-1 text-xs border border-border rounded disabled:opacity-30" data-testid="btn-next">Next</button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs" data-testid="play-table">
                <thead>
                  <tr className="bg-muted/50 text-left text-[10px] text-muted-foreground">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Player</th>
                    <th className="px-3 py-2">Sport</th>
                    <th className="px-3 py-2 hidden sm:table-cell">Market</th>
                    <th className="px-3 py-2 text-center">Dir</th>
                    <th className="px-3 py-2 text-right">Line</th>
                    <th className="px-3 py-2 text-right hidden sm:table-cell">Prob</th>
                    <th className="px-3 py-2 text-right hidden sm:table-cell">Edge</th>
                    <th className="px-3 py-2 text-right">Final</th>
                    <th className="px-3 py-2 text-center">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPlays.length === 0 && (
                    <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">No plays found for these filters.</td></tr>
                  )}
                  {pagedPlays.map((p, i) => (
                    <tr key={p.id} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-card" : "bg-card/50"}`} data-testid={`play-row-${p.id}`}>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{p.settledAt ? new Date(p.settledAt).toLocaleDateString() : new Date(p.createdAt).toLocaleDateString()}</td>
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{p.player}{p.team && <span className="text-muted-foreground ml-1">({p.team})</span>}</td>
                      <td className="px-3 py-1.5"><span className={`font-medium px-1.5 py-0.5 rounded text-[10px] ${p.sport === "nba" ? "bg-orange-500/20 text-orange-400" : p.sport === "mlb" ? "bg-blue-500/20 text-blue-400" : "bg-purple-500/20 text-purple-400"}`}>{p.sport?.toUpperCase()}</span></td>
                      <td className="px-3 py-1.5 hidden sm:table-cell">{formatMarket(p.stat)}</td>
                      <td className="px-3 py-1.5 text-center"><span className={`font-bold ${p.direction === "O" ? "text-emerald-400" : "text-red-400"}`}>{p.direction === "O" ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />}{p.direction}</span></td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.line}</td>
                      <td className="px-3 py-1.5 text-right font-mono hidden sm:table-cell">{p.probability.toFixed(1)}%</td>
                      <td className="px-3 py-1.5 text-right font-mono hidden sm:table-cell"><span className={p.edge > 0 ? "text-emerald-400" : "text-muted-foreground"}>{p.edge > 0 ? "+" : ""}{p.edge.toFixed(1)}%</span></td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.finalStat ?? "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        {p.result === "HIT" && <span className="inline-flex items-center gap-0.5 font-bold text-emerald-400"><CheckCircle className="w-3 h-3" />HIT</span>}
                        {p.result === "MISS" && <span className="inline-flex items-center gap-0.5 font-bold text-red-400"><XCircle className="w-3 h-3" />MISS</span>}
                        {p.result === "PUSH" && <span className="inline-flex items-center gap-0.5 font-bold text-gray-400"><Minus className="w-3 h-3" />PUSH</span>}
                        {!p.result && <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, sub, color = "text-foreground" }: {
  icon: typeof Target; label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3" data-testid={`kpi-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-[10px] text-muted-foreground">{label}</p>
      </div>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function HrRadarSection() {
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
    <div className="space-y-4" data-testid="section-hr-radar-analytics">
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
        <Target className="w-4 h-4 text-orange-400" />
        HR Radar Analytics
        <span className="text-[10px] text-muted-foreground ml-auto">{summary.total} total calls</span>
      </h3>

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
        <select className="text-[10px] bg-muted/20 border border-border/30 rounded-lg px-2 py-1 text-foreground" value={filterResult} onChange={e => setFilterResult(e.target.value)} data-testid="select-hr-analytics-result">
          <option value="all">All Results</option>
          <option value="hit">Hits Only</option>
          <option value="miss">Misses Only</option>
        </select>
        <select className="text-[10px] bg-muted/20 border border-border/30 rounded-lg px-2 py-1 text-foreground" value={filterTier} onChange={e => setFilterTier(e.target.value)} data-testid="select-hr-analytics-tier">
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
        <div className="flex items-center justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-6 border border-border rounded-xl">No HR radar analytics data yet</div>
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

export function UnifiedAnalyticsPanel() {
  const [subView, setSubView] = useState<SubView>("dashboard");

  const subTabs: { value: SubView; label: string; icon: typeof BarChart3 }[] = [
    { value: "dashboard", label: "Dashboard", icon: BarChart3 },
    { value: "hr-radar", label: "HR Radar", icon: Target },
  ];

  return (
    <div className="space-y-4" data-testid="unified-analytics-panel">
      <div className="flex rounded-lg bg-muted/50 p-1 w-fit">
        {subTabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              data-testid={`analytics-subtab-${tab.value}`}
              onClick={() => setSubView(tab.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                subView === tab.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-3 h-3" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {subView === "dashboard" && <DashboardSection />}
      {subView === "hr-radar" && <HrRadarSection />}
    </div>
  );
}
