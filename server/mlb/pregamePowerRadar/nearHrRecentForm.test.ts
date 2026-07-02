// Pre-Game Power Radar — near-HR recent-form component (Component 6).
// Run: npx tsx server/mlb/pregamePowerRadar/nearHrRecentForm.test.ts

import { computeNearHrRecentForm, type RecentContactEventRow } from "./nearHrRecentForm";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// sessionDateEt is a fixed slate day; midday-UTC timestamps avoid any ET
// midnight-boundary ambiguity regardless of EST/EDT.
const SESSION_DATE = "2026-07-10";
const OFFSET_1_DAY = "2026-07-09"; // "yesterday"
const OFFSET_2_DAY = "2026-07-08";
const OFFSET_3_DAY = "2026-07-07";
const SAME_DAY = "2026-07-10"; // the game currently being scored — must never leak in

function tsFor(dateStr: string): string {
  return `${dateStr}T18:00:00.000Z`;
}

function watchEvent(dateStr: string): RecentContactEventRow {
  return { exitVelocity: 99, launchAngle: 25, distance: 355, isBarrel: false, result: "out", timestamp: tsFor(dateStr) };
}
function leanEvent(dateStr: string): RecentContactEventRow {
  return { exitVelocity: 104, launchAngle: 24, distance: 390, isBarrel: false, result: "out", timestamp: tsFor(dateStr) };
}
function quietEvent(dateStr: string): RecentContactEventRow {
  return { exitVelocity: 85, launchAngle: 10, distance: 150, isBarrel: false, result: "out", timestamp: tsFor(dateStr) };
}

// ── Zero events → neutral no-op ───────────────────────────────────────────────
const empty = computeNearHrRecentForm({ events: [], sessionDateEt: SESSION_DATE });
ok(!empty.available, "zero events → unavailable");
ok(empty.score10 === 5, `zero events → neutral score10=5 (got ${empty.score10})`);

// ── Recency weighting: identical event, yesterday vs 3 days ago ──────────────
const yesterday = computeNearHrRecentForm({ events: [watchEvent(OFFSET_1_DAY)], sessionDateEt: SESSION_DATE });
const threeDaysAgo = computeNearHrRecentForm({ events: [watchEvent(OFFSET_3_DAY)], sessionDateEt: SESSION_DATE });
ok(yesterday.available && threeDaysAgo.available, "both single-day watch cases available");
ok(
  yesterday.score10 > threeDaysAgo.score10,
  `identical watch event scores higher when yesterday than 3 days ago (yesterday=${yesterday.score10}, 3dAgo=${threeDaysAgo.score10})`,
);

// ── Consecutive-day bonus ─────────────────────────────────────────────────────
const oneDayTwoEvents = computeNearHrRecentForm({
  events: [watchEvent(OFFSET_1_DAY), watchEvent(OFFSET_1_DAY)],
  sessionDateEt: SESSION_DATE,
});
const twoDaysOneEventEach = computeNearHrRecentForm({
  events: [watchEvent(OFFSET_1_DAY), watchEvent(OFFSET_2_DAY)],
  sessionDateEt: SESSION_DATE,
});
ok(
  twoDaysOneEventEach.score10 > oneDayTwoEvents.score10,
  `same tier spread across 2 distinct days scores higher than concentrated on 1 day (2-day=${twoDaysOneEventEach.score10}, 1-day=${oneDayTwoEvents.score10})`,
);
ok(
  twoDaysOneEventEach.drivers.some((d) => d.key === "near_hr_form_consecutive"),
  "consecutive-day driver present when 2+ days qualify",
);
ok(
  !oneDayTwoEvents.drivers.some((d) => d.key === "near_hr_form_consecutive"),
  "no consecutive-day driver when only 1 day qualifies",
);

// ── Leakage guard: current-game-day event never contributes ──────────────────
const sameDayOnly = computeNearHrRecentForm({ events: [leanEvent(SAME_DAY)], sessionDateEt: SESSION_DATE });
ok(!sameDayOnly.available && sameDayOnly.score10 === 5, "same-day-only event → treated as no data (leaked in nothing)");

const withSameDayNoise = computeNearHrRecentForm({
  events: [leanEvent(SAME_DAY), watchEvent(OFFSET_1_DAY)],
  sessionDateEt: SESSION_DATE,
});
const withoutSameDayNoise = computeNearHrRecentForm({ events: [watchEvent(OFFSET_1_DAY)], sessionDateEt: SESSION_DATE });
ok(
  withSameDayNoise.score10 === withoutSameDayNoise.score10 && withSameDayNoise.available === withoutSameDayNoise.available,
  `adding a same-day (current-game) event changes nothing (with=${withSameDayNoise.score10}, without=${withoutSameDayNoise.score10})`,
);

// ── Tier ordering: lean > watch > quiet (neutral) > unavailable ──────────────
const leanDay = computeNearHrRecentForm({ events: [leanEvent(OFFSET_1_DAY)], sessionDateEt: SESSION_DATE });
const watchDay = computeNearHrRecentForm({ events: [watchEvent(OFFSET_1_DAY)], sessionDateEt: SESSION_DATE });
const quietDay = computeNearHrRecentForm({ events: [quietEvent(OFFSET_1_DAY)], sessionDateEt: SESSION_DATE });
ok(leanDay.score10 > watchDay.score10, `lean day > watch day (${leanDay.score10} > ${watchDay.score10})`);
ok(watchDay.score10 > quietDay.score10, `watch day > quiet day (${watchDay.score10} > ${quietDay.score10})`);
ok(quietDay.score10 >= empty.score10, `quiet day (real ABs, no signal) is not penalized below unavailable-neutral (${quietDay.score10} >= ${empty.score10})`);

// ── Quiet day is neutral, not a penalty ───────────────────────────────────────
ok(quietDay.available, "quiet day (real ABs) is still 'available' data, not treated as missing");
ok(quietDay.score10 === 5, `quiet day scores exactly neutral 5 (got ${quietDay.score10})`);

console.log(`\nnearHrRecentForm.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
