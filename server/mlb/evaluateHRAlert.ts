import type { HRBuildResult } from "./HRSignalBuilder";

export type HRAlertLevel = "ALERT" | "WATCH" | null;
export type HRSignalState = "PEAK" | "BUILDING" | "FORMATION" | "COOLDOWN" | null;
export type HRDecision = "BET_NOW" | "PREPARE" | "MONITOR" | null;

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
  signalState: HRSignalState;
  decision: HRDecision;
  confidenceScore: number;
  formattedReason: string;
  detectedInning: number;
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

function formatReason(trigger: string, factors: HRBuildResult["factors"], inning: number): string {
  if (trigger.includes("barrel") && trigger.includes("avgEV95")) {
    return `Barrel contact + 95+ EV trend. Power building into ${ordinal(inning)} inning window.`;
  }
  if (trigger.startsWith("repeat_contact")) {
    return "Back-to-back hard contact (95+ EV, optimal launch angle). HR probability spiking.";
  }
  if (trigger.startsWith("leaderboard:")) {
    const sub = trigger.replace("leaderboard:", "");
    if (sub.includes("topEV")) {
      return `Game-leading exit velocity (${factors.maxEV?.toFixed(0) ?? "105+"}mph). Elite barrel potential.`;
    }
    if (sub.includes("topDistance")) {
      return "Deep flyball contact today — distance leaderboard-level. HR conditions active.";
    }
    return "Leaderboard-level contact metrics this game. Power indicators elevated.";
  }
  if (trigger.startsWith("late_game_spike")) {
    return `Late-game power spike (${ordinal(inning)} inning). Contact quality rising against tired bullpen.`;
  }
  if (trigger.startsWith("soft_trigger")) {
    return "Consistent hard contact building. EV averaging 92+ with rising build score.";
  }
  return "Power indicators increasing — monitoring contact quality.";
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function computeConfidence(hrBuildScore: number, factors: HRBuildResult["factors"]): number {
  let base = Math.min(10, Math.round(hrBuildScore * 2));
  if ((factors.barrels ?? 0) >= 2) base = Math.min(10, base + 1);
  if ((factors.maxEV ?? 0) >= 108) base = Math.min(10, base + 1);
  return Math.max(1, base);
}

export function evaluateHRAlert(input: HRAlertInput): HRAlertResult {
  const { hrBuildScore, factors, inning, priorABResults } = input;

  const baseResult = {
    detectedInning: inning,
  };

  if (isOnCooldown(input.playerId, input.gameId)) {
    return {
      level: null,
      triggerReason: "cooldown",
      signalState: "COOLDOWN",
      decision: null,
      confidenceScore: computeConfidence(hrBuildScore, factors),
      formattedReason: "Recently alerted — signal on cooldown. Monitoring for re-escalation.",
      ...baseResult,
    };
  }

  const recentABs = priorABResults.slice(-3);
  const last2 = priorABResults.slice(-2);

  if (
    hrBuildScore >= 4.5 &&
    factors.barrels >= 1 &&
    (factors.avgEV ?? 0) >= 95 &&
    inning >= 5
  ) {
    const trigger = "hard_trigger:barrel+avgEV95+inn5+score4.5";
    return {
      level: "ALERT",
      triggerReason: trigger,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: computeConfidence(hrBuildScore, factors),
      formattedReason: formatReason(trigger, factors, inning),
      ...baseResult,
    };
  }

  if (
    last2.length >= 2 &&
    last2.every(ab => (ab.exitVelocity ?? 0) >= 95 && (ab.launchAngle ?? 0) >= 20 && (ab.launchAngle ?? 0) <= 35)
  ) {
    const trigger = "repeat_contact:last2ABs_EV95+_LA20-35";
    return {
      level: "ALERT",
      triggerReason: trigger,
      signalState: "PEAK",
      decision: "BET_NOW",
      confidenceScore: computeConfidence(hrBuildScore, factors),
      formattedReason: formatReason(trigger, factors, inning),
      ...baseResult,
    };
  }

  const topEV = (factors.maxEV ?? 0) >= 108;
  const topDistance = recentABs.some(ab => (ab.distance ?? 0) >= 380);
  if ((topEV || topDistance) && hrBuildScore > 3.5) {
    const trigger = `leaderboard:${topEV ? "topEV" : "topDistance"}+score${hrBuildScore.toFixed(1)}`;
    return {
      level: "ALERT",
      triggerReason: trigger,
      signalState: "BUILDING",
      decision: "PREPARE",
      confidenceScore: computeConfidence(hrBuildScore, factors),
      formattedReason: formatReason(trigger, factors, inning),
      ...baseResult,
    };
  }

  if (inning >= 8 && hrBuildScore > 3) {
    const trigger = `late_game_spike:inn${inning}+score${hrBuildScore.toFixed(1)}`;
    return {
      level: "ALERT",
      triggerReason: trigger,
      signalState: "BUILDING",
      decision: "PREPARE",
      confidenceScore: computeConfidence(hrBuildScore, factors),
      formattedReason: formatReason(trigger, factors, inning),
      ...baseResult,
    };
  }

  if (hrBuildScore >= 3.5 && (factors.avgEV ?? 0) >= 92) {
    const trigger = "soft_trigger:avgEV92+score3.5";
    return {
      level: "WATCH",
      triggerReason: trigger,
      signalState: "FORMATION",
      decision: "MONITOR",
      confidenceScore: computeConfidence(hrBuildScore, factors),
      formattedReason: formatReason(trigger, factors, inning),
      ...baseResult,
    };
  }

  return {
    level: null,
    triggerReason: "",
    signalState: null,
    decision: null,
    confidenceScore: 0,
    formattedReason: "",
    detectedInning: inning,
  };
}
