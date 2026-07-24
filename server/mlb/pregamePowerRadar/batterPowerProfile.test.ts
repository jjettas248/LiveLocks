// Pre-Game Power Radar — batter power profile component.
// Run: npx tsx server/mlb/pregamePowerRadar/batterPowerProfile.test.ts

import { computeBatterPowerProfile, type BatterPowerInputs } from "./batterPowerProfile";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const eliteBase: Omit<BatterPowerInputs, "battedBallEvents"> = {
  xISO: 0.26, xSLG: 0.56, barrelRatePct: 16, hardHitRatePct: 52, exitVelocity: 94,
  maxEV: 116, flyBallPct: 45, hrFBRatioPct: 25, pullRatePct: 50, sweetSpotPct: 40, xwOBA: 0.42,
};
const weakBase: Omit<BatterPowerInputs, "battedBallEvents"> = {
  xISO: 0.09, xSLG: 0.34, barrelRatePct: 3, hardHitRatePct: 30, exitVelocity: 86,
  maxEV: 104, flyBallPct: 22, hrFBRatioPct: 5, pullRatePct: 30, sweetSpotPct: 28, xwOBA: 0.3,
};

// Empty core inputs → unavailable, NEUTRAL (5), not the worst-possible score
// (Finding 11 — matches every sibling component's unavailable fallback).
const empty = computeBatterPowerProfile({
  xISO: null, xSLG: null, barrelRatePct: null, hardHitRatePct: null, exitVelocity: null,
  maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null, sweetSpotPct: null,
  xwOBA: null, battedBallEvents: null,
});
ok(!empty.available && empty.score10 === 5, `empty inputs → unavailable, neutral 5 (got ${empty.score10}/${empty.available})`);

// Unknown sample size (battedBallEvents: null) is a no-op — full confidence,
// not an assume-thin penalty (see the reasoning in batterPowerProfile.ts).
const eliteUnknownSample = computeBatterPowerProfile({ ...eliteBase, battedBallEvents: null });
ok(eliteUnknownSample.available && eliteUnknownSample.score10 >= 9, `elite inputs, unknown sample → still high score (got ${eliteUnknownSample.score10})`);

// A large, known sample also gets no shrink.
const eliteFullSample = computeBatterPowerProfile({ ...eliteBase, battedBallEvents: 150 });
ok(eliteFullSample.score10 === eliteUnknownSample.score10, `elite inputs, large known sample matches unknown-sample score (${eliteFullSample.score10} vs ${eliteUnknownSample.score10})`);

// A KNOWN thin sample shrinks an elite read toward neutral (Finding 10 — the
// single largest-weighted component previously had no shrinkage at all).
const eliteThinSample = computeBatterPowerProfile({ ...eliteBase, battedBallEvents: 8 });
ok(eliteThinSample.available && eliteThinSample.score10 < eliteFullSample.score10, `elite inputs, thin known sample (8 BIP) shrinks below full-sample score (${eliteThinSample.score10} vs ${eliteFullSample.score10})`);
ok(eliteThinSample.score10 > 5, `thin-sample elite read still stays above neutral (got ${eliteThinSample.score10})`);

// Shrinkage protects the low end too — a thin sample's weak read moves UP
// toward neutral rather than staying at the full-sample floor.
const weakFullSample = computeBatterPowerProfile({ ...weakBase, battedBallEvents: 150 });
const weakThinSample = computeBatterPowerProfile({ ...weakBase, battedBallEvents: 8 });
ok(weakThinSample.score10 > weakFullSample.score10, `weak inputs, thin known sample shrinks toward neutral from above (${weakThinSample.score10} vs ${weakFullSample.score10})`);

// A full-sample weak read still fires "Limited Raw Power"; the thin-sample
// version — shrunk toward neutral — should not unfairly trigger the same tag.
ok(weakFullSample.drivers.some((d) => d.key === "power_low"), "full-sample weak read fires power_low driver");
ok(!weakThinSample.drivers.some((d) => d.key === "power_low"), "thin-sample weak read (shrunk toward neutral) does not fire power_low driver");

// Moderate known sample sizes land strictly between the thin and full cases.
const eliteModerateSample = computeBatterPowerProfile({ ...eliteBase, battedBallEvents: 40 });
ok(
  eliteThinSample.score10 < eliteModerateSample.score10 && eliteModerateSample.score10 <= eliteFullSample.score10,
  `moderate sample (40 BIP) sits between thin and full (${eliteThinSample.score10} < ${eliteModerateSample.score10} <= ${eliteFullSample.score10})`,
);

console.log(`\nbatterPowerProfile.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
