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

// ── No self-update: the game being predicted is refused ──────────────────────
{
  let st = seed();
  const before = combineSeasonWindow(st, S);
  st = updatePosterior(st, { value: 9, weight: 1, season: S, gameId: "target" }, { excludeGameId: "target" });
  const after = combineSeasonWindow(st, S);
  ok(before.sumW === after.sumW && after.count === 0, "an observation from the target game is refused (no self-update)");
  ok(!posteriorIncludesGame(st, "target"), "refused game is not in lineage");
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
