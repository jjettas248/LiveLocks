// Mound Radar V2 (shadow) — fail-closed feature flag / kill switch.
//
// Same fail-closed parsing convention used elsewhere in this codebase (e.g.
// HR Radar research's parseHrResearchBooleanFlag) — deliberately
// reimplemented here rather than imported, so Mound V2 stays independently
// reasoned about and this flag can never be flipped by a change to an
// unrelated subsystem's flag file.
//
// Default is OFF. Setting MOUND_V2_SHADOW_ENABLED=false (or unsetting it) at
// any time is the kill switch — buildMlbMoundRadar.ts's shadow call site
// checks this on every build cycle, not just once at boot.

const TRUE_LIKE = new Set(["true", "1", "on", "yes"]);

export function parseMoundV2BooleanFlag(raw: string | undefined): boolean {
  if (raw == null) return false;
  return TRUE_LIKE.has(raw.trim().toLowerCase());
}

export function isMoundV2ShadowEnabled(): boolean {
  return parseMoundV2BooleanFlag(process.env.MOUND_V2_SHADOW_ENABLED);
}
