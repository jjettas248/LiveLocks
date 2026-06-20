/**
 * Canonical EV-scaled Statcast barrel — invariant test.
 *
 * Locks the single-source-of-truth `isBarrel` / `isDeepFly` so the on-screen
 * BRL tag and the engine's barrel count can never diverge again.
 *
 * Run: npx tsx server/mlb/statcastBarrel.test.ts
 */

import { isBarrel, isDeepFly, classifyContact } from "./statcastXBA";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}`); }
}

// ── isBarrel boundary cases (window widens with EV) ──────────────────────────
check("98@28 → barrel (in base [26,30] window)", isBarrel(98, 28) === true);
check("98@32 → not barrel (above base 30 ceiling)", isBarrel(98, 32) === false);
check("98@25 → not barrel (below base 26 floor)", isBarrel(98, 25) === false);
check("116@10 → barrel (window widened to ~[8,50])", isBarrel(116, 10) === true);
check("116@52 → not barrel (above widened 50 ceiling)", isBarrel(116, 52) === false);
check("97@28 → not barrel (sub-98 EV)", isBarrel(97, 28) === false);
check("105@22 → barrel (mid-EV widened window includes 22)", isBarrel(105, 22) === true);
check("105@18 → not barrel (still below widened floor)", isBarrel(105, 18) === false);
check("null inputs → not barrel", isBarrel(null, 28) === false && isBarrel(98, null) === false);

// ── classifyContact agrees with isBarrel ─────────────────────────────────────
check("classifyContact(101,28).isBarrel matches isBarrel", classifyContact(101, 28).isBarrel === isBarrel(101, 28));
check("classifyContact(101,28).contactGrade === 'barrel'", classifyContact(101, 28).contactGrade === "barrel");
check("classifyContact(99,40) not barrel grade", classifyContact(99, 40).contactGrade !== "barrel");

// ── isDeepFly geometry ───────────────────────────────────────────────────────
check("la25 dist360 → deep fly", isDeepFly(25, 360) === true);
check("la25 dist340 → not deep fly (under 350ft)", isDeepFly(25, 340) === false);
check("la15 dist360 → not deep fly (under 20°)", isDeepFly(15, 360) === false);
check("null → not deep fly", isDeepFly(null, 360) === false && isDeepFly(25, null) === false);

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
if (fail > 0) {
  console.log("Failures:\n  " + failures.join("\n  "));
  process.exit(1);
}
