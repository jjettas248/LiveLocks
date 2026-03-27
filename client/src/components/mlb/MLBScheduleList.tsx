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

function pitcherHeatEmoji(ctx: MLBScheduleGame["pitcherContext"]): string {
  if (!ctx) return "";
  if (ctx.velocityDrop && ctx.velocityDrop >= 3) return "🥶";
  if (ctx.timesThroughOrder >= 3 || ctx.pitchCount >= 85) return "❄️";
  if (ctx.pitchCount <= 30) return "🔥";
  return "🟡";
}

function gameTagStyle(tag: string): string {
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

  return (
    <div>
      {renderedGames.length === 0 && (
        <div className="text-xs text-muted-foreground py-3" data-testid="text-no-mlb-games">
          No games scheduled today. Check back soon.
        </div>
      )}
      <div className={isCompact
        ? "flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 scrollbar-thin"
        : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      }>
        {renderedGames.map((game) => {
          if (!game || !game.gameId) return null;
          const isActive = game.gameId === selectedGameId;
          const startTimeFormatted = formatStartTime(game.startTime);
          const awayAbbr = game.awayAbbr ?? "";
          const homeAbbr = game.homeAbbr ?? "";
          const pitcherAway = game.pitcherAway?.trim() || null;
          const pitcherHome = game.pitcherHome?.trim() || null;
          const awayLast = pitcherAway ? pitcherAway.split(" ").pop() : (game.status === "live" ? "Resolving" : "Pending");
          const homeLast = pitcherHome ? pitcherHome.split(" ").pop() : (game.status === "live" ? "Resolving" : "Pending");
          const heat = pitcherHeatEmoji(game.pitcherContext);

          const weatherLine = game.weather?.temperature != null
            ? `${game.weather.temperature}°${game.weather.windSpeed != null && game.weather.windDirection ? ` | Wind ${game.weather.windDirection} ${game.weather.windSpeed}mph` : ""}`
            : null;

          if (isCompact) {
            return (
              <button
                key={game.gameId}
                data-testid={`chip-mlb-schedule-${game.gameId}`}
                onClick={() => onSelectGame(game.gameId)}
                className={`flex-shrink-0 px-3 py-2 rounded-lg border text-left transition-all flex items-center gap-2 ${
                  isActive
                    ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                    : "border-border/40 hover:border-primary/30 hover:bg-card/80"
                }`}
              >
                <span className="text-xs font-bold text-foreground whitespace-nowrap">
                  {awayAbbr} @ {homeAbbr}
                </span>
                {game.status === "live" && game.awayScore != null && game.homeScore != null ? (
                  <span className="text-[10px] font-mono font-bold text-foreground whitespace-nowrap">
                    {game.awayScore}–{game.homeScore}
                    {game.inning > 0 && <span className="text-green-400 ml-1">{game.isTopInning ? "▲" : "▼"}{game.inning}</span>}
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">{startTimeFormatted ?? "TBD"}</span>
                )}
                {game.signalLocked && <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />}
              </button>
            );
          }

          return (
            <button
              key={game.gameId}
              data-testid={`chip-mlb-schedule-${game.gameId}`}
              onClick={() => onSelectGame(game.gameId)}
              className={`p-3.5 rounded-xl border text-left transition-all flex flex-col gap-1.5 ${
                isActive
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border/40 hover:border-primary/30 hover:bg-card/80"
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-sm font-bold text-foreground tracking-tight">
                  {awayAbbr} vs {homeAbbr}
                </span>
                {game.status === "live" ? (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 animate-pulse">LIVE</span>
                ) : (
                  <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">PRE</span>
                )}
              </div>

              {game.status === "live" && game.awayScore != null && game.homeScore != null && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-bold text-foreground">{game.awayScore} – {game.homeScore}</span>
                  {game.inning > 0 && (
                    <span className="text-green-400 font-semibold">
                      {game.isTopInning ? "▲" : "▼"}{game.inning}
                    </span>
                  )}
                </div>
              )}

              {game.status !== "live" && startTimeFormatted && (
                <span className="text-xs text-muted-foreground" data-testid={`text-mlb-start-time-${game.gameId}`}>
                  {startTimeFormatted}
                </span>
              )}

              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span className="truncate">{awayLast} vs {homeLast}</span>
                {heat && <span>{heat}</span>}
              </div>

              {weatherLine && (
                <span className="text-[10px] text-muted-foreground/70">
                  {weatherLine}
                </span>
              )}

              {game.venue && (
                <span className="text-[10px] text-muted-foreground/50 truncate">
                  {game.venue}
                </span>
              )}

              <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                {game.signalLocked ? (
                  <span className="text-[9px] font-bold text-green-400">
                    {game.signalCount ? `${game.signalCount} Signal${game.signalCount !== 1 ? "s" : ""}` : "Signals Active"}
                  </span>
                ) : game.status === "live" ? (
                  <span className="text-[9px] text-blue-400/70 flex items-center gap-1">
                    <span className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
                    Monitoring
                  </span>
                ) : game.hasOdds ? (
                  <span className="text-[9px] text-muted-foreground/60">Scanning</span>
                ) : (
                  <span className="text-[9px] text-muted-foreground/60">Pre-game</span>
                )}
                {(game.gameCardTags ?? []).map(tag => (
                  <span key={tag} data-testid={`game-tag-${tag.replace(/\s+/g, "-").toLowerCase()}`} className={`text-[8px] font-bold px-1 py-0.5 rounded ${gameTagStyle(tag)}`}>
                    {tag}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});
