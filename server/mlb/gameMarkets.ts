// ── MLB Game-Level Markets (Phase 5) ─────────────────────────────────────────
// Computes full game total, F5 total, and team total edges.
// Uses live game state + sportsbook consensus lines.

import type {
  MLBGameMarket,
  MLBGameMarketInput,
  MLBGameMarketOutput,
  MLBConfidenceTier,
} from "./types";

const LEAGUE_AVG_RUNS_PER_GAME = 8.8; // MLB 2024 average
const LEAGUE_AVG_RUNS_THROUGH_5 = 4.4; // approximately half

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Estimate run pace based on innings played
function estimatePaceRunsPerInning(
  totalRunsScored: number,
  inningsCompleted: number
): number | null {
  if (inningsCompleted < 1) return null;
  return totalRunsScored / inningsCompleted;
}

// Project final total for a full 9-inning game
function projectFullGameTotal(input: MLBGameMarketInput): number {
  const { homeScore, awayScore, inning, isTopInning } = input;
  const currentTotal = homeScore + awayScore;

  // Innings completed: top of 3 = 2.5 innings completed
  const inningsCompleted = Math.max(0, inning - 1 + (isTopInning ? 0 : 0.5));
  const pace = estimatePaceRunsPerInning(currentTotal, inningsCompleted);

  if (pace === null || inningsCompleted < 1) {
    // Not enough data — use ERA-adjusted league avg
    const eraFactor = input.starterEra != null
      ? clamp(input.starterEra / 4.0, 0.6, 1.8)
      : 1.0;
    return LEAGUE_AVG_RUNS_PER_GAME * eraFactor * input.parkFactor;
  }

  // Regression toward league average (weight by innings played)
  const regressionWeight = clamp(inningsCompleted / 9, 0, 1);
  const baselinePace = LEAGUE_AVG_RUNS_PER_GAME / 9;
  const blendedPace = regressionWeight * pace + (1 - regressionWeight) * baselinePace;

  const inningsRemaining = Math.max(0, 9 - inningsCompleted);
  const projectedRemaining = blendedPace * inningsRemaining * input.parkFactor;

  return currentTotal + projectedRemaining;
}

// Project F5 total (first 5 innings)
function projectF5Total(input: MLBGameMarketInput): number {
  const { homeScore, awayScore, inning, isTopInning } = input;
  const currentTotal = homeScore + awayScore;

  const inningsCompleted = Math.max(0, inning - 1 + (isTopInning ? 0 : 0.5));

  // If we're past inning 5, the F5 result is done
  if (inningsCompleted >= 5) return currentTotal;

  const pace = estimatePaceRunsPerInning(currentTotal, inningsCompleted);
  if (pace === null || inningsCompleted < 0.5) {
    const eraFactor = input.starterEra != null ? clamp(input.starterEra / 4.0, 0.6, 1.8) : 1.0;
    return LEAGUE_AVG_RUNS_THROUGH_5 * eraFactor * input.parkFactor;
  }

  const regressionWeight = clamp(inningsCompleted / 5, 0, 1);
  const baselinePace = LEAGUE_AVG_RUNS_THROUGH_5 / 5;
  const blendedPace = regressionWeight * pace + (1 - regressionWeight) * baselinePace;

  const inningsRemaining = Math.max(0, 5 - inningsCompleted);
  return currentTotal + blendedPace * inningsRemaining * input.parkFactor;
}

// Project team totals (home/away separately)
function projectTeamTotal(
  teamScore: number,
  oppScore: number,
  inning: number,
  isTopInning: boolean,
  parkFactor: number,
  side: "home" | "away"
): number {
  const inningsCompleted = Math.max(0, inning - 1 + (isTopInning ? 0 : 0.5));
  // Home team's half-innings completed = full innings (they bat in bottom)
  // Away team's half-innings = inning - 1 (they bat in top)
  const teamInningsCompleted =
    side === "home"
      ? Math.max(0, inning - 1 + (isTopInning ? 0 : 0.5))
      : Math.max(0, inning - 1 + (isTopInning ? 0.5 : 0));

  const pace = teamInningsCompleted > 0 ? teamScore / teamInningsCompleted : null;
  const baselinePace = LEAGUE_AVG_RUNS_PER_GAME / 2 / 9; // half of avg per inning

  const regressionWeight = clamp(inningsCompleted / 9, 0, 1);
  const blendedPace = pace !== null
    ? regressionWeight * pace + (1 - regressionWeight) * baselinePace
    : baselinePace;

  const inningsRemaining = Math.max(0, 9 - teamInningsCompleted);
  return teamScore + blendedPace * inningsRemaining * parkFactor;
}

// Convert projection vs line into an edge percentage
function computeEdge(projection: number, line: number): number {
  // Simple distance-based edge: (projection - line) normalized to a probability scale
  const gap = Math.abs(projection - line);
  // Each 1 run gap ≈ 7% probability swing for MLB totals (empirical estimate)
  return clamp(gap * 7, 0, 40);
}

function getConfidenceTier(edge: number, isDerived: boolean): MLBConfidenceTier {
  if (isDerived) {
    if (edge >= 8) return "STRONG";
    if (edge >= 4) return "LEAN";
    return "NO_EDGE";
  }
  if (edge >= 10) return "ELITE";
  if (edge >= 6) return "STRONG";
  if (edge >= 3) return "LEAN";
  return "NO_EDGE";
}

function buildGameMarketOutput(
  market: MLBGameMarket,
  input: MLBGameMarketInput,
  bookLine: number | null,
  projection: number,
  overOdds: number | null,
  underOdds: number | null
): MLBGameMarketOutput | null {
  if (bookLine === null || !Number.isFinite(bookLine)) return null;
  if (!Number.isFinite(projection)) return null;

  const gap = projection - bookLine;
  const edge = computeEdge(projection, bookLine);
  const isDerived = input.lineSource !== "sportsbook";
  const confidenceTier = getConfidenceTier(edge, isDerived);

  const MIN_EDGE = 3.0;
  if (edge < MIN_EDGE || confidenceTier === "NO_EDGE") return null;

  const recommendedSide: "OVER" | "UNDER" =
    gap > 0 ? "OVER" : "UNDER";

  const now = Date.now();
  return {
    market,
    gameId: input.gameId,
    homeTeam: input.homeTeam,
    awayTeam: input.awayTeam,
    bookLine,
    projection: parseFloat(projection.toFixed(1)),
    edge: parseFloat(edge.toFixed(1)),
    recommendedSide,
    confidenceTier,
    overOdds,
    underOdds,
    sportsbook: input.sportsbook,
    lineSource: input.lineSource,
    engineGeneratedAt: now,
    signalTimestamp: now,
    isDerivedLine: isDerived,
  };
}

// ── Main entrypoint ───────────────────────────────────────────────────────────

export function calculateMLBGameMarkets(
  input: MLBGameMarketInput
): MLBGameMarketOutput[] {
  const results: MLBGameMarketOutput[] = [];
  const now = Date.now();

  console.log(
    `[MLB GAME MARKETS] gameId=${input.gameId} inning=${input.inning} score=${input.awayScore}-${input.homeScore} lineSource=${input.lineSource}`
  );

  // Full game total
  if (input.fullGameLine !== null) {
    const proj = projectFullGameTotal(input);
    const out = buildGameMarketOutput(
      "full_game_total",
      input,
      input.fullGameLine,
      proj,
      input.fullGameOverOdds,
      input.fullGameUnderOdds
    );
    if (out) {
      console.log(`[MLB GAME MARKETS] full_game_total line=${input.fullGameLine} proj=${proj.toFixed(1)} edge=${out.edge} side=${out.recommendedSide}`);
      results.push(out);
    }
  }

  // F5 total — only relevant before inning 5 ends
  const inningsCompleted = Math.max(0, input.inning - 1 + (input.isTopInning ? 0 : 0.5));
  if (input.f5Line !== null && inningsCompleted <= 5) {
    const proj = projectF5Total(input);
    const out = buildGameMarketOutput(
      "f5_total",
      input,
      input.f5Line,
      proj,
      input.f5OverOdds,
      input.f5UnderOdds
    );
    if (out) {
      console.log(`[MLB GAME MARKETS] f5_total line=${input.f5Line} proj=${proj.toFixed(1)} edge=${out.edge} side=${out.recommendedSide}`);
      results.push(out);
    }
  }

  // Team total — home
  if (input.teamTotalHomeLine !== null) {
    const proj = projectTeamTotal(
      input.homeScore,
      input.awayScore,
      input.inning,
      input.isTopInning,
      input.parkFactor,
      "home"
    );
    const out = buildGameMarketOutput(
      "team_total_home",
      input,
      input.teamTotalHomeLine,
      proj,
      null,
      null
    );
    if (out) {
      console.log(`[MLB GAME MARKETS] team_total_home line=${input.teamTotalHomeLine} proj=${proj.toFixed(1)} edge=${out.edge} side=${out.recommendedSide}`);
      results.push(out);
    }
  }

  // Team total — away
  if (input.teamTotalAwayLine !== null) {
    const proj = projectTeamTotal(
      input.awayScore,
      input.homeScore,
      input.inning,
      input.isTopInning,
      input.parkFactor,
      "away"
    );
    const out = buildGameMarketOutput(
      "team_total_away",
      input,
      input.teamTotalAwayLine,
      proj,
      null,
      null
    );
    if (out) {
      console.log(`[MLB GAME MARKETS] team_total_away line=${input.teamTotalAwayLine} proj=${proj.toFixed(1)} edge=${out.edge} side=${out.recommendedSide}`);
      results.push(out);
    }
  }

  return results;
}
