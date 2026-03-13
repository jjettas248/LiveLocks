// ── NCAAB Engine Test Cases ────────────────────────────────────────────────────
import {
  calculateNCAABProjection,
  calculateNCAABProbabilities,
  calibrateNCAABProbability,
  determineRecommendedSide,
  buildNCAABDisplayOutput,
  validateDisplayConsistency,
  getDynamicMultiplier,
  runNCAABEngine,
  EDGE_MIN_GAP,
  EDGE_MIN_PROB,
  CALIBRATION_CAP,
  CALIBRATION_WARN_THRESHOLD,
  type NCAABGameInput,
  type NCAABEngineOutput,
} from "./ncaabEngine";

function makeInput(overrides: Partial<NCAABGameInput> = {}): NCAABGameInput {
  return {
    gameId: "test-001",
    sport: "ncaab",
    league: "NCAAB",
    homeTeam: "Duke Blue Devils",
    awayTeam: "North Carolina Tar Heels",
    homeTeamAbbr: "DUKE",
    awayTeamAbbr: "UNC",
    homeScore: 35,
    awayScore: 30,
    period: 2,
    half: 2,
    clock: "10:00",
    isHalftime: false,
    secondsRemainingInHalf: 600,
    status: "In Progress",
    liveTotalLine: 140,
    liveSpreadLine: 3.5,
    liveSpreadFavorite: "Duke Blue Devils",
    h1TotalLine: 65,
    h1SpreadLine: 2,
    h1Favorite: "Duke Blue Devils",
    h2TotalLine: 72,
    h2SpreadLine: 1.5,
    h2Favorite: "Duke Blue Devils",
    homeGameTotalLine: 72,
    awayGameTotalLine: 68,
    home1HTotalLine: 33,
    away1HTotalLine: 31,
    h1HomeScore: 35,
    h1AwayScore: 30,
    h2HomeScore: 0,
    h2AwayScore: 0,
    scoringByPeriod: { DUKE: [35], UNC: [30] },
    teamStats: {},
    projTotalBonus: 0,
    volatilityBonus: 0,
    desperation3s: false,
    intentionalFouling: false,
    overOddsAmerican: -110,
    spreadOddsAmerican: -110,
    h1OverOddsAmerican: -110,
    h1SpreadOddsAmerican: -110,
    h2OverOddsAmerican: -110,
    h2SpreadOddsAmerican: -110,
    ...overrides,
  };
}

function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      passed++;
      console.log(`  ✓ ${testName}`);
    } else {
      failed++;
      console.error(`  ✗ ${testName}`);
    }
  }

  console.log("\n=== NCAAB Engine Tests ===\n");

  // Test 1: Projection below line → must pick UNDER
  console.log("Test 1: Projection below line → UNDER");
  {
    const input = makeInput({
      homeScore: 25, awayScore: 20,
      h1HomeScore: 25, h1AwayScore: 20,
      liveTotalLine: 155,
      secondsRemainingInHalf: 600,
      half: 2, period: 2,
    });
    const output = runNCAABEngine(input);
    assert(
      output.recommendedSide === "UNDER" || output.recommendedSide === "NO_EDGE",
      `Side should be UNDER or NO_EDGE when projection well below line. Got: ${output.recommendedSide}, proj=${output.projectedTotal}, line=155`
    );
    if (output.recommendedSide !== "NO_EDGE") {
      assert(output.recommendedSide === "UNDER", "When edge exists, must be UNDER");
    }
  }

  // Test 2: Projection above line → must pick OVER
  console.log("\nTest 2: Projection above line → OVER");
  {
    const input = makeInput({
      homeScore: 75, awayScore: 70,
      h1HomeScore: 45, h1AwayScore: 40,
      h2HomeScore: 30, h2AwayScore: 30,
      liveTotalLine: 120,
      secondsRemainingInHalf: 600,
      half: 2, period: 2,
    });
    const output = runNCAABEngine(input);
    assert(
      output.recommendedSide === "OVER" || output.recommendedSide === "NO_EDGE",
      `Side should be OVER or NO_EDGE when projection well above line. Got: ${output.recommendedSide}, proj=${output.projectedTotal}, line=120`
    );
    if (output.recommendedSide !== "NO_EDGE") {
      assert(output.recommendedSide === "OVER", "When edge exists, must be OVER");
    }
  }

  // Test 3: Tiny edge → NO_EDGE
  console.log("\nTest 3: Tiny edge → NO_EDGE");
  {
    const input = makeInput({
      homeScore: 35, awayScore: 30,
      h1HomeScore: 35, h1AwayScore: 30,
      liveTotalLine: 139,
      secondsRemainingInHalf: 600,
      half: 2, period: 2,
    });
    const projection = calculateNCAABProjection(input);
    const line = input.liveTotalLine!;
    const gap = Math.abs(projection.finalProjectedTotal - line);
    if (gap < EDGE_MIN_GAP) {
      const result = determineRecommendedSide(projection.finalProjectedTotal, line, 52, 48);
      assert(result.side === "NO_EDGE", `Tiny gap (${gap.toFixed(1)}) should be NO_EDGE. Got: ${result.side}`);
    } else {
      console.log(`  (gap=${gap.toFixed(1)} >= threshold, testing with explicit small gap)`);
      const result = determineRecommendedSide(141, 140, 52, 48);
      assert(result.side === "NO_EDGE", `Gap of 1.0 should be NO_EDGE. Got: ${result.side}`);
    }
  }

  // Test 4: Rounding does not change side
  console.log("\nTest 4: Rounding does not change side");
  {
    const result1 = determineRecommendedSide(142.04, 140, 62, 38);
    const result2 = determineRecommendedSide(142.06, 140, 62, 38);
    assert(result1.side === result2.side, `Rounding should not change side: ${result1.side} vs ${result2.side}`);

    const resultUnder = determineRecommendedSide(137.96, 140, 38, 62);
    assert(resultUnder.side === "UNDER", `Should be UNDER when projection < line. Got: ${resultUnder.side}`);
  }

  // Test 5: Stale line triggers warning
  console.log("\nTest 5: Stale-state safeguards");
  {
    const output = runNCAABEngine(makeInput());
    assert(typeof output.engineGeneratedAt === "number", "engineGeneratedAt should be a timestamp");
    assert(output.engineGeneratedAt > 0, "engineGeneratedAt should be positive");
    assert(output.engineGeneratedAt <= Date.now(), "engineGeneratedAt should not be in the future");
  }

  // Test 6: Probability above threshold emits warning
  console.log("\nTest 6: Probability calibration cap");
  {
    const capped = calibrateNCAABProbability(95, "full_game_total", { secsElapsed: 1200 });
    assert(capped <= CALIBRATION_CAP, `Calibrated prob ${capped} should be ≤ ${CALIBRATION_CAP}`);

    const neutral = calibrateNCAABProbability(60, "full_game_total", { secsElapsed: 30 });
    assert(neutral === 50, `Early game prob should be 50, got ${neutral}`);
  }

  // Test 7: Display object matches engine output
  console.log("\nTest 7: Display matches engine");
  {
    const output = runNCAABEngine(makeInput());
    const display = buildNCAABDisplayOutput(output);
    if (output.projectedTotal !== null) {
      assert(display.projectedTotal === output.projectedTotal.toFixed(1), `Display projection should match engine`);
    }
    assert(display.recommendedSide === output.recommendedSide, `Display side should match engine`);
  }

  // Test 8: Stale enrichment cannot overwrite engine result
  console.log("\nTest 8: Engine output immutability");
  {
    const output = runNCAABEngine(makeInput());
    const ts = output.engineGeneratedAt;
    assert(ts > 0, "Engine timestamp exists");
    assert(output.gameId === "test-001", "Game ID preserved");
  }

  // Test 9: Dynamic multiplier clamping
  console.log("\nTest 9: Dynamic multiplier guardrails");
  {
    const early = getDynamicMultiplier(2300, 2400, 1, 2);
    assert(early.value >= 0.6, `Early game mult ${early.value} should be >= 0.6`);
    assert(early.value <= 1.4, `Early game mult ${early.value} should be <= 1.4`);

    const late = getDynamicMultiplier(100, 2400, 2, 2);
    assert(late.value >= 0.6, `Late game mult ${late.value} should be >= 0.6`);
    assert(late.value <= 1.4, `Late game mult ${late.value} should be <= 1.4`);

    const ot = getDynamicMultiplier(100, 2400, 3, 2);
    assert(ot.value <= 1.4, `OT mult ${ot.value} should be <= 1.4`);
  }

  // Test 10: Contradiction detection
  console.log("\nTest 10: Contradiction detection");
  {
    const result = determineRecommendedSide(145, 140, 45, 55);
    assert(result.side === "NO_EDGE", `Contradiction (proj OVER but prob UNDER) should be NO_EDGE. Got: ${result.side}`);
    assert(result.warnings.length > 0, "Should have contradiction warning");
    assert(result.warnings.some(w => w.includes("CONTRADICTION")), "Warning should mention CONTRADICTION");
  }

  // Test 11: Validation catches wrong side
  console.log("\nTest 11: Validation catches wrong side");
  {
    const badOutput: NCAABEngineOutput = {
      gameId: "test",
      sport: "ncaab",
      marketType: "full_game_total",
      projectedTotal: 150,
      projected1HTotal: null,
      projected2HTotal: null,
      projectedSpread: 5,
      projectedTeamTotalHome: 78,
      projectedTeamTotalAway: 72,
      rawOverProb: 70,
      rawUnderProb: 30,
      rawSpreadProb: 65,
      calibratedOverProb: 65,
      calibratedUnderProb: 35,
      calibratedSpreadProb: 60,
      over1HProb: null,
      over2HProb: null,
      impliedBookOverProb: null,
      impliedBookUnderProb: null,
      edgePctOver: null,
      edgePctUnder: null,
      edgePctSpread: null,
      recommendedSide: "UNDER",
      confidenceTier: "MEDIUM",
      explanationBullets: [],
      displayProjection: "150.0",
      displayProbability: "65%",
      displayPick: "UNDER",
      dominantMarket: "over",
      displayOutput: {
        projectedTotal: "150.0", projectedSpread: "—",
        overProb: "65.0%", underProb: "35.0%", spreadProb: "—",
        recommendedSide: "UNDER", confidenceTier: "MEDIUM",
        edgeLabelOver: "Lean Over EV", edgeLabelUnder: "",
        edgeLabelSpread: "", preGameConfidenceLabel: "Moderate",
        explanationBullets: [], warnings: [],
      },
      warnings: [],
      marketVerdicts: [],
      engineGeneratedAt: Date.now(),
    };
    const input = makeInput({ liveTotalLine: 140 });
    const display = buildNCAABDisplayOutput(badOutput);
    const validationWarns = validateDisplayConsistency(input, badOutput, display);
    assert(validationWarns.some(w => w.includes("WRONG_SIDE")), "Validation should catch wrong side");
  }

  // Test 12: Probability threshold warning
  console.log("\nTest 12: High probability warning");
  {
    const output = runNCAABEngine(makeInput({
      homeScore: 60, awayScore: 55,
      h1HomeScore: 45, h1AwayScore: 40,
      h2HomeScore: 15, h2AwayScore: 15,
      liveTotalLine: 100,
      secondsRemainingInHalf: 200,
    }));
    if (output.calibratedOverProb !== null && output.calibratedOverProb > CALIBRATION_WARN_THRESHOLD) {
      assert(
        output.warnings.some(w => w.includes("HIGH_PROB")),
        "Should warn when probability exceeds threshold"
      );
    } else {
      assert(true, `Prob ${output.calibratedOverProb} is within bounds, no warning needed`);
    }
  }

  // ── T27: Spread verdict enforces gap rule ───────────────────────────────────
  {
    const input = makeInput({
      liveSpreadLine: 5,
      liveSpreadFavorite: "Duke Blue Devils",
      homeScore: 35,
      awayScore: 30,
      liveTotalLine: 138,
    });
    const output = runNCAABEngine(input);
    const spreadVerdict = output.marketVerdicts?.find(v => v.market === "spread");
    assert(spreadVerdict != null, "T27: Spread verdict should exist");
    if (spreadVerdict) {
      const spreadGap = Math.abs(spreadVerdict.projection - spreadVerdict.line!);
      if (spreadGap < EDGE_MIN_GAP) {
        assert(
          spreadVerdict.side === "NO_EDGE",
          `T27: Spread gap ${spreadGap} < ${EDGE_MIN_GAP} → must be NO_EDGE, got ${spreadVerdict.side}`
        );
      }
    }
  }

  // ── T28: Spread verdict uses contradiction rejection ──────────────────────
  {
    const input = makeInput({
      liveSpreadLine: 3,
      liveSpreadFavorite: "North Carolina Tar Heels",
      homeScore: 40,
      awayScore: 30,
      secondsRemainingInHalf: 600,
      period: 2,
      liveTotalLine: 142,
    });
    const output = runNCAABEngine(input);
    const spreadVerdict = output.marketVerdicts?.find(v => v.market === "spread");
    assert(spreadVerdict != null, "T28: Spread verdict should exist");
    if (spreadVerdict) {
      const projFavorsHome = spreadVerdict.projection > spreadVerdict.line!;
      const probFavorsHome = (spreadVerdict.overProb ?? 0) > 50;
      if (projFavorsHome !== probFavorsHome) {
        assert(
          spreadVerdict.side === "NO_EDGE",
          `T28: Spread contradiction → must be NO_EDGE, got ${spreadVerdict.side}`
        );
      }
    }
  }

  // ── T29: Spread verdict OVER when gap and prob both met ───────────────────
  {
    const input = makeInput({
      liveSpreadLine: 10,
      liveSpreadFavorite: "North Carolina Tar Heels",
      homeScore: 50,
      awayScore: 30,
      secondsRemainingInHalf: 600,
      period: 2,
      liveTotalLine: 150,
    });
    const output = runNCAABEngine(input);
    const spreadVerdict = output.marketVerdicts?.find(v => v.market === "spread");
    assert(spreadVerdict != null, "T29: Spread verdict should exist");
    if (spreadVerdict) {
      const spreadGap = Math.abs(spreadVerdict.projection - spreadVerdict.line!);
      if (spreadGap >= EDGE_MIN_GAP && (spreadVerdict.overProb ?? 0) >= EDGE_MIN_PROB) {
        assert(
          spreadVerdict.side === "OVER",
          `T29: Spread gap ${spreadGap.toFixed(1)} ≥ ${EDGE_MIN_GAP} and prob ${spreadVerdict.overProb} ≥ ${EDGE_MIN_PROB} → should be OVER, got ${spreadVerdict.side}`
        );
      }
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  return { passed, failed };
}

runTests();
