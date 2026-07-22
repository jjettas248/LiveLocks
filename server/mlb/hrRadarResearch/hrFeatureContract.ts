// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — feature contract `hr_features_v1` (PR 1).
//
// Two distinct shapes, deliberately kept separate (see shared/schema.ts
// hr_radar_evaluation_snapshots.raw_inputs vs .derived_features):
//
//   - Raw inputs (`hrRawInputEnvelopeSchema`): a preservation/audit log of
//     whatever the upstream feed actually returned, normalized but
//     undamaged. Deliberately loosely typed (per-family z.unknown()) since
//     over-typing it would defeat its own purpose — a future PR must be able
//     to fix a feature-builder bug and re-derive features from these
//     preserved raw inputs, without pretending historical live state can be
//     reconstructed from derived numbers alone.
//   - Derived features (`hrDerivedFeatureVectorV1Schema`): the versioned,
//     strictly-typed vector actually consumed by scoring. Every leaf is
//     `nullable()` and REQUIRED (never `.optional()`) — a missing input must
//     serialize as an explicit `null`, never a dropped key, which is what
//     makes downstream diffing/training-set assembly safe.
//
// Blocks A-G below mirror the source production plan's feature blocks
// (batter HR prior, live current form, current pitcher state, matchup,
// opportunity, environment, data quality). Each block schema types the
// leaves explicitly named in that plan and adds a `z.record(string,
// number|null)` escape hatch for future leaves without a schema migration.
//
// PR 1 scope: this file defines the contract only. No feature builder, no
// call site, no validation happens anywhere yet.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const HR_FEATURES_V1 = "hr_features_v1" as const;

// Independently-versioned raw-input envelope contract version (see
// hrRawInputEnvelopeSchema below) — distinct from HR_FEATURES_V1 so a
// feature-builder bug can be fixed and features re-derived from preserved
// raw inputs without bumping the derived-feature contract itself.
export const HR_RAW_INPUTS_V1 = "hr_raw_inputs_v1" as const;

const numericLeaf = z.number().nullable();
const extraLeaves = z.record(z.string(), z.number().nullable());

// ── Block A: batter HR prior (season/career baselines — no in-game data) ───
export const hrBatterPriorFeaturesSchema = z.object({
  hrRatePriorSeasonal: numericLeaf,
  hrRateCareer: numericLeaf,
  barrelRatePriorSeasonal: numericLeaf,
  hardHitRatePriorSeasonal: numericLeaf,
  pullRatePrior: numericLeaf,
  // PR 2 additions — approved HR-specific research plan, batter prior block.
  hardHitAirBallRatePriorSeasonal: numericLeaf,
  flyBallRatePrior: numericLeaf,
  hrPerFlyBallRatePrior: numericLeaf,
  xSlgPrior: numericLeaf,
  xIsoPrior: numericLeaf,
  sweetSpotRatePrior: numericLeaf,
  extra: extraLeaves,
});
export type HrBatterPriorFeatures = z.infer<typeof hrBatterPriorFeaturesSchema>;

// ── Block B: live current form (today's in-game contact evidence only) ─────
export const hrLiveFormFeaturesSchema = z.object({
  exitVeloTodayAvg: numericLeaf,
  barrelsToday: numericLeaf,
  hardHitRateToday: numericLeaf,
  recentFormStreakScore: numericLeaf,
  // PR 2 additions. The ordered non-HR BBE sequence itself is NOT a leaf here
  // — it is preserved verbatim in rawInputs.families.liveContactBBE; these
  // are aggregates derived from that sequence.
  maxExitVeloToday: numericLeaf,
  evLaInteractionScore: numericLeaf,
  estimatedHrQualityToday: numericLeaf,
  maxEstimatedHrQualityToday: numericLeaf,
  avgBattedBallDistanceToday: numericLeaf,
  parkAdjustedContactQualityToday: numericLeaf,
  sprayPullFactorToday: numericLeaf,
  recencyWeightedContactScore: numericLeaf,
  // Independent dangerous-contact count — one increment per BBE regardless of
  // how many measurements that BBE yields (see nearHrContact.ts detection).
  dangerousContactCountToday: z.number().int().nullable(),
  contactQualityDeltaVsPrior: numericLeaf,
  contactTrendSlope: numericLeaf,
  extra: extraLeaves,
});
export type HrLiveFormFeatures = z.infer<typeof hrLiveFormFeaturesSchema>;

// ── Block C: current pitcher state ──────────────────────────────────────────
export const hrPitcherStateFeaturesSchema = z.object({
  pitcherHrRateAllowedSeasonal: numericLeaf,
  pitcherFatigueScore: numericLeaf,
  pitchCountToday: numericLeaf,
  timesThroughOrder: numericLeaf,
  // PR 2 additions.
  battersFacedToday: z.number().int().nullable(),
  velocityTrendSlope: numericLeaf,
  velocityDropFromSeason: numericLeaf,
  pitchMixShiftScore: numericLeaf,
  dangerousAerialContactAllowedToday: z.number().int().nullable(),
  pitcherRemovalProbability: numericLeaf,
  extra: extraLeaves,
});
export type HrPitcherStateFeatures = z.infer<typeof hrPitcherStateFeaturesSchema>;

// ── Block D: matchup ─────────────────────────────────────────────────────────
export const hrMatchupFeaturesSchema = z.object({
  handednessSplitFactor: numericLeaf,
  platoonAdvantage: z.boolean().nullable(),
  // PR 2 additions.
  shrunkBatterVsHandHrRate: numericLeaf,
  shrunkPitcherVsHandHrRateAllowed: numericLeaf,
  pitchFamilyPowerFitScore: numericLeaf,
  arsenalProfileFitScore: numericLeaf,
  extra: extraLeaves,
});
export type HrMatchupFeatures = z.infer<typeof hrMatchupFeaturesSchema>;

// ── Block E: opportunity ────────────────────────────────────────────────────
export const hrOpportunityFeaturesSchema = z.object({
  battingOrderSlot: z.number().int().nullable(),
  remainingPaEstimate: z.number().int().nullable(),
  inning: z.number().int().nullable(),
  // PR 2 additions.
  lineupDistanceToNextPa: z.number().int().nullable(),
  remainingPaP25: z.number().int().nullable(),
  remainingPaP50: z.number().int().nullable(),
  remainingPaP75: z.number().int().nullable(),
  scoreDifferential: numericLeaf,
  substitutionRiskScore: numericLeaf,
  pitcherSurvivalUncertaintyScore: numericLeaf,
  extra: extraLeaves,
});
export type HrOpportunityFeatures = z.infer<typeof hrOpportunityFeaturesSchema>;

// ── Block F: environment ────────────────────────────────────────────────────
export const hrEnvironmentFeaturesSchema = z.object({
  windOutFactor: numericLeaf,
  temperatureF: numericLeaf,
  parkHrFactor: numericLeaf,
  roofState: z.enum(["open", "closed", "retractable_unknown", "na"]).nullable(),
  // PR 2 additions.
  handednessParkHrFactor: numericLeaf,
  wallDistanceFitScore: numericLeaf,
  windVectorDegrees: numericLeaf,
  windSpeedMph: numericLeaf,
  humidityPercent: numericLeaf,
  pressureHpa: numericLeaf,
  extra: extraLeaves,
});
export type HrEnvironmentFeatures = z.infer<typeof hrEnvironmentFeaturesSchema>;

// ── Block G: data quality (feature-vector-level summary) — no `extra`, this
// block IS the escape hatch's own accounting. ───────────────────────────────
export const hrDataQualityFeaturesSchema = z.object({
  missingInputs: z.array(z.string()),
  overallQuality: z.enum(["full", "degraded", "missing"]),
  // PR 2 additions.
  feedDegradationFlags: z.array(z.string()),
  identityConfidence: z.enum(["confirmed", "fuzzy_matched", "unresolved"]).nullable(),
});
export type HrDataQualityFeatures = z.infer<typeof hrDataQualityFeaturesSchema>;

// ── Block H (PR 2): ablation-only raw inputs. These fields receive NO
// predetermined positive weight — they are preserved for future ablation
// study only, deliberately kept out of the 7 scored blocks above so no
// weighted-scoring code can treat them as evidence. A static source-scan
// test (hrEvalCaptureNoChampionMutation.test.ts) asserts these field names
// never appear as identifiers in any champion scoring file. ───────────────
export const hrAblationOnlyInputsSchema = z.object({
  xBaSeasonal: numericLeaf,
  pitcherEraSeasonal: numericLeaf,
  rawBvpHrRate: numericLeaf,
  rawBvpPlateAppearances: z.number().int().nullable(),
  atBatsSinceLastHr: z.number().int().nullable(),
  seasonIbbRate: numericLeaf,
  genericHotLabel: z.string().nullable(),
  leverageIndex: numericLeaf,
  extra: extraLeaves,
});
export type HrAblationOnlyInputs = z.infer<typeof hrAblationOnlyInputsSchema>;

// ── Derived feature vector (validated against the `derived_features` jsonb column) ──
export const hrDerivedFeatureVectorV1Schema = z.object({
  featureVersion: z.literal(HR_FEATURES_V1),
  batterPrior: hrBatterPriorFeaturesSchema,
  liveForm: hrLiveFormFeaturesSchema,
  pitcherState: hrPitcherStateFeaturesSchema,
  matchup: hrMatchupFeaturesSchema,
  opportunity: hrOpportunityFeaturesSchema,
  environment: hrEnvironmentFeaturesSchema,
  dataQuality: hrDataQualityFeaturesSchema,
  ablationInputs: hrAblationOnlyInputsSchema,
});
export type HrDerivedFeatureVectorV1 = z.infer<typeof hrDerivedFeatureVectorV1Schema>;

// ── Per-leaf presence/quality mirror (validated against the `availability` jsonb column) ──
export const hrFeatureAvailabilityLeafSchema = z.object({
  present: z.boolean(),
  quality: z.enum(["full", "degraded", "missing"]),
});
export type HrFeatureAvailabilityLeaf = z.infer<typeof hrFeatureAvailabilityLeafSchema>;

export const hrFeatureAvailabilityVectorV1Schema = z.object({
  featureVersion: z.literal(HR_FEATURES_V1),
  batterPrior: z.record(z.string(), hrFeatureAvailabilityLeafSchema),
  liveForm: z.record(z.string(), hrFeatureAvailabilityLeafSchema),
  pitcherState: z.record(z.string(), hrFeatureAvailabilityLeafSchema),
  matchup: z.record(z.string(), hrFeatureAvailabilityLeafSchema),
  opportunity: z.record(z.string(), hrFeatureAvailabilityLeafSchema),
  environment: z.record(z.string(), hrFeatureAvailabilityLeafSchema),
});
export type HrFeatureAvailabilityVectorV1 = z.infer<typeof hrFeatureAvailabilityVectorV1Schema>;

// ── Raw input envelope (validated against the `raw_inputs` jsonb column) ───
// Deliberately permissive per family — see file header.
export const hrRawInputEnvelopeSchema = z.object({
  inputContractVersion: z.string().min(1),
  capturedAt: z.string(),
  families: z.record(z.string(), z.unknown()),
});
export type HrRawInputEnvelope = z.infer<typeof hrRawInputEnvelopeSchema>;

// ── Per-feature-family source/freshness (validated against the
// `feature_freshness` jsonb column) — distinct from `availability`, which is
// presence/quality, not recency.
export const hrFeatureFreshnessEntrySchema = z.object({
  sourceAt: z.string().nullable(),
  ageMs: z.number().nullable(),
  quality: z.enum(["full", "degraded", "missing"]),
});
export type HrFeatureFreshnessEntry = z.infer<typeof hrFeatureFreshnessEntrySchema>;

export const hrFeatureFreshnessVectorV1Schema = z.record(z.string(), hrFeatureFreshnessEntrySchema);
export type HrFeatureFreshnessVectorV1 = z.infer<typeof hrFeatureFreshnessVectorV1Schema>;
