// Run: npx tsx server/pregameTargets/ingestion/nfl/nflverseProvider.test.ts
// PR6 — nflverse provider URL construction against the FROZEN authoritative upstream
// paths (recovered from nflverse-data + nfldata), plus post-decode fetchedAt honesty and
// typed transport/http/decode failures carrying failedAt (never a successful fetchedAt).
import { weeklyStatsUrl, schedulesUrl, nflWeeklyStatsAsset, NFL_WEEKLY_RELEASE, fetchRawNflverseCsv } from "./nflverseProvider";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

// ── Exact frozen URLs (authoritative) ───────────────────────────────────────
{
  ok(NFL_WEEKLY_RELEASE === "stats_player", "weekly release tag = stats_player");
  ok(nflWeeklyStatsAsset(2024) === "stats_player_week_2024.csv", "weekly asset = stats_player_week_{season}.csv");
  ok(weeklyStatsUrl(2024) === "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2024.csv", "exact weekly URL frozen");
  ok(weeklyStatsUrl(2023) === "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2023.csv", "per-season weekly URL");
  ok(schedulesUrl() === "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv", "exact schedule URL frozen (nfldata data/games.csv)");
}

// ── Post-decode fetchedAt + typed failures (monkeypatched fetch) ────────────
{
  const realFetch = globalThis.fetch;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const withFetch = async (impl: (input: unknown) => Promise<unknown>, fn: () => Promise<void>) => {
    globalThis.fetch = impl as typeof globalThis.fetch;
    try { await fn(); } finally { globalThis.fetch = realFetch; }
  };

  await withFetch(async () => ({ ok: true, status: 200, text: async () => { await sleep(30); return "a,b\n1,2\n"; }, headers: { get: () => null } } as unknown), async () => {
    const before = Date.now();
    const res = await fetchRawNflverseCsv({ url: weeklyStatsUrl(2024) });
    ok(res.ok, "200 → ok");
    if (res.ok) {
      ok(Date.parse(res.fetchedAt) > Date.parse(res.requestedAt), "fetchedAt (observation) after requestedAt");
      ok(Date.parse(res.fetchedAt) >= before + 25, "fetchedAt captured after decode (>= delay)");
      ok(res.sourcePublishedAt === null, "no Last-Modified → sourcePublishedAt null (durable unknown)");
    }
  });

  await withFetch(async () => { throw new Error("net down"); }, async () => {
    const res = await fetchRawNflverseCsv({ url: schedulesUrl() });
    ok(!res.ok && res.reason === "transport_failure" && typeof res.failedAt === "string" && !("fetchedAt" in res), "transport failure → failedAt, no fetchedAt");
  });
  await withFetch(async () => ({ ok: false, status: 404, text: async () => "", headers: { get: () => null } } as unknown), async () => {
    const res = await fetchRawNflverseCsv({ url: schedulesUrl() });
    ok(!res.ok && res.reason === "http_failure", "non-200 → http_failure");
  });
}

console.log(`\nnflverseProvider.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
