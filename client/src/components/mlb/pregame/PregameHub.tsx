// MLB Pre-Game Hub — internal view switcher for The Plate | The Mound.
//
// The Plate renders the existing, unmodified PregamePowerRadar board. The
// Mound renders the new MoundPowerRadar board. Defaults to The Plate. This
// pill lives INSIDE the "Pre-Game" sub-tab, independent of the top-level MLB
// sub-tab plumbing (SportTabs.tsx) — same segmented-control CSS pattern.
//
// Also fetches /api/mlb/pregame-hub for the slate-wide status badge below —
// each board still independently fetches its own target list (proven,
// regression-tested), this is additive and never feeds board rendering.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PregamePowerRadar } from "../PregamePowerRadar";
import { MoundPowerRadar } from "../MoundPowerRadar";
import type { MlbPregameHubResponse } from "@shared/mlbPregameHub";

type PregameView = "plate" | "mound";

const SUB_BASE = "px-4 py-2 rounded-lg text-xs font-semibold transition-all";
const SUB_ACTIVE = "bg-background text-foreground shadow-surface-sm";
const SUB_INACTIVE = "text-muted-foreground hover:text-foreground";

export function PregameHub({ selectedGameId = null }: { selectedGameId?: string | null } = {}) {
  const [view, setView] = useState<PregameView>("plate");

  const { data: hub } = useQuery<MlbPregameHubResponse>({
    queryKey: ["/api/mlb/pregame-hub"],
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  return (
    <div className="space-y-4" data-testid="section-pregame-hub">
      <div>
        <h2 className="text-lg font-bold flex items-center gap-2">
          Pre-Game Radar
          {hub?.slateStatus === "in_progress" && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-400"
              data-testid="pregame-hub-slate-live"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Live
            </span>
          )}
          {hub?.slateStatus === "final" && (
            <span className="text-[10px] font-semibold text-muted-foreground" data-testid="pregame-hub-slate-final">
              Final
            </span>
          )}
        </h2>
      </div>

      <div className="flex gap-1 w-fit bg-secondary/40 border border-border/60 rounded-xl p-1">
        <button
          data-testid="pill-pregame-plate"
          onClick={() => setView("plate")}
          className={`${SUB_BASE} ${view === "plate" ? SUB_ACTIVE : SUB_INACTIVE}`}
        >
          The Plate
        </button>
        <button
          data-testid="pill-pregame-mound"
          onClick={() => setView("mound")}
          className={`${SUB_BASE} ${view === "mound" ? SUB_ACTIVE : SUB_INACTIVE}`}
        >
          The Mound
        </button>
      </div>

      {view === "plate" ? (
        <PregamePowerRadar selectedGameId={selectedGameId} />
      ) : (
        <MoundPowerRadar selectedGameId={selectedGameId} />
      )}
    </div>
  );
}
