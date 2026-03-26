import { useState, useEffect, useRef } from "react";
import { useTopPlays } from "@/hooks/useTopPlays";

export function LiveUpdateToast() {
  const { data } = useTopPlays();
  const [toast, setToast] = useState<{ player: string; market: string; prob: number; sport: string } | null>(null);
  const seenIds = useRef(new Set<string>());

  useEffect(() => {
    if (!data?.plays?.length) return;
    const elitePlays = data.plays.filter(p => p.confidenceTier === "ELITE");
    for (const play of elitePlays) {
      if (!seenIds.current.has(play.id)) {
        seenIds.current.add(play.id);
        if (seenIds.current.size > 1) {
          setToast({ player: play.playerOrTeam, market: play.marketLabel, prob: Math.round(play.probability), sport: play.sport });
          setTimeout(() => setToast(null), 5000);
          break;
        }
      }
    }
  }, [data?.plays]);

  if (!toast) return null;

  return (
    <div
      data-testid="toast-live-update"
      className="fixed top-4 right-4 z-50 animate-in slide-in-from-right-5 bg-card border border-green-500/30 rounded-xl shadow-lg shadow-green-500/10 p-4 max-w-sm"
    >
      <div className="flex items-start gap-3">
        <span className="text-lg">🔥</span>
        <div className="min-w-0">
          <div className="text-xs font-bold text-green-400">New ELITE Edge</div>
          <div className="text-sm font-semibold text-foreground mt-0.5">{toast.player}</div>
          <div className="text-xs text-muted-foreground">{toast.market} — {toast.prob}% probability</div>
        </div>
        <button
          onClick={() => setToast(null)}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          ×
        </button>
      </div>
    </div>
  );
}
