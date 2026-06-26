// Phase 1 Power Prior — shadow-only contract tests.
// Run with: npx tsx server/mlb/powerPrior/powerPriorShadow.test.ts
//
// Covers: standalone→PowerPrior mapping, missing-signal "none" prior, comparison
// severity thresholds, input immutability, and proof that the shadow hook does
// not alter the live inline HR conversion result.

import { computeHRConversionProbability, type HRConversionInput } from "../hrConversionModel";
import {
  getSnapshotForDate,
  setSnapshot,
  _resetForTests as resetStore,
  type PregamePowerSnapshot,
} from "../pregamePowerRadar/pregamePowerRadarStore";
import type { PregamePowerSignal } from "../pregamePowerRadar/types";
import { getPowerPrior, mapSignalToPowerPrior, mapStandaloneTier } from "./getPowerPrior";
import { comparePowerPriors, inlineFormScoreToApproxTier } from "./comparePowerPriors";
import { runPowerPriorShadow, _resetPowerPriorShadowForTests, type PowerPrior } from "./index";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function makeSignal(over: Partial<PregamePowerSignal> = {}): PregamePowerSignal {
  const base: any = {
    signalId: "mlb-pregame:2026-06-25:g1:123",
    sport: "mlb",
    engine: "pregame_power_radar",
    sessionDate: "2026-06-25",
    gameId: "g1",
    gameDate: "2026-06-25",
    startsAt: null,
    generatedAt: "2026-06-25T18:00:00.000Z",
    buildId: "build-1",
    batterId: "123",
    batterName: "Aaron Judge",
    team: "NYY",
    opponent: "TB",
    pitcherId: "999",
    pitcherName: "Some Pitcher",
    battingOrderSlot: 2,
    handednessMatchup: "R vs L",
    primaryMarket: "home_runs",
    marketTags: ["home_runs"],
    marketScores: { home_runs: 8.2 },
    marketSetups: [],
    parkContext: null,
    score10: 7.4,
    tier: "strong",
    drivers: [
      { key: "xiso", label: "Elite Isolated Power", direction: "positive", weight: 90 },
      { key: "barrel", label: "High Barrel Rate", direction: "positive", weight: 70 },
      { key: "bvp", label: "Poor BvP History", direction: "negative", weight: 40 },
    ],
    warnings: [],
    tags: [],
    lineupStatus: "confirmed",
    weatherStatus: "confirmed",
    gameStatus: "pre",
    firstPitchLockEligible: true,
    lockedAt: null,
    hasMarketLine: false,
    isOfficialPlay: false,
    isPregameTarget: true,
    status: "active",
    suppressed: false,
    suppressedReasons: [],
    becameLiveReady: false,
    becameLiveFire: false,
    convertedLiveAt: null,
    diagnostics: { dataCoverageScore: 0.95 },
  };
  return { ...base, ...over } as PregamePowerSignal;
}

function snapshotWith(signals: PregamePowerSignal[]): PregamePowerSnapshot {
  const map = new Map<string, PregamePowerSignal>();
  for (const s of signals) map.set(`${s.sessionDate}_${s.gameId}_${s.batterId}`, s);
  return {
    buildId: "build-1",
    sessionDate: "2026-06-25",
    generatedAt: "2026-06-25T18:00:00.000Z",
    builtAtMs: Date.now(),
    gamesScanned: 1,
    battersEvaluated: signals.length,
    signals: map,
    coverage: { lineupCoverage: 1, weatherCoverage: 1, batterCoverage: 1, pitcherCoverage: 1 },
  };
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj as any)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

console.log("\n[Power Prior — Phase 1 shadow] running cases\n");

// ── 1) Mapping standalone signal → PowerPrior ────────────────────────────────
{
  const prior = mapSignalToPowerPrior(makeSignal(), "123", "g1");
  assert("source is pregame_power_radar", prior.source === "pregame_power_radar", prior.source);
  assert("score10 mapped verbatim", prior.preGamePowerScore10 === 7.4, String(prior.preGamePowerScore10));
  assert("score100 = score10 × 10", prior.preGamePowerScore100 === 74, String(prior.preGamePowerScore100));
  assert("tier mapped strong→strong", prior.preGameTier === "strong", String(prior.preGameTier));
  assert("confidence = coverage × 100", prior.confidenceScore === 95, String(prior.confidenceScore));
  assert("estimatedHrProbability stays null (no compute)", prior.estimatedHrProbability === null);
  assert("topDrivers are positives sorted by weight", prior.topDrivers[0] === "Elite Isolated Power" && prior.topDrivers.length === 2, JSON.stringify(prior.topDrivers));
  assert("topSuppressors are negatives", prior.topSuppressors.length === 1 && prior.topSuppressors[0] === "Poor BvP History", JSON.stringify(prior.topSuppressors));
  assert("hasStandalonePregameSignal true", prior.diagnostics.hasStandalonePregameSignal === true);
  assert("estimatedHrProbability listed missing", prior.diagnostics.missingFields.includes("estimatedHrProbability"));
  assert("score fields listed mapped", prior.diagnostics.mappedFromStandaloneFields.includes("preGamePowerScore10"));
}

// ── tier mapping table ───────────────────────────────────────────────────────
{
  assert("nuclear→elite", mapStandaloneTier("nuclear", false) === "elite");
  assert("elite→elite", mapStandaloneTier("elite", false) === "elite");
  assert("power_watch→watch", mapStandaloneTier("power_watch", false) === "watch");
  assert("track→neutral", mapStandaloneTier("track", false) === "neutral");
  assert("suppressed flag overrides → suppressed", mapStandaloneTier("elite", true) === "suppressed");
}

// ── 2) Missing standalone signal → source "none" ─────────────────────────────
{
  resetStore();
  const prior = getPowerPrior({ gameDateET: "2026-06-25", gameId: "g1", playerId: "123" });
  assert("empty snapshot → source none", prior.source === "none", prior.source);
  assert("none prior has null score", prior.preGamePowerScore10 === null);
  assert("none prior flags no standalone signal", prior.diagnostics.hasStandalonePregameSignal === false);
  assert("none prior empty driver arrays", prior.topDrivers.length === 0 && prior.topSuppressors.length === 0);

  // With a snapshot present, resolution by MLBAM key works.
  setSnapshot(snapshotWith([makeSignal()]));
  const found = getPowerPrior({ gameDateET: "2026-06-25", gameId: "g1", playerId: "123" });
  assert("snapshot present → resolves standalone", found.source === "pregame_power_radar", found.source);
  // Wrong date → no match (snapshot is date-scoped).
  const wrongDate = getPowerPrior({ gameDateET: "2026-06-24", gameId: "g1", playerId: "123" });
  assert("different date → source none", wrongDate.source === "none", wrongDate.source);
  // name+team fallback.
  const byName = getPowerPrior({ gameDateET: "2026-06-25", gameId: "g1", playerId: "nomatch", playerName: "Aaron Judge", teamAbbr: "NYY" });
  assert("name+team fallback resolves", byName.source === "pregame_power_radar", byName.source);
  resetStore();
}

// ── 3) Comparison severity thresholds ────────────────────────────────────────
function priorWithScore(score10: number | null, source: PowerPrior["source"] = "pregame_power_radar", tier: any = "strong"): PowerPrior {
  return {
    playerId: "123", gameId: "g1", source,
    preGamePowerScore10: score10,
    preGamePowerScore100: score10 == null ? null : score10 * 10,
    preGameTier: tier,
    estimatedHrProbability: null, confidenceScore: 90,
    topDrivers: [], topSuppressors: [], generatedAt: null,
    diagnostics: { hasStandalonePregameSignal: source !== "none", hasInlineFallback: false, mappedFromStandaloneFields: [], missingFields: [] },
  };
}
{
  // delta 0.2 → low
  const low = comparePowerPriors(priorWithScore(7.0), { formScore: 68, priorMult: 1.1 });
  assert("delta 0.2 → low", low.severity === "low", `${low.absoluteDelta} ${low.severity}`);
  assert("inlineScore10 = formScore/10", low.inlineScore10 === 6.8, String(low.inlineScore10));

  // delta 2.0 → medium
  const med = comparePowerPriors(priorWithScore(7.0), { formScore: 50, priorMult: 1.0 });
  assert("delta 2.0 → medium", med.severity === "medium", `${med.absoluteDelta} ${med.severity}`);

  // delta 4.0 → high
  const high = comparePowerPriors(priorWithScore(8.0), { formScore: 40, priorMult: 1.0 });
  assert("delta 4.0 → high", high.severity === "high", `${high.absoluteDelta} ${high.severity}`);
  assert("high divergence noted", high.notes.includes("high_divergence"));

  // no standalone signal → delta null, severity none
  const none = comparePowerPriors(priorWithScore(null, "none", null), { formScore: 60, priorMult: 1.0 });
  assert("no standalone → severity none", none.severity === "none", none.severity);
  assert("no standalone → delta null", none.absoluteDelta === null);
  assert("no standalone note present", none.notes.includes("no_standalone_pregame_signal"));

  // inline unavailable → delta null, severity none
  const inlineNull = comparePowerPriors(priorWithScore(7.0), { formScore: null, priorMult: null });
  assert("inline null → severity none", inlineNull.severity === "none", inlineNull.severity);
  assert("inline null note present", inlineNull.notes.includes("inline_form_score_unavailable"));

  // boundary: exactly 1.5 → medium (low is [0,1.5))
  const boundLow = comparePowerPriors(priorWithScore(7.0), { formScore: 55, priorMult: 1.0 });
  assert("delta exactly 1.5 → medium (boundary)", boundLow.absoluteDelta === 1.5 && boundLow.severity === "medium", `${boundLow.absoluteDelta} ${boundLow.severity}`);

  assert("inlineFormScoreToApproxTier(72)→strong", inlineFormScoreToApproxTier(72) === "strong");
  assert("inlineFormScoreToApproxTier(null)→null", inlineFormScoreToApproxTier(null) === null);
}

// ── 4) No mutation of input objects ──────────────────────────────────────────
{
  const signal = deepFreeze(makeSignal());
  let threw = false;
  try { mapSignalToPowerPrior(signal, "123", "g1"); } catch { threw = true; }
  assert("mapSignalToPowerPrior does not mutate frozen signal", !threw);

  const prior = deepFreeze(priorWithScore(7.0));
  const inline = deepFreeze({ formScore: 50, priorMult: 1.0 });
  let threw2 = false;
  try { comparePowerPriors(prior, inline as any); } catch { threw2 = true; }
  assert("comparePowerPriors does not mutate frozen inputs", !threw2);
  assert("frozen inline preserved", inline.formScore === 50);
}

// ── 5) Shadow hook does NOT change the live inline conversion result ──────────
{
  _resetPowerPriorShadowForTests();
  resetStore();
  const convInput: HRConversionInput = {
    hrBuildScore: 0,
    factors: { contactClasses: [] } as any,
    inning: 1, isTopInning: true, battingOrderSlot: 4,
    currentRuns: 0, leagueAvgRuns: 4.5,
    pitchCount: 10, timesThrough: 1, isPitcherCollapsing: false,
    era: 4.0, parkFactor: 1.0,
    windDirection: null, windSpeed: null, temperature: 72, isIndoors: false,
    batterHand: "R", pitcherThrows: "R",
    seasonHRRate: 0.04, barrelRate: 0.1, hardHitRate: 0.45, xSLG: 0.5,
    hrFBRatio: 18, flyBallPercent: 42, xISO: 0.22, xwOBA: 0.38, pullRatePercent: 48,
  };
  const before = computeHRConversionProbability(convInput);
  // Run the shadow hook between two identical engine calls — it must be a pure
  // side effect and leave the engine output bit-for-bit identical.
  let threw = false;
  try {
    runPowerPriorShadow({
      gameId: "g1", playerId: "123", playerName: "Aaron Judge", teamAbbr: "NYY",
      inlineFormScore: before.components.pregameFormScore,
      inlinePriorMult: before.components.pregamePriorMult,
    });
  } catch { threw = true; }
  assert("runPowerPriorShadow never throws", !threw);
  const after = computeHRConversionProbability(convInput);
  assert("inline finalPerPARate unchanged across shadow", before.components.finalPerPARate === after.components.finalPerPARate, `${before.components.finalPerPARate} vs ${after.components.finalPerPARate}`);
  assert("inline calibratedProbability unchanged across shadow", before.calibratedProbability === after.calibratedProbability);
  assert("inline pregamePriorMult unchanged across shadow", before.components.pregamePriorMult === after.components.pregamePriorMult);

  // Shadow with no snapshot present → standalone source none, still no throw.
  let threw2 = false;
  try {
    runPowerPriorShadow({ gameId: "g2", playerId: "456", inlineFormScore: 60, inlinePriorMult: 1.05 });
  } catch { threw2 = true; }
  assert("shadow with missing snapshot is safe", !threw2);
  _resetPowerPriorShadowForTests();
}

console.log(`\n[Power Prior — Phase 1 shadow] ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
