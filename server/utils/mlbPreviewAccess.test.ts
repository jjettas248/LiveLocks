// resolveMlbPreviewConsumeKey / fingerprintRouteParams / isMlbPreviewDenylistedRoute — invariants.
//
// requireMLBAccess itself (server/auth.ts) needs a real Express req/res +
// database and is covered by server/mlbAccessControlGate.integration.test.ts
// instead (mirrors server/services/liveEdgeAccess.integration.test.ts's
// convention) — this file covers only the extracted pure logic,
// dependency-free so it runs without a live database.
//
// Run: npx tsx server/utils/mlbPreviewAccess.test.ts

import {
  resolveMlbPreviewConsumeKey,
  fingerprintRouteParams,
  isMlbPreviewDenylistedRoute,
  MLB_PREVIEW_DENYLIST_ROUTES,
} from "./mlbPreviewAccess";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── A real gameId always wins, unchanged from before the fix ───────────────
{
  ok(resolveMlbPreviewConsumeKey("777123", { method: "GET", routePattern: "/api/mlb/whatever/:gameId", params: { gameId: "777123" } }) === "mlb-777123", "a real gameId produces the same 'mlb-<id>' key as before — per-game behavior is unchanged");
  ok(resolveMlbPreviewConsumeKey("abc", { method: "GET", routePattern: "/x", params: {} }) === "mlb-abc", "a non-numeric gameId still produces the same key shape");
}

// ── fingerprintRouteParams: deterministic, order-independent, empty-safe ────
{
  ok(fingerprintRouteParams(null) === "", "null params fingerprints to empty string — never a hash of nothing");
  ok(fingerprintRouteParams(undefined) === "", "undefined params fingerprints to empty string");
  ok(fingerprintRouteParams({}) === "", "an empty params object fingerprints to empty string");
  const a = fingerprintRouteParams({ playerId: "123" });
  const b = fingerprintRouteParams({ playerId: "456" });
  ok(a !== "" && b !== "" && a !== b, "two different playerId values produce two different, non-empty fingerprints");
  const c1 = fingerprintRouteParams({ batter: "Judge", pitcher: "Cole" });
  const c2 = fingerprintRouteParams({ pitcher: "Cole", batter: "Judge" });
  ok(c1 === c2, "key order in the params object never changes the fingerprint (sorted internally)");
  const same1 = fingerprintRouteParams({ name: "Ohtani" });
  const same2 = fingerprintRouteParams({ name: "Ohtani" });
  ok(same1 === same2, "the same params always produce the same fingerprint (deterministic, no randomness/timestamp)");
}

// ── fingerprintRouteParams merges MULTIPLE sources (params, query, body) ────
{
  ok(fingerprintRouteParams({}, {}, {}) === "", "three empty sources still fingerprint to empty string");
  const dateA = fingerprintRouteParams({}, { date: "2026-07-01" }, {});
  const dateB = fingerprintRouteParams({}, { date: "2026-07-15" }, {});
  ok(dateA !== "" && dateA !== dateB, "a query-param-only identity (e.g. the record endpoints' ?date=) fingerprints distinctly by value");
  const sameDateViaParamsOrQuery1 = fingerprintRouteParams({ x: "1" }, {}, {});
  const sameDateViaParamsOrQuery2 = fingerprintRouteParams({}, { x: "1" }, {});
  ok(sameDateViaParamsOrQuery1 === sameDateViaParamsOrQuery2, "the same key/value fingerprints identically whether it came from params or query — the merge doesn't care which source it came from");
  const bodyFingerprint = fingerprintRouteParams(null, null, { market: "hits", line: 6.5 });
  ok(bodyFingerprint !== "", "a body-only identity (e.g. a POST route's real payload) is fingerprinted too, defense-in-depth for any future gameId-less POST route not on the denylist");
}

// ── No gameId: keys scope to the SPECIFIC route, never a shared flat string ──
{
  const boardA = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/alerts", params: {} });
  const boardB = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/hr-radar", params: {} });
  ok(boardA !== boardB, `two different gameId-less routes produce two DIFFERENT keys (got "${boardA}" vs "${boardB}") — this is the core Correction 5 fix: visiting one route must never unlock another`);
  ok(boardA !== "mlb-general" && boardB !== "mlb-general", "neither key is the old flat 'mlb-general' string");
}

// ── No gameId, but a real path-param identity: distinct resources get distinct keys ──
{
  const player1 = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/player-history/:playerId", params: { playerId: "111" } });
  const player2 = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/player-history/:playerId", params: { playerId: "222" } });
  const player1Again = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/player-history/:playerId", params: { playerId: "111" } });
  ok(player1 !== player2, "two different playerIds on the SAME route produce two different keys — viewing player A's history never unlocks player B's");
  ok(player1 === player1Again, "the SAME playerId always resolves to the SAME key — a repeat view of the same resource is free, matching per-game behavior");
}

// ── resolveMlbPreviewConsumeKey incorporates query params too (e.g. ?date=) ──
{
  const recordDay1 = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/mound-radar/record", params: {}, query: { date: "2026-07-01" } });
  const recordDay2 = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/mound-radar/record", params: {}, query: { date: "2026-07-15" } });
  const recordNoDate = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/mound-radar/record", params: {} });
  ok(recordDay1 !== recordDay2, "two different ?date= values on the record endpoint produce two different keys — browsing the historical archive isn't a single free unlock");
  ok(recordNoDate !== recordDay1 && recordNoDate !== recordDay2, "an explicit ?date= key is distinct from the no-query (defaults to today) key");
}

// ── Multi-param routes (batter+pitcher) ─────────────────────────────────────
{
  const bvp1 = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/onlyhomers/bvp/:batter/:pitcher", params: { batter: "Judge", pitcher: "Cole" } });
  const bvp2 = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/onlyhomers/bvp/:batter/:pitcher", params: { batter: "Judge", pitcher: "Ohtani" } });
  ok(bvp1 !== bvp2, "a different pitcher (same batter) produces a different key");
}

// ── Same route pattern, different HTTP method -> different key ─────────────
{
  const getKey = resolveMlbPreviewConsumeKey(null, { method: "GET", routePattern: "/api/mlb/foo", params: {} });
  const postKey = resolveMlbPreviewConsumeKey(null, { method: "POST", routePattern: "/api/mlb/foo", params: {} });
  ok(getKey !== postKey, "GET and POST on the same path produce different keys — method is part of route identity");
}

// ── isMlbPreviewDenylistedRoute ──────────────────────────────────────────────
{
  ok(isMlbPreviewDenylistedRoute("POST", "/api/mlb/props"), "POST /api/mlb/props is denylisted");
  ok(isMlbPreviewDenylistedRoute("post", "/api/mlb/props"), "denylist check is case-insensitive on method");
  ok(isMlbPreviewDenylistedRoute("POST", "/api/mlb/calculate"), "POST /api/mlb/calculate is denylisted");
  ok(isMlbPreviewDenylistedRoute("POST", "/api/mlb/calculate-manual"), "POST /api/mlb/calculate-manual (arbitrary manual-input calculator) is denylisted");
  ok(isMlbPreviewDenylistedRoute("GET", "/api/mlb/odds"), "GET /api/mlb/odds (raw odds lookup) is denylisted");
  ok(!isMlbPreviewDenylistedRoute("GET", "/api/mlb/alerts"), "an ordinary board route is NOT denylisted");
  ok(!isMlbPreviewDenylistedRoute("GET", "/api/mlb/player-history/:playerId"), "a route with a real bounded identity is NOT denylisted");
  ok(!isMlbPreviewDenylistedRoute("GET", "/api/mlb/props"), "GET /api/mlb/props (wrong method) is NOT denylisted under GET — the denylist is exact on method+path, not path-only");
  ok(MLB_PREVIEW_DENYLIST_ROUTES.size === 4, `exactly the 4 known raw odds/calculation routes are denylisted (got ${MLB_PREVIEW_DENYLIST_ROUTES.size})`);
}

console.log(`\nmlbPreviewAccess.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
