import { Flame, TrendingUp, Target, Eye } from "lucide-react";

type MLBSignal = {
  playerId: string;
  playerName: string;
  market: string;
  bookLine: number | null;
  projection: number | null;
  enginePct: number;
  edge: number | null;
  recommendedSide: string;
  tier: string;
  gameId: string;
  signalScore: number;
  confidenceTier: string;
  signalTags: string[];
  feedTags: string[];
  formIndicator: string | null;
  awayAbbr?: string | null;
  homeAbbr?: string | null;
};

const MARKET_LABELS: Record<string, string> = {
  hits: "Hits",
  total_bases: "Total Bases",
  hrr: "H+R+RBI",
  hr: "Home Runs",
  rbi: "RBIs",
  runs: "Runs",
  stolen_bases: "Stolen Bases",
  pitcher_strikeouts: "K (Pitcher)",
  pitcher_outs: "Outs (Pitcher)",
  walks_allowed: "BB Allowed",
  hits_allowed: "Hits Allowed",
  earned_runs: "Earned Runs",
};

const TIER_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  ELITE: { bg: "rgba(0,212,170,0.08)", border: "rgba(0,212,170,0.4)", text: "#00d4aa", badge: "ELITE" },
  STRONG: { bg: "rgba(250,204,21,0.08)", border: "rgba(250,204,21,0.4)", text: "#facc15", badge: "STRONG" },
  SOLID: { bg: "rgba(56,189,248,0.08)", border: "rgba(56,189,248,0.4)", text: "#38bdf8", badge: "EDGE" },
  WATCHLIST: { bg: "rgba(113,113,122,0.06)", border: "rgba(113,113,122,0.3)", text: "#71717a", badge: "WATCH" },
};

function getTagIcon(tag: string) {
  if (tag.includes("HOT")) return <Flame className="w-3 h-3" />;
  if (tag.includes("TREND") || tag.includes("MOMENTUM")) return <TrendingUp className="w-3 h-3" />;
  if (tag.includes("MATCHUP") || tag.includes("EDGE")) return <Target className="w-3 h-3" />;
  return <Eye className="w-3 h-3" />;
}

export function TopPlays({ signals }: { signals: MLBSignal[] }) {
  const sorted = [...signals].sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
  const topPlays = sorted.slice(0, 5);

  if (topPlays.length === 0) {
    return (
      <div className="rounded-xl p-4 space-y-3" style={{ background: "#0a0a0a", border: "1px solid #1a1a2e" }} data-testid="mlb-top-plays-monitoring">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-bold text-white">Top Plays</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
          </span>
          <span className="text-xs font-semibold text-blue-400">Engine processing live markets</span>
        </div>
        <p className="text-[11px] text-muted-foreground">Switch to the Games tab to select any game and run manual calculations on player props while the engine evaluates all markets.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="mlb-top-plays">
      <div className="flex items-center gap-2 px-1">
        <Flame className="w-4 h-4 text-orange-400" />
        <span className="text-sm font-bold text-white">Top Plays</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400 font-semibold">{topPlays.length}</span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2" style={{ scrollSnapType: "x mandatory" }}>
        {topPlays.map((sig, idx) => {
          const tier = TIER_COLORS[sig.confidenceTier] ?? TIER_COLORS.WATCHLIST;
          const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
          const tags = (sig.signalTags ?? []).slice(0, 2);
          const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;

          return (
            <div
              key={`${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`}
              data-testid={`mlb-top-play-${sig.playerId}-${sig.market}`}
              className="flex-shrink-0 rounded-xl p-3.5 space-y-2"
              style={{
                width: 260,
                background: "#0a0a0a",
                border: `1px solid ${tier.border}`,
                scrollSnapAlign: "start",
              }}
            >
              <div className="flex items-center justify-between">
                <span
                  className="text-[9px] font-black px-2 py-0.5 rounded-full"
                  style={{ background: tier.bg, color: tier.text, border: `1px solid ${tier.border}` }}
                >
                  {tier.badge}
                </span>
                {matchup && <span className="text-[9px] text-muted-foreground">{matchup}</span>}
              </div>

              <div>
                <p className="text-xs font-bold text-white truncate">{sig.playerName}</p>
                <p className="text-[10px] text-muted-foreground">{marketLabel} {sig.recommendedSide} {sig.bookLine}</p>
              </div>

              <div className="flex items-baseline gap-2">
                <span className="text-lg font-black tabular-nums" style={{ color: tier.text }}>{sig.enginePct.toFixed(1)}%</span>
                {sig.edge != null && (
                  <span className="text-[10px] font-semibold text-muted-foreground">Edge {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%</span>
                )}
              </div>

              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <span key={tag} className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.05)", color: "#a1a1aa" }}>
                      {getTagIcon(tag)}
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                <span>Score: {sig.signalScore}</span>
                {sig.projection != null && <span>Proj: {sig.projection.toFixed(1)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
