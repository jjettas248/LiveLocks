// Run: npx tsx server/engines/nbaPregame/statPosterior.test.ts
// Pregame Targets PR3 — posterior→rate bridge: per-minute rate consumed from
// PR1 sufficient stats, prior-shrunk, mixed over minutes EXACTLY ONCE (no double
// count), overdispersed game total; prior_dominant still projects; genuine
// absence/invalidity returns typed unavailable.
import {
  bridgeStatPosterior,
  DEFAULT_MIN_ESS,
  type StatPosteriorInputs,
} from "./statPosterior";
import {
  emptyPosteriorState,
  updatePosterior,
  type PosteriorState,
  type Prior,
} from "../../pregameTargets/posteriorState/posteriorState";
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
const approx = (a: number | null, b: number, eps = 1e-9) => a !== null && Math.abs(a - b) < eps;

const SEASON = 2026;
const g = (id: string) => `nba:game:${id}`;
const PRIOR: Prior = { mean: 0.5, strength: 3 }; // 0.5 pts/min prior

// A per-minute-rate posterior with `n` games at rate `rate`, weight 1 each.
function ratePosterior(n: number, rate: number): PosteriorState {
  let st = emptyPosteriorState("nba.player.points_per_min", "v1", "nba:player:1");
  for (let i = 0; i < n; i++) {
    st = updatePosterior(st, { value: rate, weight: 1, season: SEASON, gameId: g(`G${i}`) });
  }
  return st;
}

// A starter's minutes distribution (~34 min, no DNP).
function starterMinutes() {
  const alloc = allocateTeamMinutes({
    players: [
      { playerId: "star", playProbability: 1.0, projectedMinutesIfActive: 34 },
      { playerId: "b", playProbability: 1.0, projectedMinutesIfActive: 30 },
      { playerId: "c", playProbability: 1.0, projectedMinutesIfActive: 28 },
      { playerId: "d", playProbability: 1.0, projectedMinutesIfActive: 26 },
      { playerId: "e", playProbability: 1.0, projectedMinutesIfActive: 24 },
      { playerId: "f", playProbability: 1.0, projectedMinutesIfActive: 22 },
      { playerId: "g", playProbability: 1.0, projectedMinutesIfActive: 20 },
      { playerId: "h", playProbability: 1.0, projectedMinutesIfActive: 18 },
      { playerId: "i", playProbability: 1.0, projectedMinutesIfActive: 18 },
    ],
  });
  return playerMinutes(alloc, "star")!;
}

const baseInputs = (posterior: PosteriorState | null): StatPosteriorInputs => ({
  stat: "points",
  posterior,
  currentSeason: SEASON,
  prior: PRIOR,
  minutes: starterMinutes(),
});

// ── available: high ESS → data-informed projection ──────────────────────────
{
  const res = bridgeStatPosterior(baseInputs(ratePosterior(20, 0.6)));
  ok(res.reason === "available", "20 games → available (ESS >= minEss)");
  ok(res.projected && res.moments !== null, "available projects real moments");
  ok(res.ess >= DEFAULT_MIN_ESS, "ESS at/above threshold");
  // Rate shrinks slightly toward the 0.5 prior but stays near the 0.6 data rate.
  ok(res.rateMean! > 0.55 && res.rateMean! < 0.6, "rate mean between prior and data");
}

// ── Single mix over minutes: game mean == rateMean × E[minutes] (no double) ──
{
  const mins = starterMinutes();
  const res = bridgeStatPosterior({ ...baseInputs(ratePosterior(20, 0.6)), minutes: mins });
  ok(approx(res.minutesMean, mins.expectedMinutes, 1e-9), "bridge reports E[minutes] from the allocator");
  ok(approx(res.moments!.mean, res.rateMean! * res.minutesMean!, 1e-9), "game mean = rateMean × E[minutes] (mixed once)");
}

// ── Overdispersion: game-total variance > mean ──────────────────────────────
{
  const res = bridgeStatPosterior(baseInputs(ratePosterior(20, 0.6)));
  ok(res.moments!.variance > res.moments!.mean, "game total is overdispersed (variance > mean)");
}

// ── prior_dominant: low ESS STILL projects ──────────────────────────────────
{
  const res = bridgeStatPosterior(baseInputs(ratePosterior(1, 0.9)));
  ok(res.reason === "prior_dominant", "1 game → prior_dominant");
  ok(res.projected && res.moments !== null, "prior_dominant STILL projects (not unavailable)");
  ok(res.ess < DEFAULT_MIN_ESS, "ESS below threshold");
  // With ESS≈1 and strength 3, the 0.9 data rate is pulled hard toward 0.5.
  ok(res.rateMean! < 0.7, "low-ESS rate pulled toward prior");
}

// ── Empty posterior (present but no data) → prior_dominant, projects from prior ─
{
  const empty = emptyPosteriorState("nba.player.points_per_min", "v1", "nba:player:1");
  const res = bridgeStatPosterior(baseInputs(empty));
  ok(res.reason === "prior_dominant", "empty posterior → prior_dominant (present, ESS 0)");
  ok(res.projected && approx(res.rateMean, 0.5, 1e-9), "empty posterior projects exactly the prior rate");
}

// ── Genuine absence / invalidity → typed unavailable (no moments) ───────────
{
  const missPost = bridgeStatPosterior(baseInputs(null));
  ok(missPost.reason === "missing_posterior" && !missPost.projected && missPost.moments === null, "null posterior → missing_posterior unavailable");

  const missMin = bridgeStatPosterior({ ...baseInputs(ratePosterior(20, 0.6)), minutes: null });
  ok(missMin.reason === "missing_minutes" && !missMin.projected, "null minutes → missing_minutes unavailable");

  const badPrior = bridgeStatPosterior({ ...baseInputs(ratePosterior(20, 0.6)), prior: { mean: NaN, strength: 3 } });
  ok(badPrior.reason === "invalid_input" && !badPrior.projected, "NaN prior mean → invalid_input");

  const badSeason = bridgeStatPosterior({ ...baseInputs(ratePosterior(20, 0.6)), currentSeason: 2026.5 });
  ok(badSeason.reason === "invalid_input", "non-integer season → invalid_input");
}

// ── Determinism ─────────────────────────────────────────────────────────────
{
  const a = bridgeStatPosterior(baseInputs(ratePosterior(12, 0.55)));
  const b = bridgeStatPosterior(baseInputs(ratePosterior(12, 0.55)));
  ok(JSON.stringify(a) === JSON.stringify(b), "bridge is deterministic");
}

console.log(`\nstatPosterior.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
