// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW leakage contract
//
// Pure, dependency-free guards that enforce the "pre-first-pitch information
// only" rule for the v2 math core. No I/O, no engine imports.
//
// The contract:
//   • A v2 prediction must be LOCKED before first pitch.
//   • No live-only feature may feed the math (current-game EV / launch angle /
//     barrel / hard-hit count / pitch count / count / base-out / inning / live
//     pitcher decay / live wind / live spray / live Statcast events).
//   • Helpers never throw on partial/empty rows — they degrade to warnings.
//     (`assertPregameFeatureAllowed` is the ONE intentional throw, used only when
//     a caller explicitly asserts a single feature is pregame-legal.)
// ─────────────────────────────────────────────────────────────────────────────

import type { FeatureProvenance } from "./mathTypes";

/**
 * Canonical live-only feature substrings. Matching is case-insensitive and
 * substring-based against a normalized name so `currentGameBarrelCount`,
 * `current_game_barrel`, and `liveBarrel` all resolve to the same rule.
 *
 * These are the fields the task forbids: anything describing the CURRENT game's
 * in-progress state. Season / career / pre-first-pitch aggregates are allowed.
 */
export const LIVE_ONLY_FEATURE_PATTERNS: readonly string[] = [
  // current-game Statcast batted-ball outcomes
  "currentgameev",
  "currentgamelaunchangle",
  "currentgamebarrel",
  "currentgamehardhit",
  "currentgamespray",
  "currentgamestatcast",
  "currentgameexitvelocity",
  // live pitch / count / situation state
  "currentpitchcount",
  "pitchcountcurrent",
  "currentcount",
  "currentballs",
  "currentstrikes",
  "currentbaseout",
  "currentbasestate",
  "currentouts",
  "currentinning",
  "liveinning",
  "currentscore",
  "livescore",
  // live pitcher deterioration / command decay
  "livepitcherdeterioration",
  "livecommanddecay",
  "livevelocitydrop",
  "livepitcherfatigue",
  // live environment
  "livewind",
  "currentwind",
  "windshiftlive",
  // generic live markers
  "liveev",
  "livelaunchangle",
  "livebarrel",
  "livehardhit",
  "livespray",
  "livestatcast",
  "ingame",
  "inplaylive",
] as const;

/** Phase markers that indicate a value is from the in-progress game. */
const LIVE_PHASE = "live";

/** Normalize a feature name for matching: lowercased, alnum only. */
function normalizeName(name: string): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * True when a feature name denotes live (current-game, in-progress) data and is
 * therefore forbidden in the pregame model. Pure; never throws.
 */
export function isLiveOnlyFeatureName(name: string): boolean {
  const norm = normalizeName(name);
  if (!norm) return false;
  return LIVE_ONLY_FEATURE_PATTERNS.some((p) => norm.includes(p));
}

/**
 * True when the prediction was locked strictly before (or at) first pitch.
 * If either timestamp is missing or unparseable, returns `false` — callers
 * should pair this with `buildLeakageWarnings` to surface the missing-timestamp
 * warning rather than silently trusting the row.
 */
export function isPredictionBeforeFirstPitch(
  predictionGeneratedAtISO: string | null | undefined,
  firstPitchTimeISO: string | null | undefined,
): boolean {
  const pred = Date.parse(String(predictionGeneratedAtISO ?? ""));
  const fp = Date.parse(String(firstPitchTimeISO ?? ""));
  if (!Number.isFinite(pred) || !Number.isFinite(fp)) return false;
  return pred <= fp;
}

/** Error thrown only by `assertPregameFeatureAllowed`. */
export class PregameLeakageError extends Error {
  constructor(public readonly featureName: string) {
    super(`[PREGAME_LEAKAGE] live-only feature not allowed in pregame model: "${featureName}"`);
    this.name = "PregameLeakageError";
  }
}

/**
 * Assert a single named feature is pregame-legal. Throws `PregameLeakageError`
 * for a live-only name. Use this at explicit feature-ingest sites; for bulk
 * filtering use `filterLeakyFeatures` (non-throwing).
 */
export function assertPregameFeatureAllowed(name: string): void {
  if (isLiveOnlyFeatureName(name)) {
    throw new PregameLeakageError(name);
  }
}

/**
 * Partition a list of feature provenances into allowed (pregame-safe) vs.
 * rejected (live-only by name, or explicitly phase==="live"). Never throws —
 * a partial/empty list yields empty partitions.
 */
export function filterLeakyFeatures(
  features: ReadonlyArray<FeatureProvenance> | null | undefined,
): { allowed: FeatureProvenance[]; rejected: FeatureProvenance[] } {
  const allowed: FeatureProvenance[] = [];
  const rejected: FeatureProvenance[] = [];
  if (!Array.isArray(features)) return { allowed, rejected };
  for (const f of features) {
    if (!f || typeof f.name !== "string") continue;
    const live = isLiveOnlyFeatureName(f.name) || f.phase === LIVE_PHASE;
    (live ? rejected : allowed).push(f);
  }
  return { allowed, rejected };
}

/**
 * Build human-readable leakage warnings for a feature set + prediction window.
 * Pure and total: missing timestamps and empty inputs produce warnings, not
 * exceptions. Returns an empty array when everything checks out.
 */
export function buildLeakageWarnings(args: {
  predictionGeneratedAtISO?: string | null;
  firstPitchTimeISO?: string | null;
  features?: ReadonlyArray<FeatureProvenance> | null;
}): string[] {
  const warnings: string[] = [];

  const { predictionGeneratedAtISO, firstPitchTimeISO, features } = args ?? {};

  // Timestamp window checks.
  const predParsed = Number.isFinite(Date.parse(String(predictionGeneratedAtISO ?? "")));
  const fpParsed = Number.isFinite(Date.parse(String(firstPitchTimeISO ?? "")));
  if (!predParsed) warnings.push("missing_or_invalid_prediction_timestamp");
  if (!fpParsed) warnings.push("missing_or_invalid_first_pitch_timestamp");
  if (predParsed && fpParsed && !isPredictionBeforeFirstPitch(predictionGeneratedAtISO, firstPitchTimeISO)) {
    warnings.push("prediction_locked_after_first_pitch");
  }

  // Feature-level checks.
  const { rejected } = filterLeakyFeatures(features);
  for (const f of rejected) {
    warnings.push(`live_only_feature:${f.name}`);
  }

  // Per-feature post-first-pitch timestamp check (a season feature stamped with
  // a post-first-pitch time is suspicious).
  if (Array.isArray(features) && fpParsed) {
    const fp = Date.parse(String(firstPitchTimeISO));
    for (const f of features) {
      if (!f || typeof f.valueTimestamp !== "string") continue;
      const t = Date.parse(f.valueTimestamp);
      if (Number.isFinite(t) && t > fp) {
        warnings.push(`feature_timestamp_after_first_pitch:${f.name}`);
      }
    }
  }

  return warnings;
}
