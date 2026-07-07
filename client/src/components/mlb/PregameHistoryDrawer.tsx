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
import { AlertCircle, ChevronDown, ChevronRight, FolderOpen, Trophy } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { PregameWinCard } from "./PregameWinCard";
import type { PregameRadarPublicStats } from "@shared/pregameRadarWin";
import { formatPlainDateLabel } from "@shared/dateLabel";
import { slateDaysAgoET } from "@shared/slateDate";

const HISTORY_DAYS = 21;

/**
 * Slate-day (6am-ET rollover) dates going back from "now", newest first.
 * Must match slateDateET() — the same convention every pregame signal's
 * sessionDate is stamped with server-side — since the record endpoint does
 * an exact string match on the requested date. A plain midnight-ET calendar
 * walk here would query the wrong slate during the 12am-6am ET window.
 */
function lastNDatesET(n: number): string[] {
  return Array.from({ length: n }, (_, i) => slateDaysAgoET(i));
}

export function PregameHistoryDrawer() {
  const [open, setOpen] = useState(false);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const dates = useMemo(() => lastNDatesET(HISTORY_DAYS), []);
  const isMobile = useIsMobile();

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
          side={isMobile ? "bottom" : "left"}
          className={
            isMobile
              ? "w-full max-h-[85dvh] rounded-t-2xl flex flex-col overflow-hidden"
              : "w-full max-w-md overflow-y-auto"
          }
          style={isMobile ? { paddingBottom: "env(safe-area-inset-bottom, 0px)" } : undefined}
          data-testid="drawer-pregame-history"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5 text-amber-400" />
              Pregame Radar Win History
            </SheetTitle>
          </SheetHeader>

          <div className={`mt-4 space-y-1.5 ${isMobile ? "overflow-y-auto" : ""}`}>
            {dates.map((date, i) => {
              const query = results[i];
              const data = query?.data as PregameRadarPublicStats | undefined;
              const wins = data?.pregameWinsToday ?? 0;
              const failed = Boolean(query?.isError) || data?.degraded === true;
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
                      {formatPlainDateLabel(date)}
                    </span>
                    {query?.isLoading ? (
                      <span className="text-[11px] text-muted-foreground">…</span>
                    ) : failed ? (
                      <span className="flex items-center gap-1 text-[11px] text-amber-400/80">
                        <AlertCircle className="w-3 h-3" /> Couldn't load
                      </span>
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
                      {failed ? (
                        <p className="text-xs text-amber-400/80 py-2">
                          Couldn't load this day's data.
                        </p>
                      ) : (data?.topPregameWinPlayers?.length ?? 0) === 0 ? (
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
