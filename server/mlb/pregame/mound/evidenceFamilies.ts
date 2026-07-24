// Mound Radar — independent predictive-evidence families.
//
// Driver chips are presentation/explainability. They are not a statistically
// independent evidence count: one data source can emit multiple chips, while
// context chips such as Confirmed Starter/Confirmed Lineup are availability
// facts rather than predictive evidence. Public quality gating therefore counts
// component families, not raw positive chips.

export type MoundEvidenceFamily =
  | "pitcher_skill"
  | "opponent_k"
  | "workload"
  | "run_environment"
  | "recent_form";

export interface MoundEvidenceInputs {
  pitcherSkillScore: number | null;
  opponentKProfileScore: number | null;
  workloadScore: number | null;
  runEnvironmentScore: number | null;
  recentFormScore: number | null;
}

const THRESHOLDS: Record<MoundEvidenceFamily, number> = {
  pitcher_skill: 6.0,
  // The K-profile scale intentionally places league average below 5, so 5.8 is
  // already a meaningfully favorable strikeout matchup rather than "barely above neutral".
  opponent_k: 5.8,
  workload: 6.0,
  run_environment: 6.0,
  recent_form: 6.0,
};

export function positiveMoundEvidenceFamilies(input: MoundEvidenceInputs): MoundEvidenceFamily[] {
  const out: MoundEvidenceFamily[] = [];
  if (input.pitcherSkillScore != null && input.pitcherSkillScore >= THRESHOLDS.pitcher_skill) out.push("pitcher_skill");
  if (input.opponentKProfileScore != null && input.opponentKProfileScore >= THRESHOLDS.opponent_k) out.push("opponent_k");
  if (input.workloadScore != null && input.workloadScore >= THRESHOLDS.workload) out.push("workload");
  if (input.runEnvironmentScore != null && input.runEnvironmentScore >= THRESHOLDS.run_environment) out.push("run_environment");
  if (input.recentFormScore != null && input.recentFormScore >= THRESHOLDS.recent_form) out.push("recent_form");
  return out;
}

export function countPositiveMoundEvidenceFamilies(input: MoundEvidenceInputs): number {
  return positiveMoundEvidenceFamilies(input).length;
}
