// MLB Pre-Game Power Radar — Win Attribution row card (public, wins-only).
//
// Direction 2 product rule: a pre-game target that homers is a public Pregame
// Radar Win; a target that misses is calibration-only and is NEVER rendered
// here. The server stamps label / cardCopy / drivers; the UI renders verbatim
// and never derives win/loss or shows "Loss / Missed / -units".
//
// The only rendering surface for wins is the Win History drawer
// (PregameHistoryDrawer.tsx), which reuses PregameWinCard below.

import { Card } from "@/components/ui/card";
import { Flame, Target } from "lucide-react";
import type { PregameRadarWinItem } from "@shared/pregameRadarWin";

function inningText(win: PregameRadarWinItem): string | null {
  if (win.hrInning == null) return null;
  const half = win.hrHalf === "top" ? "Top" : win.hrHalf === "bottom" ? "Bot" : "";
  return `${half} ${win.hrInning}`.trim();
}

/** One public Pregame Radar Win row. Renders server-stamped label/copy verbatim. */
export function PregameWinCard({ win }: { win: PregameRadarWinItem }) {
  const firstAb = win.firstAbPregameWin;
  const inning = inningText(win);
  return (
    <Card
      className={`p-3 ${
        firstAb ? "bg-amber-500/10 border-amber-400/40" : "bg-emerald-500/10 border-emerald-400/30"
      }`}
      data-testid={`pregame-win-${win.signalId}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {firstAb ? (
              <Flame className="w-3.5 h-3.5 text-amber-300 shrink-0" />
            ) : (
              <Target className="w-3.5 h-3.5 text-emerald-300 shrink-0" />
            )}
            <span
              className={`text-[10px] font-bold tracking-wide ${
                firstAb ? "text-amber-200" : "text-emerald-200"
              }`}
              data-testid={`pregame-win-label-${win.signalId}`}
            >
              {win.label}
            </span>
          </div>
          <div className="text-sm font-semibold mt-0.5 truncate">
            {win.playerName}
            <span className="text-muted-foreground font-normal">
              {" "}
              · {win.team} vs {win.opponent}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{win.cardCopy}</div>
          {win.pregameDrivers.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {win.pregameDrivers.slice(0, 3).map((d) => (
                <span
                  key={d.key}
                  className="px-1.5 py-0.5 rounded bg-secondary/50 text-[10px] text-muted-foreground"
                >
                  {d.label}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          {inning && (
            <div className="text-[11px] font-medium text-emerald-200" data-testid={`pregame-win-inning-${win.signalId}`}>
              HR {inning}
            </div>
          )}
          {win.pregameRank != null && (
            <div className="text-[10px] text-muted-foreground">Pregame #{win.pregameRank}</div>
          )}
          {win.becameLiveFire && (
            <div className="text-[10px] text-orange-300 mt-0.5">→ live FIRE</div>
          )}
        </div>
      </div>
    </Card>
  );
}
