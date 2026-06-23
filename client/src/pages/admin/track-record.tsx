import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { getAuthToken } from "@/lib/queryClient";
import {
  Loader2,
  AlertCircle,
  BarChart3,
  Download,
  ShieldCheck,
  FlaskConical,
} from "lucide-react";

// ── Contract (mirrors GET /api/admin/track-record) ──────────────────────────
interface RoiMetrics {
  totalBets: number;
  totalProfit: number;
  totalStake: number;
  roi: number;
  hitRate: number;
  hits: number;
  misses: number;
  pushes: number;
  pending: number;
}
interface SegmentedRoi {
  segment: string;
  metrics: RoiMetrics;
}
interface MarketBreakdownRow {
  market: string;
  excludedFromPrimary: boolean;
  metrics: RoiMetrics;
}
interface ShadowSummary {
  liveFloor: number;
  shadowFloor: number;
  scope: string;
  totals: {
    shadowQualified: number;
    shadowRejected: number;
    pending: number;
    cashed: number;
    missed: number;
    push: number;
    expired: number;
    settled: number;
  };
  hitRate: number | null;
  roiUnits: number | null;
  roiPerPick: number | null;
  sampleSize: number;
  sampleSizeWarning: string | null;
}
interface TrackRecordPayload {
  filters: { sport: string; market: string; tier: string; range: string };
  engineVersion: string;
  generatedAt: string;
  historical: {
    surfaced: number;
    settled: number;
    pending: number;
    global: RoiMetrics;
    primary: RoiMetrics;
    excludedFromPrimary: string[];
    bySport: SegmentedRoi[];
    byMarket: SegmentedRoi[];
    byMarketBreakdown: MarketBreakdownRow[];
    byTier: SegmentedRoi[];
    byEngineVersion: SegmentedRoi[];
    byProbBucket: SegmentedRoi[];
    bySignalScore: SegmentedRoi[];
    byDirection: SegmentedRoi[];
    byTiming: SegmentedRoi[];
  };
  shadow: ShadowSummary;
}

const SPORT_OPTIONS = [
  { value: "all", label: "All Sports" },
  { value: "nba", label: "NBA" },
  { value: "mlb", label: "MLB" },
  { value: "ncaab", label: "NCAAB" },
];
const RANGE_OPTIONS = [
  { value: "1d", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];
const TIER_OPTIONS = [
  { value: "all", label: "All Tiers" },
  { value: "watch", label: "Watch" },
  { value: "lean", label: "Lean" },
  { value: "strong", label: "Strong" },
  { value: "elite", label: "Elite" },
  { value: "untiered", label: "Untiered" },
];

function pct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}
function units(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}u`;
}

function ToggleGroup({
  options,
  value,
  onChange,
  testId,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
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

function KpiCard({
  label,
  value,
  sub,
  color,
  testId,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  testId?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-3" data-testid={testId}>
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${color ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function SegmentTable({
  title,
  rows,
  flagExcluded,
}: {
  title: string;
  rows: { key: string; metrics: RoiMetrics; excluded?: boolean }[];
  flagExcluded?: boolean;
}) {
  const slug = title.toLowerCase().replace(/\s+/g, "-");
  return (
    <div>
      <div className="text-sm font-medium mb-2">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No plays in range.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid={`table-${slug}`}>
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-1 pr-3">Segment</th>
                <th className="py-1 pr-3">Settled</th>
                <th className="py-1 pr-3">W-L-P</th>
                <th className="py-1 pr-3">Win %</th>
                <th className="py-1 pr-3">ROI</th>
                <th className="py-1 pr-3">Profit</th>
                <th className="py-1 pr-3">Pending</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/50" data-testid={`row-${slug}-${r.key}`}>
                  <td className="py-1 pr-3 font-mono">
                    {r.key}
                    {flagExcluded && r.excluded && (
                      <span className="ml-1 text-[10px] text-amber-500" title="Excluded from Core Engine ROI">
                        (excl)
                      </span>
                    )}
                  </td>
                  <td className="py-1 pr-3">{r.metrics.totalBets}</td>
                  <td className="py-1 pr-3">
                    {r.metrics.hits}-{r.metrics.misses}-{r.metrics.pushes}
                  </td>
                  <td className="py-1 pr-3">{pct(r.metrics.hitRate)}</td>
                  <td
                    className={`py-1 pr-3 ${r.metrics.roi > 0 ? "text-emerald-500" : r.metrics.roi < 0 ? "text-red-500" : ""}`}
                  >
                    {pct(r.metrics.roi)}
                  </td>
                  <td className="py-1 pr-3">{units(r.metrics.totalProfit)}</td>
                  <td className="py-1 pr-3">{r.metrics.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function TrackRecordPage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [sport, setSport] = useState("all");
  const [range, setRange] = useState("all");
  const [tier, setTier] = useState("all");
  const [market, setMarket] = useState("all");
  const [downloading, setDownloading] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && (!user || !user.isAdmin)) {
      navigate("/");
    }
  }, [authLoading, user, navigate]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<TrackRecordPayload>({
    queryKey: ["/api/admin/track-record", sport, market, tier, range],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (sport !== "all") params.set("sport", sport);
      if (market !== "all") params.set("market", market);
      if (tier !== "all") params.set("tier", tier);
      if (range !== "all") params.set("range", range);
      const token = getAuthToken();
      const res = await fetch(`/api/admin/track-record?${params.toString()}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Failed to load track record (${res.status})`);
      return res.json();
    },
    enabled: !!user?.isAdmin,
    refetchInterval: 60_000,
  });

  async function downloadCsv(kind: "historical" | "shadow") {
    setDownloading(kind);
    try {
      const params = new URLSearchParams();
      if (sport !== "all") params.set("sport", sport);
      if (market !== "all") params.set("market", market);
      if (tier !== "all") params.set("tier", tier);
      if (range !== "all") params.set("range", range);
      const token = getAuthToken();
      const res = await fetch(`/api/admin/track-record/export/${kind}.csv?${params.toString()}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `livelocks-${kind}-track-record-${range}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({
        title: "Export failed",
        description: e?.message ?? "Could not generate CSV.",
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  }

  if (authLoading || (!user && !authLoading)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen text-muted-foreground gap-2">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading Track Record…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Card>
          <CardContent className="p-6 flex items-center gap-3 text-destructive">
            <AlertCircle className="h-5 w-5" /> Failed to load track record.
          </CardContent>
        </Card>
      </div>
    );
  }

  const h = data.historical;
  const sh = data.shadow;
  const marketOptions = [
    { value: "all", label: "All Markets" },
    ...h.byMarketBreakdown.map((m) => ({ value: m.market, label: m.market })),
  ];

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <BarChart3 className="h-6 w-6" /> Buyer Track Record
          </h1>
          <div className="text-xs text-muted-foreground mt-1">
            Engine {data.engineVersion} · Generated {new Date(data.generatedAt).toLocaleString()}
            {isFetching && (
              <span className="ml-2 inline-flex items-center">
                <Loader2 className="h-3 w-3 animate-spin" />
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="text-xs px-3 py-1 rounded border border-border hover:bg-accent"
          data-testid="button-refresh"
        >
          Refresh
        </button>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup options={SPORT_OPTIONS} value={sport} onChange={setSport} testId="filter-sport" />
        <ToggleGroup options={RANGE_OPTIONS} value={range} onChange={setRange} testId="filter-range" />
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="text-xs px-2 py-1.5 rounded-md border border-border bg-card"
          data-testid="filter-tier"
        >
          {TIER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={market}
          onChange={(e) => setMarket(e.target.value)}
          className="text-xs px-2 py-1.5 rounded-md border border-border bg-card"
          data-testid="filter-market"
        >
          {marketOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* ── Historical Engine Record ─────────────────────────────────────── */}
      <Card data-testid="card-historical" className="border-emerald-500/30">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-500" /> Historical Engine Record
          </CardTitle>
          <div className="text-xs text-muted-foreground">
            Durable source of truth — every surfaced play written to <code>persisted_plays</code>, graded, and
            used for ROI. Profit/loss uses real odds where present, otherwise a -110 assumption.
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Surfaced" value={h.surfaced} testId="kpi-surfaced" />
            <KpiCard label="Settled" value={h.settled} testId="kpi-settled" />
            <KpiCard label="Pending" value={h.pending} testId="kpi-pending" />
            <KpiCard
              label="Win Rate"
              value={pct(h.global.hitRate)}
              sub={`${h.global.hits}W-${h.global.misses}L-${h.global.pushes}P`}
              color="text-emerald-500"
              testId="kpi-winrate"
            />
            <KpiCard
              label="ROI (all markets)"
              value={pct(h.global.roi)}
              sub={units(h.global.totalProfit)}
              color={h.global.roi >= 0 ? "text-emerald-500" : "text-red-500"}
              testId="kpi-roi"
            />
            <KpiCard
              label="Core Engine ROI"
              value={pct(h.primary.roi)}
              sub={`excl ${h.excludedFromPrimary.join(", ") || "none"}`}
              color={h.primary.roi >= 0 ? "text-emerald-500" : "text-red-500"}
              testId="kpi-primary-roi"
            />
          </div>

          <div className="grid md:grid-cols-2 gap-5">
            <SegmentTable
              title="By Sport"
              rows={h.bySport.map((s) => ({ key: s.segment, metrics: s.metrics }))}
            />
            <SegmentTable
              title="By Signal Tier"
              rows={h.byTier.map((s) => ({ key: s.segment, metrics: s.metrics }))}
            />
            <SegmentTable
              title="By Market"
              flagExcluded
              rows={h.byMarketBreakdown.map((s) => ({
                key: s.market,
                metrics: s.metrics,
                excluded: s.excludedFromPrimary,
              }))}
            />
            <SegmentTable
              title="By Engine Version"
              rows={h.byEngineVersion.map((s) => ({ key: s.segment, metrics: s.metrics }))}
            />
            <SegmentTable
              title="By Probability Bucket"
              rows={h.byProbBucket.map((s) => ({ key: s.segment, metrics: s.metrics }))}
            />
            <SegmentTable
              title="By Signal Score"
              rows={h.bySignalScore.map((s) => ({ key: s.segment, metrics: s.metrics }))}
            />
          </div>

          <button
            onClick={() => downloadCsv("historical")}
            disabled={downloading === "historical"}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-60"
            data-testid="button-export-historical"
          >
            {downloading === "historical" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            Export Historical Engine Record (CSV)
          </button>
        </CardContent>
      </Card>

      {/* ── Shadow / Experimental Record ─────────────────────────────────── */}
      <Card data-testid="card-shadow" className="border-amber-500/40 border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-amber-500" /> Shadow / Experimental Record
          </CardTitle>
          <div className="text-xs text-amber-500/90 bg-amber-500/10 rounded px-2 py-1 mt-1">
            Not a surfaced product record. MLB batter-over only, session-scoped (in-memory), excluded from the
            official W/L record and ROI. ROI is a directional -110 proxy (cashed +0.909u / missed -1u / push 0).
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Shadow Qualified" value={sh.totals.shadowQualified} />
            <KpiCard label="Settled" value={sh.totals.settled} sub={`${sh.totals.cashed}-${sh.totals.missed}`} />
            <KpiCard label="Pending" value={sh.totals.pending} />
            <KpiCard label="Hit Rate" value={pct(sh.hitRate != null ? sh.hitRate * 100 : null)} />
            <KpiCard label="ROI (units)" value={units(sh.roiUnits)} />
            <KpiCard
              label="ROI / pick"
              value={sh.roiPerPick != null ? `${(sh.roiPerPick).toFixed(3)}u` : "—"}
              sub={`floor ${sh.shadowFloor} vs live ${sh.liveFloor}`}
            />
          </div>
          {sh.sampleSizeWarning && (
            <div className="text-xs text-amber-500 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {sh.sampleSizeWarning}
            </div>
          )}
          <button
            onClick={() => downloadCsv("shadow")}
            disabled={downloading === "shadow"}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 disabled:opacity-60"
            data-testid="button-export-shadow"
          >
            {downloading === "shadow" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            Export Shadow / Experimental Record (CSV)
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
