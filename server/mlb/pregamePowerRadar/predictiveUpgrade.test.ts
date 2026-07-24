// Consolidated Pregame Radar predictive-upgrade invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/predictiveUpgrade.test.ts

import { PARK_DIMENSIONS_2026_COUNT, getPullSideParkGeometry } from "./parkDimensions";
import { aggregateBatTrackingResearch } from "./batTrackingResearch";
import { scoreBatTrackingPower } from "./math/scoreBatTrackingPower";
import { scoreParkWeatherSprayInteraction } from "./math/scoreParkWeatherSprayInteraction";
import { countPositivePregameEvidenceFamilies } from "./evidenceFamilies";
import { computeMatchupFit } from "./matchupFit";
import { countPositiveMoundEvidenceFamilies } from "../pregame/mound/evidenceFamilies";
import { computeOpponentKProfile } from "../pregame/mound/opponentKProfile";
import { deriveFrozenMoundMarketRecommendation } from "../pregame/mound/marketRecommendation";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// 30 current MLB parks are frozen from the 2026 Statcast dimensions table.
ok(PARK_DIMENSIONS_2026_COUNT === 30, "park geometry covers 30 MLB parks");
const yankeeL = getPullSideParkGeometry("Yankee Stadium", "L", "R");
const yankeeR = getPullSideParkGeometry("Yankee Stadium", "R", "L");
ok(yankeeL != null && yankeeR != null, "Yankee geometry resolves both sides");
ok((yankeeL?.pullFenceDistanceFt ?? 999) < (yankeeR?.pullFenceDistanceFt ?? 0), "Yankee lefty pull sector is shorter than righty pull sector");

// Geometry must move the shadow park term in the intuitive direction while all
// observed park/weather inputs are held fixed.
const parkBase = {
  parkHrFactor: 1.0,
  parkHrFactorHand: 1.0,
  isIndoors: false,
  weatherAvailable: true,
  temperatureF: 72,
  windSpeedMph: 0,
  windDirection: "calm" as const,
  batterPullAirShare: 0.65,
  avgFenceDistanceFt: 370,
  avgFenceHeightFt: 10,
  avgHrDistanceFt: 382,
};
const shortPorch = scoreParkWeatherSprayInteraction({ ...parkBase, pullFenceDistanceFt: 335, pullFenceHeightFt: 7 });
const deepWall = scoreParkWeatherSprayInteraction({ ...parkBase, pullFenceDistanceFt: 400, pullFenceHeightFt: 14 });
ok(shortPorch.logOdds > deepWall.logOdds, "short/lower pull fence > deep/tall pull fence");

// Raw bat tracking uses official 75mph fast-swing and 5–20° ideal-angle bands.
const rows: Array<Record<string, string>> = [];
for (let i = 0; i < 30; i++) {
  rows.push({
    bat_speed: i < 24 ? "77" : "72",
    swing_length: "7.1",
    attack_angle: i < 21 ? "13" : "28",
    swing_path_tilt: "24",
  });
}
const bt = aggregateBatTrackingResearch(rows);
ok(bt.fastSwingRatePct === 80, "fast swing rate uses 75mph threshold");
ok(bt.idealAttackAngleRatePct === 70, "ideal attack angle uses 5-20 degree band");
ok(bt.squaredUpPerSwingPct === null && bt.blastPerSwingPct === null, "squared-up/blasts are never fabricated");
const btScore = scoreBatTrackingPower({ ...bt });
ok(btScore.available && btScore.logOdds > 0, "speed + ideal angle produce positive shadow bat-tracking term");

// Public evidence is one vote per independent model family, not one per chip.
ok(countPositivePregameEvidenceFamilies({
  batterPowerScore: 8.5,
  pitcherVulnerabilityScore: 5.0,
  matchupFitScore: 5.0,
  parkWeatherScore: 5.0,
  lineupOpportunityScore: 5.0,
  nearHrRecentFormScore: 5.0,
}) === 1, "multiple power chips still count as one Plate evidence family");
ok(countPositiveMoundEvidenceFamilies({
  pitcherSkillScore: 8.0,
  opponentKProfileScore: 5.0,
  workloadScore: 5.0,
  runEnvironmentScore: 5.0,
  recentFormScore: 5.0,
}) === 1, "confirmed/context chips cannot create a second Mound evidence family");

// Hitter-side K propensity must materially move the Mound matchup even when the
// pitcher's own handedness K split is identical.
const moundBase = {
  pitcherKnown: true,
  opposingLineupConfirmed: true,
  kRateVsLHB: 0.27,
  kRateVsRHB: 0.27,
  opposingLineupHandedness: { left: 4, right: 4, switchHit: 1 },
  lineupBatterKCoverage: 1,
  lineupHighKShare: null,
};
const highK = computeOpponentKProfile({ ...moundBase, lineupBatterKRate: 0.30 });
const lowK = computeOpponentKProfile({ ...moundBase, lineupBatterKRate: 0.16 });
ok(highK.score10 > lowK.score10, "high-K opposing hitters raise K matchup score");
ok((highK.matchupKRate ?? 0) > (lowK.matchupKRate ?? 1), "high-K opposing hitters raise matchup K rate");

// BvP under 10 AB is context only: no final-score nudge and no elite-blocking direction.
const smallBvp = computeMatchupFit({
  batterHand: "R",
  pitcherThrows: "L",
  batterOpsVsHand: 0.9,
  batterXslgVsDominantFamily: 0.55,
  pullRatePct: 50,
  parkFavorsPull: true,
  bvpPlateAppearances: 8,
  bvpHr: 2,
  bvpHits: 5,
  bvpAtBats: 8,
  bvpStrikeouts: 1,
  bvpOps: 1.3,
  bvpAvg: 0.625,
});
ok(smallBvp.bvpModifier === 0, "BvP <10 AB cannot move composite score");
ok(smallBvp.bvpDirection === "neutral", "BvP <25 AB cannot independently gate Elite");

// Mound sportsbook side is projection-vs-line, independent of Follow/Fade.
const frozen: any = {
  frozenAt: "2026-07-24T12:00:00.000Z",
  champion: {
    postedLine: {
      strikeouts: { market: "pitcher_strikeouts", line: 6.5, lineUnavailableReason: null, sourceTimestamp: null },
      outs: { market: "pitcher_outs", line: null, lineUnavailableReason: "not_available", sourceTimestamp: null },
    },
    predictionTimeProjections: { projectedStrikeouts: 6.0, matchupAdjustedStrikeouts: 5.2 },
    frozenProductionBaseline: { strikeouts: { value: 6.0 }, outs: { value: 18 } },
  },
};
const marketRead = deriveFrozenMoundMarketRecommendation("pitcher_strikeouts", frozen);
ok(marketRead.side === "UNDER", "frozen 5.2 projection vs 6.5 line yields UNDER market read");
ok(marketRead.margin === -1.3, "market margin is frozen projection minus frozen line");

console.log(`[predictiveUpgrade] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
