// Pre-Game Power Radar — Win History drawer (aesthetic, additive UI only).
//
// A "file drawer" pinned to the left edge: a vertical pull-tab opens a Sheet
// listing recent dates with that day's Pregame Radar win total. Expanding a
// date reveals the same win cards used on the live board, all server-stamped
// — this component never derives win/loss itself, it just re-renders data
// from the existing /api/mlb/pregame-radar/record endpoint per date.

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, FolderOpen, Trophy } from "lucide-react";
import { PregameWinCard } from "./PregameWinCard";
import type { PregameRadarPublicStats } from "@shared/pregameRadarWin";

const HISTORY_DAYS = 21;

function lastNDatesET(n: number): string[] {
  const fmt = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; out.length < n && i < n + 5; i++) {
    const key = fmt(new Date(Date.now() - i * 86_400_000));
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function formatDateLabel(dateET: string): string {
  const [y, m, d] = dateET.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function PregameHistoryDrawer() {
  const [open, setOpen] = useState(false);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const dates = useMemo(() => lastNDatesET(HISTORY_DAYS), []);

  const results = useQueries({
    queries: dates.map((date) => ({
      queryKey: [`/api/mlb/pregame-radar/record?date=${date}`],
      enabled: open,
      staleTime: 5 * 60_000,
    })),
  });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        data-testid="button-open-pregame-history"
        className="fixed left-0 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-1.5 px-1.5 py-3 rounded-r-lg bg-secondary/90 border border-l-0 border-border/60 text-muted-foreground hover:text-amber-200 hover:bg-amber-500/10 transition-colors shadow-lg"
      >
        <FolderOpen className="w-3.5 h-3.5" />
        <span className="text-[10px] font-semibold tracking-wide [writing-mode:vertical-rl]">
          Win History
        </span>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          className="w-full sm:max-w-md overflow-y-auto"
          data-testid="drawer-pregame-history"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-amber-400" />
              Pregame Radar Win History
            </SheetTitle>
          </SheetHeader>

          <div className="mt-4 space-y-1.5">
            {dates.map((date, i) => {
              const query = results[i];
              const data = query?.data as PregameRadarPublicStats | undefined;
              const wins = data?.pregameWinsToday ?? 0;
              const isExpanded = expandedDate === date;
              return (
                <div
                  key={date}
                  className="rounded-lg border border-border/50 overflow-hidden"
                  data-testid={`pregame-history-day-${date}`}
                >
                  <button
                    onClick={() => setExpandedDate(isExpanded ? null : date)}
                    data-testid={`button-pregame-history-day-${date}`}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-secondary/40 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                      )}
                      {formatDateLabel(date)}
                    </span>
                    {query?.isLoading ? (
                      <span className="text-[11px] text-muted-foreground">…</span>
                    ) : wins > 0 ? (
                      <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-400/30 gap-1">
                        <Trophy className="w-3 h-3" /> {wins} {wins === 1 ? "Win" : "Wins"}
                      </Badge>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/60">No wins</span>
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2 bg-secondary/10">
                      {(data?.topPregameWinPlayers?.length ?? 0) === 0 ? (
                        <p className="text-xs text-muted-foreground py-2">
                          No pregame radar wins this day.
                        </p>
                      ) : (
                        data!.topPregameWinPlayers.map((w) => <PregameWinCard key={w.signalId} win={w} />)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
