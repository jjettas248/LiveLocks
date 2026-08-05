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
import { deriveFrozenMoundMarketRecommendation } from "./marketRecommendation";

export interface MoundMarketOutcomeBackfillRow {
  signalId: string;
  primaryMarket: MoundMarket;
  /**
   * The row's MODEL read. Retained for logging/traceability only — it is
   * deliberately NOT used to pick the sportsbook side (see the planner body).
   */
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

    // Strikeouts is the sole settlement market — see
    // moundOutcomeAttribution.ts's header comment. row.primaryMarket (Best
    // Angle at original grading time) is display-only and never selects the
    // backfill input.
    const settlementMarket = "pitcher_strikeouts" as const;
    const frozenLine = row.finalPregameSnapshot?.champion.postedLine.strikeouts ?? null;
    const actual = row.finalStrikeouts;

    // The sportsbook side comes from the FROZEN pregame recommendation
    // (projection vs. posted line), exactly as the prospective grading path
    // derives it — never remapped from the row's Follow/Fade model read.
    // Follow/Fade answers "is this pitcher above or below his own season
    // baseline?"; OVER/UNDER answers "is the frozen projection above or below
    // a real posted line?" A Follow can legitimately be an UNDER and vice
    // versa, so inferring one from the other would backfill historical rows
    // with sides no user was ever shown.
    const recommendation = deriveFrozenMoundMarketRecommendation(settlementMarket, row.finalPregameSnapshot);
    const marketSettlementDirection: MoundDirection =
      recommendation.side === "OVER" ? "follow" : recommendation.side === "UNDER" ? "fade" : null;

    const result = deriveMoundMarketOutcome({
      moundDirection: marketSettlementDirection,
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
