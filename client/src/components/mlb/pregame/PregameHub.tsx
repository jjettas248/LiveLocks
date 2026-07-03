// MLB Pre-Game Hub — internal view switcher for The Plate | The Mound.
//
// The Plate renders the existing, unmodified PregamePowerRadar board. The
// Mound renders the new MoundPowerRadar board. Defaults to The Plate. This
// pill lives INSIDE the "Pre-Game" sub-tab, independent of the top-level MLB
// sub-tab plumbing (SportTabs.tsx) — same segmented-control CSS pattern.

import { useState } from "react";
import { PregamePowerRadar } from "../PregamePowerRadar";
import { MoundPowerRadar } from "../MoundPowerRadar";

type PregameView = "plate" | "mound";

const SUB_BASE = "px-4 py-2 rounded-lg text-xs font-semibold transition-all";
const SUB_ACTIVE = "bg-background text-foreground shadow-surface-sm";
const SUB_INACTIVE = "text-muted-foreground hover:text-foreground";

export function PregameHub({ selectedGameId = null }: { selectedGameId?: string | null } = {}) {
  const [view, setView] = useState<PregameView>("plate");

  return (
    <div className="space-y-4" data-testid="section-pregame-hub">
      <div>
        <h2 className="text-lg font-bold">Pre-Game Radar</h2>
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
