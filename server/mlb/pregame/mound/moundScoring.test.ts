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
import { computeRunEnvironment } from "./runEnvironment";

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
ok(
  classifyMoundTier(MOUND_PUBLISH_MIN_SCORE - 0.1, 5, 5) === "watch",
  `just under MOUND_PUBLISH_MIN_SCORE (${MOUND_PUBLISH_MIN_SCORE - 0.1}) → watch`,
);
ok(
  classifyMoundTier(MOUND_PUBLISH_MIN_SCORE, 5, 5) === "strong",
  `MOUND_PUBLISH_MIN_SCORE (${MOUND_PUBLISH_MIN_SCORE}) → strong`,
);
// Regression: calibration fix — a score that cleared only "watch" under the
// old 6.0 bar must now clear "strong" under the recalibrated 5.5 bar (see
// scoring.ts's MOUND_PUBLISH_MIN_SCORE comment for the league-average math).
ok(classifyMoundTier(5.7, 5, 5) === "strong", "5.7 (below old 6.0 bar, above new 5.5 bar) → strong");
ok(classifyMoundTier(7.3, 7.0, 5.5) === "elite", "7.3 with skill≥7 workload≥5.5 → elite");
ok(classifyMoundTier(7.3, 5.0, 5.5) === "strong", "7.3 without skill≥7 → capped at strong");
ok(classifyMoundTier(8.8, 7.0, 6.0) === "nuclear", "8.8 with full gates → nuclear");

// ── Component scorer: pitcher skill unavailable when pitcher unknown ─────────
const psUnknown = computePitcherSkill({ pitcherKnown: false, kPer9: null, swStrPct: null, cswPct: null, missesBatsFamily: null });
ok(!psUnknown.available, "pitcherKnown=false → unavailable");
ok(psUnknown.drivers.length === 0, "unavailable → no drivers");

const psKnown = computePitcherSkill({ pitcherKnown: true, kPer9: 11.5, swStrPct: null, cswPct: null, missesBatsFamily: null });
ok(psKnown.available, "high K/9 → available");
ok(psKnown.drivers.some((d) => d.key === "ps_k9"), "high K/9 → Pitcher High K% driver");

// ── v2: SwStr%/CSW% now real, from aggregatePitcherStuffMetrics ──────────────
const psStuffMetrics = computePitcherSkill({
  pitcherKnown: true, kPer9: 9.5, swStrPct: 15.0, cswPct: 32.0, missesBatsFamily: null,
});
ok(psStuffMetrics.drivers.some((d) => d.key === "ps_swstr"), "high SwStr% → Pitcher High SwStr% driver");
ok(psStuffMetrics.drivers.some((d) => d.key === "ps_csw"), "high CSW% → Pitcher High CSW% driver");

// ── v2: Pitch Mix Misses Bats fires only when a family clears usage+whiff floors ──
const psMissesBats = computePitcherSkill({
  pitcherKnown: true, kPer9: 9.0, swStrPct: null, cswPct: null,
  missesBatsFamily: { family: "breaking", whiffPct: 42.5, usagePct: 30 },
});
const missesBatsDriver = psMissesBats.drivers.find((d) => d.key === "ps_misses_bats");
ok(missesBatsDriver !== undefined, "missesBatsFamily set → Pitch Mix Misses Bats driver present");
ok(missesBatsDriver?.label === "Pitch Mix Misses Bats", "driver label is exactly 'Pitch Mix Misses Bats'");
ok(missesBatsDriver?.evidence?.includes("Breaking Ball") ?? false, `evidence names the pitch family (got "${missesBatsDriver?.evidence}")`);

const psNoMissesBats = computePitcherSkill({
  pitcherKnown: true, kPer9: 9.0, swStrPct: null, cswPct: null, missesBatsFamily: null,
});
ok(!psNoMissesBats.drivers.some((d) => d.key === "ps_misses_bats"), "missesBatsFamily null → no Pitch Mix Misses Bats driver");

// ── Component scorer: workload unavailable when pitcher unknown ──────────────
const wlUnknown = computeWorkload({
  pitcherKnown: false, bbPer9: null, avgInningsPerStart: null, lastStartPitchCount: null, lastStartInningsPitched: null, ipVarianceLast3: null, archetype: null,
});
ok(!wlUnknown.available, "workload: pitcherKnown=false → unavailable");

const wlLongLeash = computeWorkload({
  pitcherKnown: true, bbPer9: 2.0, avgInningsPerStart: 6.5, lastStartPitchCount: 95, lastStartInningsPitched: 6.5, ipVarianceLast3: 0.5, archetype: "ace",
});
ok(wlLongLeash.drivers.some((d) => d.key === "wl_leash"), "6.5 avg IP/start → Long Leash driver");

// ── Regression: pitches/inning must use the SAME start's innings, not the
// season average — a short/aberrant outing must not misread as "efficient".
const wlShortOuting = computeWorkload({
  pitcherKnown: true, bbPer9: 2.0, avgInningsPerStart: 7.0, lastStartPitchCount: 45, lastStartInningsPitched: 3.0, ipVarianceLast3: 1.0, archetype: null,
});
ok(
  !wlShortOuting.drivers.some((d) => d.key === "wl_efficient"),
  "45 pitches over an actual 3.0 IP outing (15 pitches/inning) must NOT fire Efficient Pitch Profile, even though season avg is 7.0 IP/start",
);

const wlTrulyEfficient = computeWorkload({
  pitcherKnown: true, bbPer9: 2.0, avgInningsPerStart: 7.0, lastStartPitchCount: 45, lastStartInningsPitched: 7.0, ipVarianceLast3: 0.3, archetype: null,
});
ok(
  wlTrulyEfficient.drivers.some((d) => d.key === "wl_efficient"),
  "45 pitches over an actual 7.0 IP outing (6.4 pitches/inning) SHOULD fire Efficient Pitch Profile",
);

// ── Regression: computeRunEnvironment must never double-count one signal
// into two positive drivers (the ≥2-positive-driver publish gate must reflect
// genuinely independent evidence, not the same park-factor threshold twice).
const reParkOnly = computeRunEnvironment({
  venueName: "Comerica Park", parkFactorRuns: 0.80, isIndoors: false, weatherAvailable: false,
  temperatureF: null, windMph: null, windDirection: null,
});
const reParkOnlyPositives = reParkOnly.drivers.filter((d) => d.direction === "positive");
ok(
  reParkOnlyPositives.length === 1,
  `park factor alone must produce exactly 1 positive driver, not a duplicate (got ${reParkOnlyPositives.length}: ${reParkOnlyPositives.map((d) => d.key).join(",")})`,
);

const reParkAndTemp = computeRunEnvironment({
  venueName: "Comerica Park", parkFactorRuns: 0.80, isIndoors: false, weatherAvailable: true,
  temperatureF: 50, windMph: 5, windDirection: "calm",
});
const reComboPositives = reParkAndTemp.drivers.filter((d) => d.direction === "positive");
ok(
  reComboPositives.length === 3,
  `park (1) + cool temp (1) + combo "Low Run Environment" (1) = exactly 3 positive drivers, not the pre-fix 5 (got ${reComboPositives.length}: ${reComboPositives.map((d) => d.key).join(",")})`,
);

// ── Regression: MoundParkContext.driverText must be populated when available.
ok(
  reParkAndTemp.parkContext.driverText != null,
  `driverText must be populated for an available parkContext, not left null/undefined (got ${reParkAndTemp.parkContext.driverText})`,
);

console.log(`\nmoundScoring.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
