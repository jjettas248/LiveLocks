// Plate HR V2 — stabilized recent-contact-form features (§8.3, PR5 / PR5.1 / PR5.2).
// PURE: no I/O, no Date.now()/new Date() internally; no snapshot-module import (so
// the training reader can import the re-derivation here without a cycle — the
// evidence-descriptor builder lives in recentContactFormEvidence.ts).
//
// SHADOW-ONLY and ADDITIVE. Produces a `RecentContactFormInputs` leaf for the V2
// feature contract; no production scorer reads it. Component 6 (`nearHrRecentForm.ts`)
// is untouched.
//
// Honest to the ONLY real per-BBE stream — `contact_events`
// (`{exitVelocity, launchAngle, isBarrel, result, timestamp}`; NO bb_type/spray/
// xSLG per event). EV (EWMA), EV90, air-ball% (LA), barrel% are per-event.
// `recentFormXHrPerContact` is always null (no per-event xSLG). `recentFormPulledAirShare`
// is **always null** for now (PR5.2 gap 4): there is no genuine per-event OR season
// pulled-AIR aggregate — the previously-wired season pull-rate was a MISLABELED
// proxy and has been removed. Recent HR COUNT can never contribute (`result` never
// read). Bat speed never required.
//
// Coefficients (EWMA half-life, reliability K, cap) are DEFAULT PRIORS, refined
// out-of-sample in PR8. Effects bounded (each w ∈ [0, cap]).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/recentContactForm.test.ts

import { isValidExitVelocity, isValidLaunchAngle } from "./statParsers";

/** The per-event row we actually have. `result` is present but NEVER read. */
export interface RecentContactEventLite {
  exitVelocity: number | null;
  launchAngle: number | null;
  isBarrel: boolean | null;
  result?: string | null;
  timestamp: string | Date;
}

/** Season posterior used to stabilize a short recent window — DOMAIN-VALIDATED.
 * No `pulledAirShare` (PR5.2 gap 4: no genuine pulled-air aggregate exists yet). */
export interface RecentContactFormSeasonBaseline {
  avgEv?: number | null;
  ev90?: number | null;
  airBallPct?: number | null;
  barrelPct?: number | null;
}

/** The additive V2 contract leaf (all nullable numbers; no-op when absent). */
export interface RecentContactFormInputs {
  recentFormEv: number | null;
  recentFormEv90: number | null;
  recentFormAirBallPct: number | null;
  recentFormBarrelPct: number | null;
  /** Always null until a genuine pulled-air season aggregate exists (PR5.2). */
  recentFormPulledAirShare: number | null;
  /** Always null — no per-event xSLG/xwOBA stream exists. */
  recentFormXHrPerContact: number | null;
  effectiveBbe: number | null;
  last15Bbe: number | null;
  reliabilityWeight: number | null;
}

export interface ComputeRecentContactFormArgs {
  events: readonly RecentContactEventLite[];
  /** Leakage boundary: only events STRICTLY before this instant are used. MUST be
   * finite — a non-finite boundary fails closed to a neutral leaf. */
  asOfExclusiveMs: number | null;
  seasonBaseline?: RecentContactFormSeasonBaseline | null;
  /** Requested window; hard-capped at 50 and normalized to 50 when invalid. */
  windowMax?: number;
}

/** The immutable payload a leaf is EXACTLY re-derivable from (PR5.1 gap 2). */
export interface RecentContactFormEvidencePayload {
  events: Array<{ exitVelocity: number | null; launchAngle: number | null; isBarrel: boolean | null; timestamp: string }>;
  seasonBaseline: Required<RecentContactFormSeasonBaseline>;
  asOfExclusiveMs: number;
  windowMax: number;
}

const EV_HALFLIFE_EVENTS = 20;
const RELIABILITY_K = 20;
const RELIABILITY_CAP = 0.85;
const AIR_MIN_LA = 10;
export const RECENT_CONTACT_WINDOW_HARD_CAP = 50;
const RECENCY_15 = 15;

const NEUTRAL: RecentContactFormInputs = {
  recentFormEv: null, recentFormEv90: null, recentFormAirBallPct: null, recentFormBarrelPct: null,
  recentFormPulledAirShare: null, recentFormXHrPerContact: null, effectiveBbe: null, last15Bbe: null,
  reliabilityWeight: null,
};

export function neutralRecentContactForm(): RecentContactFormInputs {
  return { ...NEUTRAL };
}

export function tsMs(t: string | Date): number {
  const ms = t instanceof Date ? t.getTime() : Date.parse(t);
  return Number.isFinite(ms) ? ms : NaN;
}

function percentile90(sortedAsc: number[]): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.ceil(0.9 * n);
  return sortedAsc[Math.min(n, Math.max(1, rank)) - 1];
}

export function reliabilityWeight(effectiveCount: number): number {
  if (!(effectiveCount > 0)) return 0;
  return Math.min(RELIABILITY_CAP, effectiveCount / (effectiveCount + RELIABILITY_K));
}

function validBaseline(x: number | null | undefined, lo: number, hi: number): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : null;
}

function blend(recent: number | null, baseline: number | null, w: number): number | null {
  if (baseline == null) return null;
  if (recent == null) return baseline;
  return w * recent + (1 - w) * baseline;
}

/** Normalize the requested window to a positive integer ≤ 50 (invalid → 50). */
export function normalizeWindowMax(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return RECENT_CONTACT_WINDOW_HARD_CAP;
  const floored = Math.floor(requested);
  if (floored <= 0) return RECENT_CONTACT_WINDOW_HARD_CAP;
  return Math.min(RECENT_CONTACT_WINDOW_HARD_CAP, floored);
}

/** The SINGLE window definition shared by compute + the evidence builder: events
 * strictly before the finite boundary, chronological, last `windowMax`. */
export function selectContactWindow(
  events: readonly RecentContactEventLite[],
  boundary: number,
  windowMax: number,
): Array<{ event: RecentContactEventLite; ms: number }> {
  const ordered = (events ?? [])
    .map((e) => ({ event: e, ms: tsMs(e.timestamp) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms < boundary)
    .sort((a, c) => a.ms - c.ms);
  return ordered.slice(Math.max(0, ordered.length - windowMax));
}

/**
 * Compute the stabilized recent-contact-form leaf. Pure, total — never throws.
 * Fails closed to neutral when the boundary is non-finite or no in-window events
 * exist. `recentFormPulledAirShare`/`recentFormXHrPerContact` are always null.
 */
export function computeRecentContactForm(args: ComputeRecentContactFormArgs): RecentContactFormInputs {
  const boundary = args.asOfExclusiveMs;
  if (boundary == null || !Number.isFinite(boundary)) return neutralRecentContactForm();

  const windowMax = normalizeWindowMax(args.windowMax);
  const b = args.seasonBaseline ?? null;
  const baseEv = validBaseline(b?.avgEv, 0.0001, 130);
  const baseEv90 = validBaseline(b?.ev90, 0.0001, 130);
  const baseAir = validBaseline(b?.airBallPct, 0, 100);
  const baseBarrel = validBaseline(b?.barrelPct, 0, 100);

  const windowed = selectContactWindow(args.events, boundary, windowMax).map((x) => x.event);
  const n = windowed.length;
  if (n === 0) return neutralRecentContactForm();

  let evWeightSum = 0;
  let evValueSum = 0;
  const evSamples: number[] = [];
  for (let i = 0; i < n; i++) {
    const ev = windowed[i].exitVelocity;
    if (!isValidExitVelocity(ev)) continue;
    const decay = Math.pow(0.5, (n - 1 - i) / EV_HALFLIFE_EVENTS);
    evWeightSum += decay;
    evValueSum += decay * (ev as number);
    evSamples.push(ev as number);
  }
  const ewmaEv = evWeightSum > 0 ? evValueSum / evWeightSum : null;
  const ev90 = percentile90([...evSamples].sort((a, c) => a - c));

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

  const wEv = reliabilityWeight(evSamples.length);
  const wAir = reliabilityWeight(laCount);
  const wBarrel = reliabilityWeight(barrelDenom);

  return {
    recentFormEv: blend(ewmaEv, baseEv, wEv),
    recentFormEv90: blend(ev90, baseEv90, wEv),
    recentFormAirBallPct: blend(airBallPct, baseAir, wAir),
    recentFormBarrelPct: blend(barrelPct, baseBarrel, wBarrel),
    recentFormPulledAirShare: null, // no genuine pulled-air aggregate (PR5.2 gap 4)
    recentFormXHrPerContact: null,
    effectiveBbe: n,
    last15Bbe: Math.min(n, RECENCY_15),
    reliabilityWeight: wEv,
  };
}

/** True iff a leaf carries no signal at all (all fields null). */
export function isNeutralRecentContactForm(leaf: RecentContactFormInputs): boolean {
  return leaf.recentFormEv == null && leaf.recentFormEv90 == null && leaf.recentFormAirBallPct == null
    && leaf.recentFormBarrelPct == null && leaf.recentFormPulledAirShare == null && leaf.recentFormXHrPerContact == null
    && leaf.effectiveBbe == null && leaf.last15Bbe == null && leaf.reliabilityWeight == null;
}

/** Re-derive the leaf from a persisted contact_events payload — proves the stored
 * evidence recomputes to the captured derived vector (read-time check in PR5.2). */
export function recomputeRecentContactFormFromEvidence(payload: RecentContactFormEvidencePayload): RecentContactFormInputs {
  return computeRecentContactForm({
    events: payload.events,
    asOfExclusiveMs: payload.asOfExclusiveMs,
    seasonBaseline: payload.seasonBaseline,
    windowMax: payload.windowMax,
  });
}
