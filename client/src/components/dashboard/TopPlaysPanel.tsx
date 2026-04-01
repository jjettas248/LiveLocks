import { useState } from "react";
import { useTopPlays, type UnifiedTopPlay } from "@/hooks/useTopPlays";
import { SportSignalCard } from "@/components/signals/SportSignalCard";
import { SignalSkeletonCard } from "@/components/signals/SignalSkeletonCard";
import { Zap, X, ChevronUp } from "lucide-react";

type TopPlaysPanelProps = {
  isElite?: boolean;
  onNavigateToSport?: (sport: string) => void;
  onAddToSlip?: (play: UnifiedTopPlay) => void;
};

export function TopPlaysPanel({ isElite, onNavigateToSport, onAddToSlip }: TopPlaysPanelProps) {
  const { data, isLoading } = useTopPlays();
  const allPlays = data?.plays ?? [];
  const plays = allPlays.slice(0, 6);
  const [isOpen, setIsOpen] = useState(false);

  const hasPlays = plays.length > 0;

  return (
    <>
      <button
        data-testid="button-live-edge-feed"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border transition-all ${
          hasPlays
            ? "border-green-500/40 bg-green-500/5 shadow-[0_0_15px_rgba(34,197,94,0.15)] hover:shadow-[0_0_25px_rgba(34,197,94,0.25)]"
            : "border-border/40 bg-card/50 hover:bg-card/80"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className={`relative flex items-center justify-center w-8 h-8 rounded-lg ${
            hasPlays ? "bg-green-500/20" : "bg-muted/50"
          }`}>
            <Zap className={`w-4 h-4 ${hasPlays ? "text-green-400" : "text-muted-foreground"}`} />
            {hasPlays && (
              <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-green-500 text-[9px] font-bold text-black flex items-center justify-center animate-pulse">
                {plays.length}
              </span>
            )}
          </div>
          <div className="text-left">
            <span className={`text-sm font-bold ${hasPlays ? "text-green-400" : "text-muted-foreground"}`}>
              {hasPlays ? "Live Edge Feed" : "Edge Feed"}
            </span>
            <span className="block text-[10px] text-muted-foreground/70">
              {isLoading ? "Scanning..." : hasPlays ? `${plays.length} signal${plays.length !== 1 ? "s" : ""} across all sports` : "Monitoring opportunities"}
            </span>
          </div>
        </div>
        <ChevronUp className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? "" : "rotate-180"}`} />
      </button>

      {isOpen && (
        <div className="space-y-3 animate-in slide-in-from-top-2 duration-200" data-testid="panel-top-plays">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Live Edges</h2>
            <button
              data-testid="button-close-edge-feed"
              onClick={() => setIsOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {isLoading && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <SignalSkeletonCard />
              <SignalSkeletonCard />
            </div>
          )}

          {!isLoading && plays.length === 0 && (
            <div className="rounded-xl border border-border/40 bg-card p-6 text-center">
              <div className="flex items-center justify-center gap-2 text-sm text-blue-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
                </span>
                Processing live markets
              </div>
              <div className="text-xs text-muted-foreground/60 mt-1">
                Open any sport tab to view markets, run manual calculations, and see engine probabilities in real time.
              </div>
            </div>
          )}

          {!isLoading && plays.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {plays.map((play, i) => (
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
                  isBestBet={i === 0}
                  locked={!isElite && play.sport !== "NBA"}
                  onPrimaryAction={onNavigateToSport ? () => onNavigateToSport(play.routeTarget) : undefined}
                  onAddToSlip={onAddToSlip && !((!isElite && play.sport !== "NBA")) ? () => onAddToSlip(play) : undefined}
                  market={play.market}
                  gameId={play.gameId}
                  playerId={play.playerId}
                  currentStats={play.currentStats}
                  lastABContact={play.lastABContact}
                  matchup={play.matchup}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
