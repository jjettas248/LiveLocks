// HR Radar — "Decision Queue". The next ≤5 plays under the Hot Seat, ranked by
// importance (stage, then score). Compact, scannable rows; tap to act.
// PRESENTATION ONLY — reads the canonical view model.

import { Check } from "lucide-react";
import type { HrRadarCardViewModel } from "@/lib/mlb/hrRadarViewModel";
import { HR_PUBLIC_STAGE_LABEL } from "@/lib/mlb/hrRadarViewModel";
import { hrTierTheme, TierRail, HeatMeter } from "@/components/mlb/hrRadarVisuals";

function QueueRow({ vm, rank, onPrimary }: { vm: HrRadarCardViewModel; rank: number; onPrimary: () => void }) {
  const t = hrTierTheme(vm.stage);
  const timing = vm.inningLabel ?? vm.nextPaLabel ?? "";
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-border/40 bg-card/60 px-3 py-2.5"
      data-testid={`queue-row-${vm.playerId}`}
      data-stage={vm.stage}
    >
      <TierRail tier={vm.stage} className="h-9" />
      <span className="text-xs font-bold tabular-nums text-muted-foreground/60 w-4 text-center shrink-0">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground truncate" data-testid={`text-queue-player-${vm.playerId}`}>
            {vm.playerName}
          </span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide shrink-0">{vm.team}</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className={`text-[9px] font-black uppercase tracking-wide ${t.text} shrink-0`}>
            {HR_PUBLIC_STAGE_LABEL[vm.stage]}
          </span>
          <div className="flex-1 max-w-[120px]">
            <HeatMeter score10={vm.score10} tier={vm.stage} compact />
          </div>
          {timing && <span className="text-[10px] text-muted-foreground/70 shrink-0">{timing}</span>}
        </div>
      </div>
      <span className={`text-base font-black tabular-nums shrink-0 ${t.text}`} data-testid={`text-queue-score-${vm.playerId}`}>
        {vm.scoreLabel}
      </span>
      <button
        onClick={onPrimary}
        className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-lg border ${t.border} ${t.text} hover:bg-background/60 active:scale-95 transition-all`}
        data-testid={`button-queue-primary-${vm.playerId}`}
        title={vm.primaryCtaLabel}
        aria-label={vm.primaryCtaLabel}
      >
        <Check className="w-4 h-4" />
      </button>
    </div>
  );
}

export function HrRadarDecisionQueue({
  items,
  onPrimary,
}: {
  items: HrRadarCardViewModel[];
  onPrimary: (vm: HrRadarCardViewModel) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="hr-decision-queue">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Decision Queue</span>
        <span className="text-[10px] text-muted-foreground/60">Next {items.length} to watch</span>
      </div>
      {items.map((vm, i) => (
        <QueueRow key={vm.id} vm={vm} rank={i + 1} onPrimary={() => onPrimary(vm)} />
      ))}
    </section>
  );
}
