// Plate — client display-suppression invariants (PR0).
// Run: npx tsx client/src/lib/mlb/plateDisplaySuppression.test.ts
//
// The Plate card filters display-suppressed driver keys with the SAME shared
// predicate the server uses (shared/plateDisplaySuppression.ts). This proves the
// client explicitly filters `power_iso` (not merely dropping its label mapping)
// and that only the intended key is removed.

import { isDisplaySuppressedDriverKey, DISPLAY_SUPPRESSED_DRIVER_KEYS } from "@shared/plateDisplaySuppression";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

// Predicate coverage.
ok(isDisplaySuppressedDriverKey("power_iso"), "power_iso is suppressed");
ok(!isDisplaySuppressedDriverKey("power_barrel"), "power_barrel is NOT suppressed");
ok(!isDisplaySuppressedDriverKey("pv_hr9"), "pv_hr9 is NOT suppressed");
ok(!isDisplaySuppressedDriverKey("power_pullair"), "power_pullair is NOT suppressed (handled separately)");
ok(DISPLAY_SUPPRESSED_DRIVER_KEYS.size === 1, "exactly one key suppressed today");

// Mirrors the component filter: positive chips exclude power_pullair + suppressed keys.
type Driver = { key: string; direction: "positive" | "negative" };
const drivers: Driver[] = [
  { key: "power_iso", direction: "positive" },
  { key: "power_barrel", direction: "positive" },
  { key: "pv_hr9", direction: "positive" },
  { key: "power_pullair", direction: "positive" },
  { key: "power_low", direction: "negative" },
];
const shownPositives = drivers.filter(
  (d) => d.direction === "positive" && d.key !== "power_pullair" && !isDisplaySuppressedDriverKey(d.key),
);
ok(!shownPositives.some((d) => d.key === "power_iso"), "client positive chips exclude power_iso");
ok(shownPositives.some((d) => d.key === "power_barrel"), "client positive chips keep power_barrel");
ok(shownPositives.some((d) => d.key === "pv_hr9"), "client positive chips keep pv_hr9");
ok(shownPositives.length === 2, `only power_iso + power_pullair removed from positives (got ${shownPositives.length}, want 2)`);

console.log(`\nPlate display suppression (client): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
