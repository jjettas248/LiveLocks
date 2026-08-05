// Mound Radar — public-recommendation settlement lane invariants.
// Run: npx tsx server/mlb/pregame/mound/moundPublicSettlement.test.ts
//
// Locks the two-lane settlement contract:
//
//   LANE A (market)        A real sportsbook bet, frozen strictly pregame,
//                          settles Cashed/Missed/Push against its own frozen
//                          side + line. Absolute precedence over every
//                          model-performance label.
//   LANE B (model_review)  Model-performance wording ("Performed Above/Below
//                          Baseline", "Follow/Fade Read Confirmed") is legal
//                          ONLY where no sportsbook bet was ever recommended.
//   integrity_gap          A public recommendation whose frozen bet cannot be
//                          recovered is surfaced as such — never silently
//                          relabelled as model performance, never fabricated
//                          into a Cashed off the engine baseline.
//
// Also pins the root-cause regression this suite was written for: a card
// publicly surfaced as a FOLLOW read whose `moundDirection` column was later
// recomputed to "fade" by a post-first-pitch rebuild must still settle and
// label under Follow rules (resolveMoundSettlementDirection).

import {
  buildMoundSettlementView,
  deriveMoundMarketOutcome,
  deriveMoundOutcome,
  resolveMoundSettlementDirection,
  resolveMoundSettlementLane,
} from "./moundOutcomeAttribution";
import { deriveFrozenMoundMarketRecommendation } from "./marketRecommendation";
import { planMoundMarketOutcomeBackfill } from "./moundMarketOutcomeBackfill";
import { carryForwardMoundGradedState } from "./moundGradedStateCarry";
import type { MoundDirection } from "./moundDirection";
import type { MoundEvaluationSnapshot, MoundOutcome, MoundSignal } from "./types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log("\n=== Mound Radar — Public Settlement Lane Suite ===\n");

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Frozen pregame snapshot carrying a real posted strikeout line + projection. */
function snapshotWithKLine(line: number | null, projection: number | null, lineUnavailableReason: string | null = null): MoundEvaluationSnapshot {
  return {
    frozenAt: "2026-07-20T22:05:00.000Z",
    buildId: "build-1",
    candidatePoolSize: 20,
    champion: {
      score10: 6.4,
      tier: "strong",
      componentScores: {
        pitcherSkillScore: 7,
        opponentKProfileScore: 6,
        workloadScore: 6,
        runEnvironmentScore: 5,
        recentFormScore: 6,
      },
      marketScores: {},
      drivers: [],
      rank: { holistic: 3, byMarket: {} },
      dataCoverageScore: 0.9,
      lineupStatus: "confirmed",
      weatherStatus: "estimated",
      frozenProductionBaseline: { strikeouts: { value: 5.4 }, outs: { value: 15.9 } },
      postedLine: {
        strikeouts: { line, lineUnavailableReason: line == null ? lineUnavailableReason ?? "no_line_posted" : null, sourceTimestamp: null, sportsbook: "draftkings" },
        outs: { line: null, lineUnavailableReason: "no_data_source", sourceTimestamp: null, sportsbook: null },
      },
      predictionTimeProjections: { matchupAdjustedStrikeouts: projection },
    },
  };
}

/**
 * Mirrors moundShadowOutcomes.ts's stampMarketOutcome adaptation exactly:
 * strikeouts is the sole settlement market, the sportsbook side comes from
 * the FROZEN pregame recommendation, and the signal's Follow/Fade model
 * read is never passed into market settlement.
 */
function settleMarket(
  snapshot: MoundEvaluationSnapshot | null,
  actual: number | null,
) {
  const frozenLine = snapshot?.champion.postedLine.strikeouts ?? null;
  const recommendation = deriveFrozenMoundMarketRecommendation("pitcher_strikeouts", snapshot);
  const marketSettlementDirection: MoundDirection =
    recommendation.side === "OVER" ? "follow" : recommendation.side === "UNDER" ? "fade" : null;
  return deriveMoundMarketOutcome({
    moundDirection: marketSettlementDirection,
    frozenLine,
    lineFrozenAt: snapshot?.frozenAt ?? null,
    actual,
  });
}

// ── Public OVER: settles against the frozen line, not the engine baseline ────
{
  // Projection 7.2 vs line 5.5 → margin +1.7 → OVER recommended.
  const over = snapshotWithKLine(5.5, 7.2);
  ok(settleMarket(over, 6).marketOutcome === "cashed", "OVER 5.5, final 6 → cashed");
  ok(settleMarket(over, 5).marketOutcome === "missed", "OVER 5.5, final 5 → missed");
  ok(settleMarket(over, 6).sportsbookLine === 5.5, "cashed OVER grades against the frozen 5.5, never the 5.4 engine baseline");
  ok(settleMarket(over, 6).lineSource === "draftkings", "sportsbook provenance survives settlement");
}

// ── Public UNDER: opposite comparison, same frozen line ──────────────────────
{
  // Projection 4.0 vs line 5.5 → margin -1.5 → UNDER recommended.
  const under = snapshotWithKLine(5.5, 4.0);
  ok(settleMarket(under, 5).recommendedSide === "UNDER", "frozen projection below the line → UNDER side");
  ok(settleMarket(under, 5).marketOutcome === "cashed", "UNDER 5.5, final 5 → cashed");
  ok(settleMarket(under, 6).marketOutcome === "missed", "UNDER 5.5, final 6 → missed");
}

// ── Push: integer line matched exactly ──────────────────────────────────────
{
  const integerLine = snapshotWithKLine(6, 7.5);
  ok(settleMarket(integerLine, 6).marketOutcome === "push", "OVER 6, final 6 → push");
  const integerUnder = snapshotWithKLine(6, 4.5);
  ok(settleMarket(integerUnder, 6).marketOutcome === "push", "UNDER 6, final 6 → push (side-independent)");
}

// ── Follow/Fade is NEVER remapped onto the sportsbook side ──────────────────
{
  // Model read is Follow; the frozen projection (4.0) sits BELOW the posted
  // line (5.5), so the sportsbook recommendation is UNDER. Settlement must
  // use UNDER — a Follow read does not mean "Over".
  const snapshot = snapshotWithKLine(5.5, 4.0);
  const market = settleMarket(snapshot, 5);
  ok(market.recommendedSide === "UNDER", "Follow model read + below-the-line projection → UNDER official side (never Follow⇒OVER)");
  ok(market.marketOutcome === "cashed", "Follow model read still settles as a cashed UNDER");

  const view = buildMoundSettlementView(
    { finalStrikeouts: 5, seasonBaselineValue: 5.4, ...market } as MoundOutcome,
    "follow",
    true,
    false,
  );
  ok(view.recommendedSide === "UNDER", "settlement view surfaces the frozen UNDER side, not the Follow model read");
  ok(view.settlementDirection === "follow", "model direction stays Follow — the two concepts never overwrite each other");
  ok(view.settlementLane === "market", "a real frozen bet always lands in the market lane");
}

// ── The backfill planner must not infer side from Follow/Fade either ────────
{
  const snapshot = snapshotWithKLine(5.5, 4.0); // projection below line → UNDER
  const plan = planMoundMarketOutcomeBackfill([
    {
      signalId: "mlb-mound:2026-07-20:1:99",
      primaryMarket: "pitcher_strikeouts",
      moundDirection: "follow", // model read says Follow — must not become OVER
      finalStrikeouts: 5,
      finalOutsRecorded: 15,
      alreadyHasMarketOutcome: false,
      finalPregameSnapshot: snapshot,
    },
  ]);
  ok(plan.length === 1, "backfill plans the row with a provable frozen line");
  ok(plan[0]?.patch.recommendedSide === "UNDER", "backfill takes the side from the frozen recommendation, never from moundDirection");
  ok(plan[0]?.patch.marketOutcome === "cashed", "backfilled UNDER 5.5 with final 5 → cashed");
}

// ── No synthetic settlement: a missing line never borrows the baseline ──────
{
  const noLine = snapshotWithKLine(null, 7.2);
  const result = settleMarket(noLine, 6);
  ok(result.marketOutcome === "unavailable", "no posted line → unavailable, never graded against the engine baseline");
  ok(result.sportsbookLine === null, "no line is reported as null, never the 5.4 engine baseline");
  ok(result.marketUnavailableReason === "no_line_posted", "the missing component is named");

  const noSnapshot = settleMarket(null, 6);
  ok(noSnapshot.marketUnavailableReason === "no_pregame_snapshot", "a missing frozen snapshot is reported as such");
}

// ── Lane precedence ─────────────────────────────────────────────────────────
{
  ok(resolveMoundSettlementLane("cashed", null, true) === "market", "a real market result always wins the lane");
  ok(resolveMoundSettlementLane("missed", null, false) === "market", "market lane doesn't depend on public status");
  ok(
    resolveMoundSettlementLane("unavailable", "no_pregame_snapshot", true) === "integrity_gap",
    "public recommendation + unrecoverable frozen bet → integrity_gap, never model_review",
  );
  ok(
    resolveMoundSettlementLane("unavailable", "not_stamped", true) === "integrity_gap",
    "public recommendation that never ran market settlement → integrity_gap",
  );
  ok(
    resolveMoundSettlementLane("unavailable", "no_pregame_snapshot", false) === "model_review",
    "a non-public card is never an integrity gap — nothing was recommended to anyone",
  );
  ok(
    resolveMoundSettlementLane("unavailable", "market_has_no_line_source", true) === "model_review",
    "a public MODEL READ on a market with no odds feed legitimately settles in the model lane",
  );
  ok(resolveMoundSettlementLane("unavailable", "no_edge", true) === "model_review", "no edge → no bet was recommended → model lane");
}

// ── Durable public exposure survives the final-state transition ─────────────
{
  // outcomes.userVisible is the transient field: deriveMoundOutcome stamps it
  // false whenever the BASELINE comparison misses, even for a card whose
  // MARKET bet cashed. The settlement view must ignore it entirely.
  const market = settleMarket(snapshotWithKLine(5.5, 7.2), 6);
  const outcomes: MoundOutcome = {
    finalStrikeouts: 6,
    seasonBaselineValue: 8.0, // baseline missed…
    outcome: "mound_calibration_miss",
    userVisible: false, // …so the transient visibility flag is false
    ...market, // …but the real frozen bet cashed
  };
  const view = buildMoundSettlementView(outcomes, "follow", true, false);
  ok(view.isPublicRecommendation === true, "durable everPubliclyFlagged decides public status, not outcomes.userVisible");
  ok(view.marketOutcome === "cashed", "the frozen bet still settles as cashed while userVisible is false");
  ok(view.settlementLane === "market", "…and lands in the market lane");
  ok(view.modelOutcome === "not_confirmed", "the internal model verdict is unchanged and kept separate");
}

// ── Non-public pitcher: model review, never Cashed ──────────────────────────
{
  const view = buildMoundSettlementView(
    { finalStrikeouts: 8, seasonBaselineValue: 6.0, outcome: "mound_win", userVisible: false },
    "follow",
    false, // never publicly flagged
    false,
  );
  ok(view.isPublicRecommendation === false, "an unflagged card is not a public recommendation");
  ok(view.settlementLane === "model_review", "unflagged + no bet → model review");
  ok(view.marketOutcome === "unavailable", "beating the engine baseline is never a Cashed on its own");
  ok(view.modelOutcome === "confirmed", "the model read is still recorded internally");
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOT-CAUSE REGRESSION — a Follow-public card whose direction column was
// recomputed to "fade" after first pitch.
//
// Reproduces the production failure exactly: a pitcher publicly surfaced
// pregame as a Strong-tier Follow read (everPubliclyFlagged minted, which
// requires score10 >= 5.5 and strong/elite/nuclear tier), then rebuilt after
// the game with degraded inputs — score below the publish bar, tier "track",
// so computeMoundDirection returns "fade". With the raw column driving
// settlement, 8 Ks against a 6.0 baseline graded as a FAILED FADE and
// rendered "Performed Above Baseline" on a card that had actually won.
// ═══════════════════════════════════════════════════════════════════════════
{
  const resolved = resolveMoundSettlementDirection({
    moundDirection: "fade", // post-hoc recomputed value
    everPubliclyFlagged: true, // durable proof the user was shown a Follow read
    everPubliclyFlaggedFade: true, // minted by the same bad rebuild — must not win
  });
  ok(resolved === "follow", "durable Follow exposure outranks a post-hoc 'fade' recomputation");

  const attribution = deriveMoundOutcome({
    finalStrikeouts: 8,
    seasonKPer9: 9.0, // baseline = 6.0
    wasPubliclyFlagged: true,
    moundDirection: resolved,
  });
  ok(attribution.seasonBaselineValue === 6.0, `baseline is 6.0 (got ${attribution.seasonBaselineValue})`);
  ok(attribution.outcome === "mound_win", "8 Ks vs a 6.0 baseline under the Follow rule → mound_win");
  ok(attribution.userVisible === true, "…and it counts publicly");

  const view = buildMoundSettlementView(
    {
      finalStrikeouts: 8,
      seasonBaselineValue: 6.0,
      outcome: attribution.outcome,
      userVisible: attribution.userVisible,
      settledDirection: resolved,
      marketOutcome: "unavailable",
      marketUnavailableReason: "no_line_posted", // a real line source exists for strikeouts, but no book posted this one
    },
    "fade", // the corrupted column, as persisted
    true,
    true,
  );
  ok(view.settlementDirection === "follow", "the settlement view grades under Follow despite the 'fade' column");
  ok(view.recommendedSide === "OVER", "the model-lane wording is Follow-sided, not Fade-sided");
  ok(view.modelOutcome === "confirmed", "8 > 6 under a Follow read is a confirmation, not a miss");
  ok(view.isPublicRecommendation === true, "public status survives the final-state transition");
  ok(view.settlementLane === "model_review", "no book posted a line this game, so this is honestly a model read");
  ok(view.marketOutcome !== "cashed", "…and is never fabricated into a Cashed off the engine baseline");
}

// ── A genuine Fade card is untouched by the precedence rule ─────────────────
{
  const resolved = resolveMoundSettlementDirection({
    moundDirection: "fade",
    everPubliclyFlagged: false, // never cleared the Follow public bar
    everPubliclyFlaggedFade: true,
  });
  ok(resolved === "fade", "a card that was only ever Fade-public still settles as a Fade");

  const view = buildMoundSettlementView(
    { finalStrikeouts: 4, seasonBaselineValue: 6.0, marketOutcome: "unavailable", marketUnavailableReason: "no_line_posted" },
    "fade",
    false,
    true,
  );
  ok(view.settlementDirection === "fade", "Fade direction preserved");
  ok(view.modelOutcome === "confirmed", "4 Ks under a 6.0 baseline confirms the Fade read");
  ok(view.recommendedSide === "UNDER", "Fade model wording stays Under-sided");
}

// ── An unstamped strikeout row is an integrity gap, not a quiet model review ─
{
  const view = buildMoundSettlementView(
    { finalStrikeouts: 7, seasonBaselineValue: 5.4 }, // no market fields at all
    "follow",
    true,
    false,
  );
  ok(view.marketUnavailableReason === "not_stamped", "a strikeout row that never ran market settlement is flagged");
  ok(view.settlementLane === "integrity_gap", "…and lands in the integrity lane, not model review");
  ok(view.marketOutcome === "unavailable", "…and is never fabricated into a result");
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIMARY-MARKET DRIFT REGRESSION (production regression fixture, COL vs MIL).
//
// computeMarketTags (marketTagger.ts) recomputes primaryMarket ("Best Angle")
// every build cycle from live pitcherSkill/opponentKProfile/workloadScore —
// exactly like moundDirection. Historically this mattered for settlement: a
// post-first-pitch rebuild with degraded data could silently swap a
// publicly-flagged pitcher's Best Angle off the REAL-ODDS strikeout market
// onto the Outs market — which has no sportsbook line source at all — and
// since settlement used to key off primaryMarket, that swap permanently lost
// a real Cashed/Missed/Push to the model-review baseline fallback ("Performed
// Above Baseline"/"Performed Below Baseline").
//
// Settlement is now ALWAYS strikeouts (moundOutcomeAttribution.ts's header
// comment) — it no longer reads primaryMarket at all — so this entire bug
// class is structurally impossible, not merely guarded against. This suite
// keeps two things: (1) carryForwardMoundGradedState (moundGradedStateCarry.ts)
// still pins primaryMarket for BEST ANGLE BADGE display consistency (a
// genuinely separate, still-real concern), and (2) a demonstration that even
// an unpinned/drifted Best Angle badge has zero effect on the real settlement
// result, because grading never consults it. This is a regression fixture,
// not a hardcoded player — it reproduces the failure SHAPE, not any specific
// stored row.
// ═══════════════════════════════════════════════════════════════════════════
{
  function moundSignalFixture(over: Partial<MoundSignal>): MoundSignal {
    return {
      signalId: "mlb-mound:2026-07-20:g1:pfixture",
      sport: "mlb",
      engine: "mound_radar",
      sessionDate: "2026-07-20",
      gameId: "g1",
      gameDate: "2026-07-20",
      startsAt: "2026-07-20T23:10:00.000Z",
      generatedAt: "2026-07-20T20:00:00.000Z",
      buildId: "b1",
      pitcherId: "pfixture",
      pitcherName: "Regression Fixture Pitcher",
      team: "MIL",
      opponent: "COL",
      throws: "R",
      opposingLineupConfirmed: true,
      opposingLineupLabel: "vs COL confirmed lineup",
      primaryMarket: "pitcher_strikeouts",
      marketTags: ["pitcher_strikeouts", "pitcher_outs"],
      marketScores: { pitcher_strikeouts: 6.5, pitcher_outs: 6.0 },
      marketSetups: [
        { market: "pitcher_strikeouts", setupScore: 6.5, setupLabel: "Strong", isPrimary: true },
        { market: "pitcher_outs", setupScore: 6.0, setupLabel: "Solid", isPrimary: false },
      ],
      parkContext: null,
      score10: 6.4,
      tier: "track",
      moundDirection: "fade",
      drivers: [],
      warnings: [],
      tags: [],
      lineupStatus: "confirmed",
      weatherStatus: "estimated",
      gameStatus: "scheduled",
      firstPitchLockEligible: true,
      lockedAt: null,
      hasMarketLine: false,
      isOfficialPlay: false,
      isPregameTarget: true,
      marketEdgeContext: null,
      projectedStrikeouts: 5.4,
      status: "active",
      suppressed: false,
      suppressedReasons: [],
      outcomes: null,
      everPubliclyFlagged: false,
      everPubliclyFlaggedFade: false,
      becameLiveReady: false,
      becameLiveFire: false,
      convertedLiveAt: null,
      diagnostics: {
        pitcherSkillScore: 6, opponentKProfileScore: 6, workloadScore: 5.8, runEnvironmentScore: 5,
        recentFormScore: 5, marketFitScore: 0, contactRiskScore: null, riskPenalty: 0,
        appliedDrivers: [], appliedWarnings: [],
        dataCoverageScore: 0.9, finalScoreBeforeCaps: 6.4, finalScoreAfterCaps: 6.4, publicTier: "track",
        suppressed: false, suppressedReasons: [],
        sourceFreshness: {},
        rawInputsAvailable: {
          confirmedStarter: true, confirmedOpposingLineup: true, pitcherSeasonStats: true,
          pitcherHandednessSplits: true, pitcherRecentStarts: true, pitcherStuffMetrics: true,
          park: true, weather: true,
        },
      },
      ...over,
    };
  }

  // Pregame: publicly flagged as a Fade candidate on the strikeout market,
  // which carries a real frozen sportsbook line (5.5, projection 4.0 → a
  // real, frozen UNDER recommendation — the bet the user actually saw).
  const frozenSnapshot = snapshotWithKLine(5.5, 4.0);
  const prev = moundSignalFixture({
    primaryMarket: "pitcher_strikeouts",
    everPubliclyFlaggedFade: true,
    moundDirection: "fade",
    tier: "track",
  });

  // Post-game rebuild: degraded workload/opponent-K inputs flip the
  // kScore-vs-outsScore comparison this cycle — primaryMarket freshly
  // recomputes to "pitcher_outs", exactly as buildMlbMoundRadar.ts's
  // computeMarketTags call would produce from degraded post-game inputs.
  const freshRebuild = moundSignalFixture({
    primaryMarket: "pitcher_outs",
    marketScores: { pitcher_strikeouts: 5.0, pitcher_outs: 5.8 },
    marketSetups: [
      { market: "pitcher_strikeouts", setupScore: 5.0, setupLabel: "Solid", isPrimary: false },
      { market: "pitcher_outs", setupScore: 5.8, setupLabel: "Solid", isPrimary: true },
    ],
    moundDirection: "fade",
    tier: "track",
    gameStatus: "final",
    firstPitchLockEligible: false,
    status: "locked",
  });

  carryForwardMoundGradedState(freshRebuild, prev);
  ok(freshRebuild.primaryMarket === "pitcher_strikeouts", "the Best Angle badge is still pinned by carryForwardMoundGradedState for display consistency");
  ok(freshRebuild.everPubliclyFlaggedFade === true, "the durable Fade flag still carries forward independently of the Best Angle pin");

  // ── Grading against the real strikeout market, using the pinned Best Angle ──
  {
    const finalStrikeouts = 5; // beats the frozen UNDER 5.5 recommendation
    const recommendation = deriveFrozenMoundMarketRecommendation("pitcher_strikeouts", frozenSnapshot);
    ok(recommendation.side === "UNDER", "the frozen recommendation is UNDER 5.5 — the real bet the user saw");

    const market = deriveMoundMarketOutcome({
      moundDirection: recommendation.side === "UNDER" ? "fade" : "follow",
      frozenLine: frozenSnapshot.champion.postedLine.strikeouts,
      lineFrozenAt: frozenSnapshot.frozenAt,
      actual: finalStrikeouts,
    });
    ok(market.marketOutcome === "cashed", "final 5 Ks vs a frozen UNDER 5.5 → cashed — the real settlement");

    const view = buildMoundSettlementView(
      { finalStrikeouts, seasonBaselineValue: 6.0, ...market } as MoundOutcome,
      freshRebuild.moundDirection,
      freshRebuild.everPubliclyFlagged,
      freshRebuild.everPubliclyFlaggedFade,
    );
    ok(view.settlementLane === "market", "the card settles in the market lane, not model_review");
    ok(view.marketOutcome === "cashed", "the card renders Cashed");
  }

  // ── Settlement is invariant to Best Angle: even a card whose badge still
  // reads "Pitcher Outs" (imagine the carry-forward pin never ran) grades
  // identically, because deriveMoundMarketOutcome/buildMoundSettlementView
  // never accept a market argument at all — there is no branch left to drift.
  // This is what makes the historical bug class structurally impossible now,
  // not merely guarded against by the pin. ──
  {
    const driftedBadgeSignal = { ...freshRebuild, primaryMarket: "pitcher_outs" as const };
    const finalStrikeouts = 5;
    const recommendation = deriveFrozenMoundMarketRecommendation("pitcher_strikeouts", frozenSnapshot);
    const market = deriveMoundMarketOutcome({
      moundDirection: recommendation.side === "UNDER" ? "fade" : "follow",
      frozenLine: frozenSnapshot.champion.postedLine.strikeouts,
      lineFrozenAt: frozenSnapshot.frozenAt,
      actual: finalStrikeouts,
    });
    ok(market.marketOutcome === "cashed", "grading is unaffected by driftedBadgeSignal.primaryMarket — it was never read");

    const view = buildMoundSettlementView(
      { finalStrikeouts, seasonBaselineValue: 6.0, ...market } as MoundOutcome,
      driftedBadgeSignal.moundDirection,
      driftedBadgeSignal.everPubliclyFlagged,
      driftedBadgeSignal.everPubliclyFlaggedFade,
    );
    ok(view.settlementLane === "market", "still the market lane, regardless of the (unused) Best Angle badge value");
    ok(view.marketOutcome === "cashed", "still renders Cashed — the real production symptom this suite protects against is now impossible");
  }
}

console.log(`\nmoundPublicSettlement.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
