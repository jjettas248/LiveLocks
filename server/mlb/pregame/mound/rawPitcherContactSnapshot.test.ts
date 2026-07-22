// Mound Radar PR 2/5 — raw pitcher contact aggregation invariants.
// Denominator independence, sample floors, sampleSizes correctness (incl.
// when the metric itself is null), schema version, unit/precision, numeric
// safety, and the non-Statcast (hr9Allowed/bb9/ipVariance) availability
// branches.
// Run: npx tsx server/mlb/pregame/mound/rawPitcherContactSnapshot.test.ts

import {
  aggregateRawPitcherContactSnapshot,
  RAW_PITCHER_CONTACT_SNAPSHOT_SCHEMA_VERSION,
  type RawContactSupportingInputs,
  type RawPitcherContactSnapshot,
} from "./rawPitcherContactSnapshot";
import type { PitcherContactCsvSource, PitcherContactRow, PitcherContactField } from "../../dataSources";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const ALL_FIELDS_PRESENT: Record<PitcherContactField, boolean> = {
  bb_type: true,
  launch_speed: true,
  launch_speed_angle: true,
  estimated_slg_using_speedangle: true,
  estimated_woba_using_speedangle: true,
};

function source(
  rows: PitcherContactRow[],
  fieldsPresentOverrides: Partial<Record<PitcherContactField, boolean>> = {},
): PitcherContactCsvSource {
  return { rows, fieldsPresent: { ...ALL_FIELDS_PRESENT, ...fieldsPresentOverrides } };
}

function neutralInputs(overrides: Partial<RawContactSupportingInputs> = {}): RawContactSupportingInputs {
  return {
    seasonStatsAvailable: true,
    inningsPitchedSeason: 100,
    homeRunsAllowedSeason: 10,
    bb9Season: 3.2,
    recentStartsAvailable: true,
    ipVarianceLast3: 1.5,
    ...overrides,
  };
}

function assertNoNanOrInfinity(snap: RawPitcherContactSnapshot, label: string) {
  const numericFields: (keyof RawPitcherContactSnapshot)[] = [
    "hr9Allowed", "barrelAllowedPct", "hardHitAllowedPct", "flyBallAllowedPct",
    "xSLGAllowed", "xwOBAAllowed", "bb9", "ipVariance",
  ];
  for (const f of numericFields) {
    const v = snap[f] as number | null;
    ok(v === null || Number.isFinite(v), `${label}: ${f} is null or finite (got ${v})`);
  }
}

// ── Block A: full valid dataset — establishes "available" for all 5 Statcast metrics ──
const blockARows: PitcherContactRow[] = [];
for (let i = 0; i < 40; i++) {
  blockARows.push({
    launch_speed: i < 24 ? "100" : "80", // 24 hard-hit (>=95) / 16 not
    launch_speed_angle: i < 6 ? "6" : String(1 + (i % 5)), // exactly 6 barrels, rest 1-5 (never 6)
    bb_type: i < 10 ? "fly_ball" : i < 20 ? "line_drive" : i < 30 ? "ground_ball" : "popup", // 10 fly_ball of 40
    estimated_slg_using_speedangle: "0.500",
    estimated_woba_using_speedangle: "0.320",
  });
}
const blockA = aggregateRawPitcherContactSnapshot(source(blockARows), neutralInputs());
ok(blockA.schemaVersion === RAW_PITCHER_CONTACT_SNAPSHOT_SCHEMA_VERSION, "schemaVersion stamped correctly");
ok(blockA.availability.hardHitAllowedPct === "available", "hard-hit available at 40 eligible");
ok(blockA.hardHitAllowedPct === 60.0, `hard-hit pct = 60.0 (got ${blockA.hardHitAllowedPct})`);
ok(blockA.sampleSizes.hardHitEligibleBbe === 40, `hard-hit eligible = 40 (got ${blockA.sampleSizes.hardHitEligibleBbe})`);
ok(blockA.availability.barrelAllowedPct === "available", "barrel available at 40 eligible (>=30 floor)");
ok(blockA.barrelAllowedPct === 15.0, `barrel pct = 15.0 (got ${blockA.barrelAllowedPct})`);
ok(blockA.sampleSizes.barrelEligibleBbe === 40, `barrel eligible = 40 (got ${blockA.sampleSizes.barrelEligibleBbe})`);
ok(blockA.availability.flyBallAllowedPct === "available", "fly-ball available at 40 eligible");
ok(blockA.flyBallAllowedPct === 25.0, `fly-ball pct = 25.0 (got ${blockA.flyBallAllowedPct})`);
ok(blockA.sampleSizes.bbTypeEligibleBbe === 40, `bb_type eligible = 40 (got ${blockA.sampleSizes.bbTypeEligibleBbe})`);
ok(blockA.availability.xSLGAllowed === "available", "xSLG available at 40 eligible");
ok(blockA.xSLGAllowed === 0.5, `xSLG mean = 0.5 (got ${blockA.xSLGAllowed})`);
ok(blockA.sampleSizes.xSLGEligibleBbe === 40, `xSLG eligible = 40 (got ${blockA.sampleSizes.xSLGEligibleBbe})`);
ok(blockA.availability.xwOBAAllowed === "available", "xwOBA available at 40 eligible");
ok(blockA.xwOBAAllowed === 0.32, `xwOBA mean = 0.32 (got ${blockA.xwOBAAllowed})`);
ok(blockA.sampleSizes.xwOBAEligibleBbe === 40, `xwOBA eligible = 40 (got ${blockA.sampleSizes.xwOBAEligibleBbe})`);

// ── Block B: denominator independence — hard-hit does NOT require bb_type ──
const blockBRows: PitcherContactRow[] = [];
for (let i = 0; i < 25; i++) blockBRows.push({ launch_speed: i < 15 ? "100" : "80" }); // no bb_type key at all
const blockB = aggregateRawPitcherContactSnapshot(source(blockBRows, { bb_type: false }), neutralInputs());
ok(blockB.availability.hardHitAllowedPct === "available", "hard-hit available even though bb_type column absent");
ok(blockB.hardHitAllowedPct === 60.0, `hard-hit pct correct without bb_type (got ${blockB.hardHitAllowedPct})`);
ok(blockB.availability.flyBallAllowedPct === "source_field_missing", "fly-ball reports source_field_missing when bb_type column absent");
ok(blockB.flyBallAllowedPct === null, "fly-ball null when column absent");
ok(blockB.sampleSizes.bbTypeEligibleBbe === 0, "bb_type eligible count 0 when column absent");

// ── Block C: missing xSLG excluded ONLY from its own denominator ──
const blockCRows = blockARows.map((r, i) => (i < 10 ? { ...r, estimated_slg_using_speedangle: "" } : r));
const blockC = aggregateRawPitcherContactSnapshot(source(blockCRows), neutralInputs());
ok(blockC.sampleSizes.xSLGEligibleBbe === 30, `xSLG eligible reduced to 30 when 10 rows blank (got ${blockC.sampleSizes.xSLGEligibleBbe})`);
ok(blockC.sampleSizes.hardHitEligibleBbe === 40, "hard-hit denom unaffected by blank xSLG cells");
ok(blockC.sampleSizes.barrelEligibleBbe === 40, "barrel denom unaffected by blank xSLG cells");
ok(blockC.sampleSizes.bbTypeEligibleBbe === 40, "fly-ball denom unaffected by blank xSLG cells");
ok(blockC.sampleSizes.xwOBAEligibleBbe === 40, "xwOBA denom unaffected by blank xSLG cells");

// ── Missing fields never become zero: all-blank column (present but every cell blank) ──
const blankBarrelRows = blockARows.map((r) => ({ ...r, launch_speed_angle: "" }));
const blankBarrel = aggregateRawPitcherContactSnapshot(source(blankBarrelRows), neutralInputs());
ok(blankBarrel.sampleSizes.barrelEligibleBbe === 0, "all-blank launch_speed_angle cells → eligible count 0, never fabricated");
ok(blankBarrel.availability.barrelAllowedPct === "insufficient_sample", "0 eligible with column present → insufficient_sample, not source_unavailable");
ok(blankBarrel.barrelAllowedPct === null, "barrelAllowedPct null when 0 eligible, never 0");

// ── Sample-floor boundary tests (below/at/above) for each Statcast metric ──
function makeRowsForFloor(field: "hardHit" | "barrel" | "flyBall" | "xSLG" | "xwOBA", count: number): PitcherContactRow[] {
  const rows: PitcherContactRow[] = [];
  for (let i = 0; i < count; i++) {
    switch (field) {
      case "hardHit": rows.push({ launch_speed: "100" }); break;
      case "barrel": rows.push({ launch_speed_angle: "3" }); break;
      case "flyBall": rows.push({ bb_type: "ground_ball" }); break;
      case "xSLG": rows.push({ estimated_slg_using_speedangle: "0.400" }); break;
      case "xwOBA": rows.push({ estimated_woba_using_speedangle: "0.300" }); break;
    }
  }
  return rows;
}

function floorTest(
  field: "hardHit" | "barrel" | "flyBall" | "xSLG" | "xwOBA",
  floor: number,
  availKey: keyof RawPitcherContactSnapshot["availability"],
  valueKey: keyof RawPitcherContactSnapshot,
) {
  const below = aggregateRawPitcherContactSnapshot(source(makeRowsForFloor(field, floor - 1)), neutralInputs());
  ok(below.availability[availKey] === "insufficient_sample", `${field}: below floor (${floor - 1}) → insufficient_sample`);
  ok(below[valueKey] === null, `${field}: below floor → null value`);

  const at = aggregateRawPitcherContactSnapshot(source(makeRowsForFloor(field, floor)), neutralInputs());
  ok(at.availability[availKey] === "available", `${field}: at floor (${floor}) → available`);
  ok(at[valueKey] !== null, `${field}: at floor → non-null value`);

  const above = aggregateRawPitcherContactSnapshot(source(makeRowsForFloor(field, floor + 1)), neutralInputs());
  ok(above.availability[availKey] === "available", `${field}: above floor (${floor + 1}) → available`);
}

floorTest("hardHit", 20, "hardHitAllowedPct", "hardHitAllowedPct");
floorTest("barrel", 30, "barrelAllowedPct", "barrelAllowedPct");
floorTest("flyBall", 20, "flyBallAllowedPct", "flyBallAllowedPct");
floorTest("xSLG", 20, "xSLGAllowed", "xSLGAllowed");
floorTest("xwOBA", 20, "xwOBAAllowed", "xwOBAAllowed");

// sampleSizes still reports the true eligible count even when the metric itself is null
const belowFloorSnap = aggregateRawPitcherContactSnapshot(source(makeRowsForFloor("barrel", 10)), neutralInputs());
ok(belowFloorSnap.barrelAllowedPct === null, "below-floor barrel metric is null");
ok(
  belowFloorSnap.sampleSizes.barrelEligibleBbe === 10,
  `sampleSizes still reports the true eligible count (10) even though the metric is null (got ${belowFloorSnap.sampleSizes.barrelEligibleBbe})`,
);

// ── Numeric safety ──
const malformedRows: PitcherContactRow[] = [
  {
    launch_speed: "abc",
    bb_type: "not_a_real_type",
    launch_speed_angle: "xyz",
    estimated_slg_using_speedangle: "nan",
    estimated_woba_using_speedangle: "-1",
  },
];
const malformed = aggregateRawPitcherContactSnapshot(source(malformedRows), neutralInputs());
ok(malformed.sampleSizes.hardHitEligibleBbe === 0, "malformed launch_speed excluded from hard-hit denom");
ok(malformed.sampleSizes.barrelEligibleBbe === 0, "malformed launch_speed_angle excluded from barrel denom");
ok(malformed.sampleSizes.bbTypeEligibleBbe === 0, "unrecognized bb_type excluded from fly-ball denom");
ok(malformed.sampleSizes.xSLGEligibleBbe === 0, "non-numeric xSLG excluded");
ok(malformed.sampleSizes.xwOBAEligibleBbe === 0, "out-of-range (-1) xwOBA excluded");
assertNoNanOrInfinity(malformed, "malformed rows");

// Empty rows array (header present, zero data rows) → insufficient_sample, NOT source_unavailable
const emptyRowsSnap = aggregateRawPitcherContactSnapshot(source([]), neutralInputs());
ok(emptyRowsSnap.availability.hardHitAllowedPct === "insufficient_sample", "empty rows (header present) → insufficient_sample not source_unavailable");
ok(emptyRowsSnap.hardHitAllowedPct === null, "empty rows → null value, never neutral/fabricated");
assertNoNanOrInfinity(emptyRowsSnap, "empty rows");

// source === null → source_unavailable for the 5 Statcast fields; hr9/bb9/ipVariance still compute
const nullSourceSnap = aggregateRawPitcherContactSnapshot(null, neutralInputs());
ok(nullSourceSnap.availability.hardHitAllowedPct === "source_unavailable", "null source → hard-hit source_unavailable");
ok(nullSourceSnap.availability.barrelAllowedPct === "source_unavailable", "null source → barrel source_unavailable");
ok(nullSourceSnap.availability.flyBallAllowedPct === "source_unavailable", "null source → fly-ball source_unavailable");
ok(nullSourceSnap.availability.xSLGAllowed === "source_unavailable", "null source → xSLG source_unavailable");
ok(nullSourceSnap.availability.xwOBAAllowed === "source_unavailable", "null source → xwOBA source_unavailable");
ok(nullSourceSnap.availability.hr9Allowed === "available", "hr9Allowed still computed independently when Savant unavailable");
ok(nullSourceSnap.hr9Allowed !== null, "hr9Allowed has a real value despite null Savant source");
ok(nullSourceSnap.availability.bb9 === "available", "bb9 still computed independently when Savant unavailable");
ok(nullSourceSnap.availability.ipVariance === "available", "ipVariance still computed independently when Savant unavailable");
assertNoNanOrInfinity(nullSourceSnap, "null source");

// ── Precision: percentages round to 1 decimal ──
const precRows: PitcherContactRow[] = [];
for (let i = 0; i < 23; i++) precRows.push({ launch_speed: i < 17 ? "100" : "80" }); // 17/23 = 73.913...%
const precSnap = aggregateRawPitcherContactSnapshot(source(precRows), neutralInputs());
ok(precSnap.hardHitAllowedPct === 73.9, `hard-hit pct rounds to 1 decimal (got ${precSnap.hardHitAllowedPct}, expected 73.9)`);

// Precision: xSLG/xwOBA round to 3 decimals
const xslgRows: PitcherContactRow[] = [];
for (let i = 0; i < 21; i++) xslgRows.push({ estimated_slg_using_speedangle: i < 7 ? "1.0" : "0.0" }); // 7/21 = 0.33333...
const xslgSnap = aggregateRawPitcherContactSnapshot(source(xslgRows), neutralInputs());
ok(xslgSnap.xSLGAllowed === 0.333, `xSLG rounds to 3 decimals (got ${xslgSnap.xSLGAllowed}, expected 0.333)`);

const xwobaRows: PitcherContactRow[] = [];
for (let i = 0; i < 21; i++) xwobaRows.push({ estimated_woba_using_speedangle: i < 5 ? "1.0" : "0.0" }); // 5/21 = 0.238095...
const xwobaSnap = aggregateRawPitcherContactSnapshot(source(xwobaRows), neutralInputs());
ok(xwobaSnap.xwOBAAllowed === 0.238, `xwOBA rounds to 3 decimals (got ${xwobaSnap.xwOBAAllowed}, expected 0.238)`);

// Precision: hr9Allowed/bb9 round to 2 decimals; ipVariance passes through UNCHANGED
const precisionInputs = neutralInputs({ inningsPitchedSeason: 63.33, homeRunsAllowedSeason: 17, bb9Season: 3.456, ipVarianceLast3: 1.234567 });
const precisionSnap = aggregateRawPitcherContactSnapshot(null, precisionInputs);
ok(precisionSnap.hr9Allowed === 2.42, `hr9Allowed rounds to 2 decimals (got ${precisionSnap.hr9Allowed}, expected 2.42)`);
ok(precisionSnap.bb9 === 3.46, `bb9 rounds to 2 decimals (got ${precisionSnap.bb9}, expected 3.46)`);
ok(precisionSnap.ipVariance === 1.234567, `ipVariance passthrough preserves exact precision, no re-rounding (got ${precisionSnap.ipVariance})`);

// ── Non-Statcast availability branches ──
function nonStatcastCase(overrides: Partial<RawContactSupportingInputs>): RawPitcherContactSnapshot {
  return aggregateRawPitcherContactSnapshot(source(makeRowsForFloor("hardHit", 25)), { ...neutralInputs(), ...overrides });
}

ok(nonStatcastCase({ seasonStatsAvailable: false }).availability.hr9Allowed === "source_unavailable", "hr9Allowed: seasonStatsAvailable=false → source_unavailable");
ok(nonStatcastCase({ inningsPitchedSeason: null }).availability.hr9Allowed === "source_field_missing", "hr9Allowed: inningsPitchedSeason null → source_field_missing");
ok(nonStatcastCase({ homeRunsAllowedSeason: null }).availability.hr9Allowed === "source_field_missing", "hr9Allowed: homeRunsAllowedSeason null → source_field_missing");
ok(nonStatcastCase({ inningsPitchedSeason: 9 }).availability.hr9Allowed === "insufficient_sample", "hr9Allowed: IP=9 → insufficient_sample");
ok(nonStatcastCase({ inningsPitchedSeason: 10 }).availability.hr9Allowed === "available", "hr9Allowed: IP=10 → available");

ok(nonStatcastCase({ seasonStatsAvailable: false }).availability.bb9 === "source_unavailable", "bb9: seasonStatsAvailable=false → source_unavailable");
ok(nonStatcastCase({ inningsPitchedSeason: null }).availability.bb9 === "source_field_missing", "bb9: inningsPitchedSeason null → source_field_missing");
ok(nonStatcastCase({ bb9Season: null }).availability.bb9 === "source_field_missing", "bb9: bb9Season null → source_field_missing");
ok(nonStatcastCase({ inningsPitchedSeason: 9 }).availability.bb9 === "insufficient_sample", "bb9: IP=9 → insufficient_sample");
ok(nonStatcastCase({ inningsPitchedSeason: 10 }).availability.bb9 === "available", "bb9: IP=10 → available");

ok(nonStatcastCase({ recentStartsAvailable: false }).availability.ipVariance === "source_unavailable", "ipVariance: recentStartsAvailable=false → source_unavailable");
ok(nonStatcastCase({ ipVarianceLast3: null }).availability.ipVariance === "insufficient_sample", "ipVariance: null → insufficient_sample");
ok(nonStatcastCase({ ipVarianceLast3: -1 }).availability.ipVariance === "insufficient_sample", "ipVariance: negative → insufficient_sample");
ok(nonStatcastCase({ ipVarianceLast3: Number.NaN }).availability.ipVariance === "insufficient_sample", "ipVariance: NaN → insufficient_sample");
ok(nonStatcastCase({ ipVarianceLast3: 2.5 }).availability.ipVariance === "available", "ipVariance: finite non-negative → available");

// Invalid-but-present season inputs normalize to null → source_field_missing (never source_unavailable, source IS present)
ok(nonStatcastCase({ inningsPitchedSeason: -5 }).availability.hr9Allowed === "source_field_missing", "negative inningsPitchedSeason normalizes to null → source_field_missing");
ok(nonStatcastCase({ homeRunsAllowedSeason: -3 }).availability.hr9Allowed === "source_field_missing", "negative homeRunsAllowedSeason normalizes to null → source_field_missing");
ok(nonStatcastCase({ inningsPitchedSeason: Number.NaN }).availability.hr9Allowed === "source_field_missing", "non-finite inningsPitchedSeason normalizes to null → source_field_missing");
ok(nonStatcastCase({ bb9Season: -1 }).availability.bb9 === "source_field_missing", "negative bb9Season normalizes to null → source_field_missing");

const ipBelowFloor = nonStatcastCase({ inningsPitchedSeason: 9 });
ok(ipBelowFloor.hr9Allowed === null, "hr9Allowed null when IP below floor");
ok(
  ipBelowFloor.sampleSizes.inningsPitched === 9,
  `sampleSizes.inningsPitched still reports the true value (9) even though hr9Allowed is null (got ${ipBelowFloor.sampleSizes.inningsPitched})`,
);

console.log(`\nrawPitcherContactSnapshot.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
