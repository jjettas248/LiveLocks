// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — label contract (PR 1).
//
// Mirrors shared/schema.ts plate_hr_v2_labels 1:1 — the DB row IS the label
// contract, no divergence permitted. One label ROW per (snapshotId,
// labelVersion); the table's PK is that composite pair, append-only, so a
// corrected label adds a new versioned row rather than overwriting history.
//
// Deliberately different from server/mlb/hrRadarResearch/hrLabelContract.ts's
// next-PA censoring rule: Plate V2's primary prediction target is
// `P(hitter hits >= 1 HR in game)`, a WHOLE-GAME target, not a next-PA/
// next-two-PA target. There is therefore no PA-count-conditioned censoring
// rule here — `hitHrToday` is unconditional on how many PAs the batter
// recorded, once the game itself has resolved.
//
// Hard invariants (enforced by a later PR's labeler/reconciler, not by this
// schema alone — documented here so every consumer sees them):
//   - Only rows with labelDisposition === "resolved" may enter model
//     metrics. "censored" / "excluded" / "manual_review" rows must never be
//     silently treated as ordinary negatives.
//   - hitHrToday is non-null ONLY when labelDisposition === "resolved".
//   - labelDisposition is "resolved" once the game reaches a final status,
//     REGARDLESS of how many PAs the batter recorded — false is a fully
//     valid, fully resolved negative whether the batter played 9 innings or
//     was pinch-hit for in the 3rd.
//   - The one carve-out: "no_pa_recorded" (the batter recorded zero PAs at
//     all, e.g. a pregame scratch) resolves to "excluded", modeled on real
//     HR-prop settlement (a scratched player voids the bet rather than
//     losing it) — NOT resolved-false.
//   - "censored" applies only when the game itself never produced a result
//     (postponed with no same-day makeup, or suspended and not yet resumed)
//     — right-censoring, never a negative.
//   - Total-base composition is never part of this label. paCountObserved/
//     hrCountToday are preserved for PA-hazard-layer validation (a 0-HR-in-2-PA
//     row and a 0-HR-in-5-PA row are both game-level negatives, but carry very
//     different information for the hazard model) — never for ranking,
//     training, or grading on anything other than the HR target itself.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const PLATE_HR_V2_LABEL_V1 = "plate_hr_v2_label_v1" as const;

export const plateHrV2LabelDispositionSchema = z.enum(["resolved", "censored", "excluded", "manual_review"]);
export type PlateHrV2LabelDisposition = z.infer<typeof plateHrV2LabelDispositionSchema>;

export const plateHrV2LabelResolutionReasonSchema = z.enum([
  "game_final", // resolved: game reached a final status
  "game_postponed", // censored: scheduled game never happened, no same-day makeup captured
  "game_suspended_unresolved", // censored (pending): suspended, not yet resumed to final
  "no_pa_recorded", // excluded: confirmed-lineup batter recorded zero PAs (scratch/injury pregame)
  "identity_unresolved", // excluded: batterId/gameId could not be matched to the outcome feed
  "suspended_manual_review", // manual_review: resumed after an unusual gap, needs human check
]);
export type PlateHrV2LabelResolutionReason = z.infer<typeof plateHrV2LabelResolutionReasonSchema>;

export const plateHrV2LabelSourceSchema = z.enum(["engine", "manual_review", "backfill"]);
export type PlateHrV2LabelSource = z.infer<typeof plateHrV2LabelSourceSchema>;

export const plateHrV2EvaluationLabelContractSchema = z.object({
  labelVersion: z.string().min(1),
  snapshotId: z.string().min(1),
  labelDisposition: plateHrV2LabelDispositionSchema,
  resolvedAt: z.string().nullable(),
  resolutionReason: plateHrV2LabelResolutionReasonSchema.nullable(),
  hitHrToday: z.boolean().nullable(),
  paCountObserved: z.number().int().nullable(),
  hrCountToday: z.number().int().nullable(),
  hrEventId: z.string().nullable(),
  hrInning: z.number().int().nullable(),
  hrHalf: z.enum(["top", "bottom"]).nullable(),
  hrPlateAppearanceNumber: z.number().int().nullable(),
  hrFirstAb: z.boolean().nullable(),
  labelSource: plateHrV2LabelSourceSchema,
  dataQuality: z.string().nullable(),
});
export type PlateHrV2EvaluationLabelContract = z.infer<typeof plateHrV2EvaluationLabelContractSchema>;
