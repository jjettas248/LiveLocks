import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { getAuthToken } from "@/lib/queryClient";
import { TrendingUp, CheckCircle, Clock, Target, ArrowUp, ArrowDown, BarChart3 } from "lucide-react";

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

export default function AnalyticsPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const [league, setLeague] = useState<League>("NBA");
  const [range, setRange] = useState<Range>("all");

  if (!authLoading && (!user || !user.isAdmin)) {
    navigate("/dashboard");
    return null;
  }

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
  });

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
    </div>
  );
}
