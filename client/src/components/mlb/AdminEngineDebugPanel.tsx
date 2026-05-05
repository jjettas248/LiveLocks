import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Activity, AlertTriangle, Flame, Database, Wrench, Eye } from "lucide-react";
import { useAdminViewMode, useRealUser, type AdminViewMode } from "@/hooks/use-auth";

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
    // Phase 3 — market-calibration audit counters.
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

const VIEW_MODE_OPTIONS: Array<{ value: AdminViewMode; label: string; tone: string }> = [
  { value: "real", label: "Real (you)", tone: "text-foreground" },
  { value: "free", label: "Free user", tone: "text-zinc-400" },
  { value: "pro_mlb", label: "Pro MLB", tone: "text-blue-400" },
  { value: "all_sports", label: "All Sports", tone: "text-emerald-400" },
  { value: "admin", label: "Admin", tone: "text-amber-400" },
];

function fmtAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "ok" | "warn" | "err" | "muted" }) {
  const color =
    tone === "ok" ? "text-green-400" :
    tone === "warn" ? "text-amber-400" :
    tone === "err" ? "text-red-400" :
    tone === "muted" ? "text-muted-foreground" :
    "text-foreground";
  return (
    <div className="rounded border border-border/40 bg-background/40 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm font-bold ${color}`}>{value}</div>
    </div>
  );
}

export function AdminEngineDebugPanel({ selectedGameId }: { selectedGameId: string | null }) {
  const [open, setOpen] = useState(true);
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

  return (
    <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg" data-testid="admin-engine-debug-panel">
      <button
        type="button"
        className="w-full flex items-center justify-between px-3 py-2"
        onClick={() => setOpen((o) => !o)}
        data-testid="button-toggle-admin-debug"
      >
        <div className="flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Admin · MLB Engine Debug</span>
          {data && (
            <span className="text-[10px] text-muted-foreground">
              {data.activeGames} active · {data.totals.qualifiedSignalCount} qualified · {data.totals.hrWatchDetectedCount} hr_watch
            </span>
          )}
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3" data-testid="admin-engine-debug-body">
          {/* View-as switcher */}
          <div className="rounded border border-border/40 bg-background/40 px-2 py-2">
            <div className="flex items-center gap-2 mb-1.5">
              <Eye className="w-3 h-3 text-muted-foreground" />
              <span className="text-[10px] uppercase text-muted-foreground tracking-wider">View as</span>
              {viewMode !== "real" && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold uppercase" data-testid="badge-view-mode-active">
                  Override active — UI does not match your real account
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
                <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300 flex items-start gap-1.5" data-testid="text-empty-state-reason">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                  <div>
                    <span className="font-bold">Why feed is empty:</span> {data.emptyStateReason}
                  </div>
                </div>
              )}

              {/* Pipeline counts */}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Activity className="w-3 h-3" /> Signal Pipeline
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                  <StatTile label="Active Games" value={data.activeGames} tone={data.activeGames > 0 ? "ok" : "warn"} />
                  <StatTile label="Raw" value={data.totals.rawSignalCount} />
                  <StatTile label="Qualified" value={data.totals.qualifiedSignalCount} tone={data.totals.qualifiedSignalCount > 0 ? "ok" : "muted"} />
                  <StatTile label="Suppressed" value={data.totals.suppressedCount} tone="muted" />
                  <StatTile label="Top Plays" value={data.totals.topPlaysCount} />
                </div>
              </div>

              {/* HR Watch */}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Flame className="w-3 h-3" /> HR Watch (last 10m)
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  <StatTile label="Detected" value={data.totals.hrWatchDetectedCount} tone={data.totals.hrWatchDetectedCount > 0 ? "ok" : "muted"} />
                  <StatTile label="Suppressed" value={data.totals.hrWatchSuppressedCount} tone="muted" />
                  <StatTile label="Persist Reject" value={data.totals.persistRejectedCount} tone={data.totals.persistRejectedCount > 0 ? "warn" : "muted"} />
                </div>
              </div>

              {/* Persistence */}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Database className="w-3 h-3" /> Persistence
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <StatTile label="Persisted Today" value={data.totals.persistedTodayCount} />
                  <StatTile label="Pending Plays" value={data.totals.pendingPlayCount} />
                </div>
              </div>

              {/* Phase 3 — Market Calibration */}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Activity className="w-3 h-3" /> Market Calibration (last 10m)
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                  <StatTile label="HRR Calls" value={data.totals.hrrCalibrationCount ?? 0} tone="muted" />
                  <StatTile label="Hits-Allowed" value={data.totals.hitsAllowedCalibrationCount ?? 0} tone="muted" />
                  <StatTile label="Self-Learn" value={data.totals.selfLearningCalibrationCount ?? 0} tone="muted" />
                  <StatTile label="HR Watch Ctx" value={data.totals.hrWatchContextUseCount ?? 0} tone={data.totals.hrWatchContextUseCount && data.totals.hrWatchContextUseCount > 0 ? "ok" : "muted"} />
                  <StatTile label="Caps Applied" value={data.totals.capsAppliedCount ?? 0} tone="muted" />
                </div>
                {data.recentHrrCalibrations && data.recentHrrCalibrations.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                    {data.recentHrrCalibrations.slice(0, 5).map((r, i) => (
                      <div key={i} className="text-[10px] px-2 py-0.5 rounded bg-background/30 flex items-center justify-between gap-2" data-testid={`row-hrr-cal-${i}`}>
                        <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                        <span className="truncate">{r.player ?? "?"}</span>
                        <span className="shrink-0">raw={r.rawProbability?.toFixed(1)}</span>
                        {r.usedTbFallback && <span className="text-amber-400 shrink-0">tb-fallback</span>}
                      </div>
                    ))}
                  </div>
                )}
                {data.recentHitsAllowedCalibrations && data.recentHitsAllowedCalibrations.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                    {data.recentHitsAllowedCalibrations.slice(0, 5).map((r, i) => (
                      <div key={i} className="text-[10px] px-2 py-0.5 rounded bg-background/30 flex items-center justify-between gap-2" data-testid={`row-hits-allowed-cal-${i}`}>
                        <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                        <span className="truncate">{r.pitcher ?? "?"}</span>
                        <span className="shrink-0">raw={r.rawProbability?.toFixed(1)}</span>
                        {r.fallbackUsed && <span className="text-amber-400 shrink-0">cdf-fallback</span>}
                      </div>
                    ))}
                  </div>
                )}
                {data.recentHrWatchContextUses && data.recentHrWatchContextUses.length > 0 && (
                  <div className="mt-1.5 space-y-0.5 max-h-32 overflow-y-auto">
                    {data.recentHrWatchContextUses.slice(0, 5).map((r, i) => (
                      <div key={i} className="text-[10px] px-2 py-0.5 rounded bg-background/30 flex items-center justify-between gap-2" data-testid={`row-hr-watch-ctx-${i}`}>
                        <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                        <span className="truncate">{r.player ?? "?"} · {r.market ?? "?"}</span>
                        <span className="shrink-0">drv={r.nearHrCount}</span>
                        <span className="shrink-0">score={r.affectedSignalScore}</span>
                        {r.signalTier && <span className="text-amber-400 shrink-0">{r.signalTier}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Per-game cache */}
              {data.edgeEntries.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">Per-Game Edge Cache</div>
                  <div className="space-y-1">
                    {data.edgeEntries.map((e) => (
                      <div key={e.gameId} className="flex items-center justify-between text-[10px] px-2 py-1 rounded bg-background/40 border border-border/40" data-testid={`row-edge-cache-${e.gameId}`}>
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
                </div>
              )}

              {/* Recent HR Watch */}
              {data.recentHrWatchDetections.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">Recent HR Watch Detections</div>
                  <div className="space-y-0.5 max-h-40 overflow-y-auto">
                    {data.recentHrWatchDetections.slice(0, 8).map((r, i) => (
                      <div key={i} className="text-[10px] px-2 py-0.5 rounded bg-background/30 flex items-center justify-between gap-2" data-testid={`row-hr-watch-detection-${i}`}>
                        <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                        <span className="truncate">{r.player ?? "?"} · {r.market ?? "?"}</span>
                        <span className="text-green-400 shrink-0">{r.signalTier}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Recent persist rejects */}
              {data.recentPersistRejects.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground mb-1">Recent Persist Rejects</div>
                  <div className="space-y-0.5 max-h-32 overflow-y-auto">
                    {data.recentPersistRejects.slice(0, 6).map((r, i) => (
                      <div key={i} className="text-[10px] px-2 py-0.5 rounded bg-red-500/5 flex items-center justify-between gap-2" data-testid={`row-persist-reject-${i}`}>
                        <span className="font-mono text-muted-foreground shrink-0">{fmtTime(r.ts)}</span>
                        <span className="truncate">{r.player ?? "?"} · {r.market ?? "?"}</span>
                        <span className="text-red-400 shrink-0">{r.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Semantics footer */}
              <div className="text-[9px] text-muted-foreground border-t border-border/30 pt-1.5 space-y-0.5">
                <div>Probability: {data.semantics.probability}</div>
                <div>Tier: {data.semantics.tier}</div>
                <div>Calibration: <span className="text-amber-400 font-mono">{data.semantics.calibrationVersion}</span></div>
                {data.semantics.phase3Note && <div className="text-[9px] italic">{data.semantics.phase3Note}</div>}
                <div>Snapshot age: {Math.round((Date.now() - dataUpdatedAt) / 1000)}s</div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
