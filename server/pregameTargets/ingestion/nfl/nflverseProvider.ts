// PR6 — NFL raw provider fetch (nflverse). Preserves the verbatim CSV text so the
// immutable capture IS the provider payload and the adapter sees real schema drift +
// genuine missing values. Timestamp honesty (audit-3): on success `fetchedAt` is captured
// ONLY AFTER the body is received and decoded; `requestedAt` names request-start; a
// transport/HTTP/decode failure carries `failedAt`, never a successful `fetchedAt`. All
// instants are generated inside this bridge — no caller may supply or back-date them.
//
// FROZEN authoritative sources (see docs/pregame-targets/PR6-nfl-source-manifest.md):
//   • Weekly player stats: nflverse/nflverse-data release `stats_player`,
//     asset `stats_player_week_{season}.csv`.
//   • Schedules: nflverse/nfldata raw `data/games.csv` (multi-season).

const NFLVERSE_DATA_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";
const NFLDATA_RAW_BASE = "https://raw.githubusercontent.com/nflverse/nfldata/master";

export const NFL_WEEKLY_RELEASE = "stats_player" as const;
export const nflWeeklyStatsAsset = (season: number) => `stats_player_week_${season}.csv`;

/** Exact frozen URL for a season's weekly player-stats CSV. */
export function weeklyStatsUrl(season: number): string {
  return `${NFLVERSE_DATA_RELEASE_BASE}/${NFL_WEEKLY_RELEASE}/${nflWeeklyStatsAsset(season)}`;
}
/** Exact frozen URL for the multi-season schedule CSV. */
export function schedulesUrl(): string {
  return `${NFLDATA_RAW_BASE}/data/games.csv`;
}

const NFL_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; LiveLocksPregameBackfill/1.0)", "Accept": "text/csv,*/*" };

export type RawNflCsvFetchResult =
  | { ok: true; rawCsv: string; requestedAt: string; fetchedAt: string; sourcePublishedAt: string | null }
  | { ok: false; reason: "transport_failure" | "http_failure" | "decode_failure"; requestedAt: string; failedAt: string };

/** Fetch one CSV asset verbatim. `sourcePublishedAt` = Last-Modified if present (guarded),
 *  else null (durable unknown). Does NOT parse or coerce. */
export async function fetchRawNflverseCsv(args: { url: string }): Promise<RawNflCsvFetchResult> {
  const requestedAt = new Date().toISOString();
  let res: Response;
  try {
    res = await fetch(args.url, { headers: NFL_HEADERS, redirect: "follow", signal: AbortSignal.timeout(20000) });
  } catch {
    return { ok: false, reason: "transport_failure", requestedAt, failedAt: new Date().toISOString() };
  }
  if (!res.ok) return { ok: false, reason: "http_failure", requestedAt, failedAt: new Date().toISOString() };
  let rawCsv: string;
  try { rawCsv = await res.text(); } catch { return { ok: false, reason: "decode_failure", requestedAt, failedAt: new Date().toISOString() }; }
  const fetchedAt = new Date().toISOString();
  const lastMod = res.headers?.get?.("last-modified") ?? null;
  let sourcePublishedAt: string | null = null;
  if (lastMod) { const ms = Date.parse(lastMod); if (Number.isFinite(ms)) sourcePublishedAt = new Date(ms).toISOString(); }
  return { ok: true, rawCsv, requestedAt, fetchedAt, sourcePublishedAt };
}
