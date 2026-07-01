// Pre-Game Power Radar — Win Attribution transport contracts.
//
// Product attribution rule (do not re-derive on the client):
//   • A Pre-Game Power Target who hits a HR in the same game is a PUBLIC
//     Pregame Radar Win (userVisible = true).
//   • A Pre-Game Power Target who does NOT hit a HR is a calibration moment
//     stored internally only (never surfaced as a public loss).
//
// These types describe what the server stamps; clients render verbatim.

/** Outcome taxonomy stamped on a graded pre-game target. */
export type PregameOutcomeType = "pregame_win" | "calibration_miss";

/** Card label shown for a pregame win. */
export const PREGAME_WIN_LABEL = "PREGAME RADAR WIN" as const;
export const FIRST_AB_PREGAME_WIN_LABEL = "FIRST-AB PREGAME WIN" as const;

/** Card copy lines (server-built, rendered verbatim). */
export const FIRST_AB_PREGAME_WIN_COPY = "Flagged before first pitch · Homered in first AB" as const;
export const PREGAME_WIN_COPY = "Flagged before first pitch · Homered in game" as const;

/** One official, user-visible live HR Radar cash (FIRE-only official grading). */
export interface CashLogItem {
  source: "live_hr_radar";
  playerId: string;
  playerName: string;
  team: string;
  gameId: string;
  market: string;
  side: string;
  hitInning: number | null;
  hitHalf: string | null;
  hitLabel: string | null;
  gradingStatus: string | null;
  resolvedAt: string | null;
}

/** One public Pregame Radar Win row for the daily cashed log. */
export interface PregameRadarWinItem {
  source: "pregame_power_radar";
  signalId: string;
  sessionDate: string;
  gameId: string;
  playerId: string;
  playerName: string;
  team: string;
  opponent: string;
  primaryMarket: string;
  // Pre-game evidence (immutable from build time).
  pregameTier: string;
  pregamePowerScore: number;
  pregameRank: number | null;
  pregameDrivers: Array<{ key: string; label: string; direction: string }>;
  opposingPitcher: string | null;
  parkWeatherBoost: string | null;
  // HR event attribution.
  hrInning: number | null;
  hrHalf: "top" | "bottom" | null;
  plateAppearanceNumber: number | null;
  firstAbPregameWin: boolean;
  // Live-bridge context (read-only mirror of the live HR Radar).
  becameLiveReady: boolean;
  becameLiveFire: boolean;
  resolvedAt: string | null;
  // Display contract.
  label: typeof PREGAME_WIN_LABEL | typeof FIRST_AB_PREGAME_WIN_LABEL;
  cardCopy: string;
}

/** Grouped daily cashed-log response. */
export interface DailyCashedLogResponse {
  officialLiveCashes: CashLogItem[];
  pregameRadarWins: PregameRadarWinItem[];
  firstAbPregameWins: PregameRadarWinItem[];
  engineCashesTotal: number;
}

/** Admin-only calibration rollup (pregame proxy — never official ROI / W-L). */
export interface PregameCalibrationRecord {
  /** Public pregame wins (hit a HR + was publicly flagged). */
  wins: number;
  /** First-AB subset of wins. */
  firstAbWins: number;
  /** Calibration misses (flagged, did not hit a HR) — internal only. */
  calibrationMisses: number;
  /** Graded pregame targets that homered but were not publicly flagged. */
  internalWins: number;
  /** Total graded pregame targets. */
  totalGraded: number;
  /** Public win rate over graded public targets, or null below sample. */
  winRate: number | null;
}

export interface PregameRadarPublicStats {
  dateET: string;
  pregameWinsToday: number;
  firstAbPregameWinsToday: number;
  pregameWinsLast7Days: number;
  firstAbPregameWinsLast7Days: number;
  flaggedBeforeFirstPitchToday: number;
  topPregameWinPlayers: PregameRadarWinItem[];
}

/** One day's entry in the Pregame Radar history drawer. */
export interface PregameRadarDailyHistoryEntry {
  dateET: string;
  flaggedBeforeFirstPitch: number;
  pregameWinsCount: number;
  firstAbPregameWinsCount: number;
  wins: PregameRadarWinItem[];
}

export interface PregameCalibrationBucket {
  targets: number;
  wins: number;
  misses: number;
  hitRate: number;
}

export interface PregameRadarCalibrationStats {
  dateRange: {
    startET: string;
    endET: string;
  };
  targets: number;
  wins: number;
  calibrationMisses: number;
  hitRate: number;
  firstAbWins: number;
  firstAbWinRate: number;
  byTier: Record<string, PregameCalibrationBucket>;
  byScoreBand: Record<string, PregameCalibrationBucket>;
  byDriver: Record<string, PregameCalibrationBucket>;
  targetToLiveReadyRate: number;
  targetToLiveFireRate: number;
  targetToHrRate: number;
}
