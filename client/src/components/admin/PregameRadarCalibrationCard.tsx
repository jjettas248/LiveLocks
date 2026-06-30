// Admin-only Pregame Radar calibration panel.
//
// Shows the FULL denominator (wins AND calibration misses) so the true
// target→HR conversion is visible internally. Admin surface only — these are
// proxy metrics, never official ROI / W-L. Public users never see misses.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Target } from "lucide-react";
import type {
  PregameRadarCalibrationStats,
  PregameCalibrationBucket,
} from "@shared/pregameRadarWin";

function pctStr(v: number): string {
  return `${v}%`;
}

function StatCell({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-border/50 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-bold">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function BucketTable({
  title,
  buckets,
}: {
  title: string;
  buckets: Record<string, PregameCalibrationBucket>;
}) {
  const rows = Object.entries(buckets).sort((a, b) => b[1].targets - a[1].targets);
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="text-sm font-medium mb-1.5">{title}</div>
      <div className="space-y-0.5">
        {rows.map(([key, b]) => (
          <div
            key={key}
            className="grid grid-cols-[1fr_auto_auto_auto] gap-2 text-[11px] items-center"
            data-testid={`pregame-cal-bucket-${key}`}
          >
            <span className="truncate text-muted-foreground">{key}</span>
            <span>{b.targets} tgt</span>
            <span className="text-emerald-400">{b.wins}W</span>
            <span className="font-semibold w-12 text-right">{pctStr(b.hitRate)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PregameRadarCalibrationCard() {
  const { data, isLoading } = useQuery<PregameRadarCalibrationStats>({
    queryKey: ["/api/admin/mlb/pregame-radar/calibration"],
    refetchInterval: 120_000,
  });

  return (
    <Card data-testid="card-pregame-radar-calibration">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="h-4 w-4" /> Pregame Radar Calibration
          <span className="text-[11px] font-normal text-muted-foreground">
            full denominator · proxy only, not official ROI
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {data && (
          <>
            <div className="text-[11px] text-muted-foreground">
              {data.dateRange.startET} → {data.dateRange.endET}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCell label="Targets" value={data.targets} sub="graded, flagged" />
              <StatCell label="Wins" value={data.wins} />
              <StatCell label="Calibration Misses" value={data.calibrationMisses} sub="internal only" />
              <StatCell label="Hit Rate" value={pctStr(data.hitRate)} />
              <StatCell label="First-AB Wins" value={data.firstAbWins} />
              <StatCell label="First-AB Rate" value={pctStr(data.firstAbWinRate)} />
              <StatCell label="→ Live Ready" value={pctStr(data.targetToLiveReadyRate)} />
              <StatCell label="→ Live Fire" value={pctStr(data.targetToLiveFireRate)} />
              <StatCell label="→ HR" value={pctStr(data.targetToHrRate)} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <BucketTable title="By Tier" buckets={data.byTier} />
              <BucketTable title="By Score Band" buckets={data.byScoreBand} />
              <BucketTable title="By Driver" buckets={data.byDriver} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
