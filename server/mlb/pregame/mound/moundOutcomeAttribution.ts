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

import type { MoundDriver, MoundSignal, MoundOutcome } from "./types";
import type { MoundDirection } from "./moundDirection";
import {
  type MoundRadarWinItem,
  type MoundOutcomeType,
  type MoundMarketOutcome,
  type MoundLineSnapshotType,
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

/** A frozen pregame line reading for one market, as captured in MoundEvaluationSnapshot.champion.postedLine. */
export interface FrozenLineInput {
  line: number | null;
  lineUnavailableReason: string | null;
  sportsbook?: string | null;
}

export interface MoundMarketOutcomeInput {
  moundDirection: MoundDirection;
  /** The frozen postedLine reading for this signal's primaryMarket (strikeouts or outs) — never refetched, never a live line. */
  frozenLine: FrozenLineInput | null;
  /** When the frozen snapshot itself was taken (finalPregameSnapshot.frozenAt) — always strictly pregame. */
  lineFrozenAt: string | null;
  /** Final actual stat for the signal's primaryMarket (finalStrikeouts or finalOutsRecorded). */
  actual: number | null;
}

export interface MoundMarketOutcomeResult {
  marketOutcome: MoundMarketOutcome;
  sportsbookLine: number | null;
  recommendedSide: "OVER" | "UNDER" | null;
  lineSnapshotType: MoundLineSnapshotType | null;
  lineFrozenAt: string | null;
  lineSource: string | null;
}

/**
 * Market settlement — SIBLING to deriveMoundOutcome above, never a
 * replacement for it. Grades the recommended side against a real sportsbook
 * line frozen strictly pregame (finalPregameSnapshot) — never a later line,
 * never the live/current line, never a projection or the season baseline
 * standing in for a market line. "unavailable" whenever no such line was
 * ever captured — this is the ONLY function allowed to produce
 * "cashed"/"missed"/"push" for public display; deriveMoundOutcome's
 * mound_win/mound_fade_win/mound_calibration_miss stays internal-only.
 */
export function deriveMoundMarketOutcome(input: MoundMarketOutcomeInput): MoundMarketOutcomeResult {
  // Stricter than deriveMoundOutcome's Follow-default: an unresolved
  // direction never gets a guessed side for this public-facing contract —
  // mirrors MoundGradingMeasurements.championVsFrozenBaseline.directionResult's
  // "null direction always yields unavailable" convention.
  if (input.moundDirection == null) {
    return {
      marketOutcome: "unavailable",
      sportsbookLine: input.frozenLine?.line ?? null,
      recommendedSide: null,
      lineSnapshotType: null,
      lineFrozenAt: null,
      lineSource: null,
    };
  }

  const recommendedSide: "OVER" | "UNDER" = input.moundDirection === "fade" ? "UNDER" : "OVER";
  const line = input.frozenLine?.line ?? null;

  if (line == null || input.actual == null) {
    return {
      marketOutcome: "unavailable",
      sportsbookLine: line,
      recommendedSide,
      lineSnapshotType: null,
      lineFrozenAt: null,
      lineSource: null,
    };
  }

  const provenance = {
    lineSnapshotType: "final_pregame" as MoundLineSnapshotType,
    lineFrozenAt: input.lineFrozenAt,
    lineSource: input.frozenLine?.sportsbook ?? null,
  };

  if (input.actual === line) {
    return { marketOutcome: "push", sportsbookLine: line, recommendedSide, ...provenance };
  }

  const wentOver = input.actual > line;
  const cashed = recommendedSide === "OVER" ? wentOver : !wentOver;
  return { marketOutcome: cashed ? "cashed" : "missed", sportsbookLine: line, recommendedSide, ...provenance };
}

/**
 * Additive, display-only relabeling of the existing season-baseline
 * classification — never mutates deriveMoundOutcome/outcome/userVisible.
 * Exposes the exact-tie case (folded into "win" internally via `>=`) as a
 * distinct "push" for the new user-facing contract. The label layer (client)
 * must render this tie case as "Matched Engine Baseline" — never the word
 * "Push", which is reserved exclusively for a real market-line push.
 */
export function deriveModelOutcomeLabel(
  actual: number | null,
  seasonBaselineValue: number | null,
  moundDirection: MoundDirection,
): "confirmed" | "not_confirmed" | "push" | null {
  if (actual == null || seasonBaselineValue == null || moundDirection == null) return null;
  if (actual === seasonBaselineValue) return "push";
  const wentOver = actual > seasonBaselineValue;
  const confirmed = moundDirection === "fade" ? !wentOver : wentOver;
  return confirmed ? "confirmed" : "not_confirmed";
}

/**
 * Public settlement-view contract — the only shape the client should ever
 * read for card display. Computed fresh at API-response time from the
 * persisted `outcomes` object; never stored redundantly.
 */
export interface MoundSettlementView {
  modelOutcome: "confirmed" | "not_confirmed" | "push" | null;
  modelBaseline: number | null;
  marketOutcome: MoundMarketOutcome;
  sportsbookLine: number | null;
  recommendedSide: "OVER" | "UNDER" | null;
  finalStat: number | null;
}

export function buildMoundSettlementView(
  outcomes: MoundOutcome | null | undefined,
  primaryMarket: "pitcher_strikeouts" | "pitcher_outs",
  moundDirection: MoundDirection,
): MoundSettlementView {
  const finalStat = primaryMarket === "pitcher_strikeouts" ? outcomes?.finalStrikeouts ?? null : outcomes?.finalOutsRecorded ?? null;
  return {
    modelOutcome: deriveModelOutcomeLabel(finalStat, outcomes?.seasonBaselineValue ?? null, moundDirection),
    modelBaseline: outcomes?.seasonBaselineValue ?? null,
    marketOutcome: outcomes?.marketOutcome ?? "unavailable",
    sportsbookLine: outcomes?.sportsbookLine ?? null,
    recommendedSide: outcomes?.recommendedSide ?? null,
    finalStat,
  };
}

/**
 * Has this pitcher been pulled from the game? True when their ID appears in
 * the team's live appearance order (boxscore.teams[side].pitchers, index 0
 * = starter — see dataPullService.ts's getPitcherAppearanceOrder) but is
 * NOT the last entry, meaning a later pitcher has since taken the mound.
 * Once true, this pitcher's own strikeouts/outs-recorded for the game are
 * permanently locked — they cannot pitch again this game (bar an all but
 * unheard-of re-entry) — so their line is just as settled as if the whole
 * game had gone final, often hours sooner. A missing/empty order (box score
 * not synced yet, or this pitcher hasn't recorded a line at all) is treated
 * as "not pulled" — never fabricates certainty from absent data.
 */
export function hasPitcherBeenPulled(
  pitcherId: string,
  appearanceOrder: string[] | null | undefined,
): boolean {
  if (!appearanceOrder || appearanceOrder.length === 0) return false;
  const idx = appearanceOrder.indexOf(String(pitcherId));
  if (idx === -1) return false;
  return idx < appearanceOrder.length - 1;
}

/**
 * Settlement-timing gate: is this outcome safe to commit right now?
 *
 * `outingComplete` is true once this pitcher's OWN outing is certain to be
 * over — either the whole game has reached final, or (typically much
 * sooner) they've been pulled (see hasPitcherBeenPulled above). Once true,
 * every outcome type is safe to grade: their final Ks/outs for the start
 * are locked and cannot change regardless of how much longer the game runs.
 *
 * Before that, a Follow/Over `mound_win` is STILL monotonic-safe to grade
 * live — strikeouts/outs-recorded only climb while a pitcher is actively in
 * the game, so a win seen mid-outing can never un-happen. `mound_fade_win`
 * and every `mound_calibration_miss` need `outingComplete`: an under-baseline
 * count can still climb while the pitcher remains in, and a miss can't be
 * declared while they might still take the mound again. Mirrors
 * pregamePowerRadar/shadowOutcomes.ts's win-grades-live / miss-waits split
 * for Plate HR targets, generalized from "game final" to "outing complete."
 */
export function isMoundOutcomeGradeableNow(
  outingComplete: boolean,
  outcome: MoundOutcomeType | undefined,
): boolean {
  return outingComplete || outcome === "mound_win";
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
