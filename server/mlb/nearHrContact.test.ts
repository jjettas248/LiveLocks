// [MLB Phase 2.5] Validation cases for detectNearHrContact()
// Run with: npx tsx server/mlb/nearHrContact.test.ts

import { detectNearHrContact } from "./nearHrContact";

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[Phase 2.5 — detectNearHrContact] running cases\n");

// Spec Case 1 — Mark Vientos: EV 102.9 / LA 24 / Dist 392 / xBA .720 / flyout
{
  const r = detectNearHrContact({ ev: 102.9, la: 24, distance: 392, xba: 0.72 });
  assert("Vientos (102.9/24/392/.720) → lean", r.tier === "lean", `got tier=${r.tier}`);
  assert("Vientos drivers include Near-HR contact", r.drivers.includes("Near-HR contact"));
  assert("Vientos drivers include Elite exit velocity", r.drivers.includes("Elite exit velocity"));
  assert("Vientos drivers include Optimal launch angle", r.drivers.includes("Optimal launch angle"));
  assert("Vientos drivers include Deep fly-ball distance", r.drivers.includes("Deep fly-ball distance"));
}

// Spec Case 2 — Mickey Moniak: EV 95.3 / LA 30 / Dist 338 / double
// Should NOT auto-force HR Watch — fails EV (95.3 < 98) AND distance (338 < 350)
{
  const r = detectNearHrContact({ ev: 95.3, la: 30, distance: 338 });
  assert("Moniak (95.3/30/338) → null tier", r.tier === null, `got tier=${r.tier}`);
  assert("Moniak emits suppressionReason", typeof r.suppressionReason === "string");
}

// Watch boundary cases
{
  const r = detectNearHrContact({ ev: 98, la: 20, distance: 350 });
  assert("Boundary EV=98/LA=20/dist=350 → watch", r.tier === "watch", `got tier=${r.tier}`);
}
{
  const r = detectNearHrContact({ ev: 98, la: 35, distance: 350 });
  assert("Boundary EV=98/LA=35/dist=350 → watch", r.tier === "watch", `got tier=${r.tier}`);
}
{
  const r = detectNearHrContact({ ev: 97.9, la: 25, distance: 360 });
  assert("Just-below-EV (97.9) → null", r.tier === null);
}
{
  const r = detectNearHrContact({ ev: 100, la: 36, distance: 360 });
  assert("LA=36 (above watch ceiling 35) → null", r.tier === null);
}
{
  const r = detectNearHrContact({ ev: 100, la: 25, distance: 349 });
  assert("Distance 349 (below watch floor 350) → null", r.tier === null);
}

// Lean boundary cases
{
  const r = detectNearHrContact({ ev: 102, la: 20, distance: 375 });
  assert("Boundary EV=102/LA=20/dist=375 → lean", r.tier === "lean", `got tier=${r.tier}`);
}
{
  const r = detectNearHrContact({ ev: 102, la: 33, distance: 380 });
  // LA 33 > 32 — fails lean EV+LA, but EV=102/LA=33/dist=380 still meets WATCH (LA<=35)
  assert("EV=102/LA=33/dist=380 → watch (lean LA cap is 32)", r.tier === "watch", `got tier=${r.tier}`);
}
{
  const r = detectNearHrContact({ ev: 102, la: 25, distance: 374 });
  // distance 374 < 375 fails lean, but meets watch (distance >= 350)
  assert("EV=102/dist=374 → watch (lean dist cap is 375)", r.tier === "watch", `got tier=${r.tier}`);
}

// xBA gate
{
  const r = detectNearHrContact({ ev: 102, la: 22, distance: 380, xba: 0.49 });
  // xBA below .500 fails LEAN; falls through to WATCH (still meets watch thresholds)
  assert("xBA=.49 blocks lean upgrade → watch", r.tier === "watch", `got tier=${r.tier}`);
}
{
  const r = detectNearHrContact({ ev: 102, la: 22, distance: 380, xba: 0.51 });
  assert("xBA=.51 allows lean", r.tier === "lean", `got tier=${r.tier}`);
}
{
  const r = detectNearHrContact({ ev: 102, la: 22, distance: 380 });
  assert("xBA omitted → lean still allowed (no per-AB xBA yet)", r.tier === "lean", `got tier=${r.tier}`);
}

// Missing/invalid data
{
  const r = detectNearHrContact({ ev: null, la: 25, distance: 360 });
  assert("Missing EV → null + suppressionReason missing_statcast", r.tier === null && r.suppressionReason === "missing_statcast");
}
{
  const r = detectNearHrContact({ ev: 100, la: null, distance: 360 });
  assert("Missing LA → null + missing_statcast", r.tier === null && r.suppressionReason === "missing_statcast");
}

// Junk contact (way below watch)
{
  const r = detectNearHrContact({ ev: 75, la: 5, distance: 150 });
  assert("Junk contact (75/5/150) → null no suppressionReason", r.tier === null && !r.suppressionReason);
}

console.log(`\n[Phase 2.5 — detectNearHrContact] ${passed}/${passed + failed} cases passed${failed > 0 ? ` (${failed} FAILED)` : ""}\n`);
if (failed > 0) process.exit(1);
