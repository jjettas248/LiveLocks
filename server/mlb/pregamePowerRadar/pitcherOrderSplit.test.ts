// Pre-Game Power Radar — pitcher allowed-by-batting-order-slot orientation.
// Run: npx tsx server/mlb/pregamePowerRadar/pitcherOrderSplit.test.ts
//
// Canonical orientation (pitcher-allowed perspective): high allowed
// HR/SLG/OPS/AVG/OBP = vulnerable; low = suppressive; high SO = pitcher strength.
// Fixtures use the real Tanner Bibee batting-order splits.

import { computePitcherOrderSplit, type PitcherOrderSplitInputs } from "./pitcherOrderSplit";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const NIL = { r: null, doubles: null, triples: null, rbi: null, bb: null, hbp: null, so: null, sb: null, cs: null };
function row(p: Partial<PitcherOrderSplitInputs>): PitcherOrderSplitInputs {
  return { slot: null, ab: null, h: null, hr: null, avg: null, obp: null, slg: null, ops: null, ...NIL, ...p } as PitcherOrderSplitInputs;
}

// ── Bibee fixtures ────────────────────────────────────────────────────────────
const bibee1 = computePitcherOrderSplit(row({ slot: 1, ab: 44, h: 12, hr: 5, avg: 0.273, obp: 0.333, slg: 0.727, ops: 1.061 }));
ok(bibee1.available && bibee1.direction === "vulnerable", `#1 (1.061 OPS, 5 HR) → vulnerable (got ${bibee1.score10}/${bibee1.direction})`);

const bibee2 = computePitcherOrderSplit(row({ slot: 2, ab: 39, h: 13, hr: 3, avg: 0.333, obp: 0.4, slg: 0.615, ops: 1.015 }));
ok(bibee2.available && bibee2.direction === "vulnerable", `#2 (1.015 OPS, 3 HR) → vulnerable (got ${bibee2.score10}/${bibee2.direction})`);

const bibee5 = computePitcherOrderSplit(row({ slot: 5, ab: 35, h: 4, hr: 0, avg: 0.114, obp: 0.2, slg: 0.114, ops: 0.314, so: 11 }));
ok(bibee5.available && bibee5.direction === "suppressive", `#5 (.314 OPS, 0 HR, 11 SO) → suppressive (got ${bibee5.score10}/${bibee5.direction})`);

ok(bibee1.score10 > bibee5.score10 && bibee2.score10 > bibee5.score10, "vulnerable slots score ABOVE the suppressed slot (not inverted)");

// ── 0 HR with low SLG/OPS is suppression, not opportunity ─────────────────────
const lowNoHr = computePitcherOrderSplit(row({ slot: 6, ab: 30, h: 5, hr: 0, avg: 0.167, obp: 0.22, slg: 0.2, ops: 0.42 }));
ok(lowNoHr.direction === "suppressive", `0 HR + low SLG/OPS → suppressive (got ${lowNoHr.score10}/${lowNoHr.direction})`);

// ── SO by the pitcher is pitcher strength (inverse) ───────────────────────────
const kHeavy = computePitcherOrderSplit(row({ slot: 3, ab: 40, h: 10, hr: 1, avg: 0.25, obp: 0.31, slg: 0.45, ops: 0.76, so: 22 }));
const kLight = computePitcherOrderSplit(row({ slot: 3, ab: 40, h: 10, hr: 1, avg: 0.25, obp: 0.31, slg: 0.45, ops: 0.76, so: 3 }));
ok(kHeavy.score10 < kLight.score10, `high-K slot less vulnerable than low-K slot (got ${kHeavy.score10} < ${kLight.score10})`);

// ── SB/CS are ignored for HR/power ────────────────────────────────────────────
const noRun = computePitcherOrderSplit(row({ slot: 4, ab: 40, h: 12, hr: 3, avg: 0.3, obp: 0.36, slg: 0.6, ops: 0.96, sb: 0, cs: 0 }));
const bigRun = computePitcherOrderSplit(row({ slot: 4, ab: 40, h: 12, hr: 3, avg: 0.3, obp: 0.36, slg: 0.6, ops: 0.96, sb: 20, cs: 10 }));
ok(noRun.score10 === bigRun.score10, "SB/CS do not change the score");

// ── Sample-size shrinkage: a tiny vulnerable line stays near neutral ──────────
const tiny = computePitcherOrderSplit(row({ slot: 7, ab: 6, h: 4, hr: 2, avg: 0.667, obp: 0.7, slg: 1.5, ops: 2.2 }));
ok(tiny.available && tiny.score10 < bibee1.score10 && tiny.score10 < 7, `6-AB monster line shrinks toward neutral (got ${tiny.score10})`);

// ── Absent feed → unavailable, neutral 5 (never penalizes) ────────────────────
const absent = computePitcherOrderSplit(row({ slot: 5 }));
ok(!absent.available && absent.direction === "unavailable" && absent.score10 === 5, "absent split → unavailable, neutral 5");

console.log(`\npitcherOrderSplit.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
