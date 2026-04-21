import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { ShareSignalButton } from "@/components/common/ShareSignalButton";
import { CopyBetButton } from "@/components/common/CopyBetButton";
import type { UnifiedTopPlay } from "@/hooks/useTopPlays";
import { Sparkles, ExternalLink, Plus, Check } from "lucide-react";

const SPORT_BADGE: Record<string, { label: string; color: string }> = {
  NBA: { label: "NBA", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  NCAAB: { label: "NCAAB", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  MLB: { label: "MLB", color: "bg-green-500/15 text-green-400 border-green-500/30" },
};

const EDGE_COLOR = (edge: number): string => {
  if (edge >= 8) return "text-green-400";
  if (edge >= 5) return "text-yellow-400";
  if (edge >= 0) return "text-muted-foreground";
  return "text-red-400";
};

type RelatedPlay = Pick<
  UnifiedTopPlay,
  "id" | "marketLabel" | "side" | "line" | "projection" | "probability" | "edge" | "confidenceTier" | "market"
>;

export type SignalDetailDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  play: UnifiedTopPlay | null;
  related?: RelatedPlay[];
  alreadyOnSlip?: boolean;
  onAddToSlip?: (play: UnifiedTopPlay) => void;
  onAddRelatedToSlip?: (play: RelatedPlay & { id: string }) => void;
  onOpenSport?: (routeTarget: string) => void;
};

function deriveDrivers(play: UnifiedTopPlay): string[] {
  const drivers: string[] = [];
  if (play.thesis) drivers.push(play.thesis);
  if (play.timingContext) drivers.push(`Timing: ${play.timingContext}`);
  if (play.batterArchetype) drivers.push(`Batter profile: ${play.batterArchetype}`);
  if (play.pitcherArchetype) drivers.push(`Pitcher profile: ${play.pitcherArchetype}`);
  if (play.signalScore != null) drivers.push(`Signal score: ${Math.round(play.signalScore)}/100`);
  if (play.summary && !drivers.includes(play.summary)) drivers.push(play.summary);
  return drivers;
}

export function SignalDetailDialog({
  open,
  onOpenChange,
  play,
  related = [],
  alreadyOnSlip,
  onAddToSlip,
  onAddRelatedToSlip,
  onOpenSport,
}: SignalDetailDialogProps) {
  if (!play) return null;
  const sportBadge = SPORT_BADGE[play.sport] ?? SPORT_BADGE.NBA;
  const edgeStr = play.edge > 0 ? `+${play.edge.toFixed(1)}%` : `${play.edge.toFixed(1)}%`;
  const probWhole = Math.round(play.probability);
  const drivers = deriveDrivers(play);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[90vh] overflow-y-auto"
        data-testid="dialog-signal-detail"
      >
        <DialogHeader>
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${sportBadge.color}`}>
              {sportBadge.label}
            </span>
            <ConfidenceBadge tier={play.confidenceTier} />
            {play.isFlagship && (
              <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 border border-purple-500/30 shrink-0">
                Flagship
              </span>
            )}
            {play.signalScore != null && (
              <span className="text-[10px] font-bold tabular-nums text-muted-foreground" data-testid="text-detail-signal-score">
                SS {Math.round(play.signalScore)}
              </span>
            )}
          </div>
          <DialogTitle
            className="text-lg font-bold text-foreground mt-2 text-left"
            data-testid="text-detail-player"
          >
            {play.playerOrTeam}
          </DialogTitle>
          {play.matchup && (
            <div className="text-xs text-muted-foreground" data-testid="text-detail-matchup">{play.matchup}</div>
          )}
        </DialogHeader>

        <div className="space-y-4 mt-1">
          {/* Best Bet block */}
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider text-primary">Best Bet</div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className={`text-base font-bold ${EDGE_COLOR(play.edge)}`}>{play.side}</span>
              <span className="text-sm text-muted-foreground">{play.marketLabel}</span>
              {play.line != null && <span className="text-sm font-semibold text-foreground">{play.line}</span>}
            </div>
            <div className="flex items-end gap-5 pt-1">
              <div>
                <div className={`text-2xl font-bold ${EDGE_COLOR(play.edge)}`} data-testid="text-detail-probability">{probWhole}%</div>
                <div className="text-[10px] text-muted-foreground">Probability</div>
              </div>
              {play.projection != null && play.sport !== "MLB" && (
                <div>
                  <div className="text-sm font-semibold text-foreground" data-testid="text-detail-projection">
                    {typeof play.projection === "number" ? play.projection.toFixed(1) : play.projection}
                  </div>
                  <div className="text-[10px] text-muted-foreground">Proj</div>
                </div>
              )}
              <div>
                <div className={`text-sm font-semibold ${EDGE_COLOR(play.edge)}`} data-testid="text-detail-edge">{edgeStr}</div>
                <div className="text-[10px] text-muted-foreground">Edge</div>
              </div>
            </div>
          </div>

          {/* Why this signal */}
          {drivers.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Why this signal</span>
              </div>
              <ul className="space-y-1.5">
                {drivers.slice(0, 5).map((driver, idx) => (
                  <li
                    key={idx}
                    className="text-xs text-foreground leading-snug pl-3 border-l-2 border-primary/30"
                    data-testid={`text-detail-driver-${idx}`}
                  >
                    {driver}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Live stats line for MLB */}
          {play.currentStats && (
            <div className="rounded-lg border border-border/30 bg-secondary/30 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Today</div>
              <div className="flex items-center gap-2 flex-wrap text-[11px]">
                <span className="font-semibold text-foreground">
                  {play.currentStats.ab > 0 ? `${play.currentStats.h}-${play.currentStats.ab}` : "0 AB"}
                </span>
                {play.currentStats.hr > 0 && <span className="text-orange-400 font-bold">{play.currentStats.hr} HR</span>}
                {play.currentStats.rbi > 0 && <span className="text-muted-foreground">{play.currentStats.rbi} RBI</span>}
                {play.currentStats.bb > 0 && <span className="text-muted-foreground">{play.currentStats.bb} BB</span>}
                {play.currentStats.k > 0 && <span className="text-red-400">{play.currentStats.k} K</span>}
                {play.currentStats.tb > 0 && <span className="text-muted-foreground">{play.currentStats.tb} TB</span>}
              </div>
            </div>
          )}

          {/* Related opportunities */}
          {related.length > 0 && (
            <div className="space-y-2">
              <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                Related opportunities ({related.length})
              </div>
              <div className="space-y-1.5">
                {related.map((rel) => {
                  const relEdgeStr = rel.edge > 0 ? `+${rel.edge.toFixed(1)}%` : `${rel.edge.toFixed(1)}%`;
                  return (
                    <div
                      key={rel.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border/30 bg-card px-3 py-2"
                      data-testid={`row-related-${rel.id}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className={`text-xs font-bold ${EDGE_COLOR(rel.edge)}`}>{rel.side}</span>
                          <span className="text-xs text-muted-foreground truncate">{rel.marketLabel}</span>
                          {rel.line != null && <span className="text-xs font-semibold text-foreground">{rel.line}</span>}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {Math.round(rel.probability)}% · {relEdgeStr}
                        </div>
                      </div>
                      {onAddRelatedToSlip && (
                        <button
                          onClick={() => onAddRelatedToSlip(rel)}
                          data-testid={`button-related-add-slip-${rel.id}`}
                          className="text-[10px] font-semibold px-2 py-1 rounded border border-primary/30 bg-primary/10 hover:bg-primary/20 transition-colors text-primary shrink-0"
                        >
                          + Slip
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-2 pt-2 border-t border-border/30">
            {onAddToSlip && (
              <button
                onClick={() => onAddToSlip(play)}
                disabled={alreadyOnSlip}
                data-testid="button-detail-add-slip"
                className={`flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-4 py-2.5 min-h-[44px] rounded-lg transition-colors ${
                  alreadyOnSlip
                    ? "bg-green-500/15 text-green-400 border border-green-500/30 cursor-default"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {alreadyOnSlip ? (
                  <>
                    <Check className="w-4 h-4" /> Added to Slip
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" /> Add to Slip
                  </>
                )}
              </button>
            )}
            {onOpenSport && (
              <button
                onClick={() => {
                  onOpenSport(play.routeTarget);
                  onOpenChange(false);
                }}
                data-testid="button-detail-open-sport"
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2.5 min-h-[44px] rounded-lg border border-border/40 bg-card hover:bg-secondary/40 transition-colors text-foreground"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open
              </button>
            )}
          </div>

          <div className="flex items-center justify-end gap-1.5">
            <ShareSignalButton
              data={{
                sport: play.sport,
                playerOrTeam: play.playerOrTeam,
                marketLabel: play.marketLabel,
                side: play.side,
                line: typeof play.line === "number" ? play.line : undefined,
                probability: play.probability,
                edge: play.edge,
              }}
            />
            <CopyBetButton
              data={{
                playerOrTeam: play.playerOrTeam,
                side: play.side,
                marketLabel: play.marketLabel,
                line: typeof play.line === "number" ? play.line : undefined,
                probability: play.probability,
                edge: play.edge,
              }}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
