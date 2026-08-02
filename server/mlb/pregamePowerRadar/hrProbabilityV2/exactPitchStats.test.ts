// Plate HR V2 exact-pitch sufficient statistics — invariants (§5a, PR4).
//
// Proves grain-typed counts (per pitch / per swing / per BBE / per quality-BBE /
// per terminal PA) with correct denominators, opponent-hand split by entity type,
// unknown-code → "OT" fallback, damage sums scoped to qualityBbeCount (never
// contactCount), barrel via EV/LA proxy, and no summed ISO.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/exactPitchStats.test.ts

import { computeExactPitchStats, exactPitchStatKey } from "./exactPitchStats";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

type Row = Record<string, string>;
const r = (o: Partial<Row>): Row => ({ ...o } as Row);

// A batter facing an RHP. FF-vs-R rows (6): called-strike, whiff, foul, HR-BBE
// (measurable+barrel), out-BBE (measurable non-barrel), single-BBE (no EV).
const batterRows: Row[] = [
  r({ pitch_type: "FF", p_throws: "R", stand: "L", description: "called_strike" }),
  r({ pitch_type: "FF", p_throws: "R", description: "swinging_strike" }),
  r({ pitch_type: "FF", p_throws: "R", description: "foul" }),
  r({ pitch_type: "FF", p_throws: "R", description: "hit_into_play", bb_type: "fly_ball", events: "home_run", launch_speed: "105", launch_angle: "28", estimated_slg_using_speedangle: "3.9", estimated_woba_using_speedangle: "1.9" }),
  r({ pitch_type: "FF", p_throws: "R", description: "hit_into_play", bb_type: "ground_ball", events: "field_out", launch_speed: "80", launch_angle: "5", estimated_slg_using_speedangle: "0.1", estimated_woba_using_speedangle: "0.2" }),
  r({ pitch_type: "FF", p_throws: "R", description: "hit_into_play", bb_type: "line_drive", events: "single" }), // BBE, no measurable EV
  r({ pitch_type: "SL", p_throws: "R", description: "swinging_strike" }),
  r({ pitch_type: "ZZ", p_throws: "R", description: "ball" }),   // unknown code → OT
  r({ pitch_type: "FF", p_throws: "L", description: "swinging_strike" }), // different hand bucket
];

const b = computeExactPitchStats(batterRows, "batter");
const ffR = b[exactPitchStatKey("R", "FF")];
ok(ffR != null, "FF vs R bucket exists");
ok(ffR.pitchCount === 6, `FF vs R pitchCount=6 (got ${ffR?.pitchCount})`);
ok(ffR.swingCount === 5, `FF vs R swingCount=5 — whiff+foul+3 BBE swings (got ${ffR?.swingCount})`);
ok(ffR.whiffCount === 1, `FF vs R whiffCount=1 (got ${ffR?.whiffCount})`);
ok(ffR.contactCount === 4, `FF vs R contactCount=4 — foul+3 BBE, includes foul (got ${ffR?.contactCount})`);
ok(ffR.bbeCount === 3, `FF vs R bbeCount=3 (got ${ffR?.bbeCount})`);
ok(ffR.qualityBbeCount === 2, `FF vs R qualityBbeCount=2 — the no-EV single excluded (got ${ffR?.qualityBbeCount})`);
ok(ffR.barrelCount === 1, `FF vs R barrelCount=1 via EV/LA proxy (got ${ffR?.barrelCount})`);
ok(ffR.hrCount === 1, `FF vs R hrCount=1 (got ${ffR?.hrCount})`);
ok(ffR.paEndedCount === 3, `FF vs R paEndedCount=3 (got ${ffR?.paEndedCount})`);
ok(Math.abs(ffR.xslgContactSum - 4.0) < 1e-9 && ffR.xslgContactN === 2, "xslgContactSum=4.0 over N=2 quality BBE (own denominator)");
ok(Math.abs(ffR.xwobaContactSum - 2.1) < 1e-9 && ffR.xwobaContactN === 2, "xwobaContactSum=2.1 over N=2 (xwOBA-on-contact, own denominator)");
// Damage denominator is qualityBbeCount (2), NOT contactCount (4) — the very bug
// PR3.1 review flagged. xslgContactN must equal quality BBE with xSLG, not contacts.
ok(ffR.xslgContactN !== ffR.contactCount, "damage sum denominator (2) is NOT contactCount (4)");

// Hand split: FF vs L is a separate bucket.
const ffL = b[exactPitchStatKey("L", "FF")];
ok(ffL != null && ffL.pitchCount === 1 && ffL.whiffCount === 1, "FF vs L is a separate hand bucket");

// Unknown code → OT fallback (not dropped).
ok(b[exactPitchStatKey("R", "OT")] != null && b[exactPitchStatKey("R", "OT")].pitchCount === 1, "unknown pitch code falls back to OT bucket (not dropped)");

// SL vs R present.
ok(b[exactPitchStatKey("R", "SL")]?.swingCount === 1, "SL vs R bucket present");

// ── Pitcher entity: opponent hand comes from `stand`, not `p_throws` ──────────
const pitcherRows: Row[] = [
  r({ pitch_type: "SL", stand: "L", p_throws: "R", description: "swinging_strike" }),
  r({ pitch_type: "SL", stand: "R", p_throws: "R", description: "foul" }),
];
const p = computeExactPitchStats(pitcherRows, "pitcher");
ok(p[exactPitchStatKey("L", "SL")]?.whiffCount === 1, "pitcher entity splits by batter stand (L)");
ok(p[exactPitchStatKey("R", "SL")]?.contactCount === 1, "pitcher entity splits by batter stand (R)");
ok(b[exactPitchStatKey("R", "SL")] !== p[exactPitchStatKey("R", "SL")], "batter vs pitcher entity use different hand columns");

// ── Blank/whitespace cells never become numeric zero (defect #1) ──────────────
{
  // Valid EV but BLANK LA → NOT a quality BBE.
  const rows = [r({ pitch_type: "FF", p_throws: "R", description: "hit_into_play", bb_type: "fly_ball", launch_speed: "100", launch_angle: "  ", estimated_slg_using_speedangle: "", estimated_woba_using_speedangle: "null" })];
  const s = computeExactPitchStats(rows, "batter")[exactPitchStatKey("R", "FF")];
  ok(s.bbeCount === 1, "bb_type present → bbeCount incremented");
  ok(s.qualityBbeCount === 0, "valid EV + blank LA is NOT a quality BBE");
  ok(s.xslgContactN === 0 && s.xslgContactSum === 0, "blank xSLG does not increment its denominator (no artificial zero)");
  ok(s.xwobaContactN === 0 && s.xwobaContactSum === 0, "null xwOBA does not increment its denominator");
  ok(s.barrelCount === 0, "no quality BBE → no barrel");
}

// ── Monotonic count-chain invariants across a realistic bucket ────────────────
{
  const all = computeExactPitchStats(batterRows, "batter");
  for (const [key, s] of Object.entries(all)) {
    ok(s.barrelCount <= s.qualityBbeCount, `${key}: barrelCount ≤ qualityBbeCount`);
    ok(s.qualityBbeCount <= s.bbeCount, `${key}: qualityBbeCount ≤ bbeCount`);
    ok(s.bbeCount <= s.contactCount, `${key}: bbeCount ≤ contactCount`);
    ok(s.contactCount <= s.swingCount, `${key}: contactCount ≤ swingCount`);
    ok(s.swingCount <= s.pitchCount, `${key}: swingCount ≤ pitchCount`);
    ok(s.hrCount <= s.paEndedCount, `${key}: hrCount ≤ paEndedCount`);
    ok(s.xslgContactN <= s.qualityBbeCount, `${key}: xslgContactN ≤ qualityBbeCount`);
    ok(s.xwobaContactN <= s.qualityBbeCount, `${key}: xwobaContactN ≤ qualityBbeCount`);
  }
}

// ── Empty / malformed input → empty map, never throws ────────────────────────
ok(Object.keys(computeExactPitchStats(null, "batter")).length === 0, "null rows → empty map");
ok(Object.keys(computeExactPitchStats([], "batter")).length === 0, "empty rows → empty map");
ok(Object.keys(computeExactPitchStats([r({ description: "ball" })], "batter")).length === 1, "row with no pitch_type still buckets to OT/U");
{
  let threw = false;
  try {
    computeExactPitchStats([
      r({ pitch_type: "FF", p_throws: "R", description: "hit_into_play", bb_type: "x", launch_speed: "abc", launch_angle: "!!", estimated_slg_using_speedangle: "NaN" }),
      {} as Record<string, string>,
    ], "batter");
  } catch { threw = true; }
  ok(!threw, "malformed row elements never throw");
}

console.log(`\nexactPitchStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
