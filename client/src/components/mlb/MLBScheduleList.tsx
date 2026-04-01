import { memo } from "react";
import { CloudRain, Wind, Thermometer } from "lucide-react";

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
  status: "live" | "pregame" | "final" | null;
  startTime?: string | null;
  venue?: string | null;
  weatherSummary?: string | null;
  pitcherAway?: string | null;
  pitcherHome?: string | null;
  awayPitcherHand?: string | null;
  homePitcherHand?: string | null;
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
  parkFactor?: number | null;
  isIndoors?: boolean;
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

function pitcherLabel(name: string | null | undefined, hand: string | null | undefined): string {
  const last = lastName(name);
  if (hand) return `${last} (${hand})`;
  return last;
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

function parkFactorLabel(pf: number | null | undefined): { label: string; color: string } | null {
  if (pf == null) return null;
  if (pf >= 1.15) return { label: "Hitter+", color: "#f97316" };
  if (pf >= 1.05) return { label: "Hit-lean", color: "#eab308" };
  if (pf <= 0.85) return { label: "Pitcher+", color: "#3b82f6" };
  if (pf <= 0.95) return { label: "Pitch-lean", color: "#60a5fa" };
  return null;
}

export const MLBScheduleList = memo(function MLBScheduleList({ games, selectedGameId, onSelectGame }: MLBScheduleListProps) {
  const safeGames = Array.isArray(games) ? games : [];
  const renderedGames = safeGames.filter((g) => g && g.gameId && (g.awayTeam || g.homeTeam));

  const liveGames = renderedGames
    .filter(g => g.status === "live")
    .sort((a, b) => (b.signalCount ?? 0) - (a.signalCount ?? 0));
  const preGames = renderedGames
    .filter(g => g.status === "pregame" || g.status === null)
    .sort((a, b) => new Date(a.startTime ?? "").getTime() - new Date(b.startTime ?? "").getTime());
  const finalGames = renderedGames.filter(g => g.status === "final");

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
              {(game.status === "live" || game.status === "final") && game.awayScore != null && game.homeScore != null ? (
                <span className={`text-[10px] font-mono font-bold whitespace-nowrap ${game.status === "final" ? "text-muted-foreground" : "text-foreground"}`}>
                  {game.awayScore}–{game.homeScore}
                  {game.status === "live" && game.inning > 0 && <span className="text-green-400 ml-1">{game.isTopInning ? "▲" : "▼"}{game.inning}</span>}
                  {game.status === "final" && <span className="text-muted-foreground/50 ml-1">F</span>}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">{formatStartTime(game.startTime) ?? "TBD"}</span>
              )}
              {(game.signalCount ?? 0) > 0 && (
                <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 whitespace-nowrap">
                  {game.signalCount}
                </span>
              )}
              {game.signalLocked && <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />}
            </button>
          );
        })}
      </div>
    );
  }

  function renderGameCard(game: MLBScheduleGame) {
    if (!game?.gameId) return null;
    const isActive = game.gameId === selectedGameId;
    const startTimeFormatted = formatStartTime(game.startTime);
    const awayAbbr = game.awayAbbr ?? "";
    const homeAbbr = game.homeAbbr ?? "";
    const isLive = game.status === "live";
    const isFinal = game.status === "final";
    const pf = isLive ? parkFactorLabel(game.parkFactor) : null;
    const weather = game.weather;
    const hasWeatherInfo = weather && (weather.temperature != null || weather.windSpeed != null);
    const bothTBD = lastName(game.pitcherAway) === "TBD" && lastName(game.pitcherHome) === "TBD";

    return (
      <button
        key={game.gameId}
        data-testid={`chip-mlb-schedule-${game.gameId}`}
        onClick={() => onSelectGame(game.gameId)}
        className={`w-full px-4 py-3 min-h-[44px] rounded-lg border text-left transition-all ${
          isActive
            ? "border-primary bg-primary/10 ring-1 ring-primary/30"
            : "border-border/30 hover:border-primary/30 hover:bg-card/80"
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 min-w-0 shrink-0" style={{ width: "100px" }}>
            <div className="text-xs font-bold text-foreground">{awayAbbr}</div>
            {(isLive || isFinal) && game.awayScore != null && game.homeScore != null ? (
              <span className={`text-[11px] font-mono font-bold mx-1 ${isFinal ? "text-muted-foreground" : "text-foreground"}`}>
                {game.awayScore}–{game.homeScore}
              </span>
            ) : (
              <span className="text-[10px] text-muted-foreground mx-1">vs</span>
            )}
            <div className="text-xs font-bold text-foreground">{homeAbbr}</div>
          </div>

          {isLive && game.inning > 0 ? (
            <span className="text-[10px] font-bold text-green-400 shrink-0 w-8 text-center">
              {game.isTopInning ? "▲" : "▼"}{game.inning}
            </span>
          ) : isFinal ? (
            <span className="text-[10px] font-bold text-muted-foreground/50 shrink-0 w-12 text-center">
              Final
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground shrink-0 w-12 text-center">
              {startTimeFormatted ?? "TBD"}
            </span>
          )}

          {!bothTBD && (
            <div className="text-[10px] text-muted-foreground truncate min-w-0 flex-1 hidden sm:block">
              {pitcherLabel(game.pitcherAway, game.awayPitcherHand)} vs {pitcherLabel(game.pitcherHome, game.homePitcherHand)}
            </div>
          )}

          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            {pf && (
              <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded" style={{ color: pf.color, background: `${pf.color}15` }}>
                {pf.label}
              </span>
            )}
            {isLive && game.signalLocked ? (
              <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400" data-testid={`signal-count-${game.gameId}`}>
                {game.signalCount ?? 0}
              </span>
            ) : isLive ? (
              <span className="relative flex h-2 w-2" title="Monitoring">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
              </span>
            ) : isFinal ? (
              <span className="text-[9px] text-muted-foreground/40">FIN</span>
            ) : (
              <span className="text-[9px] text-muted-foreground/50">PRE</span>
            )}
          </div>
        </div>

        {(hasWeatherInfo || game.venue) && (
          <div className="flex items-center gap-2 mt-1.5 text-[9px] text-muted-foreground/60">
            {game.venue && (
              <span className="truncate max-w-[140px]">{game.venue}</span>
            )}
            {weather?.temperature != null && (
              <span className="flex items-center gap-0.5 shrink-0">
                <Thermometer className="w-2.5 h-2.5" />
                {weather.temperature}°F
              </span>
            )}
            {weather?.windSpeed != null && weather.windSpeed > 0 && (
              <span className="flex items-center gap-0.5 shrink-0">
                <Wind className="w-2.5 h-2.5" />
                {weather.windSpeed} mph
                {weather.windDirection && <span className="text-muted-foreground/40">{weather.windDirection}</span>}
              </span>
            )}
            {game.isIndoors && (
              <span className="text-muted-foreground/40">Dome</span>
            )}
          </div>
        )}
      </button>
    );
  }

  return (
    <div className="space-y-1.5">
      {liveGames.length > 0 && (
        <>
          <h3 className="text-xs font-bold text-green-400 uppercase tracking-wider px-2 py-2">
            Live Games
          </h3>
          {liveGames.map(renderGameCard)}
        </>
      )}

      {preGames.length > 0 && (
        <>
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider px-2 py-2 mt-4">
            Upcoming
          </h3>
          {preGames.map(renderGameCard)}
        </>
      )}

      {finalGames.length > 0 && (
        <>
          <h3 className="text-xs font-bold text-muted-foreground/50 uppercase tracking-wider px-2 py-2 mt-4">
            Final
          </h3>
          {finalGames.map(renderGameCard)}
        </>
      )}
    </div>
  );
});
