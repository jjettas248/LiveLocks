// HR Radar — stage-movement toast. When a player advances up the ladder
// (BUILD→READY, →FIRE), a small animated banner fires once. This is the
// "product hit" before the bet hits — dopamine from REAL signal movement, not
// fake urgency. Movement is detected by diffing the server-stamped stage across
// payloads (never by re-deriving stage). PRESENTATION ONLY.

import { useEffect, useState } from "react";
import { Zap, Flame } from "lucide-react";
import { hrTierTheme } from "@/components/mlb/hrRadarVisuals";
import { HR_PUBLIC_STAGE_LABEL, type HrPublicStage } from "@/lib/mlb/hrRadarViewModel";

export interface StageMovement {
  id: string;
  playerName: string;
  from: HrPublicStage;
  to: HrPublicStage;
  reason?: string;
}

function ToastRow({ m, onDone }: { m: StageMovement; onDone: (id: string) => void }) {
  const t = hrTierTheme(m.to);
  const Icon = m.to === "fire" ? Flame : Zap;
  useEffect(() => {
    const timer = window.setTimeout(() => onDone(m.id), 4200);
    return () => window.clearTimeout(timer);
  }, [m.id, onDone]);
  return (
    <div
      className={`hr-stage-toast pointer-events-auto flex items-center gap-2.5 rounded-xl border ${t.border} ${t.cardTint} bg-card/95 backdrop-blur px-3.5 py-2.5 shadow-xl`}
      data-testid={`hr-stage-toast-${m.id}`}
      role="status"
    >
      <Icon className={`w-4 h-4 shrink-0 ${t.text}`} />
      <div className="min-w-0">
        <div className="text-sm font-bold text-foreground leading-tight">
          {m.playerName} moved to{" "}
          <span className={`${t.text} uppercase`}>{HR_PUBLIC_STAGE_LABEL[m.to]}</span>
        </div>
        {m.reason && <div className="text-[11px] text-muted-foreground leading-tight truncate">{m.reason}</div>}
      </div>
    </div>
  );
}

export function HrRadarStageToastHost({
  movements,
  onDismiss,
}: {
  movements: StageMovement[];
  onDismiss: (id: string) => void;
}) {
  // Show at most the 3 most recent movements so a burst doesn't wall the screen.
  const shown = movements.slice(-3);
  if (shown.length === 0) return null;
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[min(92vw,420px)] pointer-events-none"
      style={{ top: "max(12px, env(safe-area-inset-top, 12px))" }}
      data-testid="hr-stage-toast-host"
    >
      {shown.map((m) => (
        <ToastRow key={m.id} m={m} onDone={onDismiss} />
      ))}
    </div>
  );
}

// Pure movement detector — diff a previous (id→stage) snapshot against the
// current view models, returning only UPWARD moves into BUILD/READY/FIRE. No
// re-derivation: stages are read straight from the view models. Exported for
// unit testing.
const UPWARD_RANK: Record<HrPublicStage, number> = {
  missed: -1,
  cashed: -1,
  track: 0,
  build: 1,
  ready: 2,
  fire: 3,
};

export function detectStageMovements(
  prev: Map<string, HrPublicStage>,
  current: Array<{ id: string; playerName: string; stage: HrPublicStage; reason?: string }>,
): StageMovement[] {
  const out: StageMovement[] = [];
  for (const c of current) {
    const before = prev.get(c.id);
    if (before == null) continue; // brand-new row → not a "movement"
    if (before === c.stage) continue;
    // Only celebrate upward moves into an actionable tier.
    if (UPWARD_RANK[c.stage] > UPWARD_RANK[before] && UPWARD_RANK[c.stage] >= 1) {
      out.push({ id: c.id, playerName: c.playerName, from: before, to: c.stage, reason: c.reason });
    }
  }
  return out;
}
