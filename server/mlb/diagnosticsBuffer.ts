// MLB Engine Diagnostics Ring Buffers
//
// Small in-memory recorders so the admin debug endpoint can show recent
// HR Watch detections, suppressions, persistence rejects, and Phase 3
// market-calibration events without having to re-scan log files. Pure
// observation — never affects engine math, never surfaces to non-admin users.

const MAX_ENTRIES = 50;

// ── Phase 3 — Market Calibration Version ─────────────────────────────────
// Single source of truth for the calibration version stamped on every
// MLB engine signal + exposed via the admin debug endpoint. Bump this
// string whenever the calibration semantics change.
export const MLB_CALIBRATION_VERSION = "mlb-market-cal-v3";

export interface HrWatchDetectionRecord {
  ts: number;
  player: string | null;
  team: string | null;
  market: string | null;
  inning: number | null;
  result: string | null;
  ev: number | null;
  la: number | null;
  distance: number | null;
  xba: number | null;
  signalTier: "watch" | "lean" | null;
  drivers: string[];
}

export interface HrWatchSuppressedRecord {
  ts: number;
  player: string | null;
  market: string | null;
  reason: string;
  ev: number | null;
  la: number | null;
  distance: number | null;
  xba: number | null;
}

export interface PersistRejectRecord {
  ts: number;
  reason: string;
  player: string | null;
  market: string | null;
  recommendedSide: string | null;
  engineProbability: number | null;
  signalScore: number | null;
}

// ── Phase 3 — Market-specific calibration audit records ─────────────────
export interface HrrCalibrationRecord {
  ts: number;
  player: string | null;
  rawProbability: number | null;
  adjustedProbability: number | null;
  capApplied: boolean;
  usedTbFallback: boolean;
  nearHrCount: number | null;
  contactScore: number | null;
  reason: string;
}

export interface HitsAllowedCalibrationRecord {
  ts: number;
  pitcher: string | null;
  side: string | null;
  rawProbability: number | null;
  adjustedProbability: number | null;
  pitchCount: number | null;
  timesThroughOrder: number | null;
  contactAllowedScore: number | null;
  fallbackUsed: boolean;
}

export interface SelfLearningCalibrationRecord {
  ts: number;
  market: string;
  side: string | null;
  sampleSize: number;
  observedHitRate: number | null;
  predictedAvg: number | null;
  adjustmentFactor: number | null;
  applied: boolean;
}

export interface HrWatchContextRecord {
  ts: number;
  player: string | null;
  market: string | null;
  nearHrCount: number | null;
  contactScore: number | null;
  affectedSignalScore: number | null;
  affectedProbability: number | null;
  signalTier: string | null;
}

export interface CapAppliedRecord {
  ts: number;
  market: string;
  side: string;
  player: string | null;
  rawProbability: number;
  cappedProbability: number;
  capReason: string;
}

const _hrWatchDetections: HrWatchDetectionRecord[] = [];
const _hrWatchSuppressed: HrWatchSuppressedRecord[] = [];
const _persistRejects: PersistRejectRecord[] = [];
const _hrrCalibrations: HrrCalibrationRecord[] = [];
const _hitsAllowedCalibrations: HitsAllowedCalibrationRecord[] = [];
const _selfLearningCalibrations: SelfLearningCalibrationRecord[] = [];
const _hrWatchContextUses: HrWatchContextRecord[] = [];
const _capsApplied: CapAppliedRecord[] = [];

function pushCapped<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
}

export function recordHrWatchDetection(rec: Omit<HrWatchDetectionRecord, "ts">): void {
  pushCapped(_hrWatchDetections, { ts: Date.now(), ...rec });
}

export function recordHrWatchSuppressed(rec: Omit<HrWatchSuppressedRecord, "ts">): void {
  pushCapped(_hrWatchSuppressed, { ts: Date.now(), ...rec });
}

export function recordPersistReject(rec: Omit<PersistRejectRecord, "ts">): void {
  pushCapped(_persistRejects, { ts: Date.now(), ...rec });
}

export function recordHrrCalibration(rec: Omit<HrrCalibrationRecord, "ts">): void {
  pushCapped(_hrrCalibrations, { ts: Date.now(), ...rec });
}

export function recordHitsAllowedCalibration(rec: Omit<HitsAllowedCalibrationRecord, "ts">): void {
  pushCapped(_hitsAllowedCalibrations, { ts: Date.now(), ...rec });
}

export function recordSelfLearningCalibration(rec: Omit<SelfLearningCalibrationRecord, "ts">): void {
  pushCapped(_selfLearningCalibrations, { ts: Date.now(), ...rec });
}

export function recordHrWatchContext(rec: Omit<HrWatchContextRecord, "ts">): void {
  pushCapped(_hrWatchContextUses, { ts: Date.now(), ...rec });
}

export function recordCapApplied(rec: Omit<CapAppliedRecord, "ts">): void {
  pushCapped(_capsApplied, { ts: Date.now(), ...rec });
}

export function getHrWatchDetections(limit = MAX_ENTRIES): HrWatchDetectionRecord[] {
  return _hrWatchDetections.slice(-limit).reverse();
}

export function getHrWatchSuppressed(limit = MAX_ENTRIES): HrWatchSuppressedRecord[] {
  return _hrWatchSuppressed.slice(-limit).reverse();
}

export function getPersistRejects(limit = MAX_ENTRIES): PersistRejectRecord[] {
  return _persistRejects.slice(-limit).reverse();
}

export function getHrrCalibrations(limit = MAX_ENTRIES): HrrCalibrationRecord[] {
  return _hrrCalibrations.slice(-limit).reverse();
}

export function getHitsAllowedCalibrations(limit = MAX_ENTRIES): HitsAllowedCalibrationRecord[] {
  return _hitsAllowedCalibrations.slice(-limit).reverse();
}

export function getSelfLearningCalibrations(limit = MAX_ENTRIES): SelfLearningCalibrationRecord[] {
  return _selfLearningCalibrations.slice(-limit).reverse();
}

export function getHrWatchContextUses(limit = MAX_ENTRIES): HrWatchContextRecord[] {
  return _hrWatchContextUses.slice(-limit).reverse();
}

export function getCapsApplied(limit = MAX_ENTRIES): CapAppliedRecord[] {
  return _capsApplied.slice(-limit).reverse();
}

export function getDiagnosticsCounts(windowMs = 10 * 60 * 1000): {
  hrWatchDetected: number;
  hrWatchSuppressed: number;
  persistRejected: number;
  hrrCalibrations: number;
  hitsAllowedCalibrations: number;
  selfLearningCalibrations: number;
  hrWatchContextUses: number;
  capsApplied: number;
} {
  const cutoff = Date.now() - windowMs;
  return {
    hrWatchDetected: _hrWatchDetections.filter((r) => r.ts >= cutoff).length,
    hrWatchSuppressed: _hrWatchSuppressed.filter((r) => r.ts >= cutoff).length,
    persistRejected: _persistRejects.filter((r) => r.ts >= cutoff).length,
    hrrCalibrations: _hrrCalibrations.filter((r) => r.ts >= cutoff).length,
    hitsAllowedCalibrations: _hitsAllowedCalibrations.filter((r) => r.ts >= cutoff).length,
    selfLearningCalibrations: _selfLearningCalibrations.filter((r) => r.ts >= cutoff).length,
    hrWatchContextUses: _hrWatchContextUses.filter((r) => r.ts >= cutoff).length,
    capsApplied: _capsApplied.filter((r) => r.ts >= cutoff).length,
  };
}
