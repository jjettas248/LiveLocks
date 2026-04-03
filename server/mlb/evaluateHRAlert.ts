import type { HRBuildResult } from "./HRSignalBuilder";

export type HRAlertLevel = "ALERT" | "WATCH" | null;

export interface HRAlertInput {
  playerId: string;
  playerName: string;
  teamAbbr: string;
  gameId: string;
  hrBuildScore: number;
  hrIntensity: string;
  factors: HRBuildResult["factors"];
  inning: number;
  priorABResults: Array<{
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: string;
  }>;
}

export interface HRAlertResult {
  level: HRAlertLevel;
  triggerReason: string;
}

const COOLDOWN_MS = 10 * 60 * 1000;
const recentAlerts = new Map<string, number>();

function cooldownKey(playerId: string, gameId: string): string {
  return `${playerId}:${gameId}`;
}

export function isOnCooldown(playerId: string, gameId: string): boolean {
  const key = cooldownKey(playerId, gameId);
  const last = recentAlerts.get(key);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

export function markAlertSent(playerId: string, gameId: string): void {
  recentAlerts.set(cooldownKey(playerId, gameId), Date.now());
}

export function clearGameCooldowns(gameId: string): void {
  const keys = Array.from(recentAlerts.keys());
  for (const key of keys) {
    if (key.endsWith(`:${gameId}`)) recentAlerts.delete(key);
  }
}

export function evaluateHRAlert(input: HRAlertInput): HRAlertResult {
  const { hrBuildScore, factors, inning, priorABResults } = input;

  if (isOnCooldown(input.playerId, input.gameId)) {
    return { level: null, triggerReason: "" };
  }

  const recentABs = priorABResults.slice(-3);
  const last2 = priorABResults.slice(-2);

  if (
    hrBuildScore >= 4.5 &&
    factors.barrels >= 1 &&
    (factors.avgEV ?? 0) >= 95 &&
    inning >= 5
  ) {
    return { level: "ALERT", triggerReason: "hard_trigger:barrel+avgEV95+inn5+score4.5" };
  }

  if (
    last2.length >= 2 &&
    last2.every(ab => (ab.exitVelocity ?? 0) >= 95 && (ab.launchAngle ?? 0) >= 20 && (ab.launchAngle ?? 0) <= 35)
  ) {
    return { level: "ALERT", triggerReason: "repeat_contact:last2ABs_EV95+_LA20-35" };
  }

  const topEV = (factors.maxEV ?? 0) >= 108;
  const topDistance = recentABs.some(ab => (ab.distance ?? 0) >= 380);
  if ((topEV || topDistance) && hrBuildScore > 3.5) {
    return { level: "ALERT", triggerReason: `leaderboard:${topEV ? "topEV" : "topDistance"}+score${hrBuildScore.toFixed(1)}` };
  }

  if (inning >= 8 && hrBuildScore > 3) {
    return { level: "ALERT", triggerReason: `late_game_spike:inn${inning}+score${hrBuildScore.toFixed(1)}` };
  }

  if (hrBuildScore >= 3.5 && (factors.avgEV ?? 0) >= 92) {
    return { level: "WATCH", triggerReason: "soft_trigger:avgEV92+score3.5" };
  }

  return { level: null, triggerReason: "" };
}
