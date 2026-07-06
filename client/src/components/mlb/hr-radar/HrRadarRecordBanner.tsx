// HR Radar Record banner — aggregate, same-day trust signal. Mirrors
// PregameRadarRecord/MoundRadarRecord (PregameWinCard.tsx/MoundWinCard.tsx):
// one self-hiding Card, a bold title, one flex-wrap row of plain-text stats.
// Client-only — derives every stat from the already-fetched
// /api/mlb/hr-radar/ladder response (same queryKey the ladder/Quick Decide
// use, so this never triggers an extra network request). No 7-day trailing
// stat: that needs server-side history this endpoint doesn't carry.

import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Trophy } from "lucide-react";
import type { HrRadarLadderResponse } from "@/components/mlb/HrRadarLadder";

export function HrRadarRecordBanner() {
  const { data } = useQuery<HrRadarLadderResponse>({
    queryKey: ["/api/mlb/hr-radar/ladder"],
    placeholderData: (prev) => prev,
  });

  if (!data) return null;

  // A `called_hit` outcome is intentionally kept in its pre-hit live section
  // (attackNow/ready/building/watch) until the inning advances, so a cash
  // that just happened this inning has `counts.cashed === 0` and doesn't yet
  // appear in `sections.cashed` — scan every section's `outcome` field
  // (set verbatim server-side, unaffected by which section the row sits in)
  // rather than only the cashed bucket, or a same-inning cash would hide.
  const allEntries = [
    ...data.sections.attackNow,
    ...(data.sections.ready ?? []),
    ...data.sections.building,
    ...data.sections.watch,
    ...data.sections.cashed,
  ];
  const cashedEntries = allEntries.filter((e) => e.outcome === "called_hit");
  const cashedToday = cashedEntries.length;
  if (cashedToday === 0) return null;

  const earlyCallsToday = cashedEntries.filter((e) => e.alertPath === "early").length;
  const liveNow =
    data.counts.attackNow + data.counts.building + data.counts.watch + (data.counts.ready ?? 0);

  return (
    <Card className="p-3 bg-emerald-500/10 border-emerald-400/30" data-testid="hr-radar-record">
      <div className="flex items-center gap-2 mb-1.5">
        <Trophy className="w-4 h-4 text-emerald-300" />
        <span className="text-sm font-bold text-emerald-200">HR Radar Record</span>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <RecordStat value={cashedToday} label="Cashed Today" testid="hr-record-cashed-today" />
        {earlyCallsToday > 0 && (
          <RecordStat value={earlyCallsToday} label="Early Calls" testid="hr-record-early-today" />
        )}
        {liveNow > 0 && <RecordStat value={liveNow} label="Live Now" testid="hr-record-live-now" muted />}
      </div>
    </Card>
  );
}

function RecordStat({
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
