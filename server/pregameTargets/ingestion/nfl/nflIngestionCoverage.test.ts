// Run: npx tsx server/pregameTargets/ingestion/nfl/nflIngestionCoverage.test.ts
// PR6 — NFL coverage spans the whole pipeline (parse → schedule-resolution → features →
// persistence), never collapsing to "weekly parsed N". Historical knownAt unsupported for
// prior seasons; live full-season depth stays PENDING MEASUREMENT (never fabricated).
import { buildNflCoverage, PENDING_MEASUREMENT_LABEL } from "./nflIngestionCoverage";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const counts = (over: Record<string, number> = {}) => ({
  rawWeeklyRows: 500, structurallyAcceptedWeeklyRows: 480, scheduleRawRows: 7000, scheduleRowsForSeason: 285,
  scheduleResolvedRows: 470, unresolvedGameIds: 10, contradictoryRows: 0, featureBearingPlayers: 300,
  rawCapturesPersisted: 3, featureRowsPersisted: 2350, ...over,
});

{
  const cur = buildNflCoverage({ season: 2024, currentSeason: 2024, coverage: "adapter_retrievable", counts: counts() });
  ok(cur.coverage === "adapter_retrievable" && cur.knownAtSupport === "forward_supported", "current season forward-supported");
  ok(cur.counts.scheduleResolvedRows === 470 && cur.counts.unresolvedGameIds === 10 && cur.counts.featureRowsPersisted === 2350, "every pipeline stage separately reported");
  ok(cur.reason.includes(PENDING_MEASUREMENT_LABEL), "live full-season depth stays PENDING MEASUREMENT");

  const prior = buildNflCoverage({ season: 2022, currentSeason: 2024, coverage: "adapter_retrievable", counts: counts() });
  ok(prior.knownAtSupport === "historical_unsupported", "prior season → historical knownAt unsupported");

  const inc = buildNflCoverage({ season: 2024, currentSeason: 2024, coverage: "incomplete", counts: counts({ featureRowsPersisted: 0, scheduleResolvedRows: 0, unresolvedGameIds: 480 }) });
  ok(inc.coverage === "incomplete" && inc.reason.startsWith("incomplete:"), "a parse with zero resolved rows is NOT usable coverage → incomplete");
  ok(inc.counts.rawCapturesPersisted === 3, "counts preserved even when incomplete (no fabrication)");
}

console.log(`\nnflIngestionCoverage.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
