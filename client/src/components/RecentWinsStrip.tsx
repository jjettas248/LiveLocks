import { CheckCircle, TrendingUp } from "lucide-react";

interface RecentWin {
  playerName: string;
  statLine: string;
  probability: number;
}

const RECENT_WINS: RecentWin[] = [
  { playerName: "Jayson Tatum", statLine: "Over 24.5 Pts", probability: 72 },
  { playerName: "Luka Dončić", statLine: "Over 8.5 Ast", probability: 68 },
  { playerName: "Anthony Edwards", statLine: "Over 22.5 Pts", probability: 74 },
];

export function RecentWinsStrip() {
  return (
    <div className="animate-fade-in-up" style={{ animationDelay: "400ms", animationFillMode: "both" }}>
      <div className="flex items-center gap-1.5 mb-2.5" data-testid="text-momentum-label">
        <TrendingUp className="w-3.5 h-3.5 text-emerald-400/70" />
        <span className="text-xs font-medium text-muted-foreground/80">
          Model is 3/3 on recent plays
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="strip-recent-wins">
        {RECENT_WINS.map((win, idx) => (
          <div
            key={idx}
            data-testid={`card-recent-win-${idx}`}
            className="flex items-center gap-3 rounded-lg border border-border/30 bg-card/60 px-3 py-2.5 opacity-75"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground/80 truncate">{win.playerName}</p>
              <p className="text-xs text-muted-foreground/70">{win.statLine} · {win.probability}%</p>
            </div>
            <span className="inline-flex items-center gap-1 shrink-0 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400/80">
              <CheckCircle className="w-3 h-3" />
              Won
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
