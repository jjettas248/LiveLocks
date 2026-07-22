// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research module — public surface.
//
// PR 1 landed the contracts + flags only (no runtime call site). PR 2 adds
// the first live call site: population-complete, event-driven evaluation
// capture (feature builder, epoch detector, eligibility evaluator, bounded
// write queue, sampling, diagnostics, and the capture orchestration entry
// point liveGameOrchestrator.ts calls). Labeling/reconciliation, model
// training/inference, and shadow predictions/decisions remain future PRs.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./hrFeatureContract";
export * from "./hrEligibilityContract";
export * from "./hrTriggerContract";
export * from "./hrLabelContract";
export * from "./hrModelArtifactContract";
export * from "./hrStagePolicyContract";
export * from "./hrRadarResearchFlags";
export * from "./hrEvaluationEpochId";
export * from "./hrEvaluationEpochDetector";
export * from "./hrEligibilityEvaluator";
export * from "./hrFeatureHash";
export * from "./hrEvalCaptureSampling";
export * from "./hrFeatureBuilder";
export * from "./hrEvaluationWriteQueue";
export * from "./hrEvalCaptureDiagnostics";
export * from "./hrEvaluationCapture";
