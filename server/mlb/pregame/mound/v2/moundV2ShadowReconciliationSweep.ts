// Mound Radar V2 (shadow) — bounded reconciliation sweep + grading coverage
// report (Correction 3). Storage- and network-touching; imports the pure
// eligibility/backoff/report logic from the sibling
// moundV2ShadowReconciliation.ts (same pure/impure split as
// moundV2ShadowGrading.ts / moundV2ShadowGradingSweep.ts).
//
// This is a DELIBERATELY SEPARATE tick from runMoundV2ShadowGradingSweep()
// (Part 5) — that sweep stays purely passive (cache reads only, zero
// provider calls, runs every 5 min) by design; this module is the bounded
// backstop for the tail case where the passive sweep's cache never gets
// populated for a given game at all (see moundV2ShadowReconciliation.ts's
// header for why that happens). Only THIS module ever calls
// syncGameBoxScore from anywhere in the V2 shadow package — grep-verified
// (moundV2ShadowReconciliationWiring.test.ts).
//
// Never awaited by, and never reachable from, buildMlbMoundRadar.ts's
// per-pitcher build loop — this runs on its own independent periodic tick
// (wired in server/index.ts), exactly like the routine grading sweep.
// Zero sportsbook/odds calls: syncGameBoxScore hits only the MLB Stats API
// live-feed endpoint (see dataPullService.ts) — the same official-stat
// provider V1's own grading passively waits on, never the odds provider.

import { mlbGameCache, syncGameBoxScore } from "../../../dataPullService";
import { storage } from "../../../../storage";
import { computeMoundV2GradingDecision, classifyMoundV2GameStatusForGrading } from "./moundV2ShadowGrading";
import { lookupOfficialStats } from "./moundV2ShadowGradingSweep";
import {
  isReconciliationEligible,
  buildMoundV2GradingCoverageReport,
  MOUND_V2_RECONCILIATION_POLICY,
  type MoundV2ReconciliationRow,
  type MoundV2GradingCoverageReport,
} from "./moundV2ShadowReconciliation";
import type { MoundV2ShadowPredictionRow } from "@shared/schema";

export interface MoundV2ShadowReconciliationSweepSummary {
  candidatesConsidered: number;
  eligible: number;
  skippedIneligible: number;
  skippedNoGamePk: number;
  gamesConsidered: number;
  gamesReconciledThisTick: number;
  gamesTruncatedThisTick: number;
  graded: number;
  voided: number;
  stillPending: number;
  providerFailures: number;
  errors: number;
}

function toReconciliationRow(row: MoundV2ShadowPredictionRow): MoundV2ReconciliationRow {
  return {
    predictionId: row.predictionId,
    gameId: row.gameId,
    pitcherId: row.pitcherId,
    settlementStatus: row.settlementStatus,
    scheduledGameTime: row.scheduledGameTime,
    evaluationTimestamp: row.evaluationTimestamp,
    reconciliationAttemptCount: row.reconciliationAttemptCount,
    lastReconciliationAttemptAt: row.lastReconciliationAttemptAt,
    lastReconciliationFailureReason: row.lastReconciliationFailureReason,
    lastKnownStatus: classifyMoundV2GameStatusForGrading(mlbGameCache.gamePitchingBoxScore[row.gameId]?.gameStatus),
  };
}

// Single-flight for the WHOLE sweep, not just per-game — a slow tick (many
// eligible games, one real network call per game) must never overlap with
// the next timer firing or an admin-triggered manual run. A concurrent
// caller gets the SAME in-flight promise rather than launching a second
// overlapping pass.
let sweepInFlight: Promise<MoundV2ShadowReconciliationSweepSummary> | null = null;

export interface MoundV2ShadowReconciliationDeps {
  /** Real MLB Stats API box-score fetch. Injectable so behavior (never-throws, per-game dedup, write-skip-on-failure) can be proven without a network call. */
  fetchBoxScore?: (gamePk: string, gameId: string) => Promise<void>;
}

/**
 * Bounded backstop for pending V2 shadow predictions the routine passive
 * sweep can never resolve because mlbGameCache.gamePitchingBoxScore was
 * never (or is no longer) populated for that game. Never throws. Always
 * returns a real summary, even on a total listing failure.
 */
export async function runMoundV2ShadowReconciliationSweep(
  deps: MoundV2ShadowReconciliationDeps = {},
): Promise<MoundV2ShadowReconciliationSweepSummary> {
  if (sweepInFlight) return sweepInFlight;
  const run = runMoundV2ShadowReconciliationSweepInner(deps);
  sweepInFlight = run;
  try {
    return await run;
  } finally {
    sweepInFlight = null;
  }
}

async function runMoundV2ShadowReconciliationSweepInner(
  deps: MoundV2ShadowReconciliationDeps,
): Promise<MoundV2ShadowReconciliationSweepSummary> {
  const fetchBoxScore = deps.fetchBoxScore ?? ((gamePk: string, gameId: string) => syncGameBoxScore(gamePk, gameId));
  const now = new Date();
  const summary: MoundV2ShadowReconciliationSweepSummary = {
    candidatesConsidered: 0, eligible: 0, skippedIneligible: 0, skippedNoGamePk: 0,
    gamesConsidered: 0, gamesReconciledThisTick: 0, gamesTruncatedThisTick: 0,
    graded: 0, voided: 0, stillPending: 0, providerFailures: 0, errors: 0,
  };

  let pending: MoundV2ShadowPredictionRow[];
  try {
    // Bounded — mirrors the routine sweep's own limit. A pathological
    // backlog beyond this is itself surfaced by the coverage report's
    // staleAlertCount, not silently grown into an unbounded scan here.
    pending = await storage.listMoundV2ShadowPredictions({ settlementStatus: "pending", limit: 2000 });
  } catch (err: unknown) {
    console.warn(
      "[MOUND_V2_RECONCILE] failed to list pending predictions:",
      err instanceof Error ? err.message : err,
    );
    return summary;
  }
  summary.candidatesConsidered = pending.length;

  const eligibleRows: MoundV2ShadowPredictionRow[] = [];
  for (const row of pending) {
    const verdict = isReconciliationEligible(toReconciliationRow(row), now);
    if (!verdict.eligible) {
      summary.skippedIneligible++;
      continue;
    }
    if (!row.gamePk) {
      summary.skippedNoGamePk++;
      // Bump bookkeeping (with a real, honest reason) so a structurally
      // unreconcilable row still ages out via the normal attempt-count
      // backoff/cap instead of being re-examined at zero cost forever.
      try {
        await storage.recordMoundV2ShadowReconciliationAttempt(row.predictionId, {
          attemptedAt: now, failureReason: "gamePk_unresolved_at_capture",
        });
      } catch (err: unknown) {
        console.warn(`[MOUND_V2_RECONCILE] failed to record no-gamePk attempt for ${row.predictionId}:`, err instanceof Error ? err.message : err);
      }
      continue;
    }
    summary.eligible++;
    eligibleRows.push(row);
  }

  const byGame = new Map<string, MoundV2ShadowPredictionRow[]>();
  for (const row of eligibleRows) {
    const list = byGame.get(row.gameId) ?? [];
    list.push(row);
    byGame.set(row.gameId, list);
  }
  summary.gamesConsidered = byGame.size;

  const gameIds = Array.from(byGame.keys());
  const gameIdsThisTick = gameIds.slice(0, MOUND_V2_RECONCILIATION_POLICY.MAX_GAMES_PER_SWEEP);
  summary.gamesReconciledThisTick = gameIdsThisTick.length;
  summary.gamesTruncatedThisTick = gameIds.length - gameIdsThisTick.length;
  if (summary.gamesTruncatedThisTick > 0) {
    console.warn(
      `[MOUND_V2_RECONCILE] rate-limited: ${gameIds.length} distinct games eligible, only reconciling ${gameIdsThisTick.length} this tick (remaining ${summary.gamesTruncatedThisTick} carry to the next tick)`,
    );
  }

  for (const gameId of gameIdsThisTick) {
    const rowsForGame = byGame.get(gameId)!;
    const gamePk = rowsForGame[0].gamePk!;

    let fetchError: string | null = null;
    try {
      await fetchBoxScore(gamePk, gameId);
    } catch (err: unknown) {
      fetchError = err instanceof Error ? err.message : String(err);
      console.warn(`[MOUND_V2_RECONCILE] box-score fetch failed for game=${gameId} gamePk=${gamePk}:`, fetchError);
    }

    for (const row of rowsForGame) {
      const attemptedAt = new Date();
      try {
        if (fetchError) {
          await storage.recordMoundV2ShadowReconciliationAttempt(row.predictionId, { attemptedAt, failureReason: fetchError });
          summary.providerFailures++;
          continue;
        }

        const frozenLine = row.frozenLine != null ? Number(row.frozenLine) : null;
        const decision = computeMoundV2GradingDecision({
          market: row.market,
          pitcherId: row.pitcherId,
          frozenLine,
          officialStats: lookupOfficialStats(row),
        });

        if (decision.kind === "hold") {
          await storage.recordMoundV2ShadowReconciliationAttempt(row.predictionId, { attemptedAt, failureReason: null });
          summary.stillPending++;
        } else if (decision.kind === "void") {
          await storage.gradeMoundV2ShadowPrediction(row.predictionId, {
            settlementStatus: "void", finalResult: null, finalStatValue: null, voidReason: decision.reason, gradedAt: attemptedAt,
          });
          summary.voided++;
          console.log(`[MOUND_V2_RECONCILE_RESOLVED] ${row.predictionId} game=${gameId} -> void (${decision.reason})`);
        } else {
          await storage.gradeMoundV2ShadowPrediction(row.predictionId, {
            settlementStatus: "graded", finalResult: decision.finalResult, finalStatValue: decision.finalStatValue, gradedAt: attemptedAt,
          });
          summary.graded++;
          console.log(`[MOUND_V2_RECONCILE_RESOLVED] ${row.predictionId} game=${gameId} -> graded (${decision.finalResult})`);
        }
      } catch (err: unknown) {
        summary.errors++;
        console.warn(`[MOUND_V2_RECONCILE] failed to process ${row.predictionId}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  return summary;
}

/**
 * Read-only coverage report for admin diagnostics (Correction 3's required
 * "pending completed games, oldest pending prediction, grading coverage,
 * provider failures, unresolved pitcher identities, suspended/postponed
 * counts"). Lists rows and defers all the actual arithmetic to the pure
 * buildMoundV2GradingCoverageReport.
 */
export async function gatherMoundV2ShadowGradingCoverageReport(opts: {
  fromEvaluationTimestamp?: Date;
  toEvaluationTimestamp?: Date;
} = {}): Promise<MoundV2GradingCoverageReport> {
  const rows = await storage.listMoundV2ShadowPredictions({
    fromEvaluationTimestamp: opts.fromEvaluationTimestamp,
    toEvaluationTimestamp: opts.toEvaluationTimestamp,
    limit: 5000,
  });
  const now = new Date();
  return buildMoundV2GradingCoverageReport(rows.map(toReconciliationRow), now);
}
