// Plate HR V2 snapshot contract — evidenceKind-specific point-in-time eligibility.
//
// Proves the §7.1 rules: a valid pregame weather forecast (issued before the
// prediction, valid for a future game time) is ELIGIBLE and is NOT failed by the
// historical-stat dataThroughAt guard; observed post-game weather and a stat
// whose cutoff is at/after the prediction are EXCLUDED; reconstructed records are
// excluded unless verified as-of retrieval; prediction eligibility requires
// as-of completeness (no missing/ineligible source) and predictionAsOf ≤ first pitch.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2Snapshots.test.ts

import {
  isSourceEvidenceEligible,
  isPredictionSnapshotEligible,
  predictionSnapshotCompositeKey,
  sourceEvidenceSnapshotSchema,
  predictionSnapshotSchema,
  type SourceEvidenceSnapshot,
} from "./plateHrV2Snapshots";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const FIRST_PITCH = "2026-07-01T23:05:00Z";
const PREDICTION = "2026-07-01T18:00:00Z"; // ~5h before first pitch

type EvArgs = Pick<SourceEvidenceSnapshot, "evidenceKind" | "dataThroughAt" | "availableAt" | "validForAt" | "reconstructed">;
const ev = (o: Partial<EvArgs> & Pick<EvArgs, "evidenceKind">): EvArgs => ({
  dataThroughAt: null, availableAt: "2026-07-01T12:00:00Z", validForAt: null, reconstructed: false, ...o,
});

// ── historical_stat ───────────────────────────────────────────────────────────
ok(
  isSourceEvidenceEligible(ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-06-30T23:59:00Z" }), PREDICTION, FIRST_PITCH).eligible,
  "historical stat covering only prior days is eligible",
);
ok(
  !isSourceEvidenceEligible(ev({ evidenceKind: "historical_stat", dataThroughAt: null }), PREDICTION, FIRST_PITCH).eligible,
  "historical stat without dataThroughAt is ineligible",
);
{
  // Cutoff at/after the prediction → leakage → excluded.
  const r = isSourceEvidenceEligible(ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-07-01T20:00:00Z" }), PREDICTION, FIRST_PITCH);
  ok(!r.eligible && r.reason === "data_not_strictly_before_prediction", "historical stat with cutoff after prediction is excluded (leakage)");
}

// ── weather_forecast: the key regression ──────────────────────────────────────
{
  // Issued before the prediction, valid for the FUTURE game time → eligible, and
  // must NOT be failed by any dataThroughAt guard.
  const r = isSourceEvidenceEligible(
    ev({ evidenceKind: "weather_forecast", availableAt: "2026-07-01T15:00:00Z", validForAt: FIRST_PITCH, dataThroughAt: null }),
    PREDICTION, FIRST_PITCH,
  );
  ok(r.eligible, "valid pregame forecast (issued-before, valid-for-future) is eligible");
}
{
  // Observed post-game weather: issued AFTER the prediction → excluded.
  const r = isSourceEvidenceEligible(
    ev({ evidenceKind: "weather_forecast", availableAt: "2026-07-02T02:00:00Z", validForAt: FIRST_PITCH }),
    PREDICTION, FIRST_PITCH,
  );
  ok(!r.eligible && r.reason === "available_after_prediction", "observed post-game weather (available after prediction) is excluded");
}

// ── lineup / probable ─────────────────────────────────────────────────────────
ok(isSourceEvidenceEligible(ev({ evidenceKind: "lineup" }), PREDICTION, FIRST_PITCH).eligible, "lineup available before prediction is eligible");
ok(
  !isSourceEvidenceEligible(ev({ evidenceKind: "probable", availableAt: "2026-07-01T20:00:00Z" }), PREDICTION, FIRST_PITCH).eligible,
  "probable available after prediction is ineligible",
);

// ── park ──────────────────────────────────────────────────────────────────────
ok(isSourceEvidenceEligible(ev({ evidenceKind: "park" }), PREDICTION, FIRST_PITCH).eligible, "park factor is eligible");

// ── reconstructed ─────────────────────────────────────────────────────────────
{
  const base = ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-06-30T23:59:00Z", reconstructed: true });
  ok(!isSourceEvidenceEligible(base, PREDICTION, FIRST_PITCH).eligible, "reconstructed without verified as-of is excluded");
  ok(isSourceEvidenceEligible(base, PREDICTION, FIRST_PITCH, { verifiedAsOfRetrieval: true }).eligible, "reconstructed WITH verified as-of is eligible");
}

// ── prediction after first pitch ──────────────────────────────────────────────
ok(
  !isSourceEvidenceEligible(ev({ evidenceKind: "lineup" }), "2026-07-01T23:30:00Z", FIRST_PITCH).eligible,
  "prediction after first pitch is ineligible (lineup)",
);

// ── prediction-level: as-of completeness ──────────────────────────────────────
{
  const sources = new Map<string, EvArgs>([
    ["s1", ev({ evidenceKind: "historical_stat", dataThroughAt: "2026-06-30T23:59:00Z" })],
    ["s2", ev({ evidenceKind: "weather_forecast", availableAt: "2026-07-01T15:00:00Z", validForAt: FIRST_PITCH })],
  ]);
  const good = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: ["s1", "s2"] }, sources,
  );
  ok(good.eligible, "prediction with all eligible resolvable sources is eligible");

  const missing = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: ["s1", "s3"] }, sources,
  );
  ok(!missing.eligible && missing.reasons.some((r) => r.startsWith("missing_source_evidence:s3")), "missing source evidence → ineligible (as-of completeness)");

  const empty = isPredictionSnapshotEligible(
    { predictionAsOf: PREDICTION, firstPitchTime: FIRST_PITCH, sourceSnapshotIds: [] }, sources,
  );
  ok(!empty.eligible && empty.reasons.includes("no_source_evidence"), "no source evidence → ineligible");
}

// ── composite key + schema round-trip ─────────────────────────────────────────
ok(
  predictionSnapshotCompositeKey({ gamePk: "g1", batterId: "b1", featureVersion: "v2", predictionAsOf: PREDICTION }) ===
    `g1|b1|v2|${PREDICTION}`,
  "composite key matches the DB unique index tuple",
);
ok(
  sourceEvidenceSnapshotSchema.safeParse({
    sourceSnapshotId: "s1", provider: "savant", entityId: "b1", entityType: "batter", evidenceKind: "historical_stat",
    dataThroughAt: "2026-06-30T23:59:00Z", availableAt: "2026-07-01T12:00:00Z", availabilitySource: "fetched_at",
    validForAt: null, reconstructed: false, fetchedAt: "2026-07-01T12:00:00Z", schemaVersion: "1", contentHash: "abc", payloadRef: null,
  }).success,
  "sourceEvidenceSnapshotSchema accepts a well-formed row",
);
ok(
  predictionSnapshotSchema.safeParse({
    predictionSnapshotId: "p1", gamePk: "g1", batterId: "b1", featureVersion: "v2", predictionAsOf: PREDICTION,
    firstPitchTime: FIRST_PITCH, sourceSnapshotIds: ["s1"], derivedFeatures: {}, contentHash: "xyz",
  }).success,
  "predictionSnapshotSchema accepts a well-formed row",
);

console.log(`\nplateHrV2Snapshots.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
