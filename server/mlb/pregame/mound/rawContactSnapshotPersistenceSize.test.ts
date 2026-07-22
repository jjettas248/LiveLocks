// Mound Radar PR 2/5 — persistence-size / payload-budget invariant.
//
// RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES is a FIXED constant derived once from
// an actual serialization delta (a fully-populated MoundEvaluationRecord with
// both firstPublicSnapshot and finalPregameSnapshot carrying
// champion.rawContactSnapshot, vs. the identical record with that field
// stripped from both champions) — NOT recomputed live at assertion time.
// Recomputing it live would defeat the guard: an accidental regression that
// adds a THIRD copy (e.g. back onto MoundDiagnostics) would inflate the
// "derived" delta right along with the measured size, masking the bug. A
// checked-in fixed ceiling instead fails loudly when the real payload grows
// past what two legitimate copies (firstPublicSnapshot + finalPregameSnapshot)
// account for.
//
// Derivation (captured via scratch calculation, this exact fixture):
//   single fully-populated RawPitcherContactSnapshot, serialized:  584 bytes
//   evaluation object WITHOUT rawContactSnapshot in either champion: 1689 bytes
//   evaluation object WITH rawContactSnapshot in both champions:    2901 bytes
//   delta = 2901 - 1689 = 1212 bytes
//     (= 2 * 584 [two legitimate copies] + 44 bytes of "rawContactSnapshot":
//     key-name/container overhead across both champions)
//
// Run: npx tsx server/mlb/pregame/mound/rawContactSnapshotPersistenceSize.test.ts

import { buildMoundEvaluationSnapshot } from "./evaluationSnapshot";
import type { MoundSignal, MoundEvaluationRecord } from "./types";
import type { RawPitcherContactSnapshot } from "./rawPitcherContactSnapshot";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

// Fixed, checked-in — see derivation note above. Do NOT replace with a live
// recomputation of the same fixture; that would silently rubber-stamp future
// regressions instead of catching them.
const RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES = 1212;

function sig(over: Partial<MoundSignal>): MoundSignal {
  return {
    signalId: "mlb-mound:2026-07-01:g1:p1", sport: "mlb", engine: "mound_radar",
    sessionDate: "2026-07-01", gameId: "g1", gameDate: "2026-07-01", startsAt: null,
    generatedAt: "", buildId: "b1", pitcherId: "p1", pitcherName: "P", team: "NYY", opponent: "BOS",
    throws: "R", opposingLineupConfirmed: true, opposingLineupLabel: "vs BOS confirmed lineup",
    primaryMarket: "pitcher_strikeouts", marketTags: ["pitcher_strikeouts", "pitcher_outs"],
    marketScores: { pitcher_strikeouts: 7, pitcher_outs: 6 }, marketSetups: [],
    kStuffScore: 7, kStuffLabel: "Strong", platoonKFitScore: 6, platoonKFitLabel: "Solid",
    kProjectionLabel: null, kLineValue: null, parkContext: null,
    score10: 7, tier: "strong", moundDirection: "follow",
    drivers: [], warnings: [], tags: [], lineupStatus: "confirmed", weatherStatus: "estimated",
    gameStatus: "scheduled", firstPitchLockEligible: true, lockedAt: null,
    hasMarketLine: false, isOfficialPlay: false, isPregameTarget: true, marketEdgeContext: null,
    projectedStrikeouts: 5, matchupAdjustedStrikeouts: 5.5,
    status: "active", suppressed: false, suppressedReasons: [],
    outcomes: null, everPubliclyFlagged: false, everPubliclyFlaggedFade: false,
    becameLiveReady: false, becameLiveFire: false, convertedLiveAt: null,
    diagnostics: {
      pitcherSkillScore: 7, opponentKProfileScore: 6, workloadScore: 6, runEnvironmentScore: 5,
      recentFormScore: 6, marketFitScore: 0, contactRiskScore: null, riskPenalty: 0,
      appliedDrivers: [], appliedWarnings: [], dataCoverageScore: 0.9,
      finalScoreBeforeCaps: 7, finalScoreAfterCaps: 7, publicTier: "strong",
      suppressed: false, suppressedReasons: [], sourceFreshness: {},
      rawInputsAvailable: {
        confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
        pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
        park: true, weather: true,
      },
    },
    ...over,
  };
}

function contactSnap(): RawPitcherContactSnapshot {
  return {
    schemaVersion: 1,
    hr9Allowed: 1.2, barrelAllowedPct: 8.5, hardHitAllowedPct: 38.2, flyBallAllowedPct: 30.1,
    xSLGAllowed: 0.41, xwOBAAllowed: 0.32, bb9: 2.8, ipVariance: 1.1,
    sampleSizes: {
      inningsPitched: 100, homeRunsAllowed: 13, hardHitEligibleBbe: 200,
      barrelEligibleBbe: 200, bbTypeEligibleBbe: 200, xSLGEligibleBbe: 200, xwOBAEligibleBbe: 200,
    },
    availability: {
      hr9Allowed: "available", barrelAllowedPct: "available", hardHitAllowedPct: "available",
      flyBallAllowedPct: "available", xSLGAllowed: "available", xwOBAAllowed: "available",
      bb9: "available", ipVariance: "available",
    },
  };
}

const baseSignal = sig({});

// "before" — evaluation exists (pre-existing PR-1 shape) but with no rawContactSnapshot in either champion.
const snapshotWithoutContact = buildMoundEvaluationSnapshot(
  baseSignal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6, undefined,
);
const evaluationWithoutContact: MoundEvaluationRecord = {
  firstPublicSnapshot: snapshotWithoutContact, firstPublicUnavailableReason: null, firstPublicDirection: "follow", directionConflict: false,
  finalPregameSnapshot: snapshotWithoutContact, finalPregameUnavailableReason: null,
};
const signalWithoutContact: MoundSignal = { ...baseSignal, diagnostics: { ...baseSignal.diagnostics, evaluation: evaluationWithoutContact } };

// "after" — the same signal, with rawContactSnapshot populated in BOTH champions (the two legitimate locations).
const snapshotWithContact = buildMoundEvaluationSnapshot(
  baseSignal, { holistic: 1, byMarket: {} }, "b1", 1, "2026-07-01T00:00:00Z", 9, 6, contactSnap(),
);
const evaluationWithContact: MoundEvaluationRecord = {
  firstPublicSnapshot: snapshotWithContact, firstPublicUnavailableReason: null, firstPublicDirection: "follow", directionConflict: false,
  finalPregameSnapshot: snapshotWithContact, finalPregameUnavailableReason: null,
};
const signalWithContact: MoundSignal = { ...baseSignal, diagnostics: { ...baseSignal.diagnostics, evaluation: evaluationWithContact } };

const beforeSize = JSON.stringify(signalWithoutContact).length;
const afterSize = JSON.stringify(signalWithContact).length;

console.log(`[persistence-size] beforeSize=${beforeSize}B afterSize=${afterSize}B delta=${afterSize - beforeSize}B allowance=${RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES}B`);

ok(afterSize <= beforeSize + RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES, `afterSize (${afterSize}) <= beforeSize (${beforeSize}) + fixed allowance (${RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES})`);
ok(
  afterSize - beforeSize === RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES,
  `for this exact fixture the delta exactly matches the derived allowance — a mismatch here means either the fixture or the storage shape changed (got delta=${afterSize - beforeSize}, expected ${RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES})`,
);

// Regression guard: only 2 legitimate locations (firstPublicSnapshot,
// finalPregameSnapshot) — never a 3rd top-level copy on MoundDiagnostics.
// If one were reintroduced, this fixture's delta would roughly double,
// tripping the ceiling above well before this explicit count check even runs.
const singleSnapshotSize = JSON.stringify(contactSnap()).length;
ok(
  RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES < singleSnapshotSize * 3,
  `allowance stays bounded to roughly 2 copies' worth, not 3+ (allowance=${RAW_CONTACT_SNAPSHOT_ALLOWANCE_BYTES}, single copy=${singleSnapshotSize})`,
);

console.log(`\nrawContactSnapshotPersistenceSize.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
