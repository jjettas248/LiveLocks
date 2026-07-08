import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Sparkles, Target, Link2, Filter, Flame } from "lucide-react";
import { HrBoardAssetCard } from "./HrBoardAssetCard";
import { HrMovementFeed } from "./HrMovementFeed";
import { HrBoardRecapPanel } from "./HrBoardRecapPanel";
import { HrBoardAnalyticsPanel } from "./HrBoardAnalyticsPanel";
import {
  HR_BOARD_ASSET_LABELS,
  type HrBoardAnalyticsEventType,
  type HrBoardAnalyticsSummary,
  type HrBoardAsset,
  type HrBoardAssetType,
  type HrBoardContentPack,
  type HrBoardRow,
  type HrBoardTodayResponse,
  type HrMovementFeedResponse,
  type HrRecapResponse,
} from "@shared/hrBoardStudio";

/** Today's MLB slate date in ET, with the same 6am-ET rollover the server's
 * slateDateET() (server/utils/dateUtils.ts) uses, so the recap date picker
 * defaults to the slate that's actually live — not the UTC calendar date.
 * Builds the previous day from the ET year/month/day parts directly (mirrors
 * the server implementation) rather than mutating a local Date: subtracting
 * a calendar day via the admin's local timezone and re-formatting in ET can
 * land on the wrong date when the local zone's DST calendar/offset differs
 * from New York's around a DST transition. */
function slateDateET(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  let year = get("year");
  let month = get("month");
  let day = get("day");
  const hour = get("hour") % 24; // some ICU builds render midnight as "24"

  if (hour < 6) {
    const prevDay = new Date(Date.UTC(year, month - 1, day));
    prevDay.setUTCDate(prevDay.getUTCDate() - 1);
    year = prevDay.getUTCFullYear();
    month = prevDay.getUTCMonth() + 1;
    day = prevDay.getUTCDate();
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function authHeaders(json = false): Record<string, string> {
  const token = getAuthToken();
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include", headers: authHeaders() });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

/** Fire-and-forget analytics logging — never blocks the workflow. */
function logAction(
  event: HrBoardAnalyticsEventType,
  extra: Record<string, unknown> = {},
): void {
  void fetch("/api/admin/hr-board-studio/log-action", {
    method: "POST",
    credentials: "include",
    headers: authHeaders(true),
    body: JSON.stringify({ event, ...extra }),
  }).catch(() => {});
}

function copyEventFor(assetType: HrBoardAssetType): HrBoardAnalyticsEventType {
  if (assetType === "cashed_proof" || assetType === "near_miss_transparency" || assetType === "postgame_recap") {
    return "hr_recap_copied";
  }
  if (assetType === "movement_alert" || assetType === "ready_fire_alert") {
    return "hr_movement_asset_copied";
  }
  return "hr_board_asset_copied";
}

const ASSET_TYPE_OPTIONS: Array<{ value: "all" | HrBoardAssetType; label: string }> = [
  { value: "all", label: "All assets" },
  ...(Object.keys(HR_BOARD_ASSET_LABELS) as HrBoardAssetType[]).map((t) => ({
    value: t,
    label: HR_BOARD_ASSET_LABELS[t],
  })),
];

/**
 * HR Board Studio — admin command center for the Pre-Game HR Power Board.
 * Generate no-link content packs, monitor live movement into HR Radar stages,
 * and produce postgame recaps. Renders engine output only; never recomputes.
 */
export function HrBoardStudio() {
  const { toast } = useToast();
  const [includeLink, setIncludeLink] = useState(false);
  const [link, setLink] = useState("");
  const [assetFilter, setAssetFilter] = useState<"all" | HrBoardAssetType>("all");
  const [stageFilter, setStageFilter] = useState("all");
  const [pack, setPack] = useState<HrBoardContentPack | null>(null);
  const [recap, setRecap] = useState<HrRecapResponse | null>(null);
  const [generatingPack, setGeneratingPack] = useState(false);
  const [generatingRecap, setGeneratingRecap] = useState(false);
  const [recapDate, setRecapDate] = useState(slateDateET);

  // Log the admin view once per mount.
  useEffect(() => {
    logAction("hr_board_admin_viewed");
  }, []);

  const boardQ = useQuery<HrBoardTodayResponse>({
    queryKey: ["/api/admin/hr-board-studio/today"],
    queryFn: () => getJson<HrBoardTodayResponse>("/api/admin/hr-board-studio/today"),
  });

  const movementQ = useQuery<HrMovementFeedResponse>({
    queryKey: ["/api/admin/hr-board-studio/movement-feed"],
    queryFn: () => getJson<HrMovementFeedResponse>("/api/admin/hr-board-studio/movement-feed"),
    refetchInterval: 30_000,
  });

  const analyticsQ = useQuery<HrBoardAnalyticsSummary>({
    queryKey: ["/api/admin/hr-board-studio/analytics"],
    queryFn: () => getJson<HrBoardAnalyticsSummary>("/api/admin/hr-board-studio/analytics"),
    refetchInterval: 30_000,
  });

  const liveBestContactsQ = useQuery<{ date: string; generatedAt: string; rows: HrBoardRow[] }>({
    queryKey: ["/api/admin/hr-board-studio/live-best-contacts"],
    queryFn: () =>
      getJson<{ date: string; generatedAt: string; rows: HrBoardRow[] }>(
        "/api/admin/hr-board-studio/live-best-contacts",
      ),
    refetchInterval: 30_000,
  });

  async function generatePack() {
    setGeneratingPack(true);
    try {
      const result = await postJson<HrBoardContentPack>(
        "/api/admin/hr-board-studio/generate-pack",
        { includeLink, link: includeLink ? link.trim() || null : null },
      );
      setPack(result);
      void analyticsQ.refetch();
      toast({
        title: "Content pack generated",
        description: `${result.assets.length} assets${result.counts.flagged ? ` · ${result.counts.flagged} flagged` : ""}`,
      });
    } catch (e: any) {
      toast({ title: "Generation failed", description: e?.message, variant: "destructive" });
    } finally {
      setGeneratingPack(false);
    }
  }

  async function generateRecap() {
    setGeneratingRecap(true);
    try {
      const result = await postJson<HrRecapResponse>(
        "/api/admin/hr-board-studio/generate-recap",
        { date: recapDate },
      );
      setRecap(result);
      void analyticsQ.refetch();
      toast({ title: "Recap generated", description: `${result.assets.length} recap assets` });
    } catch (e: any) {
      toast({ title: "Recap failed", description: e?.message, variant: "destructive" });
    } finally {
      setGeneratingRecap(false);
    }
  }

  function onCopy(asset: HrBoardAsset) {
    logAction(copyEventFor(asset.assetType), {
      assetType: asset.assetType,
      template: asset.imagePayload.template,
      player: asset.imagePayload.rows?.[0]?.player ?? null,
      signalId: asset.sourceSignalIds[0] ?? null,
    });
  }

  function onDownloadImage(asset: HrBoardAsset) {
    try {
      const blob = new Blob([JSON.stringify(asset.imagePayload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `hr-board-${asset.assetType}-image-payload.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      logAction("hr_board_image_payload_downloaded", {
        assetType: asset.assetType,
        template: asset.imagePayload.template,
      });
    } catch {
      /* download is best-effort */
    }
  }

  function toggleLink(next: boolean) {
    setIncludeLink(next);
    if (next) logAction("hr_board_link_toggle_enabled");
  }

  const visibleAssets = useMemo(() => {
    if (!pack) return [];
    return assetFilter === "all"
      ? pack.assets
      : pack.assets.filter((a) => a.assetType === assetFilter);
  }, [pack, assetFilter]);

  const board = boardQ.data;
  const movements = movementQ.data?.movements ?? [];

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2" data-testid="text-page-title">
            <Target className="h-6 w-6 text-primary" /> HR Board Studio
          </h1>
          <div className="text-xs text-muted-foreground mt-1">
            Pre-Game HR Power Board → content, movement & proof. No-link native by default · admin only.
            {board && <span className="ml-1">Board: {board.counts.total} players · {board.date}</span>}
          </div>
        </div>
      </header>

      <HrBoardAnalyticsPanel summary={analyticsQ.data ?? null} />

      {/* ── Generate controls ─────────────────────────────────────────────── */}
      <Card data-testid="generate-controls-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Daily Board Pack
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={generatePack}
              disabled={generatingPack || boardQ.isLoading}
              className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-60"
              data-testid="button-generate-pack"
            >
              {generatingPack ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Generate Board Pack
            </button>

            <label
              className="flex items-center gap-2 text-xs cursor-pointer select-none"
              data-testid="toggle-include-link"
            >
              <input
                type="checkbox"
                checked={includeLink}
                onChange={(e) => toggleLink(e.target.checked)}
                className="accent-primary"
                data-testid="checkbox-include-link"
              />
              <Link2 className="h-3.5 w-3.5" /> Include link
            </label>

            {includeLink && (
              <input
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://… (CTA only, never in copy)"
                className="text-xs px-2 py-1.5 rounded-md border border-border bg-card flex-1 min-w-[200px]"
                data-testid="input-link"
              />
            )}
          </div>

          <div className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Filter className="h-3 w-3" />
            <select
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value as any)}
              className="text-xs px-2 py-1 rounded-md border border-border bg-card"
              data-testid="filter-asset-type"
            >
              {ASSET_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {pack && (
              <span className="ml-2">
                {pack.counts.total} assets · {pack.counts.flagged} flagged · link {pack.includeLink ? "on" : "off"}
              </span>
            )}
          </div>

          {pack ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visibleAssets.map((a) => (
                <HrBoardAssetCard
                  key={a.assetType}
                  asset={a}
                  onCopy={onCopy}
                  onDownloadImage={onDownloadImage}
                />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border rounded-md">
              Generate today's board pack to create X-native, no-link content assets in one click.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Movement feed ─────────────────────────────────────────────────── */}
      <HrMovementFeed
        movements={movements}
        stageFilter={stageFilter}
        onStageFilter={setStageFilter}
        isFetching={movementQ.isFetching}
        onRefresh={() => movementQ.refetch()}
      />

      {/* ── Live Best Contacts ────────────────────────────────────────────── */}
      <Card data-testid="live-best-contacts-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Flame className="h-4 w-4 text-primary" /> Live Best Contacts
          </CardTitle>
        </CardHeader>
        <CardContent>
          {liveBestContactsQ.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : (liveBestContactsQ.data?.rows.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground">
              No live Attack/Playable signals yet today.
            </div>
          ) : (
            <div className="space-y-1.5" data-testid="live-best-contacts-list">
              {liveBestContactsQ.data!.rows.map((r) => (
                <div
                  key={r.signalId}
                  className="flex items-center justify-between gap-2 text-xs px-2 py-1.5 rounded-md bg-muted/30"
                  data-testid={`row-live-best-contact-${r.playerId}`}
                >
                  <span className="font-medium">
                    {r.rank}. {r.player} <span className="text-muted-foreground">({r.team})</span>
                  </span>
                  <span className="text-muted-foreground">
                    {r.stage} · {r.score.toFixed(1)}/10
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Recap ─────────────────────────────────────────────────────────── */}
      <HrBoardRecapPanel
        recap={recap}
        date={recapDate}
        onDateChange={setRecapDate}
        onGenerate={generateRecap}
        generating={generatingRecap}
        onCopy={onCopy}
        onDownloadImage={onDownloadImage}
      />
    </div>
  );
}
