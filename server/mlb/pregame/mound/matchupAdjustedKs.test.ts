// Mound Radar — Matchup-Adjusted Ks invariants.
//
// Locks two things: (1) the enrichment math behaves sanely and stays within
// its documented caps for each of its four real inputs (multi-year K/9
// blend, opponent platoon K-rate, aggregate BvP, run environment, recent
// form), and (2) — the critical isolation guarantee — that
// moundOutcomeAttribution.ts's settlement baseline NEVER references this
// module or its output. Projected Ks (projectedStrikeoutsFromKPer9) alone
// decides mound_win/mound_calibration_miss; Matchup Adj. Ks is display-only.
// Run: npx tsx server/mlb/pregame/mound/matchupAdjustedKs.test.ts

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { computeMatchupAdjustedStrikeouts, type MatchupAdjustedKsInputs } from "./matchupAdjustedKs";
import { computeAvgInningsPerStart } from "./scoreUtils";

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseInputs(overrides: Partial<MatchupAdjustedKsInputs> = {}): MatchupAdjustedKsInputs {
  return {
    kPer9: 9.0,
    priorSeasonsKPer9: [],
    avgInningsPerStart: null,
    platoonKRate: null,
    opposingLineupConfirmed: false,
    runEnvironmentScore10: null,
    runEnvironmentAvailable: false,
    last3StartStrikeouts: null,
    bvpTotalAtBats: 0,
    bvpTotalStrikeouts: 0,
    ...overrides,
  };
}

// ── Null kPer9 → null projection, never fabricated ───────────────────────────
ok(computeMatchupAdjustedStrikeouts(baseInputs({ kPer9: null })) === null, "null kPer9 → null matchup-adjusted projection");

// ── Base uses avgInningsPerStart when present, falls back to fixed-6-inning ──
const withRealInnings = computeMatchupAdjustedStrikeouts(baseInputs({ kPer9: 9.0, avgInningsPerStart: 5.5 }));
const expectedRealInningsBase = (9.0 * 5.5) / 9; // 5.5
ok(withRealInnings === Math.round(expectedRealInningsBase * 10) / 10, `avgInningsPerStart base (got ${withRealInnings}, expected ~${expectedRealInningsBase})`);

const withoutInnings = computeMatchupAdjustedStrikeouts(baseInputs({ kPer9: 9.0, avgInningsPerStart: null }));
ok(withoutInnings === 6.0, `fallback to fixed 6-inning base when avgInningsPerStart null (got ${withoutInnings}, expected 6.0)`);

// ── Multi-year blend: current season weighted heaviest (5/4/3) ──────────────
// current=9.0, year-1=7.0, year-2=7.0 → blend = (9*5 + 7*4 + 7*3)/12 = 7.75
const withPriorSeasons = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, priorSeasonsKPer9: [7.0, 7.0], avgInningsPerStart: null }),
);
const blended = (9.0 * 5 + 7.0 * 4 + 7.0 * 3) / 12;
const expectedBlendBase = Math.round((blended * (6 / 9)) * 10) / 10;
ok(withPriorSeasons === expectedBlendBase, `multi-year blend lowers the base toward prior seasons (got ${withPriorSeasons}, expected ${expectedBlendBase})`);
ok((withPriorSeasons ?? 0) < 6.0, "a weaker multi-year history pulls the projection below the current-season-only value");

// ── Regression: a disqualified year-1 must NOT shift year-2 into year-1's weight ──
// (Codex review on PR #100: syncPitcherMultiYearStats used to omit a
// disqualified year entirely, compacting the array and giving year-2 data
// year-1's heavier weight. priorSeasonsKPer9 must stay positionally aligned
// [year-1, year-2] with null for a disqualified year.)
// current=9.0, year-1=null (disqualified), year-2=7.0 → year-2 keeps weight 3:
// blend = (9*5 + 7*3)/(5+3) = 8.25
const withSkippedYear1 = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, priorSeasonsKPer9: [null, 7.0], avgInningsPerStart: null }),
);
const correctBlend = (9.0 * 5 + 7.0 * 3) / (5 + 3);
const expectedSkippedYear1Base = Math.round((correctBlend * (6 / 9)) * 10) / 10;
const buggyBlend = (9.0 * 5 + 7.0 * 4) / (5 + 4); // what it would be if year-2 wrongly got year-1's weight
const buggyBase = Math.round((buggyBlend * (6 / 9)) * 10) / 10;
ok(
  withSkippedYear1 === expectedSkippedYear1Base,
  `disqualified year-1 (null) does not shift year-2's real value to a heavier weight (got ${withSkippedYear1}, expected ${expectedSkippedYear1Base}, buggy-would-be ${buggyBase})`,
);
ok(withSkippedYear1 !== buggyBase, "result must differ from the compacted-array bug's output");

// ── Opponent platoon K-rate modifier: raises/lowers within its cap ───────────
const aboveAvgOpponent = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, opposingLineupConfirmed: true, platoonKRate: 0.30 }), // well above ~0.223 league avg
);
const neutralOpponent = computeMatchupAdjustedStrikeouts(baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0 }));
ok((aboveAvgOpponent ?? 0) > (neutralOpponent ?? 0), "high-K opposing lineup raises the projection above neutral");

const belowAvgOpponent = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, opposingLineupConfirmed: true, platoonKRate: 0.15 }), // well below league avg
);
ok((belowAvgOpponent ?? 0) < (neutralOpponent ?? 0), "low-K opposing lineup lowers the projection below neutral");

const unconfirmedLineupIgnoresPlatoon = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, opposingLineupConfirmed: false, platoonKRate: 0.30 }),
);
ok(unconfirmedLineupIgnoresPlatoon === neutralOpponent, "opponent modifier stays neutral when lineup isn't confirmed, even if a platoon rate is passed");

// ── BvP modifier: sample floor, shrinkage, and cap ───────────────────────────
const bvpTooSmall = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, opposingLineupConfirmed: true, bvpTotalAtBats: 5, bvpTotalStrikeouts: 4 }),
);
ok(bvpTooSmall === neutralOpponent, "BvP sample below the 15-AB floor is ignored (stays neutral)");

const bvpHighKSample = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, opposingLineupConfirmed: true, bvpTotalAtBats: 60, bvpTotalStrikeouts: 24 }), // 40% K rate, full-confidence sample
);
ok((bvpHighKSample ?? 0) > (neutralOpponent ?? 0), "a large, high-K BvP sample raises the projection");

// ── Run environment: small, narrowly-capped nudge ────────────────────────────
const favorableRunEnv = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, runEnvironmentAvailable: true, runEnvironmentScore10: 9 }),
);
const unfavorableRunEnv = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, runEnvironmentAvailable: true, runEnvironmentScore10: 1 }),
);
ok((favorableRunEnv ?? 0) > (neutralOpponent ?? 0), "a run-suppressing environment nudges the projection up");
ok((unfavorableRunEnv ?? 0) < (neutralOpponent ?? 0), "an unfavorable run environment nudges the projection down");
ok(Math.abs((favorableRunEnv ?? 6) - 6.0) <= 6.0 * 0.06, "run-environment nudge stays within its documented small (~5%) cap");

// ── Recent form: capped additive nudge ───────────────────────────────────────
const hotRecentForm = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.0, avgInningsPerStart: 6.0, last3StartStrikeouts: [10, 11, 12] }), // well above 6.0 season pace
);
ok((hotRecentForm ?? 0) > (neutralOpponent ?? 0), "trending-up recent form raises the projection");
ok((hotRecentForm ?? 0) - (neutralOpponent ?? 0) <= 1.5, "recent-form nudge never exceeds its documented cap");

// ── Overall safety clamp — no combination of modifiers produces an outlier ──
const maxedOut = computeMatchupAdjustedStrikeouts(
  baseInputs({
    kPer9: 9.0,
    avgInningsPerStart: 6.0,
    opposingLineupConfirmed: true,
    platoonKRate: 0.40,
    bvpTotalAtBats: 100,
    bvpTotalStrikeouts: 50,
    runEnvironmentAvailable: true,
    runEnvironmentScore10: 10,
    last3StartStrikeouts: [15, 15, 15],
  }),
);
ok((maxedOut ?? 0) <= 6.0 * 1.4 + 0.05, `stacking every favorable modifier still respects the overall clamp (got ${maxedOut})`);

// ── Regression: swingman/call-up with relief innings inflating raw IP/GS ────
// 20 relief IP + 12 start IP over 2 starts = 32 total IP / 2 GS = 16.0 raw
// avgInningsPerStart (real per-start average ~6). Unclamped, this used to
// blow past matchupAdjustedKs.ts's OWN clamp band (base*1.4) because the
// clamp is self-referential against an already-wrong base — with
// blendedKPer9≈9.15 (Projected Ks 6.1) and raw avgInningsPerStart≈27.5, base
// ≈ 27.5 and base*1.4 ≈ 38.5, matching the observed real-world outlier
// (Matchup Adj. Ks 37.7 for a Projected Ks 6.1 pitcher) almost exactly.
const swingmanRaw = computeAvgInningsPerStart(2, 32);
ok(swingmanRaw !== null && swingmanRaw <= 8.0, `swingman raw ratio (16.0) is clamped to the realistic band (got ${swingmanRaw})`);

const extremeSwingmanRaw = computeAvgInningsPerStart(1, 27.5);
ok(extremeSwingmanRaw !== null && extremeSwingmanRaw <= 8.0, `extreme swingman raw ratio (27.5) is clamped to the realistic band (got ${extremeSwingmanRaw})`);

const swingmanProjection = computeMatchupAdjustedStrikeouts(
  baseInputs({ kPer9: 9.15, avgInningsPerStart: swingmanRaw }),
);
// With the clamp, base ≈ (9.15*8.0)/9 ≈ 8.13, so even the widest overall
// multiplier (1.4x) tops out ≈ 11.4 — nowhere near the observed 37.7-class outlier.
ok((swingmanProjection ?? 0) < 15, `swingman scenario no longer produces an outlier projection (got ${swingmanProjection})`);

// ── Isolation guarantee: moundOutcomeAttribution.ts never references this module ──
const attributionSrc = readFileSync(join(HERE, "moundOutcomeAttribution.ts"), "utf8");
ok(!/matchupAdjustedStrikeouts/.test(attributionSrc), "moundOutcomeAttribution.ts source does not reference matchupAdjustedStrikeouts");
ok(!/computeMatchupAdjustedStrikeouts/.test(attributionSrc), "moundOutcomeAttribution.ts source does not import/call computeMatchupAdjustedStrikeouts");
ok(!/matchupAdjustedKs/.test(attributionSrc), "moundOutcomeAttribution.ts source does not import from matchupAdjustedKs.ts at all");

// scoring.ts (score10/tier composite) must also never reference it.
const scoringSrc = readFileSync(join(HERE, "scoring.ts"), "utf8");
ok(!/matchupAdjustedStrikeouts|computeMatchupAdjustedStrikeouts|matchupAdjustedKs/.test(scoringSrc), "scoring.ts (score10/tier composite) does not reference matchupAdjustedKs in any form");

console.log(`\nmatchupAdjustedKs.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
