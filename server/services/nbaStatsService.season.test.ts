// Run: npx tsx server/services/nbaStatsService.season.test.ts
// Pregame Targets PR5 — provider season support: an omitted season resolves to
// the current season (byte-equivalent current-season request preserved); an
// explicit season string is used verbatim (reaches the provider for a prior-season pull).
import { resolveGameLogSeason } from "./nbaStatsService";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const current = resolveGameLogSeason(); // whatever getCurrentSeason() returns

// ── Omitted / blank season → current (unchanged behavior) ───────────────────
{
  ok(typeof current === "string" && /^\d{4}-\d{2}$/.test(current), "current season resolves to a season string");
  ok(resolveGameLogSeason(undefined) === current, "undefined → current season (unchanged)");
  ok(resolveGameLogSeason(null) === current, "null → current season (unchanged)");
  ok(resolveGameLogSeason("") === current, "empty string → current season (unchanged)");
  ok(resolveGameLogSeason("   ") === current, "whitespace → current season (unchanged)");
}

// ── Explicit prior season → used verbatim (reaches the provider) ────────────
{
  ok(resolveGameLogSeason("2023-24") === "2023-24", "explicit prior season used verbatim");
  ok(resolveGameLogSeason("2024-25") === "2024-25", "explicit prior season used verbatim (2)");
  ok(resolveGameLogSeason("  2022-23  ") === "2022-23", "explicit season trimmed but preserved");
  ok(resolveGameLogSeason("2023-24") !== current, "explicit prior season differs from current (proves it is honored)");
}

console.log(`\nnbaStatsService.season.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
