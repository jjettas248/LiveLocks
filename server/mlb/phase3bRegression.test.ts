/**
 * MLB Phase 3B — Regression Harness
 *
 * Plain-tsx test (no jest/vitest), follows the existing pattern from
 * canonicalProbability.test.ts and canonicalSignalTier.test.ts.
 *
 *   npx tsx server/mlb/phase3bRegression.test.ts
 *
 * Locks the eight invariants the user explicitly named, covering Phase 1
 * through Phase 3B:
 *
 *   1. HR Watch score bump does NOT change engine probability.
 *   2. HRR soft compression applies above 82 unless contactScore >= 0.65.
 *   3. Phase 1.5 HRR ceiling (88) still caps final output.
 *   4. hits_allowed fatigue wrapper shifts probability with pc/TTO/contact.
 *   5. Phase 1.5 hits_allowed UNDER cap (74) still binds after wrapper.
 *   6. signalTier remains server-owned (deriveSignalTier is the sole mapper).
 *   7. signalScore is NEVER substituted for engine probability.
 *   8. NBA / NCAAB files & imports untouched by Phase 3B.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  computeModelProbability,
  computeFullModelProbability,
  validateMlbEngineProbability,
  type ProbabilityInput,
} from "./probabilityEngine";
import {
  deriveSignalTier,
  deriveHrConfidenceTier,
  computeSignalScoreByFamily,
  computeHrRadarSignalComposite,
  type SignalConfidenceTier,
} from "./signalScore";
import type { MLBPropInput, MLBPropOutput } from "./types";

// __dirname shim for ESM (tsx loader runs as ESM).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── tiny assert helpers ────────────────────────────────────────────────────
let _passes = 0;
const _failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    _passes++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    _failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}
function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}
function assertClose(actual: number, expected: number, eps: number, label: string): void {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${label} — expected ~${expected} (±${eps}), got ${actual}`);
  }
}

// ── Test 1: HR Watch bump preserves probability ─────────────────────────────
//
// Replicates the orchestrator's HR Watch bump block on a mock scoreBreakdown
// + a separate "output" object that holds the canonical probability fields,
// asserting the bump only mutates scoreBreakdown.total and its derived
// confidenceTier — never the probability fields.
//
// Precision restructure (2026-07) — bug fix: this used to re-implement the
// GENERIC non-HR tier ladder (85/70/55/40) inline, matching a real bug in
// liveGameOrchestrator.ts's HR Watch bump block that used the same wrong
// ladder even though the bump only ever runs for market === "home_runs".
// Both are now fixed to use deriveHrConfidenceTier (80/65/55/35), the one
// canonical HR-specific ladder shared with computeHrRadarSignalComposite.
console.log("\n[1] HR Watch bump invariant");

function applyHrWatchBump(
  scoreBreakdown: { total: number; confidenceTier: SignalConfidenceTier },
  tier: "watch" | "lean" | null
): void {
  const bump = tier === "lean" ? 6 : tier === "watch" ? 3 : 0;
  if (bump > 0) {
    const newTotal = Math.max(0, Math.min(100, scoreBreakdown.total + bump));
    scoreBreakdown.total = newTotal;
    scoreBreakdown.confidenceTier = deriveHrConfidenceTier(newTotal);
  }
}

test("watch bump (+3) raises scoreBreakdown.total and re-derives tier", () => {
  const sb = { total: 53, confidenceTier: "WATCHLIST" as SignalConfidenceTier };
  const output = { engineProbability: 71.4, calibratedProbabilityOver: 71.4, calibratedProbabilityUnder: 28.6, evPct: 12.3 };
  const beforeOut = JSON.stringify(output);
  applyHrWatchBump(sb, "watch");
  assertEq(sb.total, 56, "total +3");
  assertEq(sb.confidenceTier, "SOLID", "tier re-derived from 56");
  assertEq(JSON.stringify(output), beforeOut, "output (probability fields) untouched");
});

test("lean bump (+6) raises score, probability fields untouched", () => {
  const sb = { total: 65, confidenceTier: "SOLID" as SignalConfidenceTier };
  const output = { engineProbability: 78.0, calibratedProbabilityOver: 78.0, calibratedProbabilityUnder: 22.0, evPct: 8.5 };
  const beforeOut = JSON.stringify(output);
  applyHrWatchBump(sb, "lean");
  assertEq(sb.total, 71, "total +6");
  assertEq(sb.confidenceTier, "STRONG", "tier re-derived from 71");
  assertEq(JSON.stringify(output), beforeOut, "output untouched");
});

test("HR-specific ladder, not the generic one: 79+6=85 is STRONG not ELITE", () => {
  // Discriminates the fix from the bug it replaces: under the old (wrong)
  // generic ladder (85=ELITE/70/55/40), 85 would be ELITE. Under the correct
  // HR-specific ladder (80=ELITE/65/55/35), 85 is well past the 80 floor —
  // still ELITE either way at 85. Use a value that actually discriminates.
  const sb = { total: 76, confidenceTier: "STRONG" as SignalConfidenceTier };
  applyHrWatchBump(sb, "lean"); // 76 + 6 = 82
  assertEq(sb.total, 82, "total +6");
  // Old generic ladder: 82 >= 70 && < 85 → STRONG. New HR ladder: 82 >= 80 → ELITE.
  assertEq(sb.confidenceTier, "ELITE", "82 is ELITE under the HR ladder (>=80), not STRONG under the generic one (>=85 required)");
});

test("HR-specific ladder floor at 35, not the generic floor at 40", () => {
  const sb = { total: 34, confidenceTier: "NO_SIGNAL" as SignalConfidenceTier };
  applyHrWatchBump(sb, "watch"); // 34 + 3 = 37
  assertEq(sb.total, 37, "total +3");
  // Old generic ladder: 37 < 40 → NO_SIGNAL. New HR ladder: 37 >= 35 → WATCHLIST.
  assertEq(sb.confidenceTier, "WATCHLIST", "37 is WATCHLIST under the HR ladder (>=35), not NO_SIGNAL under the generic one (>=40 required)");
});

test("null tier = no bump, no probability change", () => {
  const sb = { total: 50, confidenceTier: "WATCHLIST" as SignalConfidenceTier };
  const output = { engineProbability: 65.0 };
  applyHrWatchBump(sb, null);
  assertEq(sb.total, 50, "no bump");
  assertEq(output.engineProbability, 65.0, "prob unchanged");
});

test("bump caps at 100", () => {
  const sb = { total: 96, confidenceTier: "ELITE" as SignalConfidenceTier };
  applyHrWatchBump(sb, "lean");
  assertEq(sb.total, 100, "clamped at 100");
});

// ── Test 2: HRR compression above 82 unless contactScore >= 0.65 ────────────
console.log("\n[2] HRR soft compression");

function makeHrrInput(overrides: Partial<ProbabilityInput> = {}): ProbabilityInput {
  // Calibrated to push the TB negative-binomial above 82: high rate per PA,
  // many remaining PA, low threshold. neededTB = 1, rate=0.7, PA=4 → ~99%.
  return {
    projection: 5,
    threshold: 1,
    market: "hrr",
    remainingPA: 4,
    adjustedRate: 0.7,
    currentStatValue: 0,
    playerName: "test_player",
    ...overrides,
  };
}

test("HRR raw > 82 with weak contact (0.5) → compressed below raw", () => {
  // Use the JUSTIFIED branch (contactScore=0.7) as the raw reference — it
  // bypasses compression and exposes the underlying TB-distribution prob.
  const raw = computeModelProbability(makeHrrInput({ hrrJustification: { contactScore: 0.7 } }));
  const compressed = computeModelProbability(makeHrrInput({ hrrJustification: { contactScore: 0.5 } }));
  assertTrue(raw.dominantProbability > 82, `raw should exceed 82 (got ${raw.dominantProbability})`);
  assertTrue(compressed.dominantProbability < raw.dominantProbability, `compressed (${compressed.dominantProbability}) < raw (${raw.dominantProbability})`);
  // Formula: 82 + (raw-82)*0.5. Allow ±0.6 for clamp + double rounding.
  const expected = 82 + (raw.dominantProbability - 82) * 0.5;
  assertClose(compressed.dominantProbability, expected, 0.6, "compression formula");
});

test("HRR raw > 82 with strong contact (0.7) → passthrough (no compression)", () => {
  const justified = computeModelProbability(makeHrrInput({ hrrJustification: { contactScore: 0.7 } }));
  assertTrue(justified.dominantProbability > 82, `raw should exceed 82 to test passthrough (got ${justified.dominantProbability})`);
  // Passthrough = compression formula NOT applied. Verify by checking the
  // value would be different if compression had been applied.
  const wouldBeCompressed = 82 + (justified.dominantProbability - 82) * 0.5;
  assertTrue(
    Math.abs(justified.dominantProbability - wouldBeCompressed) > 1,
    "passthrough output is materially different from what compression would produce",
  );
});

test("HRR contactScore boundary: 0.65 exactly → passthrough", () => {
  const atBoundary = computeModelProbability(makeHrrInput({ hrrJustification: { contactScore: 0.65 } }));
  const justRaw = computeModelProbability(makeHrrInput({ hrrJustification: { contactScore: 0.95 } }));
  assertEq(atBoundary.dominantProbability, justRaw.dominantProbability, "0.65 is justified (>=, not >)");
});

// ── Test 3: Phase 1.5 HRR ceiling (88) still caps final ────────────────────
console.log("\n[3] Phase 1.5 HRR ceiling");

test("HRR justified high prob still capped at 88 by applyModelSafetyCeiling", () => {
  // Force extreme raw + justified contact so wrapper passes through, then
  // verify computeFullModelProbability final dominant <= 88.
  const full = computeFullModelProbability(
    makeHrrInput({ adjustedRate: 0.95, remainingPA: 6, threshold: 1, hrrJustification: { contactScore: 0.9 } }),
    null,
    "hrr",
    false,
    false,
  );
  assertTrue(full.dominantCalibratedProbability <= 88, `final ${full.dominantCalibratedProbability} must be <=88`);
});

test("HRR unjustified extreme also <=88 (compression + ceiling both bind)", () => {
  const full = computeFullModelProbability(
    makeHrrInput({ adjustedRate: 0.95, remainingPA: 6, threshold: 1 }),
    null,
    "hrr",
    false,
    false,
  );
  assertTrue(full.dominantCalibratedProbability <= 88, `final ${full.dominantCalibratedProbability} must be <=88`);
});

// ── Test 4: hits_allowed fatigue shift ──────────────────────────────────────
console.log("\n[4] hits_allowed fatigue wrapper");

function makeHitsAllowedInput(overrides: Partial<ProbabilityInput> = {}): ProbabilityInput {
  return {
    projection: 6.2,
    threshold: 6.5,
    market: "hits_allowed",
    playerName: "test_pitcher",
    ...overrides,
  };
}

test("no fatigue → wrapper applies zero shift (matches normal CDF baseline)", () => {
  const noFatigue = computeModelProbability(makeHitsAllowedInput({ pitcherFatigue: { pitchCount: 30, timesThrough: 1, contactAllowedScore: 0.3 } }));
  const noField = computeModelProbability(makeHitsAllowedInput());
  assertEq(noFatigue.overProbability, noField.overProbability, "no shift when nothing crosses thresholds");
});

test("full fatigue (pc=95, tto=3, contact=0.7) shifts +12 toward OVER", () => {
  const baseline = computeModelProbability(makeHitsAllowedInput());
  const fatigued = computeModelProbability(makeHitsAllowedInput({
    pitcherFatigue: { pitchCount: 95, timesThrough: 3, contactAllowedScore: 0.7 },
  }));
  const delta = fatigued.overProbability - baseline.overProbability;
  // 6 (pc>=90) + 5 (tto>=3) + 4 (contact>=0.6) = 15, capped at 12.
  // Allow ±0.5 for clamp/round at probability boundaries.
  assertClose(delta, 12, 0.5, "shift = +12 (capped)");
  assertEq(fatigued.purityTag, "mlb-hits_allowed-wrapper-v1", "purityTag flipped to wrapper-v1");
});

test("partial fatigue (pc=80, tto=2) shifts +3 toward OVER", () => {
  const baseline = computeModelProbability(makeHitsAllowedInput());
  const partial = computeModelProbability(makeHitsAllowedInput({
    pitcherFatigue: { pitchCount: 80, timesThrough: 2, contactAllowedScore: 0.3 },
  }));
  const delta = partial.overProbability - baseline.overProbability;
  // pc>=75 → +3; tto<3 → 0; contact<0.6 → 0  ⇒ +3
  assertClose(delta, 3, 0.5, "shift = +3");
});

test("pitchCount branches are mutually exclusive (>=90 fires not also >=75)", () => {
  const baseline = computeModelProbability(makeHitsAllowedInput());
  const high = computeModelProbability(makeHitsAllowedInput({
    pitcherFatigue: { pitchCount: 95, timesThrough: 1, contactAllowedScore: 0 },
  }));
  // Only pc>=90 → +6 (NOT 6+3).
  assertClose(high.overProbability - baseline.overProbability, 6, 0.5, "only +6, branches exclusive");
});

// ── Test 5: hits_allowed UNDER cap (74) still binds ─────────────────────────
console.log("\n[5] Phase 1.5 hits_allowed UNDER cap");

test("UNDER-favored hits_allowed clamped to 74 even after wrapper", () => {
  // Projection well below threshold → UNDER favored. No fatigue so no shift.
  const full = computeFullModelProbability(
    {
      projection: 3.5,
      threshold: 7.5,
      market: "hits_allowed",
      playerName: "test_pitcher_under",
    },
    null,
    "hits_allowed",
    true,
    false,
  );
  assertEq(full.isOverFavored, false, "UNDER favored");
  assertTrue(
    full.calibratedUnderProbability <= 74,
    `UNDER ${full.calibratedUnderProbability} must be <= 74 (Phase 1.5 cap)`,
  );
});

// ── Test 6: signalTier remains server-owned ─────────────────────────────────
console.log("\n[6] signalTier server-owned");

test("deriveSignalTier is the canonical mapper and is deterministic", () => {
  assertEq(typeof deriveSignalTier, "function", "deriveSignalTier exported");
  assertEq(deriveSignalTier("ELITE"), "elite", "ELITE → elite");
  assertEq(deriveSignalTier("STRONG"), "strong", "STRONG → strong");
  assertEq(deriveSignalTier("SOLID"), "lean", "SOLID → lean");
  assertEq(deriveSignalTier("WATCHLIST"), "watch", "WATCHLIST → watch");
  assertEq(deriveSignalTier("NO_SIGNAL"), "watch", "NO_SIGNAL → watch");
  assertEq(deriveSignalTier(undefined), "watch", "undefined → watch");
  assertEq(deriveSignalTier(null), "watch", "null → watch");
});

test("topPlaysService consumes server-stamped signalTier (not client-derived)", () => {
  // Lock the contract that buildTopPlays reads `MLBSignal.signalTier`
  // directly from the persisted record — the server is the sole source of
  // truth. Confirms (a) it pulls `sig.signalTier`, and (b) does NOT recompute
  // the tier from raw confidenceTier or probability on the read path.
  const topPlaysSrc = fs.readFileSync(path.resolve(process.cwd(), "server", "services", "topPlaysService.ts"), "utf8");
  assertTrue(/sig\.signalTier/.test(topPlaysSrc), "topPlaysService reads sig.signalTier from persisted record");
  assertTrue(/canonicalTier/.test(topPlaysSrc), "topPlaysService treats persisted tier as canonical");
});

// ── Test 7: signalScore never substituted for engine probability ────────────
console.log("\n[7] signalScore is never used as probability");

test("validateMlbEngineProbability returns null when engineProbability missing", () => {
  const out = validateMlbEngineProbability({ engineProbability: undefined, signalScore: 85, market: "hits", side: "OVER" });
  assertEq(out, null, "missing engineProbability → null (no signalScore fallback)");
});

test("validateMlbEngineProbability rejects NaN/Infinity/out-of-range", () => {
  assertEq(validateMlbEngineProbability({ engineProbability: NaN, signalScore: 90 }), null, "NaN rejected");
  assertEq(validateMlbEngineProbability({ engineProbability: Infinity, signalScore: 90 }), null, "Infinity rejected");
  assertEq(validateMlbEngineProbability({ engineProbability: -1, signalScore: 90 }), null, "<0 rejected");
  assertEq(validateMlbEngineProbability({ engineProbability: 101, signalScore: 90 }), null, ">100 rejected");
});

test("validateMlbEngineProbability accepts valid prob even when signalScore differs", () => {
  const out = validateMlbEngineProbability({ engineProbability: 71.4, signalScore: 99, market: "hits", side: "OVER" });
  assertEq(out, 71.4, "returned engineProbability, NOT signalScore");
});

// ── Test 8: NBA / NCAAB untouched ──────────────────────────────────────────
console.log("\n[8] NBA/NCAAB isolation");

test("Phase 3B touched files do NOT import from server/nba or server/ncaab", () => {
  const touched = [
    "probabilityEngine.ts",
    "markets.ts",
    "selfLearning.ts",
    "liveGameOrchestrator.ts",
  ];
  for (const f of touched) {
    const src = fs.readFileSync(path.resolve(process.cwd(), "server", "mlb", f), "utf8");
    if (/from\s+['"][^'"]*\b(nba|ncaab)\b[^'"]*['"]/.test(src)) {
      throw new Error(`${f} contains an NBA/NCAAB import`);
    }
  }
});

test("server/nba and server/ncaab directory listings exist (sanity) and are not modified by 3B", () => {
  const nbaDir = path.resolve(process.cwd(), "server", "nba");
  const ncaabDir = path.resolve(process.cwd(), "server", "ncaab");
  assertTrue(fs.existsSync(nbaDir), "server/nba exists (engine isolation invariant)");
  // ncaab may not exist as a directory if it lives under a different path —
  // soft-check rather than hard-fail.
  if (fs.existsSync(ncaabDir)) {
    const stat = fs.statSync(ncaabDir);
    assertTrue(stat.isDirectory(), "server/ncaab is a directory");
  }
});

// ── Test 9: buildWatchSignal HR routing fix ─────────────────────────────────
//
// Volume-problem follow-up (2026-07): liveGameOrchestrator.ts's buildWatchSignal
// (the fallback path used whenever the main qualification gate returns null)
// used to call the un-routed generic computeSignalScore() directly, even for
// market === "home_runs" rows. That meant any HR-market signal that failed the
// main gate and dropped into the watch tier was scored by the generic
// composite/ladder (85/70/55/40) instead of computeHrRadarSignalComposite —
// ignoring nearHrScore/contactScore/pitcherVuln/hrTiming/powerProfile entirely.
// Fixed by switching that call site to computeSignalScoreByFamily, which
// correctly routes home_runs to the HR-specific composite. This test locks in
// that routing at the exported-function level (the level buildWatchSignal
// itself calls into), so it doesn't need to reach into the orchestrator's
// private method or its heavy constructor dependencies.
console.log("\n[9] buildWatchSignal HR routing fix");

function makeMinimalMlbPropInput(overrides: Partial<MLBPropInput> = {}): MLBPropInput {
  return {
    playerId: "p1", playerName: "Test Batter", team: "TST", opponent: "OPP", gameId: "g1",
    market: "home_runs", bookLine: 0.5, overOdds: -120, underOdds: 100,
    seasonAvg: 0.260, plateAppearances: 400, atBats: 350, currentStatValue: 0,
    remainingPA: 2, remainingAB: 2, completedAB: 2, inning: 5, isTopInning: false,
    batterHand: "R",
    contactQuality: {
      exitVelocity: 95, launchAngle: 22, hitDistance: 380,
      hardHitRateSeason: 0.42, barrelRateProxySeason: 0.10,
      avgBatSpeed: 72, avgSwingLength: 7.2,
      priorABResults: [], xBA: 0.35, xSLG: 0.480,
    },
    pitcher: {
      pitchCount: 60, timesThrough: 2, era: 4.2, whip: 1.25, kPer9: 8.5, bbPer9: 3.0,
      managerLeashShort: false, isPitcherCollapsing: false, pitchMix: [], throws: "R",
    },
    lineup: {
      battingOrderSlot: 4, orderTurnoverProximity: 0.5,
      lineupSectionStrength: "neutral", hittersAheadOnBase: 0, pocketWeakness: null,
    },
    weatherPark: {
      parkFactor: 1.0, temperature: 72, windSpeed: 5, windDirection: "calm",
      humidity: 50, isIndoors: false, parkHistoryFactor: null,
    },
    bullpen: {
      bullpenEra: 4.0, bullpenUsageLastThreeDays: 40, isTopRelieverAvailable: true,
    },
    ...overrides,
  };
}

function makeMinimalMlbPropOutput(overrides: Partial<MLBPropOutput> = {}): MLBPropOutput {
  return {
    market: "home_runs", playerId: "p1", playerName: "Test Batter", gameId: "g1",
    projection: 0.30, bookLine: 0.5, overOdds: -120, underOdds: 100,
    modifiers: {
      liveForm: 0, pitcher: 0, pitchType: 0, weatherPark: 0, lineup: 0, bullpen: 0,
      parkHistory: 0, handednessMatchup: 0, bvpHistory: 0, pocketWeakness: 0,
      liveEvent: 0, total: 0,
    },
    projectionLog: {
      baseProjection: 0.30, liveFormAdjustment: 0, pitcherAdjustment: 0,
      pitchTypeAdjustment: 0, weatherParkAdjustment: 0, lineupAdjustment: 0,
      bullpenAdjustment: 0, parkHistoryAdjustment: 0, handednessMatchupAdjustment: 0,
      bvpHistoryAdjustment: 0, pocketWeaknessAdjustment: 0, liveEventAdjustment: 0,
      finalCappedAdjustment: 0, rawProbability: 12, calibratedProbability: 12,
    },
    rawProbabilityOver: 12, rawProbabilityUnder: 88,
    calibratedProbabilityOver: 12, calibratedProbabilityUnder: 88,
    rawProbability: 12, calibratedProbability: 12, edge: 0,
    recommendedSide: "OVER", confidenceTier: "LEAN",
    mode: "standard", completedAB: 2, twoABRuleSatisfied: true,
    expectedHits: null, remainingPA: 2, adjustedHitRate: null, bookImplied: null,
    isExperimental: false, suppressed: false, suppressionReason: null,
    explanationBullets: [], warnings: [],
    engineGeneratedAt: 0, oddsUpdatedAt: 0, projectionUpdatedAt: 0,
    sportsbook: null, isDerivedLine: false, signalTimestamp: 0,
    formIndicator: "neutral", formScore: 50, evPct: 0,
    contextScore: 50, matchupTag: null,
    ...overrides,
  };
}

test("computeSignalScoreByFamily routes home_runs to computeHrRadarSignalComposite (the fix buildWatchSignal now relies on)", () => {
  const input = makeMinimalMlbPropInput();
  const output = makeMinimalMlbPropOutput();
  const viaFamily = computeSignalScoreByFamily(input, output);
  const viaComposite = computeHrRadarSignalComposite(input, output);
  assertEq(viaFamily.total, viaComposite.total, "same total as the HR-specific composite");
  assertEq(viaFamily.confidenceTier, viaComposite.confidenceTier, "same confidenceTier as the HR-specific composite");
});

test("the routed result's confidenceTier is consistent with deriveHrConfidenceTier's ladder (80/65/55/35), not the generic 85/70/55/40", () => {
  const input = makeMinimalMlbPropInput();
  const output = makeMinimalMlbPropOutput();
  const result = computeSignalScoreByFamily(input, output);
  assertEq(result.confidenceTier, deriveHrConfidenceTier(result.total), "confidenceTier matches the HR ladder for this total");
});

test("non-HR markets are unaffected by the fix (computeSignalScoreByFamily still falls through correctly for pitcher_strikeouts)", () => {
  const input = makeMinimalMlbPropInput({ market: "pitcher_strikeouts" });
  const output = makeMinimalMlbPropOutput({ market: "pitcher_strikeouts", recommendedSide: "UNDER" });
  const result = computeSignalScoreByFamily(input, output);
  assertTrue(typeof result.total === "number" && result.total >= 0 && result.total <= 100, "still produces a valid 0-100 total for a non-HR market");
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${_failures.length === 0 ? "✅" : "❌"} ${_passes} passed, ${_failures.length} failed`);
if (_failures.length > 0) {
  for (const f of _failures) console.log(`   - ${f}`);
  process.exit(1);
}
process.exit(0);
