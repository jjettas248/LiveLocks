// MLB canonical edge-version segregation — invariants.
//
// Run: npx tsx server/analytics/mlbEdgeVersion.test.ts

import {
  canonicalMlbEdgePp,
  isCanonicalMlbEdgeRow,
  analyticsEdgePp,
  MLB_CANONICAL_EDGE_VERSION,
} from "./mlbEdgeVersion";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

ok(MLB_CANONICAL_EDGE_VERSION === "novig_v1", "canonical version constant");

// Canonical MLB row → uses model_edge
{
  const row = { sport: "mlb", edgeVersion: "novig_v1", modelEdge: "4.2", edgeGap: null };
  ok(isCanonicalMlbEdgeRow(row) === true, "novig_v1 row is canonical");
  ok(canonicalMlbEdgePp(row) === 4.2, "canonical edge = model_edge");
  ok(analyticsEdgePp(row) === 4.2, "analytics edge uses canonical for mlb");
}

// Legacy MLB row (edge_version null, edge_gap=prob-50) → segregated out (null)
{
  const legacy = { sport: "mlb", edgeVersion: null, modelEdge: null, edgeGap: "22.7" };
  ok(isCanonicalMlbEdgeRow(legacy) === false, "legacy row not canonical");
  ok(canonicalMlbEdgePp(legacy) === null, "legacy canonical edge null");
  ok(analyticsEdgePp(legacy) === null, "legacy MLB edge excluded from analytics (not 22.7)");
}

// MLB row tagged canonical but missing model_edge → null (never falls back to edge_gap)
{
  const bad = { sport: "mlb", edgeVersion: "novig_v1", modelEdge: null, edgeGap: "9" };
  ok(canonicalMlbEdgePp(bad) === null, "canonical tag but no model_edge → null");
  ok(analyticsEdgePp(bad) === null, "never falls back to edge_gap for mlb");
}

// NBA row → keeps edge_gap semantics
{
  const nba = { sport: "nba", edgeVersion: null, modelEdge: null, edgeGap: "3.1" };
  ok(analyticsEdgePp(nba) === 3.1, "NBA uses edge_gap unchanged");
  ok(canonicalMlbEdgePp(nba) === null, "NBA is not a canonical mlb edge row");
}

console.log(`\nmlbEdgeVersion.test.ts — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
