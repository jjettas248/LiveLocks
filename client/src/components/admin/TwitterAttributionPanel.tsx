import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Twitter, Loader2 } from "lucide-react";

type CampaignBreakdown = {
  campaign: string;
  visits: number;
  signups: number;
  trialStarts: number;
  paidConversions: number;
  signupRate: number;
  paidRate: number;
};

type AttributionSummary = {
  source: string;
  windowDays: number;
  totals: {
    visits: number;
    signups: number;
    trialStarts: number;
    paidConversions: number;
    signupRate: number;
    paidRate: number;
  };
  byCampaign: CampaignBreakdown[];
};

type SortKey = "campaign" | "visits" | "signups" | "trialStarts" | "paidConversions" | "signupRate" | "paidRate";

export function TwitterAttributionPanel() {
  const [open, setOpen] = useState(true);
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [sortKey, setSortKey] = useState<SortKey>("visits");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading, isError } = useQuery<AttributionSummary>({
    queryKey: ["/api/admin/attribution/twitter", days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/attribution/twitter?days=${days}`, { credentials: "include" });
      if (!res.ok) throw new Error("failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const sorted = (data?.byCampaign ?? []).slice().sort((a, b) => {
    const aV = a[sortKey];
    const bV = b[sortKey];
    if (typeof aV === "string" && typeof bV === "string") {
      return sortDir === "asc" ? aV.localeCompare(bV) : bV.localeCompare(aV);
    }
    const aN = Number(aV) || 0;
    const bN = Number(bV) || 0;
    return sortDir === "asc" ? aN - bN : bN - aN;
  });

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "campaign" ? "asc" : "desc"); }
  };

  return (
    <div
      data-testid="panel-twitter-attribution"
      className="rounded-xl border border-border bg-card overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        data-testid="button-toggle-twitter-attribution"
        className="w-full flex items-center justify-between px-4 sm:px-6 py-3 hover:bg-muted/40 transition"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500/15 ring-1 ring-sky-500/30 flex items-center justify-center">
            <Twitter className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-left">
            <div className="text-sm font-bold">Twitter Attribution</div>
            <div className="text-[11px] text-muted-foreground">UTM-based tracking · /twitter landing + organic referer</div>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t border-border p-4 sm:p-6 space-y-4">
          {/* Window selector */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-muted-foreground">
              Last {days} days · auto-refresh every 60s
            </div>
            <div className="flex items-center gap-1">
              {([7, 30, 90] as const).map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  data-testid={`button-window-${d}`}
                  className={`text-xs px-3 py-1.5 rounded-md font-medium transition ${
                    days === d
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-muted/70"
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* Loading / error / empty */}
          {isLoading && (
            <div data-testid="state-loading" className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading attribution data…
            </div>
          )}
          {isError && (
            <div data-testid="state-error" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              Failed to load attribution summary.
            </div>
          )}

          {data && !isLoading && (
            <>
              {/* Top-line metric grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="grid-totals">
                <Metric label="Visits" value={data.totals.visits} testId="stat-total-visits" />
                <Metric
                  label="Signups"
                  value={data.totals.signups}
                  sub={data.totals.visits > 0 ? `${data.totals.signupRate}% conv` : undefined}
                  testId="stat-total-signups"
                />
                <Metric label="Trial Starts" value={data.totals.trialStarts} testId="stat-total-trials" />
                <Metric
                  label="Paid"
                  value={data.totals.paidConversions}
                  sub={data.totals.signups > 0 ? `${data.totals.paidRate}% conv` : undefined}
                  color="text-green-400"
                  testId="stat-total-paid"
                />
              </div>

              {/* Per-campaign table */}
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-xs" data-testid="table-campaigns">
                  <thead className="bg-muted/50">
                    <tr>
                      <Th label="Campaign" k="campaign" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                      <Th label="Visits" k="visits" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                      <Th label="Signups" k="signups" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                      <Th label="Sign-up %" k="signupRate" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                      <Th label="Trials" k="trialStarts" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                      <Th label="Paid" k="paidConversions" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                      <Th label="Paid %" k="paidRate" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          data-testid="state-empty"
                          className="px-4 py-6 text-center text-muted-foreground italic"
                        >
                          No Twitter attribution recorded in this window yet.
                        </td>
                      </tr>
                    )}
                    {sorted.map((row, i) => (
                      <tr
                        key={`${row.campaign}-${i}`}
                        data-testid={`row-campaign-${row.campaign}`}
                        className="border-t border-border hover:bg-muted/30"
                      >
                        <td className="px-3 py-2 font-medium" data-testid={`cell-campaign-${row.campaign}`}>
                          {row.campaign}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`cell-visits-${row.campaign}`}>
                          {row.visits}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`cell-signups-${row.campaign}`}>
                          {row.signups}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground" data-testid={`cell-signupRate-${row.campaign}`}>
                          {row.visits > 0 ? `${row.signupRate}%` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums" data-testid={`cell-trialStarts-${row.campaign}`}>
                          {row.trialStarts}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-green-400" data-testid={`cell-paidConversions-${row.campaign}`}>
                          {row.paidConversions}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground" data-testid={`cell-paidRate-${row.campaign}`}>
                          {row.signups > 0 ? `${row.paidRate}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-[10px] text-muted-foreground">
                Visits include direct UTM hits and organic Twitter / X / t.co referer fallbacks. Signups/trials/paid are joined from <code>user_attribution</code> → <code>users</code>. Conversion rate denominators: visits → signups, signups → paid.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  color,
  testId,
}: { label: string; value: number; sub?: string; color?: string; testId: string }) {
  return (
    <div className="rounded-lg bg-background border border-border p-3 text-center">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color ?? "text-foreground"}`} data-testid={testId}>
        {value.toLocaleString()}
      </div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Th({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  align,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "right" | "left";
}) {
  const active = k === sortKey;
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(k)}
        data-testid={`sort-${k}`}
        className={`text-[11px] font-semibold uppercase tracking-wider transition ${
          active ? "text-primary" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {label}{active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}
