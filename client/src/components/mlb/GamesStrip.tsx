import { Radio, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SurfaceCard } from "@/components/ui/SurfaceCard";
import { LiveIndicator } from "@/components/common/LiveIndicator";

export type StripGame = {
  id: string;
  status: string;
  awayScore: number | string;
  homeScore: number | string;
  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  period: number;
  clock?: string;
  startTime?: string | null;
};

export interface GamesStripProps {
  games: StripGame[];
  selectedGameId?: string;
  onRefresh: () => void;
  /** Toggle selection for a game (select if new, deselect if already selected). */
  onToggleGame: (game: StripGame) => void;
}

/**
 * Today's Games chip rail. Extracted from dashboard.tsx and re-skinned with the
 * premium surface treatment; selection/form behavior stays in the parent via
 * onToggleGame. Horizontal-friendly, consistent chip sizing, obvious live state.
 */
export function GamesStrip({ games, selectedGameId, onRefresh, onToggleGame }: GamesStripProps) {
  return (
    <SurfaceCard variant="elevated" className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-label flex items-center gap-2">
          <Radio className="w-3.5 h-3.5 text-green-500" /> Today's Games
        </h2>
        <button
          onClick={onRefresh}
          className="text-muted-foreground flex items-center gap-1 text-micro hover:text-foreground transition-colors"
          data-testid="button-refresh-games"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <div className="flex gap-2 flex-wrap">
        {games.map((game) => {
          const isLive =
            game.status !== "Scheduled" && game.status !== "Pre-Game" && game.status !== "Final";
          const isFinal = game.status === "Final";
          const isScheduled = game.status === "Scheduled" || game.status === "Pre-Game";
          const isSelected = game.id === selectedGameId;
          const tipoffTime = game.startTime
            ? new Date(game.startTime).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })
            : null;

          return (
            <button
              key={game.id}
              data-testid={`button-game-${game.id}`}
              onClick={() => onToggleGame(game)}
              className={cn(
                "flex flex-col items-center px-3.5 py-2.5 rounded-xl border text-xs min-w-[132px] transition-all",
                isSelected
                  ? "border-primary bg-primary/10 ring-1 ring-primary shadow-[0_0_16px_-3px_hsl(var(--primary)/0.4)]"
                  : "border-surface-border bg-surface-1 hover:bg-surface-3 hover:shadow-[0_0_14px_-3px_hsl(var(--primary)/0.25)]",
              )}
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="font-semibold text-foreground">{game.awayTeamAbbr}</span>
                <span className="font-mono text-primary font-bold">
                  {game.awayScore} – {game.homeScore}
                </span>
                <span className="font-semibold text-foreground">{game.homeTeamAbbr}</span>
              </div>
              <div className="flex items-center gap-1 text-muted-foreground mt-1">
                {isLive && <LiveIndicator />}
                {isFinal && (
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 inline-block" />
                )}
                <span
                  className={cn(
                    "text-micro",
                    isLive ? "text-green-400" : isFinal ? "text-muted-foreground/60" : "",
                  )}
                >
                  {isLive
                    ? `Q${game.period} ${game.clock}`
                    : isScheduled && tipoffTime
                    ? tipoffTime
                    : game.status}
                </span>
                {isSelected && <span className="text-primary font-medium ml-1">●</span>}
              </div>
            </button>
          );
        })}
      </div>
    </SurfaceCard>
  );
}
