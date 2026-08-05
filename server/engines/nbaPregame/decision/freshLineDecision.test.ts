// Run: npx tsx server/engines/nbaPregame/decision/freshLineDecision.test.ts
// Pregame Targets PR4 — fresh-line decision boundary: identity verification,
// missing/malformed/stale line rejection, market-unavailable, not-resolvable,
// coherent probabilities, complementarity-preserving calibration, and PR3
// blindness after the line is joined.
import { evaluateFreshLine, isDecisionOk, type DecisionIdentity, type EvaluateFreshLineArgs } from "./freshLineDecision";
import { computeNbaProjection, type NbaProjectionEngineInput, type NbaProjectionResult } from "../nbaProjectionEngine";
import { carriesForbiddenKey } from "../frozenNbaProjectionInput";
import { emptyPosteriorState, updatePosterior, type PosteriorState, type Prior } from "../../../pregameTargets/posteriorState/posteriorState";
import { allocateTeamMinutes, playerMinutes } from "../minutes/teamMinutesAllocator";
import type { CalibrationObservation } from "../calibration/walkForwardCalibration";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

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
    players: Array.from({ length: 9 }, (_, i) => ({ playerId: `p${i}`, playProbability: 1, projectedMinutesIfActive: [34, 32, 30, 26, 24, 22, 20, 18, 14][i] })),
  });
  return playerMinutes(alloc, "p0")!;
}
function projectionInput(over: Partial<NbaProjectionEngineInput> = {}): NbaProjectionEngineInput {
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
function identityFor(proj: NbaProjectionResult, market: DecisionIdentity["market"]): DecisionIdentity {
  return {
    playerCanonicalId: proj.playerCanonicalId,
    gameCanonicalId: proj.gameCanonicalId,
    market,
    modelVersion: proj.modelVersion,
    projectionHash: proj.projectionHash,
  };
}
const ASOF = "2026-08-05T18:05:00Z";
const freshLine = (line: number, capturedAt = "2026-08-05T18:04:00Z") => ({ line, capturedAt, sportsbook: "book-a" });

// ── OK path: coherent probabilities produced ────────────────────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const d = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "points"), line: freshLine(24.5), asOf: ASOF });
  ok(isDecisionOk(d), "valid request → ok");
  ok(d.probabilities !== null, "probabilities produced");
  ok(approx(d.probabilities!.pOver + d.probabilities!.pUnder + d.probabilities!.pPush, 1), "over+under+push = 1");
  ok(d.line === 24.5, "line echoed");
  ok(d.provenance.projectionHash === proj.projectionHash && d.provenance.featureHash === proj.featureHash, "provenance carries the frozen hashes");
}

// ── Identity mismatch (each dimension) ──────────────────────────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const bases = [
    { ...identityFor(proj, "points"), playerCanonicalId: "nba:player:999" },
    { ...identityFor(proj, "points"), gameCanonicalId: "nba:game:999" },
    { ...identityFor(proj, "points"), modelVersion: "wrong_model" },
    { ...identityFor(proj, "points"), projectionHash: "deadbeef" },
  ];
  for (const [i, id] of bases.entries()) {
    const d = evaluateFreshLine({ projection: proj, identity: id, line: freshLine(24.5), asOf: ASOF });
    ok(d.status === "identity_mismatch", `identity mismatch dimension ${i} rejected`);
    ok(d.probabilities === null, `mismatch ${i} yields no probabilities`);
  }
}

// ── Missing / malformed / stale line rejection ──────────────────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const id = identityFor(proj, "points");
  ok(evaluateFreshLine({ projection: proj, identity: id, line: null, asOf: ASOF }).status === "line_missing", "null line → line_missing");
  ok(evaluateFreshLine({ projection: proj, identity: id, line: freshLine(NaN), asOf: ASOF }).status === "line_malformed", "NaN line → line_malformed");
  ok(evaluateFreshLine({ projection: proj, identity: id, line: { line: 24.5, capturedAt: "nope" }, asOf: ASOF }).status === "line_malformed", "bad capturedAt → line_malformed");
  // Future line (capturedAt after asOf).
  ok(evaluateFreshLine({ projection: proj, identity: id, line: freshLine(24.5, "2026-08-05T18:10:00Z"), asOf: ASOF }).status === "line_malformed", "future line → line_malformed");
  // Stale line (captured 30 min before asOf, > 15 min window).
  ok(evaluateFreshLine({ projection: proj, identity: id, line: freshLine(24.5, "2026-08-05T17:35:00Z"), asOf: ASOF }).status === "line_stale", "old line → line_stale");
  // Fresh within a custom larger window is accepted.
  ok(evaluateFreshLine({ projection: proj, identity: id, line: freshLine(24.5, "2026-08-05T17:35:00Z"), asOf: ASOF, maxLineAgeMs: 60 * 60 * 1000 }).status === "ok", "within custom window → ok");
}

// ── Market unavailable ──────────────────────────────────────────────────────
{
  const proj = computeNbaProjection(projectionInput({
    posteriors: { points: ratePosterior("points", 20, 0.6), rebounds: ratePosterior("rebounds", 20, 0.25), assists: null, three_pointers_made: ratePosterior("threes", 20, 0.07) },
  }));
  const d = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "assists"), line: freshLine(6.5), asOf: ASOF });
  ok(d.status === "market_unavailable", "unavailable market → market_unavailable");
  // A combo needing assists is also unavailable.
  const d2 = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "pra"), line: freshLine(40.5), asOf: ASOF });
  ok(d2.status === "market_unavailable", "combo needing missing component → market_unavailable");
}

// ── Not resolvable (line at/above the folded tail bucket) ───────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const pointsPmfLen = proj.markets.find((m) => m.market === "points")!.pmf!.length; // 81 (cap 80)
  const d = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "points"), line: freshLine(pointsPmfLen - 1), asOf: ASOF }); // line 80 = folded bucket
  ok(d.status === "not_resolvable", "integer line on folded tail → not_resolvable");
}

// ── Calibration: complementarity preserved (UNDER = 1 − OVER) ────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const iso = (day: number) => `2026-01-${String(day).padStart(2, "0")}T12:00:00Z`;
  const observations: CalibrationObservation[] = [];
  for (let i = 0; i < 60; i++) observations.push({ market: "points", modelVersion: proj.modelVersion, rawProbability: 0.55, outcome: i < 30 ? 1 : 0, knownAt: iso(5) });
  const d = evaluateFreshLine({
    projection: proj,
    identity: identityFor(proj, "points"),
    line: freshLine(24.5),
    asOf: ASOF,
    calibration: { observations, config: { numBuckets: 10, minTotalSamples: 20, priorStrength: 5 } },
  });
  ok(isDecisionOk(d), "calibrated decision ok");
  ok(d.calibration !== null && d.calibratedNoPushWinOver !== null, "calibration attached");
  ok(approx(d.calibratedNoPushWinOver! + d.calibratedNoPushWinUnder!, 1), "calibrated OVER + UNDER = 1 (complement, not independently estimated)");
  // Without a calibrator, calibrated fields are null (raw probabilities still coherent).
  const raw = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "points"), line: freshLine(24.5), asOf: ASOF });
  ok(raw.calibration === null && raw.calibratedNoPushWinOver === null, "no calibrator → null calibrated fields");
}

// ── PR3 stays blind after the line is joined ────────────────────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const beforeHash = proj.projectionHash;
  const beforeFeature = proj.featureHash;
  const d = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "points"), line: freshLine(24.5), asOf: ASOF });
  // The projection object is untouched by the decision.
  ok(proj.projectionHash === beforeHash && proj.featureHash === beforeFeature, "projection hashes unchanged by the decision");
  ok(!carriesForbiddenKey(proj), "projection still carries no forbidden (price/line/odds/EV) key");
  // The line lives ONLY in the decision result — the projection never gains a line field.
  ok(!("line" in (proj as unknown as Record<string, unknown>)), "projection object never gains a line field");
  ok(d.line === 24.5, "line lives on the decision result");
}

// ── Determinism ─────────────────────────────────────────────────────────────
{
  const proj = computeNbaProjection(projectionInput());
  const a = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "points"), line: freshLine(24.5), asOf: ASOF });
  const b = evaluateFreshLine({ projection: proj, identity: identityFor(proj, "points"), line: freshLine(24.5), asOf: ASOF });
  ok(JSON.stringify(a) === JSON.stringify(b), "decision deterministic");
}

console.log(`\nfreshLineDecision.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
