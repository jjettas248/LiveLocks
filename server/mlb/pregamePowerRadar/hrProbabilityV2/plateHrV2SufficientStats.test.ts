// Plate HR Probability V2 — sufficient-statistics aggregator invariants
// (PR 1, correction 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2SufficientStats.test.ts

import { computePlateHrV2SufficientStats } from "./plateHrV2SufficientStats";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// A small, hand-computed batch of raw Savant `type=details`-shaped rows
// exercising every counter. Expected values are computed by hand in the
// comments alongside each row and verified below.
const ROWS: Array<Record<string, string>> = [
  { description: "swinging_strike", pitch_type: "FF" }, // A: whiff+swing, fastball
  { // B: swing (hit_into_play), breaking, BBE, terminal PA event (home_run)
    description: "hit_into_play", pitch_type: "SL", bb_type: "fly_ball",
    launch_speed: "100", launch_angle: "25", estimated_slg_using_speedangle: "1.200",
    hc_x: "150", hc_y: "150", stand: "R", events: "home_run",
  },
  { description: "called_strike", pitch_type: "CH", zone: "5" }, // C: take, offspeed, in-zone take
  { description: "ball", zone: "12" }, // D: ball, no pitch_type ("other" family), chase-zone take
  { description: "foul", pitch_type: "FF", zone: "5" }, // E: swing (not whiff), fastball, in-zone swing
  { description: "swinging_strike", pitch_type: "SL", events: "strikeout" }, // F: whiff+swing, breaking, PA-terminal K
  { description: "ball", events: "walk" }, // G: ball, PA-terminal BB
];

const result = computePlateHrV2SufficientStats(ROWS);

// ── 1. Pitch-level counts ───────────────────────────────────────────────────
{
  ok(result.pitchesSeen === 7, `pitchesSeen === 7 (got ${result.pitchesSeen})`);
  ok(result.swings === 4, `swings === 4 for A,B,E,F (got ${result.swings})`); // hit_into_play/foul/swinging_strike all count as swings
  ok(result.whiffs === 2, `whiffs === 2 for A,F (got ${result.whiffs})`);
  ok(result.calledStrikes === 1, `calledStrikes === 1 for C (got ${result.calledStrikes})`);
  ok(result.balls === 2, `balls === 2 for D,G (got ${result.balls})`);
}

// ── 2. PA-terminal event counting (via `events`, not `description`) ─────────
{
  ok(result.paCount === 3, `paCount === 3 for B(home_run),F(strikeout),G(walk) (got ${result.paCount})`);
  ok(result.strikeouts === 1, `strikeouts === 1 for F (got ${result.strikeouts})`);
  ok(result.walks === 1, `walks === 1 for G (got ${result.walks})`);
}

// ── 3. Batted-ball-event gating: EV/LA/xSLG/spray only computed for rows with a real bb_type ──
{
  ok(result.battedBallEvents === 1, `battedBallEvents === 1 for B only (got ${result.battedBallEvents})`);
  ok(result.evPercentiles.p50 === 100, `EV p50 === 100 (single BBE value) (got ${result.evPercentiles.p50}`);
  ok(result.laPercentiles.p50 === 25, `LA p50 === 25 (single BBE value) (got ${result.laPercentiles.p50}`);
  ok(result.sprayClassifiedBip === 1, "spray angle classified for the one BBE with hc_x/hc_y/stand present");
}

// ── 4. Zone classification — present when a parseable zone code exists ─────
{
  ok(result.zoneDataAvailable === true, "zoneDataAvailable true when at least one row has a parseable zone code");
  ok(result.zoneSwings === 1, `zoneSwings === 1 for E (in-zone + swing) (got ${result.zoneSwings})`);
  ok(result.zoneTakes === 1, `zoneTakes === 1 for C (in-zone + take) (got ${result.zoneTakes})`);
  ok(result.chaseSwings === 0, `chaseSwings === 0 (got ${result.chaseSwings})`);
  ok(result.chaseTakes === 1, `chaseTakes === 1 for D (chase-zone + take) (got ${result.chaseTakes})`);
}

// ── 5. Per-pitch-family stats — the batterSampleSwings-closing denominator ──
{
  ok(result.pitchFamilyStats.fastball.pitches === 2, `fastball.pitches === 2 for A,E (got ${result.pitchFamilyStats.fastball.pitches})`);
  ok(result.pitchFamilyStats.fastball.swings === 2, `fastball.swings === 2 (got ${result.pitchFamilyStats.fastball.swings})`);
  ok(result.pitchFamilyStats.fastball.whiffs === 1, `fastball.whiffs === 1 for A (got ${result.pitchFamilyStats.fastball.whiffs})`);
  ok(result.pitchFamilyStats.breaking.pitches === 2, `breaking.pitches === 2 for B,F (got ${result.pitchFamilyStats.breaking.pitches})`);
  ok(result.pitchFamilyStats.breaking.whiffs === 1, `breaking.whiffs === 1 for F (got ${result.pitchFamilyStats.breaking.whiffs})`);
  ok(result.pitchFamilyStats.breaking.xslgN === 1, `breaking.xslgN === 1 (only B is a BBE with a family) (got ${result.pitchFamilyStats.breaking.xslgN})`);
  ok(Math.abs(result.pitchFamilyStats.breaking.xslgSum - 1.2) < 1e-9, `breaking.xslgSum === 1.2 (got ${result.pitchFamilyStats.breaking.xslgSum})`);
  ok(result.pitchFamilyStats.offspeed.pitches === 1, `offspeed.pitches === 1 for C (got ${result.pitchFamilyStats.offspeed.pitches})`);
  ok(result.pitchFamilyStats.offspeed.swings === 0, "offspeed.swings === 0 (C is a take, not a swing)");
  // Row D has no pitch_type at all -> "other" family -> contributes to no family bucket.
  ok(
    result.pitchFamilyStats.fastball.pitches + result.pitchFamilyStats.breaking.pitches + result.pitchFamilyStats.offspeed.pitches === 5,
    "row D (no pitch_type) does not inflate any of the 3 named family buckets",
  );

  ok(result.sourceRowCount === 7, `sourceRowCount === 7 (got ${result.sourceRowCount})`);
}

// ── 6. Zone data absent entirely -> honestly reported unavailable, never fabricated ──
{
  const noZoneResult = computePlateHrV2SufficientStats([
    { description: "ball" },
    { description: "called_strike", pitch_type: "FF" },
  ]);
  ok(noZoneResult.zoneDataAvailable === false, "zoneDataAvailable false when no row has a parseable zone code");
  ok(noZoneResult.zoneSwings === null && noZoneResult.zoneTakes === null, "zone counts stay null (not zero) when zone data is unavailable — zero would falsely imply 'measured, found none'");
  ok(noZoneResult.chaseSwings === null && noZoneResult.chaseTakes === null, "chase counts stay null when zone data is unavailable");
}

// ── 7. Total-function sweep — never throws on degenerate input ─────────────
{
  let threw = false;
  let emptyResult: ReturnType<typeof computePlateHrV2SufficientStats> | null = null;
  try {
    emptyResult = computePlateHrV2SufficientStats([]);
    computePlateHrV2SufficientStats(null as any);
    computePlateHrV2SufficientStats(undefined as any);
    computePlateHrV2SufficientStats([{}, { description: "" }, { pitch_type: "garbage_value" }]);
  } catch {
    threw = true;
  }
  ok(!threw, "computePlateHrV2SufficientStats never throws on empty/null/undefined/malformed rows");
  ok(emptyResult != null && emptyResult.sourceRowCount === 0 && emptyResult.pitchesSeen === 0, "an empty row array degrades to all-zero counts, not an error");
}

console.log(`\nplateHrV2SufficientStats.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
