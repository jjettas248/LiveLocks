// Run: npx tsx server/engines/nbaPregame/blindness.test.ts
// Pregame Targets PR3 — blindness: the engine's frozen INPUT and its OUTPUT carry
// no line/odds/book/price/edge/EV/payout/implied/sportsbook key at ANY depth;
// checkProjectionBlindness (PR2) sees no price/EV field on either; the recursive
// forbidden-key guard catches nested/aliased/array-nested leaks.
import { computeNbaProjection, type NbaProjectionEngineInput } from "./nbaProjectionEngine";
import { buildFrozenNbaProjectionInput, carriesForbiddenKey } from "./frozenNbaProjectionInput";
import { checkProjectionBlindness } from "../../../shared/pregameTargets/projectionContract";
import { emptyPosteriorState, updatePosterior, type PosteriorState, type Prior } from "../../pregameTargets/posteriorState/posteriorState";
import { allocateTeamMinutes, playerMinutes } from "./minutes/teamMinutesAllocator";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const SEASON = 2026;
const g = (id: string) => `nba:game:${id}`;
function ratePosterior(key: string, n: number, rate: number): PosteriorState {
  let st = emptyPosteriorState(`nba.player.${key}_per_min`, "v1", "nba:player:1");
  for (let i = 0; i < n; i++) st = updatePosterior(st, { value: rate, weight: 1, season: SEASON, gameId: g(`${key}${i}`) });
  return st;
}
const PRIORS = {
  points: { mean: 0.5, strength: 3 },
  rebounds: { mean: 0.22, strength: 3 },
  assists: { mean: 0.15, strength: 3 },
  three_pointers_made: { mean: 0.06, strength: 3 },
} as Record<never, Prior>;
function starterMinutes() {
  const alloc = allocateTeamMinutes({
    players: Array.from({ length: 9 }, (_, i) => ({
      playerId: `p${i}`,
      playProbability: 1,
      projectedMinutesIfActive: [34, 32, 30, 26, 24, 22, 20, 18, 14][i],
    })),
  });
  return playerMinutes(alloc, "p0")!;
}
const INPUT: NbaProjectionEngineInput = {
  snapshotId: "s1",
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
  priors: PRIORS,
};

// A price/EV violation, if present, is the ONLY dimension we assert here (the PR3
// output has no probability field yet — that's PR4 — so we ignore the other
// checkProjectionBlindness dimensions and focus on price/EV leakage).
const leaksPriceOrEv = (obj: Record<string, unknown>) => checkProjectionBlindness(obj).includes("carries_price_or_ev_field");

// ── Frozen input carries no forbidden key (deep) ────────────────────────────
{
  const frozen = buildFrozenNbaProjectionInput({
    snapshotId: "s1",
    capturedAt: "2026-08-05T18:00:00Z",
    playerCanonicalId: "nba:player:1",
    gameCanonicalId: "nba:game:401",
    season: SEASON,
    latentStrength: 0.02,
    maxCount: { points: 80, rebounds: 40, assists: 30 },
    stats: [{ stat: "points", reason: "available", projected: true, ess: 20, rateMean: 0.6, rateVariance: 0.02, moments: { mean: 21, variance: 40 } }],
    minutes: { playerId: "p0", support: [{ minutes: 34, prob: 1 }], expectedMinutes: 34, dnpProbability: 0 },
  });
  ok(!carriesForbiddenKey(frozen), "frozen input carries no forbidden key (recursive scan)");
  ok(!leaksPriceOrEv(frozen as unknown as Record<string, unknown>), "checkProjectionBlindness: frozen INPUT has no price/EV field");
}

// ── Engine OUTPUT carries no forbidden key (deep) ───────────────────────────
{
  const result = computeNbaProjection(INPUT);
  ok(!carriesForbiddenKey(result), "engine result carries no forbidden key (recursive scan over all 8 markets + hashes)");
  ok(!leaksPriceOrEv(result as unknown as Record<string, unknown>), "checkProjectionBlindness: engine OUTPUT has no price/EV field");
  // The market objects individually are blind too.
  for (const m of result.markets) {
    ok(!carriesForbiddenKey(m), `market ${m.market} object is blind`);
  }
  // No output key is any of the forbidden tokens at the top level.
  const topKeys = Object.keys(result);
  const forbiddenTop = ["line", "price", "odds", "edge", "ev", "sportsbook", "book", "payout", "impliedProb"];
  ok(!topKeys.some((k) => forbiddenTop.includes(k)), "no forbidden top-level output key");
}

// ── Recursive / aliased / array-nested detection actually fires ─────────────
{
  ok(carriesForbiddenKey({ a: { b: { c: { odds: -110 } } } }), "deeply nested odds caught");
  ok(carriesForbiddenKey({ markets: [{ pmf: [1], line: 24.5 }] }), "array-nested line caught");
  ok(carriesForbiddenKey({ American_Odds: -110 }), "aliased American_Odds caught");
  ok(carriesForbiddenKey({ nested: { Sportsbook: "dk" } }), "case-insensitive sportsbook caught");
  ok(leaksPriceOrEv({ probability: 0.5, confidenceMarginPp: 0, meta: { edge: 0.03 } }), "checkProjectionBlindness catches nested edge");
  // A legitimate confidenceMarginPp field is NOT a false positive.
  ok(!leaksPriceOrEv({ probability: 0.5, confidenceMarginPp: 0 }), "confidenceMarginPp is not a forbidden token");
}

// ── Cycle-safe (never throws on a self-referential object) ───────────────────
{
  const cyclic: Record<string, unknown> = { pmf: [0.5, 0.5] };
  cyclic.self = cyclic;
  let threw = false;
  try {
    ok(!carriesForbiddenKey(cyclic), "cyclic clean object → no forbidden key");
  } catch {
    threw = true;
  }
  ok(!threw, "recursive scan is cycle-safe (does not throw)");
}

console.log(`\nblindness.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
