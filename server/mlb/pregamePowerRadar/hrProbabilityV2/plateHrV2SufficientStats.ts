// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — sufficient-statistics aggregator (PR 1,
// correction 2).
//
// Pure function computing durable sufficient statistics from the same raw
// Savant CSV rows server/mlb/dataSources.ts's `fetchBaseballSavantData`
// already parses and discards after computing ~15 scalar season aggregates
// (verified by direct read of dataSources.ts:453-724). No new fetch, no new
// network cost — this only stops throwing away data already paid for.
//
// Confirmed columns present on every row (used by existing code today, so
// definitely real): `description` (pitch outcome — already classified into
// swing/whiff/called-strike buckets by dataSources.ts's
// SAVANT_WHIFF_DESC/SAVANT_SWING_DESC/SAVANT_CALLED_STRIKE_DESC),
// `pitch_type`, `bb_type`, `launch_speed`, `launch_angle`, `hit_distance_sc`,
// `estimated_ba/slg/woba_using_speedangle`, `hc_x`/`hc_y`, `stand`,
// `bat_speed`, `swing_length`, `events` (PA-terminal outcome — already read
// at dataSources.ts:664 to detect "home_run"), `game_date`, `game_pk`.
//
// Honestly flagged, not fabricated: a `zone` column for true zone-swing/
// zone-contact/chase-rate computation is a standard field in Savant's
// `type=details` export, so it is *likely* present — but this was never
// confirmed against a live response in this session. This aggregator reads it
// defensively (only trusts a `zone` value that parses to Savant's known
// 1-9 (in-zone) / 11-14 (chase-region) code range) and reports
// `zoneDataAvailable: false` rather than assume, whenever no row in the
// given batch has a parseable zone code. Verify this against a live fetch
// early in implementation — see the plan's Verification §5.
//
// This same function is called on BOTH the batter-keyed fetch and the
// pitcher-keyed fetch inside fetchBaseballSavantData (the row shape and
// classification logic is identical either way; only which entity the result
// is attributed to differs, exactly like dataSources.ts already has separate
// aggregateBatterPitchAndContact/aggregatePitcherStuffMetrics functions over
// the same kind of rows).
// ─────────────────────────────────────────────────────────────────────────────

import { getPitchFamily } from "../../pitchTypeNormalizer";
import { computeExactPitchStats, type PlateHrV2ExactPitchStats, type ExactPitchEntityType } from "./exactPitchStats";

type PitchFamily = "fastball" | "breaking" | "offspeed";

// Deliberately duplicated from server/mlb/dataSources.ts rather than
// imported — dataSources.ts is about to call INTO this module (to populate
// BaseballSavantData.plateHrV2SufficientStats), so importing these constants
// FROM dataSources.ts here would create a circular dependency. Same
// duplication-over-coupling tradeoff as frozenPlateHrV2Input.ts's copy of
// frozenPlateInput.ts's freeze utility — keep in sync by convention if
// dataSources.ts's canonical sets ever change.
const SAVANT_SWING_DESC = new Set([
  "hit_into_play", "foul", "swinging_strike", "swinging_strike_blocked",
  "foul_tip", "foul_bunt", "missed_bunt", "bunt_foul_tip",
]);
const SAVANT_WHIFF_DESC = new Set([
  "swinging_strike", "swinging_strike_blocked", "missed_bunt",
]);
const SAVANT_CALLED_STRIKE_DESC = new Set(["called_strike"]);

export interface PlateHrV2PitchFamilyStat {
  pitches: number;
  swings: number;
  whiffs: number;
  xslgSum: number;
  xslgN: number;
}

export interface PlateHrV2Percentiles {
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

export interface PlateHrV2SufficientStatsRaw {
  pitchesSeen: number;
  swings: number;
  whiffs: number;
  calledStrikes: number;
  balls: number;
  zoneSwings: number | null;
  zoneTakes: number | null;
  chaseSwings: number | null;
  chaseTakes: number | null;
  zoneDataAvailable: boolean;
  paCount: number;
  strikeouts: number;
  walks: number;
  battedBallEvents: number;
  pitchFamilyStats: Record<PitchFamily, PlateHrV2PitchFamilyStat>;
  // §5a (PR4): exact-pitch-type grain-typed counts × opponent hand, keyed
  // `${hand}:${code}`. Additive — the 3-family block above is retained for
  // fallback/back-compat.
  pitchTypeExactStats: PlateHrV2ExactPitchStats;
  evPercentiles: PlateHrV2Percentiles;
  laPercentiles: PlateHrV2Percentiles;
  pulledBip: number;
  sprayClassifiedBip: number;
  sourceRowCount: number;
}

const STRIKEOUT_EVENTS = new Set(["strikeout", "strikeout_double_play", "strikeout_triple_play"]);
const WALK_EVENTS = new Set(["walk", "intent_walk"]);
// Savant's standard zone-code convention for `type=details` exports: 1-9 are
// the nine in-strike-zone regions, 11-14 are the four chase regions just
// outside it (zone 10/00 conventions vary by export and are treated as
// unknown here rather than guessed).
const IN_ZONE_CODES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const CHASE_ZONE_CODES = new Set([11, 12, 13, 14]);

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  // CSV missing cells are "" — Number("") is 0, which would corrupt denominators.
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || t.toLowerCase() === "null") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

function computePercentiles(values: number[]): PlateHrV2Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
  };
}

function emptyFamilyStat(): PlateHrV2PitchFamilyStat {
  return { pitches: 0, swings: 0, whiffs: 0, xslgSum: 0, xslgN: 0 };
}

/**
 * Compute sufficient statistics from a season-to-date batch of raw Savant
 * `type=details` rows. Pure, total — never throws, degrades to zero counts /
 * null percentiles on an empty or malformed input.
 */
export function computePlateHrV2SufficientStats(
  rows: Array<Record<string, string>> | null | undefined,
  entityType: ExactPitchEntityType = "batter",
): PlateHrV2SufficientStatsRaw {
  const pitchFamilyStats: Record<PitchFamily, PlateHrV2PitchFamilyStat> = {
    fastball: emptyFamilyStat(),
    breaking: emptyFamilyStat(),
    offspeed: emptyFamilyStat(),
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      pitchesSeen: 0,
      swings: 0,
      whiffs: 0,
      calledStrikes: 0,
      balls: 0,
      zoneSwings: null,
      zoneTakes: null,
      chaseSwings: null,
      chaseTakes: null,
      zoneDataAvailable: false,
      paCount: 0,
      strikeouts: 0,
      walks: 0,
      battedBallEvents: 0,
      pitchFamilyStats,
      pitchTypeExactStats: {},
      evPercentiles: computePercentiles([]),
      laPercentiles: computePercentiles([]),
      pulledBip: 0,
      sprayClassifiedBip: 0,
      sourceRowCount: 0,
    };
  }

  let pitchesSeen = 0;
  let swings = 0;
  let whiffs = 0;
  let calledStrikes = 0;
  let balls = 0;
  let zoneSwings = 0;
  let zoneTakes = 0;
  let chaseSwings = 0;
  let chaseTakes = 0;
  let zoneRowsSeen = 0;
  let paCount = 0;
  let strikeouts = 0;
  let walks = 0;
  let battedBallEvents = 0;
  let pulledBip = 0;
  let sprayClassifiedBip = 0;
  const evValues: number[] = [];
  const laValues: number[] = [];

  for (const row of rows) {
    const desc = (row["description"] ?? "").trim().toLowerCase();
    if (desc) {
      pitchesSeen++;
      const isSwing = SAVANT_SWING_DESC.has(desc);
      const isWhiff = SAVANT_WHIFF_DESC.has(desc);
      const isCalledStrike = SAVANT_CALLED_STRIKE_DESC.has(desc);
      if (isSwing) swings++;
      if (isWhiff) whiffs++;
      if (isCalledStrike) calledStrikes++;
      if (desc === "ball" || desc === "blocked_ball" || desc === "pitchout") balls++;

      const zone = safeNum(row["zone"]);
      if (zone != null) {
        const zoneInt = Math.trunc(zone);
        if (IN_ZONE_CODES.has(zoneInt)) {
          zoneRowsSeen++;
          if (isSwing) zoneSwings++;
          else zoneTakes++;
        } else if (CHASE_ZONE_CODES.has(zoneInt)) {
          zoneRowsSeen++;
          if (isSwing) chaseSwings++;
          else chaseTakes++;
        }
      }

      const family = getPitchFamily(row["pitch_type"]) as PitchFamily | "other";
      if (family !== "other") {
        const fam = pitchFamilyStats[family];
        fam.pitches++;
        if (isSwing) {
          fam.swings++;
          if (isWhiff) fam.whiffs++;
        }
      }
    }

    const events = (row["events"] ?? "").trim().toLowerCase();
    if (events) {
      paCount++;
      if (STRIKEOUT_EVENTS.has(events)) strikeouts++;
      if (WALK_EVENTS.has(events)) walks++;
    }

    const bbType = (row["bb_type"] ?? "").trim();
    if (!bbType) continue;
    battedBallEvents++;

    const family = getPitchFamily(row["pitch_type"]) as PitchFamily | "other";
    if (family !== "other") {
      const xslg = safeNum(row["estimated_slg_using_speedangle"]);
      if (xslg != null && xslg >= 0 && xslg <= 4.0) {
        pitchFamilyStats[family].xslgSum += xslg;
        pitchFamilyStats[family].xslgN++;
      }
    }

    const ev = safeNum(row["launch_speed"]);
    const la = safeNum(row["launch_angle"]);
    if (ev != null && ev > 0 && ev <= 130) evValues.push(ev);
    if (la != null && ev != null && ev > 0 && ev <= 130) laValues.push(la);

    const hcx = safeNum(row["hc_x"]);
    const hcy = safeNum(row["hc_y"]);
    const stand = (row["stand"] ?? "").trim().toUpperCase();
    if (hcx != null && hcy != null && (stand === "L" || stand === "R")) {
      const denom = 198.27 - hcy;
      if (denom !== 0) {
        const phi = (Math.atan2(hcx - 125.42, denom) * 180) / Math.PI;
        const pullAngle = stand === "L" ? phi : -phi;
        if (Number.isFinite(pullAngle)) {
          sprayClassifiedBip++;
          if (pullAngle >= 15) pulledBip++;
        }
      }
    }
  }

  const zoneDataAvailable = zoneRowsSeen > 0;

  return {
    pitchesSeen,
    swings,
    whiffs,
    calledStrikes,
    balls,
    zoneSwings: zoneDataAvailable ? zoneSwings : null,
    zoneTakes: zoneDataAvailable ? zoneTakes : null,
    chaseSwings: zoneDataAvailable ? chaseSwings : null,
    chaseTakes: zoneDataAvailable ? chaseTakes : null,
    zoneDataAvailable,
    paCount,
    strikeouts,
    walks,
    battedBallEvents,
    pitchFamilyStats,
    pitchTypeExactStats: computeExactPitchStats(rows, entityType),
    evPercentiles: computePercentiles(evValues),
    laPercentiles: computePercentiles(laValues),
    pulledBip,
    sprayClassifiedBip,
    sourceRowCount: rows.length,
  };
}
