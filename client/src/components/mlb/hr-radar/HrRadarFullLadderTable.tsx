// HR Radar — Full Ladder compact command table. The power-user research view:
// dense, sortable rows instead of giant expanded cards. Clicking a row opens
// the deep diagnostic drawer. PRESENTATION ONLY — every cell reads the canonical
// view model (engine truth). Raw diagnostics (RDY/HR%/PVUL/peak) live in the
// drawer, never here.

import { useState } from "react";
import { ChevronRight, ArrowUpDown } from "lucide-react";
import type { HrRadarCardViewModel, HrPublicStage } from "@/lib/mlb/hrRadarViewModel";
import { HR_PUBLIC_STAGE_LABEL, compareByImportance } from "@/lib/mlb/hrRadarViewModel";
import { hrTierTheme, TierRail } from "@/components/mlb/hrRadarVisuals";

type SortKey = "stage" | "score" | "player";

const STATUS_LABEL: Record<HrPublicStage, string> = {
  fire: "Live",
  ready: "Watch",
  build: "Track",
  track: "Track",
  cashed: "Cashed",
  missed: "Missed",
};

function inningSortValue(vm: HrRadarCardViewModel): number {
  const inn = vm.entry.currentInning ?? vm.entry.detectedInning ?? 99;
  return inn;
}

function StageCell({ vm }: { vm: HrRadarCardViewModel }) {
  const t = hrTierTheme(vm.stage);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <TierRail tier={vm.stage} className="h-5" />
      <span className={`text-[11px] font-black uppercase tracking-wide ${t.text}`}>
        {HR_PUBLIC_STAGE_LABEL[vm.stage]}
      </span>
    </div>
  );
}

function HeaderCell({
  label,
  sortKey,
  active,
  onSort,
  className = "",
  align = "left",
}: {
  label: string;
  sortKey?: SortKey;
  active?: boolean;
  onSort?: (k: SortKey) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const content = (
    <span className={`inline-flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>
      {label}
      {sortKey && <ArrowUpDown className={`w-3 h-3 ${active ? "text-foreground" : "text-muted-foreground/40"}`} />}
    </span>
  );
  return (
    <th
      className={`px-2 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground ${align === "right" ? "text-right" : "text-left"} ${sortKey ? "cursor-pointer hover:text-foreground" : ""} ${className}`}
      onClick={sortKey && onSort ? () => onSort(sortKey) : undefined}
      data-testid={sortKey ? `ladder-th-${sortKey}` : undefined}
    >
      {content}
    </th>
  );
}

export function HrRadarFullLadderTable({
  rows,
  onRowClick,
}: {
  rows: HrRadarCardViewModel[];
  onRowClick: (vm: HrRadarCardViewModel) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("stage");
  const [asc, setAsc] = useState(false);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else { setSortKey(k); setAsc(k === "player"); }
  };

  const sorted = [...rows].sort((a, b) => {
    let cmp = 0;
    if (sortKey === "stage") cmp = compareByImportance(a, b) || inningSortValue(a) - inningSortValue(b);
    else if (sortKey === "score") cmp = b.score10 - a.score10;
    else cmp = a.playerName.localeCompare(b.playerName);
    return asc ? -cmp : cmp;
  });

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border/40 bg-card/40 p-6 text-center text-sm text-muted-foreground" data-testid="ladder-table-empty">
        No HR radar signals to show.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border/40 bg-card/40 overflow-hidden" data-testid="hr-ladder-table">
      <table className="w-full border-collapse">
        <thead className="bg-muted/20 border-b border-border/40">
          <tr>
            <HeaderCell label="Stage" sortKey="stage" active={sortKey === "stage"} onSort={onSort} />
            <HeaderCell label="Player" sortKey="player" active={sortKey === "player"} onSort={onSort} />
            <HeaderCell label="Score" sortKey="score" active={sortKey === "score"} onSort={onSort} align="right" />
            <HeaderCell label="Next PA" className="hidden sm:table-cell" align="right" />
            <HeaderCell label="Last Trigger" className="hidden md:table-cell" />
            <HeaderCell label="Drivers" className="hidden lg:table-cell" />
            <HeaderCell label="Status" className="hidden sm:table-cell" align="right" />
            <th className="w-6" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((vm) => {
            const t = hrTierTheme(vm.stage);
            const nextPa = vm.inningLabel ?? vm.nextPaLabel ?? "—";
            return (
              <tr
                key={vm.id}
                onClick={() => onRowClick(vm)}
                className="border-b border-border/20 last:border-0 hover:bg-muted/20 cursor-pointer transition-colors"
                data-testid={`ladder-table-row-${vm.playerId}`}
                data-stage={vm.stage}
              >
                <td className="px-2 py-2.5"><StageCell vm={vm} /></td>
                <td className="px-2 py-2.5 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-sm font-semibold text-foreground truncate" data-testid={`ladder-table-player-${vm.playerId}`}>
                      {vm.playerName}
                    </span>
                    <span className="text-[9px] text-muted-foreground uppercase shrink-0">{vm.team}</span>
                  </div>
                  {/* Mobile-only inline meta (columns hidden < sm). */}
                  <div className="sm:hidden text-[10px] text-muted-foreground/70 truncate">
                    {nextPa !== "—" ? `${nextPa} · ` : ""}{STATUS_LABEL[vm.stage]}
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right">
                  <span className={`text-sm font-black tabular-nums ${t.text}`}>{vm.scoreLabel}</span>
                  {vm.hrChancePct != null && (
                    <div className="text-[9px] font-semibold text-muted-foreground tabular-nums" data-testid={`ladder-table-hrchance-${vm.playerId}`}>
                      {Math.round(vm.hrChancePct)}% HR
                    </div>
                  )}
                </td>
                <td className="px-2 py-2.5 text-right hidden sm:table-cell">
                  <span className="text-xs tabular-nums text-muted-foreground">{nextPa}</span>
                </td>
                <td className="px-2 py-2.5 hidden md:table-cell">
                  <span className="text-xs text-muted-foreground truncate block max-w-[180px]">{vm.headline || "—"}</span>
                </td>
                <td className="px-2 py-2.5 hidden lg:table-cell">
                  <div className="flex flex-wrap gap-1 max-w-[220px]">
                    {vm.driverChips.length > 0
                      ? vm.driverChips.map((c) => (
                          <span key={c} className={`text-[8px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${t.chip}`}>
                            {c}
                          </span>
                        ))
                      : <span className="text-xs text-muted-foreground/50">—</span>}
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right hidden sm:table-cell">
                  <span className={`text-[10px] font-bold uppercase tracking-wide ${t.text}`}>{STATUS_LABEL[vm.stage]}</span>
                </td>
                <td className="px-1 py-2.5 text-right">
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40 inline" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
