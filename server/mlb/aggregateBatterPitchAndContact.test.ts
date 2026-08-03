// Production aggregator blank-cell regression (PR4.2 #1).
//
// Guards the defect where safeNum("") === 0 silently corrupted denominators in
// dataSources.ts::aggregateBatterPitchAndContact — the exact path that now feeds
// the family damage denominator (bbeSample). A blank xSLG must NOT be counted as
// 0, must NOT inflate the sample, and a blank/unrecognized bb_type must not be a
// BBE.
//
// Run: npx tsx server/mlb/aggregateBatterPitchAndContact.test.ts

import { aggregateBatterPitchAndContact } from "./dataSources";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

type Row = Record<string, string>;
const r = (o: Partial<Row>): Row => ({ ...o } as Row);

// Fastball rows: one BBE with a REAL xSLG, one BBE with a BLANK xSLG.
const rows: Row[] = [
  r({ pitch_type: "FF", description: "hit_into_play", bb_type: "fly_ball", estimated_slg_using_speedangle: "0.900" }),
  r({ pitch_type: "FF", description: "hit_into_play", bb_type: "line_drive", estimated_slg_using_speedangle: "   " }), // blank
  r({ pitch_type: "FF", description: "hit_into_play", bb_type: "", estimated_slg_using_speedangle: "0.500" }),          // blank bb_type → not a BBE
  r({ pitch_type: "FF", description: "hit_into_play", bb_type: "bunt_popup", estimated_slg_using_speedangle: "0.500" }),// unrecognized bb_type → not a BBE
];

const agg = aggregateBatterPitchAndContact(rows);
const ff = agg.batterPitchSplits?.find((s) => s.pitchType === "fastball");
ok(ff != null, "fastball split present");
// Only the ONE real-xSLG recognized BBE counts.
ok(ff!.bbeSample === 1, `bbeSample counts only real-xSLG recognized BBE (got ${ff?.bbeSample}, want 1)`);
ok(Math.abs((ff!.xSLG ?? -1) - 0.9) < 1e-9, `xSLG is 0.900, NOT diluted toward 0 by the blank cell (got ${ff?.xSLG})`);

// Blank launch_speed_angle must not be counted as classified BBE (toppedPct
// needs >=20 classified). 4 topped + 20 solid = 24 classified; 10 blank excluded.
// toppedPct = 4/24 = 16.7. If blanks were mis-counted (34), it'd be 11.8.
const lsaRows: Row[] = [
  ...Array.from({ length: 4 }, () => r({ pitch_type: "FF", description: "hit_into_play", bb_type: "ground_ball", launch_speed_angle: "2" })),
  ...Array.from({ length: 20 }, () => r({ pitch_type: "FF", description: "hit_into_play", bb_type: "fly_ball", launch_speed_angle: "5" })),
  ...Array.from({ length: 10 }, () => r({ pitch_type: "FF", description: "hit_into_play", bb_type: "line_drive", launch_speed_angle: "  " })),
];
const agg2 = aggregateBatterPitchAndContact(lsaRows);
ok(agg2.toppedPct != null && Math.abs(agg2.toppedPct - 16.7) < 0.2, `toppedPct = 16.7% (4 topped / 24 classified; 10 blank lsa excluded) — got ${agg2.toppedPct}`);

// Empty / malformed never throws.
{
  let threw = false;
  try { aggregateBatterPitchAndContact([r({}), r({ pitch_type: "FF", launch_speed: "abc" })]); } catch { threw = true; }
  ok(!threw, "malformed/empty rows never throw");
}

console.log(`\naggregateBatterPitchAndContact.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
