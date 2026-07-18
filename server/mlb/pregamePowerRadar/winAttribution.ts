// Pre-Game Power Radar — Win Attribution (pure core).
//
// Product rule (settled — not re-litigated here):
//   • A publicly-flagged pre-game target who homers → `pregame_win`
//     (userVisible = true). It is added to the daily cashed log, the Pregame
//     Radar Record, Engine Cashes, and admin calibration as a hit.
//   • A pre-game target who does NOT homer → `calibration_miss`
//     (userVisible = false). Internal calibration only — never a public loss.
//   • A target that homers but was NOT publicly flagged is recorded as a
//     `pregame_win` internally (userVisible = false) so it never leaks into the
//     public win log yet still counts in calibration analytics.
//
// This module is pure (no I/O). All upstream data is passed in so it can be
// unit-tested deterministically. Every input is optional and degrades to a
// safe no-op when absent (CLAUDE.md §7a — additive, no-op when missing).

import type { PowerDriver, PregamePowerSignal } from "./types";
import {
  type PregameRadarWinItem,
  PREGAME_WIN_LABEL,
  FIRST_AB_PREGAME_WIN_LABEL,
  PREGAME_WIN_COPY,
  FIRST_AB_PREGAME_WIN_COPY,
} from "../../../shared/pregameRadarWin";
import { formatPlainDateLabel } from "../../../shared/dateLabel";
import { toEtDateKey, toEtTimeLabel } from "../../utils/dateUtils";

/** Minimal AB shape (subset of dataPullService priorABResults). */
export interface PlayerAbResult {
  hitType?: "single" | "double" | "triple" | "home_run" | null;
  inning?: number | null;
  half?: "top" | "bottom" | null;
}

/** Where in the player's PA sequence the HR landed. */
export interface HrLocation {
  inning: number | null;
  half: "top" | "bottom" | null;
  /** 1-based plate-appearance number of the HR. */
  plateAppearanceNumber: number;
  /** True when the HR was the player's first plate appearance. */
  firstAb: boolean;
}

/**
 * Find the player's HR within their ordered game ABs. Returns null when no HR
 * AB is present (the caller falls back to play-feed / canonical inning).
 */
export function locateHrInPlayerABs(abs: PlayerAbResult[] | null | undefined): HrLocation | null {
  if (!abs || abs.length === 0) return null;
  for (let i = 0; i < abs.length; i++) {
    if (abs[i]?.hitType === "home_run") {
      return {
        inning: abs[i].inning ?? null,
        half: abs[i].half ?? null,
        plateAppearanceNumber: i + 1,
        firstAb: i === 0,
      };
    }
  }
  return null;
}

export interface WinAttributionInput {
  /** Did the target hit a HR in the game? */
  hitHr: boolean;
  /** Was the target a publicly-flagged pre-game target (before first pitch)? */
  wasPubliclyFlagged: boolean;
  /** Ordered player ABs (preferred source for inning + PA number). */
  priorABResults?: PlayerAbResult[] | null;
  /** Play-feed HR inning fallback. */
  hrPlayInning?: number | null;
  hrPlayHalf?: "top" | "bottom" | null;
  /** Canonical live HR Radar hit inning fallback (half may be "T"/"B"). */
  canonicalHitInning?: number | null;
  canonicalHitHalf?: string | null;
}

export interface WinAttributionResult {
  outcome: "pregame_win" | "calibration_miss";
  userVisible: boolean;
  hrInning: number | null;
  hrHalf: "top" | "bottom" | null;
  plateAppearanceNumber: number | null;
  // true/false only when AB-sequencing data was actually present to decide
  // it either way; "unknown" when that data was unavailable — never silently
  // defaulted to false when the answer isn't actually known.
  firstAbPregameWin: true | false | "unknown";
}

/** Normalize canonical "T"/"B"/"top"/"bottom" → "top"|"bottom"|null. */
function normHalf(half: string | null | undefined): "top" | "bottom" | null {
  if (half == null) return null;
  const h = String(half).toLowerCase();
  if (h === "top" || h === "t") return "top";
  if (h === "bottom" || h === "b") return "bottom";
  return null;
}

/**
 * Derive the win-attribution outcome for a graded pre-game target.
 *
 * A miss is always a calibration moment (never userVisible). A hit is a
 * `pregame_win`; it is only userVisible when the target was publicly flagged.
 */
export function deriveWinAttribution(input: WinAttributionInput): WinAttributionResult {
  if (!input.hitHr) {
    return {
      outcome: "calibration_miss",
      userVisible: false,
      hrInning: null,
      hrHalf: null,
      plateAppearanceNumber: null,
      firstAbPregameWin: false,
    };
  }

  const located = locateHrInPlayerABs(input.priorABResults);
  const hrInning =
    located?.inning ?? input.hrPlayInning ?? input.canonicalHitInning ?? null;
  const hrHalf =
    located?.half ?? input.hrPlayHalf ?? normHalf(input.canonicalHitHalf) ?? null;
  const plateAppearanceNumber = located?.plateAppearanceNumber ?? null;
  // Only genuinely knowable when AB-sequencing data (priorABResults) was
  // present — the inning/half fallbacks above (play feed, canonical hit) tell
  // us *when* the HR happened, not whether it was PA #1, so they cannot
  // resolve this either way. Absent AB data must stay "unknown", not a
  // silent false.
  const firstAbPregameWin: true | false | "unknown" =
    located != null ? located.firstAb === true : "unknown";

  return {
    outcome: "pregame_win",
    userVisible: input.wasPubliclyFlagged === true,
    hrInning,
    hrHalf,
    plateAppearanceNumber,
    firstAbPregameWin,
  };
}

/** Park/weather boost label for a win card, when park context is known. */
function parkWeatherBoostLabel(signal: PregamePowerSignal): string | null {
  const pc = signal.parkContext;
  if (!pc) return null;
  if (pc.carryType === "boost") return pc.carryLabel;
  return null;
}

function pregameDriverDigest(drivers: PowerDriver[]): PregameRadarWinItem["pregameDrivers"] {
  return drivers
    .filter((d) => d.direction === "positive")
    .slice(0, 5)
    .map((d) => ({ key: d.key, label: d.label, direction: d.direction }));
}

/**
 * Canonical slate-date attribution for a win row. `signal.sessionDate` is
 * authoritative — it is stamped with slateDateET() (6am-ET rollover) at build
 * time and is the same value the DB unique index (sessionDate, gameId,
 * batterId) keys off, so it can never disagree with how the target was
 * actually grouped/deduped. `gameDate`/`startsAt` are read-only fallbacks for
 * the rare case sessionDate is missing (never happens in practice; the field
 * is required) — never the settlement/HR timestamp, which is the date source
 * that produced the original off-by-one bug.
 */
function resolveSlateDateET(signal: PregamePowerSignal): string {
  if (signal.sessionDate) return signal.sessionDate;
  if (signal.startsAt) return toEtDateKey(signal.startsAt);
  return signal.gameDate;
}

/**
 * Map a graded, won pre-game signal to a public daily-log row. `rank` is the
 * signal's 1-based pre-game rank (by score) among the day's flagged targets,
 * or null when unknown. Returns null when the signal is not a userVisible win.
 */
export function buildPregameRadarWinItem(
  signal: PregamePowerSignal,
  rank: number | null,
): PregameRadarWinItem | null {
  const o = signal.outcomes;
  if (!o || o.outcome !== "pregame_win" || o.userVisible !== true) return null;

  const firstAb = o.firstAbPregameWin === true;
  const slateDateET = resolveSlateDateET(signal);
  return {
    source: "pregame_power_radar",
    signalId: signal.signalId,
    sessionDate: signal.sessionDate,
    gameId: signal.gameId,
    playerId: signal.batterId,
    playerName: signal.batterName,
    team: signal.team,
    opponent: signal.opponent,
    primaryMarket: signal.primaryMarket,
    pregameTier: signal.tier,
    pregamePowerScore: signal.score10,
    pregameRank: rank,
    pregameDrivers: pregameDriverDigest(signal.drivers),
    opposingPitcher: signal.pitcherName ?? null,
    parkWeatherBoost: parkWeatherBoostLabel(signal),
    hrInning: o.hrInning ?? null,
    hrHalf: o.hrHalf ?? null,
    plateAppearanceNumber: o.plateAppearanceNumber ?? null,
    firstAbPregameWin: firstAb,
    becameLiveReady: signal.becameLiveReady === true,
    becameLiveFire: signal.becameLiveFire === true,
    resolvedAt: o.resolvedAt ?? null,
    slateDateET,
    displayDateLabel: formatPlainDateLabel(slateDateET),
    gameStartTimeET: signal.startsAt ? toEtTimeLabel(signal.startsAt) : null,
    detectedBeforeFirstPitch: true,
    homeredInGame: true,
    label: firstAb ? FIRST_AB_PREGAME_WIN_LABEL : PREGAME_WIN_LABEL,
    cardCopy: firstAb ? FIRST_AB_PREGAME_WIN_COPY : PREGAME_WIN_COPY,
  };
}

/**
 * Build the grouped pregame-win lists for the daily cashed log from a set of
 * graded signals. Wins are ranked by pre-game score (desc) across the supplied
 * signals so the public rank reflects the day's flagged board.
 */
export function buildDailyPregameWins(signals: PregamePowerSignal[]): {
  pregameRadarWins: PregameRadarWinItem[];
  firstAbPregameWins: PregameRadarWinItem[];
} {
  // Rank assignment uses the full flagged board (publicly-flagged targets),
  // not just winners, so a win's rank reflects where it sat pre-game — a
  // calibration miss or internal (unflagged) win scored between two public
  // wins must still occupy its board position.
  const flaggedBoard = signals
    .filter((s) => s.everPubliclyFlagged)
    .slice()
    .sort((a, b) => b.score10 - a.score10);

  const rankBySignalId = new Map<string, number>();
  flaggedBoard.forEach((s, i) => rankBySignalId.set(s.signalId, i + 1));

  const wins = signals
    .filter((s) => s.outcomes?.outcome === "pregame_win" && s.outcomes?.userVisible === true)
    .slice()
    .sort((a, b) => b.score10 - a.score10)
    .map((s) => buildPregameRadarWinItem(s, rankBySignalId.get(s.signalId) ?? null))
    .filter((w): w is PregameRadarWinItem => w != null);

  return {
    pregameRadarWins: wins,
    firstAbPregameWins: wins.filter((w) => w.firstAbPregameWin),
  };
}

/**
 * Server-stamped section title for the daily cashed log's Pregame Radar Wins
 * block. "Wins" means settled/homered; a slate that isn't today's must say so
 * rather than implying yesterday's settled wins belong to today's active
 * slate. Clients render `titleLabel` verbatim — never re-derive it.
 */
export function buildPregameWinsSectionMeta(
  queriedSlateDateET: string,
  todaySlateDateET: string,
): {
  latestSettledSlateDateET: string;
  todaySlateDateET: string;
  isToday: boolean;
  titleLabel: string;
} {
  const isToday = queriedSlateDateET === todaySlateDateET;
  const titleLabel = isToday
    ? "Pregame Radar Wins"
    : `${formatPlainDateLabel(queriedSlateDateET)} Pregame Radar Wins`;
  return {
    latestSettledSlateDateET: queriedSlateDateET,
    todaySlateDateET,
    isToday,
    titleLabel,
  };
}
