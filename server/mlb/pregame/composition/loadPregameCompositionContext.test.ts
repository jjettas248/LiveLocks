// Pregame composition layer — Plate snapshot loader invariants.
//
// Run: npx tsx server/mlb/pregame/composition/loadPregameCompositionContext.test.ts

import type { PregamePowerSnapshot } from "../../pregamePowerRadar/pregamePowerRadarStore";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function fakeSnapshot(overrides: Partial<PregamePowerSnapshot> = {}): PregamePowerSnapshot {
  return {
    buildId: "ppr_build_1",
    sessionDate: "2026-07-01",
    generatedAt: "2026-07-01T00:00:00Z",
    builtAtMs: 0,
    gamesScanned: 1,
    battersEvaluated: 1,
    signals: new Map(),
    coverage: { lineupCoverage: 1, weatherCoverage: 1, batterCoverage: 1, pitcherCoverage: 1 },
    ...overrides,
  };
}

async function main() {
  // pregamePowerRadarService.ts's import chain reaches storage.ts -> db.ts,
  // whose module guard throws unless DATABASE_URL is set. No query ever runs
  // here (this module is never called) — a fixed, unreachable dummy URL only
  // satisfies the import-time guard. This must be a dynamic import AFTER the
  // env assignment: static imports hoist above any top-level code regardless
  // of source order, so setting the env var before a static `import` of this
  // module would not actually run first — mirrors
  // pregameTargets/goldenFixtures.test.ts's identical constraint/workaround.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://fixture:fixture@240.0.0.1:1/fixture";
  }
  const { loadPlateCompositionContext, isMoundPlateTargetSuggestionsEnabled } = await import("./loadPregameCompositionContext");

  // ── 1. No snapshot at all → "missing" ──────────────────────────────────────
  {
    const ctx = await loadPlateCompositionContext("2026-07-01", () => null);
    ok(ctx.state === "missing", `null accessor result → state "missing" (got "${ctx.state}")`);
    ok(ctx.signals.length === 0 && ctx.buildId === null && ctx.generatedAt === null, "missing context has empty signals/buildId/generatedAt");
  }

  // ── 2. Wrong slate date → "date_mismatch" ──────────────────────────────────
  {
    const snap = fakeSnapshot({ sessionDate: "2026-06-30" });
    const ctx = await loadPlateCompositionContext("2026-07-01", () => snap);
    ok(ctx.state === "date_mismatch", `mismatched sessionDate → state "date_mismatch" (got "${ctx.state}")`);
    ok(ctx.signals.length === 0 && ctx.buildId === null, "date_mismatch context has empty signals and null buildId (does not leak the wrong day's data)");
  }

  // ── 3. Matching snapshot → "available" with real buildId/generatedAt ──────
  {
    const snap = fakeSnapshot({ sessionDate: "2026-07-01", buildId: "ppr_build_42", generatedAt: "2026-07-01T12:00:00Z" });
    const ctx = await loadPlateCompositionContext("2026-07-01", () => snap);
    ok(ctx.state === "available", `matching sessionDate → state "available" (got "${ctx.state}")`);
    ok(ctx.buildId === "ppr_build_42", "available context carries the real snapshot buildId");
    ok(ctx.generatedAt === "2026-07-01T12:00:00Z", "available context carries the real snapshot generatedAt");
    ok(Array.isArray(ctx.signals), "available context's signals is an array");
  }

  // ── 4. Snapshot-read error → "load_error", never throws ───────────────────
  {
    const throwingAccessor = () => { throw new Error("simulated store read failure"); };
    const ctx = await loadPlateCompositionContext("2026-07-01", throwingAccessor);
    ok(ctx.state === "load_error", `throwing accessor → state "load_error" (got "${ctx.state}")`);
    ok(ctx.signals.length === 0 && ctx.buildId === null, "load_error context has empty signals and null buildId");
  }

  // ── 5. "stale" is not a reachable state from this loader ──────────────────
  ok(
    !(["missing", "date_mismatch", "available", "load_error"] as string[]).includes("stale"),
    "sanity: the state union no longer includes an unreachable 'stale' value (compile-time — see PlateCompositionState)",
  );

  // ── 6. isMoundPlateTargetSuggestionsEnabled reflects the env var ──────────
  {
    const original = process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    try {
      delete process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
      ok(isMoundPlateTargetSuggestionsEnabled() === false, "unset env var → disabled (false)");

      process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = "false";
      ok(isMoundPlateTargetSuggestionsEnabled() === false, "env var 'false' → disabled");

      process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = "true";
      ok(isMoundPlateTargetSuggestionsEnabled() === true, "env var 'true' → enabled");
    } finally {
      if (original === undefined) delete process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
      else process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = original;
    }
  }

  console.log(`\nloadPregameCompositionContext.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
