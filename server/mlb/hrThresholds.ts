/**
 * Shared HR-detection thresholds — single source of truth.
 *
 * These were previously duplicated verbatim across `HRSignalBuilder.ts` and
 * `nearHrContact.ts`, which meant a tuning change in one place silently drifted
 * from the other. Keep cross-layer HR-geometry constants here so both the
 * signal builder and the Phase 2.5 near-HR detector stay in lockstep.
 *
 * This module is intentionally dependency-free so `nearHrContact.ts` can import
 * it while remaining a pure, I/O-free function.
 */

/** Batted-ball carry (ft) at/above which a flyout counts as a "deep" near-HR. */
export const DEEP_FLY_DISTANCE = 330;
