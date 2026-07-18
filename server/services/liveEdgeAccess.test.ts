/**
 * Live Edge access control + response serialization — validation harness.
 *
 * Plain Node.js script (no jest/vitest dependency), matching the existing
 * server/mlb/*.test.ts convention. Run with:
 *
 *   npx tsx server/services/liveEdgeAccess.test.ts
 *
 * Exercises the actual functions that produce the HTTP response bodies for
 * /api/top-plays and /api/mlb/edge-feed (server/routes.ts delegates its
 * entire res.json() payload to these), not just source-text inspection —
 * plus a secondary, cheap regression guard that routes.ts still delegates.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  resolveLiveEdgeAccess,
  buildLiveEdgePreview,
  buildTopPlaysResponse,
  buildEdgeFeedResponse,
  type MinimalUser,
} from "./liveEdgeAccess";
import type { TopPlayItem } from "./topPlaysService";

interface TestCase {
  name: string;
  fn: () => void;
}

const cases: TestCase[] = [];
function test(name: string, fn: () => void) {
  cases.push({ name, fn });
}
function assertEq<T>(actual: T, expected: T, ctx: string) {
  if (actual !== expected) {
    throw new Error(`${ctx}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertDeepEq(actual: unknown, expected: unknown, ctx: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${ctx}: expected ${e}, got ${a}`);
  }
}
function assertKeys(obj: Record<string, unknown>, expectedKeys: string[], ctx: string) {
  const actual = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  assertDeepEq(actual, expected, ctx);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. resolveLiveEdgeAccess — real accounts, both scopes
// ─────────────────────────────────────────────────────────────────────────

test("admin (no tier) → full on both scopes", () => {
  const u: MinimalUser = { subscriptionTier: null, isAdmin: true };
  assertEq(resolveLiveEdgeAccess(u, "global"), "full", "admin global");
  assertEq(resolveLiveEdgeAccess(u, "mlb"), "full", "admin mlb");
});

test('paid "elite" → full on both scopes', () => {
  const u: MinimalUser = { subscriptionTier: "elite", isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global"), "full", "elite global");
  assertEq(resolveLiveEdgeAccess(u, "mlb"), "full", "elite mlb");
});

test('paid "all" (Pro) → full on global, preview on mlb — proven hasMLB is false for this tier', () => {
  const u: MinimalUser = { subscriptionTier: "all", isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global"), "full", "all global");
  assertEq(resolveLiveEdgeAccess(u, "mlb"), "preview", "all mlb");
});

test("comped user (subscriptionTier written directly to elite) → full on both scopes, same as any paid user", () => {
  const u: MinimalUser = { subscriptionTier: "elite", isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global"), "full", "comped global");
  assertEq(resolveLiveEdgeAccess(u, "mlb"), "full", "comped mlb");
});

test("free (null tier) → preview on both scopes", () => {
  const u: MinimalUser = { subscriptionTier: null, isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global"), "preview", "free global");
  assertEq(resolveLiveEdgeAccess(u, "mlb"), "preview", "free mlb");
});

test("expired/canceled (null tier, mirrors webhookHandlers revocation) → preview on both scopes", () => {
  const u: MinimalUser = { subscriptionTier: null, isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global"), "preview", "expired global");
  assertEq(resolveLiveEdgeAccess(u, "mlb"), "preview", "expired mlb");
});

test("no user / unauthenticated → preview on both scopes", () => {
  assertEq(resolveLiveEdgeAccess(null, "global"), "preview", "null user global");
  assertEq(resolveLiveEdgeAccess(undefined, "mlb"), "preview", "undefined user mlb");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. View-mode override — every mode against both scopes, genuine admin
// ─────────────────────────────────────────────────────────────────────────

const ADMIN: MinimalUser = { subscriptionTier: null, isAdmin: true };

test("admin, no header (real) → full on both scopes", () => {
  assertEq(resolveLiveEdgeAccess(ADMIN, "global", null), "full", "real global");
  assertEq(resolveLiveEdgeAccess(ADMIN, "mlb", null), "full", "real mlb");
});

test('admin, viewMode "free" → preview on both scopes', () => {
  assertEq(resolveLiveEdgeAccess(ADMIN, "global", "free"), "preview", "free global");
  assertEq(resolveLiveEdgeAccess(ADMIN, "mlb", "free"), "preview", "free mlb");
});

test('admin, viewMode "pro_mlb" → preview on global (hasUnlimited false), full on mlb (hasMLB true) — the flagged scope-split case', () => {
  assertEq(resolveLiveEdgeAccess(ADMIN, "global", "pro_mlb"), "preview", "pro_mlb global");
  assertEq(resolveLiveEdgeAccess(ADMIN, "mlb", "pro_mlb"), "full", "pro_mlb mlb");
});

test('admin, viewMode "all_sports" → full on both scopes', () => {
  assertEq(resolveLiveEdgeAccess(ADMIN, "global", "all_sports"), "full", "all_sports global");
  assertEq(resolveLiveEdgeAccess(ADMIN, "mlb", "all_sports"), "full", "all_sports mlb");
});

test('admin, viewMode "admin" → full on both scopes', () => {
  assertEq(resolveLiveEdgeAccess(ADMIN, "global", "admin"), "full", "admin-mode global");
  assertEq(resolveLiveEdgeAccess(ADMIN, "mlb", "admin"), "full", "admin-mode mlb");
});

test("admin, unrecognized viewMode string → falls back to real (admin's actual flags), both scopes", () => {
  assertEq(resolveLiveEdgeAccess(ADMIN, "global", "bogus"), "full", "bogus global");
  assertEq(resolveLiveEdgeAccess(ADMIN, "mlb", "bogus"), "full", "bogus mlb");
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Non-admin spoof — header inert for non-admins, in both directions, both scopes
// ─────────────────────────────────────────────────────────────────────────

test("non-admin free user + spoofed all_sports header → preview on both scopes (cannot escalate)", () => {
  const u: MinimalUser = { subscriptionTier: null, isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global", "all_sports"), "preview", "spoof global");
  assertEq(resolveLiveEdgeAccess(u, "mlb", "all_sports"), "preview", "spoof mlb");
});

test("non-admin free user + spoofed pro_mlb header → preview on both scopes (cannot escalate via mlb-specific mode either)", () => {
  const u: MinimalUser = { subscriptionTier: null, isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global", "pro_mlb"), "preview", "spoof pro_mlb global");
  assertEq(resolveLiveEdgeAccess(u, "mlb", "pro_mlb"), "preview", "spoof pro_mlb mlb");
});

test("non-admin paid (elite) user + spoofed free header → full on both scopes (cannot be downgraded either)", () => {
  const u: MinimalUser = { subscriptionTier: "elite", isAdmin: false };
  assertEq(resolveLiveEdgeAccess(u, "global", "free"), "full", "downgrade-spoof global");
  assertEq(resolveLiveEdgeAccess(u, "mlb", "free"), "full", "downgrade-spoof mlb");
});

// ─────────────────────────────────────────────────────────────────────────
// 4. buildLiveEdgePreview — structural leak-proofing
// ─────────────────────────────────────────────────────────────────────────

const FORBIDDEN_SENTINELS = [
  "SENTINEL_PLAYER_NAME",
  "SENTINEL_TEAM",
  "sentinel_market",
  "SENTINEL_DIRECTION",
  "SENTINEL_GAME_ID",
  "SENTINEL_PLAYER_ID",
  "SENTINEL_THESIS",
];

function fullFidelityFixtureItem(overrides: Record<string, unknown> = {}) {
  return {
    sport: "MLB",
    confidenceTier: "elite",
    timingContext: "Inning 7",
    updatedAt: "2026-07-18T12:00:00.000Z",
    // Forbidden fields — present on the input to prove the builder never
    // reads/forwards them, even though PreviewSourceItem's declared type
    // doesn't include them (a real caller could still pass a wider object).
    playerOrTeam: "SENTINEL_PLAYER_NAME",
    team: "SENTINEL_TEAM",
    market: "sentinel_market",
    betDirection: "SENTINEL_DIRECTION",
    gameId: "SENTINEL_GAME_ID",
    playerId: "SENTINEL_PLAYER_ID",
    thesis: "SENTINEL_THESIS",
    probability: 87.5,
    line: 137.5,
    ...overrides,
  };
}

test("buildLiveEdgePreview never leaks forbidden fields (sentinel absence)", () => {
  const items = [fullFidelityFixtureItem()];
  const result = buildLiveEdgePreview(1, items as any);
  const json = JSON.stringify(result);
  for (const sentinel of FORBIDDEN_SENTINELS) {
    if (json.includes(sentinel)) {
      throw new Error(`buildLiveEdgePreview leaked forbidden sentinel "${sentinel}" — full output: ${json}`);
    }
  }
});

test("buildLiveEdgePreview.activeCount is echoed verbatim, decoupled from items.length", () => {
  const items = [fullFidelityFixtureItem(), fullFidelityFixtureItem()];
  const result = buildLiveEdgePreview(42, items as any);
  assertEq(result.activeCount, 42, "activeCount echoed, not items.length (2)");
});

test("buildLiveEdgePreview([]) → honest empty state", () => {
  const result = buildLiveEdgePreview(0, []);
  assertDeepEq(result, { activeCount: 0, sports: [], updatedAt: null, cards: [] }, "empty preview");
});

test("buildLiveEdgePreview caps cards at 3 regardless of input size", () => {
  const items = Array.from({ length: 10 }, (_, i) => fullFidelityFixtureItem({ sport: "MLB", timingContext: null }));
  const result = buildLiveEdgePreview(10, items as any);
  assertEq(result.cards.length, 3, "cards capped at 3");
});

test("buildLiveEdgePreview card timingContext is coarsened, never the verbatim per-play value", () => {
  const items = [fullFidelityFixtureItem({ timingContext: "Inning 7" })];
  const result = buildLiveEdgePreview(1, items as any);
  assertEq(result.cards[0].timingContext, "Late", "Inning 7 coarsens to Late, not passed through verbatim");
});

// ─────────────────────────────────────────────────────────────────────────
// 5. buildTopPlaysResponse / buildEdgeFeedResponse — exact shape
// ─────────────────────────────────────────────────────────────────────────

function fixtureTopPlay(overrides: Partial<TopPlayItem> = {}): TopPlayItem {
  return {
    id: "mlb_SENTINEL_PLAYER_ID_sentinel_market",
    sport: "MLB",
    playerOrTeam: "SENTINEL_PLAYER_NAME",
    market: "sentinel_market",
    marketLabel: "Props",
    side: "OVER",
    line: 137.5,
    probability: 87.5,
    edge: 12.3,
    projection: 1.5,
    summary: "SENTINEL_THESIS",
    gameId: "SENTINEL_GAME_ID",
    playerId: "SENTINEL_PLAYER_ID",
    team: "SENTINEL_TEAM",
    betDirection: "SENTINEL_DIRECTION",
    routeTarget: "mlb",
    confidenceTier: "ELITE",
    updatedAt: "2026-07-18T12:00:00.000Z",
    timingContext: "Inning 7",
    thesis: "SENTINEL_THESIS",
    ...overrides,
  };
}

const FREE_USER: MinimalUser = { subscriptionTier: null, isAdmin: false };
const PAID_ELITE: MinimalUser = { subscriptionTier: "elite", isAdmin: false };

test("buildTopPlaysResponse, access=full → complete unaltered payload, byte for byte", () => {
  const plays = [fixtureTopPlay()];
  const body = buildTopPlaysResponse(PAID_ELITE, null, 1, plays);
  assertDeepEq(body, { access: "full", plays }, "full body deep-equal");
});

test("buildTopPlaysResponse, access=preview → exact minimal key set, no forbidden fields", () => {
  const plays = [fixtureTopPlay()];
  const body: any = buildTopPlaysResponse(FREE_USER, null, 1, plays);
  assertKeys(body, ["access", "preview"], "top-plays preview top-level keys");
  assertKeys(body.preview, ["activeCount", "sports", "updatedAt", "cards"], "top-plays preview.preview keys");
  for (const card of body.preview.cards) {
    assertKeys(card, ["sport", "confidenceTier", "timingContext"], "top-plays preview card keys");
  }
  const json = JSON.stringify(body);
  for (const sentinel of FORBIDDEN_SENTINELS) {
    if (json.includes(sentinel)) {
      throw new Error(`buildTopPlaysResponse preview leaked "${sentinel}": ${json}`);
    }
  }
});

const EDGE_FEED_ENVELOPE = { updatedAt: 1_700_000_000_000, generatedAt: 1_700_000_001_000, staleCount: 0, edgeCacheEntries: 3 };

function fixtureMlbSignal() {
  return {
    signalTier: "elite",
    confidenceTier: "ELITE",
    timingContext: "Inning 7",
    updatedAt: 1_700_000_000_500,
    playerName: "SENTINEL_PLAYER_NAME",
    team: "SENTINEL_TEAM",
    market: "sentinel_market",
    recommendedSide: "SENTINEL_DIRECTION",
    gameId: "SENTINEL_GAME_ID",
    playerId: "SENTINEL_PLAYER_ID",
    thesis: "SENTINEL_THESIS",
    line: 137.5,
  };
}

test("buildEdgeFeedResponse, access=full, default view → complete unaltered payload", () => {
  const signals = [fixtureMlbSignal()];
  const body = buildEdgeFeedResponse(PAID_ELITE, null, 1, signals, EDGE_FEED_ENVELOPE, "default");
  assertDeepEq(
    body,
    { access: "full", mode: "live", signals, updatedAt: EDGE_FEED_ENVELOPE.updatedAt, generatedAt: EDGE_FEED_ENVELOPE.generatedAt, staleCount: EDGE_FEED_ENVELOPE.staleCount, edgeCacheEntries: EDGE_FEED_ENVELOPE.edgeCacheEntries },
    "edge-feed full default body deep-equal",
  );
});

test("buildEdgeFeedResponse, access=full, market-signals view → complete unaltered payload", () => {
  const signals = [fixtureMlbSignal()];
  const extra = { rows: ["SENTINEL_ROW_NOT_A_LEAK_JUST_A_FIXTURE"], grouped: { ACTION_NOW: [] }, unknownInningCount: 0, unknownInningReasons: {} };
  const body = buildEdgeFeedResponse(PAID_ELITE, null, 1, signals, EDGE_FEED_ENVELOPE, "market-signals", extra);
  assertDeepEq(
    body,
    {
      access: "full",
      mode: "live",
      view: "market-signals",
      rows: extra.rows,
      grouped: extra.grouped,
      unknownInningCount: extra.unknownInningCount,
      unknownInningReasons: extra.unknownInningReasons,
      updatedAt: EDGE_FEED_ENVELOPE.updatedAt,
      generatedAt: EDGE_FEED_ENVELOPE.generatedAt,
      staleCount: EDGE_FEED_ENVELOPE.staleCount,
      edgeCacheEntries: EDGE_FEED_ENVELOPE.edgeCacheEntries,
    },
    "edge-feed full market-signals body deep-equal",
  );
});

test("buildEdgeFeedResponse, access=preview, default view → exact minimal shape, no envelope fields", () => {
  const signals = [fixtureMlbSignal()];
  const body: any = buildEdgeFeedResponse(FREE_USER, null, 1, signals, EDGE_FEED_ENVELOPE, "default");
  assertKeys(body, ["access", "preview"], "edge-feed preview (default view) top-level keys — no mode/generatedAt/staleCount/edgeCacheEntries/signals");
  assertKeys(body.preview, ["activeCount", "sports", "updatedAt", "cards"], "edge-feed preview.preview keys");
});

test("buildEdgeFeedResponse, access=preview, market-signals view → COLLAPSES to the same exact minimal shape — rows/grouped/unknownInningCount never partially exposed", () => {
  const signals = [fixtureMlbSignal()];
  const extra = { rows: ["SENTINEL_ROW"], grouped: { ACTION_NOW: ["x"] }, unknownInningCount: 5, unknownInningReasons: { foo: 1 } };
  const body: any = buildEdgeFeedResponse(FREE_USER, null, 1, signals, EDGE_FEED_ENVELOPE, "market-signals", extra);
  assertKeys(body, ["access", "preview"], "edge-feed preview (market-signals view) collapses to minimal shape too");
  const json = JSON.stringify(body);
  for (const sentinel of [...FORBIDDEN_SENTINELS, "SENTINEL_ROW"]) {
    if (json.includes(sentinel)) {
      throw new Error(`buildEdgeFeedResponse market-signals preview leaked "${sentinel}": ${json}`);
    }
  }
});

test("buildEdgeFeedResponse preview (both views) never includes staleCount/edgeCacheEntries/generatedAt/mode/rows/grouped/unknownInningCount", () => {
  const signals = [fixtureMlbSignal()];
  for (const view of ["default", "market-signals"] as const) {
    const body: any = buildEdgeFeedResponse(FREE_USER, null, 1, signals, EDGE_FEED_ENVELOPE, view, { rows: [], grouped: {}, unknownInningCount: 0, unknownInningReasons: {} });
    for (const forbiddenKey of ["mode", "generatedAt", "staleCount", "edgeCacheEntries", "rows", "grouped", "unknownInningCount", "unknownInningReasons", "signals", "view"]) {
      if (forbiddenKey in body) {
        throw new Error(`buildEdgeFeedResponse(view=${view}) preview unexpectedly includes "${forbiddenKey}"`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Secondary regression guard — routes.ts delegates the whole body
// ─────────────────────────────────────────────────────────────────────────

// Bounds a route handler's source slice by the start of the NEXT top-level
// app.get/app.post registration, rather than a fixed character count, so
// this doesn't silently under-scan (or over-scan into the next route) as
// either handler grows.
function extractRouteSource(src: string, routeStartNeedle: string): string {
  const start = src.indexOf(routeStartNeedle);
  if (start === -1) throw new Error(`could not locate route "${routeStartNeedle}" in routes.ts`);
  const nextRouteRegex = /\n {2}app\.(get|post|patch|delete|put)\(/g;
  nextRouteRegex.lastIndex = start + routeStartNeedle.length;
  const next = nextRouteRegex.exec(src);
  return src.slice(start, next ? next.index : src.length);
}

test("server/routes.ts /api/top-plays delegates its res.json() to buildTopPlaysResponse", () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), "server", "routes.ts"), "utf8");
  const slice = extractRouteSource(src, 'app.get("/api/top-plays"');
  if (!slice.includes("buildTopPlaysResponse(")) {
    throw new Error("/api/top-plays route no longer calls buildTopPlaysResponse — response shape could diverge from tested behavior");
  }
});

test("server/routes.ts /api/mlb/edge-feed delegates its res.json() to buildEdgeFeedResponse", () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), "server", "routes.ts"), "utf8");
  const slice = extractRouteSource(src, 'app.get("/api/mlb/edge-feed"');
  const occurrences = slice.split("buildEdgeFeedResponse(").length - 1;
  if (occurrences < 3) {
    throw new Error(`/api/mlb/edge-feed route calls buildEdgeFeedResponse ${occurrences} times, expected at least 3 (preview short-circuit + market-signals view + default view) — a return path may have regressed to constructing its own response body`);
  }
});

// — runner —
let pass = 0;
let fail = 0;
const failures: string[] = [];
for (const c of cases) {
  try {
    c.fn();
    pass++;
    console.log(`  ✓ ${c.name}`);
  } catch (e: any) {
    fail++;
    failures.push(`  ✗ ${c.name}\n      ${e.message}`);
    console.log(`  ✗ ${c.name}`);
    console.log(`      ${e.message}`);
  }
}
console.log(`\n[Live Edge Access] ${pass}/${pass + fail} cases passed`);
if (fail > 0) {
  console.error(`\nFAILURES:\n${failures.join("\n")}`);
  process.exit(1);
}
