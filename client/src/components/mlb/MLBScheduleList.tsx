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
  hasOdds?: boolean;
  signalLocked?: boolean;
};

type MLBScheduleListProps = {
  games: MLBScheduleGame[];
  selectedGameId: string | null;
  onSelectGame: (gameId: string) => void;
};

type GameRenderState = "INVALID" | "PREVIEW" | "NO_SIGNAL" | "SIGNAL";

function resolveGameRenderState(game: MLBScheduleGame): GameRenderState {
  const hasValidTeams = !!(game.awayTeam && game.homeTeam);

  if (!hasValidTeams) return "INVALID";

  if (!game.hasOdds) return "PREVIEW";

  if (game.signalLocked) return "SIGNAL";

  return "NO_SIGNAL";
}

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
  const safeGames = Array.isArray(games) ? games : [];
  const renderedGames = safeGames.filter((g) => g && g.gameId && resolveGameRenderState(g) !== "INVALID");

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-sm font-semibold text-foreground">Today's Games</span>
      </div>
      {renderedGames.length === 0 && (
        <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games">
          No games scheduled today. Check back soon.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {renderedGames.map((game) => {
          if (!game || !game.gameId) return null;
          const renderState = resolveGameRenderState(game);
          if (renderState === "INVALID") return null;

          const isActive = game.gameId === selectedGameId;
          const startTimeFormatted = formatStartTime(game.startTime);

          const awayAbbr = game.awayAbbr!;
          const homeAbbr = game.homeAbbr!;

          const pitcherAway = game.pitcherAway && game.pitcherAway.trim() ? game.pitcherAway : null;
          const pitcherHome = game.pitcherHome && game.pitcherHome.trim() ? game.pitcherHome : null;
          const showPitcherPill = !!(pitcherAway && pitcherHome);
          const awayLastName = pitcherAway ? pitcherAway.split(" ").pop() : null;
          const homeLastName = pitcherHome ? pitcherHome.split(" ").pop() : null;

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
                  {awayAbbr} vs {homeAbbr}
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

              {showPitcherPill && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-secondary/60 text-muted-foreground border border-border/30 truncate max-w-[90px]">
                  {awayLastName} vs {homeLastName}
                </span>
              )}

              {renderState === "PREVIEW" && (
                <span className="text-[9px] text-muted-foreground/60 mt-0.5">Awaiting live lines</span>
              )}
              {renderState === "NO_SIGNAL" && (
                <span className="text-[9px] text-muted-foreground/60 mt-0.5">No strong edge</span>
              )}
              {renderState === "SIGNAL" && (
                <span className="text-[9px] font-semibold text-primary mt-0.5">Edge detected</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
});
