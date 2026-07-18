// HR Radar — compact queue rows shared by every non-hero list in Quick
// Decide: remaining Fire calls, remaining Ready players, and the Forming
// Signals (Build + Watch) background list. PRESENTATION ONLY — reads the
// canonical view model; never derives a stage or invents a CTA.

import { Check } from "lucide-react";
import type { HrRadarCardViewModel } from "@/lib/mlb/hrRadarViewModel";
import { HR_PUBLIC_STAGE_LABEL } from "@/lib/mlb/hrRadarViewModel";
import { hrTierTheme, TierRail } from "@/components/mlb/hrRadarVisuals";
import { HR_RADAR_FORMING_SIGNALS_COPY } from "@/components/mlb/hrRadarConsumerCopy";

// Quick Decide never shows a numeric score, percentage, or progress meter —
// a filled meter reads as an HR-probability signal regardless of its label,
// which defeats the point as much as the raw number would. `QueueRow` is
// used ONLY inside Quick Decide (compact Fire/Ready rows + the Forming
// Signals list), so it never renders one; Full Ladder has its own row
// renderer (LadderCard) for the deeper-diagnostics surface where a score is
// appropriate.
export function QueueRow({
  vm,
  rank,
  onPrimary,
}: {
  vm: HrRadarCardViewModel;
  rank: number;
  onPrimary: () => void;
}) {
  const t = hrTierTheme(vm.stage);
  const timing = vm.inningLabel ?? vm.nextPaLabel ?? "";
  const hasCta = vm.primaryCta !== "none";
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
          {vm.headline && (
            <span className="text-[10px] text-muted-foreground truncate">{vm.headline}</span>
          )}
          {timing && <span className="text-[10px] text-muted-foreground/70 shrink-0">{timing}</span>}
        </div>
      </div>
      {/* Build/Watch rows have NO CTA at all per the consumer action matrix —
          no button, not even a disabled one, so there is never an ambiguous
          checkmark on a non-actionable row. */}
      {hasCta && (
        <button
          onClick={onPrimary}
          className={`shrink-0 flex items-center justify-center h-8 px-2.5 gap-1 rounded-lg border ${t.border} ${t.text} hover:bg-background/60 active:scale-95 transition-all text-[11px] font-bold`}
          data-testid={`button-queue-primary-${vm.playerId}`}
          title={vm.primaryCtaLabel}
        >
          <Check className="w-3.5 h-3.5" /> {vm.primaryCtaLabel}
        </button>
      )}
    </div>
  );
}

export function HrRadarDecisionQueue({
  items,
  onPrimary,
  title = HR_RADAR_FORMING_SIGNALS_COPY.section,
  subtitle = HR_RADAR_FORMING_SIGNALS_COPY.description,
}: {
  items: HrRadarCardViewModel[];
  onPrimary: (vm: HrRadarCardViewModel) => void;
  title?: string;
  subtitle?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2" data-testid="hr-decision-queue">
      <div className="px-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{title}</span>
          <span className="text-[10px] text-muted-foreground/60">Next {items.length}</span>
        </div>
        <p className="text-[10px] text-muted-foreground/70">{subtitle}</p>
      </div>
      {items.map((vm, i) => (
        <QueueRow key={vm.id} vm={vm} rank={i + 1} onPrimary={() => onPrimary(vm)} />
      ))}
    </section>
  );
}
