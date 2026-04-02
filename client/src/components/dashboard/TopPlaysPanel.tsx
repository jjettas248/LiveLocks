import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTopPlays, type UnifiedTopPlay } from "@/hooks/useTopPlays";
import { SportSignalCard } from "@/components/signals/SportSignalCard";
import { SignalSkeletonCard } from "@/components/signals/SignalSkeletonCard";
import { Zap, X, ChevronUp, Lock, Sparkles } from "lucide-react";

type LiveSignalCounts = {
  nbaElite: number;
  ncaabElite: number;
  mlbElite: number;
  totalLive: number;
};

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
  const [hasSeenModal, setHasSeenModal] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const { data: signalCounts } = useQuery<LiveSignalCounts>({
    queryKey: ["/api/live-signal-counts"],
    refetchInterval: 60_000,
  });

  const totalSignals = signalCounts?.totalLive ?? 0;

  const hasPlays = plays.length > 0;

  const handleToggle = useCallback(() => {
    if (isOpen && !isElite && hasPlays && !hasSeenModal) {
      setShowModal(true);
      setHasSeenModal(true);
    }
    setIsOpen(!isOpen);
  }, [isOpen, isElite, hasPlays, hasSeenModal]);

  const handleDismissModal = useCallback(() => {
    setShowModal(false);
  }, []);

  const teaserPlay = plays[0];
  const blurredPlays = plays.slice(1, 6);

  return (
    <>
      <button
        data-testid="button-live-edge-feed"
        onClick={handleToggle}
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
              onClick={handleToggle}
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

          {!isLoading && plays.length > 0 && isElite && (
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
                  locked={false}
                  onPrimaryAction={onNavigateToSport ? () => onNavigateToSport(play.routeTarget) : undefined}
                  onAddToSlip={onAddToSlip ? () => onAddToSlip(play) : undefined}
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

          {!isLoading && plays.length > 0 && !isElite && (
            <div className="space-y-3">
              {teaserPlay && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <SportSignalCard
                    key={teaserPlay.id}
                    sport={teaserPlay.sport}
                    playerOrTeam={teaserPlay.playerOrTeam}
                    marketLabel={teaserPlay.marketLabel}
                    side={teaserPlay.side}
                    line={teaserPlay.line}
                    projection={teaserPlay.projection}
                    probability={teaserPlay.probability}
                    edge={teaserPlay.edge}
                    badgeTier={teaserPlay.confidenceTier}
                    summary={teaserPlay.summary ?? undefined}
                    isBestBet={true}
                    locked={false}
                    onPrimaryAction={onNavigateToSport ? () => onNavigateToSport(teaserPlay.routeTarget) : undefined}
                    onAddToSlip={onAddToSlip ? () => onAddToSlip(teaserPlay) : undefined}
                    market={teaserPlay.market}
                    gameId={teaserPlay.gameId}
                    playerId={teaserPlay.playerId}
                    currentStats={teaserPlay.currentStats}
                    lastABContact={teaserPlay.lastABContact}
                    matchup={teaserPlay.matchup}
                  />
                </div>
              )}

              {blurredPlays.length > 0 && (
                <div className="relative">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 filter blur-[6px] pointer-events-none select-none" aria-hidden="true">
                    {blurredPlays.map((play) => (
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
                        isBestBet={false}
                        locked={true}
                        market={play.market}
                        gameId={play.gameId}
                        playerId={play.playerId}
                        currentStats={play.currentStats}
                        lastABContact={play.lastABContact}
                        matchup={play.matchup}
                      />
                    ))}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center z-10">
                    <div className="rounded-xl border border-primary/30 bg-card/95 backdrop-blur-sm p-5 text-center space-y-3 max-w-sm shadow-xl">
                      <Lock className="w-5 h-5 text-primary mx-auto" />
                      <div className="text-sm font-bold text-foreground">
                        {blurredPlays.length} more edge{blurredPlays.length !== 1 ? "s" : ""} detected
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Upgrade to unlock all live signals, probabilities, and bet recommendations across every sport.
                      </div>
                      <a
                        href="/upgrade"
                        data-testid="link-edge-feed-upgrade"
                        className="inline-block px-5 py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-xs hover:bg-primary/90 transition-colors"
                      >
                        Upgrade Now
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {totalSignals > 0 && (
                <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-muted/30 border border-border/20">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
                  </span>
                  <span className="text-[10px] text-muted-foreground font-medium">
                    {totalSignals} live signal{totalSignals !== 1 ? "s" : ""} across all sports right now
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="modal-unlock-signals">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleDismissModal} />
          <div className="relative bg-card border border-border rounded-2xl p-6 max-w-sm w-full shadow-2xl animate-in zoom-in-95 fade-in duration-200 space-y-4">
            <div className="flex items-center justify-center">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-primary" />
              </div>
            </div>
            <div className="text-center space-y-2">
              <h3 className="text-lg font-bold text-foreground">
                Unlock {totalSignals > 0 ? `All ${totalSignals}` : "All"} Live Signals
              </h3>
              <p className="text-sm text-muted-foreground">
                You just saw one edge — there are more across NBA, NCAAB, and MLB right now. Get full access to every signal, probability, and recommendation.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <a
                href="/upgrade"
                data-testid="link-modal-upgrade"
                className="w-full text-center px-5 py-3 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-colors"
              >
                Upgrade to All Sports
              </a>
              <button
                onClick={handleDismissModal}
                data-testid="button-modal-dismiss"
                className="w-full text-center px-5 py-2.5 rounded-lg text-muted-foreground text-xs hover:text-foreground transition-colors"
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
