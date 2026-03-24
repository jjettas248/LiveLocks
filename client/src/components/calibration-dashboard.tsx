import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { ChevronUp, ChevronDown, Target } from "lucide-react";

interface PersistedPlay {
  id: string;
  gameDate: string;
  playerName: string;
  sport: string;
  market: string;
  direction: string;
  line: string;
  finalStat: string | null;
  result: string | null;
  prob: string;
  edgeGap: string | null;
}

interface BucketStat {
  label: string;
  total: number;
  wins: number;
  pushes: number;
  winRate: number;
  pushRate: number;
}

interface CalibrationData {
  plays: PersistedPlay[];
  summary: {
    totalPlays: number;
    winRate: number;
    pushRate: number;
    avgEdge: number;
    avgProbability: number;
  };
  edgeBuckets: BucketStat[];
  probBuckets: BucketStat[];
}

const MARKET_LABELS: Record<string, string> = {
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

const PROB_BUCKET_MIDPOINTS: Record<string, number> = {
  "50–60": 55,
  "60–70": 65,
  "70–80": 75,
  "80–100": 90,
};

type SortKey = "gameDate" | "playerName" | "sport" | "market" | "direction" | "line" | "finalStat" | "result" | "edgeGap" | "prob";

function ResultBadge({ result }: { result: string | null }) {
  if (result === "hit") {
    return (
      <span
        data-testid="badge-result-win"
        className="text-xs font-bold px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 border border-green-500/30"
      >
        WIN
      </span>
    );
  }
  if (result === "miss") {
    return (
      <span
        data-testid="badge-result-loss"
        className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30"
      >
        LOSS
      </span>
    );
  }
  if (result === "push") {
    return (
      <span
        data-testid="badge-result-push"
        className="text-xs font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border"
      >
        PUSH
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

function BucketCard({ bucket }: { bucket: BucketStat }) {
  const hasData = bucket.total >= 5;
  return (
    <div
      data-testid={`bucket-card-${bucket.label.replace(/[^a-z0-9]/gi, "")}`}
      className={`rounded-xl border p-4 flex flex-col gap-1 ${
        !hasData
          ? "border-border bg-muted/30"
          : bucket.winRate >= 60
          ? "border-green-500/40 bg-green-500/5"
          : bucket.winRate >= 50
          ? "border-yellow-500/40 bg-yellow-500/5"
          : "border-red-500/40 bg-red-500/5"
      }`}
    >
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {bucket.label}
      </div>
      <div
        className={`text-3xl font-bold ${
          !hasData
            ? "text-muted-foreground"
            : bucket.winRate >= 60
            ? "text-green-400"
            : bucket.winRate >= 50
            ? "text-yellow-400"
            : "text-red-400"
        }`}
      >
        {hasData ? `${bucket.winRate}%` : "—"}
      </div>
      <div className="text-xs text-muted-foreground">
        {hasData ? `${bucket.wins}/${bucket.total - bucket.pushes} wins` : `${bucket.total} plays (need 5+)`}
      </div>
      {hasData && bucket.pushes > 0 && (
        <div className="text-xs text-muted-foreground/70">{bucket.pushes} push{bucket.pushes !== 1 ? "es" : ""}</div>
      )}
    </div>
  );
}

export function CalibrationDashboard() {
  const [sport, setSport] = useState("");
  const [market, setMarket] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("gameDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const queryParams = new URLSearchParams();
  if (sport) queryParams.set("sport", sport);
  if (market) queryParams.set("market", market);
  if (startDate) queryParams.set("startDate", startDate);
  if (endDate) queryParams.set("endDate", endDate);

  const { data, isLoading } = useQuery<CalibrationData>({
    queryKey: ["/api/persisted-plays/calibration", sport, market, startDate, endDate],
    queryFn: async () => {
      const res = await fetch(`/api/persisted-plays/calibration?${queryParams.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load calibration data");
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
  });

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const sortedPlays = [...(data?.plays ?? [])].sort((a, b) => {
    const raw = (play: PersistedPlay): string | number | null => {
      const v = play[sortKey as keyof PersistedPlay];
      if (sortKey === "line" || sortKey === "finalStat" || sortKey === "edgeGap" || sortKey === "prob") {
        return v != null ? Number(v) : null;
      }
      return v != null ? String(v) : null;
    };
    const av = raw(a);
    const bv = raw(b);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  const calibrationCurveData = (data?.probBuckets ?? [])
    .filter(b => b.total >= 3)
    .map(b => ({
      name: b.label,
      midpoint: PROB_BUCKET_MIDPOINTS[b.label] ?? 0,
      actualWinRate: b.winRate,
      idealWinRate: PROB_BUCKET_MIDPOINTS[b.label] ?? 0,
    }))
    .sort((a, b) => a.midpoint - b.midpoint);

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return null;
    return sortDir === "asc"
      ? <ChevronUp className="w-3 h-3 inline ml-0.5" />
      : <ChevronDown className="w-3 h-3 inline ml-0.5" />;
  }

  const thClass = "text-left px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer hover:text-foreground select-none";

  return (
    <div className="space-y-6" data-testid="calibration-dashboard">
      <div className="flex items-center gap-2">
        <Target className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-bold text-foreground" data-testid="calibration-title">
          Calibration Dashboard
        </h2>
        <span className="text-xs text-muted-foreground ml-1">Analytics-only · does not affect model</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end bg-card border border-border rounded-xl p-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">Sport</label>
          <select
            data-testid="select-calibration-sport"
            value={sport}
            onChange={e => setSport(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="">All Sports</option>
            <option value="nba">NBA</option>
            <option value="ncaab">NCAAB</option>
            <option value="mlb">MLB</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">Market</label>
          <select
            data-testid="select-calibration-market"
            value={market}
            onChange={e => setMarket(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          >
            <option value="">All Markets</option>
            {Object.entries(MARKET_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">Start Date</label>
          <input
            data-testid="input-calibration-start-date"
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">End Date</label>
          <input
            data-testid="input-calibration-end-date"
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-lg bg-background border border-border text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
        </div>
        {(sport || market || startDate || endDate) && (
          <button
            data-testid="button-calibration-clear-filters"
            onClick={() => { setSport(""); setMarket(""); setStartDate(""); setEndDate(""); }}
            className="text-xs px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Summary Panel */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {[0,1,2,3,4].map(i => (
            <div key={i} className="h-24 rounded-xl bg-muted/30 animate-pulse border border-border" />
          ))}
        </div>
      ) : data?.summary ? (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4" data-testid="calibration-summary">
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total Plays</div>
            <div className="text-2xl font-bold text-foreground mt-1" data-testid="text-total-plays">{data.summary.totalPlays}</div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Win Rate</div>
            <div className={`text-2xl font-bold mt-1 ${data.summary.winRate >= 60 ? "text-green-400" : data.summary.winRate >= 50 ? "text-yellow-400" : "text-red-400"}`} data-testid="text-win-rate">
              {data.summary.winRate}%
            </div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Push Rate</div>
            <div className="text-2xl font-bold text-muted-foreground mt-1" data-testid="text-push-rate">{data.summary.pushRate}%</div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Avg Edge</div>
            <div className="text-2xl font-bold text-primary mt-1" data-testid="text-avg-edge">+{data.summary.avgEdge}pp</div>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Avg Probability</div>
            <div className="text-2xl font-bold text-foreground mt-1" data-testid="text-avg-probability">{data.summary.avgProbability}%</div>
          </div>
        </div>
      ) : null}

      {/* Edge Bucket Breakdown */}
      {data && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Edge Buckets</h3>
          <div className="grid grid-cols-3 gap-4" data-testid="edge-buckets">
            {data.edgeBuckets.map(bucket => (
              <BucketCard key={bucket.label} bucket={bucket} />
            ))}
          </div>
        </div>
      )}

      {/* Probability Bucket Breakdown */}
      {data && (
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Probability Buckets</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="prob-buckets">
            {data.probBuckets.map(bucket => (
              <BucketCard key={bucket.label} bucket={bucket} />
            ))}
          </div>
        </div>
      )}

      {/* Calibration Curve Chart */}
      {data && calibrationCurveData.length >= 2 && (
        <div className="bg-card border border-border rounded-xl p-4" data-testid="calibration-chart">
          <h3 className="text-sm font-semibold text-foreground mb-1">Calibration Curve</h3>
          <p className="text-xs text-muted-foreground mb-4">
            Predicted probability (X) vs actual win rate (Y). Diagonal = ideal calibration.
          </p>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={calibrationCurveData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="midpoint"
                type="number"
                domain={[50, 100]}
                tickFormatter={v => `${v}%`}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={v => `${v}%`}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              />
              <Tooltip
                formatter={(value: number | string, name: string) => [`${value}%`, name === "actualWinRate" ? "Actual Win Rate" : "Ideal"]}
                labelFormatter={(v) => `Prob bucket ~${v}%`}
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: "12px" }}
              />
              <Legend
                formatter={(value) => value === "actualWinRate" ? "Actual Win Rate" : "Ideal (Diagonal)"}
                wrapperStyle={{ fontSize: "12px" }}
              />
              <Line
                type="monotone"
                dataKey="idealWinRate"
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="6 3"
                dot={false}
                name="idealWinRate"
              />
              <Line
                type="monotone"
                dataKey="actualWinRate"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={{ r: 4, fill: "hsl(var(--primary))" }}
                name="actualWinRate"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Plays Table */}
      {data && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              Graded Plays
            </h3>
            <span className="text-xs text-muted-foreground">{sortedPlays.length} plays</span>
          </div>
          {sortedPlays.length === 0 ? (
            <div
              className="text-center py-12 text-muted-foreground text-sm border border-border rounded-xl"
              data-testid="calibration-no-plays"
            >
              No graded plays found for the selected filters.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border" data-testid="calibration-table">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className={thClass} onClick={() => handleSort("gameDate")}>
                      Date <SortIcon col="gameDate" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("playerName")}>
                      Player <SortIcon col="playerName" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("sport")}>
                      Sport <SortIcon col="sport" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("market")}>
                      Market <SortIcon col="market" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("direction")}>
                      Dir <SortIcon col="direction" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("line")}>
                      Line <SortIcon col="line" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("finalStat")}>
                      Actual <SortIcon col="finalStat" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("result")}>
                      Result <SortIcon col="result" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("edgeGap")}>
                      Edge % <SortIcon col="edgeGap" />
                    </th>
                    <th className={thClass} onClick={() => handleSort("prob")}>
                      Prob % <SortIcon col="prob" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPlays.map((play, idx) => {
                    const edge = play.edgeGap != null ? Number(play.edgeGap) : null;
                    const prob = Number(play.prob);
                    return (
                      <tr
                        key={play.id}
                        data-testid={`calibration-row-${play.id}`}
                        className={`border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors ${
                          play.result === "hit"
                            ? "bg-green-500/5"
                            : play.result === "miss"
                            ? "bg-red-500/5"
                            : ""
                        }`}
                      >
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap" data-testid={`text-date-${play.id}`}>{play.gameDate}</td>
                        <td className="px-3 py-2 text-foreground font-medium whitespace-nowrap" data-testid={`text-player-${play.id}`}>{play.playerName}</td>
                        <td className="px-3 py-2 text-muted-foreground uppercase" data-testid={`text-sport-${play.id}`}>{play.sport}</td>
                        <td className="px-3 py-2 text-muted-foreground" data-testid={`text-market-${play.id}`}>{MARKET_LABELS[play.market] ?? play.market}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`font-semibold ${play.direction === "over" ? "text-green-400" : "text-red-400"}`}
                            data-testid={`text-direction-${play.id}`}
                          >
                            {play.direction === "over" ? "O" : "U"}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-foreground" data-testid={`text-line-${play.id}`}>{Number(play.line).toFixed(1)}</td>
                        <td className="px-3 py-2 text-muted-foreground" data-testid={`text-actual-${play.id}`}>
                          {play.finalStat != null ? Number(play.finalStat).toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2" data-testid={`text-result-${play.id}`}>
                          <ResultBadge result={play.result} />
                        </td>
                        <td
                          className="px-3 py-2"
                          data-testid={`text-edge-${play.id}`}
                          style={{ color: edge != null && edge >= 10 ? "#f59e0b" : edge != null && edge >= 5 ? "#a1a1aa" : "#52525b" }}
                        >
                          {edge != null ? `+${edge.toFixed(1)}pp` : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground" data-testid={`text-prob-${play.id}`}>
                          {prob.toFixed(0)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
