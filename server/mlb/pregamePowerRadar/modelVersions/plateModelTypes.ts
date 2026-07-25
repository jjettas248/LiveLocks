// The Plate — versioned model contract (champion / challenger).
//
// The champion is the July-20 DECISION POLICY, restored. It is deliberately NOT
// a byte-for-byte July-20 build: it keeps the post-July-20 BvP sample
// discipline, the Open-Meteo weather fallback, corrected pitcher-handedness
// handling, and every grading/persistence improvement. Hence "restored", not
// "champion" — the version string must not claim more than the model delivers.

import type { PregamePowerTier } from "../types";
import type { ScoringResult } from "../scoring";
import type { AttackEnvironmentResult } from "../attackEnvironment";
import type { PregamePowerActiveMarket } from "../marketTagger";
import type { PlateDriverUniverse } from "./plateDriverUniverse";

export const PLATE_CHAMPION_VERSION = "plate_jul20_restored_v1" as const;
export const PLATE_CHALLENGER_VERSION = "plate_current_shadow_v1" as const;

/**
 * The ONLY behaviors that differ between models. Shared ingestion, shared
 * feature computation, shared component scorers — only policy is forked.
 */
export interface PlateModelPolicy {
  version: string;
  batter: {
    /** Post-July-20 batted-ball-event shrinkage toward neutral. */
    applySampleShrinkage: boolean;
    /** Score returned when no core power input is present. July-20 used 0. */
    unavailableScore: 0 | 5;
  };
  pitcher: {
    /** barrel/hard-hit/fly-ball allowed legs + the pv_barrel driver. */
    useContactAllowed: boolean;
    /** last-3-start ERA leg + pv_recent_era / pv_recent_era_good drivers. */
    useRecentForm: boolean;
    /** days-since-last-start leg + pv_short_rest driver. */
    useRestDays: boolean;
  };
  gates: {
    /** Attack Environment participates in classifyTier + borderline suppression. */
    attackEnvironmentGates: boolean;
    /** Independent evidence-family minimum participates in insufficient_drivers. */
    evidenceFamilyGate: boolean;
  };
  availability: {
    /** batterPowerAvailable additionally requires savant quality === "full". */
    strictBatterQuality: boolean;
    /** parkAvailable requires a resolved venue, not merely a park factor. */
    strictVenueResolution: boolean;
  };
  drivers: { universe: PlateDriverUniverse };
}

/**
 * Explicit per-model flags recording WHICH policy branches actually engaged on
 * this candidate. Delta attribution reads these directly — it never infers a
 * cause from final scores.
 */
export interface PlateEvaluationFlags {
  usedPitcherContactFeatures: boolean;
  usedPitcherRecentForm: boolean;
  usedPitcherRestDays: boolean;
  appliedBatterSampleShrinkage: boolean;
  attackEnvironmentGateEngaged: boolean;
  evidenceFamilyGateEngaged: boolean;
  strictAvailabilityEngaged: boolean;
  driverUniverse: PlateDriverUniverse;
}

export interface PlateComponentScores {
  batterPowerScore: number;
  pitcherVulnerabilityScore: number;
  matchupFitScore: number;
  parkWeatherScore: number;
  lineupOpportunityScore: number;
  nearHrRecentFormScore: number;
}

/** Signal-level context the publication decision needs but scoring does not own. */
export interface PlatePublicationContext {
  lineupStatus: string;
  isOfficialPlay: boolean;
  isPregameTarget: boolean;
}

export interface PlatePublicationResult {
  publicEligible: boolean;
  ineligibleReasons: string[];
}

export interface PlateModelEvaluation {
  modelVersion: string;
  components: PlateComponentScores;
  scoring: ScoringResult;
  tier: PregamePowerTier;
  score10: number;
  suppressed: boolean;
  suppressedReasons: string[];
  primaryMarket: PregamePowerActiveMarket;
  positiveDriverCount: number;
  evidenceFamilyCount: number;
  attackEnvironment: AttackEnvironmentResult;
  /**
   * Explicit publication decision. Callers must read this — never re-derive
   * publication from `!suppressed`, which is a strictly weaker condition.
   */
  publicEligible: boolean;
  publicIneligibleReasons: string[];
  flags: PlateEvaluationFlags;
}
