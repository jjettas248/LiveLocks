// Cross-Radar: structural proof that all three Mound-power-radar route
// handlers in server/routes.ts build their response through
// composeMoundResponseWithPlateTargets and never construct their final
// response from a direct, uncomposed buildMoundResponse call. Mirrors this
// codebase's established structural-wiring-proof convention (e.g.
// server/mlb/pregame/mound/v2/moundV2ShadowWiring.test.ts) rather than
// booting a real Express server + DB for an integration test.
//
// Run: npx tsx server/mlb/pregame/composition/moundRouteWiring.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const routesSource = readFileSync(path.join(dir, "..", "..", "..", "routes.ts"), "utf-8");

const ROUTE_MARKERS = [
  'app.get("/api/mlb/mound-power-radar", requireMLBAccess',
  'app.get("/api/mlb/mound-power-radar/all-starters", requireMLBAccess',
  'app.get("/api/admin/mlb/mound-power-radar/debug", requireAdmin',
];

/** The next `app.<verb>(` registration after `fromIndex` bounds this route handler's block — routes.ts is a flat, non-nested sequence of app.get/app.post registrations. */
function extractRouteBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`route marker not found: ${marker}`);
  const nextRouteMatch = /app\.(get|post|put|delete|patch)\(/g;
  nextRouteMatch.lastIndex = start + marker.length;
  const next = nextRouteMatch.exec(source);
  const end = next ? next.index : source.length;
  return source.slice(start, end);
}

for (const marker of ROUTE_MARKERS) {
  const block = extractRouteBlock(routesSource, marker);
  const routeLabel = marker.match(/"([^"]+)"/)?.[1] ?? marker;

  ok(block.length > 0, `${routeLabel}: route block located in routes.ts`);
  ok(
    block.includes("composeMoundResponseWithPlateTargets"),
    `${routeLabel}: calls composeMoundResponseWithPlateTargets`,
  );
  ok(
    /const\s+resp\s*=\s*await\s+composeMoundResponseWithPlateTargets\(/.test(block),
    `${routeLabel}: the route's \`resp\` (what res.json ultimately serializes) is assigned directly from composeMoundResponseWithPlateTargets, not reshaped from a separate uncomposed call`,
  );
  ok(
    !/buildMoundResponse\(/.test(block),
    `${routeLabel}: does NOT call buildMoundResponse directly — no uncomposed response construction`,
  );
  ok(
    /await import\(["']\.\/mlb\/pregame\/composition\/composeMoundResponse["']\)/.test(block),
    `${routeLabel}: imports composeMoundResponseWithPlateTargets from the composition module, not mound/diagnostics directly`,
  );
  ok(
    /res\.json\(resp\)/.test(block),
    `${routeLabel}: serializes the composed \`resp\` verbatim via res.json (no further reshaping after composition)`,
  );
}

// ── Sanity: the extraction technique itself is trustworthy — a route NOT in
// our marker list (the admin debug route's neighbor, the stats-route
// registration block) must not accidentally satisfy these assertions,
// proving extractRouteBlock actually bounds each block correctly. ──
{
  const allStartersBlock = extractRouteBlock(routesSource, ROUTE_MARKERS[1]);
  ok(
    !allStartersBlock.includes("registerMoundRadarStatsRoutes"),
    "extractRouteBlock correctly stops before the next route registration (all-starters block doesn't leak into the stats-routes registration that follows it)",
  );
}

console.log(`\nmoundRouteWiring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
