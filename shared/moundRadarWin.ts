// Mound Radar — Outcome Attribution transport contracts.
//
// Parallel to shared/pregameRadarWin.ts (NOT an extension of it — Plate and
// Mound outcome types are kept fully separate per architecture rule).
//
// Settlement rule (season-baseline, no sportsbook line involved):
//   • A Follow-direction (or no-direction) `pitcher_strikeouts` target is a
//     `mound_win` when the pitcher's final game strikeouts meet/beat their
//     season K/9-implied per-start rate. A `pitcher_outs` target is a
//     `mound_win` when final outs recorded meet/beat the season average
//     outs-per-start.
//   • A Fade-direction target (moundDirection stamped "fade" at build time —
//     see moundDirection.ts) is the OPPOSITE rule: a `mound_fade_win` when
//     the final total lands UNDER the same season baseline — the fade call
//     was correct. Tracked as a fully separate outcome/stat, never blended
//     into `mound_win`'s counters (an Over win and an Under win are opposite
//     bets).
//   • Anything else graded is a `mound_calibration_miss` (internal only,
//     never surfaced as a public loss — mirrors Plate's `calibration_miss`).
//
// These types describe what the server stamps; clients render verbatim.

/** Outcome taxonomy stamped on a graded mound target. */
export type MoundOutcomeType = "mound_win" | "mound_fade_win" | "mound_calibration_miss";

/**
 * Market settlement taxonomy — a SIBLING to MoundOutcomeType, never merged
 * with it. MoundOutcomeType grades a pitcher's final stat against their own
 * season baseline (internal calibration). MoundMarketOutcome grades the
 * recommended side against a real, frozen-pregame sportsbook line — the
 * only thing legitimately allowed to be called "Cashed"/"Missed"/"Push" on
 * a public surface. "unavailable" whenever no such line was ever captured
 * (always true for pitcher_outs today; sometimes true for
 * pitcher_strikeouts) — never fabricated, never backfilled from a
 * projection or the season baseline.
 */
export type MoundMarketOutcome = "cashed" | "missed" | "push" | "unavailable";

/**
 * Which frozen snapshot a market-graded line's provenance came from. Single
 * value today (the last pre-lock evaluation snapshot, "closing line"
 * equivalent) — extensible if another legitimate freeze point is ever
 * added. Never a live/current line, never fetched after the game.
 */
export type MoundLineSnapshotType = "final_pregame";

/** Card label shown for a mound win (Follow/Over). */
export const MOUND_WIN_LABEL = "MOUND RADAR WIN" as const;

/** Card copy line (server-built, rendered verbatim). Model-calibration language only — never "Cashed"; see MoundMarketOutcome for the market-facing equivalent. */
export const MOUND_WIN_COPY = "Flagged before first pitch · Model read confirmed" as const;

/** Card label shown for a mound Fade win (Under) — distinct copy required so it never misleadingly reads like an Over cash. */
export const MOUND_FADE_WIN_LABEL = "MOUND RADAR FADE WIN" as const;

/** Card copy line for a Fade win (server-built, rendered verbatim). Model-calibration language only — never "cashed". */
export const MOUND_FADE_WIN_COPY = "Flagged before first pitch · Fade model read confirmed" as const;

/** One public Mound Radar Win row for the daily cashed log. */
export interface MoundRadarWinItem {
  source: "mound_radar";
  signalId: string;
  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  opponent: string;
  primaryMarket: string;
  // Pre-game evidence (immutable from build time).
  moundTier: string;
  moundScore: number;
  moundRank: number | null;
  moundDrivers: Array<{ key: string; label: string; direction: string }>;
  opposingLineupLabel: string | null;
  // Settlement attribution.
  finalStrikeouts: number | null;
  finalOutsRecorded: number | null;
  seasonBaselineValue: number | null;
  // Canonical date attribution (server-stamped — clients render verbatim).
  slateDateET: string;
  displayDateLabel: string;
  gameStartTimeET: string | null;
  detectedBeforeFirstPitch: true;
  // Display contract.
  label: typeof MOUND_WIN_LABEL | typeof MOUND_FADE_WIN_LABEL;
  cardCopy: string;
}

/** Admin-only calibration rollup (mound proxy — never official ROI / W-L). */
export interface MoundCalibrationRecord {
  /** Public mound wins (Follow/Over — cashed the season-baseline bar + was publicly flagged). */
  wins: number;
  /** Calibration misses (flagged, did not clear the bar) — internal only. */
  calibrationMisses: number;
  /** Graded mound targets that cashed (Follow/Over) but were not publicly flagged. */
  internalWins: number;
  /** Public mound Fade wins — fully separate from `wins`, never blended. */
  fadeWins: number;
  /** Graded Fade targets that cashed but were not publicly flagged. */
  internalFadeWins: number;
  /** Total graded mound targets. */
  totalGraded: number;
  /** Public win rate over graded public targets, or null below sample. */
  winRate: number | null;
}

export interface MoundRadarPublicStats {
  dateET: string;
  moundWinsToday: number;
  pitcherPropsCashedToday: number;
  moundWinsLast7Days: number;
  flaggedBeforeFirstPitchToday: number;
  topMoundWinPlayers: MoundRadarWinItem[];
  /** Fully separate "Fades Today" stat — Fade wins never blend into moundWinsToday/pitcherPropsCashedToday above. */
  moundFadeWinsToday: number;
  fadePropsCashedToday: number;
  moundFadeWinsLast7Days: number;
  flaggedFadeBeforeFirstPitchToday: number;
  topMoundFadeWinPlayers: MoundRadarWinItem[];
}

export interface MoundCalibrationBucket {
  targets: number;
  wins: number;
  misses: number;
  hitRate: number;
}

export interface MoundRadarCalibrationStats {
  dateRange: {
    startET: string;
    endET: string;
  };
  targets: number;
  wins: number;
  calibrationMisses: number;
  hitRate: number;
  byTier: Record<string, MoundCalibrationBucket>;
  byScoreBand: Record<string, MoundCalibrationBucket>;
  byDriver: Record<string, MoundCalibrationBucket>;
  byMarket: Record<string, MoundCalibrationBucket>;
  /** Admin-only: Fade-specific vs Follow-specific hit rate — Fade wins are fully separate from the top-line wins/hitRate above. */
  byDirection: Record<"fade" | "follow", MoundCalibrationBucket>;
}
