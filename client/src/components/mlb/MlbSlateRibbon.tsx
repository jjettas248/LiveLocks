// MLB Slate Ribbon — premium at-a-glance game-triage strip.
//
// Renders one chip per today's game with a signal-grade color tier + best-edge
// badge. The grade is a READ-ONLY aggregation over server-stamped signals
// (deriveMlbRibbonChipSignal) — it never re-derives displaySide / probability /
// grade / isBettable. Selecting a chip filters the active surface (HR Radar /
// Pre-Game Power) to that game; the leading "All games" pill clears the filter.

import {
  normalizeMlbGameChip,
  deriveMlbRibbonChipSignal,
  COLOR_TIER_STYLES,
  type GameLike,
  type MlbRibbonTone,
} from "@/lib/mlb/mlbNormalizers";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import { Radio } from "lucide-react";

// Local tone → Tailwind classes (mirror of HR Radar's HR_BADGE_TONE_CLASS, kept
// inline so the ribbon stays self-contained and does not import across the
// HrRadarLadder boundary).
const RIBBON_TONE_CLASS: Record<MlbRibbonTone, string> = {
  fire: "bg-red-500/15 text-red-400 border-red-500/30",
  warn: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  info: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

export interface MlbSlateRibbonProps {
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
      className={`relative shrink-0 flex flex-col gap-1 px-3 py-2 rounded-lg border text-xs min-w-[160px] max-w-[200px] transition-all text-left ${
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

      <div className="flex items-center justify-between w-full gap-2">
        <span className="font-semibold text-foreground">{chip.awayTeam}</span>
        <span className={`font-mono font-bold ${chip.isLive ? "text-green-400" : "text-primary"}`}>
          {chip.awayScore ?? 0} – {chip.homeScore ?? 0}
        </span>
        <span className="font-semibold text-foreground">{chip.homeTeam}</span>
      </div>

      <div className="flex items-center gap-1.5 text-muted-foreground">
        {chip.isLive && <LiveDot />}
        {chip.isFinal && <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />}
        <span className={chip.isLive ? "text-green-400" : chip.isFinal ? "text-muted-foreground/60" : ""}>
          {statusText}
        </span>
        {sig.signalCount > 0 && (
          <span className="ml-auto text-[10px] font-semibold text-muted-foreground/80" data-testid={`mlb-ribbon-count-${chip.gameId}`}>
            {sig.signalCount} sig
          </span>
        )}
      </div>
    </button>
  );
}

export function MlbSlateRibbon({ games, signals, selectedGameId, onSelectGame }: MlbSlateRibbonProps) {
  if (games.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games-today">
        No MLB games scheduled today. Check back soon.
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4" data-testid="section-mlb-slate-ribbon">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
        </h2>
      </div>

      <div className="flex gap-2 overflow-x-auto sm:flex-wrap scrollbar-hide -mx-1 px-1">
        <button
          type="button"
          data-testid="mlb-ribbon-clear"
          onClick={() => onSelectGame(null)}
          className={`shrink-0 px-3 py-2 rounded-lg border text-xs font-semibold transition-all min-w-[88px] ${
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

export default MlbSlateRibbon;
