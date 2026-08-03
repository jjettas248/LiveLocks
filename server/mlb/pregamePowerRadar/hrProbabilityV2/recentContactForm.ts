// Plate HR V2 — stabilized recent-contact-form features (§8.3, PR5). PURE: no I/O,
// no Date.now()/new Date() internally — every timestamp/boundary is caller-supplied.
//
// SHADOW-ONLY and ADDITIVE. This produces a `RecentContactFormInputs` leaf for the
// V2 feature contract; no production scorer reads it (a shadow math consumer is
// deferred to PR6) and the champion path / Component 6 (`nearHrRecentForm.ts`) are
// untouched.
//
// Honest to the ONLY real per-BBE stream we have — `contact_events`
// (`{exitVelocity, launchAngle, isBarrel, result, timestamp}`; NO bb_type, NO
// spray, NO xSLG per event, per PR5 data trace). Therefore:
//   • EV (EWMA), EV90, air-ball%, barrel% are computed from the per-event stream;
//   • recentFormPulledAirShare is a SEASON fallback (never fabricated per-event);
//   • recentFormXHrPerContact is null (no per-event xSLG/xwOBA stream exists).
// Recent HR COUNT / HR-FB can never contribute — `result` is deliberately never
// read for a feature. Bat speed is not required (missing is tolerated).
//
// Coefficients here (EWMA half-life, reliability shrinkage constant, cap, air
// threshold) are DEFAULT PRIORS, not fitted — the reliability weight `w` and the
// blend are refined out-of-sample in PR8. Effects are bounded (w ∈ [0, cap]).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/recentContactForm.test.ts

import { isValidExitVelocity, isValidLaunchAngle } from "./statParsers";

/** The per-event row we actually have (matches storage.getRecentContactEventsForPlayers
 * / fetchRecentContactEventsForBatters — see PR5 data trace). `result` is present
 * but NEVER read for a feature (no HR-count leakage). Bat speed is intentionally
 * absent from this shape (tolerated). */
export interface RecentContactEventLite {
  exitVelocity: number | null;
  launchAngle: number | null;
  isBarrel: boolean | null;
  /** Accepted for shape parity; MUST NOT drive any feature (HR count can't fire). */
  result?: string | null;
  timestamp: string | Date;
}

/** Season posterior used to stabilize a short recent window. Every field is
 * optional/nullable — a missing baseline degrades gracefully (recent-only, lower
 * confidence), never fabricated. `pulledAirShare` is season-only by construction. */
export interface RecentContactFormSeasonBaseline {
  avgEv?: number | null;
  ev90?: number | null;
  airBallPct?: number | null;
  barrelPct?: number | null;
  pulledAirShare?: number | null;
}

/** The additive V2 contract leaf (all nullable numbers; no-op when absent). */
export interface RecentContactFormInputs {
  recentFormEv: number | null;
  recentFormEv90: number | null;
  recentFormAirBallPct: number | null;
  recentFormBarrelPct: number | null;
  /** Season fallback only — NOT per-event (no spray/bb_type in the stream). */
  recentFormPulledAirShare: number | null;
  /** Always null — no per-event xSLG/xwOBA stream exists (honest, not fabricated). */
  recentFormXHrPerContact: number | null;
  effectiveBbe: number | null;
  last15Bbe: number | null;
  /** Reliability blend weight w ∈ [0, cap] applied to the recent window. */
  reliabilityWeight: number | null;
}

export interface ComputeRecentContactFormArgs {
  events: readonly RecentContactEventLite[];
  /** Leakage boundary: only events STRICTLY before this instant are used (excludes
   * the game being scored). Null → no boundary is applied (caller's risk). */
  asOfExclusiveMs: number | null;
  seasonBaseline?: RecentContactFormSeasonBaseline | null;
  /** Max window size (most-recent-N BBE). Default 50. */
  windowMax?: number;
}

// Default-prior constants (refined out-of-sample in PR8).
const EV_HALFLIFE_EVENTS = 20;   // EWMA half-life in BBE (recency emphasis, capped by w)
const RELIABILITY_K = 20;        // shrinkage constant: w = n / (n + K)
const RELIABILITY_CAP = 0.85;    // w never exceeds this (a hot spike can't dominate)
const AIR_MIN_LA = 10;           // launch angle ≥ 10° counts as an "air" ball
const DEFAULT_WINDOW_MAX = 50;
const RECENCY_15 = 15;

const NEUTRAL: RecentContactFormInputs = {
  recentFormEv: null,
  recentFormEv90: null,
  recentFormAirBallPct: null,
  recentFormBarrelPct: null,
  recentFormPulledAirShare: null,
  recentFormXHrPerContact: null,
  effectiveBbe: null,
  last15Bbe: null,
  reliabilityWeight: null,
};

/** The all-null no-op leaf (used when no usable recent-contact data exists). */
export function neutralRecentContactForm(): RecentContactFormInputs {
  return { ...NEUTRAL };
}

function tsMs(t: string | Date): number {
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : NaN;
}

/** 90th-percentile (nearest-rank, 1-indexed ceil) of a numeric sample. */
function percentile90(sortedAsc: number[]): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.ceil(0.9 * n); // 1..n
  return sortedAsc[Math.min(n, Math.max(1, rank)) - 1];
}

/** Reliability weight — monotonic increasing in effective sample, capped so a tiny
 * hot spike can never dominate the season baseline. */
export function reliabilityWeight(effectiveBbe: number): number {
  if (!(effectiveBbe > 0)) return 0;
  return Math.min(RELIABILITY_CAP, effectiveBbe / (effectiveBbe + RELIABILITY_K));
}

/** Blend a recent estimate with a season baseline by the reliability weight. When
 * the baseline is absent, the recent estimate passes through (recent-only). */
function blend(recent: number | null, baseline: number | null | undefined, w: number): number | null {
  if (recent == null) return baseline ?? null;
  if (baseline == null) return recent;
  return w * recent + (1 - w) * baseline;
}

/**
 * Compute the stabilized recent-contact-form leaf. Pure, total — never throws.
 * Returns the all-null neutral leaf when no usable events remain after the
 * leakage boundary is applied.
 */
export function computeRecentContactForm(args: ComputeRecentContactFormArgs): RecentContactFormInputs {
  const windowMax = args.windowMax ?? DEFAULT_WINDOW_MAX;
  const boundary = args.asOfExclusiveMs;
  const baseline = args.seasonBaseline ?? null;

  // 1. Leakage guard + valid-timestamp filter, then chronological order.
  const ordered = (args.events ?? [])
    .map((e) => ({ e, ms: tsMs(e.timestamp) }))
    .filter(({ ms }) => Number.isFinite(ms) && (boundary == null || ms < boundary))
    .sort((a, b) => a.ms - b.ms)
    .map(({ e }) => e);

  // 2. Most-recent window (last `windowMax`).
  const windowed = ordered.slice(Math.max(0, ordered.length - windowMax));
  const n = windowed.length;
  if (n === 0) {
    // No recent events — but a season pulled-air baseline may still be surfaced
    // (it is season-derived, not recent), with zero reliability weight.
    if (baseline?.pulledAirShare != null) {
      return { ...NEUTRAL, recentFormPulledAirShare: baseline.pulledAirShare, effectiveBbe: 0, last15Bbe: 0, reliabilityWeight: 0 };
    }
    return neutralRecentContactForm();
  }

  const w = reliabilityWeight(n);

  // 3. EWMA of EV over valid-EV events (recent weighted higher via half-life).
  let evWeightSum = 0;
  let evValueSum = 0;
  const evSamples: number[] = [];
  for (let i = 0; i < n; i++) {
    const ev = windowed[i].exitVelocity;
    if (!isValidExitVelocity(ev)) continue;
    const decay = Math.pow(0.5, (n - 1 - i) / EV_HALFLIFE_EVENTS); // newest → 1
    evWeightSum += decay;
    evValueSum += decay * (ev as number);
    evSamples.push(ev as number);
  }
  const ewmaEv = evWeightSum > 0 ? evValueSum / evWeightSum : null;
  const ev90 = percentile90([...evSamples].sort((a, b) => a - b));

  // 4. Air-ball% over valid-LA events; barrel% over events with a known barrel flag.
  let laCount = 0;
  let airCount = 0;
  let barrelDenom = 0;
  let barrelCount = 0;
  for (const e of windowed) {
    if (isValidLaunchAngle(e.launchAngle)) {
      laCount++;
      if ((e.launchAngle as number) >= AIR_MIN_LA) airCount++;
    }
    if (typeof e.isBarrel === "boolean") {
      barrelDenom++;
      if (e.isBarrel) barrelCount++;
    }
  }
  const airBallPct = laCount > 0 ? (airCount / laCount) * 100 : null;
  const barrelPct = barrelDenom > 0 ? (barrelCount / barrelDenom) * 100 : null;

  // 5. Reliability-blend the recent estimates with the season baseline.
  return {
    recentFormEv: blend(ewmaEv, baseline?.avgEv, w),
    recentFormEv90: blend(ev90, baseline?.ev90, w),
    recentFormAirBallPct: blend(airBallPct, baseline?.airBallPct, w),
    recentFormBarrelPct: blend(barrelPct, baseline?.barrelPct, w),
    // Season-only by construction — never per-event.
    recentFormPulledAirShare: baseline?.pulledAirShare ?? null,
    // No per-event xSLG/xwOBA stream exists.
    recentFormXHrPerContact: null,
    effectiveBbe: n,
    last15Bbe: Math.min(n, RECENCY_15),
    reliabilityWeight: w,
  };
}
