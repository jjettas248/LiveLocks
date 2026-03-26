import { useTopPlays, type UnifiedTopPlay } from "@/hooks/useTopPlays";
import { SportSignalCard } from "@/components/signals/SportSignalCard";
import { SignalSkeletonCard } from "@/components/signals/SignalSkeletonCard";

type TopPlaysPanelProps = {
  isElite?: boolean;
  onNavigateToSport?: (sport: string) => void;
};

export function TopPlaysPanel({ isElite, onNavigateToSport }: TopPlaysPanelProps) {
  const { data, isLoading, isError } = useTopPlays();
  const plays = data?.plays ?? [];

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="panel-top-plays-loading">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Top Plays</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SignalSkeletonCard />
          <SignalSkeletonCard />
          <SignalSkeletonCard />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-3" data-testid="panel-top-plays-error">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Top Plays</h2>
        <div className="rounded-xl border border-border/40 bg-card p-8 text-center">
          <div className="text-sm text-muted-foreground">Unable to load top plays. Retrying shortly.</div>
        </div>
      </div>
    );
  }

  if (plays.length === 0) {
    return (
      <div className="space-y-3" data-testid="panel-top-plays-empty">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Top Plays</h2>
        <div className="rounded-xl border border-border/40 bg-card p-8 text-center">
          <div className="text-sm text-muted-foreground">No live signals right now</div>
          <div className="text-xs text-muted-foreground/60 mt-1">
            Edges appear when games are live and sportsbook lines are available. Check back at game time.
          </div>
        </div>
      </div>
    );
  }

  const bestPlay = plays[0];
  const restPlays = plays.slice(1);

  return (
    <div className="space-y-3" data-testid="panel-top-plays">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Top Plays</h2>
        <span className="text-[10px] text-muted-foreground">{plays.length} play{plays.length !== 1 ? "s" : ""} across all sports</span>
      </div>

      {bestPlay && (
        <SportSignalCard
          sport={bestPlay.sport}
          playerOrTeam={bestPlay.playerOrTeam}
          marketLabel={bestPlay.marketLabel}
          side={bestPlay.side}
          line={bestPlay.line}
          projection={bestPlay.projection}
          probability={bestPlay.probability}
          edge={bestPlay.edge}
          badgeTier={bestPlay.confidenceTier}
          summary={bestPlay.summary ?? undefined}
          isBestBet
          locked={!isElite && bestPlay.sport !== "NBA"}
          onPrimaryAction={onNavigateToSport ? () => onNavigateToSport(bestPlay.routeTarget) : undefined}
        />
      )}

      {restPlays.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {restPlays.map((play) => (
            <SportSignalCard
              key={play.id}
              sport={play.sport}
              playerOrTeam={play.playerOrTeam}
              marketLabel={play.marketLabel}
              side={play.side}
              line={play.line}
              projection={play.projection}
              probability={play.probability}
              edge={play.edge}
              badgeTier={play.confidenceTier}
              summary={play.summary ?? undefined}
              locked={!isElite && play.sport !== "NBA"}
              onPrimaryAction={onNavigateToSport ? () => onNavigateToSport(play.routeTarget) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
