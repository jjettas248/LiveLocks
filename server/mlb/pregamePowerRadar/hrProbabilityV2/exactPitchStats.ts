// Plate HR V2 — exact-pitch-type sufficient statistics (§5a, PR4). PURE.
//
// Computes grain-typed counts per EXACT Statcast pitch code × opponent hand from
// the same raw Savant `type=details` rows the season aggregator already parses.
// Fixes the "3-family, per-code counts discarded, no denominator" gap.
//
// Grain is explicit (never mixed across incompatible denominators):
//   pitchCount      per pitch          swingCount     per pitch
//   whiffCount      per swing          contactCount   per swing (INCLUDES foul)
//   bbeCount        balls in play      qualityBbeCount BBE with measurable EV+LA
//   paEndedCount    per terminal PA    hrCount        per terminal PA
//   barrelCount     per qualityBBE (EV/LA PROXY — launch_speed_angle unauthorized, PR2)
//   xslgContactSum/N  Σ estimated_slg over qualityBBE (its own denominator N)
//   xHrQualitySum/N   Σ estimated_woba over qualityBBE (xwOBAcon proxy; own N)
//
// ISO is NEVER summed across pitch rows. Damage-on-contact sums use
// qualityBbeCount-scoped denominators, never contactCount (which includes fouls).
// An unknown/absent pitch code maps to the documented "OT" bucket (never dropped,
// never fabricated). Unknown opponent hand → "U" bucket.

import { normalizePitchTypeCode, type CanonicalPitchType } from "../../pitchTypeNormalizer";

export type OpponentHand = "L" | "R" | "U";
export type ExactPitchEntityType = "batter" | "pitcher";

export interface PlateHrV2ExactPitchStat {
  pitchCount: number;
  swingCount: number;
  whiffCount: number;
  contactCount: number;
  bbeCount: number;
  qualityBbeCount: number;
  paEndedCount: number;
  barrelCount: number;
  hrCount: number;
  xslgContactSum: number;
  xslgContactN: number;
  xHrQualitySum: number;
  xHrQualityN: number;
}

/** Flat map keyed `${hand}:${code}` (e.g. "R:FF") for easy jsonb storage/query. */
export type PlateHrV2ExactPitchStats = Record<string, PlateHrV2ExactPitchStat>;

const SWING_DESC = new Set([
  "hit_into_play", "foul", "swinging_strike", "swinging_strike_blocked",
  "foul_tip", "foul_bunt", "missed_bunt", "bunt_foul_tip",
]);
const WHIFF_DESC = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hand(v: unknown): OpponentHand {
  const s = (v == null ? "" : String(v)).trim().toUpperCase();
  return s === "L" || s === "R" ? s : "U";
}

function emptyStat(): PlateHrV2ExactPitchStat {
  return {
    pitchCount: 0, swingCount: 0, whiffCount: 0, contactCount: 0, bbeCount: 0,
    qualityBbeCount: 0, paEndedCount: 0, barrelCount: 0, hrCount: 0,
    xslgContactSum: 0, xslgContactN: 0, xHrQualitySum: 0, xHrQualityN: 0,
  };
}

export function exactPitchStatKey(hand: OpponentHand, code: CanonicalPitchType): string {
  return `${hand}:${code}`;
}

/**
 * Aggregate exact-pitch sufficient statistics. `entityType` selects the opponent
 * hand column: for a BATTER entity the opponent is the pitcher (`p_throws`); for
 * a PITCHER entity the opponent is the batter (`stand`). Pure; never throws.
 */
export function computeExactPitchStats(
  rows: Array<Record<string, string>> | null | undefined,
  entityType: ExactPitchEntityType,
): PlateHrV2ExactPitchStats {
  const out: PlateHrV2ExactPitchStats = {};
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const handColumn = entityType === "batter" ? "p_throws" : "stand";

  const bucket = (h: OpponentHand, code: CanonicalPitchType): PlateHrV2ExactPitchStat => {
    const key = exactPitchStatKey(h, code);
    return (out[key] ??= emptyStat());
  };

  for (const row of rows) {
    const code = normalizePitchTypeCode(row["pitch_type"]);
    const h = hand(row[handColumn]);
    const stat = bucket(h, code);

    const desc = (row["description"] ?? "").trim().toLowerCase();
    if (desc) {
      stat.pitchCount++;
      const isSwing = SWING_DESC.has(desc);
      const isWhiff = WHIFF_DESC.has(desc);
      if (isSwing) {
        stat.swingCount++;
        if (isWhiff) stat.whiffCount++;
        else stat.contactCount++; // contact includes foul (a swing that isn't a whiff)
      }
    }

    const events = (row["events"] ?? "").trim().toLowerCase();
    if (events) {
      stat.paEndedCount++;
      if (events === "home_run") stat.hrCount++;
    }

    const bbType = (row["bb_type"] ?? "").trim();
    if (!bbType) continue;
    stat.bbeCount++;

    const ev = safeNum(row["launch_speed"]);
    const la = safeNum(row["launch_angle"]);
    const measurable = ev != null && ev > 0 && ev <= 130 && la != null;
    if (!measurable) continue;
    stat.qualityBbeCount++;

    // Barrel PROXY (EV≥98 & LA∈[20,35]) — the official launch_speed_angle==6
    // classification is UNAUTHORIZED until the PR2 spike verifies it. Denominator
    // is qualityBbeCount.
    if (ev >= 98 && la >= 20 && la <= 35) stat.barrelCount++;

    const xslg = safeNum(row["estimated_slg_using_speedangle"]);
    if (xslg != null && xslg >= 0 && xslg <= 4.0) {
      stat.xslgContactSum += xslg;
      stat.xslgContactN++;
    }
    const xwoba = safeNum(row["estimated_woba_using_speedangle"]);
    if (xwoba != null && xwoba >= 0 && xwoba <= 3.0) {
      stat.xHrQualitySum += xwoba;
      stat.xHrQualityN++;
    }
  }

  return out;
}
