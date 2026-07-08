// Mound Radar — Outcome Attribution (pure core). Named for both outcomes it
// handles (wins AND calibration misses), not "win attribution" alone.
//
// Settlement rule (locked product decision — season baseline, no sportsbook
// line involved, mirrors Plate's no-market-line philosophy):
//   • A `pitcher_strikeouts` target is a `mound_win` when final game
//     strikeouts meet/beat the pitcher's season K/9-implied per-start rate
//     (K/9 * 6/9 innings, matching recentForm.ts's per-start expectation).
//   • A `pitcher_outs` target is a `mound_win` when final game outs recorded
//     meet/beat the pitcher's season average outs-per-start.
//   • Anything that doesn't clear the bar (or lacks the data to verify) is a
//     `mound_calibration_miss` — internal only, never a public loss.
//   • A target that clears the bar but was NOT publicly flagged is recorded
//     as a `mound_win` internally (userVisible = false).
//
// Pure (no I/O). Mirrors pregamePowerRadar/winAttribution.ts's role and
// structure for pitcher signals — no shared code.

import type { MoundDriver, MoundSignal } from "./types";
import type { MoundDirection } from "./moundDirection";
import {
  type MoundRadarWinItem,
  type MoundOutcomeType,
  MOUND_WIN_LABEL,
  MOUND_WIN_COPY,
  MOUND_FADE_WIN_LABEL,
  MOUND_FADE_WIN_COPY,
} from "../../../../shared/moundRadarWin";
import { formatPlainDateLabel } from "../../../../shared/dateLabel";
import { toEtDateKey, toEtTimeLabel } from "../../../utils/dateUtils";
import { round1, projectedStrikeoutsFromKPer9 } from "./scoreUtils";

export interface MoundOutcomeAttributionInput {
  primaryMarket: "pitcher_strikeouts" | "pitcher_outs";
  finalStrikeouts: number | null;
  finalOutsRecorded: number | null;
  seasonKPer9: number | null;
  seasonAvgInningsPerStart: number | null;
  wasPubliclyFlagged: boolean;
  /** Direction stamped at build time (moundDirection.ts) — read as-is, never recomputed here. "follow"/null keeps the original Over-only rule unchanged; "fade" flips the comparison. */
  moundDirection: MoundDirection;
}

export interface MoundOutcomeAttributionResult {
  outcome: MoundOutcomeType;
  userVisible: boolean;
  seasonBaselineValue: number | null;
}

/** Season-baseline per-start expectation for the given primary market. */
function seasonBaseline(input: MoundOutcomeAttributionInput): number | null {
  if (input.primaryMarket === "pitcher_strikeouts") {
    return projectedStrikeoutsFromKPer9(input.seasonKPer9);
  }
  return input.seasonAvgInningsPerStart != null ? round1(input.seasonAvgInningsPerStart * 3) : null;
}

export function deriveMoundOutcome(input: MoundOutcomeAttributionInput): MoundOutcomeAttributionResult {
  const baseline = seasonBaseline(input);
  const actual = input.primaryMarket === "pitcher_strikeouts" ? input.finalStrikeouts : input.finalOutsRecorded;

  if (baseline == null || actual == null) {
    return { outcome: "mound_calibration_miss", userVisible: false, seasonBaselineValue: baseline };
  }

  const clearedOver = actual >= baseline;

  if (input.moundDirection === "fade") {
    // Fade recommendation is correct when the pitcher UNDERSHOOTS the
    // baseline — the opposite comparison from the Follow/Over rule below.
    const fadeCashed = !clearedOver;
    if (!fadeCashed) {
      return { outcome: "mound_calibration_miss", userVisible: false, seasonBaselineValue: baseline };
    }
    return { outcome: "mound_fade_win", userVisible: input.wasPubliclyFlagged === true, seasonBaselineValue: baseline };
  }

  // Follow (or no direction) — unchanged Over-only rule.
  if (!clearedOver) {
    return { outcome: "mound_calibration_miss", userVisible: false, seasonBaselineValue: baseline };
  }
  return { outcome: "mound_win", userVisible: input.wasPubliclyFlagged === true, seasonBaselineValue: baseline };
}

function moundDriverDigest(drivers: MoundDriver[]): MoundRadarWinItem["moundDrivers"] {
  return drivers
    .filter((d) => d.direction === "positive")
    .slice(0, 5)
    .map((d) => ({ key: d.key, label: d.label, direction: d.direction }));
}

function resolveSlateDateET(signal: MoundSignal): string {
  if (signal.sessionDate) return signal.sessionDate;
  if (signal.startsAt) return toEtDateKey(signal.startsAt);
  return signal.gameDate;
}

/** Shared builder for both outcome kinds — only the wanted outcome type and label/copy differ. */
function moundWinItemForOutcome(
  signal: MoundSignal,
  rank: number | null,
  wantOutcome: "mound_win" | "mound_fade_win",
): MoundRadarWinItem | null {
  const o = signal.outcomes;
  if (!o || o.outcome !== wantOutcome || o.userVisible !== true) return null;

  const slateDateET = resolveSlateDateET(signal);
  return {
    source: "mound_radar",
    signalId: signal.signalId,
    sessionDate: signal.sessionDate,
    gameId: signal.gameId,
    playerId: signal.pitcherId,
    playerName: signal.pitcherName,
    team: signal.team,
    opponent: signal.opponent,
    primaryMarket: signal.primaryMarket,
    moundTier: signal.tier,
    moundScore: signal.score10,
    moundRank: rank,
    moundDrivers: moundDriverDigest(signal.drivers),
    opposingLineupLabel: signal.opposingLineupLabel,
    finalStrikeouts: o.finalStrikeouts ?? null,
    finalOutsRecorded: o.finalOutsRecorded ?? null,
    seasonBaselineValue: o.seasonBaselineValue ?? null,
    slateDateET,
    displayDateLabel: formatPlainDateLabel(slateDateET),
    gameStartTimeET: signal.startsAt ? toEtTimeLabel(signal.startsAt) : null,
    detectedBeforeFirstPitch: true,
    label: wantOutcome === "mound_win" ? MOUND_WIN_LABEL : MOUND_FADE_WIN_LABEL,
    cardCopy: wantOutcome === "mound_win" ? MOUND_WIN_COPY : MOUND_FADE_WIN_COPY,
  };
}

/**
 * Map a graded, won (Follow/Over) mound signal to a public daily-log row.
 * Returns null when the signal is not a userVisible mound_win.
 */
export function buildMoundWinItem(signal: MoundSignal, rank: number | null): MoundRadarWinItem | null {
  return moundWinItemForOutcome(signal, rank, "mound_win");
}

/**
 * Map a graded, cashed Fade (Under) mound signal to a public daily-log row —
 * fully separate from buildMoundWinItem, never blended into the same list.
 * Returns null when the signal is not a userVisible mound_fade_win.
 */
export function buildMoundFadeWinItem(signal: MoundSignal, rank: number | null): MoundRadarWinItem | null {
  return moundWinItemForOutcome(signal, rank, "mound_fade_win");
}

function rankedList(signals: MoundSignal[], wantOutcome: "mound_win" | "mound_fade_win"): MoundRadarWinItem[] {
  const flagged = signals
    .filter((s) => s.outcomes?.outcome === wantOutcome && s.outcomes?.userVisible === true)
    .slice()
    .sort((a, b) => b.score10 - a.score10);

  const rankBySignalId = new Map<string, number>();
  flagged.forEach((s, i) => rankBySignalId.set(s.signalId, i + 1));

  return flagged
    .map((s) => moundWinItemForOutcome(s, rankBySignalId.get(s.signalId) ?? null, wantOutcome))
    .filter((w): w is MoundRadarWinItem => w != null);
}

/**
 * Build the grouped mound-win list for the daily cashed log. Wins are ranked
 * by pre-game score (desc) across the supplied signals.
 */
export function buildDailyMoundWins(signals: MoundSignal[]): {
  moundRadarWins: MoundRadarWinItem[];
} {
  return { moundRadarWins: rankedList(signals, "mound_win") };
}

/** Fully separate Fade-win daily list — mirrors buildDailyMoundWins, never merged with it. */
export function buildDailyMoundFadeWins(signals: MoundSignal[]): {
  moundRadarFadeWins: MoundRadarWinItem[];
} {
  return { moundRadarFadeWins: rankedList(signals, "mound_fade_win") };
}
