// MLB Mound Radar — Record panel (public, wins-only).
//
// Mirrors PregameWinCard.tsx's MoundRadarRecord role. "Pitcher Props Cashed"
// replaces "First-AB Cashes" — The Mound has no per-AB concept, so it must
// NEVER render First-AB Cashes.

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Trophy } from "lucide-react";

interface MoundRadarPublicStats {
  dateET: string;
  moundWinsToday: number;
  pitcherPropsCashedToday: number;
  moundWinsLast7Days: number;
  flaggedBeforeFirstPitchToday: number;
}

function slateDateET(): string {
  const now = new Date();
  const hourET = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  ) % 24;
  const d = new Date(now);
  if (hourET < 6) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Mound Radar Record banner — "{wins} Wins Today · {cashed} Pitcher Props
 * Cashed · {flagged} Flagged Before First Pitch". Hidden until there is
 * something to show (no zero-state shouting "0 wins").
 */
export function MoundRadarRecord() {
  const { data } = useQuery<MoundRadarPublicStats>({
    queryKey: ["/api/mlb/mound-radar/record", slateDateET()],
    queryFn: () => apiRequest("GET", "/api/mlb/mound-radar/record").then((r) => r.json()),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

  if (!data || data.flaggedBeforeFirstPitchToday === 0) return null;

  return (
    <Card className="p-3 bg-emerald-500/10 border-emerald-400/30" data-testid="mound-radar-record">
      <div className="flex items-center gap-2 mb-1.5">
        <Trophy className="w-4 h-4 text-emerald-300" />
        <span className="text-sm font-bold text-emerald-200">Mound Radar Record</span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <Stat value={data.moundWinsToday} label="Wins Today" testid="mound-record-wins-today" />
        <Stat
          value={data.pitcherPropsCashedToday}
          label="Pitcher Props Cashed"
          testid="mound-record-props-cashed-today"
        />
        <Stat
          value={data.flaggedBeforeFirstPitchToday}
          label="Flagged Before First Pitch"
          testid="mound-record-flagged-today"
        />
        <Stat value={data.moundWinsLast7Days} label="Wins (7d)" testid="mound-record-wins-7d" muted />
      </div>
    </Card>
  );
}

function Stat({
  value,
  label,
  testid,
  muted = false,
}: {
  value: number;
  label: string;
  testid: string;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "opacity-70" : undefined}>
      <span className="font-bold text-emerald-100" data-testid={testid}>
        {value}
      </span>{" "}
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}
