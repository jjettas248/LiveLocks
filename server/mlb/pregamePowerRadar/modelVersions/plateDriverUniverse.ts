// The Plate — driver universes for the champion / challenger model contract.
//
// Why this file exists: today `positiveDriverCount` is frozen in
// buildPregamePowerRadar.ts BEFORE appendAttackEnvironmentDrivers runs, so the
// Attack-Environment tags happen to be excluded from the count. That is an
// accident of call ordering, not a contract — reorder those two statements and
// research tags silently become qualifying evidence. This module replaces that
// accident with explicit, enumerated membership.
//
// Three sets, each read off a specific tree:
//   • JUL20_POSITIVE_DRIVER_KEYS         — positive driver keys emitted at 749c148
//   • CURRENT_HEAD_POSITIVE_DRIVER_KEYS  — the keys HEAD emits before the freeze
//   • RESEARCH_ONLY_DRIVER_KEYS          — keys that reach NEITHER production count
//
// Membership is opt-in: a newly added driver key joins no production set until
// someone deliberately edits one here. `driverUniverseHygiene()` fails loudly on
// any emitted key that has not been classified, so a new key cannot slip in
// unclassified.

import type { PowerDriver } from "../types";

/**
 * Dynamic key prefix from nearHrRecentForm.ts (`near_hr_form_${dayKey}`).
 * Prefix membership is checked separately from the exact-key sets.
 */
export const POSITIVE_DRIVER_KEY_PREFIXES = ["near_hr_form_"] as const;

/**
 * Positive-direction driver keys as emitted by the July-20 tree (`749c148`).
 *
 * `pv_barrel` is included deliberately: it existed in July-20's
 * pitcherVulnerability.ts and would have counted had it fired. It never fired,
 * because the build layer passed `barrelAllowedPct: null` on every candidate.
 * The champion's pitcher policy suppresses it for the same reason today, so its
 * presence here is historically faithful and behaviorally inert.
 */
export const JUL20_POSITIVE_DRIVER_KEYS: ReadonlySet<string> = new Set([
  // batterPowerProfile.ts
  "power_iso",
  "power_barrel",
  "power_hardhit",
  "power_maxev",
  "power_hrfb",
  "power_pullair",
  // pitcherVulnerability.ts
  "pv_hr9",
  "pv_era",
  "pv_barrel",
  // matchupFit.ts
  "fit_platoon",
  "fit_ops_hand",
  "fit_pull_park",
  "fit_bvp",
  // parkWeatherScore.ts
  "pw_park",
  "pw_temp",
  "pw_wind_out",
  // lineupOpportunity.ts
  "lo_top",
  "lo_rbi",
  "lo_runenv",
  "lo_obp_ahead",
  // batterOrderSplit.ts / pitcherOrderSplit.ts
  "pos_batter_slot",
  "pos_order_vuln",
  // marketTagger.ts
  "mkt_hr",
  "mkt_tb",
  // nearHrRecentForm.ts (plus the `near_hr_form_*` prefix above)
  "near_hr_form_consecutive",
]);

/**
 * Positive-direction driver keys HEAD emits BEFORE `positiveDriverCount` is
 * frozen — i.e. the count the current production model actually observes.
 * Deliberately excludes every `atkenv_*` key: those are appended after the
 * freeze, so HEAD has never counted them and the challenger must not either.
 */
export const CURRENT_HEAD_POSITIVE_DRIVER_KEYS: ReadonlySet<string> = new Set([
  // Array.from — the project's TS target requires it for Set iteration.
  ...Array.from(JUL20_POSITIVE_DRIVER_KEYS),
  "fit_pitch_family", // ec8ae2d
  "pv_recent_era", // 7482c91
  "pv_short_rest", // 7482c91
]);

/**
 * Keys that reach NEITHER production driver count. Attack Environment is a
 * zero-weight tag layer; its drivers exist for UI explainability and shadow
 * research only.
 */
export const RESEARCH_ONLY_DRIVER_KEYS: ReadonlySet<string> = new Set([
  "atkenv_power_env",
  "atkenv_extra_base_env",
  "atkenv_weak_pitcher_park",
  "atkenv_weak_pitcher_carry",
  "atkenv_hostile",
]);

/**
 * Negative/neutral keys emitted anywhere in the build. Not counted by either
 * model (they are not `direction: "positive"`), but enumerated so the hygiene
 * check can prove every emitted key is accounted for rather than merely
 * un-matched.
 */
export const KNOWN_NON_POSITIVE_DRIVER_KEYS: ReadonlySet<string> = new Set([
  "power_low",
  "pv_stingy",
  "pv_recent_era_good",
  "fit_bvp_bad",
  "pw_cold",
  "pw_wind_in",
  "pw_park_pitcher",
  "pw_roof",
  "lo_bottom",
  "neg_batter_slot",
  "neg_order_suppress",
]);

function matchesPositivePrefix(key: string): boolean {
  return POSITIVE_DRIVER_KEY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Count positive drivers restricted to `allowedKeys`. The `direction` check and
 * the membership check are both required — a negative driver whose key happens
 * to be listed must never count.
 */
export function countPositiveDrivers(
  drivers: readonly PowerDriver[],
  allowedKeys: ReadonlySet<string>,
): number {
  let n = 0;
  for (const d of drivers) {
    if (d.direction !== "positive") continue;
    if (allowedKeys.has(d.key) || matchesPositivePrefix(d.key)) n++;
  }
  return n;
}

export type PlateDriverUniverse = "jul20_restored" | "current_head";

export function driverKeysForUniverse(universe: PlateDriverUniverse): ReadonlySet<string> {
  return universe === "jul20_restored"
    ? JUL20_POSITIVE_DRIVER_KEYS
    : CURRENT_HEAD_POSITIVE_DRIVER_KEYS;
}

/**
 * Classify a key for the hygiene test. Returns `"unclassified"` for any key the
 * maintainer has not deliberately placed, which the regression suite treats as
 * a failure.
 */
export function classifyDriverKey(
  key: string,
): "jul20_positive" | "current_head_positive" | "research_only" | "non_positive" | "unclassified" {
  if (JUL20_POSITIVE_DRIVER_KEYS.has(key) || matchesPositivePrefix(key)) return "jul20_positive";
  if (CURRENT_HEAD_POSITIVE_DRIVER_KEYS.has(key)) return "current_head_positive";
  if (RESEARCH_ONLY_DRIVER_KEYS.has(key)) return "research_only";
  if (KNOWN_NON_POSITIVE_DRIVER_KEYS.has(key)) return "non_positive";
  return "unclassified";
}
