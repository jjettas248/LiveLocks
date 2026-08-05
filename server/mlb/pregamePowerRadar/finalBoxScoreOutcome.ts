// Pre-Game Power Radar — restart-proof grading fallback (pure, no I/O).
//
// The 5-minute grader (shadowOutcomes.ts) normally reads the in-memory
// `mlbGameCache.gameBoxScore`, which is populated ONLY by the live orchestrator
// polling the game and is wiped on every redeploy. Whenever that cache has no
// line for the batter at grading time — a game the live path never synced, or
// a cold cache after a restart — a real HR would otherwise sit unmarked for the
// rest of the day. This module resolves the outcome from a FINAL box score the
// grader fetches on demand (the same restart-proof source the official
// persisted-plays grader uses), reusing the exact win attribution + total-bases
// classification the in-memory path uses so a fallback-graded HR is
// indistinguishable from a live-graded one.
//
// Pure: no storage, no cache, no network — the caller supplies the already-
// fetched player stats. Unit-tested in finalBoxScoreOutcome.test.ts.

import { deriveWinAttribution } from "./winAttribution";
import { classifyTotalBasesOutcome } from "./totalBasesOutcome";
import { buildMlbPlayerStats, getMlbStatValue } from "../../services/gradePersistedPlays";
import type { PregameOutcome, PregamePowerSignal } from "./types";

/**
 * Build a graded outcome for `signal` from a FINAL box score's player-stats map
 * (as produced by `buildMlbPlayerStats`). Returns null when the batter is
 * absent from the box score — never a fabricated grade. Inning / plate-
 * appearance detail degrades to the optional `canonicalHit` fallback since a
 * fetched box score carries no play feed. Because the box score is
 * authoritatively final, both a hit and a miss settle from it.
 */
export function resolveOutcomeFromFinalBoxScore(
  signal: PregamePowerSignal,
  playerStats: ReturnType<typeof buildMlbPlayerStats>,
  canonicalHit?: { hitInning: number | null; hitHalf: string | null } | null,
): PregameOutcome | null {
  const entry = playerStats.get(String(signal.batterId));
  if (!entry) return null;

  const hr = getMlbStatValue(entry, "home_runs") ?? 0;
  const totalBases = getMlbStatValue(entry, "total_bases");
  const hits = getMlbStatValue(entry, "hits") ?? 0;
  const rbi = getMlbStatValue(entry, "rbi");
  const hitHr = hr > 0;

  const attribution = deriveWinAttribution({
    hitHr,
    wasPubliclyFlagged: signal.everPubliclyFlagged,
    priorABResults: null,
    hrPlayInning: null,
    hrPlayHalf: null,
    canonicalHitInning: canonicalHit?.hitInning ?? null,
    canonicalHitHalf: canonicalHit?.hitHalf ?? null,
  });

  return {
    hitHr,
    totalBases: totalBases ?? null,
    hitRecorded: hits > 0,
    rbiRecorded: rbi ?? null,
    resolvedAt: new Date().toISOString(),
    outcome: attribution.outcome,
    userVisible: attribution.userVisible,
    hrInning: attribution.hrInning,
    hrHalf: attribution.hrHalf,
    plateAppearanceNumber: attribution.plateAppearanceNumber,
    firstAbPregameWin: attribution.firstAbPregameWin,
    // totalBases from the MLB Stats box score is exact (unlike the Tank01
    // approximation), so it classifies directly.
    tbOutcome: classifyTotalBasesOutcome(totalBases ?? null, true),
  };
}
