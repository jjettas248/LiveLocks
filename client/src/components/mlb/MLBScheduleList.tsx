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
  venue?: string | null;
  pitcherAway?: string | null;
  pitcherHome?: string | null;
  hasOdds?: boolean;
  signalLocked?: boolean;
  signalCount?: number;
  gameCardTags?: string[];
  weather?: {
    temperature: number | null;
    windSpeed: number | null;
    windDirection: string | null;
    humidity: number | null;
  } | null;
  pitcherContext?: {
    pitchCount: number;
    timesThroughOrder: number;
    avgVelocity: number | null;
    velocityDrop: number | null;
  } | null;
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
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch {
    return null;
  }
}

function lastName(name: string | null | undefined): string {
  if (!name) return "TBD";
  const trimmed = name.trim();
  return trimmed.split(" ").pop() || trimmed;
}

function tagStyle(tag: string): string {
  switch (tag) {
    case "LIVE SIGNALS": return "bg-primary/15 text-primary";
    case "HOT BATS": return "bg-green-500/15 text-green-400";
    case "PITCHER ATTACKABLE": return "bg-red-500/15 text-red-400";
    case "HR WATCH": return "bg-orange-500/15 text-orange-400";
    default: return "bg-muted/30 text-muted-foreground";
  }
}

export const MLBScheduleList = memo(function MLBScheduleList({ games, selectedGameId, onSelectGame }: MLBScheduleListProps) {
  const safeGames = Array.isArray(games) ? games : [];
  const renderedGames = safeGames.filter((g) => g && g.gameId && (g.awayTeam || g.homeTeam));

  const isCompact = selectedGameId !== null;

  if (renderedGames.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games">
        No games scheduled today. Check back soon.
      </div>
    );
  }

  if (isCompact) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin">
        {renderedGames.map((game) => {
          if (!game?.gameId) return null;
          const isActive = game.gameId === selectedGameId;
          return (
            <button
              key={game.gameId}
              data-testid={`chip-mlb-schedule-${game.gameId}`}
              onClick={() => onSelectGame(game.gameId)}
              className={`flex-shrink-0 px-3 py-3 min-h-[44px] rounded-lg border text-left transition-all flex items-center gap-2 ${
                isActive
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border/40 hover:border-primary/30 hover:bg-card/80"
              }`}
            >
              <span className="text-xs font-bold text-foreground whitespace-nowrap">
                {game.awayAbbr ?? ""} @ {game.homeAbbr ?? ""}
              </span>
              {game.status === "live" && game.awayScore != null && game.homeScore != null ? (
                <span className="text-[10px] font-mono font-bold text-foreground whitespace-nowrap">
                  {game.awayScore}–{game.homeScore}
                  {game.inning > 0 && <span className="text-green-400 ml-1">{game.isTopInning ? "▲" : "▼"}{game.inning}</span>}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{formatStartTime(game.startTime) ?? "TBD"}</span>
              )}
              {game.signalLocked && <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {renderedGames.map((game) => {
        if (!game?.gameId) return null;
        const isActive = game.gameId === selectedGameId;
        const startTimeFormatted = formatStartTime(game.startTime);
        const awayAbbr = game.awayAbbr ?? "";
        const homeAbbr = game.homeAbbr ?? "";
        const tags = game.gameCardTags ?? [];
        const topTag = tags[0] ?? null;

        return (
          <button
            key={game.gameId}
            data-testid={`chip-mlb-schedule-${game.gameId}`}
            onClick={() => onSelectGame(game.gameId)}
            className={`w-full flex items-center gap-3 px-4 py-3 min-h-[44px] rounded-lg border text-left transition-all ${
              isActive
                ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                : "border-border/30 hover:border-primary/30 hover:bg-card/80"
            }`}
          >
            <div className="flex items-center gap-1 min-w-0 shrink-0" style={{ width: "100px" }}>
              <div className="text-xs font-bold text-foreground">{awayAbbr}</div>
              {game.status === "live" && game.awayScore != null && game.homeScore != null ? (
                <span className="text-[11px] font-mono font-bold text-foreground mx-1">
                  {game.awayScore}–{game.homeScore}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground mx-1">vs</span>
              )}
              <div className="text-xs font-bold text-foreground">{homeAbbr}</div>
            </div>

            {game.status === "live" && game.inning > 0 ? (
              <span className="text-[10px] font-bold text-green-400 shrink-0 w-8 text-center">
                {game.isTopInning ? "▲" : "▼"}{game.inning}
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground shrink-0 w-12 text-center">
                {startTimeFormatted ?? "TBD"}
              </span>
            )}

            <div className="text-[10px] text-muted-foreground truncate min-w-0 flex-1 hidden sm:block">
              {lastName(game.pitcherAway)} vs {lastName(game.pitcherHome)}
            </div>

            <div className="flex items-center gap-1.5 shrink-0 ml-auto">
              {topTag && (
                <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${tagStyle(topTag)}`}>
                  {topTag}
                </span>
              )}
              {game.signalLocked ? (
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400" data-testid={`signal-count-${game.gameId}`}>
                  {game.signalCount ?? 0}
                </span>
              ) : game.status === "live" ? (
                <span className="relative flex h-2 w-2" title="Monitoring">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
                </span>
              ) : (
                <span className="text-[9px] text-muted-foreground/50">PRE</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
});
