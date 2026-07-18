// Pre-Game Power Radar — public record + admin calibration stats.
//
// Pure builders only. They read already-stamped PregamePowerSignal rows and
// never mutate runtime state, live HR probability, persisted_plays, ROI, or W/L.

import type { PregamePowerSignal } from "./types";
import { isPublicPregameSignal } from "./diagnostics";
import { buildPregameRadarWinItem } from "./winAttribution";
import type {
  PregameCalibrationBucket,
  PregameRadarCalibrationStats,
  PregameRadarPublicStats,
  PregameRadarWinItem,
} from "../../../shared/pregameRadarWin";

const SCORE_BANDS = ["<6", "6-7", "7-8", "8-9", "9-10"] as const;

type MutableBucket = PregameCalibrationBucket;

function roundPct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function isPublicPregameWin(signal: PregamePowerSignal): boolean {
  return signal.outcomes?.outcome === "pregame_win" && signal.outcomes?.userVisible === true;
}

function isCalibrationMiss(signal: PregamePowerSignal): boolean {
  return signal.outcomes?.outcome === "calibration_miss";
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

function finalizeBuckets(map: Record<string, MutableBucket>): Record<string, PregameCalibrationBucket> {
  for (const bucket of Object.values(map)) {
    bucket.hitRate = roundPct(bucket.wins, bucket.wins + bucket.misses);
  }
  return map;
}

function rankedWinItems(signals: PregamePowerSignal[]): PregameRadarWinItem[] {
  const flagged = signals
    .filter((s) => s.everPubliclyFlagged)
    .slice()
    .sort((a, b) => b.score10 - a.score10);

  const rankBySignalId = new Map<string, number>();
  flagged.forEach((s, i) => rankBySignalId.set(s.signalId, i + 1));

  return flagged
    .map((s) => buildPregameRadarWinItem(s, rankBySignalId.get(s.signalId) ?? null))
    .filter((w): w is PregameRadarWinItem => w != null);
}

/**
 * Public record stats. Wins-only: misses are not returned, counted, or exposed.
 *
 * `flaggedBeforeFirstPitchToday` intentionally uses `isPublicPregameSignal` (not
 * the broader `wasPubliclyFlaggedPregame`) so it always matches the count of
 * targets a user could actually see on the live radar — wins stay visible
 * after grading, but a target whose game already went final without a HR drops
 * out of both the live list and this count. Counting the raw intrinsic-eligible
 * total here would silently include those hidden misses, producing a number
 * with no on-screen target list to back it up and implicitly disclosing a miss
 * rate next to "Wins Today" — exactly what the wins-only design forbids.
 */
export function buildPublicStats(
  todaySignals: PregamePowerSignal[],
  last7Signals: PregamePowerSignal[],
  dateET: string,
): PregameRadarPublicStats {
  const todayWins = todaySignals.filter(isPublicPregameWin);
  const last7Wins = last7Signals.filter(isPublicPregameWin);

  return {
    dateET,
    pregameWinsToday: todayWins.length,
    firstAbPregameWinsToday: todayWins.filter((s) => s.outcomes?.firstAbPregameWin === true).length,
    pregameWinsLast7Days: last7Wins.length,
    firstAbPregameWinsLast7Days: last7Wins.filter((s) => s.outcomes?.firstAbPregameWin === true).length,
    flaggedBeforeFirstPitchToday: todaySignals.filter(isPublicPregameSignal).length,
    topPregameWinPlayers: rankedWinItems(todaySignals).slice(0, 8),
  };
}

/**
 * Admin calibration stats. Full denominator for public pregame targets: wins,
 * misses, tier/score/driver breakdowns, and target→live/HR conversion rates.
 */
export function buildCalibrationStats(
  signals: PregamePowerSignal[],
  range: { startET: string; endET: string },
): PregameRadarCalibrationStats {
  const targets = signals.filter((s) => s.everPubliclyFlagged);
  const wins = targets.filter(isPublicPregameWin);
  const misses = targets.filter(isCalibrationMiss);
  // `resolved` = every settled target (wins + misses) — the same set
  // `resolvedCount` below counts. A miss is NEVER ambiguous (firstAbPregameWin
  // is always definitively false for a miss), so it belongs in the first-AB
  // denominator exactly as it always has; only a WIN whose AB-sequencing data
  // was unavailable ("unknown") is genuinely indeterminate and must be
  // excluded from the denominator entirely — narrowing the denominator to
  // wins-only would silently change the metric's meaning from "first-AB win
  // rate among all resolved targets" to "share of HR wins in the first AB".
  const resolved = [...wins, ...misses];
  const knownFirstAbWins = resolved.filter((s) => s.outcomes?.firstAbPregameWin === true);
  // Filtered from `resolved` (not `wins`) so every miss is correctly absorbed
  // here too — this is what keeps `knownFirstAbWins.length + laterAbWins.length`
  // mathematically identical to `knownOrderResolvedCount` below.
  const laterAbWins = resolved.filter((s) => s.outcomes?.firstAbPregameWin === false);
  const unknownOrderWins = resolved.filter((s) => s.outcomes?.firstAbPregameWin === "unknown");

  const byTier: Record<string, MutableBucket> = {};
  const byScoreBand: Record<string, MutableBucket> = {};
  const byDriver: Record<string, MutableBucket> = {};

  for (const signal of targets) {
    const win = isPublicPregameWin(signal);
    const miss = isCalibrationMiss(signal);

    const tierBucket = ensureBucket(byTier, signal.tier);
    tierBucket.targets++;
    if (win) tierBucket.wins++;
    if (miss) tierBucket.misses++;

    const scoreBucket = ensureBucket(byScoreBand, scoreBand(signal.score10));
    scoreBucket.targets++;
    if (win) scoreBucket.wins++;
    if (miss) scoreBucket.misses++;

    for (const driver of signal.drivers.filter((d) => d.direction === "positive")) {
      const driverBucket = ensureBucket(byDriver, driver.key);
      driverBucket.targets++;
      if (win) driverBucket.wins++;
      if (miss) driverBucket.misses++;
    }
  }

  const targetCount = targets.length;
  const resolvedCount = wins.length + misses.length;
  // Excludes only the genuinely-ambiguous unknown-order wins from the
  // denominator — preserves the original "rate over all resolved targets"
  // meaning rather than narrowing to a different "share of HR wins" metric.
  const knownOrderResolvedCount = resolvedCount - unknownOrderWins.length;

  return {
    dateRange: range,
    targets: targetCount,
    wins: wins.length,
    calibrationMisses: misses.length,
    hitRate: roundPct(wins.length, resolvedCount),
    firstAbWins: knownFirstAbWins.length,
    laterAbWins: laterAbWins.length,
    unknownOrderWins: unknownOrderWins.length,
    firstAbWinRate: roundPct(knownFirstAbWins.length, knownOrderResolvedCount),
    byTier: finalizeBuckets(byTier),
    byScoreBand: finalizeBuckets(byScoreBand),
    byDriver: finalizeBuckets(byDriver),
    targetToLiveReadyRate: roundPct(targets.filter((s) => s.becameLiveReady === true).length, targetCount),
    targetToLiveFireRate: roundPct(targets.filter((s) => s.becameLiveFire === true).length, targetCount),
    targetToHrRate: roundPct(wins.length, resolvedCount),
  };
}
