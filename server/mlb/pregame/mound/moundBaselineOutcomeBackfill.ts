// Mound Radar — baseline win/loss historical backfill planner (pure, no I/O).
// Mirrors moundMarketOutcomeBackfill.ts's pure-planner-plus-separate-runner-
// script convention (see server/scripts/repairMoundBaselineOutcomeBackfill.ts
// for the actual DB read/write).
//
// Settlement is now always strikeouts (moundOutcomeAttribution.ts's header
// comment). Rows graded BEFORE that fix, whose Best Angle badge
// (primaryMarket) was "pitcher_outs" at the time, had their
// outcomes.outcome/userVisible/seasonBaselineValue stamped from an OUTS
// comparison instead of a strikeouts one. This planner recomputes those
// three fields from the STRIKEOUTS data that was already captured on the
// same row regardless of Best Angle (finalStrikeouts, and the frozen pregame
// K baseline) — mirroring the exact comparison deriveMoundOutcome now
// performs prospectively, but reading the frozen baseline rather than
// re-deriving one from (possibly since-changed) live season K/9, so the
// backfilled result matches what the engine actually knew at the time.
//
// Rows whose Best Angle was already "pitcher_strikeouts" at grading time are
// already correct and are skipped — nothing to fix. A row missing either the
// frozen baseline or the final K count is left untouched — never fabricated.

import type { MoundDirection } from "./moundDirection";
import type { MoundMarket } from "./types";
import type { MoundOutcomeType } from "../../../../shared/moundRadarWin";

export interface MoundBaselineOutcomeBackfillRow {
  signalId: string;
  /** Best Angle badge stamped at ORIGINAL grading time — only "pitcher_outs" rows need recomputation. */
  primaryMarket: MoundMarket;
  /** Already captured on every graded row regardless of Best Angle. */
  finalStrikeouts: number | null;
  /** finalPregameSnapshot.champion.frozenProductionBaseline.strikeouts.value — never a freshly re-derived season K/9. */
  frozenBaselineStrikeouts: number | null;
  /** The direction this row was actually graded/labelled under (moundOutcomeAttribution.ts's resolveMoundSettlementDirection) — read as-is, never recomputed here. */
  settledDirection: MoundDirection;
  /** Whether this row was a genuine public recommendation under settledDirection (everPubliclyFlagged for follow, everPubliclyFlaggedFade for fade). */
  wasPubliclyFlagged: boolean;
}

export interface MoundBaselineOutcomeBackfillPatch {
  outcome: MoundOutcomeType;
  userVisible: boolean;
  seasonBaselineValue: number | null;
}

export interface MoundBaselineOutcomeBackfillEntry {
  signalId: string;
  patch: MoundBaselineOutcomeBackfillPatch;
}

/**
 * Compute the backfill plan for already-graded rows whose Best Angle was
 * Pitcher Outs at original grading time. Mirrors deriveMoundOutcome's
 * Follow/Fade comparison exactly (>= clears Over, Fade cashes on the
 * opposite of Over), applied to the frozen pregame K baseline instead of a
 * freshly re-derived one.
 */
export function planMoundBaselineOutcomeBackfill(
  rows: MoundBaselineOutcomeBackfillRow[],
): MoundBaselineOutcomeBackfillEntry[] {
  const plan: MoundBaselineOutcomeBackfillEntry[] = [];

  for (const row of rows) {
    if (row.primaryMarket !== "pitcher_outs") continue; // already graded on strikeouts — nothing to fix

    const baseline = row.frozenBaselineStrikeouts;
    const actual = row.finalStrikeouts;
    if (baseline == null || actual == null) continue; // never fabricated

    const clearedOver = actual >= baseline;

    if (row.settledDirection === "fade") {
      const fadeCashed = !clearedOver;
      plan.push({
        signalId: row.signalId,
        patch: fadeCashed
          ? { outcome: "mound_fade_win", userVisible: row.wasPubliclyFlagged === true, seasonBaselineValue: baseline }
          : { outcome: "mound_calibration_miss", userVisible: false, seasonBaselineValue: baseline },
      });
      continue;
    }

    // Follow (or unresolved direction) — unchanged Over-only rule.
    plan.push({
      signalId: row.signalId,
      patch: clearedOver
        ? { outcome: "mound_win", userVisible: row.wasPubliclyFlagged === true, seasonBaselineValue: baseline }
        : { outcome: "mound_calibration_miss", userVisible: false, seasonBaselineValue: baseline },
    });
  }

  return plan;
}
