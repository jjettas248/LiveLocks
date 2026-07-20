// Mound Radar — public record + admin calibration stats.
//
// Pure builders only. They read already-stamped MoundSignal rows and never
// mutate runtime state, live probability, persisted_plays, ROI, or W/L.
// Mirrors pregamePowerRadar/calibrationStats.ts's role for pitcher signals.

import type { MoundSignal } from "./types";
import { flaggedBeforeFirstPitchMound } from "./diagnostics";
import { buildMoundWinItem, buildMoundFadeWinItem } from "./moundOutcomeAttribution";
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

// Follow/Over wins only — unchanged meaning. Fade wins are counted
// separately via isPublicMoundFadeWin below and never blended in here.
function isPublicMoundWin(signal: MoundSignal): boolean {
  return signal.outcomes?.outcome === "mound_win" && signal.outcomes?.userVisible === true;
}

// Fully separate from isPublicMoundWin — a cashed Fade is the opposite bet
// from a cashed Follow/Over, so it must never be summed into the same total.
function isPublicMoundFadeWin(signal: MoundSignal): boolean {
  return signal.outcomes?.outcome === "mound_fade_win" && signal.outcomes?.userVisible === true;
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

function rankedItems(signals: MoundSignal[], kind: "win" | "fade_win"): MoundRadarWinItem[] {
  // everPubliclyFlagged (Follow) and everPubliclyFlaggedFade (Fade) are
  // fully separate flags — see wasPubliclyFlaggedMoundFade's doc comment.
  const flagged = signals
    .filter((s) => (kind === "win" ? s.everPubliclyFlagged : s.everPubliclyFlaggedFade))
    .slice()
    .sort((a, b) => b.score10 - a.score10);

  const rankBySignalId = new Map<string, number>();
  flagged.forEach((s, i) => rankBySignalId.set(s.signalId, i + 1));

  const build = kind === "win" ? buildMoundWinItem : buildMoundFadeWinItem;
  return flagged
    .map((s) => build(s, rankBySignalId.get(s.signalId) ?? null))
    .filter((w): w is MoundRadarWinItem => w != null);
}

/** Public record stats. Wins-only: misses are not returned, counted, or exposed. Fade wins are a fully separate stat block, never blended into the Follow/Over fields above them. */
export function buildMoundPublicStats(
  todaySignals: MoundSignal[],
  last7Signals: MoundSignal[],
  dateET: string,
): MoundRadarPublicStats {
  const todayWins = todaySignals.filter(isPublicMoundWin);
  const last7Wins = last7Signals.filter(isPublicMoundWin);
  const todayFadeWins = todaySignals.filter(isPublicMoundFadeWin);
  const last7FadeWins = last7Signals.filter(isPublicMoundFadeWin);

  return {
    dateET,
    moundWinsToday: todayWins.length,
    pitcherPropsCashedToday: todayWins.length,
    moundWinsLast7Days: last7Wins.length,
    flaggedBeforeFirstPitchToday: todaySignals.filter(flaggedBeforeFirstPitchMound).length,
    topMoundWinPlayers: rankedItems(todaySignals, "win").slice(0, 8),
    moundFadeWinsToday: todayFadeWins.length,
    fadePropsCashedToday: todayFadeWins.length,
    moundFadeWinsLast7Days: last7FadeWins.length,
    flaggedFadeBeforeFirstPitchToday: todaySignals.filter((s) => s.everPubliclyFlaggedFade).length,
    topMoundFadeWinPlayers: rankedItems(todaySignals, "fade_win").slice(0, 8),
  };
}

/** Admin calibration stats. Full denominator: wins, misses, tier/score/driver/market breakdowns. */
export function buildMoundCalibrationStats(
  signals: MoundSignal[],
  range: { startET: string; endET: string },
): MoundRadarCalibrationStats {
  // Follow-only denominator — unchanged from before Fade existed. Fade
  // signals are never everPubliclyFlagged (wasPubliclyFlaggedMound's
  // tierEligible check excludes "track" tier), so they never enter this
  // array or the byTier/byScoreBand/byDriver/byMarket breakdowns below —
  // those stay exactly as they were, uncorrupted by Fade attempts.
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

  // Admin-only: Fade-specific vs Follow-specific hit rate. Fade's
  // denominator is everPubliclyFlaggedFade — fully separate from `targets`
  // above, never merged — so a Fade miss/win can never leak into the
  // Follow-only byTier/byScoreBand/byDriver/byMarket breakdowns or the
  // top-line wins/hitRate. `follow` here mirrors the top-line stats exactly,
  // since `targets` is inherently Follow-only today.
  const fadeTargets = signals.filter((s) => s.everPubliclyFlaggedFade);
  const fadeWins = fadeTargets.filter(isPublicMoundFadeWin);
  const fadeMisses = fadeTargets.filter(isCalibrationMiss);
  const byDirection: Record<"fade" | "follow", MoundCalibrationBucket> = {
    fade: {
      targets: fadeTargets.length,
      wins: fadeWins.length,
      misses: fadeMisses.length,
      hitRate: roundPct(fadeWins.length, fadeWins.length + fadeMisses.length),
    },
    follow: {
      targets: targets.length,
      wins: wins.length,
      misses: misses.length,
      hitRate: roundPct(wins.length, resolvedCount),
    },
  };

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
    byDirection,
  };
}
