// Mound Radar V2 (shadow) — per-batter strikeout probability.
//
// Production opponentKProfile.ts blends the pitcher's own platoon K rate with
// the OPPOSING LINEUP'S AGGREGATE batter K rate to produce one lineup-wide
// score10 component. A real outcome distribution needs a probability PER
// BATTER instead (so a Poisson-binomial can aggregate across the actual
// batters a pitcher will face) — this applies the identical log-odds
// blending convention (same league prior, same pitcher/hitter weights) to a
// single batter's own shrunk K rate rather than a lineup average. Mirroring
// the blend style intentionally keeps V2 anchored to the same real-world
// calibration point production already uses, without importing production
// code (same isolation discipline as ../scoreUtils.ts).

const LEAGUE_K_RATE = 0.223;
const PITCHER_WEIGHT = 0.55;
const HITTER_WEIGHT = 0.45;

function clampProb(v: number): number {
  return Math.max(0.01, Math.min(0.6, v));
}

function logit(p: number): number {
  const x = clampProb(p);
  return Math.log(x / (1 - x));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Blends a pitcher's own platoon K rate (vs the batter's handedness) with the
 * batter's own shrunk K rate (vs the pitcher's throwing hand) in log-odds
 * space around the league K prior. Either side degrades independently to the
 * other when unavailable, and both-missing degrades to the league rate —
 * never fabricated, never zero.
 */
export function computeBatterStrikeoutProbability(
  pitcherPlatoonKRate: number | null,
  batterKRateVsThrowHand: number | null,
): number {
  if (pitcherPlatoonKRate == null && batterKRateVsThrowHand == null) return LEAGUE_K_RATE;
  if (pitcherPlatoonKRate == null) return clampProb(batterKRateVsThrowHand as number);
  if (batterKRateVsThrowHand == null) return clampProb(pitcherPlatoonKRate);

  const prior = logit(LEAGUE_K_RATE);
  const combined =
    prior +
    PITCHER_WEIGHT * (logit(pitcherPlatoonKRate) - prior) +
    HITTER_WEIGHT * (logit(batterKRateVsThrowHand) - prior);
  return clampProb(sigmoid(combined));
}

export { LEAGUE_K_RATE };
