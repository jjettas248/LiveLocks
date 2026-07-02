/**
 * HR Radar Live — runtime contract gates.
 *
 * HR Radar Live is a LIVE event-based engine: it answers "based on what is
 * happening right now in this game, who is becoming live for a home run?".
 * It must surface and promote batters from in-game evidence only (exit velo,
 * launch angle, distance, barrels, hard-hit count, deep flyouts, pitcher
 * fatigue, etc.) — never from a pregame power score, slate ranking, simulated
 * HR probability, or any "Power Prior".
 *
 * This module is intentionally dependency-free so the gate can be unit-tested
 * without importing the live orchestrator. It is a CONTRACT, not an engine —
 * it adds no scoring, no stages, and no second HR Radar.
 */

/**
 * No-AB "pregame seed" gate.
 *
 * The orchestrator previously initialized HR Radar Track rows for batters with
 * ZERO live plate appearances from pregame priors (park factor, wind, pitcher
 * ERA, BvP HR history, hot-streak). Those rows are not "live event" evidence —
 * they describe a pregame setup, not what is happening in the game right now —
 * so by the HR Radar Live product definition they should not surface.
 *
 * Gated OFF by default so HR Radar Live stays strictly live-evidence-driven.
 * Set `HR_RADAR_PREGAME_SEED` to true/1/on/yes to re-enable (e.g. to A/B the
 * first-AB-HR coverage the seed was originally added to improve).
 *
 * Note: seeded rows are always Track — they were never graded (FIRE-only
 * official record), so this gate never changes the official W/L history.
 */
export function isHrRadarPregameSeedEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.HR_RADAR_PREGAME_SEED ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

/**
 * Pregame HR-prior promotion gate (spec §2.3, 2026-07).
 *
 * Sibling to the seed gate above and independently toggleable: when a
 * presence-floor row's `computePregameHrPriorScore` reaches the Lean
 * threshold (priorScore>=0.78 + inning>=6 + bullpen vulnerability>=0.65), the
 * row's canonical stage is lifted from "watch" (Watchlist) to "building"
 * (Lean) instead of staying pinned at Watchlist. This is STILL coverage-only
 * — it can never reach "attack"/"building"→"ready" promotion on its own — so
 * it never touches the FIRE-only official W/L record, same invariant as the
 * seed gate above. Gated OFF by default until rollout is confirmed safe.
 * Set `HR_RADAR_PREGAME_PRIOR_PROMOTION` to true/1/on/yes to enable.
 */
export function isHrRadarPregamePriorPromotionEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.HR_RADAR_PREGAME_PRIOR_PROMOTION ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}
