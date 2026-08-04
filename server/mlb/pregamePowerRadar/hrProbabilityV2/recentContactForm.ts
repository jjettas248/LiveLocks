// Plate HR V2 — stabilized recent-contact-form features (§8.3, PR5 / PR5.1). PURE:
// no I/O, no Date.now()/new Date() internally — every timestamp/boundary is
// caller-supplied.
//
// SHADOW-ONLY and ADDITIVE. Produces a `RecentContactFormInputs` leaf for the V2
// feature contract; no production scorer reads it (a shadow math consumer is PR6),
// and the champion path / Component 6 (`nearHrRecentForm.ts`) are untouched.
//
// Honest to the ONLY real per-BBE stream we have — `contact_events`
// (`{exitVelocity, launchAngle, isBarrel, result, timestamp}`; NO bb_type, NO
// spray, NO xSLG per event). Therefore:
//   • EV (EWMA), EV90, air-ball% (LA), barrel% are computed from the per-event stream;
//   • recentFormPulledAirShare is a SEASON fallback (never fabricated per-event);
//   • recentFormXHrPerContact is null (no per-event xSLG/xwOBA stream).
// Recent HR COUNT / HR-FB can never contribute (`result` is never read). Bat speed
// is not required (missing tolerated).
//
// PR5.1 corrections:
//   • Fail-closed leakage/window: a non-finite prediction boundary → neutral; the
//     window is hard-capped at 50 and a non-positive/fractional/NaN/∞ windowMax is
//     normalized to 50.
//   • Per-metric shrinkage: EV, EV90, air%, and barrel% are each blended by the
//     reliability of THEIR OWN valid measurement count (not the total window).
//   • A season baseline is REQUIRED to surface a stabilized metric — a tiny recent
//     sample is never passed through raw. Unknown barrel status is treated as
//     missing (never counted as a non-barrel). Baseline domains are validated.
//
// Coefficients here (EWMA half-life, reliability shrinkage constant, cap) are
// DEFAULT PRIORS, not fitted — refined out-of-sample in PR8. Effects are bounded
// (each w ∈ [0, cap]).
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/recentContactForm.test.ts

import { isValidExitVelocity, isValidLaunchAngle } from "./statParsers";
import { canonicalHash, type PlateHrV2EvidenceDescriptor } from "./plateHrV2Snapshots";

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
 * optional/nullable and DOMAIN-VALIDATED — a missing/invalid baseline metric makes
 * that metric null (never fabricated). `pulledAirShare` is season-only. */
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
  /** Reliability weight of the headline EV metric (each metric is blended by the
   * reliability of its own valid-measurement count). ∈ [0, cap]. */
  reliabilityWeight: number | null;
}

export interface ComputeRecentContactFormArgs {
  events: readonly RecentContactEventLite[];
  /** Leakage boundary: only events STRICTLY before this instant are used (excludes
   * the game being scored). MUST be finite — a non-finite boundary fails closed to
   * a neutral leaf (never disables the boundary). */
  asOfExclusiveMs: number | null;
  seasonBaseline?: RecentContactFormSeasonBaseline | null;
  /** Requested window size; hard-capped at 50 and normalized to 50 when invalid. */
  windowMax?: number;
}

// Default-prior constants (refined out-of-sample in PR8).
const EV_HALFLIFE_EVENTS = 20;   // EWMA half-life in BBE (recency emphasis, capped by w)
const RELIABILITY_K = 20;        // shrinkage constant: w = n / (n + K)
const RELIABILITY_CAP = 0.85;    // w never exceeds this (a hot spike can't dominate)
const AIR_MIN_LA = 10;           // launch angle ≥ 10° counts as an "air" ball
const WINDOW_HARD_CAP = 50;      // most-recent-N BBE, never exceeded
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
export function reliabilityWeight(effectiveCount: number): number {
  if (!(effectiveCount > 0)) return 0;
  return Math.min(RELIABILITY_CAP, effectiveCount / (effectiveCount + RELIABILITY_K));
}

/** Domain-validate a baseline metric; out-of-range / non-finite → null (absent). */
function validBaseline(x: number | null | undefined, lo: number, hi: number): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : null;
}

/** Blend a recent estimate with a REQUIRED season baseline by the metric's own
 * reliability weight. Without a baseline → null (a short recent sample is never
 * passed through raw). No recent measurements → the season baseline (w→0). */
function blend(recent: number | null, baseline: number | null, w: number): number | null {
  if (baseline == null) return null;
  if (recent == null) return baseline;
  return w * recent + (1 - w) * baseline;
}

/** Normalize the requested window to a positive integer ≤ 50 (invalid → 50). */
export function normalizeWindowMax(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return WINDOW_HARD_CAP;
  const floored = Math.floor(requested);
  if (floored <= 0) return WINDOW_HARD_CAP;
  return Math.min(WINDOW_HARD_CAP, floored);
}

/**
 * Compute the stabilized recent-contact-form leaf. Pure, total — never throws.
 * Fails closed to a neutral leaf when the leakage boundary is non-finite. Returns
 * the neutral leaf when no usable events remain (a season pulled-air baseline may
 * still be surfaced with zero reliability weight).
 */
export function computeRecentContactForm(args: ComputeRecentContactFormArgs): RecentContactFormInputs {
  // PR5.1 gap 3: a non-finite prediction boundary fails closed (never disables it).
  const boundary = args.asOfExclusiveMs;
  if (boundary == null || !Number.isFinite(boundary)) return neutralRecentContactForm();

  const windowMax = normalizeWindowMax(args.windowMax);
  const b = args.seasonBaseline ?? null;
  const baseEv = validBaseline(b?.avgEv, 0.0001, 130);
  const baseEv90 = validBaseline(b?.ev90, 0.0001, 130);
  const baseAir = validBaseline(b?.airBallPct, 0, 100);
  const baseBarrel = validBaseline(b?.barrelPct, 0, 100);
  const basePulledAir = validBaseline(b?.pulledAirShare, 0, 1);

  // 1. Leakage guard + valid-timestamp filter, then chronological order.
  const ordered = (args.events ?? [])
    .map((e) => ({ e, ms: tsMs(e.timestamp) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms < boundary)
    .sort((a, c) => a.ms - c.ms)
    .map(({ e }) => e);

  // 2. Most-recent window (last `windowMax`).
  const windowed = ordered.slice(Math.max(0, ordered.length - windowMax));
  const n = windowed.length;
  if (n === 0) {
    if (basePulledAir != null) {
      return { ...NEUTRAL, recentFormPulledAirShare: basePulledAir, effectiveBbe: 0, last15Bbe: 0, reliabilityWeight: 0 };
    }
    return neutralRecentContactForm();
  }

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
  const ev90 = percentile90([...evSamples].sort((a, c) => a - c));

  // 4. Air-ball% over valid-LA events; barrel% over events with a KNOWN barrel flag
  //    (unknown/missing barrel status is excluded, never counted as non-barrel).
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

  // 5. PR5.1 gap 4: shrink each metric by the reliability of ITS OWN valid count.
  const evCount = evSamples.length;
  const wEv = reliabilityWeight(evCount);
  const wAir = reliabilityWeight(laCount);
  const wBarrel = reliabilityWeight(barrelDenom);

  return {
    recentFormEv: blend(ewmaEv, baseEv, wEv),
    recentFormEv90: blend(ev90, baseEv90, wEv),
    recentFormAirBallPct: blend(airBallPct, baseAir, wAir),
    recentFormBarrelPct: blend(barrelPct, baseBarrel, wBarrel),
    // Season-only by construction — never per-event.
    recentFormPulledAirShare: basePulledAir,
    // No per-event xSLG/xwOBA stream exists.
    recentFormXHrPerContact: null,
    effectiveBbe: n,
    last15Bbe: Math.min(n, RECENCY_15),
    reliabilityWeight: wEv,
  };
}

// ── Content-addressed contact_events evidence + round-trip (PR5.1 gap 2) ───────

const finiteOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Canonicalize a baseline for the reproducible payload — undefined → null so the
 * stored JSON is deterministic and re-derivation is exact. */
function canonicalBaseline(b: RecentContactFormSeasonBaseline | null | undefined): Required<RecentContactFormSeasonBaseline> {
  return {
    avgEv: finiteOrNull(b?.avgEv),
    ev90: finiteOrNull(b?.ev90),
    airBallPct: finiteOrNull(b?.airBallPct),
    barrelPct: finiteOrNull(b?.barrelPct),
    pulledAirShare: finiteOrNull(b?.pulledAirShare),
  };
}

/** The immutable, content-addressed payload from which a recentContactForm leaf is
 * EXACTLY re-derivable: the windowed raw events + the season baseline + the
 * boundary + the window size. */
export interface RecentContactFormEvidencePayload {
  events: Array<{ exitVelocity: number | null; launchAngle: number | null; isBarrel: boolean | null; timestamp: string }>;
  seasonBaseline: Required<RecentContactFormSeasonBaseline>;
  asOfExclusiveMs: number;
  windowMax: number;
}

export interface BuildRecentContactFormEvidenceArgs extends ComputeRecentContactFormArgs {
  batterId: string;
  /** When the events were fetched (fetchedAt === availableAt for this class). */
  retrievalAtMs: number;
  schemaVersion: string;
}

/**
 * Compute the leaf AND build the content-addressed `contact_events` evidence
 * descriptor it is reproducible from. Returns `evidence: null` when the boundary
 * is non-finite or no in-window events exist (nothing to content-address). Pure.
 */
export function buildRecentContactFormEvidence(
  args: BuildRecentContactFormEvidenceArgs,
): { inputs: RecentContactFormInputs; evidence: PlateHrV2EvidenceDescriptor | null } {
  const inputs = computeRecentContactForm(args);
  const boundary = args.asOfExclusiveMs;
  if (boundary == null || !Number.isFinite(boundary)) return { inputs, evidence: null };
  if (!Number.isFinite(args.retrievalAtMs)) return { inputs, evidence: null };

  const windowMax = normalizeWindowMax(args.windowMax);
  const ordered = (args.events ?? [])
    .map((e) => ({ e, ms: tsMs(e.timestamp) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms < boundary)
    .sort((a, c) => a.ms - c.ms);
  const windowed = ordered.slice(Math.max(0, ordered.length - windowMax));
  if (windowed.length === 0) return { inputs, evidence: null };

  const payload: RecentContactFormEvidencePayload = {
    events: windowed.map(({ e, ms }) => ({
      exitVelocity: finiteOrNull(e.exitVelocity),
      launchAngle: finiteOrNull(e.launchAngle),
      isBarrel: typeof e.isBarrel === "boolean" ? e.isBarrel : null,
      timestamp: new Date(ms).toISOString(),
    })),
    seasonBaseline: canonicalBaseline(args.seasonBaseline),
    asOfExclusiveMs: boundary,
    windowMax,
  };
  const maxMs = Math.max(...windowed.map(({ ms }) => ms));
  const retrievalIso = new Date(args.retrievalAtMs).toISOString();

  const evidence: PlateHrV2EvidenceDescriptor = {
    provider: "mlb_stats_live",
    entityType: "batter",
    entityId: args.batterId,
    evidenceKind: "contact_events",
    fetchedAt: retrievalIso,
    availableAt: retrievalIso, // fetched_at ⇒ availableAt === fetchedAt
    availabilitySource: "fetched_at",
    provenanceIncomplete: false,
    dataThroughAt: new Date(maxMs).toISOString(), // latest game the window covers
    validForAt: null,
    schemaVersion: args.schemaVersion,
    contentHash: canonicalHash(payload),
    payloadRef: null,
    authorizedPayload: payload,
  };
  return { inputs, evidence };
}

/** Re-derive the leaf from a persisted contact_events payload — proves the stored
 * evidence recomputes to the captured derived vector. */
export function recomputeRecentContactFormFromEvidence(payload: RecentContactFormEvidencePayload): RecentContactFormInputs {
  return computeRecentContactForm({
    events: payload.events,
    asOfExclusiveMs: payload.asOfExclusiveMs,
    seasonBaseline: payload.seasonBaseline,
    windowMax: payload.windowMax,
  });
}
