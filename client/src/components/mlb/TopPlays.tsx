import { Flame, TrendingUp, Target, Eye, ChevronRight } from "lucide-react";

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
  tier?: string;
  gameId: string;
  signalScore?: number | null;
  confidenceTier?: string;
  signalTags?: string[];
  feedTags?: string[];
  formIndicator?: string | null;
  reasons?: string[];
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  [key: string]: any;
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
  batter_strikeouts: "Strikeouts",
  hr_allowed: "HR Allowed",
};

const TIER_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  ELITE: { bg: "rgba(0,212,170,0.08)", border: "rgba(0,212,170,0.4)", text: "#00d4aa", badge: "ELITE" },
  STRONG: { bg: "rgba(250,204,21,0.08)", border: "rgba(250,204,21,0.4)", text: "#facc15", badge: "STRONG" },
  SOLID: { bg: "rgba(56,189,248,0.08)", border: "rgba(56,189,248,0.4)", text: "#38bdf8", badge: "EDGE" },
  WATCHLIST: { bg: "rgba(113,113,122,0.06)", border: "rgba(113,113,122,0.3)", text: "#71717a", badge: "WATCH" },
};

const SIDE_STYLES = {
  OVER: { accent: "#22c55e", bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.35)", label: "OVER" },
  UNDER: { accent: "#3b82f6", bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.35)", label: "UNDER" },
};

function formBadge(form: string | null): { label: string; color: string } | null {
  if (!form) return null;
  const f = form.toUpperCase();
  if (f === "HOT") return { label: "🔥 HOT", color: "#f97316" };
  if (f === "WARM") return { label: "🟡 WARM", color: "#eab308" };
  if (f === "COLD") return { label: "❄️ COLD", color: "#60a5fa" };
  if (f === "EXTREME_COLD") return { label: "🧊 ICE COLD", color: "#818cf8" };
  return null;
}

function getTagIcon(tag: string) {
  if (tag.includes("HOT")) return <Flame className="w-3 h-3" />;
  if (tag.includes("TREND") || tag.includes("MOMENTUM")) return <TrendingUp className="w-3 h-3" />;
  if (tag.includes("MATCHUP") || tag.includes("EDGE")) return <Target className="w-3 h-3" />;
  return <Eye className="w-3 h-3" />;
}

export function TopPlays({ signals, onPlayerClick }: { signals: MLBSignal[]; onPlayerClick?: (gameId: string, playerId: string) => void }) {
  const sorted = [...signals].sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
  const topPlays = sorted.slice(0, 6);

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

  const overPlays = topPlays.filter(s => s.recommendedSide === "OVER");
  const underPlays = topPlays.filter(s => s.recommendedSide === "UNDER");

  return (
    <div className="space-y-3" data-testid="mlb-top-plays">
      <div className="flex items-center gap-2 px-1">
        <Flame className="w-4 h-4 text-orange-400" />
        <span className="text-sm font-bold text-white">Top Plays</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400 font-semibold">{topPlays.length}</span>
      </div>

      {overPlays.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 px-1">
            <span className="w-2 h-2 rounded-full" style={{ background: "#22c55e" }} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#22c55e" }}>Over Plays</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {overPlays.map((sig, idx) => (
              <SignalCard key={`over-${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`} sig={sig} onPlayerClick={onPlayerClick} />
            ))}
          </div>
        </div>
      )}

      {underPlays.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 px-1">
            <span className="w-2 h-2 rounded-full" style={{ background: "#3b82f6" }} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#3b82f6" }}>Under Plays</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {underPlays.map((sig, idx) => (
              <SignalCard key={`under-${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`} sig={sig} onPlayerClick={onPlayerClick} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SignalCard({ sig, onPlayerClick }: { sig: MLBSignal; onPlayerClick?: (gameId: string, playerId: string) => void }) {
  const tier = TIER_COLORS[sig.confidenceTier] ?? TIER_COLORS.WATCHLIST;
  const side = SIDE_STYLES[sig.recommendedSide as keyof typeof SIDE_STYLES] ?? SIDE_STYLES.OVER;
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const tags = (sig.signalTags ?? []).slice(0, 3);
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} vs ${sig.homeAbbr}` : null;
  const form = formBadge(sig.formIndicator);
  const reasons = (sig.reasons ?? []).slice(0, 2);
  const isClickable = !!onPlayerClick;

  return (
    <div
      data-testid={`mlb-top-play-${sig.playerId}-${sig.market}`}
      className={`rounded-xl p-3.5 space-y-2 transition-all ${isClickable ? "cursor-pointer hover:brightness-110" : ""}`}
      style={{ background: side.bg, border: `1px solid ${side.border}` }}
      onClick={isClickable ? () => onPlayerClick(sig.gameId, sig.playerId) : undefined}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span
            className="text-[9px] font-black px-2 py-0.5 rounded-full"
            style={{ background: tier.bg, color: tier.text, border: `1px solid ${tier.border}` }}
          >
            {tier.badge}
          </span>
          <span
            className="text-[9px] font-black px-2 py-0.5 rounded-full"
            style={{ background: side.bg, color: side.accent, border: `1px solid ${side.border}` }}
          >
            {side.label}
          </span>
          {form && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full" style={{ color: form.color, background: "rgba(255,255,255,0.04)" }}>
              {form.label}
            </span>
          )}
        </div>
        {matchup && <span className="text-[9px] text-muted-foreground">{matchup}</span>}
      </div>

      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-bold text-white truncate">{sig.playerName}</p>
            {isClickable && <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
          </div>
          <p className="text-[10px] font-medium" style={{ color: side.accent }}>
            {marketLabel} {side.label} {sig.bookLine}
          </p>
        </div>
        <div className="flex flex-col items-end flex-shrink-0">
          <span className="text-lg font-black tabular-nums" style={{ color: side.accent }}>
            {sig.enginePct.toFixed(0)}%
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[9px] text-muted-foreground/70">EV%</div>
          <div className="text-[11px] font-bold" style={{ color: (sig.evPct ?? sig.edge ?? 0) > 0 ? "#22c55e" : "#ef4444" }}>
            {(sig.evPct ?? sig.edge ?? 0) > 0 ? "+" : ""}{(sig.evPct ?? sig.edge ?? 0).toFixed(1)}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground/70">Projection</div>
          <div className="text-[11px] font-bold text-white">{sig.projection != null ? sig.projection.toFixed(2) : "—"}</div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground/70">Line</div>
          <div className="text-[11px] font-bold text-white">{sig.bookLine ?? "—"}</div>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span key={tag} className="flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.06)", color: "#d4d4d8" }}>
              {getTagIcon(tag)}
              {tag}
            </span>
          ))}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="space-y-0.5 pt-0.5">
          {reasons.map((r, i) => (
            <p key={i} className="text-[9px] text-muted-foreground/80 leading-tight">
              {r}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-0.5 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <span className="text-[9px] text-muted-foreground/50">Score: {sig.signalScore}</span>
        {sig.edge != null && (
          <span className="text-[9px] text-muted-foreground/50">
            Edge: {sig.edge > 0 ? "+" : ""}{sig.edge.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
