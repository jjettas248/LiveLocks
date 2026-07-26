// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — model-artifact writer (PR 2).
//
// Serializes a fitted PlateHrV2ShadowFittingResult into the versioned
// PlateHrV2ModelArtifact contract shape, computes a checksum, and builds the
// row plate_hr_v2_model_registry expects. Always writes status:"candidate" —
// PR2 has no promotion lifecycle. checksum/stableStringify mirror
// frozenPlateHrV2Input.ts's own hash pattern exactly (a deliberate duplicate,
// not an import — same "keep in sync by convention" reasoning already used
// twice in this module for exactly this utility).
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import type { InsertPlateHrV2ModelRegistry } from "@shared/schema";
import type { LogisticTermModel } from "../math/fitShadowTermWeights";
import type { PlateHrV2CalibratorModel } from "./plateHrV2Calibrator";
import { PLATE_HR_V2_FEATURES_V1 } from "./plateHrV2FeatureContract";
import {
  plateHrV2ModelArtifactSchema,
  type PlateHrV2ModelArtifact,
  type PlateHrV2ModelArtifactStatus,
} from "./plateHrV2ModelArtifactContract";

export const PLATE_HR_V2_MODEL_TYPE = "plate_hr_v2_pregame_logistic_v1" as const;

/** e.g. "plate_hr_v2_shadow_20260726T143022Z" */
export function defaultPlateHrV2ModelVersion(trainedAtIso: string): string {
  const compact = trainedAtIso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `plate_hr_v2_shadow_${compact}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashPlateHrV2ModelArtifact(artifactWithoutChecksum: Omit<PlateHrV2ModelArtifact, "checksum">): string {
  return createHash("sha256").update(stableStringify(artifactWithoutChecksum)).digest("hex").slice(0, 16);
}

export interface BuildPlateHrV2ArtifactArgs {
  modelVersion: string;
  featureKeys: string[];
  termModel: LogisticTermModel;
  calibrator: PlateHrV2CalibratorModel;
  trainingWindowStart: string | null;
  trainingWindowEnd: string | null;
  holdoutWindowStart: string | null;
  holdoutWindowEnd: string | null;
  sampleSize: number;
  metrics: Record<string, number>;
  trainedAtIso: string;
  status?: PlateHrV2ModelArtifactStatus;
}

/**
 * Assembles and validates a PlateHrV2ModelArtifact. Every field choice is
 * justified against what fitShadowTermWeights.ts actually does, not assumed:
 *   - missingValueBehavior is "zero_fill" because that fitter's own finite()
 *     helper coerces any non-finite/null/undefined term to 0 before the dot
 *     product — declaring anything else would misdescribe its real behavior.
 *   - standardization stays null: math/'s component scorers already emit
 *     individually-capped, comparably-scaled log-odds terms (not raw
 *     heterogeneous features), so z-scoring adds complexity without a real
 *     behavior change at this stage.
 *   - live is an explicit "constant"/all-null no-op: V2 has no live/in-game
 *     component at all (pregame-only by leakageGuard.ts design); the slot
 *     exists only because it mirrors HR Radar Research's differently-scoped
 *     artifact shape, and an honest no-op avoids implying a live-conditioned
 *     refinement that doesn't exist.
 */
export function buildPlateHrV2ModelArtifact(args: BuildPlateHrV2ArtifactArgs): PlateHrV2ModelArtifact {
  const withoutChecksum: Omit<PlateHrV2ModelArtifact, "checksum"> = {
    modelVersion: args.modelVersion,
    modelType: PLATE_HR_V2_MODEL_TYPE,
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    featureOrder: args.featureKeys.slice(),
    missingValueBehavior: "zero_fill",
    standardization: null,
    baseline: {
      kind: "logistic",
      intercept: args.termModel.intercept,
      coefficients: args.termModel.coefficients,
      knots: null,
      treeNodes: null,
    },
    live: { kind: "constant", intercept: null, coefficients: null, knots: null, treeNodes: null },
    calibration: {
      method: "platt",
      params: { a: args.calibrator.a, b: args.calibrator.b },
    },
    training: {
      trainedAt: args.trainedAtIso,
      trainingWindowStart: args.trainingWindowStart,
      trainingWindowEnd: args.trainingWindowEnd,
      holdoutWindowStart: args.holdoutWindowStart,
      holdoutWindowEnd: args.holdoutWindowEnd,
      sampleSize: args.sampleSize,
      metrics: args.metrics,
    },
    status: args.status ?? "candidate",
  };

  const artifact: PlateHrV2ModelArtifact = {
    ...withoutChecksum,
    checksum: hashPlateHrV2ModelArtifact(withoutChecksum),
  };

  return plateHrV2ModelArtifactSchema.parse(artifact);
}

export function toInsertPlateHrV2ModelRegistryRow(artifact: PlateHrV2ModelArtifact): InsertPlateHrV2ModelRegistry {
  return {
    modelVersion: artifact.modelVersion,
    modelType: artifact.modelType,
    featureVersion: artifact.featureVersion,
    trainingWindowStart: artifact.training.trainingWindowStart,
    trainingWindowEnd: artifact.training.trainingWindowEnd,
    holdoutWindowStart: artifact.training.holdoutWindowStart,
    holdoutWindowEnd: artifact.training.holdoutWindowEnd,
    // Reserved for a future external-storage backend — PR2 stores the full
    // body inline in artifactBody (Postgres-native; Railway's container
    // filesystem is ephemeral across deploys, so a local path can't be relied on).
    artifactPath: null,
    artifactChecksum: artifact.checksum,
    artifactBody: artifact,
    standardization: artifact.standardization,
    metrics: artifact.training.metrics,
    status: artifact.status,
    activatedAt: null,
    retiredAt: null,
    retirementReason: null,
  };
}
