// Mound Radar PR 2/5 — real CSV-parsing/projection path invariants.
// Exercises dataSources.ts's parseSavantCsvDocument/buildPitcherContactCsvSource
// directly on synthetic CSV text (no network) — proves column-absence
// detection and the header-index-alignment fix survive the real parsing
// path, not just the aggregator's own hand-built fixtures.
// Run: npx tsx server/mlb/pregame/mound/rawContactCsvProjection.test.ts

import { parseSavantCsvDocument, buildPitcherContactCsvSource } from "../../dataSources";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// ── A document missing one target column entirely → fieldsPresent marks it false ──
const missingColumnText =
  "game_pk,game_date,pitch_type,launch_speed,launch_speed_angle,estimated_woba_using_speedangle\n" +
  "123,2024-04-01,FF,101.2,6,0.500\n";
const missingColumnParsed = parseSavantCsvDocument(missingColumnText);
ok(missingColumnParsed !== null, "valid document with known headers parses");
const missingColumnSource = buildPitcherContactCsvSource(missingColumnParsed);
ok(missingColumnSource !== null, "buildPitcherContactCsvSource returns non-null for a valid parse");
ok(missingColumnSource!.fieldsPresent.bb_type === false, "bb_type absent from header → fieldsPresent false");
ok(missingColumnSource!.fieldsPresent.estimated_slg_using_speedangle === false, "estimated_slg_using_speedangle absent from header → fieldsPresent false");
ok(missingColumnSource!.fieldsPresent.launch_speed === true, "launch_speed present in header → fieldsPresent true");
ok(missingColumnSource!.fieldsPresent.launch_speed_angle === true, "launch_speed_angle present in header → fieldsPresent true");
ok(missingColumnSource!.fieldsPresent.estimated_woba_using_speedangle === true, "estimated_woba_using_speedangle present in header → fieldsPresent true");
ok(missingColumnSource!.rows[0].bb_type === undefined, "absent column is never assigned onto a row (undefined, not a blank string)");
ok(missingColumnSource!.rows[0].launch_speed === "101.2", "present column's value is preserved");

// ── Header-only document (real known headers, zero data lines) → { rows: [], fieldsPresent }, NOT null ──
const headerOnlyText =
  "game_pk,game_date,pitch_type,launch_speed,launch_speed_angle,estimated_slg_using_speedangle,estimated_woba_using_speedangle,bb_type\n";
const headerOnlyParsed = parseSavantCsvDocument(headerOnlyText);
ok(headerOnlyParsed !== null, "header-only document (real headers, zero data rows) is NOT null");
ok(headerOnlyParsed!.rows.length === 0, "header-only document has zero data rows");
const headerOnlySource = buildPitcherContactCsvSource(headerOnlyParsed);
ok(headerOnlySource !== null, "buildPitcherContactCsvSource is non-null for a header-only document");
ok(headerOnlySource!.rows.length === 0, "source rows stays empty");
ok(Object.values(headerOnlySource!.fieldsPresent).every(Boolean), "all 5 target fields marked present when the header lists them, even with zero data rows");

// ── Garbage/unrecognized content → null (not a false-positive parse) ──
ok(parseSavantCsvDocument("garbage\n") === null, "garbage single-line content → null");
ok(buildPitcherContactCsvSource(parseSavantCsvDocument("garbage\n")) === null, "buildPitcherContactCsvSource(null) → null");
ok(parseSavantCsvDocument("") === null, "empty content → null");
ok(parseSavantCsvDocument("foo,bar\n1,2\n") === null, "two plausible-looking but unrecognized headers → null (no known Savant core column present)");

// ── Index-alignment regression fixture (round 5 — the required test) ──
// A genuinely blank header cell before valid columns must not shift later
// column values onto the wrong header once blank cells are filtered for
// validation only.
const misalignedText = "game_pk,,pitch_type,launch_speed\n123,,FF,101.2\n";
const misalignedParsed = parseSavantCsvDocument(misalignedText);
ok(misalignedParsed !== null, "a document with one blank header cell (surrounded by known columns) still parses");
const misalignedRow = misalignedParsed!.rows[0];
ok(misalignedRow.pitch_type === "FF", `row.pitch_type lands on its correct original-position header, not shifted (got ${misalignedRow.pitch_type})`);
ok(misalignedRow.launch_speed === "101.2", `row.launch_speed lands on its correct original-position header, not shifted (got ${misalignedRow.launch_speed})`);
ok(misalignedParsed!.headers.length === 3, `returned headers list is blank-filtered for validation/display (got ${misalignedParsed!.headers.length}, expected 3)`);
ok(!misalignedParsed!.headers.includes(""), "returned headers list never includes a blank entry");

console.log(`\nrawContactCsvProjection.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
