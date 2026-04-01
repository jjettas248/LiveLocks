import { useState } from "react";
import { ChevronRight, ChevronDown, Plus, Flame, TrendingUp, Target, Eye } from "lucide-react";
import {
  formatMlbMarketLabel,
  formatAmericanOdds,
  getMlbLiveStatValue,
  getSignalStateMeta,
  formBadge,
  TIER_COLORS,
  SIDE_STYLES,
  generateShareTweet,
  openShareWindow,
} from "@/lib/mlbFormatters";

export type MlbSignalData = {
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
  playerGlowEligible?: boolean;
  currentStats?: { ab?: number; h?: number; hr?: number; tb?: number; bb?: number; rbi?: number; k?: number; sb?: number; r?: number } | null;
  lastABContact?: { exitVelo: number | null; launchAngle: number | null; outcome: string | null } | null;
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
  sportsbook?: string | null;
  [key: string]: any;
};

function getTagIcon(tag: string) {
  if (tag.includes("HOT")) return <Flame className="w-3 h-3" />;
  if (tag.includes("TREND") || tag.includes("MOMENTUM")) return <TrendingUp className="w-3 h-3" />;
  if (tag.includes("MATCHUP") || tag.includes("EDGE")) return <Target className="w-3 h-3" />;
  return <Eye className="w-3 h-3" />;
}

type CardVariant = "featured" | "compact";

export function MlbSignalCard({
  sig,
  variant = "featured",
  tierColor,
  onPlayerClick,
  onAddToSlip,
}: {
  sig: MlbSignalData;
  variant?: CardVariant;
  tierColor?: string;
  onPlayerClick?: (gameId: string, playerId: string) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tier = TIER_COLORS[sig.confidenceTier ?? "WATCHLIST"] ?? TIER_COLORS.WATCHLIST;
  const side = SIDE_STYLES[sig.recommendedSide as keyof typeof SIDE_STYLES] ?? SIDE_STYLES.OVER;
  const marketLabel = formatMlbMarketLabel(sig.market);
  const tags = (sig.signalTags ?? []).slice(0, 3);
  const matchup = sig.awayAbbr && sig.homeAbbr ? `${sig.awayAbbr} @ ${sig.homeAbbr}` : null;
  const form = formBadge(sig.formIndicator ?? null);
  const reasons = sig.reasons ?? [];
  const isClickable = !!(onPlayerClick && sig.gameId);
  const liveStat = getMlbLiveStatValue(sig);
  const sideOdds = sig.recommendedSide === "OVER" ? sig.overOdds : sig.underOdds;
  const cardOpacity = sig.stale ? 0.5 : sig.alreadyHit ? 0.7 : 1;
  const stateLabel = getSignalStateMeta(sig);
  const resolvedTierColor = tierColor ?? tier.text;

  if (variant === "compact") {
    return (
      <div
        data-testid={`mlb-signal-${sig.playerId}-${sig.market}`}
        className={`rounded-lg p-3 space-y-1.5 transition-all ${isClickable ? "cursor-pointer hover:brightness-110" : ""}`}
        style={{ background: side.bg, border: `1px solid ${side.border}`, opacity: cardOpacity }}
        onClick={isClickable ? () => onPlayerClick!(sig.gameId!, sig.playerId) : undefined}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-bold text-white truncate">{sig.playerName}</span>
            {form && <span className="text-[10px] flex-shrink-0">{form.label}</span>}
            {sig.playerGlowEligible && (
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: resolvedTierColor, boxShadow: `0 0 6px ${resolvedTierColor}` }} />
            )}
            {sig.isDegraded && <span className="text-[8px] text-amber-500/60 flex-shrink-0">\u26A0</span>}
            {isClickable && <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
          </div>
          <div className="flex items-center gap-1.5">
            {stateLabel && (
              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: stateLabel.color, background: stateLabel.bg }}>
                {stateLabel.label}
              </span>
            )}
            <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ color: side.accent, background: "rgba(255,255,255,0.04)", border: `1px solid ${side.border}` }}>
              {sig.recommendedSide}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="text-[10px] text-muted-foreground">
            {marketLabel} {sig.recommendedSide} {sig.bookLine}
            {sideOdds != null && <span className="text-muted-foreground/60 ml-1">({formatAmericanOdds(sideOdds)})</span>}
            {matchup && <span className="text-muted-foreground/50 ml-1">{"\u00B7"} {matchup}</span>}
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

        {liveStat && (
          <div className="flex items-center gap-3 text-[9px]">
            <span className="font-semibold" style={{ color: liveStat.value >= (sig.bookLine ?? 99) ? "#22c55e" : "#a1a1aa" }}>
              {liveStat.label}: {liveStat.value}/{sig.bookLine}
            </span>
            {sig.projection != null && (
              <span className="text-muted-foreground/70">Proj: <span className="text-white font-semibold">{sig.projection.toFixed(2)}</span></span>
            )}
            {sig.bookImplied != null && (
              <span className="text-muted-foreground/70">Book: <span className="text-white font-semibold">{sig.bookImplied.toFixed(0)}%</span></span>
            )}
            <span className="text-muted-foreground/70">S: <span className="text-white font-semibold">{sig.signalScore ?? 0}</span></span>
          </div>
        )}

        {!liveStat && sig.projection != null && (
          <div className="flex items-center gap-3 text-[9px]">
            <span className="text-muted-foreground/70">Proj: <span className="text-white font-semibold">{sig.projection.toFixed(2)}</span></span>
            <span className="text-muted-foreground/70">Line: <span className="text-white font-semibold">{sig.bookLine}</span></span>
            <span className="text-muted-foreground/70">S: <span className="text-white font-semibold">{sig.signalScore ?? 0}</span></span>
          </div>
        )}

        {sig.bvp && sig.bvp.atBats > 0 && (
          <div className="text-[8px] text-muted-foreground/70">
            BvP: {sig.bvp.hits}/{sig.bvp.atBats} ({sig.bvp.avg != null ? sig.bvp.avg.toFixed(3) : "\u2014"})
            {sig.bvp.homeRuns > 0 && <span className="text-orange-400 ml-1">{sig.bvp.homeRuns} HR</span>}
          </div>
        )}

        {(tags.length > 0 || (sig.badges ?? []).length > 0) && (
          <div className="flex flex-wrap gap-1">
            {(sig.badges ?? []).slice(0, 2).map((badge) => (
              <span key={badge} className="text-[8px] px-1 py-0.5 rounded font-semibold" style={{ background: "rgba(234,179,8,0.1)", color: "#eab308" }}>
                {badge}
              </span>
            ))}
            {tags.map((tag) => (
              <span key={tag} className="text-[8px] px-1 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.05)", color: "#a1a1aa" }}>
                {tag}
              </span>
            ))}
          </div>
        )}

        {reasons.length > 0 && (
          <div className="space-y-0.5">
            {reasons.slice(0, 2).map((r, i) => (
              <p key={i} className="text-[8px] text-muted-foreground/60 leading-tight truncate">{r}</p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end pt-0.5 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <button
            data-testid={`button-share-${sig.playerId}-${sig.market}`}
            className="text-[8px] px-2 py-1 rounded font-semibold transition-colors"
            style={{ background: "rgba(59,130,246,0.1)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.2)" }}
            onClick={(e) => { e.stopPropagation(); openShareWindow(generateShareTweet(sig)); }}
          >{"\uD835\uDD4F"} Share</button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid={`mlb-signal-${sig.playerId}-${sig.market}`}
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
          {stateLabel && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ color: stateLabel.color, background: stateLabel.bg }}>
              {stateLabel.label}
            </span>
          )}
          {sig.isDegraded && (
            <span className="text-[8px] text-amber-500/70 px-1 py-0.5 rounded" style={{ background: "rgba(245,158,11,0.08)" }}>{"\u26A0"}</span>
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
            {sideOdds != null && <span className="text-muted-foreground/60 ml-1">({formatAmericanOdds(sideOdds)})</span>}
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
          <div className="text-[11px] font-bold text-white">{sig.projection != null ? sig.projection.toFixed(2) : "\u2014"}</div>
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
            <div className="text-[11px] font-bold text-white">{sig.bookLine ?? "\u2014"}</div>
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
          <span className="text-muted-foreground/50 ml-1">({sig.bvp.avg != null ? sig.bvp.avg.toFixed(3) : "\u2014"})</span>
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
                  <span className="mt-px" style={{ color: side.accent }}>{"\u2022"}</span>
                  <span>{r}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-0.5 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2">
          {sig.isDegraded && <span className="text-[8px] text-amber-500/70">Limited data</span>}
          {sig.sportsbook && <span className="text-[8px] text-muted-foreground/40">{sig.sportsbook}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid={`button-share-${sig.playerId}-${sig.market}`}
            className="text-[9px] px-2 py-1.5 rounded-full font-semibold transition-colors min-h-[44px]"
            style={{ background: "rgba(59,130,246,0.1)", color: "#60a5fa", border: "1px solid rgba(59,130,246,0.2)" }}
            onClick={(e) => { e.stopPropagation(); openShareWindow(generateShareTweet(sig)); }}
          >{"\uD835\uDD4F"}</button>
          {onAddToSlip && (
            <button
              data-testid={`button-slip-${sig.playerId}-${sig.market}`}
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
