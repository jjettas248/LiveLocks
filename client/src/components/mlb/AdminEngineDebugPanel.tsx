import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Flame,
  Database,
  Wrench,
  Eye,
  Settings2,
  ChevronDown,
  ChevronUp,
  ScrollText,
} from "lucide-react";
import { useAdminViewMode, useRealUser, type AdminViewMode } from "@/hooks/use-auth";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type EngineDebugResponse = {
  now: number;
  selectedGameId: string | null;
  activeGames: number;
  games: Array<{ gameId: string; status: string | null; startTime: string | null }>;
  edgeEntries: Array<{
    gameId: string;
    ageSec: number | null;
    qualifiedSignals: number;
    allSignals: number;
    outputs: number;
    isDegraded: boolean;
    signalLocked: boolean;
    tags: string[];
  }>;
  totals: {
    rawSignalCount: number;
    qualifiedSignalCount: number;
    suppressedCount: number;
    persistedTodayCount: number;
    pendingPlayCount: number;
    hrWatchDetectedCount: number;
    hrWatchSuppressedCount: number;
    persistRejectedCount: number;
    topPlaysCount: number;
    hrrCalibrationCount?: number;
    hitsAllowedCalibrationCount?: number;
    selfLearningCalibrationCount?: number;
    hrWatchContextUseCount?: number;
    capsAppliedCount?: number;
  };
  recentHrrCalibrations?: Array<{
    ts: number;
    player: string | null;
    rawProbability: number | null;
    adjustedProbability: number | null;
    capApplied: boolean;
    usedTbFallback: boolean;
    reason: string;
  }>;
  recentHitsAllowedCalibrations?: Array<{
    ts: number;
    pitcher: string | null;
    rawProbability: number | null;
    adjustedProbability: number | null;
    fallbackUsed: boolean;
  }>;
  recentHrWatchContextUses?: Array<{
    ts: number;
    player: string | null;
    market: string | null;
    nearHrCount: number | null;
    affectedSignalScore: number | null;
    signalTier: string | null;
  }>;
  emptyStateReason: string | null;
  recentHrWatchDetections: Array<{
    ts: number;
    player: string | null;
    market: string | null;
    signalTier: string | null;
    ev: number | null;
    la: number | null;
    drivers: string[];
  }>;
  recentHrWatchSuppressed: Array<{
    ts: number;
    player: string | null;
    market: string | null;
    reason: string;
  }>;
  recentPersistRejects: Array<{
    ts: number;
    reason: string;
    player: string | null;
    market: string | null;
  }>;
  semantics: {
    probability: string;
    tier: string;
    calibrationVersion: string;
    phase3Note?: string;
  };
};

const VIEW_MODE_OPTIONS: Array<{ value: AdminViewMode; label: string }> = [
  { value: "real", label: "Real (you)" },
  { value: "free", label: "Free" },
  { value: "pro_mlb", label: "Pro MLB" },
  { value: "all_sports", label: "All Sports" },
  { value: "admin", label: "Admin" },
];

const DEFAULT_ROW_LIMIT = 5;

function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "err" | "muted";
}) {
  const color =
    tone === "ok"
      ? "text-green-400"
      : tone === "warn"
        ? "text-amber-400"
        : tone === "err"
          ? "text-red-400"
          : tone === "muted"
            ? "text-muted-foreground"
            : "text-foreground";
  return (
    <div className="rounded-md border border-border/40 bg-background/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

function SectionHeader({ icon: Icon, label }: { icon: typeof Activity; label: string }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
      <Icon className="w-3 h-3" /> {label}
    </div>
  );
}

function RowList<T>({
  rows,
  testId,
  render,
  emptyLabel,
}: {
  rows: T[];
  testId: string;
  render: (row: T, i: number) => React.ReactNode;
  emptyLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length === 0) {
    return <div className="text-[10px] text-muted-foreground italic px-2 py-1">{emptyLabel}</div>;
  }
  const visible = expanded ? rows : rows.slice(0, DEFAULT_ROW_LIMIT);
  const hasMore = rows.length > DEFAULT_ROW_LIMIT;
  return (
    <div className="space-y-0.5">
      {visible.map((row, i) => (
        <div
          key={i}
          className="text-[10px] px-2 py-0.5 rounded bg-background/30 flex items-center justify-between gap-2"
          data-testid={`${testId}-${i}`}
        >
          {render(row, i)}
        </div>
      ))}
      {hasMore && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 px-2 py-0.5"
          data-testid={`${testId}-toggle`}
        >
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {expanded ? `Hide (${rows.length - DEFAULT_ROW_LIMIT} more)` : `View ${rows.length - DEFAULT_ROW_LIMIT} more`}
        </button>
      )}
    </div>
  );
}

export function AdminEngineDebugPanel({ selectedGameId }: { selectedGameId: string | null }) {
  const [open, setOpen] = useState(false);
  const [viewMode, setViewMode] = useAdminViewMode();
  const realUser = useRealUser();
  const params = selectedGameId ? `?gameId=${encodeURIComponent(selectedGameId)}` : "";
  const { data, isLoading, error, dataUpdatedAt } = useQuery<EngineDebugResponse>({
    queryKey: ["/api/admin/mlb/engine-debug", selectedGameId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/mlb/engine-debug${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 15_000,
  });

  // Defense in depth — never render the panel for non-admin REAL users, even
  // if a parent forgets to gate. This prevents diagnostic data from ever
  // appearing under a view-mode override.
  if (!realUser?.isAdmin) return null;

  const games = data?.activeGames ?? 0;
  const qualified = data?.totals.qualifiedSignalCount ?? 0;
  const hrWatch = data?.totals.hrWatchDetectedCount ?? 0;
  const errors = data?.totals.persistRejectedCount ?? 0;
  const overrideActive = viewMode !== "real";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* Floating trigger — bottom-right, mobile-safe */}
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open MLB DevTools"
          data-testid="button-open-mlb-devtools"
          className="fixed z-40 right-3 sm:right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+12px)] sm:bottom-4 flex items-center gap-2 px-3 py-2 rounded-full border border-amber-500/40 bg-background/95 backdrop-blur shadow-lg hover:border-amber-500/70 transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">MLB DevTools</span>
          {data && (
            <span className="text-[10px] text-muted-foreground font-mono" data-testid="text-mlb-devtools-summary">
              {games}g · {qualified}q · {hrWatch}hr · {errors}err
            </span>
          )}
          {overrideActive && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold uppercase">
              View
            </span>
          )}
        </button>
      </SheetTrigger>

      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 flex flex-col"
        data-testid="admin-engine-debug-panel"
      >
        <SheetHeader className="px-4 pt-4 pb-2 border-b border-border/40">
          <SheetTitle className="text-sm flex items-center gap-2">
            <Wrench className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-amber-400 uppercase tracking-wider text-xs">MLB DevTools</span>
            {data && (
              <span className="text-[10px] text-muted-foreground font-mono ml-1">
                {games}g · {qualified}q · {hrWatch}hr · {errors}err
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="text-[10px]">
            Admin-only diagnostics. Updates every 15s.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" data-testid="admin-engine-debug-body">
          {/* View-as switcher — always at top */}
          <div className="rounded-md border border-border/40 bg-background/40 px-2 py-2">
            <div className="flex items-center gap-2 mb-1.5">
              <Eye className="w-3 h-3 text-muted-foreground" />
              <span className="text-[10px] uppercase text-muted-foreground tracking-wider">View as</span>
              {overrideActive && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold uppercase"
                  data-testid="badge-view-mode-active"
                >
                  Override active
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {VIEW_MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setViewMode(opt.value)}
                  className={`text-[10px] px-2 py-1 rounded border ${
                    viewMode === opt.value
                      ? "border-amber-500/60 bg-amber-500/10 text-amber-300 font-bold"
                      : "border-border/40 bg-background/20 text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid={`button-view-mode-${opt.value}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="text-[9px] text-muted-foreground mt-1">
              Cosmetic only — your real account stays {realUser?.email ? `as ${realUser.email}` : "intact"} on the server. Refreshes & re-logins reset to "Real".
            </div>
          </div>

          {isLoading && <div className="text-xs text-muted-foreground">Loading engine debug…</div>}
          {error && (
            <div className="text-xs text-red-400 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" /> {(error as Error).message}
            </div>
          )}

          {data && (
            <>
              {data.emptyStateReason && (
                <div
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300 flex items-start gap-1.5"
                  data-testid="text-empty-state-reason"
                >
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold">Why feed is empty:</span> {data.emptyStateReason}
                  </div>
                </div>
              )}

              <Tabs defaultValue="overview" className="w-full">
                <TabsList className="w-full h-auto flex-wrap justify-start gap-1 bg-background/40 p-1">
                  <TabsTrigger value="overview" className="text-[10px] px-2 py-1 h-auto" data-testid="tab-overview">
                    Overview
                  </TabsTrigger>
                  <TabsTrigger value="pipeline" className="text-[10px] px-2 py-1 h-auto" data-testid="tab-pipeline">
                    Pipeline
                  </TabsTrigger>
                  <TabsTrigger value="hrwatch" className="text-[10px] px-2 py-1 h-auto" data-testid="tab-hrwatch">
                    HR Watch
                  </TabsTrigger>
                  <TabsTrigger value="calibration" className="text-[10px] px-2 py-1 h-auto" data-testid="tab-calibration">
                    Calibration
                  </TabsTrigger>
                  <TabsTrigger value="cache" className="text-[10px] px-2 py-1 h-auto" data-testid="tab-cache">
                    Cache
                  </TabsTrigger>
                  <TabsTrigger value="contract" className="text-[10px] px-2 py-1 h-auto" data-testid="tab-contract">
                    Contract
                  </TabsTrigger>
                </TabsList>

                {/* OVERVIEW */}
                <TabsContent value="overview" className="mt-3 space-y-3">
                  <div>
                    <SectionHeader icon={Activity} label="At a glance" />
                    <div className="grid grid-cols-2 gap-1.5">
                      <StatTile label="Active Games" value={games} tone={games > 0 ? "ok" : "warn"} />
                      <StatTile label="Qualified" value={qualified} tone={qualified > 0 ? "ok" : "muted"} />
                      <StatTile label="HR Watch" value={hrWatch} tone={hrWatch > 0 ? "ok" : "muted"} />
                      <StatTile label="Errors" value={errors} tone={errors > 0 ? "warn" : "muted"} />
                    </div>
                  </div>
                  <div>
                    <SectionHeader icon={Database} label="Persistence" />
                    <div className="grid grid-cols-2 gap-1.5">
                      <StatTile label="Persisted Today" value={data.totals.persistedTodayCount} />
                      <StatTile label="Pending Plays" value={data.totals.pendingPlayCount} />
                    </div>
                  </div>
                </TabsContent>

                {/* PIPELINE */}
                <TabsContent value="pipeline" className="mt-3 space-y-3">
                  <div>
                    <SectionHeader icon={Activity} label="Signal Pipeline" />
                    <div className="grid grid-cols-2 gap-1.5">
                      <StatTile label="Active Games" value={games} tone={games > 0 ? "ok" : "warn"} />
                      <StatTile label="Raw" value={data.totals.rawSignalCount} />
                      <StatTile
                        label="Qualified"
                        value={qualified}
                        tone={qualified > 0 ? "ok" : "muted"}
                      />
                      <StatTile label="Suppressed" value={data.totals.suppressedCount} tone="muted" />
                      <StatTile label="Top Plays" value={data.totals.topPlaysCount} />
                      <StatTile
                        label="Persist Reject"
                        value={data.totals.persistRejectedCount}
                        tone={data.totals.persistRejectedCount > 0 ? "warn" : "muted"}
                      />
                    </div>
                  </div>

                  <div>
                    <SectionHeader icon={ScrollText} label="Recent Persist Rejects" />
                    <RowList
                      rows={data.recentPersistRejects}
                      testId="row-persist-reject"
                      emptyLabel="No persist rejects in the recent window."
                      render={(r) => (
                        <>
                          <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                          <span className="truncate">
                            {r.player ?? "?"} · {r.market ?? "?"}
                          </span>
                          <span className="text-red-400 shrink-0">{r.reason}</span>
                        </>
                      )}
                    />
                  </div>
                </TabsContent>

                {/* HR WATCH */}
                <TabsContent value="hrwatch" className="mt-3 space-y-3">
                  <div>
                    <SectionHeader icon={Flame} label="HR Watch (last 10m)" />
                    <div className="grid grid-cols-3 gap-1.5">
                      <StatTile
                        label="Detected"
                        value={data.totals.hrWatchDetectedCount}
                        tone={data.totals.hrWatchDetectedCount > 0 ? "ok" : "muted"}
                      />
                      <StatTile
                        label="Suppressed"
                        value={data.totals.hrWatchSuppressedCount}
                        tone="muted"
                      />
                      <StatTile
                        label="Ctx Used"
                        value={data.totals.hrWatchContextUseCount ?? 0}
                        tone={
                          data.totals.hrWatchContextUseCount && data.totals.hrWatchContextUseCount > 0
                            ? "ok"
                            : "muted"
                        }
                      />
                    </div>
                  </div>

                  <div>
                    <SectionHeader icon={ScrollText} label="Recent Detections" />
                    <RowList
                      rows={data.recentHrWatchDetections}
                      testId="row-hr-watch-detection"
                      emptyLabel="No HR Watch detections in the recent window."
                      render={(r) => (
                        <>
                          <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                          <span className="truncate">
                            {r.player ?? "?"} · {r.market ?? "?"}
                          </span>
                          <span className="text-green-400 shrink-0">{r.signalTier}</span>
                        </>
                      )}
                    />
                  </div>

                  <div>
                    <SectionHeader icon={ScrollText} label="Context Uses" />
                    <RowList
                      rows={data.recentHrWatchContextUses ?? []}
                      testId="row-hr-watch-ctx"
                      emptyLabel="No HR Watch context applied recently."
                      render={(r) => (
                        <>
                          <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                          <span className="truncate">
                            {r.player ?? "?"} · {r.market ?? "?"}
                          </span>
                          <span className="shrink-0">drv={r.nearHrCount}</span>
                          <span className="shrink-0">score={r.affectedSignalScore}</span>
                          {r.signalTier && <span className="text-amber-400 shrink-0">{r.signalTier}</span>}
                        </>
                      )}
                    />
                  </div>
                </TabsContent>

                {/* CALIBRATION */}
                <TabsContent value="calibration" className="mt-3 space-y-3">
                  <div>
                    <SectionHeader icon={Activity} label="Market Calibration (last 10m)" />
                    <div className="grid grid-cols-2 gap-1.5">
                      <StatTile label="HRR Calls" value={data.totals.hrrCalibrationCount ?? 0} tone="muted" />
                      <StatTile
                        label="Hits-Allowed"
                        value={data.totals.hitsAllowedCalibrationCount ?? 0}
                        tone="muted"
                      />
                      <StatTile
                        label="Self-Learn"
                        value={data.totals.selfLearningCalibrationCount ?? 0}
                        tone="muted"
                      />
                      <StatTile
                        label="Caps Applied"
                        value={data.totals.capsAppliedCount ?? 0}
                        tone="muted"
                      />
                    </div>
                  </div>

                  <div>
                    <SectionHeader icon={ScrollText} label="Recent HRR" />
                    <RowList
                      rows={data.recentHrrCalibrations ?? []}
                      testId="row-hrr-cal"
                      emptyLabel="No HRR calibrations recorded recently."
                      render={(r) => (
                        <>
                          <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                          <span className="truncate">{r.player ?? "?"}</span>
                          <span className="shrink-0 font-mono">raw={r.rawProbability?.toFixed(1)}</span>
                          {r.usedTbFallback && <span className="text-amber-400 shrink-0">tb-fb</span>}
                          {r.capApplied && <span className="text-blue-400 shrink-0">cap</span>}
                        </>
                      )}
                    />
                  </div>

                  <div>
                    <SectionHeader icon={ScrollText} label="Recent Hits-Allowed" />
                    <RowList
                      rows={data.recentHitsAllowedCalibrations ?? []}
                      testId="row-hits-allowed-cal"
                      emptyLabel="No hits-allowed calibrations recorded recently."
                      render={(r) => (
                        <>
                          <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                          <span className="truncate">{r.pitcher ?? "?"}</span>
                          <span className="shrink-0 font-mono">raw={r.rawProbability?.toFixed(1)}</span>
                          {r.fallbackUsed && <span className="text-amber-400 shrink-0">cdf-fb</span>}
                        </>
                      )}
                    />
                  </div>
                </TabsContent>

                {/* CACHE */}
                <TabsContent value="cache" className="mt-3 space-y-3">
                  <div>
                    <SectionHeader icon={Database} label="Per-Game Edge Cache" />
                    {data.edgeEntries.length === 0 ? (
                      <div className="text-[10px] text-muted-foreground italic px-2 py-1">
                        No active per-game cache entries.
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {data.edgeEntries.map((e) => (
                          <div
                            key={e.gameId}
                            className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-background/40 border border-border/40"
                            data-testid={`row-edge-cache-${e.gameId}`}
                          >
                            <span className="font-mono text-muted-foreground">{e.gameId}</span>
                            <div className="flex items-center gap-2">
                              <span>age {fmtAge(e.ageSec)}</span>
                              <span>q={e.qualifiedSignals}</span>
                              <span>all={e.allSignals}</span>
                              {e.isDegraded && <span className="text-amber-400">degraded</span>}
                              {e.signalLocked && <span className="text-blue-400">locked</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* DISPLAY CONTRACT */}
                <TabsContent value="contract" className="mt-3 space-y-3">
                  <div className="rounded-md border border-border/40 bg-background/40 px-2 py-2 text-[10px] space-y-1.5">
                    <div className="font-bold text-foreground uppercase tracking-wider">Canonical Display Contract</div>
                    <div className="text-muted-foreground leading-relaxed">
                      Server stamps <span className="font-mono text-amber-300">displaySide</span>,{" "}
                      <span className="font-mono text-amber-300">displayProbability</span>,{" "}
                      <span className="font-mono text-amber-300">displayGrade</span>,{" "}
                      <span className="font-mono text-amber-300">isBettable</span>, and{" "}
                      <span className="font-mono text-amber-300">displayDrivers</span> in{" "}
                      <span className="font-mono">applyDisplayContract</span>. Clients read these directly — they never
                      re-derive grade from <span className="font-mono">liveScore</span>.
                    </div>
                    <div className="text-muted-foreground leading-relaxed">
                      Mismatches surface as{" "}
                      <span className="font-mono text-amber-300">[MLB_DISPLAY_CONTRACT_MISMATCH]</span> log lines on the
                      server.
                    </div>
                  </div>

                  <div className="rounded-md border border-border/40 bg-background/40 px-2 py-2 text-[10px] space-y-1">
                    <div className="font-bold text-foreground uppercase tracking-wider mb-0.5">Engine Semantics</div>
                    <div>
                      <span className="text-muted-foreground">Probability:</span> {data.semantics.probability}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Tier:</span> {data.semantics.tier}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Calibration:</span>{" "}
                      <span className="text-amber-400 font-mono">{data.semantics.calibrationVersion}</span>
                    </div>
                    {data.semantics.phase3Note && (
                      <div className="italic text-muted-foreground">{data.semantics.phase3Note}</div>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/40 px-4 py-2 text-[9px] text-muted-foreground flex items-center justify-between">
          <span>
            Snapshot age: {data ? Math.round((Date.now() - dataUpdatedAt) / 1000) : "—"}s
          </span>
          <span className="font-mono">{data?.semantics.calibrationVersion ?? ""}</span>
        </div>
      </SheetContent>
    </Sheet>
  );
}
