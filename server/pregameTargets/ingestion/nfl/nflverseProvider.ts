// PR6 — NFL raw provider fetch (nflverse release CSV). Preserves the verbatim CSV text
// (original headers/cells, genuine blanks) so the immutable capture IS the provider
// payload and the adapter sees real schema drift + genuine missing values. Timestamp
// honesty (audit-3 discipline): on success `fetchedAt` is captured ONLY AFTER the body
// is received and decoded; `requestedAt` names request-start; a transport/HTTP/decode
// failure carries `failedAt`, never a successful `fetchedAt`. All instants are generated
// inside this bridge — no caller may supply or back-date them.

// nflverse-data release asset base. Exact tag/asset names are pinned by sourceVersion
// and confirmed in the authorized environment (this environment has no provider access).
const NFLVERSE_RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

const NFL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; LiveLocksPregameBackfill/1.0)",
  "Accept": "text/csv,*/*",
};

export type RawNflCsvFetchResult =
  | { ok: true; rawCsv: string; requestedAt: string; fetchedAt: string; sourcePublishedAt: string | null }
  | { ok: false; reason: "transport_failure" | "http_failure" | "decode_failure"; requestedAt: string; failedAt: string };

/** Build the release asset URL for a whole-season nflverse CSV. */
export function nflverseAssetUrl(release: string, asset: string): string {
  return `${NFLVERSE_RELEASE_BASE}/${release}/${asset}`;
}

/**
 * Fetch one whole-season nflverse CSV asset, verbatim. Does NOT parse or coerce — the
 * adapter does that. `sourcePublishedAt` is taken from the response's Last-Modified
 * header when present (the release/asset publish instant), else null (durable unknown).
 */
export async function fetchRawNflverseCsv(args: { release: string; asset: string }): Promise<RawNflCsvFetchResult> {
  const requestedAt = new Date().toISOString(); // request START — NOT knownAt
  const url = nflverseAssetUrl(args.release, args.asset);
  let res: Response;
  try {
    res = await fetch(url, { headers: NFL_HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
  } catch {
    return { ok: false, reason: "transport_failure", requestedAt, failedAt: new Date().toISOString() };
  }
  if (!res.ok) return { ok: false, reason: "http_failure", requestedAt, failedAt: new Date().toISOString() };
  let rawCsv: string;
  try {
    rawCsv = await res.text();
  } catch {
    return { ok: false, reason: "decode_failure", requestedAt, failedAt: new Date().toISOString() };
  }
  // Body received AND decoded — only now is it genuinely known to this pipeline.
  const fetchedAt = new Date().toISOString();
  const lastMod = res.headers?.get?.("last-modified") ?? null;
  let sourcePublishedAt: string | null = null;
  if (lastMod) {
    const ms = Date.parse(lastMod);
    if (Number.isFinite(ms)) sourcePublishedAt = new Date(ms).toISOString(); // never fabricate on a malformed header
  }
  return { ok: true, rawCsv, requestedAt, fetchedAt, sourcePublishedAt };
}
