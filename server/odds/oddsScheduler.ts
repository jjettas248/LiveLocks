import type { PollingTier, Sport } from "./oddsConfig";
import { getPollingCadenceMs } from "./oddsConfig";
import { logPriorityAssign, setTier } from "./oddsDiagnostics";

const lastPollAt: Record<Sport, Map<string, number>> = {
  mlb: new Map(),
  nba: new Map(),
  ncaab: new Map(),
};

export interface MlbGameContext {
  gameId: string;
  status: "live" | "pregame" | "final" | "unknown";
  inning?: number;
  isTopInning?: boolean;
  hasActiveSignals?: boolean;
  startsInMinutes?: number;
}

export interface NbaGameContext {
  gameId: string;
  status: "live" | "pregame" | "final" | "halftime" | "unknown";
  quarter?: number;
  minutesRemainingInQuarter?: number;
  hasActiveSignals?: boolean;
  startsInMinutes?: number;
}

export interface NcaabGameContext {
  gameId: string;
  status: "live" | "pregame" | "final" | "halftime" | "unknown";
  half?: number;
  minutesRemainingInHalf?: number;
  hasActiveSignals?: boolean;
  startsInMinutes?: number;
}

const MLB_TRIGGER_INNINGS = new Set([1, 3, 5, 7]);

export function assignMlbTier(ctx: MlbGameContext): PollingTier {
  if (ctx.status === "final") return "idle";
  if (ctx.status === "pregame") {
    if ((ctx.startsInMinutes ?? Infinity) <= 15) return "high";
    if ((ctx.startsInMinutes ?? Infinity) <= 60) return "normal";
    return "low";
  }
  if (ctx.status === "live") {
    if (ctx.hasActiveSignals) return "critical";
    if (ctx.inning != null && MLB_TRIGGER_INNINGS.has(ctx.inning)) return "critical";
    if (ctx.inning != null && ctx.inning >= 8) return "high";
    return "high";
  }
  return "low";
}

export function assignNbaTier(ctx: NbaGameContext): PollingTier {
  if (ctx.status === "final") return "idle";
  if (ctx.status === "halftime") return "critical";
  if (ctx.status === "pregame") {
    if ((ctx.startsInMinutes ?? Infinity) <= 10) return "high";
    if ((ctx.startsInMinutes ?? Infinity) <= 60) return "normal";
    return "low";
  }
  if (ctx.status === "live") {
    if (ctx.hasActiveSignals) return "critical";
    if (ctx.quarter === 3 && (ctx.minutesRemainingInQuarter ?? 12) <= 4) return "critical";
    if (ctx.quarter === 4) return "high";
    return "normal";
  }
  return "low";
}

export function assignNcaabTier(ctx: NcaabGameContext): PollingTier {
  if (ctx.status === "final") return "idle";
  if (ctx.status === "halftime") return "critical";
  if (ctx.status === "pregame") {
    if ((ctx.startsInMinutes ?? Infinity) <= 10) return "high";
    if ((ctx.startsInMinutes ?? Infinity) <= 60) return "normal";
    return "low";
  }
  if (ctx.status === "live") {
    if (ctx.hasActiveSignals) return "critical";
    if (ctx.half === 2 && (ctx.minutesRemainingInHalf ?? 20) <= 5) return "critical";
    if (ctx.half === 2) return "high";
    return "normal";
  }
  return "low";
}

export function shouldPoll(sport: Sport, gameId: string, tier: PollingTier, now = Date.now()): boolean {
  const cadence = getPollingCadenceMs(tier);
  const last = lastPollAt[sport].get(gameId) ?? 0;
  return now - last >= cadence;
}

export function markPolled(sport: Sport, gameId: string, tier: PollingTier, now = Date.now()): void {
  lastPollAt[sport].set(gameId, now);
  setTier(sport, gameId, tier);
}

export function assignAndCheckPoll(
  sport: Sport,
  gameId: string,
  tier: PollingTier,
  now = Date.now()
): { tier: PollingTier; shouldPoll: boolean; lastPollAgeMs: number } {
  setTier(sport, gameId, tier);
  const last = lastPollAt[sport].get(gameId) ?? 0;
  const lastPollAgeMs = last === 0 ? Infinity : now - last;
  const due = shouldPoll(sport, gameId, tier, now);
  return { tier, shouldPoll: due, lastPollAgeMs };
}

export function logTierAssignment(sport: Sport, gameId: string, tier: PollingTier, reason: string): void {
  setTier(sport, gameId, tier);
  logPriorityAssign(sport, { gameId, tier, reason });
}

export function clearGame(sport: Sport, gameId: string): void {
  lastPollAt[sport].delete(gameId);
}
