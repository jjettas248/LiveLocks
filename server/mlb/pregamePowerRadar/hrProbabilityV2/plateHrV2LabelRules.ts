// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — label disposition rules (PR 2).
//
// The pure decision at the heart of the labeler: given a game's resolved
// outcome facts and one batter's box-score facts (or lack thereof), produce
// exactly one PlateHrV2EvaluationLabelContract row, implementing
// plateHrV2LabelContract.ts's documented invariants exactly (whole-game
// target, no_pa_recorded carve-out, censored-never-a-negative, hitHrToday
// non-null only when resolved).
// ─────────────────────────────────────────────────────────────────────────────

import {
  plateHrV2EvaluationLabelContractSchema,
  type PlateHrV2EvaluationLabelContract,
} from "./plateHrV2LabelContract";
import type { PlateHrV2GameOutcomeFact, PlateHrV2BatterOutcomeFact } from "./plateHrV2OutcomeSource";

export interface PlateHrV2LabelDecisionInput {
  snapshotId: string;
  labelVersion: string;
  gameId: string;
  batterId: string;
  nowIso: string;
  game: PlateHrV2GameOutcomeFact;
  batter: PlateHrV2BatterOutcomeFact | null;
  anyBoxScoreRowsForGame: boolean;
}

/**
 * Pure. Never throws — the returned object is validated against the real
 * contract schema before being handed back, as a cheap correctness net.
 */
export function derivePlateHrV2Label(input: PlateHrV2LabelDecisionInput): PlateHrV2EvaluationLabelContract {
  const { game, batter, anyBoxScoreRowsForGame } = input;

  let labelDisposition: PlateHrV2EvaluationLabelContract["labelDisposition"];
  let resolutionReason: PlateHrV2EvaluationLabelContract["resolutionReason"];

  if (game.gameStatus === "final") {
    if (batter && batter.paCountObserved > 0) {
      labelDisposition = "resolved";
      resolutionReason = "game_final";
    } else if (batter && batter.paCountObserved === 0) {
      // Confirmed box-score row, but zero PA — modeled on real HR-prop
      // settlement: a scratched/DNP player voids the bet, doesn't lose it.
      labelDisposition = "excluded";
      resolutionReason = "no_pa_recorded";
    } else if (anyBoxScoreRowsForGame) {
      // No row for THIS batter, but other batters in the same game resolved
      // fine — the game's data pipeline works, so a missing row here is most
      // likely a genuine scratch, not a systemic identity bug.
      labelDisposition = "excluded";
      resolutionReason = "no_pa_recorded";
    } else {
      // Not even one batter resolved for this game — can't confirm the
      // game's data pipeline worked at all, so this is an identity/data gap,
      // not a confident "this specific batter didn't play" read.
      labelDisposition = "excluded";
      resolutionReason = "identity_unresolved";
    }
  } else if (game.gameStatus === "postponed") {
    labelDisposition = "censored";
    resolutionReason = "game_postponed";
  } else if (game.gameStatus === "suspended") {
    // Defensive fallback only in normal operation — the reconciler filters
    // "suspended" games out (alongside "in_progress"/"unknown") BEFORE this
    // function is ever called, specifically so a snapshot never acquires a
    // premature censored label that the append-only label store can then
    // never replace once the game resumes under the same gamePk and reaches
    // a real "final" (see plateHrV2LabelReconciler.ts's skippedGameNotOverYet
    // path). This branch stays correct in isolation for any other caller.
    labelDisposition = "censored";
    resolutionReason = "game_suspended_unresolved";
  } else {
    // Defensive fallback only — "in_progress"/"unknown" games are filtered
    // out by the reconciler before this function is ever called (see
    // plateHrV2LabelReconciler.ts's skippedGameNotOverYet path), so a real
    // manual_review row is unreachable in normal operation.
    labelDisposition = "manual_review";
    resolutionReason = "suspended_manual_review";
  }

  const resolved = labelDisposition === "resolved";
  const hasBatterFacts = batter != null;
  const firstHr = batter?.firstHr ?? null;

  const label: PlateHrV2EvaluationLabelContract = {
    labelVersion: input.labelVersion,
    snapshotId: input.snapshotId,
    labelDisposition,
    // Every disposition except manual_review represents a definitive,
    // terminal determination about this labeling attempt (resolved/censored/
    // excluded are all "we're done deciding," just not all a boolean HR
    // outcome) — manual_review is explicitly pending further action.
    resolvedAt: labelDisposition === "manual_review" ? null : input.nowIso,
    resolutionReason,
    hitHrToday: resolved ? (batter!.hrCountToday > 0) : null,
    // Preserved whenever available regardless of disposition (never for
    // ranking/training beyond the HR target itself — see the contract's own
    // header) — e.g. an excluded/no_pa_recorded row still usefully shows
    // paCountObserved:0 as the evidence behind that exclusion.
    paCountObserved: hasBatterFacts ? batter!.paCountObserved : null,
    hrCountToday: hasBatterFacts ? batter!.hrCountToday : null,
    hrEventId: firstHr ? `plate-hr-v2-hr:${input.gameId}:${input.batterId}:${firstHr.plateAppearanceNumber}` : null,
    hrInning: firstHr?.inning ?? null,
    hrHalf: firstHr?.half ?? null,
    hrPlateAppearanceNumber: firstHr?.plateAppearanceNumber ?? null,
    hrFirstAb: firstHr ? firstHr.firstAb : null,
    labelSource: "engine",
    dataQuality: hasBatterFacts ? "box_score_v1" : "status_only",
  };

  return plateHrV2EvaluationLabelContractSchema.parse(label);
}
