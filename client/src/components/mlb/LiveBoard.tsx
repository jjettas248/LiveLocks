import { Target, TrendingUp, Eye, Flame, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { MlbSignalCard, type MlbSignalData } from "./MlbSignalCard";
import { resolveMlbSignalTier, type MlbSignalTier } from "@/lib/mlbFormatters";

// [MLB Canonical Signal Tier — Phase 2] Bucket keys MUST match the server's
// `signalTier` vocabulary exactly ("elite" | "strong" | "lean" | "watch") so
// that `grouped[resolveMlbSignalTier(sig)]` is always defined. Display labels
// remain user-facing names ("Elite" / "Strong" / "Lean" / "Watch").
type TierConfig = {
  key: MlbSignalTier;
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: typeof Flame;
};

const TIERS: TierConfig[] = [
  { key: "elite",  label: "Elite",  color: "#eab308", bg: "rgba(234,179,8,0.06)",   border: "rgba(234,179,8,0.3)",   icon: Flame      },
  { key: "strong", label: "Strong", color: "#22c55e", bg: "rgba(34,197,94,0.06)",   border: "rgba(34,197,94,0.3)",   icon: Target     },
  { key: "lean",   label: "Lean",   color: "#14b8a6", bg: "rgba(20,184,166,0.06)",  border: "rgba(20,184,166,0.3)",  icon: TrendingUp },
  { key: "watch",  label: "Watch",  color: "#71717a", bg: "rgba(113,113,122,0.04)", border: "rgba(113,113,122,0.2)", icon: Eye        },
];

export function LiveBoard({
  signals,
  onPlayerClick,
  onAddToSlip,
  onOpenCalculator,
  sortBy = "signalScore",
}: {
  signals: MlbSignalData[];
  onPlayerClick?: (gameId: string, playerId: string) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenCalculator?: (sig: MlbSignalData) => void;
  sortBy?: "signalScore" | "enginePct";
}) {
  const [collapsedTiers, setCollapsedTiers] = useState<Record<string, boolean>>({});
  const sortFn = sortBy === "enginePct"
    ? (a: MlbSignalData, b: MlbSignalData) => (b.enginePct ?? 0) - (a.enginePct ?? 0)
    : (a: MlbSignalData, b: MlbSignalData) => (b.signalScore ?? 0) - (a.signalScore ?? 0);

  const grouped: Record<MlbSignalTier, { over: MlbSignalData[]; under: MlbSignalData[] }> = {
    elite:  { over: [], under: [] },
    strong: { over: [], under: [] },
    lean:   { over: [], under: [] },
    watch:  { over: [], under: [] },
  };

  for (const sig of signals) {
    // [MLB Canonical Signal Tier — Phase 2] Read server-stamped `signalTier`
    // directly; resolveMlbSignalTier() emits [MLB_TIER_FALLBACK] only if the
    // server hasn't stamped it (cache rollover) and falls back deterministically.
    const tier = resolveMlbSignalTier(sig as any);
    if (sig.recommendedSide === "UNDER") {
      grouped[tier].under.push(sig);
    } else {
      grouped[tier].over.push(sig);
    }
  }

  // Phase E: distinguish strict / fallback / watch / truly-empty so the
  // empty-state copy doesn't say "no signals" when fallback signals exist.
  // Buckets are mutually exclusive: fallback wins over watch (orchestrator
  // stamps fallback signals with watchlist=true), then watch, then strict.
  const totalSignals = signals.length;
  const fallbackCount = signals.filter(s => s.fallbackUsed === true).length;
  const watchCount = signals.filter(
    s => s.fallbackUsed !== true && (s.watchlist === true || s.isEarlySignal === true)
  ).length;
  const strictCount = Math.max(0, totalSignals - fallbackCount - watchCount);

  for (const tier of Object.keys(grouped) as MlbSignalTier[]) {
    grouped[tier].over.sort(sortFn);
    grouped[tier].under.sort(sortFn);
  }

  const toggleTier = (key: string) => {
    setCollapsedTiers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="space-y-4" data-testid="mlb-live-board">
      {/* Phase E: top-of-board summary so users instantly see whether
           the engine is in strict mode, fallback mode, or only producing
           watch signals — and so the per-tier "no signals" copy reads
           correctly in each case. */}
      {totalSignals > 0 && (
        <div
          className="flex items-center gap-2 text-[10px] text-muted-foreground"
          data-testid="mlb-board-mode-summary"
        >
          {strictCount > 0 && (
            <span
              className="px-2 py-0.5 rounded-full font-semibold"
              style={{ background: "rgba(34,197,94,0.08)", color: "#86efac", border: "1px solid rgba(34,197,94,0.3)" }}
              data-testid="mode-summary-strict"
            >
              {strictCount} Strict
            </span>
          )}
          {fallbackCount > 0 && (
            <span
              className="px-2 py-0.5 rounded-full font-semibold"
              style={{ background: "rgba(251,191,36,0.08)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}
              data-testid="mode-summary-fallback"
              title="Fallback mode signals — engine surfaced these under relaxed criteria. Lower conviction than strict."
            >
              {fallbackCount} Fallback
            </span>
          )}
          {watchCount > 0 && (
            <span
              className="px-2 py-0.5 rounded-full font-semibold"
              style={{ background: "rgba(148,163,184,0.06)", color: "#94a3b8", border: "1px solid rgba(148,163,184,0.3)" }}
              data-testid="mode-summary-watch"
            >
              {watchCount} Watch
            </span>
          )}
        </div>
      )}
      {TIERS.map((tier) => {
        const items = grouped[tier.key];
        const totalCount = items.over.length + items.under.length;
        const isCollapsed = collapsedTiers[tier.key] ?? false;
        const Icon = tier.icon;

        return (
          <div key={tier.key} data-testid={`mlb-tier-${tier.key}`}>
            <button
              onClick={() => toggleTier(tier.key)}
              data-testid={`button-toggle-tier-${tier.key}`}
              className="w-full flex items-center justify-between px-3 py-3 min-h-[44px] rounded-lg transition-colors hover:opacity-80"
              style={{ background: tier.bg, border: `1px solid ${tier.border}` }}
            >
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5" style={{ color: tier.color }} />
                <span className="text-xs font-bold" style={{ color: tier.color }}>{tier.label}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: tier.bg, color: tier.color, border: `1px solid ${tier.border}` }}>
                  {totalCount}
                </span>
                {items.over.length > 0 && (
                  <span className="text-[9px] px-1 py-0.5 rounded" style={{ color: "#22c55e", background: "rgba(34,197,94,0.1)" }}>
                    {items.over.length} O
                  </span>
                )}
                {items.under.length > 0 && (
                  <span className="text-[9px] px-1 py-0.5 rounded" style={{ color: "#3b82f6", background: "rgba(59,130,246,0.1)" }}>
                    {items.under.length} U
                  </span>
                )}
              </div>
              {isCollapsed ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>

            {!isCollapsed && (
              <div className="mt-2 space-y-2">
                {totalCount === 0 ? (
                  <div className="py-3 text-center" data-testid={`text-tier-empty-${tier.key}`}>
                    <span className="text-[11px] text-muted-foreground/60">
                      {/* Phase E: contextual empty copy. If fallback or watch
                          signals exist elsewhere, the strict tiers should not
                          read as a flat "no signals" — they're just empty
                          *at this strict level* while fallback content is
                          available below. */}
                      {tier.key === "watch"
                        ? "No additional signals"
                        : (fallbackCount + watchCount > 0
                            ? "No strict signals — see fallback/watch below"
                            : "No signals at this level yet")}
                    </span>
                  </div>
                ) : (
                  <>
                    {items.over.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {items.over.map((sig, idx) => (
                          <MlbSignalCard
                            key={`${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`}
                            sig={sig}
                            onPlayerClick={onPlayerClick}
                            onAddToSlip={onAddToSlip}
                            onOpenCalculator={onOpenCalculator}
                          />
                        ))}
                      </div>
                    )}
                    {items.under.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {items.under.map((sig, idx) => (
                          <MlbSignalCard
                            key={`${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`}
                            sig={sig}
                            onPlayerClick={onPlayerClick}
                            onAddToSlip={onAddToSlip}
                            onOpenCalculator={onOpenCalculator}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
