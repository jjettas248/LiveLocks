// Pre-Game Power Radar — diagnostics rollups + public visibility predicate.

import type { PregamePowerSignal, PregamePowerRadarResponse } from "./types";

/** Derived helper: positive drivers on a signal. */
export function positiveDrivers(signal: PregamePowerSignal) {
  return signal.drivers.filter((d) => d.direction === "positive");
}

/** Derived helper: whether the batter power profile was available. */
export function batterPowerAvailable(signal: PregamePowerSignal): boolean {
  return signal.diagnostics.rawInputsAvailable.batterPower === true;
}

/**
 * Intrinsic public-quality gates, independent of live/final game status.
 *
 * Answers "was this a publicly-surfaced pre-game target, flagged before first
 * pitch?" — the question Win Attribution must ask at grading time, when the
 * game is already `final` (so the live-status gates in `isPublicPregameSignal`
 * no longer apply). A pregame win is only `userVisible` when this is true.
 */
export function wasPubliclyFlaggedPregame(signal: PregamePowerSignal): boolean {
  // Tier gate: surface only strong+ setups and `power_watch` (Batter Power Only)
  // candidates — never bare `watch`/`track`.
  const tierEligible =
    signal.tier === "power_watch" ||
    signal.tier === "strong" ||
    signal.tier === "elite" ||
    signal.tier === "nuclear";

  return (
    signal.lineupStatus === "posted" &&
    tierEligible &&
    signal.score10 >= 6.0 &&
    positiveDrivers(signal).length >= 2 &&
    signal.diagnostics.dataCoverageScore >= 0.6 &&
    signal.diagnostics.rawInputsAvailable.batterPower === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true &&
    !signal.suppressed
  );
}

/**
 * Final public-visibility predicate. Public surfaces only confirmed-lineup,
 * non-suppressed, strong+ targets. Live and final games show only locked rows.
 *
 * A graded target that actually homered stays visible after grading (display
 * only — never re-derived) so the card can render its cashed/"HOMERED" state.
 * A `final` game whose shadow grader hasn't run yet is treated the same as a
 * `live` one — still visible as a pending/locked row — instead of vanishing
 * the instant the game goes final only to (maybe) reappear once the 5-minute
 * grading pass catches up (or never, if the box score cache never resolves
 * for that game). A graded miss still hides once `status` flips to `"graded"`
 * without `hitHr`, via the active/locked check above.
 *
 * For an already-`graded` signal, eligibility also accepts the frozen
 * `everPubliclyFlagged` flag (OR'd) — a target that was ever legitimately
 * flagged pregame must never silently drop out of the list because a later
 * rebuild's freshly-refetched mutable fields (tier/score/dataCoverageScore/
 * etc.) dipped below threshold. This OR is scoped to `graded` signals only:
 * `wasPubliclyFlaggedPregame` also gates `!suppressed`, and suppression is a
 * live, legitimately-changing fact (e.g. a lineup scratch) for a still-active
 * pre-lock signal — a target that gets scratched must always disappear from
 * the live board, never held visible by an earlier frozen flag.
 *
 * A `suspended` (non-graded) signal is the one case where a *live* pass on
 * `wasPubliclyFlaggedPregame` must NOT be trusted on its own: that check has
 * no awareness of `gameStatus`, so a signal built for the first time while
 * its game is already suspended (a cold restart with no prior copy to carry
 * a frozen flag from) could otherwise pass its intrinsic gates and surface
 * as a brand-new recommendation for a game that's already past first pitch —
 * exactly the "new actionable recommendation while paused" case suspended
 * handling must block. Suspended therefore requires the frozen
 * `everPubliclyFlagged` flag specifically (not an OR with the live pass): an
 * already-flagged target stays visible (the flag survived via
 * carryForwardGradedState's OR-forward), but a live-only pass can never
 * mint visibility on its own while paused.
 */
export function isPublicPregameSignal(signal: PregamePowerSignal): boolean {
  const flaggedNow = wasPubliclyFlaggedPregame(signal);
  const flagged =
    signal.status === "graded" ? flaggedNow || signal.everPubliclyFlagged
    : signal.gameStatus === "suspended" ? signal.everPubliclyFlagged
    : flaggedNow;
  if (!flagged) return false;
  if (signal.status === "graded" && signal.outcomes?.hitHr === true) return true;
  if (signal.status !== "active" && signal.status !== "locked") return false;
  if (signal.gameStatus === "postponed") return false;
  // Suspended shares the same underlying property as live/final — first pitch
  // has already happened — so it belongs in this branch rather than falling
  // through to the generic pre-lock `return true` below. A suspended signal
  // is preserved and visible (not hidden like postponed) as long as it's
  // correctly locked; see buildPregamePowerRadar.ts's isLocked computation.
  if (signal.gameStatus === "live" || signal.gameStatus === "final" || signal.gameStatus === "suspended") {
    return signal.status === "locked";
  }
  return true;
}

export interface CoverageCounters {
  gamesScanned: number;
  battersEvaluated: number;
  lineupCoverage: number;
  weatherCoverage: number;
  batterCoverage: number;
  pitcherCoverage: number;
}

export function buildResponse(
  date: string,
  buildId: string,
  generatedAt: string,
  source: PregamePowerRadarResponse["source"],
  signals: PregamePowerSignal[],
  counters: CoverageCounters,
  includeSuppressed: boolean,
): PregamePowerRadarResponse {
  const publicSignals = signals.filter(isPublicPregameSignal);
  const suppressedSignals = signals.filter((s) => !isPublicPregameSignal(s));

  const reasonCounts = new Map<string, number>();
  for (const s of suppressedSignals) {
    for (const r of s.suppressedReasons) {
      reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    }
  }
  const topSuppressionReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const out = includeSuppressed ? signals : publicSignals;

  return {
    date,
    buildId,
    generatedAt,
    source,
    gamesScanned: counters.gamesScanned,
    signals: out.slice().sort((a, b) => b.score10 - a.score10),
    diagnostics: {
      lineupCoverage: counters.lineupCoverage,
      weatherCoverage: counters.weatherCoverage,
      batterCoverage: counters.batterCoverage,
      pitcherCoverage: counters.pitcherCoverage,
      totalBattersEvaluated: counters.battersEvaluated,
      publicSignals: publicSignals.length,
      suppressedSignals: suppressedSignals.length,
      topSuppressionReasons,
    },
  };
}
