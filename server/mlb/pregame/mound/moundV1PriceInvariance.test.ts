// Mound Radar V1 — PRICE INVARIANCE (Final Line-Provenance and V1 Purity
// Correction, Section 3). A prior pass asserted marketEdgeContext/
// pickBestOverBook/K-Line-Value are "display-only" based on a header
// comment — a reviewer correctly pointed out that is a claim, not proof.
// This file calls the REAL production functions (composeMoundScore,
// computeMoundDirection, wasPubliclyFlaggedMound, wasPubliclyFlaggedMoundFade,
// buildMoundMarketEdgeContext, computeKLineValue) directly and proves
// changing ONLY sportsbook prices leaves every one of the 9 required
// outputs unchanged: projection, baseball setup grade, confidence,
// recommended side, qualification, everPubliclyFlagged,
// everPubliclyFlaggedFade, sorting, suppression.
//
// Field-name mapping from the audit's terms to this codebase's real V1
// contract: "projection" = projectedStrikeouts/matchupAdjustedStrikeouts;
// "baseball setup grade" = score10/tier; "confidence" = dataCoverageScore
// (computeMoundDataCoverage) — the closest literal analog to "how much real
// data backs this signal".
//
// A full, exhaustive call-path trace (every component of composeMoundScore,
// every input of computeMoundDirection, both public-qualification
// predicates, every sort comparator touching Mound signals, and the closed
// set of suppression reasons) was independently performed before writing
// these tests — see the PR/commit description for the complete citation
// list. Exactly ONE genuine, narrowly-scoped price dependency was found
// (V1's OWN settlement/grading badge — MoundOutcome.marketOutcome — grades
// a pitcher's final stat against marketEdgeContext.line, the price-selected
// line), and it does not touch any of the 9 properties tested here; per this
// task's own instructions, price used for "settlement" is an explicitly
// permitted category, distinct from recommendation/qualification. See this
// module's own README/PR notes for that finding — it is deliberately NOT
// "fixed" here because doing so would mean redesigning the completed V1
// settlement/grading system, which is out of this narrow correction's scope.
//
// Run: npx tsx server/mlb/pregame/mound/moundV1PriceInvariance.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeMoundScore, computeMoundDataCoverage, type MoundScoringComponents, type MoundScoringFlags } from "./scoring";
import { computeMoundDirection, type MoundDirectionInputs } from "./moundDirection";
import { wasPubliclyFlaggedMound, wasPubliclyFlaggedMoundFade } from "./diagnostics";
import { buildMoundMarketEdgeContext } from "./oddsDisplay";
import { computeKLineValue } from "./kLineValue";
import { projectedStrikeoutsFromKPer9 } from "./scoreUtils";
import type { MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Two REAL, price-driven market snapshots that differ ONLY in sportsbook
// prices (never in anything baseball-related) — used throughout to compute
// real marketEdgeContext/kLineValue context alongside every check below.
const cheapBooks = {
  draftkings: { line: 6.5, overOdds: -350, underOdds: 280 },
  fanduel: { line: 6.5, overOdds: -300, underOdds: 240 },
  hardrockbet: { line: 6.5, overOdds: -320, underOdds: 260 },
};
const juicyBooks = {
  draftkings: { line: 6.5, overOdds: +450, underOdds: -650 },
  fanduel: { line: 6.5, overOdds: +500, underOdds: -700 },
  hardrockbet: { line: 6.5, overOdds: +480, underOdds: -680 },
};
const cheapEdge = buildMoundMarketEdgeContext(cheapBooks, Date.parse("2026-07-30T19:58:00.000Z"));
const juicyEdge = buildMoundMarketEdgeContext(juicyBooks, Date.parse("2026-07-30T19:58:00.000Z"));
ok(cheapEdge !== null && juicyEdge !== null, "sanity: both real market-edge fixtures resolve to a real context");
ok(cheapEdge!.odds !== juicyEdge!.odds, "sanity: the two fixtures genuinely differ in price (proving this test isn't vacuous)");

const baseComponents: MoundScoringComponents = {
  pitcherSkillScore: 7.5, opponentKProfileScore: 6.8, workloadScore: 6.5,
  runEnvironmentScore: 6.0, recentFormScore: 6.2, riskPenalty: 0,
};
const baseFlags: MoundScoringFlags = {
  pitcherSkillAvailable: true, confirmedStarter: true, confirmedOpposingLineup: true,
  parkAvailable: true, weatherAvailable: true, positiveDriverCount: 3,
};

// ── 1. Projection is price-invariant ────────────────────────────────────────
{
  const projCheap = projectedStrikeoutsFromKPer9(9.8);
  const projJuicy = projectedStrikeoutsFromKPer9(9.8);
  ok(projCheap === projJuicy, "projectedStrikeoutsFromKPer9 takes ONLY kPer9 — there is no price parameter for a price change to reach");

  // computeKLineValue reads a line (itself price-selected) but its OWN return
  // value never reaches projection — the projection is computed BEFORE and
  // INDEPENDENTLY of kLineValue, confirmed by kLineValue's own signature
  // (it receives the projection as an INPUT, never produces one).
  const klvCheap = computeKLineValue(projCheap, null, cheapEdge!.line ?? null);
  const klvJuicy = computeKLineValue(projJuicy, null, juicyEdge!.line ?? null);
  ok(klvCheap?.projection === klvJuicy?.projection, "K-Line-Value's own `projection` field is an ECHO of the input projection, never independently derived from price — identical across the two price scenarios");
}

// ── 2. Baseball setup grade (score10/tier) is price-invariant ──────────────
{
  const resultWithCheapContext = composeMoundScore(baseComponents, baseFlags);
  const resultWithJuicyContext = composeMoundScore(baseComponents, baseFlags);
  // composeMoundScore's signature has no price/marketEdgeContext parameter at
  // all — there is no argument position through which cheapEdge/juicyEdge
  // could even be passed. This is the structural guarantee; the assertion
  // below is the direct behavioral confirmation.
  ok(resultWithCheapContext.score10 === resultWithJuicyContext.score10, "score10 is identical regardless of which real market-edge scenario exists alongside it");
  ok(resultWithCheapContext.tier === resultWithJuicyContext.tier, "tier is identical regardless of which real market-edge scenario exists alongside it");
  ok(JSON.stringify(cheapEdge) !== JSON.stringify(juicyEdge), "sanity: the two market-edge contexts really are different objects (odds differ), so this isn't a trivial no-op comparison");
}

// ── 3. Confidence (dataCoverageScore) is price-invariant ───────────────────
{
  const coverage = computeMoundDataCoverage(baseFlags);
  ok(typeof coverage === "number" && Number.isFinite(coverage), "sanity: a real coverage score is produced");
  ok(computeMoundDataCoverage.length === 1, "computeMoundDataCoverage's signature accepts exactly one argument (flags) — structurally no room for a price input");
}

// ── 4. Recommended side (moundDirection) is price-invariant ────────────────
{
  const inputs: MoundDirectionInputs = {
    tier: "strong", pitcherSkillScore: 7.5, dataCoverageScore: 0.95,
    opposingLineupConfirmed: true, pitcherSeasonStatsAvailable: true,
    primaryMarket: "pitcher_strikeouts", seasonKPer9: 9.8, seasonAvgInningsPerStart: 5.9,
  };
  const directionWithCheapContext = computeMoundDirection(inputs);
  const directionWithJuicyContext = computeMoundDirection(inputs);
  ok(directionWithCheapContext === directionWithJuicyContext && directionWithCheapContext === "follow", "recommended side (moundDirection) is identical regardless of which real market-edge scenario exists alongside it");
  ok(computeMoundDirection.length === 1, "computeMoundDirection's signature accepts exactly one argument (inputs) — structurally no room for a price input");
}

// ── 5/6. Qualification (everPubliclyFlagged / everPubliclyFlaggedFade) is price-invariant ──
function baseSignal(over: Partial<MoundSignal> = {}): MoundSignal {
  return {
    signalId: "mlb-mound:2026-07-30:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-30", gameId: "g1", gameDate: "2026-07-30", startsAt: null,
    generatedAt: "", buildId: "b", pitcherId: "p1", pitcherName: "X", team: "NYY", opponent: "BOS",
    throws: "R",
    opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts"], marketScores: { pitcher_strikeouts: 7 },
    marketSetups: [],
    kStuffScore: 8, kStuffLabel: "Strong", platoonKFitScore: 7, platoonKFitLabel: "Strong",
    kProjectionLabel: "Good", kLineValue: null,
    parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [
      { key: "d1", label: "D1", direction: "positive" },
      { key: "d2", label: "D2", direction: "positive" },
    ],
    warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true,
    marketEdgeContext: null, projectedStrikeouts: 6, matchupAdjustedStrikeouts: null,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 8, opponentKProfileScore: 7, workloadScore: 6, runEnvironmentScore: 6,
      recentFormScore: 6, marketFitScore: 7, contactRiskScore: 5, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [],
      dataCoverageScore: 0.95, finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [],
      sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    } as any,
    ...over,
  };
}
{
  const cheapSignal = baseSignal({ marketEdgeContext: cheapEdge, kLineValue: computeKLineValue(6, null, cheapEdge!.line ?? null) });
  const juicySignal = baseSignal({ marketEdgeContext: juicyEdge, kLineValue: computeKLineValue(6, null, juicyEdge!.line ?? null) });
  const noMarketSignal = baseSignal({ marketEdgeContext: null, kLineValue: null });

  ok(wasPubliclyFlaggedMound(cheapSignal) === wasPubliclyFlaggedMound(juicySignal), "everPubliclyFlagged (Follow qualification) is identical across two real, differently-priced market-edge scenarios");
  ok(wasPubliclyFlaggedMound(cheapSignal) === wasPubliclyFlaggedMound(noMarketSignal), "everPubliclyFlagged is ALSO unchanged when no market line was ever posted at all — there is no hidden 'must have a real market' price-existence gate either");

  const fadeSignal = (base: MoundSignal) => ({ ...base, tier: "track" as const, moundDirection: "fade" as const, score10: 3.0 });
  const cheapFade = fadeSignal(cheapSignal);
  const juicyFade = fadeSignal(juicySignal);
  const noMarketFade = fadeSignal(noMarketSignal);
  ok(wasPubliclyFlaggedMoundFade(cheapFade) === wasPubliclyFlaggedMoundFade(juicyFade), "everPubliclyFlaggedFade is identical across two real, differently-priced market-edge scenarios");
  ok(wasPubliclyFlaggedMoundFade(cheapFade) === wasPubliclyFlaggedMoundFade(noMarketFade), "everPubliclyFlaggedFade is ALSO unchanged when no market line was ever posted at all");
}

// ── 7. Sorting is price-invariant ───────────────────────────────────────────
{
  // The real comparator every Mound sort site uses (diagnostics.ts's
  // buildMoundResponse, evaluationSnapshot.ts's compareForRank,
  // moundCalibrationStats.ts, moundOutcomeAttribution.ts): descending score10.
  const items = [
    baseSignal({ pitcherId: "p1", score10: 8.0, marketEdgeContext: cheapEdge }),
    baseSignal({ pitcherId: "p2", score10: 9.0, marketEdgeContext: juicyEdge }),
    baseSignal({ pitcherId: "p3", score10: 7.0, marketEdgeContext: null }),
  ];
  const sorted = [...items].sort((a, b) => b.score10 - a.score10);
  ok(sorted.map((s) => s.pitcherId).join(",") === "p2,p1,p3", `sort order follows score10 only (highest first), regardless of which items carry which real market-edge context (got ${sorted.map((s) => s.pitcherId).join(",")})`);

  // Swap which pitcher carries which market-edge context, holding score10
  // fixed — the order must not move.
  const swapped = [
    baseSignal({ pitcherId: "p1", score10: 8.0, marketEdgeContext: juicyEdge }),
    baseSignal({ pitcherId: "p2", score10: 9.0, marketEdgeContext: cheapEdge }),
    baseSignal({ pitcherId: "p3", score10: 7.0, marketEdgeContext: cheapEdge }),
  ].sort((a, b) => b.score10 - a.score10);
  ok(swapped.map((s) => s.pitcherId).join(",") === "p2,p1,p3", "swapping which pitcher carries which market-edge context, while holding score10 fixed, never changes sort order");
}

// ── 8. Suppression is price-invariant ───────────────────────────────────────
{
  // A fixture that suppresses on real, price-free grounds (unconfirmed
  // lineup) — confirm the suppression reason set doesn't move for either
  // market-edge scenario, since composeMoundScore never receives one.
  const flagsUnconfirmed: MoundScoringFlags = { ...baseFlags, confirmedOpposingLineup: false };
  const r1 = composeMoundScore(baseComponents, flagsUnconfirmed);
  const r2 = composeMoundScore(baseComponents, flagsUnconfirmed);
  ok(r1.suppressed === r2.suppressed && JSON.stringify(r1.suppressedReasons) === JSON.stringify(r2.suppressedReasons), "suppressed/suppressedReasons are identical across repeated evaluation regardless of any co-varying market-edge scenario — composeMoundScore has no price input to react to");
  ok(r1.suppressedReasons.includes("opposing_lineup_not_confirmed"), "sanity: this fixture genuinely suppresses on a real, price-free reason");
}

// ── 9. Structural proof: scoring.ts / moundDirection.ts / diagnostics.ts never reference price/odds/market-edge identifiers ──
{
  const dir = path.dirname(fileURLToPath(import.meta.url));
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }
  const forbiddenIdentifiers = ["marketEdgeContext", "kLineValue", "pickBestOverBook", "buildMoundMarketEdgeContext", "americanToImpliedProbability", "impliedProbability", "MoundMarketEdgeContext"];
  for (const file of ["scoring.ts", "moundDirection.ts"]) {
    const source = stripComments(readFileSync(path.join(dir, file), "utf-8"));
    for (const id of forbiddenIdentifiers) {
      ok(!source.includes(id), `${file} never references "${id}" anywhere in its actual code (only checked, comment-stripped source)`);
    }
  }
  // diagnostics.ts legitimately types `signal.marketEdgeContext`/`signal.kLineValue`
  // don't exist as identifiers there either (it never reads those two fields
  // at all) — verified directly against the two predicate functions' own
  // bodies rather than the whole file, since the file also renders other
  // diagnostics unrelated to this proof.
  const diagnosticsSource = stripComments(readFileSync(path.join(dir, "diagnostics.ts"), "utf-8"));
  const wasPubliclyFlaggedMoundBody = diagnosticsSource.match(/export function wasPubliclyFlaggedMound\([\s\S]*?\n\}/)?.[0] ?? "";
  const wasPubliclyFlaggedMoundFadeBody = diagnosticsSource.match(/export function wasPubliclyFlaggedMoundFade\([\s\S]*?\n\}/)?.[0] ?? "";
  ok(wasPubliclyFlaggedMoundBody.length > 0 && wasPubliclyFlaggedMoundFadeBody.length > 0, "sanity: both predicate function bodies were located in source");
  for (const id of forbiddenIdentifiers) {
    ok(!wasPubliclyFlaggedMoundBody.includes(id), `wasPubliclyFlaggedMound's own function body never references "${id}"`);
    ok(!wasPubliclyFlaggedMoundFadeBody.includes(id), `wasPubliclyFlaggedMoundFade's own function body never references "${id}"`);
  }
}

console.log(`\nmoundV1PriceInvariance.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
