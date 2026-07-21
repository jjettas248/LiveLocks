// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — model artifact contract (PR 1).
//
// The immutable JSON artifact shape a later PR's artifact loader (PR 5)
// will `.parse()` against before evaluating a challenger model. PR 1 defines
// and typechecks the contract only — no loader, no file-read, no network
// call exists yet. A bad/missing/checksum-mismatched artifact must disable
// the challenger and leave the champion intact (enforced in PR 5, not here).
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { HR_FEATURES_V1 } from "./hrFeatureContract";

export const hrModelArtifactStatusSchema = z.enum([
  "candidate",
  "shadow",
  "canary",
  "active",
  "retired",
  "rejected",
]);
export type HrModelArtifactStatus = z.infer<typeof hrModelArtifactStatusSchema>;

// `treeNodes` is deliberately z.unknown() — tree-model node shapes vary by
// algorithm and PR 1 isn't picking the model family; every other leaf here
// is concretely typed.
export const hrModelArtifactComponentSchema = z.object({
  kind: z.enum(["logistic", "gbm_tree", "spline", "constant"]),
  coefficients: z.record(z.string(), z.number()).nullable(),
  knots: z.array(z.number()).nullable(),
  treeNodes: z.unknown().nullable(),
});
export type HrModelArtifactComponent = z.infer<typeof hrModelArtifactComponentSchema>;

export const hrModelArtifactCalibrationSchema = z.object({
  method: z.enum(["platt", "isotonic", "none"]),
  params: z.record(z.string(), z.number()).nullable(),
});
export type HrModelArtifactCalibration = z.infer<typeof hrModelArtifactCalibrationSchema>;

// The artifact's embedded pointer to (not full definition of) the stage
// policy in effect at training time. Full policy shape lives in
// hrStagePolicyContract.ts.
export const hrModelArtifactPolicyRefSchema = z.object({
  policyVersion: z.string().min(1),
  thresholds: z.record(z.string(), z.number()),
});
export type HrModelArtifactPolicyRef = z.infer<typeof hrModelArtifactPolicyRefSchema>;

export const hrModelArtifactTrainingMetadataSchema = z.object({
  trainedAt: z.string(),
  trainingWindowStart: z.string().nullable(),
  trainingWindowEnd: z.string().nullable(),
  holdoutWindowStart: z.string().nullable(),
  holdoutWindowEnd: z.string().nullable(),
  sampleSize: z.number().int().nullable(),
  metrics: z.record(z.string(), z.number()).nullable(),
});
export type HrModelArtifactTrainingMetadata = z.infer<typeof hrModelArtifactTrainingMetadataSchema>;

export const hrModelArtifactSchema = z.object({
  modelVersion: z.string().min(1),
  modelType: z.string().min(1),
  featureVersion: z.literal(HR_FEATURES_V1),
  featureOrder: z.array(z.string()).min(1),
  missingValueBehavior: z.enum(["zero_fill", "mean_fill", "neutral_marker", "reject"]),
  baseline: hrModelArtifactComponentSchema,
  live: hrModelArtifactComponentSchema,
  calibration: hrModelArtifactCalibrationSchema,
  policy: hrModelArtifactPolicyRefSchema,
  training: hrModelArtifactTrainingMetadataSchema,
  status: hrModelArtifactStatusSchema,
  checksum: z.string().min(1),
});

export type HrModelArtifact = z.infer<typeof hrModelArtifactSchema>;
