// Mound Radar — public record + admin calibration stats.
//
// Pure builders only. They read already-stamped MoundSignal rows and never
// mutate runtime state, live probability, persisted_plays, ROI, or W/L.
// Mirrors pregamePowerRadar/calibrationStats.ts's role for pitcher signals.

import type { MoundSignal } from "./types";
import { isPublicMoundSignal } from "./diagnostics";
import { buildMoundWinItem } from "./moundOutcomeAttribution";
import type {
  MoundCalibrationBucket,
  MoundRadarCalibrationStats,
  MoundRadarPublicStats,
  MoundRadarWinItem,
} from "../../../../shared/moundRadarWin";

const SCORE_BANDS = ["<6", "6-7", "7-8", "8-9", "9-10"] as const;

type MutableBucket = MoundCalibrationBucket;

function roundPct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function isPublicMoundWin(signal: MoundSignal): boolean {
  return signal.outcomes?.outcome === "mound_win" && signal.outcomes?.userVisible === true;
}

function isCalibrationMiss(signal: MoundSignal): boolean {
  return signal.outcomes?.outcome === "mound_calibration_miss";
}

function scoreBand(score10: number): typeof SCORE_BANDS[number] {
  if (score10 < 6) return "<6";
  if (score10 < 7) return "6-7";
  if (score10 < 8) return "7-8";
  if (score10 < 9) return "8-9";
  return "9-10";
}

function ensureBucket(map: Record<string, MutableBucket>, key: string): MutableBucket {
  return map[key] ??= { targets: 0, wins: 0, misses: 0, hitRate: 0 };
}

function finalizeBuckets(map: Record<string, MutableBucket>): Record<string, MoundCalibrationBucket> {
  for (const bucket of Object.values(map)) {
    bucket.hitRate = roundPct(bucket.wins, bucket.wins + bucket.misses);
  }
  return map;
}

function rankedWinItems(signals: MoundSignal[]): MoundRadarWinItem[] {
  const flagged = signals
    .filter((s) => s.everPubliclyFlagged)
    .slice()
    .sort((a, b) => b.score10 - a.score10);

  const rankBySignalId = new Map<string, number>();
  flagged.forEach((s, i) => rankBySignalId.set(s.signalId, i + 1));

  return flagged
    .map((s) => buildMoundWinItem(s, rankBySignalId.get(s.signalId) ?? null))
    .filter((w): w is MoundRadarWinItem => w != null);
}

/** Public record stats. Wins-only: misses are not returned, counted, or exposed. */
export function buildMoundPublicStats(
  todaySignals: MoundSignal[],
  last7Signals: MoundSignal[],
  dateET: string,
): MoundRadarPublicStats {
  const todayWins = todaySignals.filter(isPublicMoundWin);
  const last7Wins = last7Signals.filter(isPublicMoundWin);

  return {
    dateET,
    moundWinsToday: todayWins.length,
    pitcherPropsCashedToday: todayWins.length,
    moundWinsLast7Days: last7Wins.length,
    flaggedBeforeFirstPitchToday: todaySignals.filter(isPublicMoundSignal).length,
    topMoundWinPlayers: rankedWinItems(todaySignals).slice(0, 8),
  };
}

/** Admin calibration stats. Full denominator: wins, misses, tier/score/driver/market breakdowns. */
export function buildMoundCalibrationStats(
  signals: MoundSignal[],
  range: { startET: string; endET: string },
): MoundRadarCalibrationStats {
  const targets = signals.filter((s) => s.everPubliclyFlagged);
  const wins = targets.filter(isPublicMoundWin);
  const misses = targets.filter(isCalibrationMiss);

  const byTier: Record<string, MutableBucket> = {};
  const byScoreBand: Record<string, MutableBucket> = {};
  const byDriver: Record<string, MutableBucket> = {};
  const byMarket: Record<string, MutableBucket> = {};

  for (const signal of targets) {
    const win = isPublicMoundWin(signal);
    const miss = isCalibrationMiss(signal);

    const tierBucket = ensureBucket(byTier, signal.tier);
    tierBucket.targets++;
    if (win) tierBucket.wins++;
    if (miss) tierBucket.misses++;

    const scoreBucket = ensureBucket(byScoreBand, scoreBand(signal.score10));
    scoreBucket.targets++;
    if (win) scoreBucket.wins++;
    if (miss) scoreBucket.misses++;

    const marketBucket = ensureBucket(byMarket, signal.primaryMarket);
    marketBucket.targets++;
    if (win) marketBucket.wins++;
    if (miss) marketBucket.misses++;

    for (const driver of signal.drivers.filter((d) => d.direction === "positive")) {
      const driverBucket = ensureBucket(byDriver, driver.key);
      driverBucket.targets++;
      if (win) driverBucket.wins++;
      if (miss) driverBucket.misses++;
    }
  }

  const resolvedCount = wins.length + misses.length;

  return {
    dateRange: range,
    targets: targets.length,
    wins: wins.length,
    calibrationMisses: misses.length,
    hitRate: roundPct(wins.length, resolvedCount),
    byTier: finalizeBuckets(byTier),
    byScoreBand: finalizeBuckets(byScoreBand),
    byDriver: finalizeBuckets(byDriver),
    byMarket: finalizeBuckets(byMarket),
  };
}
