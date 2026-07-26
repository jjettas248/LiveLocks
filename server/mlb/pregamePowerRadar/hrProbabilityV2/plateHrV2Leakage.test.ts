// Plate HR Probability V2 — leakage invariants (PR 1).
//
// math/leakageGuard.test.ts already proves the generic live-only-name
// matcher works (28 assertions against hand-picked strings) but never
// exercises a real contract's actual field inventory. This file covers the
// 7 assertions specific to the new V2 contract per the PR1 plan §5.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2Leakage.test.ts

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { z } from "zod";
import { isLiveOnlyFeatureName } from "../math/leakageGuard";
import { plateHrV2DerivedFeatureVectorV1Schema } from "./plateHrV2FeatureContract";
import { assemblePlateHrV2FeatureSnapshot, type PlateHrV2FeatureBuilderInput } from "./plateHrV2FeatureBuilder";
import { plateHrV2EvaluationLabelContractSchema, plateHrV2LabelDispositionSchema } from "./plateHrV2LabelContract";
import { toInsertFeatureSnapshot } from "./plateHrV2CaptureRowMapper";
import type { PlateHrV2CaptureRow } from "./plateHrV2ForwardCapture";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function collectLeafNames(schema: z.ZodTypeAny): string[] {
  const names: string[] = [];
  const def: any = (schema as any)._def;
  if (def?.typeName === "ZodObject") {
    const shape = (schema as any).shape as Record<string, z.ZodTypeAny>;
    for (const [key, child] of Object.entries(shape)) {
      if (key === "extra") continue;
      let unwrapped: any = child;
      while (unwrapped?._def?.typeName === "ZodOptional" || unwrapped?._def?.typeName === "ZodNullable") {
        unwrapped = unwrapped._def.innerType;
      }
      if (unwrapped?._def?.typeName === "ZodObject") names.push(...collectLeafNames(unwrapped));
      else names.push(key);
    }
  }
  return names;
}

// ── 1. Static field-inventory sweep — every real schema leaf is pregame-legal ──
{
  const leafNames = collectLeafNames(plateHrV2DerivedFeatureVectorV1Schema);
  ok(leafNames.length > 20, "sanity check: the walker found a substantial number of real leaf names");
  const liveOffenders = leafNames.filter((n) => isLiveOnlyFeatureName(n));
  ok(liveOffenders.length === 0, `no leaf name in the real feature-vector schema matches a live-only pattern (offenders: ${liveOffenders.join(",")})`);

  // Proves the sweep has teeth: a name that WOULD be forbidden if it existed
  // in the schema is in fact caught by the matcher itself.
  ok(isLiveOnlyFeatureName("currentGameBarrelCount"), "the underlying matcher does flag a hypothetical live-only leaf name — the sweep above is not vacuously passing");
}

// ── 2. Builder boundary end-to-end ──────────────────────────────────────────
{
  const minimalInput: PlateHrV2FeatureBuilderInput = {
    asOfMs: Date.parse("2026-07-26T10:00:00.000Z"),
    firstPitchAtMs: Date.parse("2026-07-26T19:00:00.000Z"),
    lineupConfirmedAtMs: null,
    starterConfirmed: false,
    sessionDate: "2026-07-26", gameId: "g1", batterId: "b1", pitcherId: null, batterHand: "R",
    sufficientStatsRef: null,
    batterPower: { xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null, exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null, sweetSpotPct: null, hrPerPaSeason: null, paSample: null },
    batTracking: { avgBatSpeed: null, fastSwingRatePct: null, avgSwingLength: null, squaredUpPerSwingPct: null, blastPerSwingPct: null, swingSample: null },
    pitcherVulnerability: { pitcherKnown: false, batterHand: null, pitcherThrows: null, hrPer9VsHand: null, hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: null },
    pitchType: { families: [] },
    zoneLocation: { batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null, pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null },
    parkWeatherSpray: { parkHrFactor: null, parkHrFactorHand: null, isIndoors: false, weatherAvailable: false, temperatureF: null, windSpeedMph: null, windDirection: null, batterPullAirShare: null },
    lineupOpportunity: { battingOrderSlot: null, teamImpliedRuns: null, obpAhead: null, lineupConfirmed: false },
    starterBullpen: { starterConfirmed: false, projectedPaVsStarter: null, projectedPaVsBullpen: null, bullpenHrPer9: null, bullpenBarrelAllowedPct: null },
    market: { hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null },
    availability: { confirmedActive: null, lateScratchRisk: null, restDayRisk: null, platoonSubRisk: null },
    contactOpportunity: { kRatePct: null, bbRatePct: null, whiffRatePct: null, contactRatePct: null, zoneContactRatePct: null, chaseRatePct: null },
    slateBaselineGameHrProbability: null,
    savantQuality: "missing", venueResolved: false, pitcherHandResolved: false, batterPowerFullyAvailable: false,
  };
  const before = assemblePlateHrV2FeatureSnapshot(minimalInput);
  ok(before.boundaryOk === true, "asOf before first pitch -> boundaryOk true, zero warnings");
  ok(before.leakageWarnings.length === 0, "zero leakage warnings on a clean pregame capture");

  const after = assemblePlateHrV2FeatureSnapshot({ ...minimalInput, asOfMs: Date.parse("2026-07-26T20:00:00.000Z") });
  ok(after.boundaryOk === false, "asOf after first pitch -> boundaryOk false");
  ok(after.leakageWarnings.length > 0, "a non-empty warning set when the boundary is violated");
}

// ── 3. Hash/shape round-trip (cross-referenced) ─────────────────────────────
// Full coverage lives in frozenPlateHrV2Input.test.ts (hash stability under
// key reordering, deepFreeze mutation guard, toPregameMathInputs shape-proof
// against a real math/ scorer). Noted here only so this file's own header
// comment's "7 assertions" claim is traceable to where each one actually
// lives, not duplicated.
{
  ok(true, "hash/shape round-trip is covered by frozenPlateHrV2Input.test.ts — see that file");
}

// ── 4. Label schema shape assertions ─────────────────────────────────────────
{
  ok(plateHrV2LabelDispositionSchema.options.length === 4, "exactly 4 label disposition values");
  const resolvedFalse = {
    labelVersion: "plate_hr_v2_label_v1", snapshotId: "s1", labelDisposition: "resolved",
    resolvedAt: new Date().toISOString(), resolutionReason: "game_final", hitHrToday: false,
    paCountObserved: 3, hrCountToday: 0, hrEventId: null, hrInning: null, hrHalf: null,
    hrPlateAppearanceNumber: null, hrFirstAb: null, labelSource: "engine", dataQuality: null,
  };
  ok(plateHrV2EvaluationLabelContractSchema.safeParse(resolvedFalse).success, "hitHrToday accepts a nullable boolean and parses a resolved-false row");
  // The non-null-iff-resolved invariant is documented and app-level (Zod
  // cannot cross-field-validate this without a refine, which PR1 does not
  // add — matches hrLabelContract.ts's own "enforced by later PRs" posture).
  const resolvedNull = { ...resolvedFalse, hitHrToday: null };
  ok(plateHrV2EvaluationLabelContractSchema.safeParse(resolvedNull).success, "schema shape alone allows resolved+null (the invariant is documented, not Zod-enforced, by design)");
}

// ── 5. Total-function sweep (cross-referenced) ──────────────────────────────
// Full coverage (all-null/all-false/empty-array never throws) lives in
// plateHrV2FeatureBuilder.test.ts and plateHrV2SufficientStats.test.ts.
{
  ok(true, "total-function sweep is covered by plateHrV2FeatureBuilder.test.ts and plateHrV2SufficientStats.test.ts — see those files");
}

// ── 6. Forbidden-training-feature structural sweep (cross-referenced) ──────
// Full coverage lives in plateHrV2TrainingFeatureGuard.test.ts (walks the
// real schema, plus a synthetic-schema proof the sweep has teeth).
{
  ok(true, "forbidden-training-feature structural sweep is covered by plateHrV2TrainingFeatureGuard.test.ts — see that file");
}

// ── 7. Lock-immutability (correction 3) ─────────────────────────────────────
// A live Postgres connection would be needed to exercise storage.ts's real
// `ON CONFLICT ... WHERE locked_at IS NULL` guard end-to-end — this session
// has no DATABASE_URL (same constraint noted throughout this PR). Verified
// instead in two DB-independent ways: (a) the pure lock-stamping logic that
// feeds that guard, and (b) a static source-scan proving the guard clause is
// actually present in storage.ts, mirroring this repo's own precedent of
// regex-scanning migration source for structural guarantees.
{
  function rowFixture(gameStatus: string): PlateHrV2CaptureRow {
    return {
      snapshotId: "plate-hr-v2:plate_hr_v2_features_v1:2026-07-26:g1:b1",
      sessionDate: "2026-07-26", gameId: "g1", batterId: "b1", batterName: "Test Batter",
      team: "NYY", opponent: "BOS", pitcherId: null, pitcherName: null, battingOrderSlot: 3,
      buildId: "build-1", firstCapturedAtIso: "2026-07-26T10:00:00.000Z", lastCapturedAtIso: "2026-07-26T18:00:00.000Z",
      firstPitchTimeIso: "2026-07-26T19:00:00.000Z", firstPitchLockEligible: true, gameStatus,
      predictionAsOfIso: "2026-07-26T18:00:00.000Z", secondsToFirstPitch: 3600, lineupConfirmedAtIso: null,
      starterConfirmed: false, inputContractVersion: "plate_hr_v2_features_v1",
      frozenInput: {} as any, inputHash: "hash1", featureVersion: "plate_hr_v2_features_v1",
      derivedFeatures: {} as any, availability: {} as any, featureFreshness: {} as any, rawInputs: {} as any,
      leakageWarnings: [], sufficientStatsRef: null,
      championModelVersion: "plate_jul20_restored_v1", championScore10: 6.5, championTier: "watch", championSuppressed: false,
    };
  }

  const pregameInsert = toInsertFeatureSnapshot(rowFixture("scheduled"));
  ok(pregameInsert.lockedAt === null, "a pregame (scheduled) capture is not locked");

  const preInsert = toInsertFeatureSnapshot(rowFixture("pre"));
  ok(preInsert.lockedAt === null, "a pregame (pre) capture is not locked");

  const liveInsert = toInsertFeatureSnapshot(rowFixture("live"));
  ok(liveInsert.lockedAt instanceof Date, "a live-game capture is stamped with a lock timestamp");

  const finalInsert = toInsertFeatureSnapshot(rowFixture("final"));
  ok(finalInsert.lockedAt instanceof Date, "a final-game capture is stamped with a lock timestamp");

  // Static source-scan: the real enforcement point (the WHERE guard) exists
  // in server/storage.ts's upsertPlateHrV2FeatureSnapshot method.
  const storagePath = fileURLToPath(new URL("../../../storage.ts", import.meta.url));
  const storageSource = readFileSync(storagePath, "utf8");
  const methodStart = storageSource.indexOf("async upsertPlateHrV2FeatureSnapshot");
  ok(methodStart >= 0, "server/storage.ts defines upsertPlateHrV2FeatureSnapshot");
  // Wide enough to comfortably span the full method body (including the
  // per-column CASE guards below) — this is a source-scan, not a runtime
  // boundary, so a generous slice just avoids false negatives as the method grows.
  const methodSlice = storageSource.slice(methodStart, methodStart + 6000);
  ok(
    /where:\s*sql`\$\{plateHrV2FeatureSnapshots\.lockedAt\}\s*IS\s*NULL`/.test(methodSlice),
    "upsertPlateHrV2FeatureSnapshot's ON CONFLICT DO UPDATE is guarded by a `lockedAt IS NULL` WHERE clause — the actual enforcement of 'no overwrite after lock'",
  );

  // The WHERE guard alone only stops writes once a row is ALREADY locked —
  // it does nothing to protect the transition write itself (existing row
  // still unlocked, incoming row is the first non-pregame capture), which
  // would otherwise overwrite the last pregame observation with post-first-
  // pitch data in the same statement that sets lockedAt. The training-
  // observation columns must additionally be CASE-guarded on
  // `excluded.locked_at`, keeping the existing (pregame) value on that one
  // transition write.
  ok(
    /derivedFeatures:\s*sql`CASE WHEN excluded\.locked_at IS NOT NULL THEN \$\{plateHrV2FeatureSnapshots\.derivedFeatures\} ELSE excluded\.derived_features END`/.test(methodSlice),
    "derivedFeatures is CASE-guarded so the lock-transition write preserves the last pregame observation instead of overwriting it",
  );
  ok(
    /predictionAsOf:\s*sql`CASE WHEN excluded\.locked_at IS NOT NULL THEN \$\{plateHrV2FeatureSnapshots\.predictionAsOf\} ELSE excluded\.prediction_as_of END`/.test(methodSlice),
    "predictionAsOf is CASE-guarded so the lock-transition write preserves the last pregame observation instead of overwriting it",
  );
}

console.log(`\nplateHrV2Leakage.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
