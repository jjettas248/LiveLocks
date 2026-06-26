// Pre-Game Power Radar — v2 SHADOW component scorer invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/math/components.test.ts

import { scoreBatterTruePower, BATTER_POWER_CAP } from "./scoreBatterTruePower";
import { scoreBatTrackingPower } from "./scoreBatTrackingPower";
import { scorePitcherHrVulnerability, PITCHER_VULN_CAP } from "./scorePitcherHrVulnerability";
import { scorePitchTypeInteraction } from "./scorePitchTypeInteraction";
import { scoreZoneLocationInteraction } from "./scoreZoneLocationInteraction";
import { scoreParkWeatherSprayInteraction } from "./scoreParkWeatherSprayInteraction";
import { scoreMarketConfirmation } from "./scoreMarketConfirmation";
import { scoreAvailabilitySuppressors } from "./scoreAvailabilitySuppressors";
import type {
  BatterTruePowerInputs, PitcherVulnerabilityInputs, PitchTypeInteractionInputs,
  ZoneLocationInputs, ParkWeatherSprayInputs,
} from "./mathTypes";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

const emptyBatter: BatterTruePowerInputs = {
  xISO: null, xSLG: null, xwOBAcon: null, barrelRatePct: null, hardHitRatePct: null,
  exitVelocity: null, maxEV: null, flyBallPct: null, hrFBRatioPct: null, pullRatePct: null,
  sweetSpotPct: null, hrPerPaSeason: null, paSample: null,
};

// ── Batter true power: missing data → no-op ───────────────────────────────────
const bpNone = scoreBatterTruePower(emptyBatter);
ok(!bpNone.available && bpNone.logOdds === 0, "batter power: all-null → no-op");
ok(scoreBatterTruePower(null).logOdds === 0, "batter power: null input → no-op");

// Elite power → positive, capped.
const bpElite = scoreBatterTruePower({
  ...emptyBatter, xISO: 0.28, barrelRatePct: 18, hrFBRatioPct: 28, maxEV: 117,
  hardHitRatePct: 55, xSLG: 0.60, paSample: 600,
});
const bpWeak = scoreBatterTruePower({
  ...emptyBatter, xISO: 0.08, barrelRatePct: 1, hrFBRatioPct: 4, maxEV: 100,
  hardHitRatePct: 25, xSLG: 0.30, paSample: 600,
});
ok(bpElite.available && bpElite.logOdds > 0, "elite power → positive logOdds");
ok(bpWeak.logOdds < 0, "weak power → negative logOdds");
ok(bpElite.logOdds > bpWeak.logOdds, "elite > weak power logOdds");
ok(Math.abs(bpElite.logOdds) <= BATTER_POWER_CAP + 1e-9, "batter power respects cap");

// Shrinkage: tiny sample mutes the same elite line.
const bpEliteSmall = scoreBatterTruePower({
  ...emptyBatter, xISO: 0.28, barrelRatePct: 18, hrFBRatioPct: 28, maxEV: 117,
  hardHitRatePct: 55, xSLG: 0.60, paSample: 15,
});
ok(bpEliteSmall.logOdds < bpElite.logOdds, "small sample mutes elite power");

// ── Bat tracking: unavailable → no-op + null score ────────────────────────────
const btNone = scoreBatTrackingPower({
  avgBatSpeed: null, fastSwingRatePct: null, avgSwingLength: null,
  squaredUpPerSwingPct: null, blastPerSwingPct: null, swingSample: null,
});
ok(!btNone.available && btNone.score100 === null, "bat tracking: unavailable → no-op, null score");
const btFast = scoreBatTrackingPower({
  avgBatSpeed: 77, fastSwingRatePct: 45, avgSwingLength: 7.8, squaredUpPerSwingPct: 32,
  blastPerSwingPct: 20, swingSample: 300,
});
ok(btFast.available && btFast.logOdds > 0 && (btFast.score100 ?? 0) > 50, "fast bat → positive + score>50");

// ── Pitcher vulnerability: unknown → no-op; HR/9 monotone ─────────────────────
const pvUnknown = scorePitcherHrVulnerability({
  pitcherKnown: false, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: 2.0,
  hrPer9Overall: 2.0, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: 500,
});
ok(!pvUnknown.available && pvUnknown.logOdds === 0, "pitcher unknown → no-op");
const base: PitcherVulnerabilityInputs = {
  pitcherKnown: true, batterHand: "R", pitcherThrows: "L", hrPer9VsHand: null,
  hrPer9Overall: null, barrelAllowedPct: null, hardHitAllowedPct: null, flyBallAllowedPct: null, bfSample: 400,
};
const pvHittable = scorePitcherHrVulnerability({ ...base, hrPer9VsHand: 2.1 });
const pvStingy = scorePitcherHrVulnerability({ ...base, hrPer9VsHand: 0.7 });
ok(pvHittable.logOdds > 0 && pvStingy.logOdds < 0, "HR/9 sign: hittable + / stingy -");
ok(pvHittable.logOdds > pvStingy.logOdds, "higher HR/9 → higher vulnerability logOdds");
ok(Math.abs(pvHittable.logOdds) <= PITCHER_VULN_CAP + 1e-9, "pitcher vuln respects cap");

// ── Pitch-type interaction: usage weighting + sparse shrink ───────────────────
// Batter mashes fastballs; pitcher is fastball-heavy → strong positive.
const ptHeavyFb: PitchTypeInteractionInputs = {
  families: [
    { family: "fastball", usageShare: 0.7, batterXslg: 0.62, batterWhiffPct: 15, batterSample: 300 },
    { family: "breaking", usageShare: 0.2, batterXslg: 0.30, batterWhiffPct: 35, batterSample: 200 },
    { family: "offspeed", usageShare: 0.1, batterXslg: 0.33, batterWhiffPct: 30, batterSample: 100 },
  ],
};
// Same batter damage, but pitcher rarely throws the pitch they mash.
const ptLightFb: PitchTypeInteractionInputs = {
  families: [
    { family: "fastball", usageShare: 0.15, batterXslg: 0.62, batterWhiffPct: 15, batterSample: 300 },
    { family: "breaking", usageShare: 0.6, batterXslg: 0.30, batterWhiffPct: 35, batterSample: 200 },
    { family: "offspeed", usageShare: 0.25, batterXslg: 0.33, batterWhiffPct: 30, batterSample: 100 },
  ],
};
const ptH = scorePitchTypeInteraction(ptHeavyFb);
const ptL = scorePitchTypeInteraction(ptLightFb);
ok(ptH.logOdds > ptL.logOdds, "usage weighting: facing-your-strength > avoiding-it");
// Sparse batter sample shrinks contribution toward 0.
const ptSparse = scorePitchTypeInteraction({
  families: [{ family: "fastball", usageShare: 0.7, batterXslg: 0.62, batterWhiffPct: 15, batterSample: 5 }],
});
const ptRich = scorePitchTypeInteraction({
  families: [{ family: "fastball", usageShare: 0.7, batterXslg: 0.62, batterWhiffPct: 15, batterSample: 400 }],
});
ok(Math.abs(ptSparse.logOdds) < Math.abs(ptRich.logOdds), "sparse pitch-type sample shrinks toward 0");
ok(scorePitchTypeInteraction({ families: [] }).logOdds === 0, "no families → no-op");

// ── Zone/location: hot-zone × mistake-zone overlap rewarded ───────────────────
const zHot: ZoneLocationInputs = {
  batterHeartXslg: 0.60, batterElevatedFbXslg: 0.55, batterLowBreakingXslg: 0.30,
  pitcherHeartRate: 0.8, pitcherMiddleMiddleRate: 0.5, pitcherHangerRate: 0.2,
};
const zCold: ZoneLocationInputs = {
  batterHeartXslg: 0.30, batterElevatedFbXslg: 0.30, batterLowBreakingXslg: 0.30,
  pitcherHeartRate: 0.1, pitcherMiddleMiddleRate: 0.05, pitcherHangerRate: 0.05,
};
ok(scoreZoneLocationInteraction(zHot).logOdds > scoreZoneLocationInteraction(zCold).logOdds,
  "zone overlap: hot-bat × mistake-pitcher > cold-bat × precise-pitcher");
ok(scoreZoneLocationInteraction({
  batterHeartXslg: null, batterElevatedFbXslg: null, batterLowBreakingXslg: null,
  pitcherHeartRate: null, pitcherMiddleMiddleRate: null, pitcherHangerRate: null,
}).available === false, "zone: all-null → unavailable (no-op)");

// ── Park/weather/spray: matching fit rewarded, poor fit suppressed ────────────
const goodFit: ParkWeatherSprayInputs = {
  parkHrFactor: 1.25, parkHrFactorHand: 1.30, isIndoors: false, weatherAvailable: true,
  temperatureF: 88, windSpeedMph: 15, windDirection: "out", batterPullAirShare: 0.8,
};
const badFit: ParkWeatherSprayInputs = {
  parkHrFactor: 0.85, parkHrFactorHand: 0.82, isIndoors: false, weatherAvailable: true,
  temperatureF: 52, windSpeedMph: 15, windDirection: "in", batterPullAirShare: 0.3,
};
ok(scoreParkWeatherSprayInteraction(goodFit).logOdds > 0, "good park/wind/temp fit → positive");
ok(scoreParkWeatherSprayInteraction(badFit).logOdds < 0, "poor fit → negative");
ok(scoreParkWeatherSprayInteraction(goodFit).logOdds > scoreParkWeatherSprayInteraction(badFit).logOdds,
  "good fit > poor fit");
// Indoors ignores wind/temp; relies on park factor only.
const indoor = scoreParkWeatherSprayInteraction({ ...goodFit, isIndoors: true });
ok(indoor.available, "indoor still scores park factor");

// ── Market confirmation: no-op when unavailable; confirms when present ─────────
ok(scoreMarketConfirmation({ hrOddsAvailable: false, impliedHrProbability: null, noVigImpliedHrProbability: null })
  .logOdds === 0, "no odds → no-op (market never creates candidate)");
const mktHot = scoreMarketConfirmation({ hrOddsAvailable: true, impliedHrProbability: 0.18, noVigImpliedHrProbability: 0.16 });
const mktCold = scoreMarketConfirmation({ hrOddsAvailable: true, impliedHrProbability: 0.05, noVigImpliedHrProbability: 0.045 });
ok(mktHot.logOdds > 0 && mktCold.logOdds < 0, "market sign tracks implied prob vs reference");

// ── Availability suppressors: penalty + confidence damage ─────────────────────
const supNone = scoreAvailabilitySuppressors({ confirmedActive: true, lateScratchRisk: false, restDayRisk: false, platoonSubRisk: false });
ok(supNone.penaltyLogOdds === 0 && supNone.confidenceFactor === 1, "no risks → no penalty");
const supScratch = scoreAvailabilitySuppressors({ confirmedActive: false, lateScratchRisk: true, restDayRisk: false, platoonSubRisk: false });
ok(supScratch.penaltyLogOdds > 0 && supScratch.confidenceFactor < 1, "scratch risk → penalty + confidence damage");
ok(supScratch.suppressors.includes("not_confirmed_active"), "scratch labelled");
ok(scoreAvailabilitySuppressors(null).available === false, "null suppressor input → no-op");

console.log(`\ncomponents.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
