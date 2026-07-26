// Plate HR Probability V2 — forbidden-training-feature structural sweep
// (PR 1, correction 4).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/plateHrV2TrainingFeatureGuard.test.ts

import { z } from "zod";
import { plateHrV2DerivedFeatureVectorV1Schema } from "./plateHrV2FeatureContract";
import { PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES, assertNoForbiddenTrainingFeatures } from "./plateHrV2TrainingFeatureGuard";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${msg}`); }
}

/**
 * Recursively collect every leaf key name declared in a Zod object schema,
 * skipping the `extra` escape-hatch record (that's a free-form bag, not a
 * named contract leaf) and recursing into nested ZodObjects. This walks the
 * REAL schema definition, not a hand-written fixture, so it can't drift out
 * of sync with plateHrV2FeatureContract.ts.
 */
function collectLeafNames(schema: z.ZodTypeAny, path: string[] = []): string[] {
  const names: string[] = [];
  const def: any = (schema as any)._def;
  if (def?.typeName === "ZodObject") {
    const shape = (schema as any).shape as Record<string, z.ZodTypeAny>;
    for (const [key, child] of Object.entries(shape)) {
      if (key === "extra") continue;
      let unwrapped: any = child;
      while (unwrapped?._def?.typeName === "ZodOptional" || unwrapped?._def?.typeName === "ZodNullable") {
        unwrapped = unwrapped._def.innerType;
      }
      if (unwrapped?._def?.typeName === "ZodObject") {
        names.push(...collectLeafNames(unwrapped, [...path, key]));
      } else {
        names.push([...path, key].join("."));
        names.push(key); // bare leaf name too — the forbidden list is bare-name based
      }
    }
  }
  return names;
}

// ── 1. Every leaf name declared in the real feature-vector schema is clean ─
{
  const leafNames = collectLeafNames(plateHrV2DerivedFeatureVectorV1Schema);
  ok(leafNames.length > 20, "the walker actually found a substantial number of leaves (sanity check the walker isn't silently returning nothing)");

  let threw = false;
  let offender: string | null = null;
  try {
    assertNoForbiddenTrainingFeatures(leafNames);
  } catch (err: any) {
    threw = true;
    offender = err?.message ?? String(err);
  }
  ok(!threw, `no leaf name in the real derived-feature-vector schema matches the forbidden training-feature list${threw ? `: ${offender}` : ""}`);

  for (const forbidden of PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES) {
    ok(!leafNames.includes(forbidden), `"${forbidden}" (forbidden) does not appear as a schema leaf name`);
  }
}

// ── 2. A hypothetically-mistaken future leaf IS caught (proves the sweep has teeth) ──
{
  const HypotheticalMistakeSchema = z.object({
    batterPower: z.object({ xISO: z.number().nullable(), championScore10: z.number().nullable() }),
  });
  const leafNames = collectLeafNames(HypotheticalMistakeSchema);
  let threw = false;
  try {
    assertNoForbiddenTrainingFeatures(leafNames);
  } catch {
    threw = true;
  }
  ok(threw, "a synthetic schema with a forbidden leaf name (championScore10) IS caught by the sweep — proves this isn't a vacuous pass");
}

// ── 3. Metadata columns live only on the outer row, never inside derived_features ──
{
  // plateHrV2FeatureContract.ts's derived-feature schema has no
  // championModelVersion/championScore10/championTier/championSuppressed
  // fields at all — they exist only as sibling columns on the persisted
  // snapshot row (see shared/schema.ts's plateHrV2FeatureSnapshots table and
  // plateHrV2ForwardCapture.ts's PlateHrV2CaptureRow). Confirmed structurally
  // by the walker above finding zero matches; this test names the specific
  // fields explicitly so a future contract change that accidentally adds one
  // fails loudly rather than silently passing the generic sweep.
  const leafNames = collectLeafNames(plateHrV2DerivedFeatureVectorV1Schema);
  for (const metadataField of ["championModelVersion", "championScore10", "championTier", "championSuppressed", "hitHrToday", "hrCountToday"]) {
    ok(!leafNames.includes(metadataField), `"${metadataField}" is not reachable from the feature-vector schema at all`);
  }
}

console.log(`\nplateHrV2TrainingFeatureGuard.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
