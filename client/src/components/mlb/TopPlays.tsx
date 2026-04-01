import { Flame } from "lucide-react";
import { MlbSignalCard, type MlbSignalData } from "./MlbSignalCard";

export function TopPlays({
  signals,
  onPlayerClick,
  onAddToSlip,
}: {
  signals: MlbSignalData[];
  onPlayerClick?: (gameId: string, playerId: string) => void;
  onAddToSlip?: (sig: MlbSignalData) => void;
}) {
  const sorted = [...signals].sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
  const topPlays = sorted.slice(0, 6);

  if (topPlays.length === 0) {
    return (
      <div className="rounded-xl p-4 space-y-3" style={{ background: "#0a0a0a", border: "1px solid #1a1a2e" }} data-testid="mlb-top-plays-monitoring">
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-bold text-white">Top Plays</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-400" />
          </span>
          <span className="text-xs font-semibold text-blue-400">Engine processing live markets</span>
        </div>
        <p className="text-[11px] text-muted-foreground">Switch to the Games tab to select any game and run manual calculations on player props while the engine evaluates all markets.</p>
      </div>
    );
  }

  const overPlays = topPlays.filter(s => s.recommendedSide === "OVER");
  const underPlays = topPlays.filter(s => s.recommendedSide === "UNDER");

  return (
    <div className="space-y-3" data-testid="mlb-top-plays">
      <div className="flex items-center gap-2 px-1">
        <Flame className="w-4 h-4 text-orange-400" />
        <span className="text-sm font-bold text-white">Top Plays</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400 font-semibold">{topPlays.length}</span>
      </div>

      {overPlays.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 px-1">
            <span className="w-2 h-2 rounded-full" style={{ background: "#22c55e" }} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#22c55e" }}>Over Plays</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {overPlays.map((sig, idx) => (
              <MlbSignalCard
                key={`over-${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`}
                sig={sig}
                variant="featured"
                onPlayerClick={onPlayerClick}
                onAddToSlip={onAddToSlip}
              />
            ))}
          </div>
        </div>
      )}

      {underPlays.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 px-1">
            <span className="w-2 h-2 rounded-full" style={{ background: "#3b82f6" }} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: "#3b82f6" }}>Under Plays</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {underPlays.map((sig, idx) => (
              <MlbSignalCard
                key={`under-${sig.gameId}-${sig.playerId}-${sig.market}-${idx}`}
                sig={sig}
                variant="featured"
                onPlayerClick={onPlayerClick}
                onAddToSlip={onAddToSlip}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
