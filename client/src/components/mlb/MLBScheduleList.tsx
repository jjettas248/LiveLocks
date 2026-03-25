import { memo } from "react";

type MLBScheduleGame = {
  gameId: string;
  homeTeam: string | null;
  awayTeam: string | null;
  awayAbbr: string | null;
  homeAbbr: string | null;
  homeScore: number | null;
  awayScore: number | null;
  inning: number;
  isTopInning: boolean;
  status: "live" | "pregame" | null;
  startTime?: string | null;
  pitcherAway?: string | null;
  pitcherHome?: string | null;
};

type MLBScheduleListProps = {
  games: MLBScheduleGame[];
  selectedGameId: string | null;
  onSelectGame: (gameId: string) => void;
};

function formatStartTime(startTime: string | null | undefined): string | null {
  if (!startTime) return null;
  try {
    const date = new Date(startTime);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch {
    return null;
  }
}

export const MLBScheduleList = memo(function MLBScheduleList({ games, selectedGameId, onSelectGame }: MLBScheduleListProps) {
  const validGames = games.filter(
    (g) => g.homeTeam && g.awayTeam && g.startTime
  );

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold text-foreground">Today's Games</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {validGames.map((game) => {
          if (!game.awayAbbr || !game.homeAbbr) return null;
          if (game.awayAbbr.length < 2 || game.homeAbbr.length < 2) return null;

          const isActive = game.gameId === selectedGameId;
          const pitcherAway = game.pitcherAway;
          const pitcherHome = game.pitcherHome;
          const awayLastName = pitcherAway ? pitcherAway.split(" ").pop() : null;
          const homeLastName = pitcherHome ? pitcherHome.split(" ").pop() : null;
          const startTimeFormatted = formatStartTime(game.startTime);

          return (
            <button
              key={game.gameId}
              data-testid={`chip-mlb-schedule-${game.gameId}`}
              onClick={() => onSelectGame(game.gameId)}
              className={`p-3 rounded-xl border text-left transition-all flex flex-col gap-1 ${
                isActive
                  ? "border-primary bg-primary/10"
                  : "border-white/10 hover:border-white/20 hover:bg-white/5"
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-bold text-foreground">
                  {game.awayAbbr} @ {game.homeAbbr}
                </span>
                {game.status === "live" ? (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">LIVE</span>
                ) : (
                  <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">PRE</span>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                {game.status === "live" && game.awayScore != null && game.homeScore != null && (
                  <span>{game.awayScore} – {game.homeScore}</span>
                )}
                {game.status === "live" && game.inning > 0 && (
                  <span className="text-green-400 font-semibold">
                    {game.isTopInning ? "▲" : "▼"}{game.inning}
                  </span>
                )}
                {game.status !== "live" && startTimeFormatted && (
                  <span data-testid={`text-mlb-start-time-${game.gameId}`}>{startTimeFormatted}</span>
                )}
              </div>

              {awayLastName && homeLastName && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground border border-border/30 truncate max-w-[90px]">
                  {awayLastName} vs {homeLastName}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
