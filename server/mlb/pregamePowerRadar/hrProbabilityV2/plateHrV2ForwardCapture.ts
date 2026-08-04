// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — forward feature capture orchestrator (PR 1).
//
// The one function buildPregamePowerRadar.ts calls per-candidate: checks the
// capture flag, builds the frozen input, freezes + hashes it, runs the
// as-of-date builder, and shapes the row a later sink persists. No try/catch
// inside — the call site wraps it, matching how the existing
// shadow-challenger block in buildPregamePowerRadar.ts is wrapped by its
// caller rather than wrapping itself.
//
// Also owns the capture-sink registration (mirrors buildPregamePowerRadar.ts's
// own PregameBuildSink/buildSink/setPregameBuildSink pattern, kept in this
// new file rather than duplicated inline so buildPregamePowerRadar.ts's own
// diff stays to a tap block + one array + one flush call).
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
} from "../math/mathTypes";
import {
  freezePlateHrV2Input,
  hashFrozenPlateHrV2Input,
  type ContactOpportunityInputs,
  type FrozenPlateHrV2Input,
} from "./frozenPlateHrV2Input";
import {
  assemblePlateHrV2FeatureSnapshot,
  type PlateHrV2SourceMeta,
} from "./plateHrV2FeatureBuilder";
import { PLATE_HR_V2_FEATURES_CURRENT } from "./plateHrV2FeatureContract";
import type { PlateHrV2EvidenceDescriptor } from "./plateHrV2Snapshots";
import { isPlateHrV2ForwardCaptureEnabled } from "./plateHrV2CaptureFlags";
import type { PlateHrV2DerivedFeatureVectorV2, PlateHrV2FeatureAvailabilityVectorV2, PlateHrV2FeatureFreshnessVectorV1, PlateHrV2RawInputEnvelope } from "./plateHrV2FeatureContract";
import type { RecentContactFormInputs } from "./recentContactForm";
import type { PlateHrV2SufficientStatsRaw } from "./plateHrV2SufficientStats";

export interface PlateHrV2CaptureRow {
  snapshotId: string;
  sessionDate: string;
  gameId: string;
  /** Real MLB Stats gamePk (distinct from the ESPN `gameId`), used as the
   * append-only prediction snapshot key so MLB outcome/status joins line up. */
  gamePk: string | null;
  /** Real per-provider/entity evidence descriptors assembled at the fetch site. */
  evidence: PlateHrV2EvidenceDescriptor[];
  batterId: string;
  batterName: string;
  team: string;
  opponent: string;
  pitcherId: string | null;
  pitcherName: string | null;
  battingOrderSlot: number | null;
  buildId: string;
  firstCapturedAtIso: string;
  lastCapturedAtIso: string;
  firstPitchTimeIso: string | null;
  firstPitchLockEligible: boolean;
  gameStatus: string;
  // Correction 3 — the canonical-training-observation fields.
  predictionAsOfIso: string;
  secondsToFirstPitch: number | null;
  lineupConfirmedAtIso: string | null;
  starterConfirmed: boolean;
  inputContractVersion: string;
  frozenInput: FrozenPlateHrV2Input;
  inputHash: string;
  featureVersion: string;
  derivedFeatures: PlateHrV2DerivedFeatureVectorV2;
  availability: PlateHrV2FeatureAvailabilityVectorV2;
  featureFreshness: PlateHrV2FeatureFreshnessVectorV1;
  rawInputs: PlateHrV2RawInputEnvelope;
  leakageWarnings: string[];
  sufficientStatsRef: string | null;
  championModelVersion: string;
  championScore10: number;
  championTier: string;
  championSuppressed: boolean;
}

export type PlateHrV2CaptureSink = (
  rows: PlateHrV2CaptureRow[],
  manifest: { buildId: string; sessionDate: string },
) => Promise<void>;

let plateHrV2CaptureSink: PlateHrV2CaptureSink | null = null;
export function setPlateHrV2CaptureSink(sink: PlateHrV2CaptureSink): void {
  plateHrV2CaptureSink = sink;
}

/** Flush the batch through the registered sink, if any. Never called when capture is disabled (the caller only accumulates rows when the flag is on). */
export async function flushPlateHrV2Captures(
  rows: PlateHrV2CaptureRow[],
  manifest: { buildId: string; sessionDate: string },
): Promise<void> {
  if (!plateHrV2CaptureSink || rows.length === 0) return;
  await plateHrV2CaptureSink(rows, manifest);
}

export interface CapturePlateHrV2CandidateArgs {
  sessionDate: string;
  gameId: string;
  gamePk: string | null;
  evidence: PlateHrV2EvidenceDescriptor[];
  buildId: string;
  batterId: string;
  batterName: string;
  team: string;
  opponent: string;
  pitcherId: string | null;
  pitcherName: string | null;
  battingOrderSlot: number | null;
  batterHand: Handedness;
  capturedAtMs: number;
  firstPitchAtMs: number | null;
  firstPitchLockEligible: boolean;
  gameStatus: string;
  lineupConfirmedAtMs: number | null;
  starterConfirmed: boolean;
  sufficientStatsRef: string | null;
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
  // PR5 additive shadow input — omitted → the builder emits a neutral group. The
  // caller (buildPregamePowerRadar) also appends the content-addressed
  // contact_events evidence descriptor to `evidence` so this leaf is reproducible.
  recentContactForm?: RecentContactFormInputs;
  slateBaselineGameHrProbability: number | null;
  savantQuality: "full" | "fallback" | "missing";
  venueResolved: boolean;
  pitcherHandResolved: boolean;
  batterPowerFullyAvailable: boolean;
  batterPowerMeta?: PlateHrV2SourceMeta;
  batTrackingMeta?: PlateHrV2SourceMeta;
  pitcherVulnerabilityMeta?: PlateHrV2SourceMeta;
  pitchTypeMeta?: PlateHrV2SourceMeta;
  parkWeatherSprayMeta?: PlateHrV2SourceMeta;
  lineupOpportunityMeta?: PlateHrV2SourceMeta;
  championModelVersion: string;
  championScore10: number;
  championTier: string;
  championSuppressed: boolean;
}

/**
 * Build (but do not persist) one Plate HR V2 capture row. Returns null when
 * the forward-capture flag is off — the caller should treat a null return as
 * "nothing to accumulate this cycle," not an error.
 */
export function capturePlateHrV2Candidate(args: CapturePlateHrV2CandidateArgs): PlateHrV2CaptureRow | null {
  if (!isPlateHrV2ForwardCaptureEnabled()) return null;

  const capturedAtIso = new Date(args.capturedAtMs).toISOString();
  const firstPitchIso = args.firstPitchAtMs != null ? new Date(args.firstPitchAtMs).toISOString() : null;
  const lineupConfirmedAtIso = args.lineupConfirmedAtMs != null ? new Date(args.lineupConfirmedAtMs).toISOString() : null;
  const secondsToFirstPitch =
    args.firstPitchAtMs != null ? Math.round((args.firstPitchAtMs - args.capturedAtMs) / 1000) : null;

  const frozen: FrozenPlateHrV2Input = {
    sessionDate: args.sessionDate,
    gameId: args.gameId,
    batterId: args.batterId,
    pitcherId: args.pitcherId,
    batterHand: args.batterHand,
    body: {
      batterPower: args.batterPower,
      batTracking: args.batTracking,
      pitcherVulnerability: args.pitcherVulnerability,
      pitchType: args.pitchType,
      zoneLocation: args.zoneLocation,
      parkWeatherSpray: args.parkWeatherSpray,
      lineupOpportunity: args.lineupOpportunity,
      starterBullpen: args.starterBullpen,
      market: args.market,
      availability: args.availability,
      contactOpportunity: args.contactOpportunity,
      recentContactForm: args.recentContactForm,
      slateBaselineGameHrProbability: args.slateBaselineGameHrProbability,
    },
    dataQuality: {
      savantQuality: args.savantQuality,
      venueResolved: args.venueResolved,
      pitcherHandResolved: args.pitcherHandResolved,
      batterPowerFullyAvailable: args.batterPowerFullyAvailable,
    },
  };
  const frozenInput = freezePlateHrV2Input(frozen);
  const inputHash = hashFrozenPlateHrV2Input(frozen);

  const built = assemblePlateHrV2FeatureSnapshot({
    asOfMs: args.capturedAtMs,
    firstPitchAtMs: args.firstPitchAtMs,
    lineupConfirmedAtMs: args.lineupConfirmedAtMs,
    starterConfirmed: args.starterConfirmed,
    sessionDate: args.sessionDate,
    gameId: args.gameId,
    batterId: args.batterId,
    pitcherId: args.pitcherId,
    batterHand: args.batterHand,
    sufficientStatsRef: args.sufficientStatsRef,
    batterPower: args.batterPower,
    batTracking: args.batTracking,
    pitcherVulnerability: args.pitcherVulnerability,
    pitchType: args.pitchType,
    zoneLocation: args.zoneLocation,
    parkWeatherSpray: args.parkWeatherSpray,
    lineupOpportunity: args.lineupOpportunity,
    starterBullpen: args.starterBullpen,
    market: args.market,
    availability: args.availability,
    contactOpportunity: args.contactOpportunity,
    recentContactForm: args.recentContactForm,
    slateBaselineGameHrProbability: args.slateBaselineGameHrProbability,
    batterPowerMeta: args.batterPowerMeta,
    batTrackingMeta: args.batTrackingMeta,
    pitcherVulnerabilityMeta: args.pitcherVulnerabilityMeta,
    pitchTypeMeta: args.pitchTypeMeta,
    parkWeatherSprayMeta: args.parkWeatherSprayMeta,
    lineupOpportunityMeta: args.lineupOpportunityMeta,
    savantQuality: args.savantQuality,
    venueResolved: args.venueResolved,
    pitcherHandResolved: args.pitcherHandResolved,
    batterPowerFullyAvailable: args.batterPowerFullyAvailable,
  });

  // Deterministic key so re-capturing the same (feature-version, session,
  // game, batter) is idempotent — mirrors the champion's own
  // `mlb-pregame:${sessionDate}:${gameId}:${batterId}` signalId convention.
  const snapshotId = `plate-hr-v2:${PLATE_HR_V2_FEATURES_CURRENT}:${args.sessionDate}:${args.gameId}:${args.batterId}`;

  return {
    snapshotId,
    sessionDate: args.sessionDate,
    gameId: args.gameId,
    gamePk: args.gamePk,
    evidence: args.evidence,
    batterId: args.batterId,
    batterName: args.batterName,
    team: args.team,
    opponent: args.opponent,
    pitcherId: args.pitcherId,
    pitcherName: args.pitcherName,
    battingOrderSlot: args.battingOrderSlot,
    buildId: args.buildId,
    firstCapturedAtIso: capturedAtIso,
    lastCapturedAtIso: capturedAtIso,
    firstPitchTimeIso: firstPitchIso,
    firstPitchLockEligible: args.firstPitchLockEligible,
    gameStatus: args.gameStatus,
    predictionAsOfIso: capturedAtIso,
    secondsToFirstPitch,
    lineupConfirmedAtIso,
    starterConfirmed: args.starterConfirmed,
    inputContractVersion: PLATE_HR_V2_FEATURES_CURRENT,
    frozenInput,
    inputHash,
    featureVersion: PLATE_HR_V2_FEATURES_CURRENT,
    derivedFeatures: built.derivedFeatures,
    availability: built.availability,
    featureFreshness: built.featureFreshness,
    rawInputs: built.rawInputs,
    leakageWarnings: built.leakageWarnings,
    sufficientStatsRef: args.sufficientStatsRef,
    championModelVersion: args.championModelVersion,
    championScore10: args.championScore10,
    championTier: args.championTier,
    championSuppressed: args.championSuppressed,
  };
}

// ── Sufficient-statistics capture (correction 2) ─────────────────────────────
// A player's season-to-date evidence, captured once per (entityType,
// entityId, asOfDate) — deliberately separate from the per-(game,batter)
// feature-snapshot capture above, mirroring plate_hr_v2_sufficient_stats'
// own table grain (see the plan's deviation (k)).

export interface PlateHrV2SufficientStatsCaptureRow {
  statsId: string;
  entityType: "batter" | "pitcher";
  entityId: string;
  asOfDate: string;
  raw: PlateHrV2SufficientStatsRaw;
}

export type PlateHrV2SufficientStatsSink = (rows: PlateHrV2SufficientStatsCaptureRow[]) => Promise<void>;

let plateHrV2SufficientStatsSink: PlateHrV2SufficientStatsSink | null = null;
export function setPlateHrV2SufficientStatsSink(sink: PlateHrV2SufficientStatsSink): void {
  plateHrV2SufficientStatsSink = sink;
}

export async function flushPlateHrV2SufficientStats(rows: PlateHrV2SufficientStatsCaptureRow[]): Promise<void> {
  if (!plateHrV2SufficientStatsSink || rows.length === 0) return;
  await plateHrV2SufficientStatsSink(rows);
}

/** Deterministic id shared between the capture row and a feature snapshot's `sufficientStatsRef` pointer. */
export function plateHrV2SufficientStatsId(entityType: "batter" | "pitcher", entityId: string, asOfDate: string): string {
  return `plate-hr-v2-stats:${entityType}:${entityId}:${asOfDate}`;
}

/**
 * Build (but do not persist) one sufficient-stats capture row. Returns null
 * when capture is disabled or no raw stats were computed for this entity
 * (e.g. the Savant fetch failed or returned zero rows) — never fabricated.
 */
export function captureSufficientStatsIfNeeded(
  entityType: "batter" | "pitcher",
  entityId: string,
  asOfDate: string,
  raw: PlateHrV2SufficientStatsRaw | null | undefined,
): PlateHrV2SufficientStatsCaptureRow | null {
  if (!isPlateHrV2ForwardCaptureEnabled()) return null;
  if (!raw || raw.sourceRowCount === 0) return null;
  return { statsId: plateHrV2SufficientStatsId(entityType, entityId, asOfDate), entityType, entityId, asOfDate, raw };
}
