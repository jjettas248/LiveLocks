// Mound Radar — diagnostics rollups + public visibility predicate.
// Mirrors pregamePowerRadar/diagnostics.ts's role, own thresholds.

import type { MoundSignal, MoundRadarResponse } from "./types";
import { MOUND_PUBLISH_MIN_SCORE } from "./scoring";

// contactRisk.ts's chips (cr_high/cr_low) are informational-only — like
// marketSetups, they must never affect suppression/publish gating, only
// what's displayed on the card. Excluded here (the sole gating use of this
// count) AND from buildMlbMoundRadar.ts's own positiveDriverCount, which
// independently computes the same count before it's stamped onto the signal.
export function positiveMoundDrivers(signal: MoundSignal) {
  return signal.drivers.filter((d) => d.direction === "positive" && !d.key.startsWith("cr_"));
}

/**
 * Intrinsic public-quality gate — "was this a publicly-surfaced Mound target,
 * flagged before first pitch?" Mirrors wasPubliclyFlaggedPregame's structure.
 */
export function wasPubliclyFlaggedMound(signal: MoundSignal): boolean {
  const tierEligible = signal.tier === "strong" || signal.tier === "elite" || signal.tier === "nuclear";

  return (
    signal.lineupStatus === "confirmed" &&
    tierEligible &&
    signal.score10 >= MOUND_PUBLISH_MIN_SCORE &&
    positiveMoundDrivers(signal).length >= 2 &&
    signal.diagnostics.dataCoverageScore >= 0.6 &&
    signal.diagnostics.rawInputsAvailable.pitcherSeasonStats === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true &&
    !signal.suppressed
  );
}

/**
 * Fade-track analog of wasPubliclyFlaggedMound — that predicate's tierEligible
 * check (strong/elite/nuclear only) structurally excludes "track" tier, so a
 * Fade Candidate signal can never satisfy it. "Was this shown as a Fade
 * Candidate before first pitch?" is exactly the same condition that gates the
 * "Fade Candidate" badge everywhere else (moundDirection === "fade").
 *
 * Deliberately does NOT check `!signal.suppressed` (Codex review, PR #105) —
 * composeMoundScore suppresses every score below MOUND_PUBLISH_MIN_SCORE
 * (5.5), and "track" tier is defined as score10 < 4.0, so EVERY fade-
 * direction signal is unconditionally suppressed under that Follow-oriented
 * quality bar. Reusing it here would make this predicate permanently
 * unsatisfiable — suppressed isn't a data-quality problem for Fade, it's a
 * category error: the low score IS the fade signal, not something to gate
 * against. computeMoundDirection's own fade branch (track tier + a real,
 * non-null pitcherSkillScore) is already the correct quality bar — it rules
 * out a data-missing artifact masquerading as a genuine weak matchup, which
 * is exactly what wasPubliclyFlaggedMound's driver-count/coverage checks
 * exist to do for Follow. No confirmed-lineup requirement either:
 * computeMoundDirection's fade branch doesn't require one (a weak-pitcher
 * classification is driven by pitcherSkill/workload, not the day's specific
 * opposing lineup), and requiring it here would over-gate relative to what
 * the UI already shows as "Fade Candidate."
 *
 * firstPitchLockEligible === true (gameStatus scheduled/pre) IS still
 * required — this predicate is called with no `prev` signal for a game's
 * first-ever build (server restart, a delayed build, or an earlier
 * unresolved gamePk), and without this guard a build that first evaluates a
 * pitcher AFTER the game already went live/final would flag him as a Fade
 * candidate using hindsight (final box score) data, even though nothing was
 * ever shown to a user before first pitch. Once legitimately set true
 * pre-game, the flag still survives into live/final builds via
 * carryForwardMoundGradedState's OR — this guard only blocks a flag being
 * MINTED post-first-pitch with no prior true value to inherit.
 */
export function wasPubliclyFlaggedMoundFade(signal: MoundSignal): boolean {
  return (
    signal.moundDirection === "fade" &&
    signal.firstPitchLockEligible === true &&
    signal.isOfficialPlay === false &&
    signal.isPregameTarget === true
  );
}

/**
 * Frozen historical public-admission flag — Follow only. Reads the durable
 * `everPubliclyFlagged` value (set once pre-first-pitch, OR-forwarded across
 * rebuilds and DB-hydrated), NEVER a live re-evaluation.
 *
 * Deliberately does NOT OR in `everPubliclyFlaggedFade`: `isPublicMoundSignal`
 * has never admitted Fade publicly (its eligibility branch uses only the Follow
 * predicate), so `everPubliclyFlaggedFade` represents Fade *eligibility*, not
 * actual public delivery. Using it here would retroactively surface a card the
 * product never publicly showed — a candidate-volume change. Fade flags/outcomes
 * are still preserved internally across rebuild/restart (moundGradedStateCarry),
 * but Fade stays publicly absent. Public Fade activation is a separate
 * engine/product decision requiring its own before/after candidate-volume audit.
 */
export function flaggedBeforeFirstPitchMound(signal: MoundSignal): boolean {
  return signal.everPubliclyFlagged === true;
}

/**
 * Final public-visibility predicate — same shared lifecycle principle as
 * isPublicPregameSignal (no per-outcome exceptions):
 *   1. INITIAL eligibility (pre-first-pitch): `wasPubliclyFlaggedMound` (Follow),
 *      unchanged — no candidate-volume change, Fade stays publicly absent.
 *   2. RETAINED visibility (first pitch passed): the durable frozen Follow flag
 *      + a locked/graded status — Follow win OR miss, graded or not. Cold-start
 *      minting is blocked in moundGradedStateCarry (firstPitchLockEligible), so
 *      retention never surfaces a signal never shown before first pitch.
 * `status === "graded"` implies first pitch has passed, routing to retention.
 */
export function isPublicMoundSignal(signal: MoundSignal): boolean {
  if (signal.gameStatus === "postponed") return false;
  if (signal.status === "expired") return false;

  const firstPitchPassed =
    signal.status === "graded" || signal.gameStatus === "live" || signal.gameStatus === "final";

  if (!firstPitchPassed) return wasPubliclyFlaggedMound(signal);

  return flaggedBeforeFirstPitchMound(signal) && (signal.status === "locked" || signal.status === "graded");
}

export interface MoundCoverageCounters {
  gamesScanned: number;
  pitchersEvaluated: number;
  starterCoverage: number;
  weatherCoverage: number;
  pitcherCoverage: number;
  lineupCoverage: number;
}

export function buildMoundResponse(
  date: string,
  buildId: string,
  generatedAt: string,
  source: MoundRadarResponse["source"],
  signals: MoundSignal[],
  counters: MoundCoverageCounters,
  includeSuppressed: boolean,
): MoundRadarResponse {
  const publicSignals = signals.filter(isPublicMoundSignal);
  const suppressedSignals = signals.filter((s) => !isPublicMoundSignal(s));

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
      starterCoverage: counters.starterCoverage,
      weatherCoverage: counters.weatherCoverage,
      pitcherCoverage: counters.pitcherCoverage,
      lineupCoverage: counters.lineupCoverage,
      totalPitchersEvaluated: counters.pitchersEvaluated,
      publicSignals: publicSignals.length,
      suppressedSignals: suppressedSignals.length,
      topSuppressionReasons,
    },
  };
}
