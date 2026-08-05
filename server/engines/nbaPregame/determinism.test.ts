// Run: npx tsx server/engines/nbaPregame/determinism.test.ts
// Pregame Targets PR3 — determinism + projection-hash invariance to decision-layer
// data: identical modeling input → byte-identical output + hashes; the projection
// hash is recomputable from ONLY the blind output (so no line/odds/book/EV can
// perturb it); envelope (timestamps/snapshot id) is invariant; modeling inputs are
// the only thing the hashes are sensitive to.
import { computeNbaProjection, type NbaProjectionEngineInput } from "./nbaProjectionEngine";
import { computeProjectionHash, carriesForbiddenKey, NBA_PREGAME_MODEL_VERSION, type ProjectionHashMarket } from "./frozenNbaProjectionInput";
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
function baseInput(over: Partial<NbaProjectionEngineInput> = {}): NbaProjectionEngineInput {
  return {
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
    ...over,
  };
}

// ── Strong determinism: identical modeling input → byte-identical everything ─
{
  const a = computeNbaProjection(baseInput());
  const b = computeNbaProjection(baseInput());
  ok(a.featureHash === b.featureHash, "feature hash identical across runs");
  ok(a.projectionHash === b.projectionHash, "projection hash identical across runs");
  ok(JSON.stringify(a.markets) === JSON.stringify(b.markets), "market PMFs/moments byte-identical across runs");
}

// ── Projection hash recomputable from ONLY the blind output ─────────────────
// If the hash equals a recomputation over just {modelVersion, featureHash,
// markets' key/available/reason/pmf/mean/variance}, then nothing outside that
// blind set — no line/odds/book/edge/EV — could have contributed to it.
{
  const res = computeNbaProjection(baseInput());
  const blindMarkets: ProjectionHashMarket[] = res.markets.map((m) => ({
    market: m.market,
    available: m.available,
    reason: m.reason,
    pmf: m.pmf,
    mean: m.mean,
    variance: m.variance,
  }));
  const recomputed = computeProjectionHash({
    modelVersion: NBA_PREGAME_MODEL_VERSION,
    featureHash: res.featureHash,
    markets: blindMarkets,
  });
  ok(recomputed === res.projectionHash, "projection hash is a pure function of the blind output only");
  ok(!carriesForbiddenKey(blindMarkets), "the hashed market set carries no decision-layer key");
}

// ── Envelope invariance: snapshot id / capturedAt do not move the hashes ─────
{
  const a = computeNbaProjection(baseInput());
  const b = computeNbaProjection(baseInput({ snapshotId: "different-snap", capturedAt: "2026-08-05T23:59:59Z" }));
  ok(a.featureHash === b.featureHash, "feature hash invariant to snapshotId/capturedAt (envelope)");
  ok(a.projectionHash === b.projectionHash, "projection hash invariant to envelope");
}

// ── Modeling-input sensitivity: the hashes DO move when the model input moves ─
{
  const base = computeNbaProjection(baseInput());
  const diffRate = computeNbaProjection(baseInput({
    posteriors: {
      points: ratePosterior("points", 20, 0.72), // higher scoring rate
      rebounds: ratePosterior("rebounds", 20, 0.25),
      assists: ratePosterior("assists", 20, 0.18),
      three_pointers_made: ratePosterior("threes", 20, 0.07),
    },
  }));
  ok(base.featureHash !== diffRate.featureHash, "different rate → different feature hash");
  ok(base.projectionHash !== diffRate.projectionHash, "different rate → different projection hash");

  const diffLatent = computeNbaProjection(baseInput({ latentStrength: 0.035 }));
  ok(base.featureHash !== diffLatent.featureHash, "different latent strength → different feature hash");
  ok(base.projectionHash !== diffLatent.projectionHash, "different latent strength → different projection hash");

  const diffMinutes = computeNbaProjection(baseInput({
    minutes: (() => {
      const alloc = allocateTeamMinutes({
        players: Array.from({ length: 9 }, (_, i) => ({
          playerId: `p${i}`,
          playProbability: 1,
          projectedMinutesIfActive: [30, 32, 30, 26, 26, 22, 20, 18, 16][i], // p0 34→30
        })),
      });
      return playerMinutes(alloc, "p0")!;
    })(),
  }));
  ok(base.featureHash !== diffMinutes.featureHash, "different minutes → different feature hash");
  ok(base.projectionHash !== diffMinutes.projectionHash, "different minutes → different projection hash");
}

// ── The engine input itself carries no decision-layer field (nothing to leak) ─
{
  ok(!carriesForbiddenKey(baseInput()), "engine input object carries no line/odds/book/EV key");
}

console.log(`\ndeterminism.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
