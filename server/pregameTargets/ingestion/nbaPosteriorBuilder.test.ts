// Run: npx tsx server/pregameTargets/ingestion/nbaPosteriorBuilder.test.ts
// Pregame Targets PR5 — posterior fold: deterministic, preserves included-game
// lineage, no self-update, current+2-prior rollover, value-bearing only,
// order-independent, correction via same-game re-fold.
import { foldNbaPosteriors } from "./nbaPosteriorBuilder";
import { NBA_FEATURE_VERSION } from "./nbaFeatureBuilder";
import { combineSeasonWindow, posteriorMean, type PosteriorState } from "../posteriorState/posteriorState";
import type { AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) passed++; else { failed++; console.error(`  ✗ ${m}`); } }

const FK = "nba.player.points_per_min";
function row(over: Partial<AsOfFeatureRow>): AsOfFeatureRow {
  return {
    sport: "nba", entityCanonicalId: "nba:player:1", entityKind: "player", featureKey: FK, featureVersion: NBA_FEATURE_VERSION,
    season: 2026, validAt: "2026-01-15T00:00:00Z", knownAt: "2026-08-05T18:00:00Z", state: "observed", value: 0.7,
    sourceId: "snap", derivedFromGameIds: ["nba:game:G1"], ...over,
  };
}
const ASOF = "2026-08-06T00:00:00Z";

// ── Deterministic + order-independent fold ──────────────────────────────────
{
  const rows = [
    row({ value: 0.6, derivedFromGameIds: ["nba:game:G1"] }),
    row({ value: 0.8, derivedFromGameIds: ["nba:game:G2"] }),
  ];
  const a = foldNbaPosteriors({ rows, currentSeason: 2026, asOfDate: ASOF });
  const b = foldNbaPosteriors({ rows: [...rows].reverse(), currentSeason: 2026, asOfDate: ASOF });
  ok(JSON.stringify(a.get(FK)) === JSON.stringify(b.get(FK)), "fold is order-independent + deterministic");
  ok((a.get(FK)!.bySeason[2026]?.gameIds ?? []).length === 2, "both games folded into lineage");
}

// ── Included-game lineage preserved; value-bearing only ─────────────────────
{
  const rows = [
    row({ value: 0.7, derivedFromGameIds: ["nba:game:G1"] }),
    row({ state: "missing", value: null, derivedFromGameIds: ["nba:game:G2"] }),  // skipped
    row({ state: "not_applicable", value: null, derivedFromGameIds: ["nba:game:G3"] }), // skipped
    row({ state: "observed_zero", value: 0, derivedFromGameIds: ["nba:game:G4"] }), // folded (0)
  ];
  const state = foldNbaPosteriors({ rows, currentSeason: 2026, asOfDate: ASOF }).get(FK)!;
  ok(state.bySeason[2026].gameIds.length === 2, "only value-bearing rows (observed + observed_zero) folded");
  ok(state.bySeason[2026].gameIds.includes("nba:game:G1") && state.bySeason[2026].gameIds.includes("nba:game:G4"), "observed + observed_zero games in lineage");
  ok(!state.bySeason[2026].gameIds.includes("nba:game:G2"), "missing row not folded");
}

// ── No self-update: excludeGameId is refused ────────────────────────────────
{
  const rows = [row({ value: 0.7, derivedFromGameIds: ["nba:game:TARGET"] }), row({ value: 0.8, derivedFromGameIds: ["nba:game:OTHER"] })];
  const state = foldNbaPosteriors({ rows, currentSeason: 2026, asOfDate: ASOF, excludeGameId: "nba:game:TARGET" }).get(FK)!;
  ok(!state.bySeason[2026].gameIds.includes("nba:game:TARGET"), "predicted game excluded (no self-update)");
  ok(state.bySeason[2026].gameIds.includes("nba:game:OTHER"), "other game still folded");
}

// ── Correction: re-folding the SAME game with a new value moves the posterior ─
{
  const first = foldNbaPosteriors({ rows: [row({ value: 0.6, derivedFromGameIds: ["nba:game:G1"] })], currentSeason: 2026, asOfDate: ASOF });
  const corrected = foldNbaPosteriors({
    rows: [row({ value: 0.9, derivedFromGameIds: ["nba:game:G1"] })], currentSeason: 2026, asOfDate: ASOF,
    priorStates: first,
  }).get(FK)!;
  ok(corrected.bySeason[2026].gameIds.length === 1, "correction keeps a single lineage entry for the game");
  const mean = posteriorMean(combineSeasonWindow(corrected, 2026));
  ok(mean !== null && mean > 0.6, "corrected value moved the posterior mean (same-game correction)");
}

// ── Current + 2-prior rollover: an out-of-window season is excluded ──────────
{
  const rows = [
    row({ season: 2026, value: 0.7, derivedFromGameIds: ["nba:game:C1"] }),
    row({ season: 2025, value: 0.6, derivedFromGameIds: ["nba:game:P1"] }),
    row({ season: 2024, value: 0.5, derivedFromGameIds: ["nba:game:P2"] }),
    row({ season: 2023, value: 0.4, derivedFromGameIds: ["nba:game:OLD"] }), // outside current+2
  ];
  const state = foldNbaPosteriors({ rows, currentSeason: 2026, asOfDate: ASOF }).get(FK)!;
  const window = combineSeasonWindow(state, 2026); // default window 3 = 2024..2026
  ok(window.seasonsIncluded.includes(2026) && window.seasonsIncluded.includes(2024), "current + prior-2 in window");
  ok(!window.seasonsIncluded.includes(2023), "2023 dropped by current+2-prior rollover");
  // The 2023 observation is zero-weighted by the recency rollover (seasonOffset 3 >
  // maxSeasonOffset 2 → weight 0 → veto), so it never enters the posterior at all.
  ok(state.bySeason[2023] === undefined, "out-of-window season dropped at fold time (recency weight 0)");
  ok(state.bySeason[2024] !== undefined, "prior-2 season (2024) folded", );
}

console.log(`\nnbaPosteriorBuilder.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
