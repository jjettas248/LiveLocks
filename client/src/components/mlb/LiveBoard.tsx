import { Target, TrendingUp, Eye, Flame, ChevronDown, ChevronUp, ChevronRight } from "lucide-react";
import { useState } from "react";

type MLBSignal = {
  playerId: string;
  playerName: string;
  market: string;
  bookLine: number | null;
  projection?: number | null;
  enginePct: number;
  edge: number | null;
  evPct?: number | null;
  recommendedSide: string;
  tier: string;
  gameId?: string;
  signalScore?: number | null;
  confidenceTier?: string | null;
  signalTags?: string[];
  feedTags?: string[];
  formIndicator?: string | null;
  reasons?: string[];
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  playerGlowEligible?: boolean;
};

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  hrr: "H+R+RBI",
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
  batter_strikeouts: "Strikeouts",
  hr_allowed: "HR Allowed",
};

const SIDE_COLORS = {
  OVER: { accent: "#22c55e", bg: "rgba(34,197,94,0.06)", border: "rgba(34,197,94,0.25)" },
  UNDER: { accent: "#ef4444", bg: "rgba(239,68,68,0.06)", border: "rgba(239,68,68,0.25)" },
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

function formBadge(form: string | null | undefined): { label: string; color: string } | null {
  if (!form) return null;
  const f = form.toUpperCase();
  if (f === "HOT") return { label: "🔥", color: "#f97316" };
  if (f === "WARM") return { label: "🟡", color: "#eab308" };
  if (f === "COLD") return { label: "❄️", color: "#60a5fa" };
  if (f === "EXTREME_COLD") return { label: "🧊", color: "#818cf8" };
  return null;
}

export function LiveBoard({ signals, onPlayerClick }: { signals: MLBSignal[]; onPlayerClick?: (gameId: string, playerId: string) => void }) {
  const [collapsedTiers, setCollapsedTiers] = useState<Record<string, boolean>>({});

  const grouped: Record<string, { over: MLBSignal[]; under: MLBSignal[] }> = {
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
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors hover:opacity-80"
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
                  <span className="text-[9px] px-1 py-0.5 rounded" style={{ color: "#ef4444", background: "rgba(239,68,68,0.1)" }}>
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
                          <BoardCard key={`${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`} sig={sig} tierConfig={tier} onPlayerClick={onPlayerClick} />
                        ))}
                      </div>
                    )}
                    {items.under.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {items.under.map((sig, idx) => (
                          <BoardCard key={`${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`} sig={sig} tierConfig={tier} onPlayerClick={onPlayerClick} />
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

function BoardCard({ sig, tierConfig, onPlayerClick }: { sig: MLBSignal; tierConfig: TierConfig; onPlayerClick?: (gameId: string, playerId: string) => void }) {
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;
  const tags = (sig.signalTags ?? []).slice(0, 2);
  const side = SIDE_COLORS[sig.recommendedSide as keyof typeof SIDE_COLORS] ?? SIDE_COLORS.OVER;
  const form = formBadge(sig.formIndicator);
  const reasons = (sig.reasons ?? []).slice(0, 2);
  const isClickable = !!(onPlayerClick && sig.gameId);

  return (
    <div
      data-testid={`mlb-board-signal-${sig.playerId}-${sig.market}`}
      className={`rounded-lg p-3 space-y-1.5 transition-all ${isClickable ? "cursor-pointer hover:brightness-110" : ""}`}
      style={{ background: side.bg, border: `1px solid ${side.border}` }}
      onClick={isClickable ? () => onPlayerClick(sig.gameId!, sig.playerId) : undefined}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-bold text-white truncate">{sig.playerName}</span>
          {form && <span className="text-[10px] flex-shrink-0">{form.label}</span>}
          {sig.playerGlowEligible && (
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tierConfig.color, boxShadow: `0 0 6px ${tierConfig.color}` }} />
          )}
          {isClickable && <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
        </div>
        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ color: side.accent, background: "rgba(255,255,255,0.04)", border: `1px solid ${side.border}` }}>
          {sig.recommendedSide}
        </span>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-[10px] text-muted-foreground">
          {marketLabel} {sig.recommendedSide} {sig.bookLine}
          {matchup && <span className="text-muted-foreground/50 ml-1">· {matchup}</span>}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-sm font-black tabular-nums" style={{ color: side.accent }}>
            {sig.enginePct.toFixed(0)}%
          </span>
          {sig.edge != null && (
            <span className="text-[9px] tabular-nums" style={{ color: sig.edge > 0 ? "#22c55e" : "#ef4444" }}>
              {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      {sig.projection != null && (
        <div className="flex items-center gap-3 text-[9px]">
          <span className="text-muted-foreground/70">Proj: <span className="text-white font-semibold">{sig.projection.toFixed(2)}</span></span>
          <span className="text-muted-foreground/70">Line: <span className="text-white font-semibold">{sig.bookLine}</span></span>
          <span className="text-muted-foreground/70">S: <span className="text-white font-semibold">{sig.signalScore ?? 0}</span></span>
        </div>
      )}

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="text-[8px] px-1 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "#a1a1aa" }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="space-y-0.5">
          {reasons.map((r, i) => (
            <p key={i} className="text-[8px] text-muted-foreground/60 leading-tight truncate">
              {r}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
