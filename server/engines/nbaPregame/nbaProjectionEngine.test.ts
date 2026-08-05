// Run: npx tsx server/engines/nbaPregame/nbaProjectionEngine.test.ts
// Pregame Targets PR3 — engine + fail-closed boundary: full-data projection of
// all 8 markets; expected missing data → typed per-market unavailable (no throw);
// corruption DETECTED (core throws, safe boundary catches → all-unavailable +
// diagnostic); assertMarketProjectionValid detects corrupt PMFs/moments.
import {
  computeNbaProjection,
  safeComputeNbaProjection,
  assertMarketProjectionValid,
  marketProjection,
  NBA_THREES_MAX_COUNT_DEFAULT,
  type NbaProjectionEngineInput,
} from "./nbaProjectionEngine";
import { NBA_LAUNCH_MARKETS, NBA_MARKET_REGISTRY } from "./markets";
import { isNormalized } from "./math/pmf";
import { emptyPosteriorState, updatePosterior, type PosteriorState, type Prior } from "../../pregameTargets/posteriorState/posteriorState";
import { allocateTeamMinutes, playerMinutes, type PlayerMinutesDistribution } from "./minutes/teamMinutesAllocator";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const SEASON = 2026;
const g = (id: string) => `nba:game:${id}`;

function ratePosterior(key: string, n: number, rate: number): PosteriorState {
  let st = emptyPosteriorState(`nba.player.${key}_per_min`, "v1", "nba:player:1");
  for (let i = 0; i < n; i++) st = updatePosterior(st, { value: rate, weight: 1, season: SEASON, gameId: g(`${key}${i}`) });
  return st;
}

const PRIORS: Record<string, Prior> = {
  points: { mean: 0.5, strength: 3 },
  rebounds: { mean: 0.22, strength: 3 },
  assists: { mean: 0.15, strength: 3 },
  three_pointers_made: { mean: 0.06, strength: 3 },
};

function starterMinutes(): PlayerMinutesDistribution {
  const alloc = allocateTeamMinutes({
    players: [
      { playerId: "star", playProbability: 1.0, projectedMinutesIfActive: 34 },
      { playerId: "b", playProbability: 1.0, projectedMinutesIfActive: 32 },
      { playerId: "c", playProbability: 1.0, projectedMinutesIfActive: 30 },
      { playerId: "d", playProbability: 1.0, projectedMinutesIfActive: 26 },
      { playerId: "e", playProbability: 1.0, projectedMinutesIfActive: 24 },
      { playerId: "f", playProbability: 1.0, projectedMinutesIfActive: 22 },
      { playerId: "g", playProbability: 1.0, projectedMinutesIfActive: 20 },
      { playerId: "h", playProbability: 1.0, projectedMinutesIfActive: 18 },
      { playerId: "i", playProbability: 1.0, projectedMinutesIfActive: 14 },
    ],
  });
  return playerMinutes(alloc, "star")!;
}

function fullInput(over: Partial<NbaProjectionEngineInput> = {}): NbaProjectionEngineInput {
  return {
    snapshotId: "snap-1",
    capturedAt: "2026-08-05T18:00:00Z",
    playerCanonicalId: "nba:player:1",
    gameCanonicalId: "nba:game:401",
    season: SEASON,
    minutes: starterMinutes(),
    posteriors: {
      points: ratePosterior("points", 20, 0.6),
      rebounds: ratePosterior("rebounds", 20, 0.25),
      assists: ratePosterior("assists", 20, 0.18),
      three_pointers_made: ratePosterior("threes", 20, 0.07),
    },
    priors: PRIORS as Record<never, Prior>,
    ...over,
  };
}

// ── Full data: all 8 markets available, hashes present + distinct ───────────
{
  const res = computeNbaProjection(fullInput());
  ok(res.markets.length === 8, "8 markets returned");
  ok(res.markets.every((m) => m.available), "all 8 markets available with full data");
  ok(!res.allUnavailable, "not all-unavailable");
  ok(res.markets.every((m) => m.pmf !== null && isNormalized(m.pmf!, 1e-6)), "every emitted PMF normalized");
  ok(res.featureHash.length === 64 && res.projectionHash.length === 64, "both hashes are sha256");
  ok(res.projectionHash !== res.featureHash, "projection hash distinct from feature hash");
  // Combo mean = sum of component emitted means (joint read-off preserved end-to-end).
  const mean = (k: string) => marketProjection(res, k as never)!.mean!;
  ok(approx(mean("pra"), mean("points") + mean("rebounds") + mean("assists"), 1e-6), "pra mean = pts+reb+ast means");
  ok(approx(mean("pts_reb"), mean("points") + mean("rebounds"), 1e-6), "pts_reb mean = pts+reb means");
  // Combo variance exceeds the independent sum (covariance carried through).
  const varM = (k: string) => marketProjection(res, k as never)!.variance!;
  ok(varM("pts_reb") > varM("points") + varM("rebounds") + 1e-6, "pts_reb variance includes positive covariance");
}

// ── Determinism: byte-identical input → identical hashes + markets ──────────
{
  const a = computeNbaProjection(fullInput());
  const b = computeNbaProjection(fullInput());
  ok(a.featureHash === b.featureHash, "feature hash deterministic");
  ok(a.projectionHash === b.projectionHash, "projection hash deterministic");
  ok(JSON.stringify(a.markets) === JSON.stringify(b.markets), "market projections deterministic");
}

// ── Expected missing data → typed per-market unavailable (no throw) ─────────
{
  // Assists posterior missing: assists + all assists-combos unavailable; pts/reb
  // and pts_reb still available; threes still available. No exception.
  const res = computeNbaProjection(fullInput({
    posteriors: {
      points: ratePosterior("points", 20, 0.6),
      rebounds: ratePosterior("rebounds", 20, 0.25),
      assists: null,
      three_pointers_made: ratePosterior("threes", 20, 0.07),
    },
  }));
  ok(marketProjection(res, "points")!.available, "points available");
  ok(marketProjection(res, "rebounds")!.available, "rebounds available");
  ok(marketProjection(res, "pts_reb")!.available, "pts_reb available (both components present)");
  ok(marketProjection(res, "three_pointers_made")!.available, "threes available");
  ok(!marketProjection(res, "assists")!.available, "assists unavailable (missing posterior)");
  ok(marketProjection(res, "assists")!.reason === "missing_posterior", "assists reason = missing_posterior");
  ok(!marketProjection(res, "pts_ast")!.available, "pts_ast unavailable (needs assists)");
  ok(!marketProjection(res, "reb_ast")!.available, "reb_ast unavailable");
  ok(!marketProjection(res, "pra")!.available, "pra unavailable");
  ok(marketProjection(res, "pra")!.reason.includes("assists"), "pra reason names the missing component");
}

// ── Missing minutes → every market unavailable (missing_minutes), no throw ──
{
  const res = computeNbaProjection(fullInput({ minutes: null }));
  ok(res.allUnavailable, "all markets unavailable without minutes");
  ok(res.markets.every((m) => m.reason.includes("missing_minutes")), "every market reason reflects missing_minutes");
  ok(res.featureHash.length === 64, "still stamps a feature hash (typed unavailable, not error)");
}

// ── All posteriors absent → all-unavailable, typed (not an exception) ───────
{
  const res = computeNbaProjection(fullInput({ posteriors: {} }));
  ok(res.allUnavailable, "no posteriors → all-unavailable");
  ok(res.markets.every((m) => !m.available), "every market unavailable");
}

// ── Corruption DETECTED: core throws, safe boundary catches ─────────────────
{
  // A NaN minutes support point yields a non-finite moment → the core throws
  // (never silently normalizes). This is corruption, not expected missing data.
  const corruptMinutes = starterMinutes();
  const bad: PlayerMinutesDistribution = {
    ...corruptMinutes,
    support: [{ minutes: NaN, prob: 1 }],
    expectedMinutes: NaN,
  };
  const corruptInput = fullInput({ minutes: bad });
  ok(throws(() => computeNbaProjection(corruptInput)), "pure core throws on a non-finite moment");

  const safe = safeComputeNbaProjection(corruptInput);
  ok(!safe.ok, "safe boundary reports ok=false on corruption");
  ok(safe.diagnostic !== null && safe.diagnostic.kind === "engine_threw", "typed diagnostic recorded");
  ok(safe.result.allUnavailable, "safe boundary returns an all-unavailable result (never partial)");
  ok(safe.result.markets.every((m) => m.reason === "engine_error"), "fallback markets carry engine_error");
}

// ── safe boundary passes through a healthy projection ───────────────────────
{
  const safe = safeComputeNbaProjection(fullInput());
  ok(safe.ok && safe.diagnostic === null, "healthy input → ok, no diagnostic");
  ok(safe.result.markets.every((m) => m.available), "healthy input → all markets available");
}

// ── assertMarketProjectionValid detects corrupt PMFs / impossible moments ───
{
  ok(throws(() => assertMarketProjectionValid({ market: "points", available: true, reason: "available", pmf: [0.5, 0.6], mean: 1, variance: 1 })), "detects un-normalized PMF");
  ok(throws(() => assertMarketProjectionValid({ market: "points", available: true, reason: "available", pmf: [0.5, 0.5], mean: NaN, variance: 1 })), "detects non-finite mean");
  ok(throws(() => assertMarketProjectionValid({ market: "points", available: true, reason: "available", pmf: [0.5, 0.5], mean: 1, variance: -1 })), "detects negative variance");
  ok(throws(() => assertMarketProjectionValid({ market: "points", available: true, reason: "available", pmf: null, mean: 1, variance: 1 })), "detects null PMF on available market");
  // An unavailable market is exempt (null PMF is legitimate there).
  let okUnavail = true;
  try {
    assertMarketProjectionValid({ market: "points", available: false, reason: "missing_posterior", pmf: null, mean: null, variance: null });
  } catch {
    okUnavail = false;
  }
  ok(okUnavail, "unavailable market with null PMF is valid");
}

// ── three_pointers cap sanity ───────────────────────────────────────────────
{
  const res = computeNbaProjection(fullInput());
  const threes = marketProjection(res, "three_pointers_made")!;
  ok(threes.pmf!.length === NBA_THREES_MAX_COUNT_DEFAULT + 1, "threes PMF has the standalone cap length");
  ok(NBA_MARKET_REGISTRY.three_pointers_made.kind === "base", "threes is a base market (not a combo)");
}

console.log(`\nnbaProjectionEngine.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
