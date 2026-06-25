import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3 } from "lucide-react";
import type { HrBoardAnalyticsSummary } from "@shared/hrBoardStudio";

interface Props {
  summary: HrBoardAnalyticsSummary | null;
}

function Stat({ label, value, testId }: { label: string; value: string | number; testId: string }) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-2.5" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
    </div>
  );
}

/** Read-only rollup of the admin's daily content workflow. */
export function HrBoardAnalyticsPanel({ summary }: Props) {
  return (
    <Card data-testid="analytics-panel-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" /> Workflow Analytics
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!summary ? (
          <div className="text-xs text-muted-foreground py-4 text-center">No analytics yet.</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            <Stat label="Generated today" value={summary.assetsGeneratedToday} testId="stat-generated" />
            <Stat label="Copied today" value={summary.assetsCopiedToday} testId="stat-copied" />
            <Stat
              label="Most copied player"
              value={summary.mostCopiedPlayer ?? "—"}
              testId="stat-top-player"
            />
            <Stat
              label="Most copied template"
              value={summary.mostCopiedTemplate ?? "—"}
              testId="stat-top-template"
            />
            <Stat
              label="Movement assets"
              value={summary.movementAssetsAvailable}
              testId="stat-movement"
            />
            <Stat
              label="Recap status"
              value={summary.recapStatus === "generated" ? "Generated" : "Pending"}
              testId="stat-recap-status"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
