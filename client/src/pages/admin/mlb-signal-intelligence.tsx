import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Activity, AlertCircle, BarChart3, Target, Zap, Bell, Layers } from "lucide-react";
import { PregameRadarCalibrationCard } from "@/components/admin/PregameRadarCalibrationCard";
import { HrMissDiagnosticsCard } from "@/components/admin/HrMissDiagnosticsCard";

interface RoiBucket {
  cashed: number;
  missed: number;
  settled: number;
  hitRate: number | null;
  roiUnits: number | null;
  roiPerPick: number | null;
  sampleSizeWarning: string | null;
}

interface IntelligencePayload {
  runtimeHealth: {
    freshnessMs: number;
    registered: number;
    updated: number;
    deduped: number;
    rejected: number;
    staleExpired: number;
    legacyConsumers: Record<string, number>;
    propagationMsP50: number;
    propagationMsP95: number;
    sampleCount: number;
    bridge: { hrRadarCanonicalReads: number; topPlaysCanonicalReads: number; bridgeMisses: number; routeCanonicalReads: Record<string, number> };
    alerts: { queued: number; sent: number; opened: number; clicked: number; suppressed: number; deduped: number; queueDepth: number };
    lifecycleEventCountsByState: Record<string, number>;
    tierCountsCurrent: Record<string, number>;
    analyticsBufferSize: number;
  };
  lifecycle: {
    totals: Record<string, number>;
    alerts: { queued: number; sent: number; opened: number; clicked: number; openRate: number | null; clickThroughRate: number | null };
    roi: {
      overall: RoiBucket;
      byTier: Record<string, RoiBucket>;
      byLifecycleState: Record<string, RoiBucket>;
      byMarket: Record<string, RoiBucket>;
      bySide: Record<string, RoiBucket>;
    };
    signalAging: { cycles: number; avgSignalScore: number | null; avgProbability: number | null };
    sampleSizeFloor: number;
    windowMs: number;
  };
  hrRadar: {
    totals: { transitionsObserved: number; cashedObserved: number; missedObserved: number };
    stageDistribution: Record<string, number>;
    conversion: { trackToBuild: number | null; buildToReady: number | null; readyToFire: number | null; fireToCashed: number | null };
    averageDurationMs: { track: number | null; build: number | null; ready: number | null; fire: number | null };
    falseFireRate: number | null;
    readyEffectiveness: number | null;
    buildMaturation: number | null;
    sampleSizeWarning: string | null;
    // FIRE-only official record vs shadow/watch (2026-06). Optional so older
    // server payloads still type-check.
    officialFireRecord?: {
      fireCalls: number;
      fireCashed: number;
      fireMissed: number;
      fireHitRate: number | null;
    };
    shadowWatchIntelligence?: {
      readyReached: number;
      watchPromotedToFire: number;
      readyOnly: number;
      watchCashedWithoutFire: number;
      readyOnlyMissed: number;
    };
    // Playability outcome-bucket metrics (2026-07). Optional so older server
    // payloads still type-check.
    playabilityMetrics?: {
      officialRecall: number | null;
      radarCoverageRecall: number | null;
      lateSignalRate: number | null;
      trueUncalledHrRate: number | null;
      playableAttackPrecision: number | null;
      watchlistLeanConversionRate: number | null;
    };
  };
  drivers: {
    observedDrivers: number;
    topDrivers: Array<{ driver: string; appearances: number; cashed: number; missed: number; hitRate: number | null; roiUnits: number | null; sampleSizeWarning: string | null }>;
    bottomDrivers: Array<{ driver: string; appearances: number; cashed: number; missed: number; hitRate: number | null; roiUnits: number | null; sampleSizeWarning: string | null }>;
    topCombos: Array<{ combo: string; appearances: number; cashed: number; missed: number; hitRate: number | null; roiUnits: number | null }>;
  };
  shadow: {
    shadow: { settled: number; cashed: number; missed: number; hitRate: number | null; roiPerPick: number | null; sampleSizeWarning: string | null };
    live: { settled: number; cashed: number; missed: number; hitRate: number | null; roiPerPick: number | null; sampleSizeWarning: string | null };
    delta: { hitRateDelta: number | null; roiPerPickDelta: number | null };
    thresholds: { liveFloor: number; shadowFloor: number };
    byMarket: Record<string, { shadow: { settled: number; cashed: number; hitRate: number | null } }>;
  };
  generatedAt: string;
}

function pct(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
function num(n: number | null | undefined, digits = 2): string {
  if (n == null || isNaN(n)) return "—";
  return n.toFixed(digits);
}
function dur(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function StatCard({ label, value, sub, testId }: { label: string; value: string | number; sub?: string; testId?: string }) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-3" data-testid={testId}>
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function RoiTable({ title, rows }: { title: string; rows: Array<[string, RoiBucket]> }) {
  if (!rows.length) {
    return (
      <div>
        <div className="text-sm font-medium mb-2">{title}</div>
        <div className="text-xs text-muted-foreground">No settled signals in window.</div>
      </div>
    );
  }
  return (
    <div>
      <div className="text-sm font-medium mb-2">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid={`table-roi-${title.toLowerCase().replace(/\s+/g, "-")}`}>
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="py-1 pr-3">Bucket</th>
              <th className="py-1 pr-3">Settled</th>
              <th className="py-1 pr-3">Cashed</th>
              <th className="py-1 pr-3">Missed</th>
              <th className="py-1 pr-3">Hit %</th>
              <th className="py-1 pr-3">ROI (u)</th>
              <th className="py-1 pr-3">ROI/pick</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([key, b]) => (
              <tr key={key} className="border-b border-border/50">
                <td className="py-1 pr-3 font-mono">{key}</td>
                <td className="py-1 pr-3">{b.settled}</td>
                <td className="py-1 pr-3">{b.cashed}</td>
                <td className="py-1 pr-3">{b.missed}</td>
                <td className="py-1 pr-3">{pct(b.hitRate)}</td>
                <td className="py-1 pr-3">{num(b.roiUnits)}</td>
                <td className="py-1 pr-3">{num(b.roiPerPick, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function MlbSignalIntelligencePage() {
  const { user, isLoading: authLoading } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!authLoading && (!user || !user.isAdmin)) {
      navigate("/");
    }
  }, [authLoading, user, navigate]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<IntelligencePayload>({
    queryKey: ["/api/admin/mlb-signal-intelligence"],
    enabled: !!user?.isAdmin,
    refetchInterval: 30_000,
  });

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
        <Loader2 className="h-5 w-5 animate-spin" /> Loading MLB Signal Intelligence…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <Card>
          <CardContent className="p-6 flex items-center gap-3 text-destructive">
            <AlertCircle className="h-5 w-5" /> Failed to load intelligence payload.
          </CardContent>
        </Card>
      </div>
    );
  }

  const rh = data.runtimeHealth;
  const lc = data.lifecycle;
  const hr = data.hrRadar;
  const dr = data.drivers;
  const sh = data.shadow;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <BarChart3 className="h-6 w-6" /> MLB Signal Intelligence
          </h1>
          <div className="text-xs text-muted-foreground mt-1">
            Window: {dur(lc.windowMs)} · Generated {new Date(data.generatedAt).toLocaleTimeString()}
            {isFetching && <span className="ml-2 inline-flex items-center"><Loader2 className="h-3 w-3 animate-spin" /></span>}
          </div>
        </div>
        <button
          onClick={() => refetch()}
          className="text-xs px-3 py-1 rounded border border-border hover:bg-accent"
          data-testid="button-refresh"
        >Refresh</button>
      </header>

      {/* 1. Runtime Health */}
      <Card data-testid="card-runtime-health">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4" /> Runtime Health</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Bus Registered" value={rh.registered} testId="stat-bus-registered" />
          <StatCard label="Updates" value={rh.updated} testId="stat-bus-updated" />
          <StatCard label="Deduped" value={rh.deduped} testId="stat-bus-deduped" />
          <StatCard label="Rejected" value={rh.rejected} testId="stat-bus-rejected" />
          <StatCard label="Stale Expired" value={rh.staleExpired} sub="freshness ceiling reached" />
          <StatCard label="Bridge Reads" value={rh.bridge.hrRadarCanonicalReads + rh.bridge.topPlaysCanonicalReads} sub={`HR ${rh.bridge.hrRadarCanonicalReads} · TP ${rh.bridge.topPlaysCanonicalReads}`} />
          <StatCard label="Legacy Consumers" value={Object.keys(rh.legacyConsumers).length} sub={Object.entries(rh.legacyConsumers).map(([k, v]) => `${k}=${v}`).join(" · ") || "none"} />
          <StatCard label="Analytics Buffer" value={rh.analyticsBufferSize} sub="ring buffer depth" />
          <StatCard label="Bus Propagation P50" value={`${rh.propagationMsP50}ms`} sub={`P95 ${rh.propagationMsP95}ms`} />
          <StatCard label="Tier Distribution" value={Object.entries(rh.tierCountsCurrent).map(([t, n]) => `${t}:${n}`).join(" · ") || "—"} />
          <StatCard label="Lifecycle States" value={Object.entries(rh.lifecycleEventCountsByState).map(([s, n]) => `${s}:${n}`).join(" · ") || "—"} />
          <StatCard label="Alert Queue Depth" value={rh.alerts.queueDepth} sub={`suppressed ${rh.alerts.suppressed} · deduped ${rh.alerts.deduped}`} />
        </CardContent>
      </Card>

      {/* 2. Lifecycle Intelligence */}
      <Card data-testid="card-lifecycle">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Layers className="h-4 w-4" /> Lifecycle Intelligence</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Created" value={lc.totals.signalCreated} />
            <StatCard label="Upgraded" value={lc.totals.signalUpgraded} />
            <StatCard label="Downgraded" value={lc.totals.signalDowngraded} />
            <StatCard label="Cashed" value={lc.totals.signalCashed} />
            <StatCard label="Missed" value={lc.totals.signalMissed} />
            <StatCard label="Expired" value={lc.totals.signalExpired} />
            <StatCard label="Avg Probability" value={lc.signalAging.avgProbability ?? "—"} />
            <StatCard label="Avg Signal Score" value={lc.signalAging.avgSignalScore ?? "—"} />
          </div>
          <RoiTable title="ROI Overall" rows={[["overall", lc.roi.overall]]} />
          <div className="grid md:grid-cols-2 gap-4">
            <RoiTable title="ROI by Tier" rows={Object.entries(lc.roi.byTier)} />
            <RoiTable title="ROI by Lifecycle State" rows={Object.entries(lc.roi.byLifecycleState)} />
            <RoiTable title="ROI by Market" rows={Object.entries(lc.roi.byMarket)} />
            <RoiTable title="ROI by Side" rows={Object.entries(lc.roi.bySide)} />
          </div>
          {lc.roi.overall.sampleSizeWarning && (
            <div className="text-xs text-amber-500 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {lc.roi.overall.sampleSizeWarning}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. HR Radar Intelligence */}
      <Card data-testid="card-hr-radar">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Target className="h-4 w-4" /> HR Radar Intelligence</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Transitions" value={hr.totals.transitionsObserved} />
            <StatCard label="Cashed" value={hr.totals.cashedObserved} />
            <StatCard label="Missed" value={hr.totals.missedObserved} />
            <StatCard label="False Attack" value={pct(hr.falseFireRate)} sub="Attack → MISSED rate" />
            <StatCard label="Watchlist → Lean" value={pct(hr.conversion.trackToBuild)} />
            <StatCard label="Lean → Playable" value={pct(hr.conversion.buildToReady)} />
            <StatCard label="Playable → Attack" value={pct(hr.conversion.readyToFire)} />
            <StatCard label="Attack → Cashed" value={pct(hr.conversion.fireToCashed)} />
            <StatCard label="Avg Watchlist dur" value={dur(hr.averageDurationMs.track)} />
            <StatCard label="Avg Lean dur" value={dur(hr.averageDurationMs.build)} />
            <StatCard label="Avg Playable dur" value={dur(hr.averageDurationMs.ready)} />
            <StatCard label="Avg Attack dur" value={dur(hr.averageDurationMs.fire)} />
          </div>
          <div className="text-xs">
            <span className="text-muted-foreground">Stage distribution: </span>
            {Object.entries(hr.stageDistribution).map(([s, n]) => (
              <Badge key={s} variant="outline" className="mr-1 mb-1" data-testid={`badge-stage-${s}`}>{s}: {n}</Badge>
            ))}
          </div>
          {/* FIRE-only official record vs shadow/watch (2026-06) — this block
              uses the STRICT FIRE-only grading gate (only Attack calls count),
              matching storage.ts's write-side gate. See "Playability coverage"
              below for the wider Playable+Attack=official definition. */}
          {hr.officialFireRecord && (
            <div className="space-y-2" data-testid="block-hr-official-shadow">
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-500">Official record (Attack only)</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="Attack calls" value={hr.officialFireRecord.fireCalls} sub="resolved Attack signals" />
                <StatCard label="Attack cashed" value={hr.officialFireRecord.fireCashed} />
                <StatCard label="Attack missed" value={hr.officialFireRecord.fireMissed} />
                <StatCard label="Attack hit rate" value={pct(hr.officialFireRecord.fireHitRate)} sub="official W/L" />
              </div>
              {hr.shadowWatchIntelligence && (
                <>
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-500 pt-1">Playable / shadow (not Attack-official)</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="Playable reached" value={hr.shadowWatchIntelligence.readyReached} />
                    <StatCard label="Playable → Attack" value={hr.shadowWatchIntelligence.watchPromotedToFire} sub="promoted" />
                    <StatCard label="Playable-only" value={hr.shadowWatchIntelligence.readyOnly} sub="never reached Attack" />
                    <StatCard label="Playable cashed (no Attack)" value={hr.shadowWatchIntelligence.watchCashedWithoutFire} sub="shadow win, not Attack-official" />
                  </div>
                </>
              )}
            </div>
          )}
          {/* Playability coverage metrics (spec §8, 2026-07) — Playable AND
              Attack both count as official here, per the product's Watchlist/
              Lean/Playable/Attack contract. Distinct from the Attack-only
              block above. */}
          {hr.playabilityMetrics && (
            <div className="space-y-2" data-testid="block-hr-playability-metrics">
              <div className="text-xs font-semibold uppercase tracking-wide text-sky-500 pt-1">Playability coverage</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <StatCard label="Official recall" value={pct(hr.playabilityMetrics.officialRecall)} sub="Playable+Attack / all HRs" />
                <StatCard label="Radar coverage recall" value={pct(hr.playabilityMetrics.radarCoverageRecall)} sub="any tier / all HRs" />
                <StatCard label="Late signal rate" value={pct(hr.playabilityMetrics.lateSignalRate)} />
                <StatCard label="True uncalled HR rate" value={pct(hr.playabilityMetrics.trueUncalledHrRate)} />
                <StatCard label="Playable/Attack precision" value={pct(hr.playabilityMetrics.playableAttackPrecision)} />
                <StatCard label="Watchlist/Lean conversion" value={pct(hr.playabilityMetrics.watchlistLeanConversionRate)} />
              </div>
            </div>
          )}
          {hr.sampleSizeWarning && (
            <div className="text-xs text-amber-500 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> {hr.sampleSizeWarning}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4. Driver Intelligence */}
      <Card data-testid="card-drivers">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Zap className="h-4 w-4" /> Driver Intelligence ({dr.observedDrivers} observed)</CardTitle>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-sm font-medium mb-2">Top Drivers</div>
            {dr.topDrivers.length === 0 && <div className="text-xs text-muted-foreground">No settled drivers in window.</div>}
            <ul className="text-xs space-y-1">
              {dr.topDrivers.map((d) => (
                <li key={d.driver} className="flex justify-between gap-2 py-1 border-b border-border/30" data-testid={`row-driver-top-${d.driver}`}>
                  <span className="truncate">{d.driver}</span>
                  <span className="text-muted-foreground">{pct(d.hitRate)} · {d.cashed}-{d.missed} · ROI {num(d.roiUnits)}u</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">Bottom Drivers</div>
            {dr.bottomDrivers.length === 0 && <div className="text-xs text-muted-foreground">No settled drivers in window.</div>}
            <ul className="text-xs space-y-1">
              {dr.bottomDrivers.map((d) => (
                <li key={d.driver} className="flex justify-between gap-2 py-1 border-b border-border/30" data-testid={`row-driver-bottom-${d.driver}`}>
                  <span className="truncate">{d.driver}</span>
                  <span className="text-muted-foreground">{pct(d.hitRate)} · {d.cashed}-{d.missed} · ROI {num(d.roiUnits)}u</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="md:col-span-2">
            <div className="text-sm font-medium mb-2">Top Driver Combos</div>
            {dr.topCombos.length === 0 && <div className="text-xs text-muted-foreground">No settled combos in window.</div>}
            <ul className="text-xs space-y-1">
              {dr.topCombos.map((c) => (
                <li key={c.combo} className="flex justify-between gap-2 py-1 border-b border-border/30" data-testid={`row-driver-combo-${c.combo}`}>
                  <span className="truncate">{c.combo}</span>
                  <span className="text-muted-foreground">{pct(c.hitRate)} · {c.cashed}-{c.missed} · ROI {num(c.roiUnits)}u</span>
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* 5. Shadow Qualification */}
      <Card data-testid="card-shadow">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Shadow Qualification (live{sh.thresholds.liveFloor} vs shadow{sh.thresholds.shadowFloor})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Live Settled" value={sh.live.settled} sub={`${sh.live.cashed}-${sh.live.missed}`} />
            <StatCard label="Live Hit %" value={pct(sh.live.hitRate)} />
            <StatCard label="Live ROI/pick" value={num(sh.live.roiPerPick, 3)} />
            <StatCard label="Shadow Settled" value={sh.shadow.settled} sub={`${sh.shadow.cashed}-${sh.shadow.missed}`} />
            <StatCard label="Shadow Hit %" value={pct(sh.shadow.hitRate)} />
            <StatCard label="Shadow ROI/pick" value={num(sh.shadow.roiPerPick, 3)} />
            <StatCard label="Δ Hit Rate" value={pct(sh.delta.hitRateDelta)} sub="shadow − live" />
            <StatCard label="Δ ROI/pick" value={num(sh.delta.roiPerPickDelta, 3)} sub="shadow − live" />
          </div>
          {(sh.live.sampleSizeWarning || sh.shadow.sampleSizeWarning) && (
            <div className="text-xs text-amber-500 space-y-1">
              {sh.live.sampleSizeWarning && <div className="flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Live: {sh.live.sampleSizeWarning}</div>}
              {sh.shadow.sampleSizeWarning && <div className="flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Shadow: {sh.shadow.sampleSizeWarning}</div>}
            </div>
          )}
          <div>
            <div className="text-sm font-medium mb-2">Shadow by Market</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1 pr-3">Market</th>
                    <th className="py-1 pr-3">Settled</th>
                    <th className="py-1 pr-3">Cashed</th>
                    <th className="py-1 pr-3">Hit %</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(sh.byMarket).map(([m, r]) => (
                    <tr key={m} className="border-b border-border/50">
                      <td className="py-1 pr-3 font-mono">{m}</td>
                      <td className="py-1 pr-3">{r.shadow.settled}</td>
                      <td className="py-1 pr-3">{r.shadow.cashed}</td>
                      <td className="py-1 pr-3">{pct(r.shadow.hitRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 6. Alerts */}
      <Card data-testid="card-alerts">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" /> Alerts</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Queued" value={lc.alerts.queued} />
          <StatCard label="Sent" value={lc.alerts.sent} />
          <StatCard label="Opened" value={lc.alerts.opened} />
          <StatCard label="Clicked" value={lc.alerts.clicked} />
          <StatCard label="Open Rate" value={pct(lc.alerts.openRate)} />
          <StatCard label="Click-Through" value={pct(lc.alerts.clickThroughRate)} />
        </CardContent>
      </Card>

      {/* 7. Calibration */}
      <Card data-testid="card-calibration">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Calibration</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Avg Probability (window)" value={lc.signalAging.avgProbability ?? "—"} />
          <StatCard label="Avg Signal Score (window)" value={lc.signalAging.avgSignalScore ?? "—"} />
          <StatCard label="Sample Floor" value={lc.sampleSizeFloor} sub="for ROI bucket warnings" />
          <StatCard label="Window" value={dur(lc.windowMs)} />
        </CardContent>
      </Card>

      {/* 8. Pregame Radar Calibration (Win Attribution — full denominator) */}
      <PregameRadarCalibrationCard />

      {/* 9. HR Miss Diagnostics — LLM payload generator (read-only) */}
      <HrMissDiagnosticsCard />
    </div>
  );
}
