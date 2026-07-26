// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — forbidden training-feature guard (PR 1).
//
// Metadata that is legitimately persisted for comparison purposes — champion/
// challenger output, market pricing, outcome/label fields — must never later
// leak into a training feature matrix, without depending on every future PR2
// author remembering not to include it. This file names that boundary once,
// in a shared, importable place, so it can be enforced structurally rather
// than by convention.
//
// This is a PR1 deliverable, not a PR2 one: the feature-vector schema
// (plateHrV2FeatureContract.ts) already cannot contain these fields, because
// they live only as sibling columns on plate_hr_v2_feature_snapshots /
// plate_hr_v2_labels, never inside the derived_features jsonb itself — see
// plateHrV2Leakage.test.ts for the structural proof. Whether a specific
// legitimate feature-group value (e.g. something inside `market`) should ever
// be excluded from PR2's particular fitted model is a modeling decision for
// PR2, not a leakage question for PR1 — this file exists so that decision has
// a named, enforceable place to live.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE on `market`: math/'s own architecture (mathTypes.ts's
// MarketConfirmationInputs, inherited unchanged by this V2 contract's
// `market` group) already sanctions HR-odds-derived numbers as a bounded,
// "confirm/rank only, never creates a candidate" input — the same group
// scoreMarketConfirmation.ts consumes. Bare names that collide with that
// group's OWN legitimate leaves (`impliedHrProbability`,
// `noVigImpliedHrProbability`) are deliberately NOT on this list — banning
// them here would contradict a feature group this contract already commits
// to supporting. `marketProbability`/`marketOdds` (generic names that do NOT
// collide with any declared leaf) stay listed as a placeholder for whatever
// PR2's specific training-matrix flattener chooses to call a raw market
// price it decides to exclude — see plateHrV2FeatureContract.ts's `market`
// schema for the fields actually stored today.
export const PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES: readonly string[] = [
  // champion/challenger output — comparison-only, never a training feature
  "championModelVersion",
  "championScore10",
  "championTier",
  "championSuppressed",
  "challengerModelVersion",
  "challengerScore10",
  "challengerTier",
  "challengerSuppressed",
  // generic market-price placeholder — see NOTE above
  "marketProbability",
  "marketOdds",
  // publication/eligibility metadata — describes the champion's own gating,
  // not a baseball fact about the candidate
  "publicEligible",
  "isOfficialPlay",
  // outcome/label fields — these are what the model predicts, never an input
  "hitHrToday",
  "hrCountToday",
  "paCountObserved",
  "hrEventId",
  "labelDisposition",
] as const;

/**
 * Throws if any of the given leaf names appears on the forbidden list. Pure;
 * intended for use in a build-time/test-time structural sweep over a fully
 * enumerated feature-vector fixture — never called on a hot path.
 */
export function assertNoForbiddenTrainingFeatures(featureLeafNames: readonly string[]): void {
  const hit = featureLeafNames.find((name) => PLATE_HR_V2_FORBIDDEN_TRAINING_FEATURES.includes(name));
  if (hit) {
    throw new Error(`[PLATE_HR_V2_FORBIDDEN_FEATURE] "${hit}" must never enter the training feature matrix`);
  }
}
