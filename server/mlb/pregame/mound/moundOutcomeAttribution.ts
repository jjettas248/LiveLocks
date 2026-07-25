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
  type MoundMarketUnavailableReason,
  type MoundSettlementLane,
  type MoundLineSnapshotType,
  MOUND_MARKET_INTEGRITY_REASONS,
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

export interface MoundSettlementDirectionInput {
  /** The direction currently stamped on the signal — may have been recomputed post-hoc by a later rebuild. */
  moundDirection: MoundDirection;
  /** Durable Follow-track public exposure (OR-sticky DB column). */
  everPubliclyFlagged: boolean;
  /** Durable Fade-track public exposure (OR-sticky DB column). */
  everPubliclyFlaggedFade: boolean;
}

/**
 * The direction a settled card must be graded and labelled under — the single
 * authority, used by BOTH the grader and the display view so the two can
 * never disagree.
 *
 * `moundDirection` alone is not trustworthy at settlement time. It is
 * recomputed from live inputs on every build cycle (computeMoundDirection),
 * and a rebuild that lands after first pitch sees degraded data — the
 * opposing lineup no longer reads "confirmed", stats age out — which drops
 * score10 below MOUND_PUBLISH_MIN_SCORE, drops the tier to "track", and flips
 * the recomputed direction to "fade". The in-memory carry-forward pin
 * (carryForwardMoundGradedState) guards that flip only while an unbroken
 * previous-build chain exists; a cold start, a snapshot that never hydrated,
 * or a game whose signals weren't retained loses the pin, and the flipped
 * "fade" then becomes permanent via the DB column's stickiness. The result is
 * a card that was publicly surfaced as a Follow read being settled under Fade
 * rules — inverting its outcome and its label.
 *
 * `everPubliclyFlagged` cannot flip that way. It is durable (SQL-level OR
 * upsert) and can only ever have been minted by wasPubliclyFlaggedMound,
 * which requires strong/elite/nuclear tier, score10 >= MOUND_PUBLISH_MIN_SCORE,
 * a confirmed opposing lineup, real coverage and real season stats — exactly
 * the conditions under which computeMoundDirection returns "follow", and
 * mutually exclusive with the "track"-tier condition under which it returns
 * "fade". So a true Follow flag PROVES the user was shown a Follow read, and
 * any later "fade" on that same signal is a post-hoc artifact, not something
 * anyone ever saw.
 *
 * NOTE: this resolves the MODEL read only (which season-baseline comparison
 * applies, and which model-performance wording is honest). It must never be
 * used to infer a sportsbook side — market side comes exclusively from the
 * frozen pregame recommendation (marketRecommendation.ts).
 */
export function resolveMoundSettlementDirection(input: MoundSettlementDirectionInput): MoundDirection {
  if (input.everPubliclyFlagged === true) return "follow";
  if (input.everPubliclyFlaggedFade === true) return "fade";
  return input.moundDirection;
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
  /** Null iff marketOutcome is a real result. Otherwise names the missing settlement component — see MoundMarketUnavailableReason. */
  marketUnavailableReason: MoundMarketUnavailableReason | null;
}

/**
 * Name the missing settlement component, in priority order, so an
 * "unavailable" is never an anonymous dead end. `sideResolved` says whether a
 * sportsbook side was ever recommended at all (null direction = no bet).
 */
function marketUnavailableReasonFor(
  input: MoundMarketOutcomeInput,
  sideResolved: boolean,
): MoundMarketUnavailableReason {
  // No frozen snapshot at all — the terms of whatever the user saw are gone.
  if (input.frozenLine == null) return "no_pregame_snapshot";
  if (input.frozenLine.line == null) {
    // Distinguish "this market has no odds feed anywhere" (pitcher_outs's
    // permanent state, stamped as "no_data_source" at freeze time) from "a
    // feed exists but no book had posted yet".
    return input.frozenLine.lineUnavailableReason === "no_data_source"
      ? "market_has_no_line_source"
      : "no_line_posted";
  }
  if (!sideResolved) return "no_edge";
  return "no_final_stat";
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
      marketUnavailableReason: marketUnavailableReasonFor(input, false),
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
      marketUnavailableReason: marketUnavailableReasonFor(input, true),
    };
  }

  const provenance = {
    lineSnapshotType: "final_pregame" as MoundLineSnapshotType,
    lineFrozenAt: input.lineFrozenAt,
    lineSource: input.frozenLine?.sportsbook ?? null,
    marketUnavailableReason: null,
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
  /**
   * Was this ever a genuine public recommendation, independent of which
   * grading path (model vs. market) decided the outcome? `outcomes.userVisible`
   * is NOT usable for this — deriveMoundOutcome always stamps it false
   * whenever the BASELINE comparison misses, even for a signal that was
   * genuinely publicly flagged and whose MARKET outcome cashed. Sourced
   * instead from the durable, grading-basis-independent
   * everPubliclyFlagged/everPubliclyFlaggedFade flags (mirrors the same
   * direction-based selection resolveMoundOutcome uses for wasPubliclyFlagged).
   */
  isPublicRecommendation: boolean;
  /**
   * Which lane decided this card's terminal result. The client renders from
   * this and never re-derives it — model-performance wording is permitted in
   * the "model_review" lane and nowhere else.
   */
  settlementLane: MoundSettlementLane;
  /**
   * The direction the model comparison was actually graded/labelled under —
   * durable public exposure resolved, not the possibly-recomputed
   * `moundDirection` column. Exposed so a card's wording can be traced back
   * to a decision rather than to an unstable field.
   */
  settlementDirection: MoundDirection;
  /** Why no market result exists. Null when marketOutcome is a real result. */
  marketUnavailableReason: MoundMarketUnavailableReason | null;
}

export function buildMoundSettlementView(
  outcomes: MoundOutcome | null | undefined,
  primaryMarket: "pitcher_strikeouts" | "pitcher_outs",
  moundDirection: MoundDirection,
  everPubliclyFlagged: boolean,
  everPubliclyFlaggedFade: boolean,
): MoundSettlementView {
  const finalStat = primaryMarket === "pitcher_strikeouts" ? outcomes?.finalStrikeouts ?? null : outcomes?.finalOutsRecorded ?? null;
  // Durable public exposure decides the model read, not the recomputable
  // column — see resolveMoundSettlementDirection. This is what stops a card
  // publicly surfaced as a Follow from being labelled with Fade wording after
  // a post-first-pitch rebuild flipped its stamped direction.
  const settlementDirection = resolveMoundSettlementDirection({
    moundDirection,
    everPubliclyFlagged,
    everPubliclyFlaggedFade,
  });
  const isPublicRecommendation = settlementDirection === "fade" ? everPubliclyFlaggedFade : everPubliclyFlagged;

  // Fallback for legacy/non-backfilled rows: outcomes.recommendedSide is only
  // stamped once a market outcome has actually been derived (prospectively,
  // or by the backfill script). A row with no resolvable frozen line never
  // gets it — but the resolved settlement direction is always available, so
  // the baseline-only fallback label is never misgendered (e.g. a legacy Fade
  // result must never read as "Follow Read Confirmed"). This fallback exists
  // ONLY to word the model-lane label; a market-lane side is never inferred
  // from direction — outcomes.recommendedSide comes from the frozen pregame
  // recommendation and is the only side a Cashed/Missed/Push can be graded on.
  const recommendedSide =
    outcomes?.recommendedSide ??
    (settlementDirection === "fade" ? "UNDER" : settlementDirection === "follow" ? "OVER" : null);

  const marketOutcome: MoundMarketOutcome = outcomes?.marketOutcome ?? "unavailable";
  // A row that never ran the market-settlement pass carries no reason. For
  // pitcher_outs that absence is still fully explained — no odds feed exists
  // for the market at all (postedLine.outs is stamped "no_data_source" at
  // every freeze), so no bet could ever have been offered on it and this is
  // not an integrity gap. For pitcher_strikeouts, where a real line source
  // does exist, an unstamped row IS the finding.
  const marketUnavailableReason: MoundMarketUnavailableReason | null =
    marketOutcome !== "unavailable"
      ? null
      : outcomes?.marketUnavailableReason ??
        (primaryMarket === "pitcher_outs" ? "market_has_no_line_source" : "not_stamped");

  return {
    modelOutcome: deriveModelOutcomeLabel(finalStat, outcomes?.seasonBaselineValue ?? null, settlementDirection),
    modelBaseline: outcomes?.seasonBaselineValue ?? null,
    marketOutcome,
    sportsbookLine: outcomes?.sportsbookLine ?? null,
    recommendedSide,
    finalStat,
    isPublicRecommendation,
    settlementLane: resolveMoundSettlementLane(marketOutcome, marketUnavailableReason, isPublicRecommendation),
    settlementDirection,
    marketUnavailableReason,
  };
}

/**
 * Terminal-state precedence. Strict order, no blending:
 *
 *   1. A real frozen sportsbook bet that settled → "market". Cashed/Missed/
 *      Push outrank every model-performance label, always.
 *   2. A public recommendation whose frozen bet can't be recovered →
 *      "integrity_gap". Never silently downgraded to model-performance
 *      wording, and never upgraded into a fabricated Cashed off the engine
 *      baseline.
 *   3. Everything else → "model_review". This covers both a card that was
 *      never public and a public MODEL READ on which no sportsbook bet was
 *      ever offered (no line source for the market, no book posted, or the
 *      projection sat inside the no-edge band). Model-performance wording is
 *      honest there because no bet was ever recommended to lose.
 */
export function resolveMoundSettlementLane(
  marketOutcome: MoundMarketOutcome,
  marketUnavailableReason: MoundMarketUnavailableReason | null,
  isPublicRecommendation: boolean,
): MoundSettlementLane {
  if (marketOutcome !== "unavailable") return "market";
  if (
    isPublicRecommendation &&
    marketUnavailableReason != null &&
    MOUND_MARKET_INTEGRITY_REASONS.includes(marketUnavailableReason)
  ) {
    return "integrity_gap";
  }
  return "model_review";
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
