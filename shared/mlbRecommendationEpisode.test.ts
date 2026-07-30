// MLB Recommendation Episode contract — invariants.
//
// Run: npx tsx shared/mlbRecommendationEpisode.test.ts

import {
  applyMlbEpisodeLifecycleEvent,
  settleMlbRecommendationEpisode,
  MlbEpisodeMutationError,
  MlbEpisodeTransitionError,
  MlbEpisodeTerminalError,
  type MlbRecommendationEpisode,
} from "./mlbRecommendationEpisode";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function makeEpisode(overrides: Partial<MlbRecommendationEpisode> = {}): MlbRecommendationEpisode {
  return {
    episodeId: "ep_1",
    sport: "MLB",
    product: "mound",
    gameId: "game_1",
    playerId: "player_1",
    playerName: "Test Pitcher",
    market: "pitcher_strikeouts",
    recommendedSide: "OVER",
    line: 5.5,
    americanOdds: -120,
    sportsbook: "draftkings",
    oddsFetchedAt: "2026-07-29T22:00:00.000Z",
    recommendationCreatedAt: "2026-07-29T22:00:05.000Z",
    modelVersion: "mound_v1",
    contractVersion: "episode_v1",
    projection: 6.2,
    modelProbability: 0.58,
    setupGrade: "Strong",
    sportsbookEdge: null,
    dataQuality: "complete",
    sourceType: "sportsbook",
    isOfficial: true,
    gamePhase: "pregame",
    surfacedAt: null,
    expiresAt: null,
    lifecycleStatus: "recommended",
    status: "created",
    settlementResult: null,
    settledAt: null,
    ...overrides,
  };
}

// ── Frozen fields cannot be mutated ─────────────────────────────────────────
{
  const ep = makeEpisode();
  let threw = false;
  try {
    applyMlbEpisodeLifecycleEvent(ep, { line: 6.5 } as any);
  } catch (e) {
    threw = e instanceof MlbEpisodeMutationError;
  }
  ok(threw, "mutating a frozen field (line) throws MlbEpisodeMutationError");

  let threw2 = false;
  try {
    applyMlbEpisodeLifecycleEvent(ep, { americanOdds: -200, recommendedSide: "UNDER" } as any);
  } catch (e) {
    threw2 = e instanceof MlbEpisodeMutationError &&
      (e as MlbEpisodeMutationError).attemptedFields.includes("americanOdds") &&
      (e as MlbEpisodeMutationError).attemptedFields.includes("recommendedSide");
  }
  ok(threw2, "mutating multiple frozen fields at once names all of them in the error");
}

// ── Lifecycle events only touch mutable fields, return a new object ────────
{
  const ep = makeEpisode({ status: "created" });
  const surfaced = applyMlbEpisodeLifecycleEvent(ep, {
    status: "surfaced",
    surfacedAt: "2026-07-29T22:01:00.000Z",
    lifecycleStatus: "recommended",
  });
  ok(surfaced !== ep, "applyMlbEpisodeLifecycleEvent returns a new object, not the same reference");
  ok(ep.status === "created", "the original episode object is left untouched");
  ok(surfaced.status === "surfaced", "the new object reflects the patch");
  ok(surfaced.line === ep.line && surfaced.americanOdds === ep.americanOdds, "frozen fields carry through unchanged");
}

// ── Invalid status transitions are rejected ─────────────────────────────────
{
  const ep = makeEpisode({ status: "created" });
  let threw = false;
  try {
    applyMlbEpisodeLifecycleEvent(ep, { status: "settled" });
  } catch (e) {
    threw = e instanceof MlbEpisodeTransitionError;
  }
  ok(threw, "created -> settled directly is an invalid transition");
}
{
  const ep = makeEpisode({ status: "created" });
  const locked = applyMlbEpisodeLifecycleEvent(ep, { status: "surfaced" });
  const relocked = applyMlbEpisodeLifecycleEvent(locked, { status: "locked" });
  ok(relocked.status === "locked", "created -> surfaced -> locked is a valid chain");
}

// ── Terminal episodes reject every further lifecycle event ─────────────────
{
  const ep = makeEpisode({ status: "settled", settlementResult: "cashed", settledAt: "2026-07-30T01:00:00.000Z" });
  let threw = false;
  try {
    applyMlbEpisodeLifecycleEvent(ep, { expiresAt: "2026-01-01T00:00:00.000Z" });
  } catch (e) {
    threw = e instanceof MlbEpisodeTerminalError;
  }
  ok(threw, "a settled episode rejects further lifecycle events, even to a mutable field");
}
{
  const ep = makeEpisode({ status: "expired" });
  let threw = false;
  try {
    applyMlbEpisodeLifecycleEvent(ep, { status: "surfaced" });
  } catch (e) {
    threw = e instanceof MlbEpisodeTerminalError;
  }
  ok(threw, "an expired episode rejects further lifecycle events");
}

// ── Settlement grades the exact frozen side/line/price ──────────────────────
{
  const ep = makeEpisode({ status: "surfaced", recommendedSide: "UNDER", line: 7.5, americanOdds: 145 });
  const settled = settleMlbRecommendationEpisode(ep, "cashed", "2026-07-30T01:00:00.000Z");
  ok(settled.recommendedSide === "UNDER", "settlement preserves the original recommended side");
  ok(settled.line === 7.5, "settlement preserves the original line");
  ok(settled.americanOdds === 145, "settlement preserves the original captured price");
  ok(settled.status === "settled" && settled.settlementResult === "cashed", "settlement stamps status + result");
  ok(settled.lifecycleStatus === "cashed", "settlement lifecycle mirrors settlementResult");
}

// ── A settled episode can never be re-settled ───────────────────────────────
{
  const ep = makeEpisode({ status: "settled", settlementResult: "cashed", settledAt: "2026-07-30T01:00:00.000Z" });
  let threw = false;
  try {
    settleMlbRecommendationEpisode(ep, "missed", "2026-07-30T02:00:00.000Z");
  } catch (e) {
    threw = e instanceof MlbEpisodeTerminalError;
  }
  ok(threw, "a settled episode can never be re-settled");
}

// ── An invalid settlementResult value is rejected ───────────────────────────
{
  const ep = makeEpisode({ status: "surfaced" });
  let threw = false;
  try {
    settleMlbRecommendationEpisode(ep, "invalid" as any, "2026-07-30T02:00:00.000Z");
  } catch (e) {
    threw = e instanceof RangeError;
  }
  ok(threw, "an invalid settlementResult value is rejected");
}

console.log(`\nmlbRecommendationEpisode.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
