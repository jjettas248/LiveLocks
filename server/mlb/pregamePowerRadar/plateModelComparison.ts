// The Plate — champion vs challenger comparison record.
//
// Pure builder. Produces the record persisted under diagnostics.modelComparison
// and read by the admin comparison endpoint. It never touches the production
// signal's score, tier, suppression, or publication.
//
// Two decisions this file is careful about:
//
//  1. `publicDecisionChanged` compares the two explicit PER-BUILD `publicEligible`
//     values. Durable A/B accounting is a different question and uses the sticky
//     `everPubliclyEligible` pair — the two must never be substituted for one
//     another.
//
//  2. Attribution reads explicit evaluation flags, never final scores. A cause
//     is only listed when the corresponding branch actually engaged for exactly
//     one of the two models. `bvp_policy` is deliberately absent: both models
//     run the identical sample-disciplined BvP path, so BvP cannot explain a
//     disagreement today. It becomes a legitimate value only if a future change
//     genuinely forks that behavior.

import type { PlateModelEvaluation } from "./modelVersions/plateModelTypes";
import { PLATE_CHAMPION_VERSION, PLATE_CHALLENGER_VERSION } from "./modelVersions/plateModelTypes";

export type PlateDeltaAttribution =
  | "pitcher_contact_features"
  | "pitcher_recent_form"
  | "pitcher_rest"
  | "batter_sample_shrinkage"
  | "attack_environment_gate"
  | "evidence_family_gate"
  | "driver_universe"
  | "data_quality_policy"
  | "other";

export interface PlateModelSideRecord {
  score10: number;
  tier: string;
  suppressed: boolean;
  suppressedReasons: string[];
  primaryMarket: string;
  pitcherVulnerabilityScore: number | null;
  batterPowerScore: number | null;
  positiveDriverCount: number;
  evidenceFamilyCount: number;
  /** This build only. */
  publicEligible: boolean;
  publicIneligibleReasons: string[];
}

/**
 * The challenger's exposure is sticky, mirroring the champion's
 * `everPubliclyFlagged`. Without this, a challenger call that surfaces at noon
 * and dips below threshold by 4pm would be scored as "never called" — which
 * would understate the challenger and make the whole A/B dishonest.
 */
export interface PlateChallengerRecord extends PlateModelSideRecord {
  everPubliclyEligible: boolean;
  firstPublicEligibleAt: string | null;
}

export interface PlateShadowComparison {
  championVersion: string;
  challengerVersion: string;
  frozenInputHash: string;
  champion: PlateModelSideRecord;
  challenger: PlateChallengerRecord;
  delta: {
    score10: number;
    /** Per-build disagreement — NOT the durable A/B measure. */
    publicDecisionChanged: boolean;
    tierChanged: boolean;
    marketChanged: boolean;
  };
  attribution: PlateDeltaAttribution[];
}

/** Recorded when the challenger did not run, so "absent" is never read as "declined". */
export interface PlateChallengerUnavailable {
  championVersion: string;
  challengerVersion: string;
  frozenInputHash: string;
  challengerUnavailable: "disabled" | "failed" | "inputs_missing";
}

export type PlateModelComparisonRecord = PlateShadowComparison | PlateChallengerUnavailable;

export function isComparisonAvailable(
  r: PlateModelComparisonRecord | null | undefined,
): r is PlateShadowComparison {
  return r != null && !("challengerUnavailable" in r);
}

function sideRecord(ev: PlateModelEvaluation): PlateModelSideRecord {
  return {
    score10: ev.score10,
    tier: ev.tier,
    suppressed: ev.suppressed,
    suppressedReasons: ev.suppressedReasons.slice(),
    primaryMarket: ev.primaryMarket,
    pitcherVulnerabilityScore: ev.components.pitcherVulnerabilityScore,
    batterPowerScore: ev.components.batterPowerScore,
    positiveDriverCount: ev.positiveDriverCount,
    evidenceFamilyCount: ev.evidenceFamilyCount,
    publicEligible: ev.publicEligible,
    publicIneligibleReasons: ev.publicIneligibleReasons.slice(),
  };
}

/**
 * A cause is attributed when the branch engaged for exactly one model. XOR, not
 * OR: a branch both models took cannot explain why they disagreed.
 */
export function attributeDelta(
  champion: PlateModelEvaluation,
  challenger: PlateModelEvaluation,
): PlateDeltaAttribution[] {
  const out: PlateDeltaAttribution[] = [];
  const xor = (a: boolean, b: boolean) => a !== b;
  const f = champion.flags;
  const g = challenger.flags;

  if (xor(f.usedPitcherContactFeatures, g.usedPitcherContactFeatures)) out.push("pitcher_contact_features");
  if (xor(f.usedPitcherRecentForm, g.usedPitcherRecentForm)) out.push("pitcher_recent_form");
  if (xor(f.usedPitcherRestDays, g.usedPitcherRestDays)) out.push("pitcher_rest");
  if (xor(f.appliedBatterSampleShrinkage, g.appliedBatterSampleShrinkage)) out.push("batter_sample_shrinkage");
  if (xor(f.attackEnvironmentGateEngaged, g.attackEnvironmentGateEngaged)) out.push("attack_environment_gate");
  if (xor(f.evidenceFamilyGateEngaged, g.evidenceFamilyGateEngaged)) out.push("evidence_family_gate");
  if (xor(f.strictAvailabilityEngaged, g.strictAvailabilityEngaged)) out.push("data_quality_policy");
  if (champion.positiveDriverCount !== challenger.positiveDriverCount) out.push("driver_universe");

  return out;
}

export function buildPlateModelComparison(
  champion: PlateModelEvaluation,
  challenger: PlateModelEvaluation,
  frozenInputHash: string,
  prev: PlateModelComparisonRecord | null | undefined,
  nowIso: string,
): PlateShadowComparison {
  const disagreed =
    champion.publicEligible !== challenger.publicEligible ||
    champion.tier !== challenger.tier ||
    champion.primaryMarket !== challenger.primaryMarket ||
    champion.score10 !== challenger.score10;

  const attribution = attributeDelta(champion, challenger);
  // A real disagreement must always be explainable. If no explicit flag differs
  // we say "other" rather than presenting an unexplained delta as attributed.
  if (disagreed && attribution.length === 0) attribution.push("other");

  const prevChallenger = isComparisonAvailable(prev) ? prev.challenger : null;
  const everPubliclyEligible = (prevChallenger?.everPubliclyEligible ?? false) || challenger.publicEligible;
  const firstPublicEligibleAt =
    prevChallenger?.firstPublicEligibleAt ?? (challenger.publicEligible ? nowIso : null);

  return {
    championVersion: PLATE_CHAMPION_VERSION,
    challengerVersion: PLATE_CHALLENGER_VERSION,
    frozenInputHash,
    champion: sideRecord(champion),
    challenger: { ...sideRecord(challenger), everPubliclyEligible, firstPublicEligibleAt },
    delta: {
      score10: Math.round((challenger.score10 - champion.score10) * 10) / 10,
      publicDecisionChanged: champion.publicEligible !== challenger.publicEligible,
      tierChanged: champion.tier !== challenger.tier,
      marketChanged: champion.primaryMarket !== challenger.primaryMarket,
    },
    attribution,
  };
}

/** True when the delta is worth a log line — never log unchanged candidates. */
export function shouldLogPlateDelta(c: PlateShadowComparison): boolean {
  return c.delta.publicDecisionChanged || c.delta.tierChanged || c.delta.marketChanged;
}
