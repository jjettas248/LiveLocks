import { useTopPlays, type UnifiedTopPlay } from "@/hooks/useTopPlays";
import { SignalSkeletonCard } from "@/components/signals/SignalSkeletonCard";
import { TopPlaysPanel } from "@/components/dashboard/TopPlaysPanel";
import { LiveEdgePreview } from "@/components/dashboard/LiveEdgePreview";

type LiveEdgeSurfaceProps = {
  onUpgradeClick: () => void;
  onNavigateToSport?: (sport: string) => void;
  onAddToSlip?: (play: UnifiedTopPlay) => void;
  onViewDetails?: (play: UnifiedTopPlay, related?: UnifiedTopPlay[]) => void;
};

// Sole owner of the /api/top-plays subscription on the dashboard, and the
// single place that performs the server-authoritative full/preview branch —
// the server's `access` field decides what renders, never client-side tier
// state. `access: "full"` renders the real TopPlaysPanel (all cards fully
// visible and actionable); anything else renders the honest LiveEdgePreview.
export function LiveEdgeSurface({ onUpgradeClick, onNavigateToSport, onAddToSlip, onViewDetails }: LiveEdgeSurfaceProps) {
  const { data, isLoading, isError, isFetching, refetch } = useTopPlays();

  if (!data) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="panel-live-edge-loading">
        <SignalSkeletonCard />
        <SignalSkeletonCard />
      </div>
    );
  }

  if (data.access === "full") {
    return (
      <TopPlaysPanel
        plays={data.plays}
        isLoading={isLoading}
        isError={isError}
        isFetching={isFetching}
        onRetry={refetch}
        onNavigateToSport={onNavigateToSport}
        onAddToSlip={onAddToSlip}
        onViewDetails={onViewDetails}
      />
    );
  }

  return <LiveEdgePreview preview={data.preview} onUpgradeClick={onUpgradeClick} />;
}
