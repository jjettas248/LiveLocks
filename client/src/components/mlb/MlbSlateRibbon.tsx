// MLB Slate Ribbon — premium at-a-glance game-triage strip.
//
// Renders one chip per today's game with a signal-grade color tier + best-edge
// badge. The grade is a READ-ONLY aggregation over server-stamped signals
// (deriveMlbRibbonChipSignal) — it never re-derives displaySide / probability /
// grade / isBettable. Selecting a chip filters the active surface (HR Radar /
// Pre-Game Power) to that game; the leading "All games" pill clears the filter.

import { useEffect, useState } from "react";
import {
  normalizeMlbGameChip,
  deriveMlbRibbonChipSignal,
  COLOR_TIER_STYLES,
  type GameLike,
  type MlbRibbonTone,
} from "@/lib/mlb/mlbNormalizers";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { Radio } from "lucide-react";

// Base/out state is greyed out once the server game-state snapshot is older
// than this — the orchestrator polls every ~10s, so >60s means it's frozen.
const GAME_STATE_STALE_MS = 60_000;
// "Updated Ns ago" turns amber after 3 missed 15s polls.
const RIBBON_UPDATED_WARN_MS = 45_000;

// Local tone → Tailwind classes (mirror of HR Radar's HR_BADGE_TONE_CLASS, kept
// inline so the ribbon stays self-contained and does not import across the
// HrRadarLadder boundary).
const RIBBON_TONE_CLASS: Record<MlbRibbonTone, string> = {
  fire: "bg-red-500/15 text-red-400 border-red-500/30",
  warn: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  info: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

interface MlbSlateRibbonProps {
  games: GameLike[];
  signals: MlbSignalData[];
  selectedGameId: string | null;
  onSelectGame: (id: string | null) => void;
  dataUpdatedAt?: number;
}

function LiveDot() {
  return <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block animate-pulse" />;
}

function MlbSlateRibbonChip({
  game,
  signals,
  isSelected,
  onSelect,
}: {
  game: GameLike;
  signals: MlbSignalData[];
  isSelected: boolean;
  onSelect: () => void;
}) {
  const chip = normalizeMlbGameChip(game);
  const sig = deriveMlbRibbonChipSignal(signals, chip.gameId);
  const tierStyle = COLOR_TIER_STYLES[sig.colorTier];
  const statusText = chip.isLive ? chip.displayInning : chip.displayStatus;

  return (
    <button
      type="button"
      data-testid={`mlb-ribbon-chip-${chip.gameId}`}
      onClick={onSelect}
      className={`relative shrink-0 flex flex-col gap-0.5 px-2.5 py-1.5 rounded-lg border text-xs min-w-[128px] max-w-[152px] transition-all text-left ${
        isSelected
          ? "border-primary bg-primary/10 ring-1 ring-primary shadow-[0_0_16px_-3px_hsl(var(--primary)/0.4)]"
          : "bg-secondary/40 hover:bg-secondary/70 hover:shadow-[0_0_14px_-3px_hsl(var(--primary)/0.25)]"
      }`}
      style={
        isSelected
          ? undefined
          : { borderColor: sig.colorTier === "neutral" ? "hsl(var(--border))" : tierStyle.border, borderLeftWidth: 3 }
      }
    >
      {sig.badge && (
        <span
          data-testid={`mlb-ribbon-badge-${chip.gameId}`}
          className={`absolute -top-1.5 right-2 text-[9px] font-black px-1.5 py-0.5 rounded-full border whitespace-nowrap ${RIBBON_TONE_CLASS[sig.badge.tone]}`}
        >
          {sig.badge.label}
        </span>
      )}

      <div className="flex items-center justify-between w-full gap-1.5">
        <span className="font-semibold text-foreground">{chip.awayTeam}</span>
        {chip.awayScore != null && chip.homeScore != null ? (
          <span className={`font-mono font-bold text-[11px] ${chip.isLive ? "text-green-400" : "text-primary"}`}>
            {chip.awayScore}-{chip.homeScore}
          </span>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground/60">@</span>
        )}
        <span className="font-semibold text-foreground">{chip.homeTeam}</span>
      </div>

      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {chip.isLive && <LiveDot />}
        {chip.isFinal && <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />}
        <span className={`whitespace-nowrap ${chip.isLive ? "text-green-400" : chip.isFinal ? "text-muted-foreground/60" : ""}`}>
          {statusText}
        </span>
        {chip.isLive && (chip.runners !== null || chip.outs !== null) && (
          <span
            data-testid={`mlb-ribbon-basestate-${chip.gameId}`}
            aria-label={baseOutAriaLabel(chip.runners, chip.outs)}
            className={`whitespace-nowrap font-mono ${
              chip.gameStateAgeMs !== null && chip.gameStateAgeMs > GAME_STATE_STALE_MS
                ? "text-muted-foreground/40"
                : "text-muted-foreground/80"
            }`}
          >
            {chip.runners && (
              <>
                {chip.runners.first ? "◆" : "◇"}
                {chip.runners.second ? "◆" : "◇"}
                {chip.runners.third ? "◆" : "◇"}
              </>
            )}
            {chip.outs !== null && <> {chip.outs}o</>}
          </span>
        )}
        {sig.signalCount > 0 && (
          <span className="ml-auto font-semibold text-muted-foreground/80" data-testid={`mlb-ribbon-count-${chip.gameId}`}>
            {sig.signalCount} sig
          </span>
        )}
      </div>
    </button>
  );
}

function baseOutAriaLabel(
  runners: { first: boolean; second: boolean; third: boolean } | null,
  outs: number | null,
): string {
  const parts: string[] = [];
  if (runners) {
    const occupied = [runners.first && "first", runners.second && "second", runners.third && "third"].filter(Boolean);
    parts.push(occupied.length > 0 ? `runners on ${occupied.join(", ")}` : "bases empty");
  }
  if (outs !== null) parts.push(`${outs} out${outs === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function MlbSlateRibbon({ games, signals, selectedGameId, onSelectGame, dataUpdatedAt }: MlbSlateRibbonProps) {
  // "Updated Ns ago" depends on Date.now(), so tick a slow local clock to
  // drive re-renders (same renderer-only pattern as MlbSignalCard). Inactive
  // when the caller doesn't supply dataUpdatedAt.
  const hasUpdatedAt = typeof dataUpdatedAt === "number" && dataUpdatedAt > 0;
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!hasUpdatedAt) return;
    const id = setInterval(() => forceTick(t => (t + 1) % 1_000_000), 5_000);
    return () => clearInterval(id);
  }, [hasUpdatedAt]);
  const updatedAgoMs = hasUpdatedAt ? Math.max(0, Date.now() - dataUpdatedAt!) : null;

  if (games.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games-today">
        No MLB games scheduled today. Check back soon.
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4" data-testid="section-mlb-slate-ribbon">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
        </h2>
        <span className="text-[10px] text-muted-foreground/70" data-testid="text-mlb-ribbon-count">
          {games.length} game{games.length === 1 ? "" : "s"} &middot; scroll for more
          {updatedAgoMs !== null && (
            <span
              data-testid="text-mlb-ribbon-updated"
              className={updatedAgoMs > RIBBON_UPDATED_WARN_MS ? "text-amber-400" : ""}
            >
              {" "}&middot; updated {Math.round(updatedAgoMs / 1000)}s ago
            </span>
          )}
        </span>
      </div>

      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide -mx-1 px-1">
        <button
          type="button"
          data-testid="mlb-ribbon-clear"
          onClick={() => onSelectGame(null)}
          className={`shrink-0 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-all min-w-[72px] ${
            selectedGameId === null
              ? "border-primary bg-primary/10 text-primary ring-1 ring-primary"
              : "border-border/60 bg-secondary/40 text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
          }`}
        >
          All games
        </button>

        {games.map((game) => (
          <MlbSlateRibbonChip
            key={game.gameId}
            game={game}
            signals={signals}
            isSelected={game.gameId === selectedGameId}
            onSelect={() => onSelectGame(game.gameId === selectedGameId ? null : game.gameId)}
          />
        ))}
      </div>
    </div>
  );
}
