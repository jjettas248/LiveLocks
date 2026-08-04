// Run: npx tsx server/pregameTargets/posteriorState/posteriorState.test.ts
import {
  emptyPosteriorState,
  updatePosterior,
  posteriorIncludesGame,
  combineSeasonWindow,
  effectiveSampleSize,
  posteriorMean,
  posteriorVariance,
  shrunkPosteriorMean,
  POSTERIOR_STATE_VERSION,
} from "./posteriorState";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

const S = 2026;
function seed() {
  return emptyPosteriorState("nba.player.reb_per_min", "v1", "nba:player:1");
}

// ── Empty state ──────────────────────────────────────────────────────────────
{
  const st = seed();
  ok(st.version === POSTERIOR_STATE_VERSION, "empty state carries the schema version");
  const c = combineSeasonWindow(st, S);
  ok(effectiveSampleSize(c) === 0, "empty → ESS 0");
  ok(posteriorMean(c) === null, "empty → mean null (not 0)");
  ok(posteriorVariance(c) === null, "empty → variance null");
}

// ── Weighted sufficient stats: mean, variance, ESS ───────────────────────────
{
  let st = seed();
  st = updatePosterior(st, { value: 2, weight: 1, season: S, gameId: "g1" });
  st = updatePosterior(st, { value: 4, weight: 1, season: S, gameId: "g2" });
  st = updatePosterior(st, { value: 6, weight: 1, season: S, gameId: "g3" });
  const c = combineSeasonWindow(st, S);
  ok(approx(posteriorMean(c), 4), "equal-weight mean of [2,4,6] = 4");
  ok(approx(posteriorVariance(c), 8 / 3), "weighted population variance = 8/3");
  ok(approx(effectiveSampleSize(c), 3), "ESS = 3 for three equal weights");
}
{
  // Unequal weights → ESS strictly below the raw count.
  let st = seed();
  st = updatePosterior(st, { value: 1, weight: 9, season: S, gameId: "g1" });
  st = updatePosterior(st, { value: 1, weight: 1, season: S, gameId: "g2" });
  const c = combineSeasonWindow(st, S);
  const ess = effectiveSampleSize(c);
  ok(ess > 1 && ess < 2, "ESS between 1 and 2 for lopsided weights (9,1)");
  ok(approx(ess, 100 / 82), "ESS = (10)^2 / (81+1)");
}

// ── Idempotent lineage: same game never double-counts ────────────────────────
{
  let st = seed();
  st = updatePosterior(st, { value: 5, weight: 2, season: S, gameId: "gDup" });
  const after1 = combineSeasonWindow(st, S);
  st = updatePosterior(st, { value: 5, weight: 2, season: S, gameId: "gDup" });
  const after2 = combineSeasonWindow(st, S);
  ok(posteriorIncludesGame(st, "gDup"), "lineage records the included game");
  ok(after1.sumW === after2.sumW && after1.count === after2.count, "re-adding the same game is a no-op");
}

// ── Same-game CORRECTION replaces the prior contribution (append-only) ───────
{
  let st = seed();
  st = updatePosterior(st, { value: 10, weight: 1, season: S, gameId: "g1" });
  ok(approx(posteriorMean(combineSeasonWindow(st, S)), 10), "initial fold registers value 10");
  // A corrected reading for the SAME game (different value) replaces the stale one.
  st = updatePosterior(st, { value: 4, weight: 1, season: S, gameId: "g1" });
  const after = combineSeasonWindow(st, S);
  ok(approx(posteriorMean(after), 4), "corrected same-game observation replaces the stale value (not discarded)");
  ok(after.count === 1, "a correction does not add a second fold (count stays 1)");
  // Corrected weight is honored too.
  st = updatePosterior(st, { value: 4, weight: 5, season: S, gameId: "g1" });
  ok(effectiveSampleSize(combineSeasonWindow(st, S)) === 1, "still one effective observation after a weight correction");
}

// ── Cross-season CORRECTION: a game re-labeled to a new season is relocated ──
{
  let st = seed();
  // Fold the same canonical game under the WRONG season first.
  st = updatePosterior(st, { value: 10, weight: 1, season: 2025, gameId: "gX" });
  // A backfill correction fixes both the value AND the season label.
  st = updatePosterior(st, { value: 4, weight: 1, season: 2026, gameId: "gX" });
  // The game must now live in exactly one season (the corrected 2026), never both.
  ok(st.bySeason[2025] === undefined, "the stale 2025 season is removed once its only game relocates");
  ok(st.bySeason[2026]?.byGame["gX"] !== undefined, "the game is present under the corrected 2026 season");
  ok(posteriorIncludesGame(st, "gX"), "lineage still includes the relocated game");
  // A window spanning both seasons must see the game ONCE, at the corrected value.
  const win = combineSeasonWindow(st, 2026); // [2024,2025,2026]
  ok(win.count === 1, "the relocated game is counted exactly once across the window (no double-count)");
  ok(approx(posteriorMean(win), 4), "the window sees the corrected value, not the stale one");
  ok(win.seasonsIncluded.join(",") === "2026", "only the corrected season contributes");

  // If the old season also held OTHER folds, only the relocated game leaves it.
  let st2 = seed();
  st2 = updatePosterior(st2, { value: 10, weight: 1, season: 2025, gameId: "gMove" });
  st2 = updatePosterior(st2, { value: 8, weight: 1, season: 2025, gameId: "gStay" });
  st2 = updatePosterior(st2, { value: 4, weight: 1, season: 2026, gameId: "gMove" });
  ok(st2.bySeason[2025]?.byGame["gStay"] !== undefined && st2.bySeason[2025]?.byGame["gMove"] === undefined, "only the relocated game leaves the old season; a co-resident game stays");
  ok(st2.bySeason[2025]?.count === 1, "old season count drops by exactly one on relocation");
  const win2 = combineSeasonWindow(st2, 2026);
  ok(win2.count === 2, "window counts the staying game and the relocated game once each");
}

// ── Zero-weight VETO of a folded game removes its stale contribution ─────────
{
  let st = seed();
  st = updatePosterior(st, { value: 10, weight: 2, season: S, gameId: "gV" });
  st = updatePosterior(st, { value: 5, weight: 3, season: S, gameId: "gKeep" });
  ok(combineSeasonWindow(st, S).count === 2, "two games folded before the veto");
  // A later as-of correction vetoes gV (data-quality/context) with weight 0.
  st = updatePosterior(st, { value: 10, weight: 0, season: S, gameId: "gV" });
  const after = combineSeasonWindow(st, S);
  ok(after.count === 1, "a zero-weight veto removes the folded game (count drops to 1)");
  ok(!posteriorIncludesGame(st, "gV"), "the vetoed game leaves the lineage");
  ok(posteriorIncludesGame(st, "gKeep"), "an unrelated folded game is untouched by the veto");
  ok(approx(posteriorMean(after), 5), "the posterior reflects only the surviving game");
  // A veto that empties the only season deletes the season entirely.
  let solo = seed();
  solo = updatePosterior(solo, { value: 7, weight: 1, season: 2025, gameId: "gSolo" });
  solo = updatePosterior(solo, { value: 7, weight: 0, season: 2025, gameId: "gSolo" });
  ok(solo.bySeason[2025] === undefined, "vetoing the last game in a season removes the empty season");
  // A veto of a never-folded game (or a gameless veto) is a pure no-op.
  const base = seed();
  ok(updatePosterior(base, { value: 1, weight: 0, season: S, gameId: "ghost" }) === base, "vetoing a never-folded game returns the same state (no-op)");
  ok(updatePosterior(base, { value: 1, weight: 0, season: S }) === base, "a gameless zero-weight observation is a no-op");
  // A negative weight behaves like a zero-weight veto for a folded game.
  let neg = seed();
  neg = updatePosterior(neg, { value: 3, weight: 1, season: S, gameId: "gNeg" });
  neg = updatePosterior(neg, { value: 3, weight: -1, season: S, gameId: "gNeg" });
  ok(!posteriorIncludesGame(neg, "gNeg") && combineSeasonWindow(neg, S).count === 0, "a negative-weight correction also removes the folded game");
  // A MALFORMED zero-weight row (non-finite value or non-integer season) is NOT
  // a trustworthy veto — it must be a no-op, never erasing good posterior mass.
  let mal = seed();
  mal = updatePosterior(mal, { value: 9, weight: 2, season: S, gameId: "gMal" });
  const malState = mal;
  mal = updatePosterior(mal, { value: NaN, weight: 0, season: S, gameId: "gMal" });
  ok(mal === malState, "a weight-0 row with a NaN value is a malformed no-op (same state ref), not a veto");
  ok(posteriorIncludesGame(mal, "gMal") && approx(posteriorMean(combineSeasonWindow(mal, S)), 9), "the folded game survives a malformed zero-weight correction");
  mal = updatePosterior(mal, { value: 5, weight: 0, season: 2026.5, gameId: "gMal" });
  ok(posteriorIncludesGame(mal, "gMal"), "a weight-0 row with a non-integer season does not erase the folded game either");
}

// ── No self-update: the game being predicted is refused ──────────────────────
{
  let st = seed();
  const before = combineSeasonWindow(st, S);
  st = updatePosterior(st, { value: 9, weight: 1, season: S, gameId: "target" }, { excludeGameId: "target" });
  const after = combineSeasonWindow(st, S);
  ok(before.sumW === after.sumW && after.count === 0, "an observation from the target game is refused (no self-update)");
  ok(!posteriorIncludesGame(st, "target"), "refused game is not in lineage");
}

// ── Game-id normalization: self-update + dedupe survive format variants ──────
{
  // A non-normalized obs.gameId must still be caught by the self-update guard
  // against a canonical excludeGameId — else the target game leaks in.
  let st = seed();
  st = updatePosterior(st, { value: 9, weight: 1, season: S, gameId: "nba:game:TARGET " }, { excludeGameId: "nba:game:TARGET" });
  ok(combineSeasonWindow(st, S).count === 0 && !posteriorIncludesGame(st, "nba:game:TARGET"), "a whitespaced obs.gameId is still refused against a canonical excludeGameId");
  // …and symmetrically when the excludeGameId is the non-normalized one.
  let st2 = seed();
  st2 = updatePosterior(st2, { value: 9, weight: 1, season: S, gameId: "nba:game:TARGET" }, { excludeGameId: "nba:game:TARGET " });
  ok(combineSeasonWindow(st2, S).count === 0, "a whitespaced excludeGameId still refuses the canonical target observation");
  // Format variants of the SAME game collapse to one lineage key (correction,
  // not a second fold), so a whitespaced re-fold cannot double-count.
  let st3 = seed();
  st3 = updatePosterior(st3, { value: 10, weight: 1, season: S, gameId: "nba:game:G1" });
  st3 = updatePosterior(st3, { value: 4, weight: 1, season: S, gameId: "nba:game:G1 " });
  const c3 = combineSeasonWindow(st3, S);
  ok(c3.count === 1, "a whitespaced re-fold of the same game is a correction, not a second fold");
  ok(approx(posteriorMean(c3), 4), "the normalized correction replaces the stale value");
  ok(posteriorIncludesGame(st3, "nba:game:G1"), "lineage stores the normalized canonical key");
}

// ── Fail closed on a non-canonical excludeGameId (safety-critical) ───────────
{
  // A bare native exclude id can't match a canonically-keyed observation; rather
  // than silently fold the target game in, a game-bearing obs is REFUSED.
  let st = seed();
  st = updatePosterior(st, { value: 9, weight: 1, season: S, gameId: "nba:game:TARGET" }, { excludeGameId: "TARGET" });
  ok(combineSeasonWindow(st, S).count === 0 && !posteriorIncludesGame(st, "nba:game:TARGET"), "a bare (non-canonical) excludeGameId fails closed — the game obs is refused, not folded");
  // A wrong-kind canonical exclude id also fails closed.
  let st2 = seed();
  st2 = updatePosterior(st2, { value: 9, weight: 1, season: S, gameId: "nba:game:TARGET" }, { excludeGameId: "nba:player:TARGET" });
  ok(combineSeasonWindow(st2, S).count === 0, "a wrong-kind (non-game) excludeGameId fails closed");
  // A blank (whitespace-only) native exclude segment must not read as valid.
  let stB = seed();
  stB = updatePosterior(stB, { value: 9, weight: 1, season: S, gameId: "nba:game:TARGET" }, { excludeGameId: "nba:game:   " });
  ok(combineSeasonWindow(stB, S).count === 0, "a blank-native excludeGameId (\"nba:game:   \") fails closed");
  // Fail-closed refuses ANY game-bearing obs under an invalid exclude (can't rule
  // out the target), but a GAMELESS observation can never be the target → folds.
  let st3 = seed();
  st3 = updatePosterior(st3, { value: 5, weight: 1, season: S }, { excludeGameId: "TARGET" });
  ok(combineSeasonWindow(st3, S).count === 1, "a gameless observation still folds under an invalid excludeGameId");
  let st4 = seed();
  st4 = updatePosterior(st4, { value: 5, weight: 1, season: S, gameId: "nba:game:OTHER" }, { excludeGameId: "TARGET" });
  ok(combineSeasonWindow(st4, S).count === 0, "a game-bearing obs is refused under an invalid exclude even when it isn't the (unidentifiable) target");
  // A valid canonical exclude still folds a non-matching game normally.
  let st5 = seed();
  st5 = updatePosterior(st5, { value: 5, weight: 1, season: S, gameId: "nba:game:OTHER" }, { excludeGameId: "nba:game:TARGET" });
  ok(combineSeasonWindow(st5, S).count === 1 && posteriorIncludesGame(st5, "nba:game:OTHER"), "a valid canonical exclude folds a non-target game normally");
}

// ── Determinism: order-independent, sorted lineage ───────────────────────────
{
  let a = seed();
  a = updatePosterior(a, { value: 3, weight: 1, season: S, gameId: "b" });
  a = updatePosterior(a, { value: 7, weight: 2, season: S, gameId: "a" });
  let b = seed();
  b = updatePosterior(b, { value: 7, weight: 2, season: S, gameId: "a" });
  b = updatePosterior(b, { value: 3, weight: 1, season: S, gameId: "b" });
  ok(JSON.stringify(a.bySeason) === JSON.stringify(b.bySeason), "state is independent of insertion order");
  ok(JSON.stringify(a.bySeason[S].gameIds) === JSON.stringify(["a", "b"]), "lineage game ids are sorted");
}

// ── Rolling window: current + 2 priors, oldest drops on rollover ─────────────
{
  let st = seed();
  st = updatePosterior(st, { value: 1, weight: 1, season: 2024, gameId: "g24" });
  st = updatePosterior(st, { value: 1, weight: 1, season: 2025, gameId: "g25" });
  st = updatePosterior(st, { value: 1, weight: 1, season: 2026, gameId: "g26" });
  ok(combineSeasonWindow(st, 2026).seasonsIncluded.join(",") === "2024,2025,2026", "window @2026 includes current + 2 priors");
  ok(combineSeasonWindow(st, 2027).seasonsIncluded.join(",") === "2025,2026", "rollover @2027 drops 2024 (stored state unchanged)");
  ok(st.bySeason[2024] !== undefined, "rollover is a VIEW — the oldest season's stored stats are not deleted");
  // A malformed window must fail closed, never pull in ALL history.
  ok(combineSeasonWindow(st, NaN).seasonsIncluded.length === 0, "NaN currentSeason → empty window (fail closed, not all history)");
  ok(combineSeasonWindow(st, Infinity).seasonsIncluded.length === 0, "Infinity currentSeason → empty window");
  ok(combineSeasonWindow(st, 2026.5).seasonsIncluded.length === 0, "non-integer currentSeason → empty window");
  ok(combineSeasonWindow(st, 2026, NaN).seasonsIncluded.join(",") === "2026", "NaN windowSize → narrowest safe window (current season only), not all history");
  ok(combineSeasonWindow(st, 2026, Infinity).seasonsIncluded.join(",") === "2026", "Infinity windowSize → current season only");
  ok(combineSeasonWindow(st, 2026, 0).seasonsIncluded.join(",") === "2026", "windowSize 0 clamps to 1 (current season only)");
  ok(combineSeasonWindow(st, 2026, -5).seasonsIncluded.join(",") === "2026", "negative windowSize clamps to 1");
}

// ── Prior-mass guard at ESS boundaries ───────────────────────────────────────
{
  const prior = { mean: 0, strength: 10 };
  // No data → exactly the prior.
  ok(approx(shrunkPosteriorMean(combineSeasonWindow(seed(), S), prior), 0), "ESS 0 → exactly the prior mean");
  // Low ESS → shrunk hard toward the prior.
  let low = seed();
  low = updatePosterior(low, { value: 10, weight: 1, season: S, gameId: "g1" });
  const lowShrunk = shrunkPosteriorMean(combineSeasonWindow(low, S), prior)!;
  ok(lowShrunk > 0 && lowShrunk < 1, "low ESS (1) vs strong prior (10) → mean pulled near prior");
  ok(approx(lowShrunk, (1 * 10 + 10 * 0) / 11), "shrinkage = (ESS·data + strength·prior)/(ESS+strength)");
  // High ESS → approaches the data mean.
  let high = seed();
  for (let i = 0; i < 200; i++) high = updatePosterior(high, { value: 10, weight: 1, season: S, gameId: `g${i}` });
  const highShrunk = shrunkPosteriorMean(combineSeasonWindow(high, S), prior)!;
  ok(highShrunk > 9.4, "high ESS overwhelms the prior, approaching the data mean 10");
}

// ── Rejects malformed observations ───────────────────────────────────────────
{
  let st = seed();
  const c0 = combineSeasonWindow(st, S);
  st = updatePosterior(st, { value: NaN, weight: 1, season: S });
  st = updatePosterior(st, { value: 5, weight: 0, season: S });
  st = updatePosterior(st, { value: 5, weight: -1, season: S });
  st = updatePosterior(st, { value: 5, weight: Infinity, season: S });
  st = updatePosterior(st, { value: 5, weight: 1, season: 2026.5 });
  const c1 = combineSeasonWindow(st, S);
  ok(c0.count === c1.count && c1.count === 0, "non-finite value / non-positive weight / non-integer season are all no-ops");
}

console.log(`\nposteriorState.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
