// setupGrade — invariants.
// Run: npx tsx client/src/lib/mlb/setupGrade.test.ts
//
// Guards the letter-grade boundaries shared by The Mound and The Plate. This
// helper was extracted verbatim from MoundPowerRadar.tsx — these tests pin
// the exact thresholds/return values so a future edit to either surface
// can't silently drift the grade scale.

import { getSetupGrade } from "@/lib/mlb/setupGrade";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n=== setupGrade — Invariant Suite ===\n");

console.log("boundary values");
{
  assert("8.5 → A+", getSetupGrade(8.5) === "A+");
  assert("10 → A+", getSetupGrade(10) === "A+");
  assert("8.49 → A", getSetupGrade(8.49) === "A");
  assert("7.5 → A", getSetupGrade(7.5) === "A");
  assert("7.49 → B+", getSetupGrade(7.49) === "B+");
  assert("6.5 → B+", getSetupGrade(6.5) === "B+");
  assert("6.49 → B", getSetupGrade(6.49) === "B");
  assert("5.5 → B", getSetupGrade(5.5) === "B");
  assert("5.49 → C", getSetupGrade(5.49) === "C");
  assert("4.5 → C", getSetupGrade(4.5) === "C");
  assert("4.49 → D", getSetupGrade(4.49) === "D");
  assert("0 → D", getSetupGrade(0) === "D");
}

console.log("\n=== " + (pass + fail) + " total, " + pass + " passed, " + fail + " failed ===");
if (failures.length > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
}

if (fail > 0) process.exit(1);
