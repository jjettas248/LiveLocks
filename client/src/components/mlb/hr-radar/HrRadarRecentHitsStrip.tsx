// HR Radar — "Today's Official Results" strip. Fire-only counts (never
// tracked/uncalled HRs) with a celebratory pulse when a fresh Signal Hit just
// landed this session. PRESENTATION ONLY.

import { Trophy } from "lucide-react";
import { CashCelebration } from "@/components/mlb/hrRadarVisuals";

export function HrRadarRecentHitsStrip({
  signalHits,
  officialMisses,
  freshCount = 0,
}: {
  /** Fire-tier cashes only — server-derived (decisionView.counts.fireHitsToday). */
  signalHits: number;
  /** Fire-tier no-HR resolutions only (decisionView.counts.fireMissesToday). */
  officialMisses: number;
  /** Number that just transitioned into a Signal Hit this session → celebrate. */
  freshCount?: number;
}) {
  if (signalHits === 0 && officialMisses === 0) return null;
  const celebrate = freshCount > 0;

  const inner = (
    <div
      className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2.5"
      data-testid="hr-recent-hits-strip"
    >
      <Trophy className="w-4 h-4 text-emerald-400 shrink-0" />
      <div className="min-w-0">
        <div className="text-[9px] font-bold uppercase tracking-wide text-emerald-400/80">
          Today&apos;s Official Results
        </div>
        <div className="text-sm font-bold text-emerald-300">
          {signalHits} Signal Hit{signalHits === 1 ? "" : "s"}
          {officialMisses > 0 && (
            <span className="text-muted-foreground font-medium"> · {officialMisses} Missed</span>
          )}
        </div>
      </div>
    </div>
  );

  return celebrate ? <CashCelebration testId="hr-recent-hits-celebrate">{inner}</CashCelebration> : inner;
}
