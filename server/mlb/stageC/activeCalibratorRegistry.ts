// ── MLB Live Edge Stage C PR3 — in-memory active-calibrator registry ─────────
// The ONE hot-path read of promoted calibrators. The finalizer (a pure,
// per-tick function) must never touch the DB, so this module holds an in-memory
// snapshot of the currently-active calibrators (loaded at boot + refreshed after
// each offline runner cycle) and exposes a synchronous, pure lookup.
//
// TRIPLE fail-closed gating on the read side — a calibrated value is returned
// only when ALL hold:
//   1. MLB_CALIBRATION_PROMOTION_ENABLED is on (master switch, read once at
//      boot). While off, this ALWAYS returns null no matter what is loaded — a
//      stray active row can never affect engine output.
//   2. a compatible active calibrator exists for the segment, AND
//   3. the raw probability is WITHIN the calibrator's fitted support (outside
//      it applyCalibrator flat-extrapolates — Stage A rule: treat out-of-support
//      as uncalibrated / null, never ship an extrapolated value).
// Any miss ⇒ null ⇒ the finalizer keeps calibratedProbability = null (Stage A
// semantics unchanged). Never an identity copy of the raw probability.
//
// The load (async, storage-backed) lives in refreshActiveCalibratorRegistry();
// the lookup (sync, pure) lives in lookupCalibratedProbability(). Loading data
// is harmless while the flag is off because the lookup itself is flag-gated.

import { applyCalibrator, isWithinCalibratorSupport, type MlbActiveCalibrator } from "@shared/mlbCalibration";
import { isMlbCalibrationPromotionEnabled } from "../productionPolicy";

// segment → active calibrator. Replaced wholesale on each refresh (never mutated
// in place) so a concurrent hot-path read always sees a coherent snapshot.
let REGISTRY: ReadonlyMap<string, MlbActiveCalibrator> = new Map();
let loadedAtMs: number | null = null;

/** Replaces the in-memory snapshot. Called by refreshActiveCalibratorRegistry
 *  (and directly by tests). Pure w.r.t. the DB. */
export function setActiveCalibratorRegistry(
  calibrators: readonly MlbActiveCalibrator[],
  nowMs: number,
): void {
  const next = new Map<string, MlbActiveCalibrator>();
  for (const c of calibrators) {
    if (c.active) next.set(c.segment, c);
  }
  REGISTRY = next;
  loadedAtMs = nowMs;
}

/** Test-only: reset the snapshot to empty. */
export function __resetActiveCalibratorRegistryForTest(): void {
  REGISTRY = new Map();
  loadedAtMs = null;
}

/** The segment keys to try, most specific first — supports both the runner's
 *  per-market ("hits") and per-market-lane ("hits:official") segmentation. */
function segmentCandidates(market: string, lane: string | null | undefined): string[] {
  return lane ? [`${market}:${lane}`, market] : [market];
}

/**
 * Hot-path pure lookup. Returns a calibrated probability (0..100) or null.
 * Fail-closed on all three gates (flag / compatible segment / in-support).
 * NEVER throws — any internal error resolves to null (uncalibrated).
 */
export function lookupCalibratedProbability(
  market: string,
  lane: string | null | undefined,
  rawProbPct: number,
): number | null {
  // Gate 1: master switch. While off, the registry has ZERO engine effect.
  if (!isMlbCalibrationPromotionEnabled()) return null;
  if (!Number.isFinite(rawProbPct)) return null;
  try {
    for (const seg of segmentCandidates(market, lane)) {
      const cal = REGISTRY.get(seg);
      if (!cal || !cal.active) continue;
      // Gate 3: only calibrate within fitted support (no extrapolation shipped).
      if (!isWithinCalibratorSupport(cal.artifact, rawProbPct)) return null;
      return applyCalibrator(cal.artifact, rawProbPct);
    }
    return null;
  } catch {
    return null;
  }
}

/** Read-only introspection for the admin surface / diagnostics (never affects
 *  the hot path). */
export function getActiveCalibratorRegistrySnapshot(): {
  enabled: boolean;
  loadedAtMs: number | null;
  segments: string[];
} {
  return {
    enabled: isMlbCalibrationPromotionEnabled(),
    loadedAtMs,
    segments: Array.from(REGISTRY.keys()).sort(),
  };
}

/**
 * Loads the active calibrators from storage into the in-memory snapshot. Called
 * at boot and after each offline runner cycle. NEVER throws — a load failure
 * leaves the previous snapshot in place and logs. Returns the number loaded (or
 * -1 on failure).
 */
export async function refreshActiveCalibratorRegistry(nowMs: number = Date.now()): Promise<number> {
  try {
    const { storage } = await import("../../storage");
    const active = await storage.listActiveMlbCalibrators();
    setActiveCalibratorRegistry(active, nowMs);
    console.log(
      `[MLB_STAGE_C_REGISTRY] loaded=${active.length} enabled=${isMlbCalibrationPromotionEnabled()} segments=${active.map((c) => c.segment).join(",") || "none"}`,
    );
    return active.length;
  } catch (err) {
    console.warn(`[MLB_STAGE_C_REGISTRY_ERROR] ${(err as Error)?.message ?? err}`);
    return -1;
  }
}
