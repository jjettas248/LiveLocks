// Pregame composition layer — route-orchestration invariants.
//
// Run: npx tsx server/mlb/pregame/composition/composeMoundResponse.test.ts

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MoundSignal, MoundDriver } from "../mound/types";
import type { PlateCompositionContext } from "./loadPregameCompositionContext";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function moundSignal(overrides: Partial<MoundSignal> & { drivers: MoundDriver[] }): MoundSignal {
  const base: MoundSignal = {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "2026-07-01T00:00:00Z", buildId: "b1",
    pitcherId: "p1", pitcherName: "Test Pitcher", team: "NYY", opponent: "BOS", throws: "R",
    opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts"],
    marketScores: { pitcher_strikeouts: 7 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [],
    lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: null,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 6,
      recentFormScore: 6, marketFitScore: 6, contactRiskScore: 7, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [],
      dataCoverageScore: 0.9, finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    } as any,
  };
  return { ...base, ...overrides } as MoundSignal;
}

const CR_HIGH: MoundDriver = { key: "cr_high", label: "Hit/HR Susceptible: High", direction: "negative" };

const counters = {
  gamesScanned: 1, pitchersEvaluated: 1, starterCoverage: 1, weatherCoverage: 1,
  pitcherCoverage: 1, lineupCoverage: 1,
};

/** Captures console.log/console.warn calls during `fn`, restoring afterward. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; warns: string[] }> {
  const logs: string[] = [];
  const warns: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, logs, warns };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = "postgres://fixture:fixture@240.0.0.1:1/fixture";
  }
  const { composeMoundResponseWithPlateTargets } = await import("./composeMoundResponse");

  const disabledResult = { signals: [], state: "disabled" as const, generatedAt: null, buildId: null };
  const availableResult = (): PlateCompositionContext => ({ signals: [], state: "available", generatedAt: "2026-07-01T00:00:00Z", buildId: "ppr_1" });
  const loadErrorLoader = async (): Promise<PlateCompositionContext> => { throw new Error("simulated Plate load failure"); };

  // ── 1. Disabled flag → the response's plateTargetSuggestions stay empty ───
  {
    const original = process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    delete process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    const { result, logs } = await captureConsole(() =>
      composeMoundResponseWithPlateTargets(
        "/api/mlb/mound-power-radar", "2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory",
        [moundSignal({ drivers: [CR_HIGH] })], counters, true, false,
      ),
    );
    ok(result.signals[0].plateTargetSuggestions.length === 0, "flag disabled → plateTargetSuggestions stays []");
    ok(logs.some((l) => l.includes('"plateSnapshotState":"disabled"')), "telemetry reports plateSnapshotState=disabled, distinguishable from a genuinely missing snapshot");
    ok(logs.some((l) => l.includes('"enabled":false')), "telemetry reports enabled=false");
    if (original === undefined) delete process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    else process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = original;
  }

  // ── 2. Enabled + matching snapshot → available state end-to-end ───────────
  {
    const original = process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = "true";
    const { result, logs } = await captureConsole(() =>
      composeMoundResponseWithPlateTargets(
        "/api/mlb/mound-power-radar", "2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory",
        [moundSignal({ drivers: [CR_HIGH] })], counters, true, false,
        async (date) => availableResult(),
      ),
    );
    ok(logs.some((l) => l.includes('"plateSnapshotState":"available"') && l.includes('"plateBuildId":"ppr_1"')), "telemetry reports available state with the real plateBuildId");
    ok(result.date === "2026-07-01" && result.buildId === "b1", "response envelope fields pass through");
    if (original === undefined) delete process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    else process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = original;
  }

  // ── 6. A Plate loader failure → enriched Mound response with empty arrays, never throws ──
  {
    const original = process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = "true";
    const s = moundSignal({ drivers: [CR_HIGH], score10: 9.0, tier: "elite", moundDirection: "follow" });
    const { result, logs, warns } = await captureConsole(() =>
      composeMoundResponseWithPlateTargets(
        "/api/mlb/mound-power-radar", "2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory",
        [s], counters, true, false, loadErrorLoader,
      ),
    );
    ok(result.signals.length === 1, "a Plate loader failure still returns the Mound signal");
    ok(result.signals[0].plateTargetSuggestions.length === 0, "a Plate loader failure degrades to empty suggestions, not a thrown error");
    // ── 7. Canonical Mound fields remain unchanged despite the Plate failure ──
    ok(result.signals[0].score10 === 9.0 && result.signals[0].tier === "elite" && result.signals[0].moundDirection === "follow", "canonical Mound fields (score10/tier/moundDirection) are untouched by the Plate failure path");
    ok(warns.some((w) => w.includes("[MOUND_PLATE_COMPOSITION_FAILED]")), "a distinct warn signal fires for the genuine composition exception");
    // ── 10. Exactly one bounded [MOUND_PLATE_COMPOSITION] record, even on failure ──
    const compositionLogs = logs.filter((l) => l.includes("[MOUND_PLATE_COMPOSITION]") && !l.includes("_FAILED"));
    ok(compositionLogs.length === 1, `exactly one [MOUND_PLATE_COMPOSITION] telemetry record emitted, even on a Plate failure (got ${compositionLogs.length})`);
    if (original === undefined) delete process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED;
    else process.env.MOUND_PLATE_TARGET_SUGGESTIONS_ENABLED = original;
  }

  // ── 9. A genuine Mound exception is NOT caught/mislabeled as a Plate failure ──
  {
    let threw = false;
    try {
      // signals: null forces buildMoundResponse's own `.filter` call to throw
      // — a genuine Mound-engine-layer failure, unrelated to Plate composition.
      await composeMoundResponseWithPlateTargets(
        "/api/mlb/mound-power-radar", "2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory",
        null as any, counters, true, false,
      );
    } catch {
      threw = true;
    }
    ok(threw, "a genuine buildMoundResponse exception propagates out of composeMoundResponseWithPlateTargets rather than being caught and degraded to an empty-suggestions fallback");
  }

  // ── 10 (success path). Exactly one telemetry record on the happy path ─────
  {
    const { logs } = await captureConsole(() =>
      composeMoundResponseWithPlateTargets(
        "/api/mlb/mound-power-radar", "2026-07-01", "b1", "2026-07-01T00:00:00Z", "memory",
        [moundSignal({ drivers: [CR_HIGH] })], counters, true, false,
      ),
    );
    const compositionLogs = logs.filter((l) => l.includes("[MOUND_PLATE_COMPOSITION]"));
    ok(compositionLogs.length === 1, `exactly one [MOUND_PLATE_COMPOSITION] telemetry record on the ordinary success path (got ${compositionLogs.length})`);
  }

  // ── 8. Structural proof: buildMoundResponse is called exactly once ────────
  {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(dir, "composeMoundResponse.ts"), "utf-8");
    // Strip full-line `//` comments (the file's own doc comment references
    // "buildMoundResponse()" in prose) so this counts real call sites only.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const callSites = (codeOnly.match(/buildMoundResponse\(/g) ?? []).length;
    ok(callSites === 1, `buildMoundResponse( appears exactly once as an actual call site in composeMoundResponse.ts, outside comments (got ${callSites}) — no duplicate call in the catch branch`);
    const beforeTry = codeOnly.indexOf("buildMoundResponse(") < codeOnly.indexOf("try {");
    ok(beforeTry, "the single buildMoundResponse( call site appears BEFORE the try block — a Mound-engine exception is never caught here");
  }

  console.log(`\ncomposeMoundResponse.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
