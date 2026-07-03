// Mound Radar — scoring + component invariants.
// Run: npx tsx server/mlb/pregame/mound/moundScoring.test.ts

import {
  composeMoundScore,
  computeMoundDataCoverage,
  classifyMoundTier,
  MOUND_PUBLISH_MIN_SCORE,
  type MoundScoringComponents,
  type MoundScoringFlags,
} from "./scoring";
import { computePitcherSkill } from "./pitcherSkill";
import { computeWorkload } from "./workload";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}
function approx(a: number, b: number, eps = 0.1) { return Math.abs(a - b) <= eps; }

const fullFlags: MoundScoringFlags = {
  pitcherSkillAvailable: true,
  confirmedStarter: true,
  confirmedOpposingLineup: true,
  parkAvailable: true,
  weatherAvailable: true,
  positiveDriverCount: 3,
};

// ── Data coverage formula ─────────────────────────────────────────────────────
ok(approx(computeMoundDataCoverage(fullFlags), 1.0), "full coverage = 1.0");
ok(
  computeMoundDataCoverage({ ...fullFlags, pitcherSkillAvailable: false }) === 0.65,
  "no pitcher skill → 0.65 coverage",
);

// ── Composite is 0–10 and weighted ────────────────────────────────────────────
const comps: MoundScoringComponents = {
  pitcherSkillScore: 8,
  opponentKProfileScore: 8,
  workloadScore: 8,
  runEnvironmentScore: 8,
  recentFormScore: 8,
  riskPenalty: 0,
};
const r1 = composeMoundScore(comps, fullFlags);
ok(approx(r1.score10, 8.0), `all-8 components → ~8.0 (got ${r1.score10})`);
ok(r1.score10 >= 0 && r1.score10 <= 10, "score in [0,10]");
ok(!r1.suppressed, "full data, high score → not suppressed");

// ── Risk penalty subtracts, capped ────────────────────────────────────────────
const r2 = composeMoundScore({ ...comps, riskPenalty: 2.5 }, fullFlags);
ok(approx(r2.score10, 5.5), `risk penalty 2.5 subtracted from 8.0 → ~5.5 (got ${r2.score10})`);

// ── Coverage caps ──────────────────────────────────────────────────────────────
const r3 = composeMoundScore(comps, { ...fullFlags, pitcherSkillAvailable: false });
ok(r3.score10 <= 3.9, `missing pitcher skill caps at 3.9 (got ${r3.score10})`);

const r4 = composeMoundScore(comps, { ...fullFlags, confirmedStarter: false });
ok(r4.score10 <= 3.9, `unconfirmed starter caps at 3.9 (got ${r4.score10})`);

// ── Tier classification ───────────────────────────────────────────────────────
ok(classifyMoundTier(3.9, 5, 5) === "track", "3.9 → track");
ok(classifyMoundTier(5.9, 5, 5) === "watch", "5.9 → watch");
ok(classifyMoundTier(MOUND_PUBLISH_MIN_SCORE, 5, 5) === "strong", "6.0 → strong");
ok(classifyMoundTier(7.3, 7.0, 5.5) === "elite", "7.3 with skill≥7 workload≥5.5 → elite");
ok(classifyMoundTier(7.3, 5.0, 5.5) === "strong", "7.3 without skill≥7 → capped at strong");
ok(classifyMoundTier(8.8, 7.0, 6.0) === "nuclear", "8.8 with full gates → nuclear");

// ── Component scorer: pitcher skill unavailable when pitcher unknown ─────────
const psUnknown = computePitcherSkill({ pitcherKnown: false, kPer9: null });
ok(!psUnknown.available, "pitcherKnown=false → unavailable");
ok(psUnknown.drivers.length === 0, "unavailable → no drivers");

const psKnown = computePitcherSkill({ pitcherKnown: true, kPer9: 11.5 });
ok(psKnown.available, "high K/9 → available");
ok(psKnown.drivers.some((d) => d.key === "ps_k9"), "high K/9 → Pitcher High K% driver");

// ── Component scorer: workload unavailable when pitcher unknown ──────────────
const wlUnknown = computeWorkload({
  pitcherKnown: false, bbPer9: null, avgInningsPerStart: null, lastStartPitchCount: null, ipVarianceLast3: null, archetype: null,
});
ok(!wlUnknown.available, "workload: pitcherKnown=false → unavailable");

const wlLongLeash = computeWorkload({
  pitcherKnown: true, bbPer9: 2.0, avgInningsPerStart: 6.5, lastStartPitchCount: 95, ipVarianceLast3: 0.5, archetype: "ace",
});
ok(wlLongLeash.drivers.some((d) => d.key === "wl_leash"), "6.5 avg IP/start → Long Leash driver");

console.log(`\nmoundScoring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
