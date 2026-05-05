// MLB Engine Diagnostics Ring Buffers
//
// Small in-memory recorders so the admin debug endpoint can show recent
// HR Watch detections, suppressions, and persistence rejects without
// having to re-scan log files. Pure observation — never affects engine
// math, never surfaces to non-admin users.

const MAX_ENTRIES = 50;

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

const _hrWatchDetections: HrWatchDetectionRecord[] = [];
const _hrWatchSuppressed: HrWatchSuppressedRecord[] = [];
const _persistRejects: PersistRejectRecord[] = [];

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

export function getHrWatchDetections(limit = MAX_ENTRIES): HrWatchDetectionRecord[] {
  return _hrWatchDetections.slice(-limit).reverse();
}

export function getHrWatchSuppressed(limit = MAX_ENTRIES): HrWatchSuppressedRecord[] {
  return _hrWatchSuppressed.slice(-limit).reverse();
}

export function getPersistRejects(limit = MAX_ENTRIES): PersistRejectRecord[] {
  return _persistRejects.slice(-limit).reverse();
}

export function getDiagnosticsCounts(windowMs = 10 * 60 * 1000): {
  hrWatchDetected: number;
  hrWatchSuppressed: number;
  persistRejected: number;
} {
  const cutoff = Date.now() - windowMs;
  return {
    hrWatchDetected: _hrWatchDetections.filter((r) => r.ts >= cutoff).length,
    hrWatchSuppressed: _hrWatchSuppressed.filter((r) => r.ts >= cutoff).length,
    persistRejected: _persistRejects.filter((r) => r.ts >= cutoff).length,
  };
}
