// Admin-only HR Miss Diagnostic Payload generator panel.
//
// Read-only view over GET /api/admin/hr-radar/miss-payload. Lets the admin
// pick a lookback window, preview the aggregate miss summary, then copy the
// full LLM-ready markdown prompt (or download the raw JSON) to feed to an
// external model for engine-improvement analysis. Renders server-stamped
// values verbatim — no client-side re-derivation.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bug, ClipboardCopy, Download, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface MissPayloadSummary {
  totalRecords: number;
  falsePositives: number;
  falseNegatives: number;
  exempt: number;
  byCategory: Record<string, number>;
  byReviewBucket: Record<string, number>;
  byBlockedGate: Record<string, number>;
  byMissingInput: Record<string, number>;
  avgPeakConversionOnFalsePositives: number | null;
}

interface MissPayload {
  generatedAt: string;
  engineVersion: string;
  window: { days: number; fromDateET: string; toDateET: string };
  totalMissesInWindow: number;
  recordLimit: number;
  truncated: boolean;
  summary: MissPayloadSummary;
  records: unknown[];
}

const DAY_OPTIONS = [3, 7, 14, 30] as const;

function StatCell({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-border/50 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-bold">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function CountList({ title, counts }: { title: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="text-sm font-medium mb-1.5">{title}</div>
      <div className="space-y-0.5">
        {rows.map(([key, n]) => (
          <div
            key={key}
            className="grid grid-cols-[1fr_auto] gap-2 text-[11px] items-center"
            data-testid={`hr-miss-count-${title.toLowerCase().replace(/\s+/g, "-")}-${key}`}
          >
            <span className="truncate text-muted-foreground">{key}</span>
            <span className="font-semibold">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HrMissDiagnosticsCard() {
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState<"copy" | "download" | null>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery<MissPayload>({
    queryKey: [`/api/admin/hr-radar/miss-payload?days=${days}`],
  });

  const copyLlmPrompt = async () => {
    setBusy("copy");
    try {
      const res = await apiRequest("GET", `/api/admin/hr-radar/miss-payload?days=${days}&format=markdown`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      toast({
        title: "LLM prompt copied",
        description: `${data?.summary.totalRecords ?? "?"} miss records over ${days}d — paste into your LLM.`,
      });
    } catch (err: any) {
      toast({
        title: "Copy failed",
        description: err?.message ?? "Could not generate the miss payload",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const downloadJson = async () => {
    setBusy("download");
    try {
      const res = await apiRequest("GET", `/api/admin/hr-radar/miss-payload?days=${days}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hr-miss-payload-${days}d.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({
        title: "Download failed",
        description: err?.message ?? "Could not generate the miss payload",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-testid="card-hr-miss-diagnostics">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Bug className="h-4 w-4" /> HR Miss Diagnostics — LLM Payload
          <span className="text-[11px] font-normal text-muted-foreground">
            read-only · fired misses + uncalled/late HRs
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {DAY_OPTIONS.map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? "default" : "outline"}
                onClick={() => setDays(d)}
                data-testid={`button-hr-miss-days-${d}`}
              >
                {d}d
              </Button>
            ))}
          </div>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={copyLlmPrompt}
            disabled={busy !== null || isLoading}
            data-testid="button-copy-hr-miss-payload"
          >
            {busy === "copy" ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <ClipboardCopy className="h-3.5 w-3.5 mr-1.5" />
            )}
            Copy LLM prompt
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={downloadJson}
            disabled={busy !== null || isLoading}
            data-testid="button-download-hr-miss-payload"
          >
            {busy === "download" ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}
            JSON
          </Button>
        </div>

        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {data && (
          <>
            <div className="text-[11px] text-muted-foreground" data-testid="text-hr-miss-window">
              {data.window.fromDateET} → {data.window.toDateET} · engine {data.engineVersion}
              {data.truncated &&
                ` · showing ${data.summary.totalRecords} of ${data.totalMissesInWindow} misses`}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCell label="Misses" value={data.summary.totalRecords} sub={`last ${days}d`} />
              <StatCell
                label="False Positives"
                value={data.summary.falsePositives}
                sub="tracked, no HR"
              />
              <StatCell
                label="False Negatives"
                value={data.summary.falseNegatives}
                sub="uncalled / late HR"
              />
              <StatCell
                label="Avg FP Peak Conv"
                value={
                  data.summary.avgPeakConversionOnFalsePositives != null
                    ? `${Math.round(data.summary.avgPeakConversionOnFalsePositives * 1000) / 10}%`
                    : "—"
                }
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <CountList title="By Category" counts={data.summary.byCategory} />
              <CountList title="By Review Bucket" counts={data.summary.byReviewBucket} />
              <CountList title="By Blocked Gate" counts={data.summary.byBlockedGate} />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
