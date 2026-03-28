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
  return "text-muted-foreground";
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
  onPrimaryAction?: () => void;
  onShare?: () => void;
  onCopy?: () => void;
  footerSlot?: ReactNode;
  detailSlot?: ReactNode;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  matchup?: string;
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
  onPrimaryAction,
  footerSlot,
  detailSlot,
  currentStats,
  matchup,
}: SportSignalCardProps) {
  const sportBadge = SPORT_BADGE[sport] ?? SPORT_BADGE.NBA;
  const probWhole = Math.round(probability);
  const edgeStr = edge > 0 ? `+${edge.toFixed(1)}%` : `${edge.toFixed(1)}%`;

  return (
    <div
      data-testid={`card-signal-${sport.toLowerCase()}-${playerOrTeam.replace(/\s+/g, "-").toLowerCase()}`}
      className={`rounded-xl border bg-card overflow-hidden transition-all ${
        isBestBet
          ? "border-primary/40 ring-1 ring-primary/20 shadow-[0_0_16px_rgba(34,197,94,0.1)]"
          : "border-border/40 hover:border-border/60"
      } ${locked ? "opacity-60" : ""}`}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${sportBadge.color}`}>
              {sportBadge.label}
            </span>
            <ConfidenceBadge tier={badgeTier} />
            {isBestBet && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30 shrink-0">
                Best Bet
              </span>
            )}
          </div>
          {timestampLabel && (
            <span className="text-[10px] text-muted-foreground/60 shrink-0">{timestampLabel}</span>
          )}
        </div>

        <div>
          <div className="text-sm font-bold text-foreground leading-tight">{playerOrTeam}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-xs font-bold ${edge >= 5 ? EDGE_COLOR(edge) : "text-foreground"}`}>{side}</span>
            <span className="text-xs text-muted-foreground">{marketLabel}</span>
            {line != null && <span className="text-xs font-semibold text-foreground">{line}</span>}
          </div>
        </div>

        <div className="flex items-baseline gap-4">
          <div>
            <div className="text-[10px] text-muted-foreground">Prob</div>
            <div className={`text-xl font-bold ${EDGE_COLOR(edge)}`}>{probWhole}%</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">Edge</div>
            <div className={`text-xl font-bold ${EDGE_COLOR(edge)}`}>{edgeStr}</div>
          </div>
          {projection != null && (
            <div>
              <div className="text-[10px] text-muted-foreground">Proj</div>
              <div className="text-xl font-bold text-foreground">{typeof projection === "number" ? projection.toFixed(1) : projection}</div>
            </div>
          )}
        </div>

        {currentStats && (
          <div className="flex items-center gap-3 py-1.5 px-2 rounded-lg bg-secondary/40 border border-border/30">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider shrink-0">Today</span>
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              <span className="text-foreground font-semibold">{currentStats.ab > 0 ? `${currentStats.h}-${currentStats.ab}` : "0 AB"}</span>
              {currentStats.hr > 0 && <span className="text-orange-400 font-bold">{currentStats.hr} HR</span>}
              {currentStats.rbi > 0 && <span className="text-muted-foreground">{currentStats.rbi} RBI</span>}
              {currentStats.bb > 0 && <span className="text-muted-foreground">{currentStats.bb} BB</span>}
              {currentStats.k > 0 && <span className="text-muted-foreground">{currentStats.k} K</span>}
              {currentStats.tb > 0 && <span className="text-muted-foreground">{currentStats.tb} TB</span>}
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
