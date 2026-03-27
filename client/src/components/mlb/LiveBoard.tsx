import { Target, TrendingUp, Eye, Flame, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

type MLBSignal = {
  playerId: string;
  playerName: string;
  market: string;
  bookLine: number | null;
  projection?: number | null;
  enginePct: number;
  edge: number | null;
  recommendedSide: string;
  tier: string;
  gameId?: string;
  signalScore?: number | null;
  confidenceTier?: string | null;
  signalTags?: string[];
  feedTags?: string[];
  formIndicator?: string | null;
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  playerGlowEligible?: boolean;
};

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  batter_strikeouts: "Strikeouts",
  hr: "Home Runs",
  home_runs: "Home Runs",
  rbi: "RBIs",
  runs: "Runs",
  stolen_bases: "Stolen Bases",
  pitcher_strikeouts: "K (Pitcher)",
  pitcher_k: "K (Pitcher)",
  pitcher_outs: "Outs",
  walks_allowed: "BB Allowed",
  hits_allowed: "Hits Allowed",
  earned_runs: "Earned Runs",
};

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
  { key: "elite", label: "Elite", min: 75, max: 100, color: "#00d4aa", bg: "rgba(0,212,170,0.06)", border: "rgba(0,212,170,0.3)", icon: Flame },
  { key: "edge", label: "Edge", min: 65, max: 74, color: "#facc15", bg: "rgba(250,204,21,0.06)", border: "rgba(250,204,21,0.3)", icon: Target },
  { key: "lean", label: "Lean", min: 55, max: 64, color: "#38bdf8", bg: "rgba(56,189,248,0.06)", border: "rgba(56,189,248,0.3)", icon: TrendingUp },
  { key: "watch", label: "Watch", min: 0, max: 54, color: "#71717a", bg: "rgba(113,113,122,0.04)", border: "rgba(113,113,122,0.2)", icon: Eye },
];

function classifyTier(score: number | null | undefined): string {
  const s = score ?? 0;
  if (s >= 75) return "elite";
  if (s >= 65) return "edge";
  if (s >= 55) return "lean";
  return "watch";
}

export function LiveBoard({ signals }: { signals: MLBSignal[] }) {
  const [collapsedTiers, setCollapsedTiers] = useState<Record<string, boolean>>({});

  const grouped: Record<string, MLBSignal[]> = { elite: [], edge: [], lean: [], watch: [] };
  for (const sig of signals) {
    const tier = classifyTier(sig.signalScore);
    grouped[tier].push(sig);
  }
  for (const tier of Object.keys(grouped)) {
    grouped[tier].sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
  }

  const toggleTier = (key: string) => {
    setCollapsedTiers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="space-y-4" data-testid="mlb-live-board">
      {TIERS.map((tier) => {
        const items = grouped[tier.key];
        const isCollapsed = collapsedTiers[tier.key] ?? false;
        const Icon = tier.icon;

        return (
          <div key={tier.key} data-testid={`mlb-tier-${tier.key}`}>
            <button
              onClick={() => toggleTier(tier.key)}
              data-testid={`button-toggle-tier-${tier.key}`}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors hover:opacity-80"
              style={{ background: tier.bg, border: `1px solid ${tier.border}` }}
            >
              <div className="flex items-center gap-2">
                <Icon className="w-3.5 h-3.5" style={{ color: tier.color }} />
                <span className="text-xs font-bold" style={{ color: tier.color }}>{tier.label}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: tier.bg, color: tier.color, border: `1px solid ${tier.border}` }}>
                  {items.length}
                </span>
              </div>
              {isCollapsed ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </button>

            {!isCollapsed && (
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {items.length === 0 ? (
                  <div className="col-span-full py-3 text-center" data-testid={`text-tier-empty-${tier.key}`}>
                    <span className="text-[11px] text-muted-foreground/60">
                      {tier.key === "watch" ? "No additional signals" : "No signals at this level yet"}
                    </span>
                  </div>
                ) : (
                  items.map((sig, idx) => {
                    const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
                    const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;
                    const tags = (sig.signalTags ?? []).slice(0, 2);

                    return (
                      <div
                        key={`${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`}
                        data-testid={`mlb-board-signal-${sig.playerId}-${sig.market}`}
                        className="rounded-lg p-3 flex items-start gap-3 transition-colors"
                        style={{ background: "#0a0a0a", border: `1px solid ${tier.border}` }}
                      >
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white truncate">{sig.playerName}</span>
                            {sig.playerGlowEligible && (
                              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tier.color, boxShadow: `0 0 6px ${tier.color}` }} />
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {marketLabel} {sig.recommendedSide} {sig.bookLine}
                          </div>
                          {matchup && <div className="text-[9px] text-muted-foreground/60">{matchup}</div>}
                          {tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {tags.map((tag) => (
                                <span key={tag} className="text-[8px] px-1 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "#a1a1aa" }}>
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col items-end flex-shrink-0">
                          <span className="text-sm font-black tabular-nums" style={{ color: tier.color }}>
                            {sig.enginePct.toFixed(1)}%
                          </span>
                          {sig.edge != null && (
                            <span className="text-[9px] text-muted-foreground">
                              {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%
                            </span>
                          )}
                          <span className="text-[8px] text-muted-foreground/50 mt-0.5">
                            S:{sig.signalScore ?? 0}
                          </span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
