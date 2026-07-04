// Mound Radar — composite scoring (single 0–10 scale).
//
// Structurally parallel to pregamePowerRadar/scoring.ts (weighted base ->
// clamp -> coverage caps -> risk penalty subtract -> score10 -> tier) but
// entirely separate constants/functions — no import from Plate's scoring.ts.
//
//   moundScore10 =
//       clamp10(
//         pitcherSkillScore     * 0.28
//       + opponentKProfileScore * 0.20
//       + workloadScore         * 0.20
//       + runEnvironmentScore   * 0.16
//       + recentFormScore       * 0.16
//       )
//     - riskPenalty   // capped at 2.5, same discipline as Plate's matchupPenalty

import type { MoundTier } from "./types";
import { clamp10, round1 } from "./scoreUtils";

export interface MoundScoringComponents {
  pitcherSkillScore: number;
  opponentKProfileScore: number;
  workloadScore: number;
  runEnvironmentScore: number;
  recentFormScore: number;
  riskPenalty: number;
}

export interface MoundScoringFlags {
  pitcherSkillAvailable: boolean;
  confirmedStarter: boolean;
  confirmedOpposingLineup: boolean;
  parkAvailable: boolean;
  weatherAvailable: boolean;
  positiveDriverCount: number;
}

export interface MoundScoringResult {
  baseScore: number;
  finalScoreBeforeCaps: number;
  score10: number;
  tier: MoundTier;
  dataCoverageScore: number;
  finalScoreCap?: number;
  suppressed: boolean;
  suppressedReasons: string[];
}

// 5.5, not 6.0: pitcherSkillScore's and opponentKProfileScore's lin() scales
// (pitcherSkill.ts, opponentKProfile.ts) both place true league-average
// performance well below the scale midpoint (~4.2/10 and ~2.9/10
// respectively at league-average K/9 and platoon K rate), and
// opponentKProfileScore + runEnvironmentScore (36% combined weight) sit at a
// neutral 5 on any day without an extreme platoon/park/weather edge. At 6.0
// this bar required near-top-of-league performance on nearly every axis
// simultaneously, leaving it un-clearable on an ordinary slate.
export const MOUND_PUBLISH_MIN_SCORE = 5.5;

export const MOUND_COMPONENT_WEIGHTS = {
  pitcherSkill: 0.28,
  opponentKProfile: 0.20,
  workload: 0.20,
  runEnvironment: 0.16,
  recentForm: 0.16,
} as const;

/** Fixed data-coverage formula for the Mound — mirrors Plate's discipline with its own weights. */
export function computeMoundDataCoverage(flags: MoundScoringFlags): number {
  const v =
    (flags.pitcherSkillAvailable ? 0.35 : 0) +
    (flags.confirmedStarter ? 0.2 : 0) +
    (flags.confirmedOpposingLineup ? 0.2 : 0) +
    (flags.parkAvailable ? 0.15 : 0) +
    (flags.weatherAvailable ? 0.1 : 0);
  return Math.round(v * 100) / 100;
}

export function classifyMoundTier(score10: number, pitcherSkillScore: number, workloadScore: number): MoundTier {
  // Elite requires a real skill signal AND a favorable workload/environment
  // context — never from pitcherSkillScore alone (mirrors Plate's discipline
  // that batter power alone can't mint "Elite Setup").
  if (score10 >= 8.8 && pitcherSkillScore >= 7.0 && workloadScore >= 6.0) return "nuclear";
  if (score10 >= 7.3 && pitcherSkillScore >= 7.0 && workloadScore >= 5.5) return "elite";
  if (score10 >= MOUND_PUBLISH_MIN_SCORE) return "strong";
  if (score10 >= 4.0) return "watch";
  return "track";
}

export function composeMoundScore(
  c: MoundScoringComponents,
  flags: MoundScoringFlags,
): MoundScoringResult {
  const baseScore = clamp10(
    c.pitcherSkillScore * MOUND_COMPONENT_WEIGHTS.pitcherSkill +
      c.opponentKProfileScore * MOUND_COMPONENT_WEIGHTS.opponentKProfile +
      c.workloadScore * MOUND_COMPONENT_WEIGHTS.workload +
      c.runEnvironmentScore * MOUND_COMPONENT_WEIGHTS.runEnvironment +
      c.recentFormScore * MOUND_COMPONENT_WEIGHTS.recentForm,
  );

  const dataCoverageScore = computeMoundDataCoverage(flags);

  let cap = 10;
  const suppressedReasons: string[] = [];

  if (!flags.pitcherSkillAvailable) {
    cap = Math.min(cap, 3.9);
    suppressedReasons.push("pitcher_skill_missing");
  }
  if (!flags.confirmedStarter) {
    cap = Math.min(cap, 3.9);
    suppressedReasons.push("starter_not_confirmed");
  }
  if (!flags.confirmedOpposingLineup) {
    suppressedReasons.push("opposing_lineup_not_confirmed");
  }
  if (dataCoverageScore < 0.6) {
    cap = Math.min(cap, 5.9);
  }

  const cappedScore = Math.min(baseScore, cap);
  const score10 = round1(clamp10(cappedScore - c.riskPenalty));
  const tier = classifyMoundTier(score10, c.pitcherSkillScore, c.workloadScore);

  if (flags.positiveDriverCount < 2) suppressedReasons.push("insufficient_drivers");
  if (score10 < MOUND_PUBLISH_MIN_SCORE) {
    suppressedReasons.push(cap < 10 ? "capped_by_data_quality" : "below_threshold_after_full_data");
  }

  const suppressed = suppressedReasons.length > 0;

  return {
    baseScore: round1(baseScore),
    finalScoreBeforeCaps: round1(clamp10(baseScore)),
    score10,
    tier,
    dataCoverageScore,
    finalScoreCap: cap < 10 ? cap : undefined,
    suppressed,
    suppressedReasons,
  };
}
