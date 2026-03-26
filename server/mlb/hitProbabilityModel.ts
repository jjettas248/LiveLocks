const LEAGUE_AVG_BA = 0.243;
const LEAGUE_AVG_BABIP = 0.296;
const LEAGUE_AVG_ERA = 4.15;

export function baseProbability(playerHits: number, playerAB: number): number {
  const playerRate = playerAB > 0 ? playerHits / playerAB : LEAGUE_AVG_BA;
  return playerRate * 0.60 + LEAGUE_AVG_BA * 0.40;
}

/**
 * Apply Statcast Expected Batting Average (xBA) as a season-talent baseline.
 * xBA captures how hard and at what angle the ball is hit, independent of
 * defense and luck. We blend it with the observed rate to give the model
 * a "true talent" anchor on top of current-game contact.
 * Cap modifier to ±8% to prevent xBA from dominating live signals.
 */
export function applyXBAModifier(
  rate: number,
  xBA: number | null | undefined,
  playerAB: number
): number {
  if (xBA == null || xBA <= 0) return rate;
  const xbaRate = xBA; // Savant returns xBA as a decimal (e.g. 0.275), not a percentage
  const delta = xbaRate - LEAGUE_AVG_BA;
  const abWeight = Math.min(1.0, playerAB / 50);
  const modifier = 1 + delta * abWeight * 0.35;
  return rate * Math.max(0.92, Math.min(1.08, modifier));
}

/**
 * Apply Statcast Expected Slugging (xSLG) as a total-bases efficiency boost.
 * Higher xSLG means the batter squares the ball up more often and with more
 * power, increasing the expected contribution to total-bases / HR markets.
 * Only applied when playerAB > 0 (not useful without contact data).
 */
export function applyXSLGModifier(
  rate: number,
  xSLG: number | null | undefined,
  playerAB: number
): number {
  if (xSLG == null || xSLG <= 0 || playerAB <= 0) return rate;
  const xslgRate = xSLG; // Savant returns xSLG as a decimal (e.g. 0.450), not a percentage
  const leagueAvgSLG = 0.400;
  const delta = xslgRate - leagueAvgSLG;
  const abWeight = Math.min(1.0, playerAB / 50);
  const modifier = 1 + delta * abWeight * 0.25;
  return rate * Math.max(0.94, Math.min(1.06, modifier));
}

export function applyPitcherModifier(
  rate: number,
  pitcherKRate: number,
  pitcherBABIP: number
): number {
  const modifier = 1 - (pitcherKRate * 0.30) + ((pitcherBABIP - LEAGUE_AVG_BABIP) * 0.50);
  return rate * modifier;
}

export function applyParkModifier(rate: number, parkFactor: number): number {
  return rate * parkFactor;
}

export function applyBullpenModifier(
  rate: number,
  bullpenERA: number | null,
  leagueERA: number = LEAGUE_AVG_ERA
): number {
  if (bullpenERA == null || bullpenERA <= 0) return rate;
  const rawModifier = leagueERA / bullpenERA;
  const modifier = Math.max(0.90, Math.min(1.10, rawModifier));
  return rate * modifier;
}

export function applyWeatherModifier(
  rate: number,
  windOut: boolean,
  temperature: number
): number {
  const rawModifier = 1 + (windOut ? 0.02 : 0) + ((temperature - 70) * 0.003);
  const modifier = Math.max(0.90, Math.min(1.10, rawModifier));
  return rate * modifier;
}

function binomialCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

export function binomialOverProbability(
  remainingPA: number,
  adjustedHitRate: number,
  neededHits: number
): number {
  const n = Math.round(Math.max(1, remainingPA));
  const p = Math.max(0, Math.min(1, adjustedHitRate));
  const target = Math.max(0, Math.ceil(neededHits));

  if (target <= 0) return 100;
  if (target > n) {
    let prob = 0;
    for (let k = target; k <= n; k++) {
      prob += binomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
    }
    return prob * 100;
  }

  let cumUnder = 0;
  for (let k = 0; k < target; k++) {
    cumUnder += binomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return (1 - cumUnder) * 100;
}
