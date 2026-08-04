// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — feature contract (PR 1).
//
// Two distinct shapes, deliberately kept separate (mirrors
// server/mlb/hrRadarResearch/hrFeatureContract.ts's split for the same reason):
//
//   - Raw inputs (`plateHrV2RawInputEnvelopeSchema`): a preservation/audit log
//     of whatever the upstream fetch actually returned, loosely typed
//     per-family. A future PR must be able to fix a feature-builder bug and
//     re-derive features from these preserved raw inputs.
//   - Derived features (`plateHrV2DerivedFeatureVectorV1Schema`): the
//     versioned, strictly-typed vector actually consumed downstream. Every
//     leaf is `.nullable()` and REQUIRED (never `.optional()`) — a missing
//     input serializes as an explicit `null`, never a dropped key.
//
// Shaped to mirror math/mathTypes.ts's `PregameMathInputs` groups field-for-
// field (batterPower, batTracking, pitcherVulnerability, pitchType,
// zoneLocation, parkWeatherSpray, lineupOpportunity, starterBullpen, market,
// availability), plus one new `contactOpportunity` group the spec asks for
// that math/ does not yet have a slot for, and a `dataQuality` summary block.
//
// PR 1 scope: this file defines the contract only. No feature builder call
// site exists here — see plateHrV2FeatureBuilder.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const PLATE_HR_V2_FEATURES_V1 = "plate_hr_v2_features_v1" as const;
// V2 (PR5) adds the `recentContactForm` group. V1 is PRESERVED unchanged so
// historical V1 snapshots still parse; a single feature version never represents
// two shapes. New snapshots are written as PLATE_HR_V2_FEATURES_CURRENT (= V2).
export const PLATE_HR_V2_FEATURES_V2 = "plate_hr_v2_features_v2" as const;
export const PLATE_HR_V2_FEATURES_CURRENT = PLATE_HR_V2_FEATURES_V2;

// Independently-versioned raw-input envelope contract version — distinct from
// PLATE_HR_V2_FEATURES_V1 so a feature-builder bug can be fixed and features
// re-derived from preserved raw inputs without bumping the derived contract.
export const PLATE_HR_V2_RAW_INPUTS_V1 = "plate_hr_v2_raw_inputs_v1" as const;

const numericLeaf = z.number().nullable();
const extraLeaves = z.record(z.string(), z.number().nullable());
const handednessSchema = z.enum(["L", "R", "S"]).nullable();

// ── A. Batter true-power skill ──────────────────────────────────────────────
export const plateHrV2BatterPowerFeaturesSchema = z.object({
  xISO: numericLeaf,
  xSLG: numericLeaf,
  xwOBAcon: numericLeaf,
  barrelRatePct: numericLeaf,
  hardHitRatePct: numericLeaf,
  exitVelocity: numericLeaf,
  maxEV: numericLeaf,
  flyBallPct: numericLeaf,
  hrFBRatioPct: numericLeaf,
  pullRatePct: numericLeaf,
  sweetSpotPct: numericLeaf,
  hrPerPaSeason: numericLeaf,
  paSample: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2BatterPowerFeatures = z.infer<typeof plateHrV2BatterPowerFeaturesSchema>;

// ── B. Bat-tracking / swing-quality skill ───────────────────────────────────
export const plateHrV2BatTrackingFeaturesSchema = z.object({
  avgBatSpeed: numericLeaf,
  fastSwingRatePct: numericLeaf,
  avgSwingLength: numericLeaf,
  avgAttackAngle: numericLeaf,
  idealAttackAngleRatePct: numericLeaf,
  attackAngleStdDev: numericLeaf,
  avgSwingPathTilt: numericLeaf,
  squaredUpPerSwingPct: numericLeaf,
  blastPerSwingPct: numericLeaf,
  swingSample: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2BatTrackingFeatures = z.infer<typeof plateHrV2BatTrackingFeaturesSchema>;

// ── E. Pitcher HR vulnerability ──────────────────────────────────────────────
export const plateHrV2PitcherVulnerabilityFeaturesSchema = z.object({
  pitcherKnown: z.boolean(),
  batterHand: handednessSchema,
  pitcherThrows: z.enum(["L", "R"]).nullable(),
  hrPer9VsHand: numericLeaf,
  hrPer9Overall: numericLeaf,
  barrelAllowedPct: numericLeaf,
  hardHitAllowedPct: numericLeaf,
  flyBallAllowedPct: numericLeaf,
  bfSample: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2PitcherVulnerabilityFeatures = z.infer<typeof plateHrV2PitcherVulnerabilityFeaturesSchema>;

// ── C/F. Pitch-type interaction ──────────────────────────────────────────────
// Reprojected from math/'s array-of-3 (PitchFamilyDatum[]) into fixed named
// keys, since math/'s own `family` enum is already closed to exactly these
// three values — see the plan's deviation (d). Each leaf carries
// `batterSampleSwings`, closing the confirmed gap in
// pitchFamilyMatchup.ts:34-37 ("Current BatterPitchSplit does not preserve
// its own denominator") — the swing count needed to shrink `batterXslg` is
// already computed and discarded inside dataSources.ts's
// aggregateBatterPitchAndContact; this contract just requires it be returned.
const pitchFamilyLeafSchema = z.object({
  usageShare: numericLeaf,
  batterXslg: numericLeaf,
  batterWhiffPct: numericLeaf,
  // PR4.1: grain-typed denominators. `batterDamageBbeSample` (BBE) shrinks the
  // xSLG damage split; `batterWhiffSwingSample` (swings) shrinks whiff%. Kept
  // separate so a BBE count is never used as a swing count. `batterSampleSwings`
  // is retained (deprecated) and now carries the swing sample to match its name.
  batterSampleSwings: numericLeaf,
  batterDamageBbeSample: numericLeaf,
  batterWhiffSwingSample: numericLeaf,
});
export const plateHrV2PitchTypeFeaturesSchema = z.object({
  fastball: pitchFamilyLeafSchema,
  breaking: pitchFamilyLeafSchema,
  offspeed: pitchFamilyLeafSchema,
  extra: extraLeaves,
});
export type PlateHrV2PitchTypeFeatures = z.infer<typeof plateHrV2PitchTypeFeaturesSchema>;

// ── D. Zone / location interaction ──────────────────────────────────────────
export const plateHrV2ZoneLocationFeaturesSchema = z.object({
  batterHeartXslg: numericLeaf,
  batterElevatedFbXslg: numericLeaf,
  batterLowBreakingXslg: numericLeaf,
  pitcherHeartRate: numericLeaf,
  pitcherMiddleMiddleRate: numericLeaf,
  pitcherHangerRate: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2ZoneLocationFeatures = z.infer<typeof plateHrV2ZoneLocationFeaturesSchema>;

// ── I/J. Park + weather + spray + fence geometry ────────────────────────────
export const plateHrV2ParkWeatherSprayFeaturesSchema = z.object({
  parkHrFactor: numericLeaf,
  parkHrFactorHand: numericLeaf,
  isIndoors: z.boolean(),
  weatherAvailable: z.boolean(),
  temperatureF: numericLeaf,
  windSpeedMph: numericLeaf,
  windDirection: z.enum(["in", "out", "cross", "calm"]).nullable(),
  batterPullAirShare: numericLeaf,
  pullFenceDistanceFt: numericLeaf,
  pullFenceHeightFt: numericLeaf,
  avgFenceDistanceFt: numericLeaf,
  avgFenceHeightFt: numericLeaf,
  avgHrDistanceFt: numericLeaf,
  extra: extraLeaves, // PR3 weather-physics/xHR extension point — no named fields invented ahead of math/ itself having them
});
export type PlateHrV2ParkWeatherSprayFeatures = z.infer<typeof plateHrV2ParkWeatherSprayFeaturesSchema>;

// ── K. Lineup / opportunity / volume ────────────────────────────────────────
export const plateHrV2LineupOpportunityFeaturesSchema = z.object({
  battingOrderSlot: z.number().int().nullable(),
  teamImpliedRuns: numericLeaf,
  obpAhead: numericLeaf,
  lineupConfirmed: z.boolean(),
  extra: extraLeaves,
});
export type PlateHrV2LineupOpportunityFeatures = z.infer<typeof plateHrV2LineupOpportunityFeaturesSchema>;

// ── L/M. Starter exposure + bullpen path ────────────────────────────────────
export const plateHrV2StarterBullpenFeaturesSchema = z.object({
  starterConfirmed: z.boolean(),
  projectedPaVsStarter: numericLeaf,
  projectedPaVsBullpen: numericLeaf,
  bullpenHrPer9: numericLeaf,
  bullpenBarrelAllowedPct: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2StarterBullpenFeatures = z.infer<typeof plateHrV2StarterBullpenFeaturesSchema>;

// ── O. Market confirmation — confirm/rank only, never creates a candidate ───
export const plateHrV2MarketFeaturesSchema = z.object({
  hrOddsAvailable: z.boolean(),
  impliedHrProbability: numericLeaf,
  noVigImpliedHrProbability: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2MarketFeatures = z.infer<typeof plateHrV2MarketFeaturesSchema>;

// ── P. Availability suppressors ──────────────────────────────────────────────
export const plateHrV2AvailabilityFeaturesSchema = z.object({
  confirmedActive: z.boolean().nullable(),
  lateScratchRisk: z.boolean().nullable(),
  restDayRisk: z.boolean().nullable(),
  platoonSubRisk: z.boolean().nullable(),
  extra: extraLeaves,
});
export type PlateHrV2AvailabilityFeatures = z.infer<typeof plateHrV2AvailabilityFeaturesSchema>;

// ── NEW group (PR1 addition, absent from math/'s PregameMathInputs today) ──
// The explicit home for K%/BB%/whiff%/contact%/zone-contact%/chase% — distinct
// from math/'s inert `PitchFamilyDatum.batterWhiffPct` (declared but never
// read by any scorer). Always all-null in PR1; PR3 wires a real producer.
export const plateHrV2ContactOpportunityFeaturesSchema = z.object({
  kRatePct: numericLeaf,
  bbRatePct: numericLeaf,
  whiffRatePct: numericLeaf,
  contactRatePct: numericLeaf,
  zoneContactRatePct: numericLeaf,
  chaseRatePct: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2ContactOpportunityFeatures = z.infer<typeof plateHrV2ContactOpportunityFeaturesSchema>;

// ── NEW group (PR5 addition) — stabilized recent-contact form. Additive/shadow:
// no scorer reads it yet (PR6 wires one). Computed from the real `contact_events`
// per-BBE stream (EV EWMA, EV90, air%, barrel%) reliability-blended with a season
// baseline; recentFormPulledAirShare is season-only and recentFormXHrPerContact is
// always null (no per-event spray/xSLG stream exists). Recent HR count can never
// contribute. All-null when absent. ──────────────────────────────────────────────
export const plateHrV2RecentContactFormFeaturesSchema = z.object({
  recentFormEv: numericLeaf,
  recentFormEv90: numericLeaf,
  recentFormAirBallPct: numericLeaf,
  recentFormBarrelPct: numericLeaf,
  recentFormPulledAirShare: numericLeaf,
  recentFormXHrPerContact: numericLeaf,
  effectiveBbe: numericLeaf,
  last15Bbe: numericLeaf,
  reliabilityWeight: numericLeaf,
  extra: extraLeaves,
});
export type PlateHrV2RecentContactFormFeatures = z.infer<typeof plateHrV2RecentContactFormFeaturesSchema>;

// ── Data quality (feature-vector-level summary) — no `extra`, this block IS
// the escape hatch's own accounting. ────────────────────────────────────────
export const plateHrV2DataQualityFeaturesSchema = z.object({
  savantQuality: z.enum(["full", "fallback", "missing"]),
  venueResolved: z.boolean(),
  pitcherHandResolved: z.boolean(),
  batterPowerFullyAvailable: z.boolean(),
  missingInputs: z.array(z.string()),
  overallQuality: z.enum(["full", "degraded", "missing"]),
});
export type PlateHrV2DataQualityFeatures = z.infer<typeof plateHrV2DataQualityFeaturesSchema>;

// ── Derived feature vector (validated against the `derived_features` jsonb
// column) ────────────────────────────────────────────────────────────────────
export const plateHrV2DerivedFeatureVectorV1Schema = z.object({
  featureVersion: z.literal(PLATE_HR_V2_FEATURES_V1),
  batterPower: plateHrV2BatterPowerFeaturesSchema,
  batTracking: plateHrV2BatTrackingFeaturesSchema,
  pitcherVulnerability: plateHrV2PitcherVulnerabilityFeaturesSchema,
  pitchType: plateHrV2PitchTypeFeaturesSchema,
  zoneLocation: plateHrV2ZoneLocationFeaturesSchema,
  parkWeatherSpray: plateHrV2ParkWeatherSprayFeaturesSchema,
  lineupOpportunity: plateHrV2LineupOpportunityFeaturesSchema,
  starterBullpen: plateHrV2StarterBullpenFeaturesSchema,
  market: plateHrV2MarketFeaturesSchema,
  availability: plateHrV2AvailabilityFeaturesSchema,
  contactOpportunity: plateHrV2ContactOpportunityFeaturesSchema,
  dataQuality: plateHrV2DataQualityFeaturesSchema,
  slateBaselineGameHrProbability: numericLeaf,
});
export type PlateHrV2DerivedFeatureVectorV1 = z.infer<typeof plateHrV2DerivedFeatureVectorV1Schema>;

// ── V2 derived vector = V1 + recentContactForm (PR5). A distinct featureVersion
// literal so the two shapes never collide. ────────────────────────────────────
export const plateHrV2DerivedFeatureVectorV2Schema = plateHrV2DerivedFeatureVectorV1Schema.extend({
  featureVersion: z.literal(PLATE_HR_V2_FEATURES_V2),
  recentContactForm: plateHrV2RecentContactFormFeaturesSchema,
});
export type PlateHrV2DerivedFeatureVectorV2 = z.infer<typeof plateHrV2DerivedFeatureVectorV2Schema>;

/** Accepts either version, discriminated on featureVersion — the reader for a
 * heterogeneous store of historical (V1) + current (V2) snapshots. */
export const plateHrV2DerivedFeatureVectorAnySchema = z.discriminatedUnion("featureVersion", [
  plateHrV2DerivedFeatureVectorV1Schema,
  plateHrV2DerivedFeatureVectorV2Schema,
]);
export type PlateHrV2DerivedFeatureVectorAny = z.infer<typeof plateHrV2DerivedFeatureVectorAnySchema>;

// ── Per-leaf presence/quality mirror (validated against the `availability`
// jsonb column) ──────────────────────────────────────────────────────────────
export const plateHrV2FeatureAvailabilityLeafSchema = z.object({
  present: z.boolean(),
  quality: z.enum(["full", "degraded", "missing"]),
});
export type PlateHrV2FeatureAvailabilityLeaf = z.infer<typeof plateHrV2FeatureAvailabilityLeafSchema>;

export const plateHrV2FeatureAvailabilityVectorV1Schema = z.object({
  featureVersion: z.literal(PLATE_HR_V2_FEATURES_V1),
  batterPower: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  batTracking: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  pitcherVulnerability: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  pitchType: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  zoneLocation: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  parkWeatherSpray: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  lineupOpportunity: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  starterBullpen: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  market: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  availability: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
  contactOpportunity: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
});
export type PlateHrV2FeatureAvailabilityVectorV1 = z.infer<typeof plateHrV2FeatureAvailabilityVectorV1Schema>;

// ── V2 availability = V1 + recentContactForm (PR5). ───────────────────────────
export const plateHrV2FeatureAvailabilityVectorV2Schema = plateHrV2FeatureAvailabilityVectorV1Schema.extend({
  featureVersion: z.literal(PLATE_HR_V2_FEATURES_V2),
  recentContactForm: z.record(z.string(), plateHrV2FeatureAvailabilityLeafSchema),
});
export type PlateHrV2FeatureAvailabilityVectorV2 = z.infer<typeof plateHrV2FeatureAvailabilityVectorV2Schema>;

/** Guard: a single training artifact must not mix feature versions. Returns the
 * common version, or an error listing the distinct versions seen. */
export function resolveSingleFeatureVersion(
  versions: readonly string[],
): { ok: true; version: string } | { ok: false; versions: string[] } {
  const distinct = Array.from(new Set(versions));
  if (distinct.length === 1) return { ok: true, version: distinct[0] };
  return { ok: false, versions: distinct };
}

// ── Per-feature-family source/freshness (validated against the
// `feature_freshness` jsonb column) — distinct from `availability`, which is
// presence/quality, not recency. ────────────────────────────────────────────
export const plateHrV2FeatureFreshnessEntrySchema = z.object({
  sourceAt: z.string().nullable(),
  ageMs: z.number().nullable(),
  quality: z.enum(["full", "degraded", "missing"]),
});
export type PlateHrV2FeatureFreshnessEntry = z.infer<typeof plateHrV2FeatureFreshnessEntrySchema>;

export const plateHrV2FeatureFreshnessVectorV1Schema = z.record(z.string(), plateHrV2FeatureFreshnessEntrySchema);
export type PlateHrV2FeatureFreshnessVectorV1 = z.infer<typeof plateHrV2FeatureFreshnessVectorV1Schema>;

// ── Raw input envelope (validated against the `raw_inputs` jsonb column) ───
// Deliberately permissive per family — see file header. This is where the
// sufficient-statistics payload (plateHrV2SufficientStats.ts) is preserved
// verbatim alongside whatever else the fetchers returned, so a future PR can
// re-derive a new feature version from evidence, not just from today's
// aggregates.
export const plateHrV2RawInputEnvelopeSchema = z.object({
  inputContractVersion: z.string().min(1),
  capturedAt: z.string(),
  families: z.record(z.string(), z.unknown()),
});
export type PlateHrV2RawInputEnvelope = z.infer<typeof plateHrV2RawInputEnvelopeSchema>;
