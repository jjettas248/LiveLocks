// Run: npx tsx server/pregameTargets/ingestion/nfl/nflIngestionCoverage.test.ts
// PR6 — NFL coverage: success → adapter_retrievable (live depth PENDING MEASUREMENT),
// failure → incomplete (never complete), prior season → historical knownAt unsupported.
import { classifyNflCoverage, PENDING_MEASUREMENT_LABEL } from "./nflIngestionCoverage";
import type { NflWeeklyAdapterResult } from "./nflSourceContracts";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const okRes = (season: number, n: number): NflWeeklyAdapterResult => ({ ok: true, kind: "nflverse_weekly_stats", sourceKey: "sk", season, records: Array.from({ length: n }, () => ({} as never)), diagnostics: { blankKeyRows: 0, duplicateRowsCollapsed: 0 }, rawPayload: {}, fetchedAt: "x" });
const failRes = (season: number): NflWeeklyAdapterResult => ({ ok: false, kind: "nflverse_weekly_stats", sourceKey: "sk", season, reason: "incomplete_response", rawPayload: {}, fetchedAt: "x" });

{
  const cur = classifyNflCoverage(okRes(2024, 300), 2024);
  ok(cur.coverage === "adapter_retrievable" && cur.recordCount === 300, "success this run → adapter_retrievable");
  ok(cur.knownAtSupport === "forward_supported" && cur.reason.includes(PENDING_MEASUREMENT_LABEL), "current season forward-supported; live depth pending measurement");

  const prior = classifyNflCoverage(okRes(2022, 280), 2024);
  ok(prior.knownAtSupport === "historical_unsupported", "prior season → historical knownAt unsupported");

  const bad = classifyNflCoverage(failRes(2024), 2024);
  ok(bad.coverage === "incomplete" && bad.recordCount === 0 && bad.reason === "provider_incomplete_response", "failure → incomplete (never complete)");
}

console.log(`\nnflIngestionCoverage.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
