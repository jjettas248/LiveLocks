// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research module — public surface (PR 1, contracts-only).
//
// Barrel re-export of every contract + the flags module. No logic of its own
// yet — there is no runtime call site in this PR (no capture, no labeling,
// no inference, no champion/runtime/UI wiring). PR 2+ imports from here.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./hrFeatureContract";
export * from "./hrEligibilityContract";
export * from "./hrTriggerContract";
export * from "./hrLabelContract";
export * from "./hrModelArtifactContract";
export * from "./hrStagePolicyContract";
export * from "./hrRadarResearchFlags";
