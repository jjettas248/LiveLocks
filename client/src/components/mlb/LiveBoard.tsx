import { Target, TrendingUp, Eye, Flame, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { MlbSignalCard, type MlbSignalData } from "./MlbSignalCard";
import { classifyTier } from "@/lib/mlbFormatters";

type TierConfig = {
  key: string;
  label: string;
  min: number;
  max: number;
  color: string;
  bg: string;
  border: string;
  icon: typeof Flame;
};

const TIERS: TierConfig[] = [
  { key: "elite", label: "Elite", min: 75, max: 100, color: "#eab308", bg: "rgba(234,179,8,0.06)", border: "rgba(234,179,8,0.3)", icon: Flame },
  { key: "edge", label: "Strong", min: 65, max: 74, color: "#22c55e", bg: "rgba(34,197,94,0.06)", border: "rgba(34,197,94,0.3)", icon: Target },
  { key: "lean", label: "Solid", min: 55, max: 64, color: "#14b8a6", bg: "rgba(20,184,166,0.06)", border: "rgba(20,184,166,0.3)", icon: TrendingUp },
  { key: "watch", label: "Watch", min: 0, max: 54, color: "#71717a", bg: "rgba(113,113,122,0.04)", border: "rgba(113,113,122,0.2)", icon: Eye },
];

export function LiveBoard({
  signals,
  onPlayerClick,
  onAddToSlip,
}: {
  signals: MlbSignalData[];
  onPlayerClick?: (gameId: string, playerId: string) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
}) {
  const [collapsedTiers, setCollapsedTiers] = useState<Record<string, boolean>>({});

  const grouped: Record<string, { over: MlbSignalData[]; under: MlbSignalData[] }> = {
    elite: { over: [], under: [] },
    edge: { over: [], under: [] },
    lean: { over: [], under: [] },
    watch: { over: [], under: [] },
  };

  for (const sig of signals) {
    const tier = classifyTier(sig.signalScore);
    if (sig.recommendedSide === "UNDER") {
      grouped[tier].under.push(sig);
    } else {
      grouped[tier].over.push(sig);
    }
  }

  for (const tier of Object.keys(grouped)) {
    grouped[tier].over.sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
    grouped[tier].under.sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
  }

  const toggleTier = (key: string) => {
    setCollapsedTiers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="space-y-4" data-testid="mlb-live-board">
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
                      {tier.key === "watch" ? "No additional signals" : "No signals at this level yet"}
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
