// Baseball Savant query upper-bound date — UTC/ET calendar-boundary fix.
// Proves resolveSavantQueryUpperBoundDate() (server/mlb/dataSources.ts)
// resolves to the Eastern calendar date, not the UTC calendar date, at an
// instant where the two disagree — the exact defect documented in
// docs/architecture/TECH_DEBT_REMAINING.md §16. Uses explicit fixed
// timestamps + Intl's America/New_York timeZone throughout, so results do
// not depend on the machine's local timezone.
// Run: npx tsx server/mlb/dataSources.test.ts

import { resolveSavantQueryUpperBoundDate } from "./dataSources";
import { dateToET } from "../utils/dateUtils";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`[DATA_SOURCES_ET_BOUNDARY_TEST] FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

// The old, buggy behavior this fix replaces — reproduced inline (not
// imported) so the test can prove the new function diverges from it exactly
// at the calendar boundary and agrees with it everywhere else.
function oldUtcDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

// ─── Case 1: winter (EST, UTC-5) — 00:30 UTC is still the previous ET day ──
{
  // 2026-01-15T00:30:00Z = 7:30 PM EST on 2026-01-14.
  const instant = new Date("2026-01-15T00:30:00Z");
  const result = resolveSavantQueryUpperBoundDate(instant);
  check("winter: 00:30 UTC resolves to the previous Eastern calendar day", result === "2026-01-14", `got ${result}`);
  check("winter: UTC calendar date is one day ahead (the bug)", oldUtcDate(instant) === "2026-01-15");
  check("winter: fix diverges from the old UTC value at this boundary", result !== oldUtcDate(instant));
}

// ─── Case 2: summer (EDT, UTC-4) — same boundary shape under DST ──────────
{
  // 2026-07-15T02:30:00Z = 10:30 PM EDT on 2026-07-14.
  const instant = new Date("2026-07-15T02:30:00Z");
  const result = resolveSavantQueryUpperBoundDate(instant);
  check("summer (DST): 02:30 UTC resolves to the previous Eastern calendar day", result === "2026-07-14", `got ${result}`);
  check("summer (DST): UTC calendar date is one day ahead (the bug)", oldUtcDate(instant) === "2026-07-15");
  check("summer (DST): fix diverges from the old UTC value at this boundary", result !== oldUtcDate(instant));
}

// ─── Case 3: agreement case — no boundary crossed, old and new must match ──
{
  // 2026-01-15T20:00:00Z = 3:00 PM EST on 2026-01-15 — same calendar day in both zones.
  const instant = new Date("2026-01-15T20:00:00Z");
  const result = resolveSavantQueryUpperBoundDate(instant);
  check("midday: Eastern date matches UTC date when no boundary is crossed", result === "2026-01-15", `got ${result}`);
  check("midday: fix agrees with the old UTC value away from the boundary", result === oldUtcDate(instant));
}

// ─── Case 4: default parameter (production call shape) ────────────────────
{
  // fetchBaseballSavantData() calls resolveSavantQueryUpperBoundDate() with
  // no argument in production — confirm the default resolves against real
  // "now" via the same dateToET() logic todayET() itself uses, and returns
  // a well-formed YYYY-MM-DD string.
  const result = resolveSavantQueryUpperBoundDate();
  check("default: well-formed YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(result), `got ${result}`);
  check("default: matches dateToET(new Date()) taken immediately after", result === dateToET(new Date()));
}

console.log(`[DATA_SOURCES_ET_BOUNDARY_TEST] passed=${pass} failed=${fail}`);
if (fail > 0) process.exit(1);
console.log("[DATA_SOURCES_ET_BOUNDARY_TEST] OK");
