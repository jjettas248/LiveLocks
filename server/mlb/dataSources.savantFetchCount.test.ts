// Mound Radar PR 2/5 — fetch-count invariant.
// Proves the new pitcherContactCsvSource projection adds ZERO new network
// calls: it reuses the already-fetched/parsed pitcher CSV text exactly once.
// Compares call counts across the existing success/failure branches rather
// than asserting a single hardcoded "always 2" universal invariant — the
// happy path stays 2 (batter + pitcher), but fallback branches are also
// checked to confirm this PR didn't change their call counts either.
// Run: npx tsx server/mlb/dataSources.savantFetchCount.test.ts

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { fetchBaseballSavantData } from "./dataSources";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const VALID_CSV =
  "game_pk,pitch_type,launch_speed,launch_speed_angle,bb_type,estimated_slg_using_speedangle,estimated_woba_using_speedangle,release_speed,release_spin_rate,description\n" +
  "123,FF,98.0,4,fly_ball,0.500,0.320,95.0,2200,hit_into_play\n";

let fetchCallCount = 0;
let scenario: "success" | "batterFail" | "pitcherFail" | "bothFail" = "success";

async function mockFetch(url: string): Promise<Response> {
  fetchCallCount++;
  const isBatter = url.includes("player_type=batter");
  const isPitcher = url.includes("player_type=pitcher");
  const isFallback = url.includes("statsapi.mlb.com");

  if (isFallback) {
    return { ok: true, json: async () => ({ stats: [{ splits: [{ stat: { avg: 0.25, slg: 0.4 } }] }] }) } as unknown as Response;
  }
  if (isBatter) {
    if (scenario === "batterFail" || scenario === "bothFail") return { ok: false } as Response;
    return { ok: true, text: async () => VALID_CSV } as unknown as Response;
  }
  if (isPitcher) {
    if (scenario === "pitcherFail" || scenario === "bothFail") return { ok: false } as Response;
    return { ok: true, text: async () => VALID_CSV } as unknown as Response;
  }
  return { ok: false } as Response;
}

async function run() {
  const originalFetch = global.fetch;
  (global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

  try {
    scenario = "success"; fetchCallCount = 0;
    await fetchBaseballSavantData("player-success-1", "g1");
    ok(fetchCallCount === 2, `happy path (both succeed): exactly 2 fetch calls — batter + pitcher (got ${fetchCallCount})`);

    scenario = "batterFail"; fetchCallCount = 0;
    await fetchBaseballSavantData("player-batterfail-2", "g1");
    ok(fetchCallCount === 3, `batter fails → existing MLB-Stats-API fallback adds exactly 1 more call, unchanged by this PR (got ${fetchCallCount}, expected 3)`);

    scenario = "pitcherFail"; fetchCallCount = 0;
    await fetchBaseballSavantData("player-pitcherfail-3", "g1");
    ok(fetchCallCount === 2, `pitcher fails → no pitcher-side fallback exists (unchanged by this PR), stays at 2 (got ${fetchCallCount})`);

    scenario = "bothFail"; fetchCallCount = 0;
    await fetchBaseballSavantData("player-bothfail-4", "g1");
    ok(fetchCallCount === 3, `both fail → batter fallback still fires once, pitcher has none, total 3 (got ${fetchCallCount})`);
  } finally {
    (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  }

  // ── Static check: the pitcher CSV response is parsed exactly once ──
  // (parsedPitcherDoc computed a single time and reused for both
  // aggregatePitcherStuffMetrics and buildPitcherContactCsvSource) — proven
  // by counting textual call-sites across the whole file: one in the
  // batter branch, one in the pitcher branch, one in the unrelated
  // fetchSavantGameFeed live-game function. Never two within the same branch.
  const src = readFileSync(join(HERE, "dataSources.ts"), "utf8");
  const totalOccurrences = (src.match(/parseSavantCsvDocument\(/g) ?? []).length;
  const declarationCount = (src.match(/function parseSavantCsvDocument\(/g) ?? []).length;
  const callSiteCount = totalOccurrences - declarationCount;
  ok(declarationCount === 1, `parseSavantCsvDocument is declared exactly once (got ${declarationCount})`);
  ok(callSiteCount === 3, `parseSavantCsvDocument has exactly 3 call sites total in dataSources.ts (batter, pitcher, fetchSavantGameFeed) — got ${callSiteCount}`);

  console.log(`\ndataSources.savantFetchCount.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
