// Mound Radar v2 — aggregatePitcherStuffMetrics() invariants.
//
// Pure aggregation over synthetic Savant per-pitch rows (same shape as the
// parsed CSV: string-keyed Record<string,string>, mirroring the real fetch).
// Run: npx tsx server/mlb/dataSources.pitcherStuffMetrics.test.ts

import { aggregatePitcherStuffMetrics } from "./dataSources";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

type Row = Record<string, string>;

function pitch(pitchType: string, description: string): Row {
  return { pitch_type: pitchType, description };
}

// ── Below sample floor → both rates null, no fabricated numbers ──────────────
const tinySample = Array.from({ length: 5 }, () => pitch("FF", "ball"));
const tinyResult = aggregatePitcherStuffMetrics(tinySample);
ok(tinyResult.swStrPct === null, "below 30-pitch floor → swStrPct null");
ok(tinyResult.cswPct === null, "below 30-pitch floor → cswPct null");
ok(Object.keys(tinyResult.whiffPctByFamily).length === 0, "below floor → no per-family whiff data");
ok(tinyResult.missesBatsFamily === null, "below floor → no misses-bats family");

// ── SwStr% / CSW% / per-family whiff over a realistic 60-pitch outing ────────
// Fastball: 30 pitches, only 5 swinging strikes (swings=5, BELOW the 10-swing
// family floor — must be excluded from whiffPctByFamily even though its
// whiff% would be 100% if computed).
// Slider: 30 pitches, 20 swinging strikes + 5 called strikes (swings=20,
// clears the floor; 100% whiff among swings; 50% usage) — the pitch that
// should surface as "misses bats".
function buildRealisticOuting(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 25; i++) rows.push(pitch("FF", "ball"));
  for (let i = 0; i < 5; i++) rows.push(pitch("FF", "swinging_strike"));
  for (let i = 0; i < 5; i++) rows.push(pitch("SL", "ball"));
  for (let i = 0; i < 5; i++) rows.push(pitch("SL", "called_strike"));
  for (let i = 0; i < 20; i++) rows.push(pitch("SL", "swinging_strike"));
  return rows;
}

const outing = buildRealisticOuting();
const result = aggregatePitcherStuffMetrics(outing);
// 60 total pitches, 25 swinging strikes (5 FF + 20 SL) → SwStr% = 25/60 = 41.7
ok(result.swStrPct === 41.7, `SwStr% = 25/60 = 41.7 (got ${result.swStrPct})`);
// (25 whiffs + 5 called) / 60 = 50.0
ok(result.cswPct === 50.0, `CSW% = 30/60 = 50.0 (got ${result.cswPct})`);

ok(
  result.whiffPctByFamily.fastball === undefined,
  `fastball has only 5 swings (below the 10-swing family floor) → excluded from whiffPctByFamily (got ${result.whiffPctByFamily.fastball})`,
);
ok(result.whiffPctByFamily.breaking === 100, `slider family whiff% = 20/20 = 100 (got ${result.whiffPctByFamily.breaking})`);

// Slider is 30/60 = 50% usage, 100% whiff → clears both misses-bats floors.
ok(result.missesBatsFamily !== null, "slider clears usage+whiff floors → missesBatsFamily set");
ok(result.missesBatsFamily?.family === "breaking", `missesBatsFamily is breaking (got ${result.missesBatsFamily?.family})`);
ok(result.missesBatsFamily?.usagePct === 50, `missesBatsFamily usagePct = 50 (got ${result.missesBatsFamily?.usagePct})`);

// ── A real but modest-usage wipeout pitch still qualifies above the 15% floor ─
function buildModestUsageWipeoutPitch(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 45; i++) rows.push(pitch("FF", "ball")); // 45 fastballs, no swings at all
  for (let i = 0; i < 10; i++) rows.push(pitch("CH", "swinging_strike")); // 10 changeups, all whiffs
  return rows;
}
const modestUsage = aggregatePitcherStuffMetrics(buildModestUsageWipeoutPitch());
// changeup usage = 10/55 = 18.2% >= 15% floor, whiff% = 100% >= 30% floor → qualifies
ok(modestUsage.missesBatsFamily?.family === "offspeed", `18% usage clears the 15% floor → still qualifies (got ${modestUsage.missesBatsFamily?.family})`);

// ── A true show-me pitch (below the usage floor) must never qualify, however elite its whiff% ──
function buildTrueShowMePitch(): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < 97; i++) rows.push(pitch("FF", "ball")); // 97 fastballs
  for (let i = 0; i < 3; i++) rows.push(pitch("CH", "swinging_strike")); // 3 changeups, all whiffs but too rare
  return rows;
}
const showMe = aggregatePitcherStuffMetrics(buildTrueShowMePitch());
// changeup usage = 3/100 = 3% < 15% floor → must not qualify despite 100% whiff (and its
// swings count of 3 is also below MIN_SWINGS_FOR_FAMILY_WHIFF, so it never even gets a whiffPctByFamily entry)
ok(showMe.missesBatsFamily === null, "3% usage below the 15% floor → never a 'misses bats' driver, however elite the whiff%");
ok(showMe.whiffPctByFamily.offspeed === undefined, "3 swings is also below the 10-swing family floor → no whiffPctByFamily entry either");

// ── Unknown pitch types (e.g. eephus) contribute to the total-pitch
// denominator (SwStr%/CSW% are season-wide rates over ALL pitches) but are
// excluded from per-family whiff aggregation.
const baseline = aggregatePitcherStuffMetrics(buildRealisticOuting());
const withUnknownPitch = aggregatePitcherStuffMetrics([...buildRealisticOuting(), pitch("EP", "ball")]);
ok(
  withUnknownPitch.swStrPct !== null && baseline.swStrPct !== null && withUnknownPitch.swStrPct < baseline.swStrPct,
  `adding a 61st (non-whiff) pitch of an unrecognized type dilutes SwStr% via the total-pitch denominator (${baseline.swStrPct} → ${withUnknownPitch.swStrPct})`,
);

console.log(`\ndataSources.pitcherStuffMetrics.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
