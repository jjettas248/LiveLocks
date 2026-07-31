// Mound Radar — Phase 1 official-firewall MEASUREMENT flag (Flagship
// Program Phase 2, Part 8). Fail-closed, default OFF — same convention as
// server/mlb/pregame/mound/v2/moundV2ShadowFlags.ts, deliberately
// reimplemented rather than imported so this flag can never be flipped by a
// change to an unrelated subsystem's flag file.
//
// This flag gates a DIAGNOSTIC READ ENDPOINT only (see
// moundOfficialFirewallGate.ts / the admin route in moundStatsRoutes.ts) —
// it never gates, suppresses, or changes anything in Mound's actual
// publication path. With the flag off, the endpoint returns a clear
// "measurement disabled" payload instead of running any evaluation.

const TRUE_LIKE = new Set(["true", "1", "on", "yes"]);

export function parseMoundFirewallMeasurementBooleanFlag(raw: string | undefined): boolean {
  if (raw == null) return false;
  return TRUE_LIKE.has(raw.trim().toLowerCase());
}

export function isMoundOfficialFirewallMeasurementEnabled(): boolean {
  return parseMoundFirewallMeasurementBooleanFlag(process.env.MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED);
}
