import { type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { type ConfidenceTier } from "./ConfidenceBadge";
import { ShareSignalButton } from "@/components/common/ShareSignalButton";
import { CopyBetButton } from "@/components/common/CopyBetButton";
import { cn } from "@/lib/utils";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { Pill } from "@/components/ui/Pill";
import { sportAccentClasses, tierBadgeClasses } from "@/lib/uiTokens";
import { VerdictHeader } from "./card/VerdictHeader";
import { EdgeMeter } from "./card/EdgeMeter";
import { WhyNowDrivers } from "./card/WhyNowDrivers";
import { LiveContextStrip } from "./card/LiveContextStrip";
import { CardActions } from "./card/CardActions";
import { type LiveContextItem } from "./card/types";

const SPORT_BADGE: Record<string, { label: string; color: string }> = {
  NBA: { label: "NBA", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  NCAAB: { label: "NCAAB", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  MLB: { label: "MLB", color: "bg-green-500/15 text-green-400 border-green-500/30" },
};

// ConfidenceTier ("ELITE"|"STRONG"|"VALUE"|"NO_EDGE") → the lowercase tier
// vocabulary tierBadgeClasses() expects, and the display label shown in the
// verdict chip (this IS the grade — the most important pixel on the card).
const TIER_GRADE: Record<ConfidenceTier, { label: string; tone: string }> = {
  ELITE: { label: "ELITE", tone: tierBadgeClasses("elite") },
  STRONG: { label: "STRONG", tone: tierBadgeClasses("strong") },
  VALUE: { label: "VALUE", tone: tierBadgeClasses("value") },
  NO_EDGE: { label: "NO EDGE", tone: tierBadgeClasses("watch") },
};

type SportSignalCardProps = {
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
  addedToSlip?: boolean;
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

// Today's-stat-line → a single LiveContextStrip item ("Today 3-5, 1 HR").
function buildStatsContext(
  cs: NonNullable<SportSignalCardProps["currentStats"]>,
  side: string,
  line: number | string | undefined,
  marketKey: string | undefined,
  marketLabel: string,
): LiveContextItem | null {
  if (cs.ab <= 0 && cs.h <= 0) return null;
  const lineNum = typeof line === "number" ? line : 0;
  const mk = marketKey?.toLowerCase() ?? marketLabel.toLowerCase();
  const currentVal = mk === "hits" || mk.includes("hit") ? cs.h
    : mk === "home_runs" || mk === "hr" ? cs.hr
    : mk === "total_bases" || mk.includes("total base") ? cs.tb
    : cs.h;
  const alreadyOver = currentVal >= lineNum && lineNum > 0;
  const edgeHit = (side === "OVER" || side === "YES") && alreadyOver;
  const extras = [
    cs.hr > 0 ? `${cs.hr} HR` : null,
    cs.rbi > 0 ? `${cs.rbi} RBI` : null,
    cs.k > 0 ? `${cs.k} K` : null,
  ].filter(Boolean).join(" · ");
  return {
    label: edgeHit ? "HIT" : "Today",
    value: `${cs.h}-${cs.ab}${extras ? ` · ${extras}` : ""}`,
    tone: edgeHit ? "good" : alreadyOver ? "default" : "default",
  };
}

function buildContactContext(
  c: NonNullable<SportSignalCardProps["lastABContact"]>,
): LiveContextItem | null {
  const parts: string[] = [];
  if (c.exitVelo != null) parts.push(`${c.exitVelo.toFixed(0)} mph`);
  if (c.launchAngle != null) parts.push(`${c.launchAngle.toFixed(0)}° LA`);
  if (c.barrelPct != null && c.barrelPct > 0) parts.push(`${c.barrelPct.toFixed(0)}% Barrel`);
  if (parts.length === 0) return null;
  const hot = (c.exitVelo ?? 0) >= 95 || (c.barrelPct ?? 0) >= 10;
  return { label: "Last AB", value: parts.join(" · "), tone: hot ? "good" : "default" };
}

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
  addedToSlip,
  footerSlot,
  detailSlot,
  market: marketKey,
  currentStats,
  lastABContact,
  matchup,
}: SportSignalCardProps) {
  const sportBadge = SPORT_BADGE[sport] ?? SPORT_BADGE.NBA;
  const grade = TIER_GRADE[badgeTier];
  const rankStyle = rank != null ? RANK_STYLES[rank] : undefined;

  const contextItems: LiveContextItem[] = [];
  if (currentStats) {
    const item = buildStatsContext(currentStats, side, line, marketKey, marketLabel);
    if (item) contextItems.push(item);
  }
  if (lastABContact && sport === "MLB") {
    const item = buildContactContext(lastABContact);
    if (item) contextItems.push(item);
  }
  if (projection != null && sport !== "MLB") {
    contextItems.push({
      label: "Proj",
      value: typeof projection === "number" ? projection.toFixed(1) : String(projection),
    });
  }

  return (
    <SurfaceCard
      variant={rankStyle || isBestBet ? "elevated" : "default"}
      data-testid={`card-signal-${sport.toLowerCase()}-${playerOrTeam.replace(/\s+/g, "-").toLowerCase()}`}
      className={cn(
        "overflow-hidden",
        !locked && "hover-elevate",
        rankStyle
          ? `${rankStyle.border} shadow-[0_0_20px_rgba(234,179,8,0.08)]`
          : isBestBet
            ? "border-primary/40 ring-1 ring-primary/20 shadow-[0_0_16px_rgba(34,197,94,0.1)]"
            : "hover:border-border/60",
        locked && "opacity-60",
      )}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {rankStyle && (
            <Pill tone="custom" className={cn(rankStyle.bg, rankStyle.text, rankStyle.border.split(" ")[0])} data-testid={`badge-rank-${rank}`}>
              {rankStyle.label}
            </Pill>
          )}
          {isFlagship && (
            <Pill tone="custom" className="bg-purple-500/15 text-purple-400 border-purple-500/30" data-testid="badge-flagship">
              Flagship
            </Pill>
          )}
          {isBestBet && !rankStyle && <Pill tone="premium">Best Bet</Pill>}
          {signalScore != null && (
            <span className={`text-micro font-bold tabular-nums ml-auto ${SIGNAL_SCORE_COLOR(signalScore)}`} data-testid="text-signal-score">
              SS {Math.round(signalScore)}
            </span>
          )}
        </div>

        <VerdictHeader
          subject={playerOrTeam}
          betLine={`${side} ${marketLabel}${line != null ? ` ${line}` : ""}`}
          grade={grade.label}
          gradeToneClass={grade.tone}
          sportBadge={{ label: sportBadge.label, className: sportAccentClasses(sport.toLowerCase()) }}
          urgencyLabel={timingContext ?? null}
          freshnessLabel={matchup ?? timestampLabel ?? null}
        />

        <EdgeMeter modelPct={probability} edgePct={edge} />

        <WhyNowDrivers headline={summary} />

        <LiveContextStrip items={contextItems} />

        {detailSlot}

        {locked && (
          <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-center">
            <div className="text-xs font-semibold text-primary">Upgrade to unlock full analysis</div>
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-border/30">
        <CardActions
          primaryLabel={locked ? "Upgrade" : "View Details"}
          onPrimary={locked ? () => { window.location.href = "/upgrade"; } : onPrimaryAction}
          isUrgent={isBestBet}
          trailingSlot={footerSlot}
        >
          {!locked && onAddToSlip && (
            <button
              data-testid={`button-add-slip-${sport.toLowerCase()}-${playerOrTeam.replace(/\s+/g, "-").toLowerCase()}`}
              onClick={(e) => {
                e.stopPropagation();
                if (addedToSlip) return;
                onAddToSlip();
                console.log(`[NBA_CLICK_FLOW] addToSlip player=${playerOrTeam} market=${marketKey ?? marketLabel} side=${side}`);
              }}
              disabled={addedToSlip}
              aria-pressed={addedToSlip ? true : undefined}
              className={`text-[11px] font-semibold px-3 py-1.5 min-h-[44px] rounded-lg border transition-colors inline-flex items-center gap-1 ${
                addedToSlip
                  ? "border-green-500/40 bg-green-500/15 text-green-400 cursor-default"
                  : "border-primary/30 bg-primary/10 hover:bg-primary/20 text-primary"
              }`}
            >
              {addedToSlip ? (
                <>
                  <Check className="w-3 h-3" /> On Slip
                </>
              ) : (
                <>
                  <Plus className="w-3 h-3" /> Slip
                </>
              )}
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
                    ...(projection != null && sport !== "MLB" ? [`Proj: ${typeof projection === "number" ? projection.toFixed(1) : projection}`] : []),
                    ...(matchup ? [matchup] : []),
                    "",
                    "Powered by @LiveLocks_",
                  ];
                  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetLines.join("\n"))}`;
                  window.open(url, "_blank", "noopener,noreferrer,width=550,height=420");
                }}
              >
                <svg viewBox="0 0 24 24" className="w-3 h-3 fill-current" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Tweet
              </button>
            </>
          )}
        </CardActions>
      </div>
    </SurfaceCard>
  );
}
