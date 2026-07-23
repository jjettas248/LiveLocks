// Admin-only MLB Runtime Qualification Audit panel.
//
// Read-only view over GET /api/admin/mlb-qualification. Surfaces the
// rolling 30-minute qualification/rejection breakdown — in particular which
// markets are being bottlenecked by missing sportsbook lines (staleOdds), the
// failure mode that can make Live Edge look like a market was "removed" when
// it's actually just waiting on a real book line. Renders server-computed
// values verbatim — no client-side re-derivation.

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";

interface QualificationBottleneck {
  market: string;
  rejected: number;
  qualified: number;
  rejectRate: number;
  staleOddsRejected: number;
  staleOddsRejectRate: number;
}

interface AuditSummaryPayload {
  windowMs: number;
  cyclesObserved: number;
  gamesObserved: number;
  totals: {
    rawCandidates: number;
    normalizedCandidates: number;
    qualifiedSignals: number;
    rejectedSignals: number;
    watchSignals: number;
    hrWatchCount: number;
  };
  rejectionsByCategoryPct: Record<string, number>;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  qualificationBottlenecks: QualificationBottleneck[];
  thresholdsCurrentlyApplied: {
    batterOverAbsoluteFloor: number;
    batterOverScoreMinimum: number;
    pitcherScoreMinimum: number;
    highProbBypassThreshold: number;
    hrWatchGate: number;
  };
}

// Visual-only echo of marketStarvationGuard.ts's RATE_THRESHOLD_PCT — flags a
// row the same way the [MLB_MARKET_STARVED] log tag would. Not wired to the
// server; if the guard's threshold changes, update this to match.
const STARVATION_RATE_THRESHOLD_PCT = 70;

function StatCell({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-border/50 p-2" data-testid={`stat-qualification-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-bold">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ReasonList({ reasons }: { reasons: Array<{ reason: string; count: number }> }) {
  if (reasons.length === 0) return null;
  return (
    <div>
      <div className="text-sm font-medium mb-1.5">Top Rejection Reasons</div>
      <div className="space-y-0.5">
        {reasons.slice(0, 6).map(({ reason, count }) => (
          <div
            key={reason}
            className="grid grid-cols-[1fr_auto] gap-2 text-[11px] items-center"
            data-testid={`row-qualification-reason-${reason}`}
          >
            <span className="truncate text-muted-foreground">{reason}</span>
            <span className="font-semibold">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BottleneckTable({ rows }: { rows: QualificationBottleneck[] }) {
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground">No market activity in the current window.</div>;
  }
  return (
    <div className="overflow-x-auto" data-testid="table-mlb-qualification-bottlenecks">
      <div className="min-w-[560px]">
        <div className="grid grid-cols-[1.3fr_0.8fr_0.8fr_0.9fr_1fr_1fr] gap-2 text-[11px] font-medium text-muted-foreground pb-1 border-b border-border/50">
          <span>Market</span>
          <span className="text-right">Rejected</span>
          <span className="text-right">Qualified</span>
          <span className="text-right">Reject Rate</span>
          <span className="text-right">staleOdds Rejected</span>
          <span className="text-right">staleOdds Rate</span>
        </div>
        {rows.map((row) => {
          const starved = row.staleOddsRejectRate >= STARVATION_RATE_THRESHOLD_PCT;
          return (
            <div
              key={row.market}
              className={`grid grid-cols-[1.3fr_0.8fr_0.8fr_0.9fr_1fr_1fr] gap-2 text-[12px] items-center py-1 border-b border-border/30 ${starved ? "bg-destructive/10" : ""}`}
              data-testid={`row-qualification-bottleneck-${row.market}`}
            >
              <span className="font-medium truncate">{row.market}</span>
              <span className="text-right">{row.rejected}</span>
              <span className="text-right">{row.qualified}</span>
              <span className="text-right">{row.rejectRate}%</span>
              <span className="text-right">{row.staleOddsRejected}</span>
              <span className={`text-right font-semibold ${starved ? "text-destructive" : ""}`}>
                {row.staleOddsRejectRate}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MlbQualificationAuditCard() {
  const { data, isLoading } = useQuery<AuditSummaryPayload>({
    queryKey: ["/api/admin/mlb-qualification"],
    refetchInterval: 30_000,
  });

  return (
    <Card data-testid="card-mlb-qualification-audit">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4" /> MLB Qualification Audit
          <span className="text-[11px] font-normal text-muted-foreground">
            read-only · rolling 30-min window · which markets bottleneck and why
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <StatCell label="Cycles" value={data.cyclesObserved} />
              <StatCell label="Games" value={data.gamesObserved} />
              <StatCell label="Qualified" value={data.totals.qualifiedSignals} />
              <StatCell label="Rejected" value={data.totals.rejectedSignals} />
              <StatCell label="Watch" value={data.totals.watchSignals} />
              <StatCell
                label="staleOdds Share"
                value={`${data.rejectionsByCategoryPct?.staleOdds ?? 0}%`}
                sub="of all rejections"
              />
            </div>

            <div>
              <div className="text-sm font-medium mb-1.5">Qualification Bottlenecks by Market</div>
              <BottleneckTable rows={data.qualificationBottlenecks} />
            </div>

            <ReasonList reasons={data.topRejectionReasons} />

            <div className="text-[10px] text-muted-foreground" data-testid="text-qualification-thresholds">
              batterOverFloor={data.thresholdsCurrentlyApplied.batterOverAbsoluteFloor} ·
              {" "}batterOverScoreMin={data.thresholdsCurrentlyApplied.batterOverScoreMinimum} ·
              {" "}pitcherScoreMin={data.thresholdsCurrentlyApplied.pitcherScoreMinimum} ·
              {" "}highProbBypass={data.thresholdsCurrentlyApplied.highProbBypassThreshold} ·
              {" "}hrWatchGate={data.thresholdsCurrentlyApplied.hrWatchGate}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
