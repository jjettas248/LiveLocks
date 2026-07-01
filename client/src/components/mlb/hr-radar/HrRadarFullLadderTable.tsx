// HR Radar — Full Ladder. Sectioned card grid: every entry renders through the
// same premium LadderCard used by the signal-detail drawer, grouped under
// section headers (FIRE → READY → BUILD → TRACK → CASHED → MISSED) so the
// highest-to-lowest hierarchy is explicit rather than an internal sort the
// user has to infer. PRESENTATION ONLY — every field reads the canonical view
// model / raw entry (engine truth); this file adds no scoring, staging, or
// probability logic.

import { LadderCard, SECTION_META, stageToSectionKey, type SectionKey } from "@/components/mlb/HrRadarLadder";
import { compareByImportance, type HrRadarCardViewModel, type HrPublicStage } from "@/lib/mlb/hrRadarViewModel";
import type { MlbSignalData } from "@/components/mlb/MlbSignalCard";
import type { HrRadarLadderEntry } from "@/components/mlb/HrRadarLadder";
import { hrTierTheme } from "@/components/mlb/hrRadarVisuals";

// Canonical display order — mirrors the order HrRadarLadder already builds
// `tableRows` in (fire → ready → build → track → cashed → missed).
const STAGE_ORDER: HrPublicStage[] = ["fire", "ready", "build", "track", "cashed", "missed"];

export interface HrRadarFullLadderTableProps {
  rows: HrRadarCardViewModel[];
  onRowClick: (vm: HrRadarCardViewModel) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
  onOpenDetails?: (entry: HrRadarLadderEntry) => void;
  onPass?: (entry: HrRadarLadderEntry) => void;
  onAccept?: (entry: HrRadarLadderEntry) => void;
  isAccepted?: (entry: HrRadarLadderEntry) => boolean;
  /** Cross-tier board priority pick (`selectTopPriority`) — the one row that
   * earns the "top priority" ribbon regardless of which section it lands in. */
  topPriorityId?: string | null;
}

export function HrRadarFullLadderTable({
  rows,
  onRowClick,
  onAddToSlip,
  onOpenDetails,
  onPass,
  onAccept,
  isAccepted,
  topPriorityId = null,
}: HrRadarFullLadderTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-card/40 p-6 text-center text-sm text-muted-foreground" data-testid="ladder-table-empty">
        No HR radar signals to show.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="hr-ladder-table">
      {STAGE_ORDER.map((stage) => {
        // Intelligent in-section order: stage-weighted sortRank (score, then
        // momentum/urgency tie-breakers) rather than a flat score-only sort —
        // see hrRadarViewModel's compareByImportance for the single formula
        // both this table and the Quick Decide Hot Seat read.
        const groupRows = rows
          .filter((vm) => vm.stage === stage)
          .sort(compareByImportance);
        if (groupRows.length === 0) return null;

        const section: SectionKey = stageToSectionKey(stage);
        const meta = SECTION_META[section];
        const SectionIcon = meta.icon;
        const t = hrTierTheme(stage);

        return (
          <section key={stage} data-testid={`ladder-section-${stage}`}>
            <div className="flex items-center gap-2 px-1 mb-2">
              <SectionIcon className={`w-4 h-4 ${t.text}`} aria-hidden="true" />
              <h3 className={`text-xs font-black uppercase tracking-wide ${t.text}`}>{meta.label}</h3>
              <span className="text-[11px] text-muted-foreground truncate">{meta.sublabel}</span>
              <span
                className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground shrink-0"
                data-testid={`ladder-section-count-${stage}`}
              >
                {groupRows.length}
              </span>
            </div>
            <div className="grid gap-2.5">
              {groupRows.map((vm) => (
                <LadderCard
                  key={vm.id}
                  entry={vm.entry}
                  section={section}
                  onAddToSlip={onAddToSlip}
                  onOpenDetails={onOpenDetails}
                  onPass={onPass}
                  onAccept={onAccept}
                  isAccepted={isAccepted ? isAccepted(vm.entry) : false}
                  onOpenDrawer={() => onRowClick(vm)}
                  isTopPriority={topPriorityId != null && vm.id === topPriorityId}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
