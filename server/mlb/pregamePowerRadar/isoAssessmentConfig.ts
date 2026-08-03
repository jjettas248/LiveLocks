// The Plate — canonical ISO assessment configuration (single source of truth).
//
// Every numeric literal the ISO tier/reliability logic depends on lives here so
// the assessment stays auditable and versionable — no scattered magic numbers in
// isoAssessment.ts. Bump ISO_ASSESSMENT_VERSION whenever a boundary/prior/floor
// changes; the value is stamped into the distribution audit for provenance.
//
// SCALE CONTRACT: every ISO value in this module is TRUE per-PA isolated power on
// the canonical decimal scale (SLG − AVG), e.g. league-average ≈ 0.140. This is
// deliberately NOT the on-contact expected-power proxy (`xISOSeason`, ≈0.20–0.30)
// that still feeds the champion score — see batterPowerProfile.ts. The two are
// different statistics with different denominators and must never be conflated.

export const ISO_ASSESSMENT_VERSION = "iso_assessment_v1";

/**
 * League-average true ISO — the shrinkage prior a small split regresses toward.
 * Provisional/seasonal; not a per-park or per-year fit.
 */
export const LEAGUE_PRIOR_ISO = 0.14;

/**
 * Plate-appearance count at which a split ISO is treated as carrying equal weight
 * to the league prior (reliability = 0.5). ISO is a batted-ball-driven rate that
 * stabilizes slower than contact rates; ~170 PA is a documented, provisional
 * stabilization point, not a literature-exact value.
 */
export const ISO_STABILIZATION_PA = 170;

/** Valid decimal ISO range. Anything outside fails closed (never becomes elite). */
export const ISO_MIN_VALID = 0;
export const ISO_MAX_VALID = 0.5;

/**
 * Tier boundaries on the reliability-adjusted (shrunk) ISO. ELITE targets roughly
 * the league ~90th percentile of isolated power; STRONG roughly the ~75th. These
 * are absolute thresholds — no stable same-population percentile source is wired
 * yet, so `percentile` is reported as null rather than fabricated.
 */
export const ISO_ELITE_MIN = 0.24;
export const ISO_STRONG_MIN = 0.2;
export const ISO_AVERAGE_MIN = 0.13;

/**
 * Reliability floor (shrinkage weight) an ELITE tier must clear to be
 * elite-eligible for the display tag. Below this, the ISO can still inform the
 * model, but it can never earn the promotional "Elite Isolated Power" label.
 */
export const ISO_RELIABILITY_FLOOR = 0.5;

/** Hard sample floors (relevant-split PA) for each display-eligible tier. */
export const ISO_ELITE_MIN_SAMPLE_PA = 100;
export const ISO_STRONG_MIN_SAMPLE_PA = 60;
