// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — training-row bridge (PR 2).
//
// Reduces a STORED, durable PlateHrV2DerivedFeatureVectorV1 (the
// `derived_features` jsonb column read back out of plate_hr_v2_feature_snapshots)
// through math/'s real, tested scorers into fitShadowTermWeights.ts's
// ShadowHrTrainingRow shape. Deliberately does NOT use frozenPlateHrV2Input.ts's
// toPregameMathInputs() — that operates on the capture-time-only FrozenPlateHrV2Input,
// which is never itself persisted (only its hash is stored; its pieces live
// loosely-typed inside rawInputs.families, preservation/audit-only). The only
// durably-typed, validated shape available to a script reading snapshots back
// out of Postgres is the derived feature vector, so this file reconstructs
// PregameMathInputs from that instead.
//
// Calls math/buildPregameHrPerPa directly — never math/mathDiagnostics'
// runPregameMathModel — because the fitter's contract (ShadowHrTrainingRow.terms)
// operates one level below the full game-probability pipeline: raw per-PA
// component log-odds terms, not the PA-distribution-marginalized game
// probability. math/ itself is imported as a library, never modified.
// ─────────────────────────────────────────────────────────────────────────────

import { buildPregameHrPerPa } from "../math/buildPregameHrPerPa";
import type { PregameMathInputs, PitchFamilyDatum } from "../math/mathTypes";
import type { ShadowHrTrainingRow } from "../math/fitShadowTermWeights";
import type { PlateHrV2DerivedFeatureVectorV1 } from "./plateHrV2FeatureContract";

/**
 * The 9 buildPregameHrPerPa LogOddsTerm keys, plus the 10th
 * (availabilitySuppressors, folded in sign-flipped so every key shares one
 * "positive = more HR-likely" convention) — confirmed directly against every
 * score*.ts file's own `key:` return value, NOT assumed from the input-group
 * field names (three of them differ: starterBullpenPath != starterBullpen,
 * marketConfirmation != market, availabilitySuppressors != availability).
 */
export const PLATE_HR_V2_SHADOW_TERM_KEYS: readonly string[] = [
  "batterPower",
  "batTracking",
  "pitcherVulnerability",
  "pitchType",
  "zoneLocation",
  "parkWeatherSpray",
  "lineupOpportunity",
  "starterBullpenPath",
  "marketConfirmation",
  "availabilitySuppressors",
] as const;

function pitchFamilyDatum(
  family: PitchFamilyDatum["family"],
  leaf: { usageShare: number | null; batterXslg: number | null; batterWhiffPct: number | null; batterSampleSwings: number | null },
): PitchFamilyDatum {
  return {
    family,
    usageShare: leaf.usageShare,
    batterXslg: leaf.batterXslg,
    batterWhiffPct: leaf.batterWhiffPct,
    // Stored contract's batterSampleSwings -> math/'s native batterSample.
    batterSample: leaf.batterSampleSwings,
  };
}

/**
 * Reconstruct math/'s native PregameMathInputs shape from a durably-stored
 * derived feature vector. Every group destructures-and-drops `extra` (the
 * stored contract's escape hatch, absent from math/'s native types) rather
 * than spreading, since a plain `{ ...derived.batterPower }` spread would
 * fail the excess-property check when assigned into a BatterTruePowerInputs-
 * typed slot — destructuring produces a variable, not a fresh object
 * literal, so no such check applies and `extra` is genuinely gone from its type.
 */
export function derivedFeatureVectorToPregameMathInputs(
  derived: PlateHrV2DerivedFeatureVectorV1,
  ids: { playerId: string; gameId: string },
): PregameMathInputs {
  const { extra: _batterPowerExtra, ...batterPower } = derived.batterPower;
  const { extra: _batTrackingExtra, ...batTracking } = derived.batTracking;
  const { extra: _pitcherExtra, ...pitcherVulnerability } = derived.pitcherVulnerability;
  const { extra: _zoneExtra, ...zoneLocation } = derived.zoneLocation;
  const { extra: _parkExtra, ...parkWeatherSpray } = derived.parkWeatherSpray;
  const { extra: _lineupExtra, ...lineupOpportunity } = derived.lineupOpportunity;
  const { extra: _bullpenExtra, ...starterBullpen } = derived.starterBullpen;
  const { extra: _marketExtra, ...market } = derived.market;
  const { extra: _availabilityExtra, ...availability } = derived.availability;

  return {
    playerId: ids.playerId,
    gameId: ids.gameId,
    batterHand: derived.pitcherVulnerability.batterHand,
    batterPower,
    batTracking,
    pitcherVulnerability,
    pitchType: {
      families: [
        pitchFamilyDatum("fastball", derived.pitchType.fastball),
        pitchFamilyDatum("breaking", derived.pitchType.breaking),
        pitchFamilyDatum("offspeed", derived.pitchType.offspeed),
      ],
    },
    zoneLocation,
    parkWeatherSpray,
    lineupOpportunity,
    starterBullpen,
    market,
    availability,
    slateBaselineGameHrProbability: derived.slateBaselineGameHrProbability,
  };
}

/**
 * Run the stored derived features through math/'s real component scorers and
 * reduce the resulting LogOddsTerm[] + suppressor penalty into the flat
 * Record<string, number> shape fitShadowTermWeights.ts's ShadowHrTrainingRow
 * expects, keyed by each term's own `.key` (never re-derived from the input-
 * group field name — see PLATE_HR_V2_SHADOW_TERM_KEYS's comment on why that
 * would be wrong for 3 of the 10 keys).
 */
export function buildShadowTermsFromDerivedFeatures(
  derived: PlateHrV2DerivedFeatureVectorV1,
  ids: { playerId: string; gameId: string },
): Record<string, number | null | undefined> {
  const inputs = derivedFeatureVectorToPregameMathInputs(derived, ids);
  const result = buildPregameHrPerPa(inputs);
  const terms: Record<string, number | null | undefined> = {};
  for (const term of result.terms) terms[term.key] = term.logOdds;
  // Sign-flipped so every key shares one "positive = more HR-likely"
  // convention — the suppressor is a penalty (subtracted from the logit),
  // so a positive penalty must become a negative contribution here.
  terms.availabilitySuppressors = -result.suppressorPenalty;
  return terms;
}

/** Build one (frozenAt, homered, terms) training row for the fitter. */
export function buildShadowHrTrainingRow(args: {
  derivedFeatures: PlateHrV2DerivedFeatureVectorV1;
  playerId: string;
  gameId: string;
  /** ISO timestamp — use the snapshot's own predictionAsOf (PR1's canonical training-observation timestamp), not capture/label time. */
  frozenAt: string;
  hitHrToday: boolean;
}): ShadowHrTrainingRow {
  return {
    frozenAt: args.frozenAt,
    homered: args.hitHrToday ? 1 : 0,
    terms: buildShadowTermsFromDerivedFeatures(args.derivedFeatures, { playerId: args.playerId, gameId: args.gameId }),
  };
}
