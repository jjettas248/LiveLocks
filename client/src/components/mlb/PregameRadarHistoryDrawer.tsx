// Pre-Game Power Radar — historical daily drawer.
//
// Read-only view over the day-by-day Pregame Radar history endpoint. Renders
// server-stamped win rows verbatim via the shared PregameWinCard component.
//
// Mobile gets a bottom sheet (same treatment as the dashboard's Parlay Slip —
// see PregamePowerRadar.tsx's sibling dashboard.tsx:4219-4229), desktop gets a
// right-side panel — matching the app's existing overlay-position-differs-by-
// viewport convention instead of one fixed-width sheet for every screen.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { PregameWinCard } from "./PregameWinCard";
import type { PregameRadarDailyHistoryEntry } from "@shared/pregameRadarWin";

function formatDateET(dateET: string): string {
  const [y, m, d] = dateET.split("-").map(Number);
  if (!y || !m || !d) return dateET;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function DayEntry({ entry }: { entry: PregameRadarDailyHistoryEntry }) {
  return (
    <div className="space-y-2" data-testid={`pregame-history-day-${entry.dateET}`}>
      <div className="flex items-baseline justify-between">
        <h4 className="text-sm font-bold">{formatDateET(entry.dateET)}</h4>
        <div className="text-[11px] text-muted-foreground">
          {entry.pregameWinsCount} Wins
          {entry.firstAbPregameWinsCount > 0 && ` · ${entry.firstAbPregameWinsCount} First-AB`}
          {" · "}
          {entry.flaggedBeforeFirstPitch} Flagged
        </div>
      </div>
      {entry.wins.length > 0 ? (
        <div className="grid gap-2">
          {entry.wins.map((w) => (
            <PregameWinCard key={w.signalId} win={w} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          No HRs from this day's flagged targets.
        </div>
      )}
    </div>
  );
}

export function PregameRadarHistoryDrawer() {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const { data, isLoading } = useQuery<PregameRadarDailyHistoryEntry[]>({
    queryKey: ["/api/mlb/pregame-radar/history"],
    enabled: open,
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 py-1 text-[11px] text-emerald-300 hover:text-emerald-200 transition-colors"
          data-testid="button-pregame-radar-history"
        >
          <History className="w-3.5 h-3.5" />
          History
        </button>
      </SheetTrigger>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={
          isMobile
            ? "w-full max-h-[85dvh] rounded-t-2xl flex flex-col overflow-hidden"
            : "w-full max-w-md overflow-y-auto"
        }
        style={isMobile ? { paddingBottom: "env(safe-area-inset-bottom, 0px)" } : undefined}
      >
        <SheetHeader>
          <SheetTitle>Pregame Radar History</SheetTitle>
        </SheetHeader>
        <div
          className={`mt-4 space-y-5 ${isMobile ? "overflow-y-auto" : ""}`}
          data-testid="pregame-radar-history-list"
        >
          {isLoading && (
            <div className="text-xs text-muted-foreground">Loading history…</div>
          )}
          {!isLoading && (!data || data.length === 0) && (
            <div className="text-xs text-muted-foreground">No history yet.</div>
          )}
          {(data ?? []).map((entry) => (
            <DayEntry key={entry.dateET} entry={entry} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
