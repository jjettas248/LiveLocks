import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { TrendingUp, CheckCircle, XCircle, Minus, Target, ArrowUp, ArrowDown, BarChart3, Filter, Calendar, Activity } from "lucide-react";

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

const RANGE_OPTIONS: { value: RangeFilter; label: string }[] = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "all", label: "All" },
];

function KpiCard({ label, value, sub, icon: Icon, color = "text-foreground" }: {
  label: string; value: string; sub?: string; icon?: any; color?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid={`kpi-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
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

export default function PerformancePage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const [sport, setSport] = useState<SportFilter>("all");
  const [direction, setDirection] = useState<DirFilter>("all");
  const [range, setRange] = useState<RangeFilter>("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const { data, isLoading, error } = useQuery<PerformanceResponse>({
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

  if (authLoading) return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading...</div>;
  if (!user) { navigate("/auth"); return null; }

  const summary = data?.summary;
  const buckets = data?.buckets ?? [];
  const allPlays = data?.plays ?? [];
  const pagedPlays = allPlays.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(allPlays.length / PAGE_SIZE);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="page-title">
              <BarChart3 className="w-6 h-6 text-primary" />
              Model Performance
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Deterministic grading from persisted plays — single source of truth
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ToggleGroup options={SPORT_OPTIONS} value={sport} onChange={(v: SportFilter) => { setSport(v); setPage(0); }} testId="filter-sport" />
            <ToggleGroup options={RANGE_OPTIONS} value={range} onChange={(v: RangeFilter) => { setRange(v); setPage(0); }} testId="filter-range" />
            <ToggleGroup options={DIR_OPTIONS} value={direction} onChange={(v: DirFilter) => { setDirection(v); setPage(0); }} testId="filter-direction" />
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-destructive text-sm" data-testid="error-message">
            Failed to load performance data. Please try again.
          </div>
        )}

        {!isLoading && summary && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6" data-testid="kpi-row">
              <KpiCard
                label="Total Plays"
                value={summary.total.toLocaleString()}
                icon={Activity}
                sub={`${summary.hits + summary.misses} decided`}
              />
              <KpiCard
                label="Win Rate"
                value={`${summary.winRate}%`}
                icon={Target}
                color={summary.winRate >= 55 ? "text-emerald-500" : summary.winRate >= 50 ? "text-yellow-500" : "text-red-500"}
                sub={`${summary.hits}W - ${summary.misses}L`}
              />
              <KpiCard
                label="Hits / Misses"
                value={`${summary.hits} / ${summary.misses}`}
                icon={CheckCircle}
                sub={summary.pushes > 0 ? `${summary.pushes} pushes` : undefined}
              />
              <KpiCard
                label="Avg Edge"
                value={`${summary.avgEdge > 0 ? "+" : ""}${summary.avgEdge}%`}
                icon={TrendingUp}
                color={summary.avgEdge > 0 ? "text-emerald-500" : "text-red-500"}
              />
              <KpiCard
                label="Avg Probability"
                value={`${summary.avgProb}%`}
                icon={BarChart3}
              />
            </div>

            <div className="mb-6">
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2" data-testid="bucket-title">
                <Filter className="w-4 h-4" />
                Probability Buckets
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="bucket-grid">
                {buckets.map((b) => (
                  <div key={b.label} className="rounded-xl border border-border bg-card p-4" data-testid={`bucket-${b.label}`}>
                    <p className="text-sm font-medium text-muted-foreground mb-1">{b.label}</p>
                    <p className={`text-2xl font-bold ${
                      b.winRate >= 65 ? "text-emerald-500" : b.winRate >= 55 ? "text-yellow-500" : b.winRate > 0 ? "text-orange-500" : "text-muted-foreground"
                    }`}>
                      {b.winRate}%
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{b.hits}/{b.total} plays hit</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold flex items-center gap-2" data-testid="table-title">
                  <Calendar className="w-4 h-4" />
                  Play History
                  <span className="text-sm font-normal text-muted-foreground">({allPlays.length} plays)</span>
                </h2>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2" data-testid="pagination">
                    <button
                      onClick={() => setPage(Math.max(0, page - 1))}
                      disabled={page === 0}
                      className="px-2 py-1 text-xs border border-border rounded disabled:opacity-30"
                      data-testid="btn-prev-page"
                    >
                      Prev
                    </button>
                    <span className="text-xs text-muted-foreground">{page + 1} / {totalPages}</span>
                    <button
                      onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                      disabled={page >= totalPages - 1}
                      className="px-2 py-1 text-xs border border-border rounded disabled:opacity-30"
                      data-testid="btn-next-page"
                    >
                      Next
                    </button>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm" data-testid="play-table">
                  <thead>
                    <tr className="bg-muted/50 text-left text-xs text-muted-foreground">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Player</th>
                      <th className="px-3 py-2">Sport</th>
                      <th className="px-3 py-2">Market</th>
                      <th className="px-3 py-2 text-center">Dir</th>
                      <th className="px-3 py-2 text-right">Line</th>
                      <th className="px-3 py-2 text-right">Prob</th>
                      <th className="px-3 py-2 text-right">Edge</th>
                      <th className="px-3 py-2 text-right">Final</th>
                      <th className="px-3 py-2 text-center">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedPlays.length === 0 && (
                      <tr>
                        <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                          No settled plays found for the selected filters.
                        </td>
                      </tr>
                    )}
                    {pagedPlays.map((p, i) => (
                      <tr
                        key={p.id}
                        className={`border-t border-border/50 ${i % 2 === 0 ? "bg-card" : "bg-card/50"} hover:bg-muted/30 transition-colors`}
                        data-testid={`play-row-${p.id}`}
                      >
                        <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                          {p.settledAt ? new Date(p.settledAt).toLocaleDateString() : new Date(p.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">
                          {p.player}
                          {p.team && <span className="text-xs text-muted-foreground ml-1">({p.team})</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                            p.sport === "nba" ? "bg-orange-500/20 text-orange-400" :
                            p.sport === "mlb" ? "bg-blue-500/20 text-blue-400" :
                            "bg-purple-500/20 text-purple-400"
                          }`}>
                            {p.sport?.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs">{formatMarket(p.stat)}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`text-xs font-bold ${p.direction === "O" ? "text-emerald-400" : "text-red-400"}`}>
                            {p.direction === "O" ? <ArrowUp className="w-3.5 h-3.5 inline" /> : <ArrowDown className="w-3.5 h-3.5 inline" />}
                            {p.direction}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{p.line}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{p.probability.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right font-mono text-xs">
                          <span className={p.edge > 0 ? "text-emerald-400" : "text-muted-foreground"}>
                            {p.edge > 0 ? "+" : ""}{p.edge.toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{p.finalStat ?? "—"}</td>
                        <td className="px-3 py-2 text-center">
                          {p.result === "HIT" && (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-400" data-testid={`result-hit-${p.id}`}>
                              <CheckCircle className="w-3.5 h-3.5" /> HIT
                            </span>
                          )}
                          {p.result === "MISS" && (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-red-400" data-testid={`result-miss-${p.id}`}>
                              <XCircle className="w-3.5 h-3.5" /> MISS
                            </span>
                          )}
                          {p.result === "PUSH" && (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-gray-400" data-testid={`result-push-${p.id}`}>
                              <Minus className="w-3.5 h-3.5" /> PUSH
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="flex justify-center mt-3" data-testid="pagination-bottom">
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => (
                      <button
                        key={i}
                        onClick={() => setPage(i)}
                        className={`w-8 h-8 text-xs rounded ${page === i ? "bg-primary text-primary-foreground" : "bg-card border border-border hover:bg-muted"}`}
                        data-testid={`page-btn-${i}`}
                      >
                        {i + 1}
                      </button>
                    ))}
                    {totalPages > 10 && <span className="text-xs text-muted-foreground px-1">...</span>}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatMarket(market: string): string {
  const map: Record<string, string> = {
    points: "Points",
    rebounds: "Rebounds",
    assists: "Assists",
    threes: "3PT Made",
    steals: "Steals",
    blocks: "Blocks",
    pts_rebs_asts: "PRA",
    pts_rebs: "Pts+Reb",
    pts_asts: "Pts+Ast",
    rebs_asts: "Reb+Ast",
    hits: "Hits",
    total_bases: "Total Bases",
    home_runs: "Home Runs",
    pitcher_strikeouts: "Strikeouts",
    rbi: "RBI",
    runs: "Runs",
    stolen_bases: "Stolen Bases",
    hrr: "H+R+RBI",
  };
  return map[market] ?? market.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
