// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — label contract (PR 1).
//
// Mirrors shared/schema.ts hr_radar_evaluation_labels 1:1 — the DB row IS
// the label contract, no divergence permitted. One label ROW per
// (snapshotId, labelVersion); the table's PK is that composite pair,
// append-only, so a corrected label adds a new versioned row rather than
// overwriting history.
//
// Hard invariants (enforced by later PRs' labeler/reconciler, not by this
// schema alone — documented here so every consumer sees them):
//   - Only rows with labelDisposition === "resolved" may enter model
//     metrics. "censored" / "excluded" / "manual_review" rows must never be
//     silently treated as ordinary negatives.
//   - hrNextPa is non-null ONLY when nextPaOccurred === true. A row with
//     nextPaOccurred === false and hrNextPa === null is a properly censored
//     short-horizon observation, not missing data — it must never be scored
//     as a negative for the next-PA target. Same rule for
//     hrNextTwoPa/secondPaOccurred.
//   - hrRemainderGame follows a DIFFERENT rule: it is a normal resolved
//     boolean, and `false` is a fully valid, fully resolved negative when
//     the game ends or the player is removed without a further HR. It is
//     never censored by the next-PA rule above.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const HR_LABEL_V1 = "hr_label_v1" as const;

export const hrLabelDispositionSchema = z.enum(["resolved", "censored", "excluded", "manual_review"]);
export type HrLabelDisposition = z.infer<typeof hrLabelDispositionSchema>;

export const hrLabelResolutionReasonSchema = z.enum([
  "game_final",
  "substitution",
  "no_remaining_pa",
  "suspended_manual_review",
]);
export type HrLabelResolutionReason = z.infer<typeof hrLabelResolutionReasonSchema>;

export const hrLabelSourceSchema = z.enum(["engine", "manual_review", "backfill"]);
export type HrLabelSource = z.infer<typeof hrLabelSourceSchema>;

export const hrEvaluationLabelContractSchema = z.object({
  labelVersion: z.string().min(1),
  snapshotId: z.string().min(1),
  labelDisposition: hrLabelDispositionSchema,
  resolvedAt: z.string().nullable(),
  resolutionReason: hrLabelResolutionReasonSchema.nullable(),
  hrRemainderGame: z.boolean().nullable(),
  hrNextPa: z.boolean().nullable(),
  nextPaOccurred: z.boolean().nullable(),
  hrNextTwoPa: z.boolean().nullable(),
  secondPaOccurred: z.boolean().nullable(),
  remainingPaObserved: z.number().int().nullable(),
  nextPaId: z.string().nullable(),
  secondPaId: z.string().nullable(),
  hrEventId: z.string().nullable(),
  hrPlaySequence: z.number().int().nullable(),
  hrAt: z.string().nullable(),
  hrInning: z.number().int().nullable(),
  hrPaOrdinal: z.number().int().nullable(),
  labelSource: hrLabelSourceSchema,
  dataQuality: z.string().nullable(),
});

export type HrEvaluationLabelContract = z.infer<typeof hrEvaluationLabelContractSchema>;
