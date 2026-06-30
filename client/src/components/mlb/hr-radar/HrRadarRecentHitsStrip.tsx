// HR Radar — "Recent Hits" proof strip. Always-on social proof when cashed
// signals exist today: a single celebratory line ("🏆 3 HR cashed today") that
// rewards the loop and builds trust. PRESENTATION ONLY.

import { Trophy } from "lucide-react";
import type { HrRadarCardViewModel } from "@/lib/mlb/hrRadarViewModel";
import { CashCelebration } from "@/components/mlb/hrRadarVisuals";

export function HrRadarRecentHitsStrip({
  cashed,
  freshCount = 0,
}: {
  cashed: HrRadarCardViewModel[];
  /** Number that just transitioned into cashed this session → celebrate. */
  freshCount?: number;
}) {
  if (cashed.length === 0) return null;
  const names = cashed.slice(0, 3).map((c) => c.playerName).join(" · ");
  const celebrate = freshCount > 0;

  const inner = (
    <div
      className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2.5"
      data-testid="hr-recent-hits-strip"
    >
      <Trophy className="w-4 h-4 text-emerald-400 shrink-0" />
      <span className="text-sm font-bold text-emerald-300 shrink-0">
        {cashed.length} HR cashed today
      </span>
      {names && (
        <span className="text-xs text-emerald-200/70 truncate" data-testid="text-recent-hits-names">
          · {names}
        </span>
      )}
    </div>
  );

  return celebrate ? <CashCelebration testId="hr-recent-hits-celebrate">{inner}</CashCelebration> : inner;
}
