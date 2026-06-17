// MLB Gold Master Guard
//
// Passive observation layer that protects the MLB engine from silent drift.
// Emits [MLB_GOLDMASTER_LOCK] once at boot, records a per-cycle drift
// snapshot, compares snapshots to the rolling baseline, and emits
// [MLB_DRIFT_WARNING] / [MLB_SIGNAL_PARITY] as appropriate.
//
// This module NEVER:
//   - mutates engine math
//   - blocks signals
//   - auto-rolls-back
//   - surfaces to non-admin users
//
// All enforcement is human-driven via docs/agents/mlb-reset-skill.md.

import { MLB_CALIBRATION_VERSION } from "./diagnosticsBuffer";

// ── Locked baseline version ────────────────────────────────────────────────
// Bump this string only when MLB engine behavior changes intentionally.
// The boot log line carries this value so prod logs are self-describing.
export const MLB_GOLDMASTER_VERSION = "mlb-goldmaster-v4-2026-06-17-ibb-recent-form";

// Rolling drift snapshot ring buffer.
const MAX_SNAPSHOTS = 50;

export interface DriftSnapshot {
  ts: number;
  gameId: string;
  marketsEvaluated: number;
  qualifiedSignals: number;
  rejectedSignals: number;
  rejectRate: number;
  avgProbability: number | null;
  avgProjectionDelta: number | null;
  hrRadarStates: Record<string, number>; // count by HR Radar canonical state
  payloadShapeHash: string;
}

const _snapshots: DriftSnapshot[] = [];
let _bootLockEmitted = false;

// Counters surfaced via admin debug for the rolling 10-minute window.
let _driftWarningsSinceBoot = 0;

function pushCapped<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > MAX_SNAPSHOTS) arr.splice(0, arr.length - MAX_SNAPSHOTS);
}

/**
 * Emit the boot lock log line exactly once per process. Idempotent — safe
 * to call from multiple module-init paths. The log is the single source of
 * truth for "what version of the MLB engine is currently running" in prod.
 */
export function emitBootLock(): void {
  if (_bootLockEmitted) return;
  _bootLockEmitted = true;
  try {
    console.log("[MLB_GOLDMASTER_LOCK]", JSON.stringify({
      version: MLB_GOLDMASTER_VERSION,
      calibrationVersion: MLB_CALIBRATION_VERSION,
      bootedAt: new Date().toISOString(),
      lockedPhases: ["1", "1.5", "2", "2.5", "3B"],
      lockedContracts: ["display-contract-v1", "signal-tier-v2", "hr-radar-canonical-v5"],
    }));
  } catch {}
}

// Self-emit on import so the lock line appears at server boot without
// requiring an explicit call site.
emitBootLock();

/**
 * Build a stable hash of the MLBSignal payload field set for drift
 * detection at the schema layer. Field order is normalized so additions
 * always change the hash.
 */
function hashPayloadShape(fieldSet: string[]): string {
  const sorted = Array.from(new Set(fieldSet)).sort().join("|");
  // Lightweight FNV-1a — we don't need cryptographic strength, just a
  // stable fingerprint that changes when fields are added/removed.
  let h = 0x811c9dc5;
  for (let i = 0; i < sorted.length; i++) {
    h ^= sorted.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

export interface DriftSnapshotInput {
  gameId: string;
  marketsEvaluated: number;
  qualifiedSignals: number;
  rejectedSignals: number;
  signals: Array<{
    engineProbability?: number | null;
    enginePct?: number | null;
    projection?: number | null;
    bookLine?: number | null;
    hrAlert?: { currentState?: string } | null;
  }>;
  payloadFieldSample?: string[]; // optional: keys of one representative signal
}

/**
 * Record one per-game drift snapshot and compare to the rolling baseline.
 * Called at the end of each MLB qualification cycle. Emits
 * [MLB_DRIFT_WARNING] when guardrail thresholds are crossed and
 * [MLB_SIGNAL_PARITY] every snapshot for external monitoring.
 */
export function recordDriftSnapshot(input: DriftSnapshotInput): DriftSnapshot {
  const probs: number[] = [];
  const deltas: number[] = [];
  const states: Record<string, number> = {};
  for (const s of input.signals) {
    const p = s.engineProbability ?? s.enginePct;
    if (typeof p === "number" && Number.isFinite(p)) probs.push(p);
    if (typeof s.projection === "number" && typeof s.bookLine === "number") {
      deltas.push(s.projection - s.bookLine);
    }
    const st = s.hrAlert?.currentState;
    if (st) states[st] = (states[st] ?? 0) + 1;
  }
  const snap: DriftSnapshot = {
    ts: Date.now(),
    gameId: input.gameId,
    marketsEvaluated: input.marketsEvaluated,
    qualifiedSignals: input.qualifiedSignals,
    rejectedSignals: input.rejectedSignals,
    rejectRate: input.marketsEvaluated > 0
      ? input.rejectedSignals / input.marketsEvaluated
      : 0,
    avgProbability: probs.length > 0
      ? probs.reduce((a, b) => a + b, 0) / probs.length
      : null,
    avgProjectionDelta: deltas.length > 0
      ? deltas.reduce((a, b) => a + b, 0) / deltas.length
      : null,
    hrRadarStates: states,
    payloadShapeHash: input.payloadFieldSample
      ? hashPayloadShape(input.payloadFieldSample)
      : "—",
  };
  pushCapped(_snapshots, snap);

  // Periodic parity log (every snapshot — admins can grep)
  try {
    console.log("[MLB_SIGNAL_PARITY]", JSON.stringify({
      version: MLB_GOLDMASTER_VERSION,
      gameId: snap.gameId,
      qualified: snap.qualifiedSignals,
      rejectRate: Number(snap.rejectRate.toFixed(3)),
      avgProb: snap.avgProbability != null ? Number(snap.avgProbability.toFixed(2)) : null,
      shape: snap.payloadShapeHash,
    }));
  } catch {}

  compareToBaseline(snap);
  return snap;
}

/**
 * Compare a fresh snapshot to the rolling baseline (prior 20 snapshots)
 * and emit [MLB_DRIFT_WARNING] when guardrail thresholds are crossed.
 *
 * Thresholds are intentionally loose — this is an early-warning signal,
 * not an enforcement gate.
 */
function compareToBaseline(snap: DriftSnapshot): void {
  // Use the prior 20 snapshots (excluding the current one) as baseline.
  const recent = _snapshots.slice(-21, -1);
  if (recent.length < 5) return; // not enough history yet

  const reasons: string[] = [];

  // Qualified signal collapse.
  const baselineQualified = recent.reduce((a, b) => a + b.qualifiedSignals, 0) / recent.length;
  if (baselineQualified >= 1 && snap.qualifiedSignals < baselineQualified * 0.6) {
    reasons.push(`qualified_drop:${snap.qualifiedSignals}vs${baselineQualified.toFixed(1)}`);
  }

  // Reject-rate spike (in percentage points).
  const baselineReject = recent.reduce((a, b) => a + b.rejectRate, 0) / recent.length;
  if (snap.rejectRate - baselineReject > 0.15) {
    reasons.push(`reject_spike:${(snap.rejectRate * 100).toFixed(1)}vs${(baselineReject * 100).toFixed(1)}`);
  }

  // Mean probability shift.
  const baseProbs = recent.map((s) => s.avgProbability).filter((p): p is number => p != null);
  if (snap.avgProbability != null && baseProbs.length >= 5) {
    const baselineProb = baseProbs.reduce((a, b) => a + b, 0) / baseProbs.length;
    if (Math.abs(snap.avgProbability - baselineProb) > 5) {
      reasons.push(`prob_shift:${snap.avgProbability.toFixed(1)}vs${baselineProb.toFixed(1)}`);
    }
  }

  // Payload shape change.
  const baselineShapes = new Set(recent.map((s) => s.payloadShapeHash).filter((h) => h !== "—"));
  if (snap.payloadShapeHash !== "—" && baselineShapes.size > 0 && !baselineShapes.has(snap.payloadShapeHash)) {
    reasons.push(`shape_change:${snap.payloadShapeHash}`);
  }

  if (reasons.length === 0) return;
  _driftWarningsSinceBoot++;
  try {
    console.warn("[MLB_DRIFT_WARNING]", JSON.stringify({
      version: MLB_GOLDMASTER_VERSION,
      gameId: snap.gameId,
      reasons,
      snapshot: {
        qualified: snap.qualifiedSignals,
        rejectRate: Number(snap.rejectRate.toFixed(3)),
        avgProb: snap.avgProbability,
        shape: snap.payloadShapeHash,
      },
    }));
  } catch {}
}

export function getDriftSnapshots(limit = MAX_SNAPSHOTS): DriftSnapshot[] {
  return _snapshots.slice(-limit).reverse();
}

export function getDriftWarningsSinceBoot(): number {
  return _driftWarningsSinceBoot;
}

export function getGoldmasterStatus(): {
  version: string;
  calibrationVersion: string;
  bootLockEmitted: boolean;
  driftWarningsSinceBoot: number;
  snapshotsRecorded: number;
} {
  return {
    version: MLB_GOLDMASTER_VERSION,
    calibrationVersion: MLB_CALIBRATION_VERSION,
    bootLockEmitted: _bootLockEmitted,
    driftWarningsSinceBoot: _driftWarningsSinceBoot,
    snapshotsRecorded: _snapshots.length,
  };
}
