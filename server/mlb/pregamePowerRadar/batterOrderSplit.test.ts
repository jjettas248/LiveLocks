// Pre-Game Power Radar — batter production from today's lineup slot.
// Run: npx tsx server/mlb/pregamePowerRadar/batterOrderSplit.test.ts

import { computeBatterOrderSplit } from "./batterOrderSplit";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Weak production from the slot → downgrade.
const weak = computeBatterOrderSplit({ slot: 5, pa: 200, slg: 0.28, ops: 0.55 });
ok(weak.available && weak.direction === "weak", `weak from slot (.550 OPS, 200 PA) → weak (got ${weak.score10}/${weak.direction})`);

// Strong production from the slot → positive context.
const strong = computeBatterOrderSplit({ slot: 3, pa: 200, slg: 0.55, ops: 0.95 });
ok(strong.available && strong.direction === "strong", `strong from slot (.950 OPS, 200 PA) → strong (got ${strong.score10}/${strong.direction})`);

ok(strong.score10 > weak.score10, "strong-slot scores above weak-slot");

// Thin sample shrinks toward neutral (no overreaction).
const thin = computeBatterOrderSplit({ slot: 5, pa: 8, slg: 0.2, ops: 0.45 });
ok(thin.available && thin.score10 > weak.score10 && thin.score10 >= 4.0, `8-PA weak line shrinks toward neutral (got ${thin.score10})`);

// Absent → unavailable.
const absent = computeBatterOrderSplit({ slot: 5, pa: null, slg: null, ops: null });
ok(!absent.available && absent.direction === "unavailable" && absent.score10 === 5, "absent → unavailable, neutral 5");

console.log(`\nbatterOrderSplit.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
