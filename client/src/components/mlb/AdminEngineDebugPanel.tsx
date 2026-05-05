import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Activity, AlertTriangle, Flame, Database, Wrench } from "lucide-react";

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
  };
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
  };
};

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
                <div>Calibration: {data.semantics.calibrationVersion}</div>
                <div>Snapshot age: {Math.round((Date.now() - dataUpdatedAt) / 1000)}s</div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
