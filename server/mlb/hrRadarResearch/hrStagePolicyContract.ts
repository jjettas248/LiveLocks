// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — stage policy + shadow decision contract (PR 1).
//
// The model predicts probability; a separate versioned policy proposes a
// stage. `hrStagePolicySchema` is the frozen policy shape (PR 6 freezes a
// version before shadow evaluation). `hrShadowDecisionRecordSchema` mirrors
// shared/schema.ts hr_radar_shadow_decisions — the one-row-per-
// (snapshotId, modelVersion, policyVersion) table split out from
// hr_radar_shadow_predictions so multiple policies can be evaluated against
// one model's probabilities without duplicating the (expensive) inference
// output.
//
// Hard invariant for later evaluation (PR 6+): "first Fire" for evaluation
// purposes means the FIRST row per (gameId, playerId, modelVersion,
// policyVersion) — joined back to hr_radar_evaluation_snapshots via
// snapshotId — where proposedStage === "fire" && stageTransitioned === true.
// Counting every snapshot that merely remains Fire (instead of only the
// transition into it) would inflate sample size and precision.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const hrStageNameSchema = z.enum(["watch", "build", "ready", "fire"]);
export type HrStageName = z.infer<typeof hrStageNameSchema>;

export const hrStageGateSchema = z.object({
  stage: hrStageNameSchema,
  minProbability: z.number().min(0).max(1).nullable(),
  minLiveLift: z.number().nullable(),
  minRankInGame: z.number().int().nullable(),
  requiresDataQuality: z.enum(["full", "degraded", "any"]),
});
export type HrStageGate = z.infer<typeof hrStageGateSchema>;

// .length(4) enforces exactly one gate per stage at the schema level. A
// later PR's runtime policy evaluator must additionally verify the 4 gates
// cover exactly ["watch","build","ready","fire"] with no duplicates — the
// Zod contract alone only catches "wrong gate count" cheaply, not "duplicate
// stage with a missing stage" (see hrRadarResearchContracts.test.ts for a
// worked example of that stronger check).
export const hrStagePolicySchema = z.object({
  policyVersion: z.string().min(1),
  gates: z.array(hrStageGateSchema).length(4),
  notes: z.string().nullable(),
});
export type HrStagePolicy = z.infer<typeof hrStagePolicySchema>;

// Mirrors hr_radar_shadow_decisions. `stageTransitioned` is true exactly
// when proposedStage differs from previousProposedStage for the same
// (snapshotId lineage / player / game / model / policy) — computed at write
// time by a later PR's decision writer, not by this contract.
export const hrShadowDecisionRecordSchema = z.object({
  snapshotId: z.string().min(1),
  modelVersion: z.string().min(1),
  policyVersion: z.string().min(1),
  proposedStage: hrStageNameSchema.nullable(),
  previousProposedStage: hrStageNameSchema.nullable(),
  stageTransitioned: z.boolean(),
});
export type HrShadowDecisionRecord = z.infer<typeof hrShadowDecisionRecordSchema>;
