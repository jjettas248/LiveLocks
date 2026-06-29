import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, ArrowRight, TrendingUp, RefreshCw } from "lucide-react";
import type { HrMovementRow } from "@shared/hrBoardStudio";

interface Props {
  movements: HrMovementRow[];
  stageFilter: string;
  onStageFilter: (stage: string) => void;
  isFetching?: boolean;
  onRefresh?: () => void;
}

const STAGE_FILTERS = ["all", "FIRE", "READY", "BUILD", "WATCH", "CASHED", "MISSED"];

// Map the engine's raw stage tokens to the SAME user-facing vocabulary the HR
// Radar ladder shows (see SECTION_META in HrRadarLadder.tsx): BUILD→ALMOST and
// WATCH→TRACK so this admin feed never surfaces a stage name that disagrees
// with — or looks more raw than — what users see on the live ladder. The raw
// token is still used for filtering; only the displayed text is humanized.
const STAGE_LABELS: Record<string, string> = {
  FIRE: "FIRE",
  READY: "READY",
  BUILD: "ALMOST",
  WATCH: "TRACK",
  CASHED: "CASHED",
  MISSED: "MISSED",
  EXPIRED: "EXPIRED",
  INACTIVE: "INACTIVE",
};

function stageLabel(stage: string): string {
  if (!stage) return "—";
  return STAGE_LABELS[stage] ?? stage.charAt(0).toUpperCase() + stage.slice(1).toLowerCase();
}

function stageColor(stage: string): string {
  switch (stage) {
    case "FIRE":
      return "text-red-500";
    case "READY":
      return "text-orange-400";
    case "CASHED":
      return "text-emerald-500";
    case "BUILD":
      return "text-amber-400";
    case "WATCH":
      return "text-sky-400";
    case "MISSED":
    case "EXPIRED":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

/**
 * Live movement from the pre-game board into HR Radar stages. Read-only —
 * renders server-stamped stage/score/result fields. No lifecycle state is
 * derived on the client.
 */
export function HrMovementFeed({
  movements,
  stageFilter,
  onStageFilter,
  isFetching,
  onRefresh,
}: Props) {
  const filtered =
    stageFilter === "all" ? movements : movements.filter((m) => m.currentStage === stageFilter);

  return (
    <Card data-testid="movement-feed-card">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" /> Movement Feed
            <span className="text-xs text-muted-foreground font-normal">
              ({filtered.length})
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="text-[11px] px-2 py-1 rounded border border-border hover:bg-accent flex items-center gap-1"
                data-testid="button-refresh-movement"
              >
                <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} /> Refresh
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {STAGE_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => onStageFilter(s)}
              className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                stageFilter === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
              data-testid={`movement-stage-filter-${s}`}
            >
              {s === "all" ? "All" : stageLabel(s)}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground py-6 text-center">
            No board players have moved into the live radar yet.
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((m) => (
              <div
                key={`${m.gameId}_${m.playerId}`}
                className="flex items-center gap-3 text-xs rounded-md border border-border/60 px-3 py-2"
                data-testid={`movement-row-${m.playerId}`}
              >
                {m.pregameRank != null && (
                  <span className="text-[10px] text-muted-foreground w-8 shrink-0">
                    #{m.pregameRank}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">
                    {m.player} <span className="text-muted-foreground">({m.team})</span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <span>{stageLabel(m.previousStage)}</span>
                    <ArrowRight className="h-3 w-3" />
                    <span className={stageColor(m.currentStage)}>{stageLabel(m.currentStage)}</span>
                    {m.topDriver && <span className="truncate">· {m.topDriver}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {m.scoreChange != null && (
                    <div
                      className={`flex items-center gap-0.5 justify-end ${
                        m.scoreChange >= 0 ? "text-emerald-500" : "text-red-500"
                      }`}
                    >
                      <TrendingUp className="h-3 w-3" />
                      {m.scoreChange >= 0 ? "+" : ""}
                      {m.scoreChange.toFixed(1)}
                    </div>
                  )}
                  {m.result && (
                    <div className={`text-[10px] ${stageColor(m.currentStage)}`}>{m.result}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
