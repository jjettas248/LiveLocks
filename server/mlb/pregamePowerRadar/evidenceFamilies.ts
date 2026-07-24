// Pre-Game Power Radar — independent predictive-evidence families.
//
// The public-quality gate must not count multiple correlated chips from the same
// underlying skill (xISO + barrels + hard-hit) as independent confirmation, and
// it must never let a market/display tag satisfy a predictive evidence minimum.
// Count one vote per model family instead.

export type PregameEvidenceFamily =
  | "batter_power"
  | "pitcher_vulnerability"
  | "matchup_fit"
  | "park_weather"
  | "lineup_opportunity"
  | "recent_contact";

export interface PregameEvidenceInputs {
  batterPowerScore: number | null;
  pitcherVulnerabilityScore: number | null;
  matchupFitScore: number | null;
  parkWeatherScore: number | null;
  lineupOpportunityScore: number | null;
  nearHrRecentFormScore: number | null;
}

const THRESHOLDS: Record<PregameEvidenceFamily, number> = {
  batter_power: 6.5,
  pitcher_vulnerability: 6.0,
  matchup_fit: 6.0,
  park_weather: 6.0,
  lineup_opportunity: 6.5,
  recent_contact: 6.5,
};

export function positivePregameEvidenceFamilies(input: PregameEvidenceInputs): PregameEvidenceFamily[] {
  const out: PregameEvidenceFamily[] = [];
  if (input.batterPowerScore != null && input.batterPowerScore >= THRESHOLDS.batter_power) out.push("batter_power");
  if (input.pitcherVulnerabilityScore != null && input.pitcherVulnerabilityScore >= THRESHOLDS.pitcher_vulnerability) out.push("pitcher_vulnerability");
  if (input.matchupFitScore != null && input.matchupFitScore >= THRESHOLDS.matchup_fit) out.push("matchup_fit");
  if (input.parkWeatherScore != null && input.parkWeatherScore >= THRESHOLDS.park_weather) out.push("park_weather");
  if (input.lineupOpportunityScore != null && input.lineupOpportunityScore >= THRESHOLDS.lineup_opportunity) out.push("lineup_opportunity");
  if (input.nearHrRecentFormScore != null && input.nearHrRecentFormScore >= THRESHOLDS.recent_contact) out.push("recent_contact");
  return out;
}

export function countPositivePregameEvidenceFamilies(input: PregameEvidenceInputs): number {
  return positivePregameEvidenceFamilies(input).length;
}
