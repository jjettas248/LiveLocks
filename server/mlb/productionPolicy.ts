// ── MLB Live Edge — Production Rollout & Validation Policy ──────────────────
// The SINGLE typed owner of MLB Live Edge market/inning rollout state and the
// numeric thresholds the fail-closed safety runtime reads. No env checks or
// magic numbers governing official-vs-shadow are permitted anywhere else in
// the MLB pipeline — they all resolve through this module.
//
// Why this exists: a 7-day production sample lost -35.28u. The damage was
// concentrated in innings 1-3 (-70.58u) and in structurally-broken markets
// (total_bases -21.4% ROI, pitcher_outs -7.4%, HRR -2.9%, hits_allowed -1.8%).
// Only `hits` (+15.6%) is currently defensible. The default policy therefore
// makes innings 1-3 watch/shadow-only and keeps every damaged market out of
// the official ROI lane until it independently clears a Stage-C promotion gate.
//
// HR Radar is deliberately OUT of scope here — it keeps its own canonical
// lifecycle (server/mlb/hrRadarStateMachine.ts) and is never absorbed into
// this market matrix.
//
// Pure, no I/O. Deterministic. Does not read process.env at call time.

import type { MLBMarket } from "./types";

export type MlbMarketMode = "official" | "shadow" | "off";

export type MlbLane = "official" | "watch" | "shadow";

export type MlbInningBand = "early" | "middle" | "late";

// A per-prediction reason code explaining why a candidate did NOT reach the
// official lane (or, for `off`, was not computed at all). Surfaced in
// diagnostics and the private prediction ledger. Kept as a closed union so a
// new reason must be declared here, never invented ad hoc at a call site.
export type MlbLaneReasonCode =
  | "early_inning_watch_only"
  | "market_shadow"
  | "market_off"
  | "no_active_calibrator"
  | "state_incomplete"
  | "price_ineligible"
  | "probability_below_floor"
  | "integer_line_push_unmodeled"
  | "not_bettable";

export interface MlbInningBandPolicy {
  readonly min: number;
  readonly max: number;
  readonly officialAllowed: boolean;
}

export interface MlbLivePolicy {
  readonly innings: {
    readonly early: MlbInningBandPolicy;
    readonly middle: MlbInningBandPolicy;
    readonly late: MlbInningBandPolicy;
  };
  readonly markets: Readonly<Record<MLBMarket, MlbMarketMode>>;
  readonly thresholds: MlbPolicyThresholds;
}

export interface MlbPolicyThresholds {
  // Minimum no-vig model edge (percentage points) for price eligibility. An
  // official candidate must beat the de-vigged book by at least this much.
  readonly minNoVigEdgePctPoints: number;
  // Minimum calibrated (or provisional) candidate probability, in 0..100
  // percentage points, for official eligibility.
  readonly minCandidateProbabilityPct: number;
  // Stage-C promotion-gate defaults. Declared here for one-place ownership;
  // they are NEVER auto-applied by the runtime (a market is promoted only by an
  // explicit, human-reviewed forward-validation report — see
  // server/mlb/calibration/report.ts).
  readonly promotion: MlbPromotionThresholds;
}

export interface MlbPromotionThresholds {
  readonly minDecidedPredictions: number;
  readonly minDistinctSlateDates: number;
  readonly maxBrier: number;              // must also beat the raw/uncalibrated Brier
  readonly maxExpectedCalibrationErrorPct: number;
  readonly requirePositiveForwardRoi: boolean;
  readonly requireTierMonotonicity: boolean;
}

// The `hits` provisional compatibility switch. Until a validated Stage-C
// calibration artifact exists for hits, hits may surface official ONLY through
// this clearly-named temporary lane, stamped `raw_provisional` — never labeled
// calibrated/Elite/Strong. Flip to `false` to move hits fully shadow with no
// deploy-time code change (a single constant edit, or an env override read once
// at boot via resolveMlbLivePolicy).
export const HITS_PROVISIONAL_UNCALIBRATED_DEFAULT = true;

export const PROVISIONAL_UNCALIBRATED_TAG = "provisional_uncalibrated" as const;

// Private measurement capture defaults ON; public shadow surfacing defaults
// OFF. Stage B reads these; declared here so all rollout state lives in one
// module.
export const MLB_PREDICTION_CAPTURE_ENABLED_DEFAULT = true;
export const MLB_SHADOW_PUBLIC_SURFACING_DEFAULT = false;

export const DEFAULT_MLB_POLICY_THRESHOLDS: MlbPolicyThresholds = {
  minNoVigEdgePctPoints: 2.0,
  minCandidateProbabilityPct: 55,
  promotion: {
    minDecidedPredictions: 200,
    minDistinctSlateDates: 20,
    maxBrier: 0.25,
    maxExpectedCalibrationErrorPct: 5,
    requirePositiveForwardRoi: true,
    requireTierMonotonicity: true,
  },
};

// The production-safe default matrix. Only `hits` is official (and only
// provisionally, see the compat switch); every other supported market is
// shadow. Markets in DISABLED_MLB_MARKETS are `off` (never computed).
export const DEFAULT_MLB_LIVE_POLICY: MlbLivePolicy = {
  innings: {
    early: { min: 1, max: 3, officialAllowed: false },
    middle: { min: 4, max: 6, officialAllowed: true },
    late: { min: 7, max: 99, officialAllowed: true },
  },
  markets: {
    hits: "official",
    pitcher_strikeouts: "shadow",
    total_bases: "shadow",
    hrr: "shadow",
    pitcher_outs: "shadow",
    hits_allowed: "shadow",
    // home_runs is governed by HR Radar's own lifecycle, not this matrix; it is
    // marked `off` here purely so this record is exhaustive over MLBMarket. The
    // orchestrator must never route a home_runs signal through resolveMlbLane.
    home_runs: "off",
    walks_allowed: "off",
    batter_strikeouts: "off",
    hr_allowed: "off",
  },
  thresholds: DEFAULT_MLB_POLICY_THRESHOLDS,
};

let ACTIVE_POLICY: MlbLivePolicy = DEFAULT_MLB_LIVE_POLICY;

/** Returns the active resolved policy (defaults unless overridden at boot). */
export function getMlbLivePolicy(): MlbLivePolicy {
  return ACTIVE_POLICY;
}

/**
 * One-time boot resolution hook. Currently returns the default policy verbatim;
 * kept as the single seam where an env/DB override could be folded in at
 * startup (read once, never per-tick) so no call site reaches for process.env.
 */
export function resolveMlbLivePolicy(): MlbLivePolicy {
  ACTIVE_POLICY = DEFAULT_MLB_LIVE_POLICY;
  return ACTIVE_POLICY;
}

export function classifyInningBand(inning: number, policy: MlbLivePolicy = ACTIVE_POLICY): MlbInningBand {
  if (!Number.isFinite(inning) || inning <= policy.innings.early.max) return "early";
  if (inning <= policy.innings.middle.max) return "middle";
  return "late";
}

export function isInningOfficialAllowed(inning: number, policy: MlbLivePolicy = ACTIVE_POLICY): boolean {
  const band = classifyInningBand(inning, policy);
  return policy.innings[band].officialAllowed;
}

export function resolveMarketMode(market: MLBMarket, policy: MlbLivePolicy = ACTIVE_POLICY): MlbMarketMode {
  return policy.markets[market] ?? "off";
}

/**
 * Whether `market` is permitted to reach the official lane THIS tick from the
 * rollout matrix alone (mode + inning band). This is a NECESSARY, not
 * sufficient, condition — the finalizer's hard evidence invariants, no-vig
 * price gate, calibration gate, and integer-line gate must all also pass. A
 * `market_off`/`market_shadow`/`early_inning_watch_only` result short-circuits
 * to a non-official lane with the corresponding reason code.
 */
export function resolveMarketOfficialGate(
  market: MLBMarket,
  inning: number,
  policy: MlbLivePolicy = ACTIVE_POLICY,
): { officialAllowed: boolean; reason: MlbLaneReasonCode | null } {
  const mode = resolveMarketMode(market, policy);
  if (mode === "off") return { officialAllowed: false, reason: "market_off" };
  if (mode === "shadow") return { officialAllowed: false, reason: "market_shadow" };
  if (!isInningOfficialAllowed(inning, policy)) {
    return { officialAllowed: false, reason: "early_inning_watch_only" };
  }
  return { officialAllowed: true, reason: null };
}

/**
 * Maps a market mode + whether the candidate cleared every official gate into a
 * concrete lane. `off` never produces a computable prediction; `shadow` always
 * lands shadow; an `official`-mode market lands `official` only when
 * `clearedAllOfficialGates` is true, else `watch`.
 */
export function resolveMlbLane(
  market: MLBMarket,
  clearedAllOfficialGates: boolean,
  policy: MlbLivePolicy = ACTIVE_POLICY,
): MlbLane {
  const mode = resolveMarketMode(market, policy);
  if (mode === "shadow" || mode === "off") return "shadow";
  return clearedAllOfficialGates ? "official" : "watch";
}

/** Structured, human-readable boot log of the resolved policy. */
export function describeMlbLivePolicy(policy: MlbLivePolicy = ACTIVE_POLICY): string {
  const marketStr = Object.entries(policy.markets)
    .map(([m, mode]) => `${m}=${mode}`)
    .join(" ");
  const inn = policy.innings;
  return (
    `[MLB_PRODUCTION_POLICY] innings early(${inn.early.min}-${inn.early.max})=` +
    `${inn.early.officialAllowed ? "official" : "watch_only"} ` +
    `middle(${inn.middle.min}-${inn.middle.max})=${inn.middle.officialAllowed ? "official" : "watch_only"} ` +
    `late(${inn.late.min}+)=${inn.late.officialAllowed ? "official" : "watch_only"} | markets ${marketStr} | ` +
    `minEdgePP=${policy.thresholds.minNoVigEdgePctPoints} minProb=${policy.thresholds.minCandidateProbabilityPct} | ` +
    `hitsProvisional=${HITS_PROVISIONAL_UNCALIBRATED_DEFAULT} captureOn=${MLB_PREDICTION_CAPTURE_ENABLED_DEFAULT} ` +
    `publicShadow=${MLB_SHADOW_PUBLIC_SURFACING_DEFAULT}`
  );
}
