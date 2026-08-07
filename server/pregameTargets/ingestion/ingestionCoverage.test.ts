// Run: npx tsx server/pregameTargets/ingestion/ingestionCoverage.test.ts
// Pregame Targets PR5 — coverage: adapter success → adapter_retrievable (live
// depth pending), failure/incomplete → incomplete (never "complete"), historical
// knownAt unsupported, current-season forward-supported.
import { classifySourceCoverage, buildCoverageReport, PENDING_MEASUREMENT_LABEL } from "./ingestionCoverage";
import type { NbaAdapterResult } from "./nbaSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const okResult = (season: number, n: number): NbaAdapterResult => ({
  ok: true, kind: "nba_stats_playergamelog", sourceKey: "sk", season, entityNativeId: "1",
  records: Array.from({ length: n }, () => ({ gameId: "g", gameDate: "2024-01-15", teamTricode: "DEN", minutes: 30, points: 20, rebounds: 5, assists: 5, threePointersMade: 2, timestamps: { sourceEffectiveAt: "", sourcePublishedAt: null, fetchedAt: "2026-08-05T18:00:00Z", knownAtPolicyVersion: "v1" } })),
  rawPayload: {}, fetchedAt: "2026-08-05T18:00:00Z",
});
const failResult = (season: number): NbaAdapterResult => ({
  ok: false, kind: "nba_stats_playergamelog", sourceKey: "sk", season, entityNativeId: "1", reason: "incomplete_response", rawPayload: {}, fetchedAt: "x",
});

// ── Success → adapter_retrievable, live depth pending ───────────────────────
{
  const c = classifySourceCoverage(okResult(2026, 40), 2026);
  ok(c.coverage === "adapter_retrievable", "success → adapter_retrievable (never verified_available without a real pull)");
  ok(c.recordCount === 40, "record count reported");
  ok(c.reason.includes(PENDING_MEASUREMENT_LABEL), "live depth marked pending measurement");
  ok(c.knownAtSupport === "forward_supported", "current season → forward-supported knownAt");
}

// ── Prior season → historical knownAt unsupported ───────────────────────────
{
  const c = classifySourceCoverage(okResult(2024, 30), 2026);
  ok(c.knownAtSupport === "historical_unsupported", "prior season → historical knownAt unsupported");
  ok(c.reason.includes("historical knownAt unsupported"), "reason states the unsupported historical knownAt");
}

// ── Failure/incomplete → incomplete, never complete ─────────────────────────
{
  const c = classifySourceCoverage(failResult(2026), 2026);
  ok(c.coverage === "incomplete", "provider failure → incomplete (never reported complete)");
  ok(c.recordCount === 0, "no records claimed on failure (no fabrication)");
}

// ── Aggregate report ────────────────────────────────────────────────────────
{
  const rep = buildCoverageReport([okResult(2026, 40), okResult(2024, 30), failResult(2023)], 2026);
  ok(rep.bySource.length === 3, "one row per source/season");
  ok(rep.allRetrievable === false, "a single incomplete source fails allRetrievable");
}

console.log(`\ningestionCoverage.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
