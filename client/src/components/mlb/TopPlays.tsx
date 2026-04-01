import { useState } from "react";
import { Flame, TrendingUp, Target, Eye, ChevronRight, ChevronDown, Plus } from "lucide-react";

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
  gameId?: string;
  odds?: { bookLine: number } | null;
  inning?: number;
  signalScore?: number | null;
  confidenceTier?: string;
  signalTags?: string[];
  feedTags?: string[];
  formIndicator?: string | null;
  reasons?: string[];
  awayAbbr?: string | null;
  homeAbbr?: string | null;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  bvp?: { atBats: number; hits: number; avg: number | null; homeRuns: number; strikeouts: number } | null;
  overOdds?: number | null;
  underOdds?: number | null;
  bookImplied?: number | null;
  isDegraded?: boolean;
  alreadyHit?: boolean;
  actionable?: boolean;
  stale?: boolean;
  watchlist?: boolean;
  badges?: string[];
  [key: string]: any;
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
  pitcher_outs: "Outs (Pitcher)",
  walks_allowed: "BB Allowed",
  hits_allowed: "Hits Allowed",
  earned_runs: "Earned Runs",
  batter_strikeouts: "Strikeouts",
  hr_allowed: "HR Allowed",
};

const TIER_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  ELITE: { bg: "rgba(234,179,8,0.08)", border: "rgba(234,179,8,0.4)", text: "#eab308", badge: "ELITE" },
  STRONG: { bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.4)", text: "#22c55e", badge: "STRONG" },
  SOLID: { bg: "rgba(20,184,166,0.08)", border: "rgba(20,184,166,0.4)", text: "#14b8a6", badge: "SOLID" },
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

export function TopPlays({ signals, onPlayerClick, onAddToSlip }: { signals: MLBSignal[]; onPlayerClick?: (gameId: string, playerId: string) => void; onAddToSlip?: (sig: MLBSignal) => void }) {
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
              <SignalCard key={`over-${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`} sig={sig} onPlayerClick={onPlayerClick} onAddToSlip={onAddToSlip} />
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
              <SignalCard key={`under-${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`} sig={sig} onPlayerClick={onPlayerClick} onAddToSlip={onAddToSlip} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatOdds(odds: number | null | undefined): string {
  if (odds == null) return "";
  return odds > 0 ? `+${odds}` : `${odds}`;
}

function getCurrentStatForMarket(sig: MLBSignal): { label: string; value: number } | null {
  const cs = sig.currentStats;
  if (!cs) return null;
  switch (sig.market) {
    case "hits": return { label: "H", value: cs.h };
    case "home_runs": case "hr": return { label: "HR", value: cs.hr };
    case "total_bases": return { label: "TB", value: cs.tb };
    case "rbi": return { label: "RBI", value: cs.rbi };
    case "stolen_bases": return { label: "SB", value: cs.sb };
    case "batter_strikeouts": return { label: "K", value: cs.k };
    case "hrr": return { label: "H+R+RBI", value: cs.h + ((cs as any).r ?? 0) + cs.rbi };
    default: return { label: "H", value: cs.h };
  }
}

function SignalCard({ sig, onPlayerClick, onAddToSlip }: { sig: MLBSignal; onPlayerClick?: (gameId: string, playerId: string) => void; onAddToSlip?: (sig: MLBSignal) => void }) {
  const [expanded, setExpanded] = useState(false);
  const tier = TIER_COLORS[sig.confidenceTier ?? "WATCHLIST"] ?? TIER_COLORS.WATCHLIST;
  const side = SIDE_STYLES[sig.recommendedSide as keyof typeof SIDE_STYLES] ?? SIDE_STYLES.OVER;
  const marketLabel = MARKET_LABELS[sig.market] ?? sig.market;
  const tags = (sig.signalTags ?? []).slice(0, 3);
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} vs ${sig.homeAbbr}` : null;
  const form = formBadge(sig.formIndicator ?? null);
  const reasons = sig.reasons ?? [];
  const isClickable = !!onPlayerClick;
  const liveStat = getCurrentStatForMarket(sig);
  const sideOdds = sig.recommendedSide === "OVER" ? sig.overOdds : sig.underOdds;
  const cardOpacity = sig.stale ? 0.5 : sig.alreadyHit ? 0.7 : 1;

  return (
    <div
      data-testid={`mlb-top-play-${sig.playerId}-${sig.market}`}
      className={`rounded-xl p-3.5 space-y-2 transition-all ${isClickable ? "cursor-pointer hover:brightness-110" : ""}`}
      style={{ background: side.bg, border: `1px solid ${side.border}`, opacity: cardOpacity }}
      onClick={isClickable && sig.gameId ? () => onPlayerClick!(sig.gameId!, sig.playerId) : undefined}
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
          {sig.alreadyHit && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: "#22c55e", background: "rgba(34,197,94,0.15)" }}>
              HIT ✓
            </span>
          )}
          {sig.stale && !sig.alreadyHit && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: "#71717a", background: "rgba(113,113,122,0.15)" }}>
              STALE
            </span>
          )}
          {sig.watchlist && !sig.stale && !sig.alreadyHit && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: "#71717a", background: "rgba(113,113,122,0.1)" }}>
              WATCH
            </span>
          )}
          {sig.isDegraded && (
            <span className="text-[8px] text-amber-500/70 px-1 py-0.5 rounded" style={{ background: "rgba(245,158,11,0.08)" }}>⚠</span>
          )}
        </div>
        {matchup && <span className="text-[9px] text-muted-foreground">{matchup}</span>}
      </div>

      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-bold text-white truncate">{sig.playerName}</p>
            {sig.playerGlowEligible && (
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tier.text, boxShadow: `0 0 6px ${tier.text}` }} />
            )}
            {isClickable && <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
          </div>
          <p className="text-[10px] font-medium" style={{ color: side.accent }}>
            {marketLabel} {side.label} {sig.bookLine}
            {sideOdds != null && <span className="text-muted-foreground/60 ml-1">({formatOdds(sideOdds)})</span>}
          </p>
        </div>
        <div className="flex flex-col items-end flex-shrink-0">
          <span className="text-lg font-black tabular-nums" style={{ color: side.accent }}>
            {sig.enginePct.toFixed(0)}%
          </span>
          {sig.bookImplied != null && (
            <span className="text-[9px] text-muted-foreground/50">Book: {sig.bookImplied.toFixed(0)}%</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[9px] text-muted-foreground/70">Edge</div>
          <div className="text-[11px] font-bold" style={{ color: (sig.edge ?? 0) > 0 ? "#22c55e" : "#ef4444" }}>
            {(sig.edge ?? 0) > 0 ? "+" : ""}{(sig.edge ?? 0).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-[9px] text-muted-foreground/70">Proj</div>
          <div className="text-[11px] font-bold text-white">{sig.projection != null ? sig.projection.toFixed(2) : "—"}</div>
        </div>
        {liveStat ? (
          <div>
            <div className="text-[9px] text-muted-foreground/70">{liveStat.label}</div>
            <div className="text-[11px] font-bold" style={{ color: liveStat.value >= (sig.bookLine ?? 99) ? "#22c55e" : "#ffffff" }}>
              {liveStat.value}/{sig.bookLine}
            </div>
          </div>
        ) : (
          <div>
            <div className="text-[9px] text-muted-foreground/70">Line</div>
            <div className="text-[11px] font-bold text-white">{sig.bookLine ?? "—"}</div>
          </div>
        )}
        <div>
          <div className="text-[9px] text-muted-foreground/70">Score</div>
          <div className="text-[11px] font-bold text-white">{sig.signalScore ?? 0}</div>
        </div>
      </div>

      {sig.bvp && sig.bvp.atBats > 0 && (
        <div className="text-[9px] px-2 py-1 rounded" style={{ background: "rgba(255,255,255,0.03)" }}>
          <span className="text-muted-foreground/70">BvP: </span>
          <span className="text-white font-semibold">{sig.bvp.hits}/{sig.bvp.atBats}</span>
          <span className="text-muted-foreground/50 ml-1">({sig.bvp.avg != null ? sig.bvp.avg.toFixed(3) : "—"})</span>
          {sig.bvp.homeRuns > 0 && <span className="text-orange-400 ml-1.5 font-semibold">{sig.bvp.homeRuns} HR</span>}
          {sig.bvp.strikeouts > 0 && <span className="text-muted-foreground/50 ml-1.5">{sig.bvp.strikeouts} K</span>}
        </div>
      )}

      {(tags.length > 0 || (sig.badges ?? []).length > 0) && (
        <div className="flex flex-wrap gap-1">
          {(sig.badges ?? []).slice(0, 2).map((badge) => (
            <span key={badge} className="text-[8px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: "rgba(234,179,8,0.1)", color: "#eab308" }}>
              {badge}
            </span>
          ))}
          {tags.map((tag) => (
            <span key={tag} className="flex items-center gap-0.5 text-[8px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.06)", color: "#d4d4d8" }}>
              {getTagIcon(tag)}
              {tag}
            </span>
          ))}
        </div>
      )}

      {reasons.length > 0 && (
        <div onClick={(e) => e.stopPropagation()}>
          <button
            className="flex items-center gap-1 text-[9px] text-muted-foreground/70 hover:text-muted-foreground transition-colors w-full"
            data-testid={`button-expand-reasons-${sig.playerId}-${sig.market}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span>{reasons.length} reason{reasons.length !== 1 ? "s" : ""}</span>
          </button>
          {expanded && (
            <div className="space-y-0.5 pt-1 animate-in slide-in-from-top-1 duration-200">
              {reasons.map((r, i) => (
                <p key={i} className="text-[9px] text-muted-foreground/80 leading-tight flex items-start gap-1">
                  <span className="mt-px" style={{ color: side.accent }}>•</span>
                  <span>{r}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-0.5 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2">
          {sig.isDegraded && (
            <span className="text-[8px] text-amber-500/70">Limited data</span>
          )}
          {sig.sportsbook && (
            <span className="text-[8px] text-muted-foreground/40">{sig.sportsbook}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onAddToSlip && (
            <button
              data-testid={`button-top-play-slip-${sig.playerId}-${sig.market}`}
              className="text-[9px] px-2.5 py-1.5 rounded-full font-semibold transition-colors flex items-center gap-0.5 min-h-[44px]"
              style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" }}
              onClick={(e) => { e.stopPropagation(); onAddToSlip(sig); }}
            >
              <Plus className="w-3 h-3" /> Slip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
