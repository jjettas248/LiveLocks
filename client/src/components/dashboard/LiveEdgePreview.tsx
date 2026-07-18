import { Lock, Zap, Radar, ArrowRight } from "lucide-react";
import type { LiveEdgePreview as LiveEdgePreviewData } from "@shared/topPlays";
import { EmptyState } from "@/components/sports/EmptyState";

interface LiveEdgePreviewProps {
  preview: LiveEdgePreviewData;
  onUpgradeClick: () => void;
}

// Honest, non-actionable Live Edge preview for non-entitled users — every
// number here comes straight from the server-sanitized `preview` payload
// (server/services/liveEdgeAccess.ts). No player, team, market, line,
// direction, probability, projection, thesis, or game/player ID is ever
// available to this component — it structurally cannot fabricate or leak
// them. Reused as-is on both the dashboard and the MLB Live page.
function relativeFreshness(updatedAt: string | null): string {
  if (!updatedAt) return "No signals yet";
  const ms = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes === 1) return "Updated 1 minute ago";
  if (minutes < 60) return `Updated ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours} hour${hours !== 1 ? "s" : ""} ago`;
}

export function LiveEdgePreview({ preview, onUpgradeClick }: LiveEdgePreviewProps) {
  const { activeCount, sports, updatedAt, cards } = preview;
  const hasActivity = activeCount > 0;

  return (
    <div data-testid="panel-live-edge-preview" className="rounded-2xl border border-border/60 bg-card/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-border/60 flex items-center gap-2">
        <Zap className="w-4 h-4 text-brand" />
        <h2 className="text-title-premium" data-testid="text-live-edge-preview-heading">Live Edge</h2>
      </div>

      <div className="p-4 space-y-4">
        {hasActivity ? (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <p className="text-sm text-foreground" data-testid="text-live-edge-active-count">
                <span className="font-bold text-brand">{activeCount}</span> active signal{activeCount !== 1 ? "s" : ""}
                {sports.length > 0 && (
                  <span className="text-muted-foreground"> across {sports.join(", ")}</span>
                )}
              </p>
              <span className="text-micro text-muted-foreground" data-testid="text-live-edge-freshness">
                {relativeFreshness(updatedAt)}
              </span>
            </div>

            {cards.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {cards.map((card, i) => (
                  <div
                    key={i}
                    data-testid={`card-locked-signal-${i}`}
                    className="rounded-xl border border-border/60 bg-card p-4 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 uppercase tracking-wider">
                        {card.sport}
                      </span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/40 uppercase tracking-wider">
                        {card.confidenceTier}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-xs">
                        {card.timingContext ?? "Locked signal"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <EmptyState
            icon={<Radar className="animate-pulse text-blue-400" />}
            title="Monitoring markets"
            description="No active Live Edge signals right now — check back as games get underway."
          />
        )}

        <button
          type="button"
          data-testid="button-unlock-live-edge"
          onClick={onUpgradeClick}
          className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 active:translate-y-px transition"
        >
          Unlock Live Edge
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
