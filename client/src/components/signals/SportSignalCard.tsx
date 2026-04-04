import { type ReactNode } from "react";
import { ConfidenceBadge, type ConfidenceTier } from "./ConfidenceBadge";
import { ShareSignalButton } from "@/components/common/ShareSignalButton";
import { CopyBetButton } from "@/components/common/CopyBetButton";

const SPORT_BADGE: Record<string, { label: string; color: string }> = {
  NBA: { label: "NBA", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  NCAAB: { label: "NCAAB", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  MLB: { label: "MLB", color: "bg-green-500/15 text-green-400 border-green-500/30" },
};

const EDGE_COLOR = (edge: number): string => {
  if (edge >= 8) return "text-green-400";
  if (edge >= 5) return "text-yellow-400";
  if (edge >= 0) return "text-muted-foreground";
  return "text-red-400";
};

export type SportSignalCardProps = {
  sport: "NBA" | "NCAAB" | "MLB";
  playerOrTeam: string;
  marketLabel: string;
  side: "OVER" | "UNDER" | "YES" | "NO" | string;
  line?: number | string;
  projection?: number | null;
  probability: number;
  edge: number;
  badgeTier: ConfidenceTier;
  summary?: string;
  timestampLabel?: string;
  locked?: boolean;
  isBestBet?: boolean;
  rank?: number;
  signalScore?: number | null;
  timingContext?: string | null;
  isFlagship?: boolean;
  onPrimaryAction?: () => void;
  onAddToSlip?: () => void;
  onShare?: () => void;
  onCopy?: () => void;
  footerSlot?: ReactNode;
  detailSlot?: ReactNode;
  market?: string;
  gameId?: string;
  playerId?: string | number;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  lastABContact?: {
    exitVelo: number | null;
    launchAngle: number | null;
    batSpeed: number | null;
    distance: number | null;
    barrelPct: number | null;
    hardHitPct: number | null;
    outcome: string | null;
  } | null;
  matchup?: string;
};

const RANK_STYLES: Record<number, { bg: string; border: string; text: string; label: string }> = {
  1: { bg: "bg-yellow-500/10", border: "border-yellow-500/40 ring-1 ring-yellow-500/20", text: "text-yellow-400", label: "#1 Pick" },
  2: { bg: "bg-slate-300/10", border: "border-slate-400/40 ring-1 ring-slate-400/15", text: "text-slate-300", label: "#2 Pick" },
  3: { bg: "bg-amber-600/10", border: "border-amber-600/40 ring-1 ring-amber-600/15", text: "text-amber-500", label: "#3 Pick" },
};

const SIGNAL_SCORE_COLOR = (score: number): string => {
  if (score >= 80) return "text-green-400";
  if (score >= 60) return "text-yellow-400";
  if (score >= 40) return "text-orange-400";
  return "text-muted-foreground";
};

export function SportSignalCard({
  sport,
  playerOrTeam,
  marketLabel,
  side,
  line,
  projection,
  probability,
  edge,
  badgeTier,
  summary,
  timestampLabel,
  locked,
  isBestBet,
  rank,
  signalScore,
  timingContext,
  isFlagship,
  onPrimaryAction,
  onAddToSlip,
  footerSlot,
  detailSlot,
  market: marketKey,
  currentStats,
  lastABContact,
  matchup,
}: SportSignalCardProps) {
  const sportBadge = SPORT_BADGE[sport] ?? SPORT_BADGE.NBA;
  const probWhole = Math.round(probability);
  const edgeStr = edge > 0 ? `+${edge.toFixed(1)}%` : `${edge.toFixed(1)}%`;
  const rankStyle = rank != null ? RANK_STYLES[rank] : undefined;

  return (
    <div
      data-testid={`card-signal-${sport.toLowerCase()}-${playerOrTeam.replace(/\s+/g, "-").toLowerCase()}`}
      className={`rounded-xl border bg-card overflow-hidden transition-all ${
        rankStyle
          ? `${rankStyle.border} shadow-[0_0_20px_rgba(234,179,8,0.08)]`
          : isBestBet
            ? "border-primary/40 ring-1 ring-primary/20 shadow-[0_0_16px_rgba(34,197,94,0.1)]"
            : "border-border/40 hover:border-border/60"
      } ${locked ? "opacity-60" : ""}`}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {rankStyle && (
              <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${rankStyle.bg} ${rankStyle.text} border ${rankStyle.border.split(" ")[0]} shrink-0`} data-testid={`badge-rank-${rank}`}>
                {rankStyle.label}
              </span>
            )}
            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${sportBadge.color}`}>
              {sportBadge.label}
            </span>
            <ConfidenceBadge tier={badgeTier} />
            {isFlagship && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/30 shrink-0" data-testid="badge-flagship">
                Flagship
              </span>
            )}
            {isBestBet && !rankStyle && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30 shrink-0">
                Best Bet
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {signalScore != null && (
              <span className={`text-[10px] font-bold tabular-nums ${SIGNAL_SCORE_COLOR(signalScore)}`} data-testid="text-signal-score">
                SS {Math.round(signalScore)}
              </span>
            )}
            {timestampLabel && (
              <span className="text-[10px] text-muted-foreground/60">{timestampLabel}</span>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-foreground leading-tight">{playerOrTeam}</span>
            {matchup && (
              <span className="text-[10px] text-muted-foreground/60">{matchup}</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-xs font-bold ${edge >= 5 ? EDGE_COLOR(edge) : "text-foreground"}`}>{side}</span>
            <span className="text-xs text-muted-foreground">{marketLabel}</span>
            {line != null && <span className="text-xs font-semibold text-foreground">{line}</span>}
            {timingContext && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-semibold" data-testid="badge-timing">
                {timingContext}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-end gap-5">
          <div>
            <div className={`text-2xl font-bold ${EDGE_COLOR(edge)}`}>{probWhole}%</div>
            <div className="text-[10px] text-muted-foreground">Probability</div>
          </div>
          {projection != null && (
            <div>
              <div className="text-sm font-semibold text-foreground">{typeof projection === "number" ? projection.toFixed(1) : projection}</div>
              <div className="text-[10px] text-muted-foreground">Proj</div>
            </div>
          )}
          {line != null && (
            <div>
              <div className="text-sm font-semibold text-foreground">{line}</div>
              <div className="text-[10px] text-muted-foreground">Line</div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px]">
          <span className={`font-medium ${EDGE_COLOR(edge)}`}>EV: {edgeStr}</span>
        </div>

        {currentStats && (() => {
          const cs = currentStats;
          const lineNum = typeof line === "number" ? line : 0;
          const mk = marketKey?.toLowerCase() ?? marketLabel.toLowerCase();
          const currentVal = mk === "hits" || mk.includes("hit") ? cs.h
            : mk === "home_runs" || mk === "hr" ? cs.hr
            : mk === "total_bases" || mk.includes("total base") ? cs.tb
            : mk === "hrr" ? (cs.h + (cs as any).r + cs.rbi)
            : cs.h;
          const alreadyOver = currentVal >= lineNum && lineNum > 0;
          const edgeHit = (side === "OVER" || side === "YES") && alreadyOver;
          return (
            <div className={`flex items-center gap-3 py-1.5 px-2 rounded-lg border ${
              edgeHit
                ? "bg-green-500/10 border-green-500/30"
                : alreadyOver
                  ? "bg-yellow-500/10 border-yellow-500/30"
                  : "bg-secondary/40 border-border/30"
            }`}>
              <span className={`text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
                edgeHit ? "text-green-400" : "text-muted-foreground"
              }`}>{edgeHit ? "HIT" : "Today"}</span>
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className={`font-semibold ${alreadyOver ? "text-green-400" : "text-foreground"}`}>
                  {cs.ab > 0 ? `${cs.h}-${cs.ab}` : "0 AB"}
                </span>
                {cs.hr > 0 && <span className="text-orange-400 font-bold">{cs.hr} HR</span>}
                {cs.rbi > 0 && <span className="text-muted-foreground">{cs.rbi} RBI</span>}
                {cs.bb > 0 && <span className="text-muted-foreground">{cs.bb} BB</span>}
                {cs.k > 0 && <span className="text-red-400">{cs.k} K</span>}
                {cs.tb > 0 && <span className="text-muted-foreground">{cs.tb} TB</span>}
              </div>
            </div>
          );
        })()}

        {lastABContact && sport === "MLB" && (lastABContact.exitVelo || lastABContact.launchAngle || lastABContact.barrelPct) && (
          <div className="flex items-center gap-3 py-1.5 px-2 rounded-lg bg-secondary/30 border border-border/20">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider shrink-0">Last AB</span>
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              {lastABContact.exitVelo != null && (
                <span className={lastABContact.exitVelo >= 95 ? "text-green-400 font-bold" : lastABContact.exitVelo >= 88 ? "text-yellow-400" : "text-muted-foreground"}>
                  {lastABContact.exitVelo.toFixed(0)} mph
                </span>
              )}
              {lastABContact.launchAngle != null && (
                <span className={lastABContact.launchAngle >= 10 && lastABContact.launchAngle <= 30 ? "text-green-400" : "text-muted-foreground"}>
                  {lastABContact.launchAngle.toFixed(0)}° LA
                </span>
              )}
              {lastABContact.barrelPct != null && lastABContact.barrelPct > 0 && (
                <span className={lastABContact.barrelPct >= 10 ? "text-green-400" : "text-muted-foreground"}>
                  {lastABContact.barrelPct.toFixed(0)}% Barrel
                </span>
              )}
              {lastABContact.hardHitPct != null && lastABContact.hardHitPct > 0 && (
                <span className={lastABContact.hardHitPct >= 40 ? "text-green-400" : "text-muted-foreground"}>
                  {lastABContact.hardHitPct.toFixed(0)}% HH
                </span>
              )}
              {lastABContact.outcome && (
                <span className={lastABContact.outcome === "hit" ? "text-green-400 font-bold" : lastABContact.outcome === "strikeout" ? "text-red-400" : "text-muted-foreground"}>
                  {lastABContact.outcome === "hit" ? "HIT" : lastABContact.outcome === "strikeout" ? "K" : lastABContact.outcome.toUpperCase()}
                </span>
              )}
            </div>
          </div>
        )}

        {summary && (
          <p className="text-[11px] text-muted-foreground leading-snug">{summary}</p>
        )}

        {detailSlot}

        {locked && (
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-center">
            <div className="text-xs font-semibold text-primary">Upgrade to unlock full analysis</div>
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-border/30 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {!locked && onAddToSlip && (
            <button
              data-testid={`button-add-slip-${sport.toLowerCase()}-${playerOrTeam.replace(/\s+/g, "-").toLowerCase()}`}
              onClick={(e) => { e.stopPropagation(); onAddToSlip(); console.log(`[NBA_CLICK_FLOW] addToSlip player=${playerOrTeam} market=${marketKey ?? marketLabel} side=${side}`); }}
              className="text-[11px] font-semibold px-3 py-1.5 min-h-[44px] rounded-lg border border-primary/30 bg-primary/10 hover:bg-primary/20 transition-colors text-primary"
            >
              + Slip
            </button>
          )}
          {!locked && (
            <>
              <ShareSignalButton
                data={{ sport, playerOrTeam, marketLabel, side, line: typeof line === "number" ? line : undefined, probability, edge }}
              />
              <CopyBetButton
                data={{ playerOrTeam, side, marketLabel, line: typeof line === "number" ? line : undefined, probability, edge }}
              />
              <button
                data-testid={`button-tweet-${sport.toLowerCase()}-${playerOrTeam.replace(/\s+/g, "-").toLowerCase()}`}
                className="text-[11px] px-2.5 py-1 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-colors text-blue-400 hover:text-blue-300 font-semibold"
                onClick={() => {
                  const tweetLines = [
                    `🔒 ${playerOrTeam}`,
                    `${side} ${marketLabel}${typeof line === "number" ? ` ${line}` : ""}`,
                    `${Math.round(probability)}% prob · ${edge > 0 ? "+" : ""}${edge.toFixed(1)}% edge`,
                    ...(projection != null ? [`Proj: ${typeof projection === "number" ? projection.toFixed(1) : projection}`] : []),
                    ...(matchup ? [matchup] : []),
                    "",
                    "Powered by @LiveLocks_",
                  ];
                  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetLines.join("\n"))}`;
                  window.open(url, "_blank", "noopener,noreferrer,width=550,height=420");
                }}
              >
                𝕏 Tweet
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {footerSlot}
          {onPrimaryAction && !locked && (
            <button
              data-testid="button-view-details"
              onClick={onPrimaryAction}
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              View Details
            </button>
          )}
          {locked && (
            <a
              href="/upgrade"
              data-testid="link-upgrade-signal"
              className="text-[11px] font-medium px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Upgrade
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
