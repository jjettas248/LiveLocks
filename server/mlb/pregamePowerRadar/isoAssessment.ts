// The Plate — canonical Isolated Power (ISO) assessment.
//
// One server-owned, pure, typed classifier for TRUE per-AB isolated power. It is
// the single authority for the ISO DISPLAY tier/label — it deliberately does NOT
// feed score10 (the champion's backtested score still consumes the separate
// on-contact expected-power proxy; see batterPowerProfile.ts). Modeling and
// labeling are separate decisions: the model may use power inputs continuously
// even when no ISO label is displayed.
//
// Canonical raw formula:  ISO = SLG − AVG   (or, from coherent counting stats on
// a SINGLE denominator:   ISO = (2B + 2·3B + 3·HR) / AB). Stats from different
// samples/denominators must never be combined — see isoFromCountingStats.
//
// Fail-closed by construction: missing, malformed, out-of-range (e.g. a
// percentage-scale 24 / 240), unsampled, or fallback-only inputs can never
// produce an ELITE tier.

import {
  ISO_ASSESSMENT_VERSION,
  ISO_AVERAGE_MIN,
  ISO_ELITE_MIN,
  ISO_ELITE_MIN_SAMPLE_AB,
  ISO_MAX_VALID,
  ISO_MIN_VALID,
  ISO_RELIABILITY_FLOOR,
  ISO_STABILIZATION_AB,
  ISO_STRONG_MIN,
  ISO_STRONG_MIN_SAMPLE_AB,
  LEAGUE_PRIOR_ISO,
} from "./isoAssessmentConfig";

export type IsoTier = "ELITE" | "STRONG" | "AVERAGE" | "WEAK" | "UNAVAILABLE";

export type IsoSource =
  | "current_split" // rate stats for the matchup-relevant handedness split
  | "current_overall" // rate stats, overall (no usable split)
  | "prior_blend" // small sample, heavily regressed to the league prior
  | "league_fallback"; // no player-specific evidence — NEVER elite-eligible

export interface IsoAssessment {
  rawIso: number | null;
  adjustedIso: number | null;
  split: "vs_lhp" | "vs_rhp" | "overall";
  sampleAB: number;
  effectiveSampleAB: number;
  source: IsoSource;
  /** Null: no stable same-population percentile source is wired yet. */
  percentile: number | null;
  reliability: number;
  tier: IsoTier;
  eliteEligible: boolean;
  reasons: string[];
}

export interface IsoAssessmentInputs {
  /** True per-AB ISO on the decimal scale (SLG − AVG). */
  rawIso: number | null;
  /** At-bats (AB) backing rawIso — the ISO denominator. A rate with no valid sample is never elite-eligible. */
  sampleAB: number | null;
  split: "vs_lhp" | "vs_rhp" | "overall";
  source: IsoSource;
}

export const ISO_VERSION = ISO_ASSESSMENT_VERSION;

/** True ISO from rate stats. Both must share the same AB denominator upstream. */
export function isoFromRateStats(slg: number, avg: number): number {
  return slg - avg;
}

/**
 * True ISO from counting stats on ONE common denominator (AB). Returns null if
 * any input is non-finite or AB <= 0 — it never silently blends samples, and it
 * is the caller's responsibility to pass counts that share `ab`.
 */
export function isoFromCountingStats(input: {
  ab: number;
  doubles: number;
  triples: number;
  homeRuns: number;
}): number | null {
  const { ab, doubles, triples, homeRuns } = input;
  if (![ab, doubles, triples, homeRuns].every((v) => Number.isFinite(v))) return null;
  if (ab <= 0) return null;
  return (doubles + 2 * triples + 3 * homeRuns) / ab;
}

function classifyTier(adjustedIso: number): IsoTier {
  if (adjustedIso >= ISO_ELITE_MIN) return "ELITE";
  if (adjustedIso >= ISO_STRONG_MIN) return "STRONG";
  if (adjustedIso >= ISO_AVERAGE_MIN) return "AVERAGE";
  return "WEAK";
}

function unavailable(
  split: IsoAssessmentInputs["split"],
  source: IsoSource,
  sampleAB: number,
  reason: string,
): IsoAssessment {
  return {
    rawIso: null,
    adjustedIso: null,
    split,
    sampleAB: Number.isFinite(sampleAB) && sampleAB > 0 ? sampleAB : 0,
    effectiveSampleAB: 0,
    source,
    percentile: null,
    reliability: 0,
    tier: "UNAVAILABLE",
    eliteEligible: false,
    reasons: [reason],
  };
}

/**
 * Assess true ISO into a tier + reliability + elite-eligibility. Pure; never
 * throws. Any invalid/insufficient/fallback input resolves to UNAVAILABLE (or a
 * valid-but-not-eligible tier), never to a spurious elite claim.
 */
export function assessIso(inputs: IsoAssessmentInputs): IsoAssessment {
  const { rawIso, sampleAB, split, source } = inputs;

  // ── Validation / fail-closed ──────────────────────────────────────────────
  if (rawIso == null || !Number.isFinite(rawIso)) {
    return unavailable(split, source, sampleAB ?? 0, "iso_missing_or_nonfinite");
  }
  // Out-of-range guards catch percentage-scale (24, 240), negatives, and other
  // malformed values. A blank string coerced to 0 elsewhere would land here as a
  // valid-but-WEAK 0, not as elite — and a genuine 0 ISO is legitimately WEAK.
  if (rawIso < ISO_MIN_VALID || rawIso > ISO_MAX_VALID) {
    return unavailable(split, source, sampleAB ?? 0, "iso_out_of_range");
  }
  if (sampleAB == null || !Number.isFinite(sampleAB) || sampleAB <= 0) {
    return unavailable(split, source, 0, "no_valid_sample");
  }

  // ── Shrinkage toward the league prior ─────────────────────────────────────
  const effectiveSampleAB = sampleAB;
  const reliability = effectiveSampleAB / (effectiveSampleAB + ISO_STABILIZATION_AB);
  const adjustedIso = reliability * rawIso + (1 - reliability) * LEAGUE_PRIOR_ISO;

  const tier = classifyTier(adjustedIso);
  const reasons: string[] = [`source:${source}`, `reliability:${reliability.toFixed(2)}`];

  // ── Elite eligibility (the promotional-label gate) ────────────────────────
  const nonFallbackSource = source !== "league_fallback";
  const eliteEligible =
    tier === "ELITE" &&
    nonFallbackSource &&
    reliability >= ISO_RELIABILITY_FLOOR &&
    sampleAB >= ISO_ELITE_MIN_SAMPLE_AB;

  if (tier === "ELITE" && !eliteEligible) {
    if (!nonFallbackSource) reasons.push("elite_blocked:league_fallback");
    if (reliability < ISO_RELIABILITY_FLOOR) reasons.push("elite_blocked:low_reliability");
    if (sampleAB < ISO_ELITE_MIN_SAMPLE_AB) reasons.push("elite_blocked:thin_sample");
  }

  return {
    rawIso,
    adjustedIso,
    split,
    sampleAB,
    effectiveSampleAB,
    source,
    percentile: null,
    reliability,
    tier,
    eliteEligible,
    reasons,
  };
}

/**
 * Display decision for the `power_iso` chip, derived from a canonical assessment.
 * `displayEligible` gates whether the chip renders at all (ordinary/missing power
 * shows no promotional ISO tag); `label` is the truthful tier wording. This never
 * changes whether the driver is EMITTED (that stays governed by the champion's
 * score-side threshold) — only how it is labeled and whether it is shown.
 */
export interface IsoTagDisplay {
  displayEligible: boolean;
  label: string;
  tier: IsoTier;
}

export function resolveIsoTagDisplay(a: IsoAssessment): IsoTagDisplay {
  if (a.eliteEligible) {
    return { displayEligible: true, label: "Elite Isolated Power", tier: a.tier };
  }
  const strongDisplayable =
    (a.tier === "ELITE" || a.tier === "STRONG") &&
    a.source !== "league_fallback" &&
    a.reliability >= ISO_RELIABILITY_FLOOR &&
    a.sampleAB >= ISO_STRONG_MIN_SAMPLE_AB;
  if (strongDisplayable) {
    return { displayEligible: true, label: "Strong Isolated Power", tier: a.tier };
  }
  // Valid-but-ordinary, thin, or unavailable — the model may still use the input,
  // but no promotional ISO chip is shown.
  return { displayEligible: false, label: "Isolated Power", tier: a.tier };
}
