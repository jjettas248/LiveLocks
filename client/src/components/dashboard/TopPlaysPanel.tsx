import { useState, useCallback } from "react";
import { useTopPlays, type UnifiedTopPlay } from "@/hooks/useTopPlays";
import { useLiveSignalCounts } from "@/hooks/useLiveSignalCounts";
import { SportSignalCard } from "@/components/signals/SportSignalCard";
import { SignalSkeletonCard } from "@/components/signals/SignalSkeletonCard";
import { QueryErrorState } from "@/components/common/QueryErrorState";
import { EmptyState } from "@/components/sports/EmptyState";
import { Zap, X, ChevronUp, Lock, Sparkles, Trophy, Radar } from "lucide-react";

type TopPlaysPanelProps = {
  isElite?: boolean;
  onNavigateToSport?: (sport: string) => void;
  onAddToSlip?: (play: UnifiedTopPlay) => void;
  onViewDetails?: (play: UnifiedTopPlay, related?: UnifiedTopPlay[]) => void;
  isOnSlip?: (play: UnifiedTopPlay) => boolean;
};

// Presentation-only grouping. Same player + same game → one primary card
// with related opportunities surfaced through View Details.
// Server ordering is preserved for primary selection (no client-side ranking).
type GroupedPlay = { primary: UnifiedTopPlay; related: UnifiedTopPlay[] };

function groupPlaysByPlayer(plays: UnifiedTopPlay[]): GroupedPlay[] {
  const groups = new Map<string, GroupedPlay>();
  const order: string[] = [];
  for (const play of plays) {
    const key = play.gameId
      ? `${play.sport}|${play.gameId}|${play.playerOrTeam}`
      : `${play.sport}|standalone|${play.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.related.push(play);
    } else {
      groups.set(key, { primary: play, related: [] });
      order.push(key);
    }
  }
  return order.map((k) => groups.get(k)!);
}

export function TopPlaysPanel({ isElite, onNavigateToSport, onAddToSlip, onViewDetails, isOnSlip }: TopPlaysPanelProps) {
  // Prefer the explicit detail handler. Fall back to legacy sport navigation
  // so callers that haven't adopted the detail dialog keep their behavior.
  const buildPrimaryAction = (play: UnifiedTopPlay, related?: UnifiedTopPlay[]) => {
    if (onViewDetails) return () => onViewDetails(play, related && related.length > 0 ? related : undefined);
    if (onNavigateToSport) return () => onNavigateToSport(play.routeTarget);
    return undefined;
  };
  const buildFooterSlot = (related: UnifiedTopPlay[], primary: UnifiedTopPlay) => {
    if (!related || related.length === 0 || !onViewDetails) return undefined;
    const onClick = () => onViewDetails!(primary, related);
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={`button-related-count-${primary.id}`}
        className="text-[10px] font-semibold px-2 py-1 rounded-md border border-border/40 bg-secondary/40 hover:bg-secondary/70 transition-colors text-muted-foreground hover:text-foreground"
      >
        +{related.length} related
      </button>
    );
  };
  const { data, isLoading, isError, isFetching, refetch } = useTopPlays();
  const allPlays = data?.plays ?? [];
  // Group same-player same-game plays (presentation only). Cap at 6 groups
  // so we still show ~6 distinct opportunities while collapsing duplicates.
  const grouped = groupPlaysByPlayer(allPlays).slice(0, 6);
  const plays = grouped.map((g) => g.primary);
  const relatedFor = (id: string) => grouped.find((g) => g.primary.id === id)?.related ?? [];
  const [isOpen, setIsOpen] = useState(false);
  const [hasSeenModal, setHasSeenModal] = useState(false);
  const [showModal, setShowModal] = useState(false);

  const { data: signalCounts } = useLiveSignalCounts();

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
            <span className={`text-title-premium ${hasPlays ? "text-green-400" : "text-foreground"}`}>
              {hasPlays ? "Live Signals" : "Signal Feed"}
            </span>
            <span className="block text-micro text-muted-foreground/70">
              {isError && !hasPlays ? "Couldn't load — tap to retry" : isLoading ? "Scanning..." : hasPlays ? `${plays.length} signal${plays.length !== 1 ? "s" : ""} across all sports` : "Monitoring opportunities"}
            </span>
          </div>
        </div>
        <ChevronUp className={`w-4 h-4 text-muted-foreground transition-transform ${isOpen ? "" : "rotate-180"}`} />
      </button>

      {isOpen && (
        <div className="space-y-3 animate-in slide-in-from-top-2 duration-200" data-testid="panel-top-plays">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-label">Live Signals</h2>
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

          {!isLoading && isError && plays.length === 0 && (
            <QueryErrorState
              message="Couldn't load live signals."
              onRetry={() => refetch()}
              isRetrying={isFetching}
            />
          )}

          {!isLoading && !isError && plays.length === 0 && (
            <EmptyState
              icon={<Radar className="animate-pulse text-blue-400" />}
              title="Processing live markets"
              description="Open any sport tab to view markets, run manual calculations, and see engine probabilities in real time."
            />
          )}

          {!isLoading && plays.length > 0 && isElite && (() => {
            const topPicks = plays.slice(0, 3);
            const otherPicks = plays.slice(3);
            return (
              <div className="space-y-4">
                {topPicks.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 px-1">
                      <Trophy className="w-3.5 h-3.5 text-yellow-400" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-400" data-testid="text-top-picks-header">Top Picks</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      {topPicks.map((play, i) => (
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
                          rank={i + 1}
                          signalScore={play.signalScore}
                          timingContext={play.timingContext ?? undefined}
                          isFlagship={play.isFlagship}
                          locked={false}
                          onPrimaryAction={buildPrimaryAction(play, relatedFor(play.id))}
                          onAddToSlip={onAddToSlip ? () => onAddToSlip(play) : undefined}
                          market={play.market}
                          gameId={play.gameId}
                          playerId={play.playerId}
                          currentStats={play.currentStats}
                          lastABContact={play.lastABContact}
                          matchup={play.matchup}
                          footerSlot={buildFooterSlot(relatedFor(play.id), play)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {otherPicks.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {otherPicks.map((play) => (
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
                        signalScore={play.signalScore}
                        timingContext={play.timingContext ?? undefined}
                        isFlagship={play.isFlagship}
                        locked={false}
                        onPrimaryAction={buildPrimaryAction(play, relatedFor(play.id))}
                        onAddToSlip={onAddToSlip ? () => onAddToSlip(play) : undefined}
                        market={play.market}
                        gameId={play.gameId}
                        playerId={play.playerId}
                        currentStats={play.currentStats}
                        lastABContact={play.lastABContact}
                        matchup={play.matchup}
                        footerSlot={buildFooterSlot(relatedFor(play.id), play)}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

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
                    rank={1}
                    signalScore={teaserPlay.signalScore}
                    timingContext={teaserPlay.timingContext ?? undefined}
                    isFlagship={teaserPlay.isFlagship}
                    locked={false}
                    onPrimaryAction={buildPrimaryAction(teaserPlay, relatedFor(teaserPlay.id))}
                    onAddToSlip={onAddToSlip ? () => onAddToSlip(teaserPlay) : undefined}
                    footerSlot={buildFooterSlot(relatedFor(teaserPlay.id), teaserPlay)}
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
                        {blurredPlays.length} more signal{blurredPlays.length !== 1 ? "s" : ""} detected
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

              <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-muted/30 border border-border/20">
                <span className="relative flex h-1.5 w-1.5">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${totalSignals > 0 ? "bg-green-400" : "bg-blue-400"} opacity-75`} />
                  <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${totalSignals > 0 ? "bg-green-400" : "bg-blue-400"}`} />
                </span>
                <span className="text-micro text-muted-foreground font-medium">
                  {totalSignals > 0
                    ? `${totalSignals} live signal${totalSignals !== 1 ? "s" : ""} across all sports right now`
                    : "Scanning for live signals across all sports"}
                </span>
              </div>
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
                Unlock {totalSignals > 0 ? `all ${totalSignals} signals` : "all signals"} across sports
              </h3>
              <p className="text-sm text-muted-foreground">
                You just saw one signal — there are more across NBA, NCAAB, and MLB right now. Get full access to every signal, probability, and recommendation.
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
