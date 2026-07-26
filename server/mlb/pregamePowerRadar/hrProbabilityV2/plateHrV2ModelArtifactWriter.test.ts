// Plate HR Probability V2 — model-artifact writer invariants (PR 2).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2ModelArtifactWriter.test.ts

import {
  buildPlateHrV2ModelArtifact,
  hashPlateHrV2ModelArtifact,
  toInsertPlateHrV2ModelRegistryRow,
  defaultPlateHrV2ModelVersion,
  PLATE_HR_V2_MODEL_TYPE,
  type BuildPlateHrV2ArtifactArgs,
} from "./plateHrV2ModelArtifactWriter";
import { plateHrV2ModelArtifactSchema } from "./plateHrV2ModelArtifactContract";
import { PLATE_HR_V2_FEATURES_V1 } from "./plateHrV2FeatureContract";
import { PLATE_HR_V2_SHADOW_TERM_KEYS } from "./plateHrV2ShadowTrainingRow";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

function baseArgs(): BuildPlateHrV2ArtifactArgs {
  return {
    modelVersion: "plate_hr_v2_shadow_20260726T000000Z",
    featureKeys: PLATE_HR_V2_SHADOW_TERM_KEYS.slice(),
    termModel: {
      featureKeys: PLATE_HR_V2_SHADOW_TERM_KEYS.slice(),
      intercept: -2.9,
      coefficients: Object.fromEntries(PLATE_HR_V2_SHADOW_TERM_KEYS.map((k, i) => [k, (i - 5) * 0.1])),
      l2: 0.1,
      trainedRows: 400,
    },
    calibrator: { a: 0.85, b: -0.05, trainedRows: 100, l2: 0.05, sufficientData: true },
    trainingWindowStart: "2026-04-01T00:00:00.000Z",
    trainingWindowEnd: "2026-06-30T00:00:00.000Z",
    holdoutWindowStart: "2026-07-01T00:00:00.000Z",
    holdoutWindowEnd: "2026-07-25T00:00:00.000Z",
    sampleSize: 400,
    metrics: { walkForwardBrier: 0.09, holdoutBrierRaw: 0.095, holdoutBrierCalibrated: 0.088 },
    trainedAtIso: "2026-07-26T00:00:00.000Z",
  };
}

// ── 1. A built artifact parses cleanly against the real contract schema ────
{
  const artifact = buildPlateHrV2ModelArtifact(baseArgs());
  const result = plateHrV2ModelArtifactSchema.safeParse(artifact);
  ok(result.success, `built artifact parses against plateHrV2ModelArtifactSchema${result.success ? "" : `: ${JSON.stringify((result as any).error?.issues)}`}`);
  ok(artifact.modelType === PLATE_HR_V2_MODEL_TYPE, "modelType is the fixed PLATE_HR_V2_MODEL_TYPE constant");
  ok(artifact.featureVersion === PLATE_HR_V2_FEATURES_V1, "featureVersion matches the current feature contract version");
  ok(artifact.status === "candidate", "default status is candidate — PR2 never writes anything else");
  ok(artifact.baseline.intercept === baseArgs().termModel.intercept, "baseline.intercept preserves the fitted intercept — predictTermModel needs intercept + Σ(coef*term), not coefficients alone");
  ok(artifact.live.intercept === null, "live.intercept is null, matching live's all-null constant no-op");
}

// ── 2. missingValueBehavior is literally zero_fill ──────────────────────────
{
  const artifact = buildPlateHrV2ModelArtifact(baseArgs());
  ok(artifact.missingValueBehavior === "zero_fill", "missingValueBehavior matches fitShadowTermWeights.ts's real finite()-coercion behavior");
}

// ── 3. live component is an explicit, honest constant/all-null no-op ───────
{
  const artifact = buildPlateHrV2ModelArtifact(baseArgs());
  ok(artifact.live.kind === "constant", "live.kind is 'constant'");
  ok(artifact.live.coefficients === null && artifact.live.knots === null && artifact.live.treeNodes === null, "live component is fully null — never implies a live-conditioned refinement that doesn't exist");
  ok(artifact.baseline.kind === "logistic" && artifact.baseline.coefficients !== null, "baseline carries the real fitted coefficients");
  ok(artifact.standardization === null, "standardization stays null (justified deviation — see file header)");
}

// ── 4. Checksum stability and sensitivity ───────────────────────────────────
{
  const a1 = buildPlateHrV2ModelArtifact(baseArgs());
  const a2 = buildPlateHrV2ModelArtifact(baseArgs());
  ok(a1.checksum === a2.checksum, "identical args produce a byte-identical checksum");

  const changedArgs = baseArgs();
  changedArgs.termModel.coefficients.batterPower = 999;
  const a3 = buildPlateHrV2ModelArtifact(changedArgs);
  ok(a3.checksum !== a1.checksum, "changing a coefficient changes the checksum");

  const { checksum, ...withoutChecksum } = a1;
  ok(hashPlateHrV2ModelArtifact(withoutChecksum) === checksum, "hashPlateHrV2ModelArtifact recomputes the same checksum the builder stamped");
}

// ── 5. toInsertPlateHrV2ModelRegistryRow round-trips every field ───────────
{
  const artifact = buildPlateHrV2ModelArtifact(baseArgs());
  const row = toInsertPlateHrV2ModelRegistryRow(artifact);
  ok(row.modelVersion === artifact.modelVersion, "modelVersion round-trips");
  ok(row.artifactChecksum === artifact.checksum, "artifactChecksum round-trips");
  ok(row.artifactPath === null, "artifactPath is null — PR2 stores the body inline, not on a filesystem path");
  ok(JSON.stringify(row.artifactBody) === JSON.stringify(artifact), "artifactBody holds the exact, complete artifact JSON");
  ok(row.status === "candidate", "status round-trips");
  ok(row.trainingWindowStart === artifact.training.trainingWindowStart, "trainingWindowStart round-trips from training metadata");
}

// ── 6. defaultPlateHrV2ModelVersion is deterministic and collision-resistant across timestamps ──
{
  const v1 = defaultPlateHrV2ModelVersion("2026-07-26T14:30:22.123Z");
  const v2 = defaultPlateHrV2ModelVersion("2026-07-26T14:30:23.000Z");
  ok(v1.startsWith("plate_hr_v2_shadow_"), "version has the expected prefix");
  ok(v1 !== v2, "different timestamps produce different versions");
  ok(defaultPlateHrV2ModelVersion("2026-07-26T14:30:22.123Z") === v1, "same timestamp is deterministic");
}

console.log(`\nplateHrV2ModelArtifactWriter.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
