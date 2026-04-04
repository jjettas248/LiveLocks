import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { getAuthToken } from "@/lib/queryClient";
import { TrendingUp, CheckCircle, Clock, Target, ArrowUp, ArrowDown, BarChart3, XCircle, Minus, Filter, Calendar, Activity } from "lucide-react";

type League = "NBA" | "MLB" | "NCAAB";
type Range = "7d" | "30d" | "all";
type BucketFilter = { direction: string; marketType: string; archetype: string; flagship: string };

type RecentPlay = {
  id: string;
  playerName: string;
  team: string | null;
  market: string;
  direction: string;
  line: string;
  prob: string;
  gameDate: string;
  result: string | null;
  finalStat: string | null;
};

type AnalyticsSummary = {
  league: League;
  range: Range;
  winRate: number;
  totalSettled: number;
  totalHits: number;
  roi: number;
  pending: number;
  overWinRate: number;
  underWinRate: number;
  recentPlays: RecentPlay[];
};

type SportFilter = "all" | "nba" | "mlb";
type DirFilter = "all" | "over" | "under";
type RangeFilter = "1d" | "7d" | "30d" | "all";

type PerformancePlay = {
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
};

type BucketStat = {
  label: string;
  total: number;
  hits: number;
  winRate: number;
};

type PerformanceSummary = {
  total: number;
  hits: number;
  misses: number;
  pushes: number;
  winRate: number;
  avgEdge: number;
  avgProb: number;
};

type PerformanceResponse = {
  plays: PerformancePlay[];
  buckets: BucketStat[];
  summary: PerformanceSummary;
};

const SPORT_OPTIONS: { value: SportFilter; label: string }[] = [
  { value: "all", label: "All Sports" },
  { value: "nba", label: "NBA" },
  { value: "mlb", label: "MLB" },
];

const DIR_OPTIONS: { value: DirFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "over", label: "Overs" },
  { value: "under", label: "Unders" },
];

const PERF_RANGE_OPTIONS: { value: RangeFilter; label: string }[] = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

const LEAGUE_LABELS: Record<League, string> = { NBA: "NBA", MLB: "MLB", NCAAB: "NCAAB" };
const RANGE_LABELS: Record<Range, string> = { "7d": "7 Days", "30d": "30 Days", all: "All Time" };

function StatCard({ label, value, sub, color = "text-foreground" }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function resultBadge(result: string | null) {
  if (result === "hit") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-semibold">HIT</span>;
  if (result === "miss") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 font-semibold">MISS</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">PENDING</span>;
}

function directionIcon(direction: string) {
  if (direction === "over") return <ArrowUp className="w-3 h-3 text-green-400 inline-block mr-0.5" />;
  if (direction === "under") return <ArrowDown className="w-3 h-3 text-red-400 inline-block mr-0.5" />;
  return null;
}

function ConfidenceBuckets() {
  const [filters, setFilters] = useState<BucketFilter>({ direction: "", marketType: "", archetype: "", flagship: "" });

  const queryStr = Object.entries(filters)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const { data, isLoading } = useQuery<{ buckets: { label: string; total: number; wins: number; losses: number; pushes: number; winRate: number }[] }>({
    queryKey: ["/api/analytics/confidence-buckets", queryStr],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`/api/analytics/confidence-buckets?sport=nba${queryStr ? "&" + queryStr : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const filterBtn = (label: string, key: keyof BucketFilter, value: string) => (
    <button
      data-testid={`button-bucket-filter-${key}-${value || "all"}`}
      onClick={() => setFilters(f => ({ ...f, [key]: f[key] === value ? "" : value }))}
      className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
        filters[key] === value
          ? "bg-primary/20 text-primary border-primary/30"
          : "bg-card text-muted-foreground border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-muted-foreground" />
        Confidence Buckets
      </h2>
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

      {isLoading ? (
        <div className="rounded-xl border border-border bg-card p-4 animate-pulse h-24" />
      ) : !data?.buckets ? null : (
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
              {data.buckets.map((b, i) => (
                <tr key={b.label} data-testid={`row-bucket-${b.label}`} className={`border-b border-border/50 ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
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
      )}
    </div>
  );
}

function PerfToggleGroup({ options, value, onChange, testId }: {
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

function ModelPerformanceSection() {
  const [sport, setSport] = useState<SportFilter>("all");
  const [direction, setDirection] = useState<DirFilter>("all");
  const [perfRange, setPerfRange] = useState<RangeFilter>("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const { data, isLoading } = useQuery<PerformanceResponse>({
    queryKey: ["/api/performance", sport, direction, perfRange],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sport !== "all") params.set("sport", sport);
      if (direction !== "all") params.set("direction", direction);
      if (perfRange !== "all") params.set("range", perfRange);
      const res = await fetch(`/api/performance?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch performance data");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const summary = data?.summary;
  const buckets = data?.buckets ?? [];
  const allPlays = data?.plays ?? [];
  const pagedPlays = allPlays.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(allPlays.length / PAGE_SIZE);

  return (
    <div className="space-y-4 mt-8 pt-6 border-t border-border" data-testid="model-performance-section">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h2 className="text-base font-bold flex items-center gap-2" data-testid="perf-section-title">
          <BarChart3 className="w-5 h-5 text-primary" />
          Model Performance
        </h2>
        <div className="flex flex-wrap gap-2">
          <PerfToggleGroup options={SPORT_OPTIONS} value={sport} onChange={(v: SportFilter) => { setSport(v); setPage(0); }} testId="perf-filter-sport" />
          <PerfToggleGroup options={PERF_RANGE_OPTIONS} value={perfRange} onChange={(v: RangeFilter) => { setPerfRange(v); setPage(0); }} testId="perf-filter-range" />
          <PerfToggleGroup options={DIR_OPTIONS} value={direction} onChange={(v: DirFilter) => { setDirection(v); setPage(0); }} testId="perf-filter-direction" />
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-10">
          <div className="animate-spin w-6 h-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      )}

      {!isLoading && summary && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="perf-kpi-row">
            <div className="rounded-xl border border-border bg-card p-3" data-testid="kpi-total-plays">
              <div className="flex items-center gap-1.5 mb-1"><Activity className="w-3.5 h-3.5 text-muted-foreground" /><p className="text-[10px] text-muted-foreground">Total Plays</p></div>
              <p className="text-xl font-bold">{summary.total.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">{summary.hits + summary.misses} decided</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3" data-testid="kpi-win-rate">
              <div className="flex items-center gap-1.5 mb-1"><Target className="w-3.5 h-3.5 text-muted-foreground" /><p className="text-[10px] text-muted-foreground">Win Rate</p></div>
              <p className={`text-xl font-bold ${summary.winRate >= 55 ? "text-emerald-500" : summary.winRate >= 50 ? "text-yellow-500" : "text-red-500"}`}>{summary.winRate}%</p>
              <p className="text-[10px] text-muted-foreground">{summary.hits}W - {summary.misses}L</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3" data-testid="kpi-hits-misses">
              <div className="flex items-center gap-1.5 mb-1"><CheckCircle className="w-3.5 h-3.5 text-muted-foreground" /><p className="text-[10px] text-muted-foreground">Hits / Misses</p></div>
              <p className="text-xl font-bold">{summary.hits} / {summary.misses}</p>
              {summary.pushes > 0 && <p className="text-[10px] text-muted-foreground">{summary.pushes} pushes</p>}
            </div>
            <div className="rounded-xl border border-border bg-card p-3" data-testid="kpi-avg-edge">
              <div className="flex items-center gap-1.5 mb-1"><TrendingUp className="w-3.5 h-3.5 text-muted-foreground" /><p className="text-[10px] text-muted-foreground">Avg Edge</p></div>
              <p className={`text-xl font-bold ${summary.avgEdge > 0 ? "text-emerald-500" : "text-red-500"}`}>{summary.avgEdge > 0 ? "+" : ""}{summary.avgEdge}%</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-3" data-testid="kpi-avg-prob">
              <div className="flex items-center gap-1.5 mb-1"><BarChart3 className="w-3.5 h-3.5 text-muted-foreground" /><p className="text-[10px] text-muted-foreground">Avg Probability</p></div>
              <p className="text-xl font-bold">{summary.avgProb}%</p>
            </div>
          </div>

          {buckets.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2" data-testid="perf-bucket-title">
                <Filter className="w-3.5 h-3.5" />
                Probability Buckets
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="perf-bucket-grid">
                {buckets.map((b) => (
                  <div key={b.label} className="rounded-xl border border-border bg-card p-3" data-testid={`perf-bucket-${b.label}`}>
                    <p className="text-xs font-medium text-muted-foreground mb-1">{b.label}</p>
                    <p className={`text-xl font-bold ${
                      b.winRate >= 65 ? "text-emerald-500" : b.winRate >= 55 ? "text-yellow-500" : b.winRate > 0 ? "text-orange-500" : "text-muted-foreground"
                    }`}>{b.winRate}%</p>
                    <p className="text-[10px] text-muted-foreground">{b.hits}/{b.total} hit</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold flex items-center gap-2" data-testid="perf-table-title">
                <Calendar className="w-3.5 h-3.5" />
                Play History
                <span className="text-xs font-normal text-muted-foreground">({allPlays.length})</span>
              </h3>
              {totalPages > 1 && (
                <div className="flex items-center gap-2" data-testid="perf-pagination">
                  <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} className="px-2 py-1 text-xs border border-border rounded disabled:opacity-30" data-testid="perf-btn-prev">Prev</button>
                  <span className="text-xs text-muted-foreground">{page + 1}/{totalPages}</span>
                  <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} className="px-2 py-1 text-xs border border-border rounded disabled:opacity-30" data-testid="perf-btn-next">Next</button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-xs" data-testid="perf-play-table">
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
                    <tr><td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">No settled plays found.</td></tr>
                  )}
                  {pagedPlays.map((p, i) => (
                    <tr key={p.id} className={`border-t border-border/50 ${i % 2 === 0 ? "bg-card" : "bg-card/50"}`} data-testid={`perf-play-row-${p.id}`}>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{p.settledAt ? new Date(p.settledAt).toLocaleDateString() : new Date(p.createdAt).toLocaleDateString()}</td>
                      <td className="px-3 py-1.5 font-medium whitespace-nowrap">{p.player}{p.team && <span className="text-muted-foreground ml-1">({p.team})</span>}</td>
                      <td className="px-3 py-1.5"><span className={`font-medium px-1.5 py-0.5 rounded ${p.sport === "nba" ? "bg-orange-500/20 text-orange-400" : p.sport === "mlb" ? "bg-blue-500/20 text-blue-400" : "bg-purple-500/20 text-purple-400"}`}>{p.sport?.toUpperCase()}</span></td>
                      <td className="px-3 py-1.5 hidden sm:table-cell">{formatMarket(p.stat)}</td>
                      <td className="px-3 py-1.5 text-center"><span className={`font-bold ${p.direction === "O" ? "text-emerald-400" : "text-red-400"}`}>{p.direction === "O" ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />}{p.direction}</span></td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.line}</td>
                      <td className="px-3 py-1.5 text-right font-mono hidden sm:table-cell">{p.probability.toFixed(1)}%</td>
                      <td className="px-3 py-1.5 text-right font-mono hidden sm:table-cell"><span className={p.edge > 0 ? "text-emerald-400" : "text-muted-foreground"}>{p.edge > 0 ? "+" : ""}{p.edge.toFixed(1)}%</span></td>
                      <td className="px-3 py-1.5 text-right font-mono">{p.finalStat ?? "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        {p.result === "HIT" && <span className="inline-flex items-center gap-0.5 font-bold text-emerald-400" data-testid={`perf-result-hit-${p.id}`}><CheckCircle className="w-3 h-3" />HIT</span>}
                        {p.result === "MISS" && <span className="inline-flex items-center gap-0.5 font-bold text-red-400" data-testid={`perf-result-miss-${p.id}`}><XCircle className="w-3 h-3" />MISS</span>}
                        {p.result === "PUSH" && <span className="inline-flex items-center gap-0.5 font-bold text-gray-400" data-testid={`perf-result-push-${p.id}`}><Minus className="w-3 h-3" />PUSH</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function AnalyticsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const [league, setLeague] = useState<League>("NBA");
  const [range, setRange] = useState<Range>("all");

  useEffect(() => {
    if (!authLoading && (!user || !user.isAdmin)) {
      navigate("/dashboard");
    }
  }, [authLoading, user, navigate]);

  const isAdmin = !!user?.isAdmin && !authLoading;

  const { data, isLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["/api/analytics/summary", league, range],
    queryFn: async () => {
      const token = getAuthToken();
      const res = await fetch(`/api/analytics/summary?league=${league}&range=${range}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Failed to load analytics");
      return res.json();
    },
    refetchInterval: 60_000,
    enabled: isAdmin,
  });

  if (!isAdmin) {
    return null;
  }

  const winColor = !data ? "text-foreground"
    : data.winRate >= 55 ? "text-green-400"
    : data.winRate >= 50 ? "text-yellow-400"
    : "text-red-400";

  const roiColor = !data ? "text-foreground"
    : data.roi >= 0 ? "text-green-400" : "text-red-400";

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground" data-testid="text-analytics-title">Analytics</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Model performance across all tracked plays</p>
        </div>
        <a href="/admin" className="text-xs text-muted-foreground hover:text-foreground transition-colors">← Admin</a>
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="flex rounded-lg border border-border overflow-hidden">
          {(["NBA", "MLB", "NCAAB"] as League[]).map((l) => (
            <button
              key={l}
              data-testid={`button-league-${l.toLowerCase()}`}
              onClick={() => setLeague(l)}
              className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                league === l
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {LEAGUE_LABELS[l]}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg border border-border overflow-hidden">
          {(["7d", "30d", "all"] as Range[]).map((r) => (
            <button
              key={r}
              data-testid={`button-range-${r}`}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                range === r
                  ? "bg-secondary text-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 animate-pulse h-20" />
          ))}
        </div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label="Win Rate"
              value={data.totalSettled > 0 ? `${data.winRate}%` : "—"}
              sub={data.totalSettled > 0 ? `${data.totalHits}W / ${data.totalSettled - data.totalHits}L` : "No settled plays"}
              color={winColor}
            />
            <StatCard
              label="Settled Plays"
              value={String(data.totalSettled)}
              sub={data.pending > 0 ? `${data.pending} pending` : "All settled"}
            />
            <StatCard
              label="ROI (@ -110)"
              value={data.totalSettled > 0 ? `${data.roi > 0 ? "+" : ""}${data.roi}%` : "—"}
              color={roiColor}
            />
            <StatCard
              label="Direction Split"
              value={data.totalSettled > 0 ? `${data.overWinRate}% / ${data.underWinRate}%` : "—"}
              sub="OVER win% / UNDER win%"
            />
          </div>

          {league === "NBA" && <ConfidenceBuckets />}

          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
              <Target className="w-4 h-4 text-muted-foreground" />
              Recent {league} Plays
            </h2>

            {data.recentPlays.length === 0 ? (
              <div className="rounded-xl border border-border bg-card px-5 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No {league} plays found{range !== "all" ? ` in the last ${RANGE_LABELS[range].toLowerCase()}` : ""}.
                </p>
                <p className="text-xs text-muted-foreground mt-1 opacity-60">
                  Plays are recorded when signals are generated and tracked.
                </p>
              </div>
            ) : (
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground">Player</th>
                      <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">Market</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Dir</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Line</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground hidden sm:table-cell">Prob</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground hidden sm:table-cell">Date</th>
                      <th className="px-3 py-2 text-center font-medium text-muted-foreground">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentPlays.map((play, i) => (
                      <tr
                        key={play.id}
                        data-testid={`row-play-${i}`}
                        className={`border-b border-border/50 ${i % 2 === 0 ? "" : "bg-muted/10"}`}
                      >
                        <td className="px-3 py-2">
                          <div className="font-medium text-foreground">{play.playerName}</div>
                          {play.team && <div className="text-muted-foreground opacity-70">{play.team}</div>}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground hidden sm:table-cell capitalize">
                          {play.market.replace(/_/g, " ")}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {directionIcon(play.direction)}
                          <span className="uppercase text-[10px] font-semibold">{play.direction}</span>
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-foreground">{play.line}</td>
                        <td className="px-3 py-2 text-center text-muted-foreground hidden sm:table-cell">
                          {Math.round(Number(play.prob))}%
                        </td>
                        <td className="px-3 py-2 text-center text-muted-foreground hidden sm:table-cell">{play.gameDate}</td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            {resultBadge(play.result)}
                            {play.result && play.finalStat != null && (
                              <span className="text-[9px] text-muted-foreground font-mono">{play.finalStat}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <ModelPerformanceSection />
    </div>
  );
}
