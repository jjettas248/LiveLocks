// Mound Radar — market-outcome historical backfill planner (pure, no I/O).
// Mirrors pregamePowerRadar/slateDateRepair.ts's pure-planner-plus-separate-
// runner-script convention (see server/scripts/repairMoundMarketOutcomeBackfill.ts
// for the actual DB read/write).
//
// Prospective-only rule (locked product decision): market settlement is only
// ever computed going forward, by moundShadowOutcomes.ts, at grading time. A
// row graded BEFORE this feature shipped never had marketOutcome/sportsbookLine/
// recommendedSide/provenance stamped. This planner backfills those fields for
// already-graded historical rows, but ONLY where the original frozen pregame
// line the market outcome would be graded against is provably already
// persisted (finalPregameSnapshot.champion.postedLine, captured strictly
// pregame at the time — never a line fetched now, never a guess). A row with
// no resolvable frozen line is left untouched — marketOutcome stays absent,
// which renders as the honest "unavailable" fallback, same as any other
// missing-data case in this codebase.
//
// Reuses deriveMoundMarketOutcome (moundOutcomeAttribution.ts) — the exact
// same translation logic the prospective grading path uses — so a backfilled
// historical row and a newly-graded one are computed identically, never a
// divergent one-off implementation.

import type { MoundDirection } from "./moundDirection";
import type { MoundEvaluationSnapshot, MoundMarket } from "./types";
import { deriveMoundMarketOutcome, type MoundMarketOutcomeResult } from "./moundOutcomeAttribution";

export interface MoundMarketOutcomeBackfillRow {
  signalId: string;
  primaryMarket: MoundMarket;
  moundDirection: MoundDirection;
  /** From the persisted `outcomes` jsonb column. */
  finalStrikeouts: number | null;
  finalOutsRecorded: number | null;
  /** Already truthy (non-null marketOutcome) rows are skipped — idempotent. */
  alreadyHasMarketOutcome: boolean;
  /** From the persisted `diagnostics` jsonb column's nested evaluation record — may be entirely absent for very old rows (predates this instrumentation). */
  finalPregameSnapshot: MoundEvaluationSnapshot | null;
}

export interface MoundMarketOutcomeBackfillEntry {
  signalId: string;
  patch: MoundMarketOutcomeResult;
}

/**
 * Compute the backfill plan for a set of already-graded rows. Only rows that
 * (a) don't already carry a market outcome and (b) resolve to something other
 * than "unavailable" are included — there is nothing to write for a row with
 * no provable frozen line, and re-running this planner is always a no-op for
 * rows it already backfilled.
 */
export function planMoundMarketOutcomeBackfill(rows: MoundMarketOutcomeBackfillRow[]): MoundMarketOutcomeBackfillEntry[] {
  const plan: MoundMarketOutcomeBackfillEntry[] = [];

  for (const row of rows) {
    if (row.alreadyHasMarketOutcome) continue;

    const frozenLine =
      row.primaryMarket === "pitcher_strikeouts"
        ? row.finalPregameSnapshot?.champion.postedLine.strikeouts ?? null
        : row.finalPregameSnapshot?.champion.postedLine.outs ?? null;
    const actual = row.primaryMarket === "pitcher_strikeouts" ? row.finalStrikeouts : row.finalOutsRecorded;

    const result = deriveMoundMarketOutcome({
      moundDirection: row.moundDirection,
      frozenLine,
      lineFrozenAt: row.finalPregameSnapshot?.frozenAt ?? null,
      actual,
    });

    // Nothing provable to backfill — leave absent, never fabricated.
    if (result.marketOutcome === "unavailable") continue;

    plan.push({ signalId: row.signalId, patch: result });
  }

  return plan;
}
