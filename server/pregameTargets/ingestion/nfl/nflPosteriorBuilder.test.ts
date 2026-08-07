// Run: npx tsx server/pregameTargets/ingestion/nfl/nflPosteriorBuilder.test.ts
// PR6 — NFL posterior fold via PR1 modules: deterministic/order-independent, value-bearing
// only (missing/not_applicable skipped), per-entity accumulation, same-game correction,
// current+2-prior rollover (out-of-window weight 0).
import { foldNflPosteriors } from "./nflPosteriorBuilder";
import { NFL_FEATURE_VERSION } from "./nflFeatureBuilder";
import type { AsOfFeatureRow } from "../../../../shared/pregameTargets/featureStore";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const row = (over: Partial<AsOfFeatureRow>): AsOfFeatureRow => ({
  sport: "nfl", entityCanonicalId: "nfl:player:1", entityKind: "player",
  featureKey: "nfl.player.targets_per_game", featureVersion: NFL_FEATURE_VERSION, season: 2024,
  validAt: "2024-09-08T00:00:00Z", knownAt: "2026-08-05T18:00:00Z", state: "observed", value: 10,
  sourceId: "s", derivedFromGameIds: ["nfl:game:2024_01_sf_kc"], ...over,
});
const asOf = "2026-08-06T00:00:00Z";

// ── Value-bearing only; missing / not_applicable skipped ────────────────────
{
  const out = foldNflPosteriors({ rows: [row({}), row({ state: "missing", value: null, derivedFromGameIds: ["nfl:game:g2"] }), row({ state: "not_applicable", value: null, derivedFromGameIds: ["nfl:game:g3"] })], currentSeason: 2024, asOfDate: asOf });
  const p = out.get("nfl.player.targets_per_game")!;
  const games = Object.values(p.bySeason as Record<number, { byGame: Record<string, unknown> }>)[0].byGame;
  ok(Object.keys(games).length === 1, "only the value-bearing observed row folded");
}

// ── Order-independent + deterministic ───────────────────────────────────────
{
  const a = foldNflPosteriors({ rows: [row({ derivedFromGameIds: ["nfl:game:a"], value: 8 }), row({ derivedFromGameIds: ["nfl:game:b"], value: 12 })], currentSeason: 2024, asOfDate: asOf });
  const b = foldNflPosteriors({ rows: [row({ derivedFromGameIds: ["nfl:game:b"], value: 12 }), row({ derivedFromGameIds: ["nfl:game:a"], value: 8 })], currentSeason: 2024, asOfDate: asOf });
  ok(JSON.stringify(a.get("nfl.player.targets_per_game")!.bySeason) === JSON.stringify(b.get("nfl.player.targets_per_game")!.bySeason), "fold is order-independent");
}

// ── Same-game correction keeps a single lineage entry ───────────────────────
{
  const first = foldNflPosteriors({ rows: [row({ value: 10 })], currentSeason: 2024, asOfDate: asOf });
  const corrected = foldNflPosteriors({ rows: [row({ value: 13 })], currentSeason: 2024, asOfDate: asOf, priorStates: first });
  const p = corrected.get("nfl.player.targets_per_game")!;
  const byGame = (p.bySeason as Record<number, { byGame: Record<string, { wx: number; w: number }> }>)[2024].byGame;
  const gk = Object.keys(byGame)[0];
  ok(Object.keys(byGame).length === 1, "same game → single lineage entry (not double-counted)");
  ok(Math.abs(byGame[gk].wx / byGame[gk].w - 13) < 1e-9, "posterior reflects the corrected per-game value");
}

// ── Accumulates across seasons; out-of-window prior dropped (weight 0) ───────
{
  let st = foldNflPosteriors({ rows: [row({ season: 2024, validAt: "2024-09-08T00:00:00Z" })], currentSeason: 2024, asOfDate: asOf });
  st = foldNflPosteriors({ rows: [row({ season: 2023, validAt: "2023-09-10T00:00:00Z", derivedFromGameIds: ["nfl:game:p1"] })], currentSeason: 2024, asOfDate: asOf, priorStates: st });
  const seasons = Object.keys(st.get("nfl.player.targets_per_game")!.bySeason as Record<string, unknown>);
  ok(seasons.includes("2024") && seasons.includes("2023"), "current + prior-1 both retained");
  // A season beyond the 2-prior window (offset 3) gets weight 0 → vetoed → not stored.
  const dropped = foldNflPosteriors({ rows: [row({ season: 2021, validAt: "2021-09-12T00:00:00Z", derivedFromGameIds: ["nfl:game:old"] })], currentSeason: 2024, asOfDate: asOf });
  ok(!(dropped.get("nfl.player.targets_per_game")?.bySeason as Record<string, unknown> | undefined)?.["2021"], "out-of-window season (offset 3) dropped");
}

console.log(`\nnflPosteriorBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
