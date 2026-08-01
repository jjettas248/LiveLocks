// The Plate — display-layer driver suppression (Plate HR engine upgrade, PR0).
//
// Problem: the `power_iso` ("Elite Isolated Power") driver fires for nearly every
// surfaced hitter (its cut sits at ~xISO 0.20 — above-average, not elite — and the
// publication funnel is power-dominated), so the tag no longer differentiates
// targets. Until a fitted, selective threshold ships with the calibrated model
// (plan PR11), it is suppressed FROM PRESENTATION.
//
// This is DISPLAY-ONLY and deliberately narrow:
//   • batterPowerProfile.ts still PRODUCES the `power_iso` PowerDriver.
//   • plateDriverUniverse.countPositiveDrivers still COUNTS it (it is a member of
//     JUL20_POSITIVE_DRIVER_KEYS), so champion score/tier/positiveDriverCount/
//     qualification/publication remain byte-identical.
//   • Only the user-facing driver/tag lists (server serialization + win digest,
//     and the client card) exclude the keys below.
//
// Keep this set minimal. Membership here NEVER changes qualification — see the
// isolation test (eliteIsoDisplaySuppression.test.ts).

export const DISPLAY_SUPPRESSED_DRIVER_KEYS: ReadonlySet<string> = new Set<string>([
  "power_iso",
]);

/** True when a driver key must be hidden from presentation (but still produced/counted). */
export function isDisplaySuppressedDriverKey(key: string): boolean {
  return DISPLAY_SUPPRESSED_DRIVER_KEYS.has(key);
}
