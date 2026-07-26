// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — model artifact contract (PR 1).
//
// The immutable JSON artifact shape a later PR's artifact loader will
// `.parse()` against before evaluating V2 against real data. PR 1 defines and
// typechecks the contract only — no loader, no file-read, no fitting code
// exists yet. A bad/missing/checksum-mismatched artifact must disable V2
// entirely and can never affect the champion (enforced by a later PR, not
// here — V2 has zero production authority regardless).
//
// Mirrors server/mlb/hrRadarResearch/hrModelArtifactContract.ts, with one
// deliberate addition and one deliberate omission:
//   - Added: `standardization` (feature means/stddevs). Neither math/ nor HR
//     Radar Live standardizes raw features today, but the spec's baseline
//     model (a regularized logistic regression fit on standardized
//     continuous features) will need this on day one of PR2 — nullable and
//     additive, so slotting it now costs nothing versus forcing an immediate
//     PR2 contract migration.
//   - Omitted: the `policy` (stage-policy) block hrModelArtifactContract.ts
//     has — Plate V2 has no Watch/Build/Ready/Fire-style promotion policy
//     defined anywhere yet. Add one only if/when a promotion policy exists.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { PLATE_HR_V2_FEATURES_V1 } from "./plateHrV2FeatureContract";

export const plateHrV2ModelArtifactStatusSchema = z.enum([
  "candidate",
  "shadow",
  "canary",
  "active",
  "retired",
  "rejected",
]);
export type PlateHrV2ModelArtifactStatus = z.infer<typeof plateHrV2ModelArtifactStatusSchema>;

// `treeNodes` is deliberately z.unknown() — tree-model node shapes vary by
// algorithm and PR 1 isn't picking the model family; every other leaf here is
// concretely typed.
//
// `intercept` (PR2 addition): a logistic component's coefficients alone are
// not enough to reproduce its fitted probabilities — math/fitShadowTermWeights.ts's
// predictTermModel computes sigmoid(intercept + Σ coefficient*term), and for a
// typical HR-rate model the intercept is a large negative number (baseline log-odds
// of the ~5% league HR rate). A dedicated field (rather than smuggling it into
// `coefficients` under a reserved key) keeps every entry in `coefficients` a real,
// unambiguous feature term a future loader can iterate without special-casing.
export const plateHrV2ModelArtifactComponentSchema = z.object({
  kind: z.enum(["logistic", "gbm_tree", "spline", "constant"]),
  intercept: z.number().nullable(),
  coefficients: z.record(z.string(), z.number()).nullable(),
  knots: z.array(z.number()).nullable(),
  treeNodes: z.unknown().nullable(),
});
export type PlateHrV2ModelArtifactComponent = z.infer<typeof plateHrV2ModelArtifactComponentSchema>;

export const plateHrV2ModelArtifactCalibrationSchema = z.object({
  method: z.enum(["platt", "isotonic", "none"]),
  params: z.record(z.string(), z.number()).nullable(),
});
export type PlateHrV2ModelArtifactCalibration = z.infer<typeof plateHrV2ModelArtifactCalibrationSchema>;

// Standardization parameters for a fitted model's raw continuous features —
// see file header. Null until a PR2 fitter actually standardizes features.
export const plateHrV2ModelStandardizationSchema = z
  .object({
    featureMeans: z.record(z.string(), z.number()),
    featureStddevs: z.record(z.string(), z.number()),
  })
  .nullable();
export type PlateHrV2ModelStandardization = z.infer<typeof plateHrV2ModelStandardizationSchema>;

export const plateHrV2ModelArtifactTrainingMetadataSchema = z.object({
  trainedAt: z.string(),
  trainingWindowStart: z.string().nullable(),
  trainingWindowEnd: z.string().nullable(),
  holdoutWindowStart: z.string().nullable(),
  holdoutWindowEnd: z.string().nullable(),
  sampleSize: z.number().int().nullable(),
  metrics: z.record(z.string(), z.number()).nullable(),
});
export type PlateHrV2ModelArtifactTrainingMetadata = z.infer<typeof plateHrV2ModelArtifactTrainingMetadataSchema>;

export const plateHrV2ModelArtifactSchema = z.object({
  modelVersion: z.string().min(1),
  modelType: z.string().min(1),
  featureVersion: z.literal(PLATE_HR_V2_FEATURES_V1),
  featureOrder: z.array(z.string()).min(1),
  missingValueBehavior: z.enum(["zero_fill", "mean_fill", "neutral_marker", "reject"]),
  standardization: plateHrV2ModelStandardizationSchema,
  baseline: plateHrV2ModelArtifactComponentSchema,
  live: plateHrV2ModelArtifactComponentSchema,
  calibration: plateHrV2ModelArtifactCalibrationSchema,
  training: plateHrV2ModelArtifactTrainingMetadataSchema,
  status: plateHrV2ModelArtifactStatusSchema,
  checksum: z.string().min(1),
});
export type PlateHrV2ModelArtifact = z.infer<typeof plateHrV2ModelArtifactSchema>;
