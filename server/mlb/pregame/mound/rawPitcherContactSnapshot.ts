// ── Mound Radar PR 2/5 — Raw Pitcher Contact Aggregation ────────────────────
// Pure, deterministic measurement layer over already-fetched pitcher Statcast
// rows (Savant CSV, via dataSources.ts's PitcherContactCsvSource) plus
// already-resolved season/recent-start inputs. No network access, no
// persistence, no global mutable state — same read (rows, inputs) always
// produces the same output. Feeds no production score, tier, direction,
// qualification, ranking, or public output — see evaluationSnapshot.ts for
// how this is threaded ONLY into the research evaluation snapshot's
// `champion.rawContactSnapshot`, never onto MoundDiagnostics.

import { PITCHER_CONTACT_FIELDS } from "../../dataSources";
import type { PitcherContactCsvSource, PitcherContactField } from "../../dataSources";

export type MetricAvailability =
  | "available"
  | "source_field_missing"
  | "insufficient_sample"
  | "source_unavailable";

export const RAW_PITCHER_CONTACT_SNAPSHOT_SCHEMA_VERSION = 1;

export interface RawPitcherContactSnapshot {
  schemaVersion: number;
  /** Overall season HR/9 — NOT handedness-adjusted. A matchup-weighted variant, if wanted, is a separate PR-3 field. Rounded to 2 decimals. */
  hr9Allowed: number | null;
  /** 0–100 scale, 1 decimal. */
  barrelAllowedPct: number | null;
  /** 0–100 scale, 1 decimal. */
  hardHitAllowedPct: number | null;
  /** 0–100 scale, 1 decimal. */
  flyBallAllowedPct: number | null;
  /** Mean, 3 decimals. */
  xSLGAllowed: number | null;
  /** Mean, 3 decimals. */
  xwOBAAllowed: number | null;
  /** Passthrough of the existing season BB/9 input, 2 decimals. */
  bb9: number | null;
  /** Passthrough of the existing ipVarianceLast3 input — precision unchanged. */
  ipVariance: number | null;
  sampleSizes: {
    inningsPitched: number | null;
    homeRunsAllowed: number | null;
    hardHitEligibleBbe: number;
    barrelEligibleBbe: number;
    bbTypeEligibleBbe: number;
    xSLGEligibleBbe: number;
    xwOBAEligibleBbe: number;
  };
  availability: {
    hr9Allowed: MetricAvailability;
    barrelAllowedPct: MetricAvailability;
    hardHitAllowedPct: MetricAvailability;
    flyBallAllowedPct: MetricAvailability;
    xSLGAllowed: MetricAvailability;
    xwOBAAllowed: MetricAvailability;
    bb9: MetricAvailability;
    ipVariance: MetricAvailability;
  };
}

/** Already-resolved, in-memory inputs — no new network calls. */
export interface RawContactSupportingInputs {
  /** Mirrors buildMlbMoundRadar.ts's existing `seasonStats != null` (same expression as rawInputsAvailable.pitcherSeasonStats). */
  seasonStatsAvailable: boolean;
  inningsPitchedSeason: number | null;
  homeRunsAllowedSeason: number | null;
  bb9Season: number | null;
  /** Mirrors buildMlbMoundRadar.ts's existing `recentStarts != null` (same expression as rawInputsAvailable.pitcherRecentStarts). */
  recentStartsAvailable: boolean;
  ipVarianceLast3: number | null;
}

// Sample floors — provisional measurement floors for this research
// instrumentation, NOT validated model thresholds. 30 BBE for barrels
// (rarer event, ~6-9% league average) is intentionally higher than the
// general 20-BBE floor used for the more common rates, mirroring the
// MIN_PITCHES_FOR_PITCHER_RATE=30 precedent in dataSources.ts.
const MIN_BBE_FOR_HARD_HIT_PCT = 20;
const MIN_BBE_FOR_BARREL_PCT = 30;
const MIN_BBE_FOR_FLY_BALL_PCT = 20;
const MIN_BBE_FOR_XSLG = 20;
const MIN_BBE_FOR_XWOBA = 20;
const MIN_IP_FOR_PER9_RATE = 10;

// The real Statcast bb_type domain (fly_ball/line_drive/ground_ball/popup) —
// unrecognized/blank values are excluded from the fly-ball denominator, never
// treated as ground contact.
const RECOGNIZED_BB_TYPES = new Set(["fly_ball", "line_drive", "ground_ball", "popup"]);

/**
 * Parses a raw CSV cell value defensively: undefined/blank → null (never 0).
 * Number("") === 0 in JS, so a blank cell must be excluded BEFORE numeric
 * conversion, or a missing measurement would silently fabricate a real zero.
 */
function parseStatcastNum(raw: string | undefined): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Normalizes an already-resolved season/recent-start scalar input:
 * non-finite or negative values collapse to null (a corrupt upstream value
 * must degrade to "missing", never silently drive a nonsense rate).
 */
function normalizeNonNegative(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Pure, deterministic aggregation. Never emits NaN/Infinity/fabricated
 * zeroes — every field independently tracks its own denominator and
 * availability reason. A Savant fetch failure (`source === null`) only
 * drives `source_unavailable` for the 5 Statcast-derived fields; hr9Allowed/
 * bb9/ipVariance are evaluated independently from `inputs` regardless of
 * Savant availability.
 */
export function aggregateRawPitcherContactSnapshot(
  source: PitcherContactCsvSource | null,
  inputs: RawContactSupportingInputs,
): RawPitcherContactSnapshot {
  // Eligible-row counts, keyed by the exact Statcast source field each metric
  // is denominated on — initialized from the authoritative field list
  // (dataSources.ts's PITCHER_CONTACT_FIELDS) so this function's per-field
  // bookkeeping can never silently drift out of sync with
  // PitcherContactCsvSource's actual shape.
  const eligibleByField = Object.fromEntries(
    PITCHER_CONTACT_FIELDS.map((f) => [f, 0]),
  ) as Record<PitcherContactField, number>;
  let hardHitCount = 0;
  let barrelCount = 0;
  let flyBallCount = 0;
  let xSLGSum = 0;
  let xwOBASum = 0;

  if (source != null) {
    for (const row of source.rows) {
      const launchSpeed = parseStatcastNum(row.launch_speed);
      if (launchSpeed != null && launchSpeed > 0 && launchSpeed <= 130) {
        eligibleByField.launch_speed++;
        if (launchSpeed >= 95) hardHitCount++;
      }

      const lsa = parseStatcastNum(row.launch_speed_angle);
      if (lsa != null && Number.isInteger(lsa) && lsa >= 1 && lsa <= 6) {
        eligibleByField.launch_speed_angle++;
        if (lsa === 6) barrelCount++;
      }

      const bbType = (row.bb_type ?? "").trim();
      if (RECOGNIZED_BB_TYPES.has(bbType)) {
        eligibleByField.bb_type++;
        if (bbType === "fly_ball") flyBallCount++;
      }

      const xslg = parseStatcastNum(row.estimated_slg_using_speedangle);
      if (xslg != null && xslg >= 0 && xslg <= 4.0) {
        eligibleByField.estimated_slg_using_speedangle++;
        xSLGSum += xslg;
      }

      const xwoba = parseStatcastNum(row.estimated_woba_using_speedangle);
      if (xwoba != null && xwoba >= 0 && xwoba <= 2.0) {
        eligibleByField.estimated_woba_using_speedangle++;
        xwOBASum += xwoba;
      }
    }
  }

  const hardHitEligible = eligibleByField.launch_speed;
  const barrelEligible = eligibleByField.launch_speed_angle;
  const bbTypeEligible = eligibleByField.bb_type;
  const xSLGEligible = eligibleByField.estimated_slg_using_speedangle;
  const xwOBAEligible = eligibleByField.estimated_woba_using_speedangle;

  function statcastAvailability(field: PitcherContactField, eligible: number, floor: number): MetricAvailability {
    if (source == null) return "source_unavailable";
    if (!source.fieldsPresent[field]) return "source_field_missing";
    if (eligible < floor) return "insufficient_sample";
    return "available";
  }

  const hardHitAvailability = statcastAvailability("launch_speed", hardHitEligible, MIN_BBE_FOR_HARD_HIT_PCT);
  const barrelAvailability = statcastAvailability("launch_speed_angle", barrelEligible, MIN_BBE_FOR_BARREL_PCT);
  const flyBallAvailability = statcastAvailability("bb_type", bbTypeEligible, MIN_BBE_FOR_FLY_BALL_PCT);
  const xSLGAvailability = statcastAvailability("estimated_slg_using_speedangle", xSLGEligible, MIN_BBE_FOR_XSLG);
  const xwOBAAvailability = statcastAvailability("estimated_woba_using_speedangle", xwOBAEligible, MIN_BBE_FOR_XWOBA);

  const hardHitAllowedPct = hardHitAvailability === "available" ? round((hardHitCount / hardHitEligible) * 100, 1) : null;
  const barrelAllowedPct = barrelAvailability === "available" ? round((barrelCount / barrelEligible) * 100, 1) : null;
  const flyBallAllowedPct = flyBallAvailability === "available" ? round((flyBallCount / bbTypeEligible) * 100, 1) : null;
  const xSLGAllowed = xSLGAvailability === "available" ? round(xSLGSum / xSLGEligible, 3) : null;
  const xwOBAAllowed = xwOBAAvailability === "available" ? round(xwOBASum / xwOBAEligible, 3) : null;

  // ── Non-Statcast metrics — independent of Savant availability ────────────
  const inningsPitchedSeason = normalizeNonNegative(inputs.inningsPitchedSeason);
  const homeRunsAllowedSeason = normalizeNonNegative(inputs.homeRunsAllowedSeason);
  const bb9Season = normalizeNonNegative(inputs.bb9Season);

  function hr9Availability(): MetricAvailability {
    if (!inputs.seasonStatsAvailable) return "source_unavailable";
    if (inningsPitchedSeason == null || homeRunsAllowedSeason == null) return "source_field_missing";
    if (inningsPitchedSeason < MIN_IP_FOR_PER9_RATE) return "insufficient_sample";
    return "available";
  }
  function bb9Availability(): MetricAvailability {
    if (!inputs.seasonStatsAvailable) return "source_unavailable";
    if (inningsPitchedSeason == null || bb9Season == null) return "source_field_missing";
    if (inningsPitchedSeason < MIN_IP_FOR_PER9_RATE) return "insufficient_sample";
    return "available";
  }
  function ipVarianceAvailability(): MetricAvailability {
    if (!inputs.recentStartsAvailable) return "source_unavailable";
    const v = inputs.ipVarianceLast3;
    if (v == null || !Number.isFinite(v) || v < 0) return "insufficient_sample";
    return "available";
  }

  const hr9Avail = hr9Availability();
  const bb9Avail = bb9Availability();
  const ipVarianceAvail = ipVarianceAvailability();

  const hr9Allowed =
    hr9Avail === "available" && inningsPitchedSeason != null && homeRunsAllowedSeason != null && inningsPitchedSeason > 0
      ? round((homeRunsAllowedSeason / inningsPitchedSeason) * 9, 2)
      : null;
  const bb9 = bb9Avail === "available" && bb9Season != null ? round(bb9Season, 2) : null;
  const ipVariance = ipVarianceAvail === "available" ? inputs.ipVarianceLast3 : null;

  return {
    schemaVersion: RAW_PITCHER_CONTACT_SNAPSHOT_SCHEMA_VERSION,
    hr9Allowed,
    barrelAllowedPct,
    hardHitAllowedPct,
    flyBallAllowedPct,
    xSLGAllowed,
    xwOBAAllowed,
    bb9,
    ipVariance,
    sampleSizes: {
      inningsPitched: inningsPitchedSeason,
      homeRunsAllowed: homeRunsAllowedSeason,
      hardHitEligibleBbe: hardHitEligible,
      barrelEligibleBbe: barrelEligible,
      bbTypeEligibleBbe: bbTypeEligible,
      xSLGEligibleBbe: xSLGEligible,
      xwOBAEligibleBbe: xwOBAEligible,
    },
    availability: {
      hr9Allowed: hr9Avail,
      barrelAllowedPct: barrelAvailability,
      hardHitAllowedPct: hardHitAvailability,
      flyBallAllowedPct: flyBallAvailability,
      xSLGAllowed: xSLGAvailability,
      xwOBAAllowed: xwOBAAvailability,
      bb9: bb9Avail,
      ipVariance: ipVarianceAvail,
    },
  };
}
