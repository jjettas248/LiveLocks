// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — as-of-date feature builder (PR 1).
//
// Pure (no I/O, no Date.now()/new Date() internally — every timestamp is
// caller-supplied) assembly of a PlateHrV2DerivedFeatureVectorV1-shaped
// snapshot from already-resolved source values. Mirrors
// server/mlb/hrRadarResearch/hrFeatureBuilder.ts's "no I/O, everything
// timestamp-driven by caller-supplied values" shape.
//
// Boundary enforcement calls math/leakageGuard.ts's existing, tested
// isPredictionBeforeFirstPitch/buildLeakageWarnings directly (zero
// reimplementation) — never throws, matching leakageGuard.ts's own
// degrade-to-warnings design. The forward-capture hook (plateHrV2ForwardCapture.ts)
// only calls this for firstPitchLockEligible candidates, so a
// `boundaryOk === false` result in production is itself worth alerting on.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  BatterTruePowerInputs,
  BatTrackingInputs,
  PitcherVulnerabilityInputs,
  PitchTypeInteractionInputs,
  ZoneLocationInputs,
  ParkWeatherSprayInputs,
  LineupOpportunityInputs,
  StarterBullpenPathInputs,
  MarketConfirmationInputs,
  AvailabilitySuppressorInputs,
  Handedness,
  FeatureProvenance,
} from "../math/mathTypes";
import { isPredictionBeforeFirstPitch, buildLeakageWarnings } from "../math/leakageGuard";
import type { ContactOpportunityInputs } from "./frozenPlateHrV2Input";
import {
  PLATE_HR_V2_FEATURES_V1,
  PLATE_HR_V2_RAW_INPUTS_V1,
  type PlateHrV2DerivedFeatureVectorV1,
  type PlateHrV2FeatureAvailabilityVectorV1,
  type PlateHrV2FeatureFreshnessVectorV1,
  type PlateHrV2RawInputEnvelope,
} from "./plateHrV2FeatureContract";

export interface PlateHrV2SourceMeta {
  fetchedAtMs: number | null;
}

type AvailabilityLeaf = { present: boolean; quality: "full" | "degraded" | "missing" };
type AvailabilityRecord = Record<string, AvailabilityLeaf>;

export interface PlateHrV2FeatureBuilderInput {
  // ── leakage boundary — caller-supplied, never computed internally ────────
  asOfMs: number;
  firstPitchAtMs: number | null;
  // ── canonical-training-observation fields (correction 3) ─────────────────
  lineupConfirmedAtMs: number | null;
  starterConfirmed: boolean;
  // ── identity ───────────────────────────────────────────────────────────
  sessionDate: string;
  gameId: string;
  batterId: string;
  pitcherId: string | null;
  batterHand: Handedness;
  // ── pointer into plate_hr_v2_sufficient_stats, never a copy (correction 2) ─
  sufficientStatsRef: string | null;
  // ── the 10 PregameMathInputs groups + PR1's contactOpportunity slot ──────
  batterPower: BatterTruePowerInputs;
  batTracking: BatTrackingInputs;
  pitcherVulnerability: PitcherVulnerabilityInputs;
  pitchType: PitchTypeInteractionInputs;
  zoneLocation: ZoneLocationInputs;
  parkWeatherSpray: ParkWeatherSprayInputs;
  lineupOpportunity: LineupOpportunityInputs;
  starterBullpen: StarterBullpenPathInputs;
  market: MarketConfirmationInputs;
  availability: AvailabilitySuppressorInputs;
  contactOpportunity: ContactOpportunityInputs;
  slateBaselineGameHrProbability: number | null;
  // ── per-family source freshness ───────────────────────────────────────
  batterPowerMeta?: PlateHrV2SourceMeta;
  batTrackingMeta?: PlateHrV2SourceMeta;
  pitcherVulnerabilityMeta?: PlateHrV2SourceMeta;
  pitchTypeMeta?: PlateHrV2SourceMeta;
  parkWeatherSprayMeta?: PlateHrV2SourceMeta;
  lineupOpportunityMeta?: PlateHrV2SourceMeta;
  // ── data-quality summary inputs ───────────────────────────────────────
  savantQuality: "full" | "fallback" | "missing";
  venueResolved: boolean;
  pitcherHandResolved: boolean;
  batterPowerFullyAvailable: boolean;
}

export interface PlateHrV2FeatureBuilderResult {
  derivedFeatures: PlateHrV2DerivedFeatureVectorV1;
  availability: PlateHrV2FeatureAvailabilityVectorV1;
  featureFreshness: PlateHrV2FeatureFreshnessVectorV1;
  rawInputs: PlateHrV2RawInputEnvelope;
  boundaryOk: boolean;
  leakageWarnings: string[];
}

/** Per-leaf presence sweep — `present` iff the value isn't null/undefined; `extra` is its own escape hatch, not enumerated. */
function leafAvailability(group: Record<string, unknown>): AvailabilityRecord {
  const result: AvailabilityRecord = {};
  for (const [key, value] of Object.entries(group)) {
    if (key === "extra") continue;
    const present = value !== null && value !== undefined;
    result[key] = { present, quality: present ? "full" : "missing" };
  }
  return result;
}

type PitchFamilyLeaves = {
  usageShare: number | null;
  batterXslg: number | null;
  batterWhiffPct: number | null;
  batterSampleSwings: number | null;
};

/**
 * pitchType is the one nested (2-level) group: fastball/breaking/offspeed are
 * always non-null wrapper objects (see batterPitchType below), so the plain
 * shallow leafAvailability() sweep would report every family "present" just
 * because the wrapper exists, even when every scalar inside it is null.
 * Flatten to per-scalar leaves ("fastball.usageShare", etc.) instead.
 */
function pitchTypeAvailability(batterPitchType: Record<"fastball" | "breaking" | "offspeed", PitchFamilyLeaves>): AvailabilityRecord {
  const result: AvailabilityRecord = {};
  for (const family of ["fastball", "breaking", "offspeed"] as const) {
    for (const [leaf, value] of Object.entries(batterPitchType[family])) {
      const present = value !== null && value !== undefined;
      result[`${family}.${leaf}`] = { present, quality: present ? "full" : "missing" };
    }
  }
  return result;
}

function freshnessEntry(asOfMs: number, meta: PlateHrV2SourceMeta | undefined, present: boolean) {
  const sourceAt = meta?.fetchedAtMs != null ? new Date(meta.fetchedAtMs).toISOString() : null;
  const ageMs = meta?.fetchedAtMs != null ? Math.max(0, asOfMs - meta.fetchedAtMs) : null;
  return { sourceAt, ageMs, quality: present ? ("full" as const) : ("missing" as const) };
}

function toProvenance(groupName: string, group: Record<string, unknown>, phase: FeatureProvenance["phase"], valueTimestampISO: string | null): FeatureProvenance[] {
  const out: FeatureProvenance[] = [];
  for (const [key, value] of Object.entries(group)) {
    if (key === "extra" || value === null || value === undefined) continue;
    out.push({ name: `${groupName}.${key}`, phase, valueTimestamp: valueTimestampISO });
  }
  return out;
}

/**
 * Assemble a Plate HR V2 feature snapshot from already-resolved,
 * caller-supplied source values. Pure, total — never throws.
 */
export function assemblePlateHrV2FeatureSnapshot(
  input: PlateHrV2FeatureBuilderInput,
): PlateHrV2FeatureBuilderResult {
  const asOfIso = new Date(input.asOfMs).toISOString();
  const firstPitchIso = input.firstPitchAtMs != null ? new Date(input.firstPitchAtMs).toISOString() : null;

  const batterPitchType = {
    fastball: {
      usageShare: input.pitchType.families.find((f) => f.family === "fastball")?.usageShare ?? null,
      batterXslg: input.pitchType.families.find((f) => f.family === "fastball")?.batterXslg ?? null,
      batterWhiffPct: input.pitchType.families.find((f) => f.family === "fastball")?.batterWhiffPct ?? null,
      batterSampleSwings: input.pitchType.families.find((f) => f.family === "fastball")?.batterSample ?? null,
    },
    breaking: {
      usageShare: input.pitchType.families.find((f) => f.family === "breaking")?.usageShare ?? null,
      batterXslg: input.pitchType.families.find((f) => f.family === "breaking")?.batterXslg ?? null,
      batterWhiffPct: input.pitchType.families.find((f) => f.family === "breaking")?.batterWhiffPct ?? null,
      batterSampleSwings: input.pitchType.families.find((f) => f.family === "breaking")?.batterSample ?? null,
    },
    offspeed: {
      usageShare: input.pitchType.families.find((f) => f.family === "offspeed")?.usageShare ?? null,
      batterXslg: input.pitchType.families.find((f) => f.family === "offspeed")?.batterXslg ?? null,
      batterWhiffPct: input.pitchType.families.find((f) => f.family === "offspeed")?.batterWhiffPct ?? null,
      batterSampleSwings: input.pitchType.families.find((f) => f.family === "offspeed")?.batterSample ?? null,
    },
    extra: {},
  };

  const overallQuality: "full" | "degraded" | "missing" =
    input.savantQuality === "missing"
      ? "missing"
      : input.savantQuality === "full" && input.venueResolved && input.pitcherHandResolved && input.batterPowerFullyAvailable
        ? "full"
        : "degraded";

  const missingInputs: string[] = [];
  if (!input.batterPowerFullyAvailable) missingInputs.push("batterPower");
  if (!input.venueResolved) missingInputs.push("parkWeatherSpray.venue");
  if (!input.pitcherHandResolved) missingInputs.push("pitcherVulnerability.hand");

  const derivedFeatures: PlateHrV2DerivedFeatureVectorV1 = {
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    batterPower: { ...input.batterPower, extra: {} },
    // math/'s BatTrackingInputs marks 4 leaves optional (`avgAttackAngle?`
    // etc.) rather than nullable-required, so a plain spread would leak
    // `undefined` into a contract that requires `number | null` — coalesce
    // explicitly instead of spreading.
    batTracking: {
      avgBatSpeed: input.batTracking.avgBatSpeed,
      fastSwingRatePct: input.batTracking.fastSwingRatePct,
      avgSwingLength: input.batTracking.avgSwingLength,
      avgAttackAngle: input.batTracking.avgAttackAngle ?? null,
      idealAttackAngleRatePct: input.batTracking.idealAttackAngleRatePct ?? null,
      attackAngleStdDev: input.batTracking.attackAngleStdDev ?? null,
      avgSwingPathTilt: input.batTracking.avgSwingPathTilt ?? null,
      squaredUpPerSwingPct: input.batTracking.squaredUpPerSwingPct,
      blastPerSwingPct: input.batTracking.blastPerSwingPct,
      swingSample: input.batTracking.swingSample,
      extra: {},
    },
    pitcherVulnerability: { ...input.pitcherVulnerability, extra: {} },
    pitchType: batterPitchType,
    zoneLocation: { ...input.zoneLocation, extra: {} },
    // Same optional-vs-required-nullable mismatch as batTracking above for
    // math/'s ParkWeatherSprayInputs (5 optional fence-geometry leaves).
    parkWeatherSpray: {
      parkHrFactor: input.parkWeatherSpray.parkHrFactor,
      parkHrFactorHand: input.parkWeatherSpray.parkHrFactorHand,
      isIndoors: input.parkWeatherSpray.isIndoors,
      weatherAvailable: input.parkWeatherSpray.weatherAvailable,
      temperatureF: input.parkWeatherSpray.temperatureF,
      windSpeedMph: input.parkWeatherSpray.windSpeedMph,
      windDirection: input.parkWeatherSpray.windDirection,
      batterPullAirShare: input.parkWeatherSpray.batterPullAirShare,
      pullFenceDistanceFt: input.parkWeatherSpray.pullFenceDistanceFt ?? null,
      pullFenceHeightFt: input.parkWeatherSpray.pullFenceHeightFt ?? null,
      avgFenceDistanceFt: input.parkWeatherSpray.avgFenceDistanceFt ?? null,
      avgFenceHeightFt: input.parkWeatherSpray.avgFenceHeightFt ?? null,
      avgHrDistanceFt: input.parkWeatherSpray.avgHrDistanceFt ?? null,
      extra: {},
    },
    lineupOpportunity: { ...input.lineupOpportunity, extra: {} },
    starterBullpen: { ...input.starterBullpen, extra: {} },
    market: { ...input.market, extra: {} },
    availability: { ...input.availability, extra: {} },
    contactOpportunity: { ...input.contactOpportunity, extra: {} },
    dataQuality: {
      savantQuality: input.savantQuality,
      venueResolved: input.venueResolved,
      pitcherHandResolved: input.pitcherHandResolved,
      batterPowerFullyAvailable: input.batterPowerFullyAvailable,
      missingInputs,
      overallQuality,
    },
    slateBaselineGameHrProbability: input.slateBaselineGameHrProbability,
  };

  const availability: PlateHrV2FeatureAvailabilityVectorV1 = {
    featureVersion: PLATE_HR_V2_FEATURES_V1,
    batterPower: leafAvailability(input.batterPower as unknown as Record<string, unknown>),
    batTracking: leafAvailability(input.batTracking as unknown as Record<string, unknown>),
    pitcherVulnerability: leafAvailability(input.pitcherVulnerability as unknown as Record<string, unknown>),
    pitchType: pitchTypeAvailability(batterPitchType),
    zoneLocation: leafAvailability(input.zoneLocation as unknown as Record<string, unknown>),
    parkWeatherSpray: leafAvailability(input.parkWeatherSpray as unknown as Record<string, unknown>),
    lineupOpportunity: leafAvailability(input.lineupOpportunity as unknown as Record<string, unknown>),
    starterBullpen: leafAvailability(input.starterBullpen as unknown as Record<string, unknown>),
    market: leafAvailability(input.market as unknown as Record<string, unknown>),
    availability: leafAvailability(input.availability as unknown as Record<string, unknown>),
    contactOpportunity: leafAvailability(input.contactOpportunity as unknown as Record<string, unknown>),
  };

  const featureFreshness: PlateHrV2FeatureFreshnessVectorV1 = {
    batterPower: freshnessEntry(input.asOfMs, input.batterPowerMeta, input.batterPowerFullyAvailable),
    batTracking: freshnessEntry(input.asOfMs, input.batTrackingMeta, input.batTracking.avgBatSpeed != null),
    pitcherVulnerability: freshnessEntry(input.asOfMs, input.pitcherVulnerabilityMeta, input.pitcherHandResolved),
    pitchType: freshnessEntry(input.asOfMs, input.pitchTypeMeta, input.pitchType.families.length > 0),
    parkWeatherSpray: freshnessEntry(input.asOfMs, input.parkWeatherSprayMeta, input.venueResolved),
    lineupOpportunity: freshnessEntry(input.asOfMs, input.lineupOpportunityMeta, input.lineupOpportunity.lineupConfirmed),
  };

  const rawInputs: PlateHrV2RawInputEnvelope = {
    inputContractVersion: PLATE_HR_V2_RAW_INPUTS_V1,
    capturedAt: asOfIso,
    families: {
      batterPower: input.batterPower,
      batTracking: input.batTracking,
      pitcherVulnerability: input.pitcherVulnerability,
      pitchType: input.pitchType,
      zoneLocation: input.zoneLocation,
      parkWeatherSpray: input.parkWeatherSpray,
      lineupOpportunity: input.lineupOpportunity,
      starterBullpen: input.starterBullpen,
      market: input.market,
      availability: input.availability,
      contactOpportunity: input.contactOpportunity,
      sufficientStatsRef: input.sufficientStatsRef,
    },
  };

  const provenance: FeatureProvenance[] = [
    ...toProvenance("batterPower", input.batterPower as unknown as Record<string, unknown>, "season", asOfIso),
    ...toProvenance("batTracking", input.batTracking as unknown as Record<string, unknown>, "season", asOfIso),
    ...toProvenance("pitcherVulnerability", input.pitcherVulnerability as unknown as Record<string, unknown>, "season", asOfIso),
    ...toProvenance("zoneLocation", input.zoneLocation as unknown as Record<string, unknown>, "season", asOfIso),
    ...toProvenance("parkWeatherSpray", input.parkWeatherSpray as unknown as Record<string, unknown>, "pregame", asOfIso),
    ...toProvenance("lineupOpportunity", input.lineupOpportunity as unknown as Record<string, unknown>, "pregame", asOfIso),
    ...toProvenance("starterBullpen", input.starterBullpen as unknown as Record<string, unknown>, "pregame", asOfIso),
    ...toProvenance("market", input.market as unknown as Record<string, unknown>, "pregame", asOfIso),
    ...toProvenance("availability", input.availability as unknown as Record<string, unknown>, "pregame", asOfIso),
    ...toProvenance("contactOpportunity", input.contactOpportunity as unknown as Record<string, unknown>, "pregame", asOfIso),
  ];

  const boundaryOk = isPredictionBeforeFirstPitch(asOfIso, firstPitchIso);
  const leakageWarnings = buildLeakageWarnings({
    predictionGeneratedAtISO: asOfIso,
    firstPitchTimeISO: firstPitchIso,
    features: provenance,
  });

  return { derivedFeatures, availability, featureFreshness, rawInputs, boundaryOk, leakageWarnings };
}
