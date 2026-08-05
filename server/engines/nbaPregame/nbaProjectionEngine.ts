// PR3 — NBA Pregame Targets: blind projection engine + fail-closed boundary.
//
// Two layers, per the error-handling contract:
//
//   • computeNbaProjection(input) — the PURE core. Runs the posterior→moments
//     bridge per base stat, builds the correlated (pts,reb,ast) joint over the
//     available subset, models three_pointers_made standalone, derives every
//     launch market's LINE-FREE PMF + moments, and stamps a frozen input +
//     projection hash. EXPECTED missing data (a null posterior, absent minutes)
//     is a TYPED per-market unavailable result — never an exception. But a
//     genuinely impossible internal state (a non-finite moment, a PMF that does
//     not normalize) THROWS: the core never silently normalizes corruption away.
//
//   • safeComputeNbaProjection(input) — the fail-closed boundary. Catches any
//     throw from the core, records a typed diagnostic, and returns an
//     ALL-UNAVAILABLE result (never a partial projection). This is the only entry
//     point a caller outside the engine should use.
//
// Structurally blind: no line/price/book/odds/edge/EV enters any input or output.
// Pure and deterministic (no Date.now / Math.random).

import {
  NBA_BASE_STATS,
  NBA_LAUNCH_MARKETS,
  NBA_MARKET_REGISTRY,
  NBA_JOINT_STATS,
  type NbaBaseStat,
  type NbaJointStat,
  type NbaMarketKey,
} from "./markets";
import {
  buildNbaJoint,
  marginalPmf,
  comboPmf,
  type NbaJointDistribution,
  type JointComponentMoments,
} from "./joint/pointsReboundsAssistsJoint";
import { negativeBinomialPmf, normalizePmf, isNormalized, meanOfPmf, varianceOfPmf } from "./math/pmf";
import { bridgeStatPosterior, type StatPosteriorResult } from "./statPosterior";
import type { PosteriorState, Prior } from "../../pregameTargets/posteriorState/posteriorState";
import type { PlayerMinutesDistribution } from "./minutes/teamMinutesAllocator";
import {
  buildFrozenNbaProjectionInput,
  computeProjectionHash,
  NBA_PREGAME_MODEL_VERSION,
  type FrozenStatInput,
  type ProjectionHashMarket,
} from "./frozenNbaProjectionInput";

export interface NbaProjectionEngineInput {
  snapshotId: string;
  capturedAt: string;
  playerCanonicalId: string;
  gameCanonicalId: string;
  season: number;
  /** This player's minutes distribution (allocator). Null → all markets missing_minutes. */
  minutes: PlayerMinutesDistribution | null;
  /** Per-minute-rate posteriors per base stat (PR1). Absent/null → missing_posterior. */
  posteriors: Partial<Record<NbaBaseStat, PosteriorState | null>>;
  /** Per-minute-rate priors per base stat (required for each modeled stat). */
  priors: Record<NbaBaseStat, Prior>;
  latentStrength?: number;
  /** Truncation caps for the joint stats. */
  maxCount?: Record<NbaJointStat, number>;
  /** Truncation cap for standalone three_pointers_made. */
  threesMaxCount?: number;
  minEss?: number;
}

export interface NbaMarketProjection {
  market: NbaMarketKey;
  available: boolean;
  reason: string;
  /** Line-free count PMF over 0..N (normalized), or null when unavailable. */
  pmf: number[] | null;
  mean: number | null;
  variance: number | null;
}

export interface NbaProjectionResult {
  playerCanonicalId: string;
  gameCanonicalId: string;
  season: number;
  modelVersion: string;
  featureHash: string;
  projectionHash: string;
  markets: NbaMarketProjection[];
  allUnavailable: boolean;
}

export const NBA_THREES_MAX_COUNT_DEFAULT = 15;
const DEFAULT_JOINT_MAX_COUNT: Record<NbaJointStat, number> = { points: 80, rebounds: 40, assists: 30 };

/**
 * INVARIANT check for an AVAILABLE market projection. Throws on an impossible
 * state so the core surfaces corruption rather than emitting it. Exported so the
 * detection itself is directly testable.
 */
export function assertMarketProjectionValid(mp: NbaMarketProjection): void {
  if (!mp.available) return;
  if (mp.pmf === null || !isNormalized(mp.pmf, 1e-6)) {
    throw new Error(`nbaProjectionEngine: market ${mp.market} available but PMF not normalized`);
  }
  if (mp.mean === null || !Number.isFinite(mp.mean) || mp.mean < 0) {
    throw new Error(`nbaProjectionEngine: market ${mp.market} impossible mean ${mp.mean}`);
  }
  if (mp.variance === null || !Number.isFinite(mp.variance) || mp.variance < 0) {
    throw new Error(`nbaProjectionEngine: market ${mp.market} impossible variance ${mp.variance}`);
  }
}

function unavailableMarket(market: NbaMarketKey, reason: string): NbaMarketProjection {
  return { market, available: false, reason, pmf: null, mean: null, variance: null };
}

/** Build an available market projection from a normalized PMF (validates finiteness of moments). */
function availableMarket(market: NbaMarketKey, pmf: number[]): NbaMarketProjection {
  const mp: NbaMarketProjection = {
    market,
    available: true,
    reason: "available",
    pmf,
    mean: meanOfPmf(pmf),
    variance: varianceOfPmf(pmf),
  };
  assertMarketProjectionValid(mp);
  return mp;
}

/**
 * The PURE projection core. May THROW on an impossible internal state; expected
 * missing data yields typed per-market unavailable results.
 */
export function computeNbaProjection(input: NbaProjectionEngineInput): NbaProjectionResult {
  const minEss = input.minEss;
  const latentStrength = input.latentStrength;
  const jointMaxCount = input.maxCount ?? DEFAULT_JOINT_MAX_COUNT;
  const threesCap = input.threesMaxCount ?? NBA_THREES_MAX_COUNT_DEFAULT;

  // 1. Bridge every base stat → typed result (available / prior_dominant / …).
  const bridge: Record<NbaBaseStat, StatPosteriorResult> = {} as Record<NbaBaseStat, StatPosteriorResult>;
  for (const stat of NBA_BASE_STATS) {
    bridge[stat] = bridgeStatPosterior({
      stat,
      posterior: input.posteriors[stat] ?? null,
      currentSeason: input.season,
      prior: input.priors[stat],
      minutes: input.minutes,
      minEss,
    });
  }

  // 2. Build the correlated joint over the projected joint stats (subset-aware).
  const jointMomentsInput: {
    points?: JointComponentMoments;
    rebounds?: JointComponentMoments;
    assists?: JointComponentMoments;
    latentStrength?: number;
    maxCount: Record<NbaJointStat, number>;
  } = { latentStrength, maxCount: jointMaxCount };
  for (const s of NBA_JOINT_STATS) {
    const r = bridge[s];
    if (r.projected && r.moments) jointMomentsInput[s] = r.moments;
  }
  const hasJoint = NBA_JOINT_STATS.some((s) => bridge[s].projected && bridge[s].moments);
  const joint: NbaJointDistribution | null = hasJoint ? buildNbaJoint(jointMomentsInput) : null;

  // 3. Per-market assembly.
  const markets: NbaMarketProjection[] = [];
  for (const key of NBA_LAUNCH_MARKETS) {
    const def = NBA_MARKET_REGISTRY[key];

    // Standalone three_pointers_made.
    if (key === "three_pointers_made") {
      const r = bridge.three_pointers_made;
      if (!r.projected || !r.moments) {
        markets.push(unavailableMarket(key, r.reason));
      } else {
        const pmf = normalizePmf(negativeBinomialPmf(r.moments.mean, r.moments.variance, threesCap), threesCap);
        markets.push(availableMarket(key, pmf));
      }
      continue;
    }

    // Base joint stat (points/rebounds/assists).
    if (def.kind === "base") {
      const stat = def.components[0] as NbaJointStat;
      const r = bridge[stat];
      if (!r.projected || !joint || joint.conditionalPmfs[stat] === undefined) {
        markets.push(unavailableMarket(key, r.reason));
      } else {
        const cap = jointMaxCount[stat];
        markets.push(availableMarket(key, normalizePmf(marginalPmf(joint, stat), cap)));
      }
      continue;
    }

    // Combo — available iff EVERY component projected and present in the joint.
    const components = def.components as readonly NbaJointStat[];
    const unavailableComponent = components.find(
      (c) => !bridge[c].projected || !joint || joint.conditionalPmfs[c] === undefined,
    );
    if (unavailableComponent || !joint) {
      // Propagate the limiting component's actual reason so a combo says WHY it is
      // unavailable (e.g. "missing_minutes:points", "missing_posterior:assists").
      const reason = unavailableComponent
        ? `${bridge[unavailableComponent].reason}:${unavailableComponent}`
        : "component_unavailable";
      markets.push(unavailableMarket(key, reason));
    } else {
      const comboCap = components.reduce((acc, c) => acc + jointMaxCount[c], 0);
      markets.push(availableMarket(key, normalizePmf(comboPmf(joint, components), comboCap)));
    }
  }

  // 4. Frozen input + hashes.
  const statInputs: FrozenStatInput[] = NBA_BASE_STATS.map((stat) => ({
    stat,
    reason: bridge[stat].reason,
    projected: bridge[stat].projected,
    ess: bridge[stat].ess,
    rateMean: bridge[stat].rateMean,
    rateVariance: bridge[stat].rateVariance,
    moments: bridge[stat].moments,
  }));
  const frozen = buildFrozenNbaProjectionInput({
    snapshotId: input.snapshotId,
    capturedAt: input.capturedAt,
    playerCanonicalId: input.playerCanonicalId,
    gameCanonicalId: input.gameCanonicalId,
    season: input.season,
    latentStrength: latentStrength ?? 0.02,
    maxCount: jointMaxCount,
    stats: statInputs,
    minutes: input.minutes
      ? {
          playerId: input.minutes.playerId,
          support: input.minutes.support.map((s) => ({ minutes: s.minutes, prob: s.prob })),
          expectedMinutes: input.minutes.expectedMinutes,
          dnpProbability: input.minutes.dnpProbability,
        }
      : { playerId: "", support: [], expectedMinutes: 0, dnpProbability: 1 },
  });

  const hashMarkets: ProjectionHashMarket[] = markets.map((m) => ({
    market: m.market,
    available: m.available,
    reason: m.reason,
    pmf: m.pmf,
    mean: m.mean,
    variance: m.variance,
  }));
  const projectionHash = computeProjectionHash({
    modelVersion: NBA_PREGAME_MODEL_VERSION,
    featureHash: frozen.featureHash,
    markets: hashMarkets,
  });

  return {
    playerCanonicalId: input.playerCanonicalId,
    gameCanonicalId: input.gameCanonicalId,
    season: input.season,
    modelVersion: NBA_PREGAME_MODEL_VERSION,
    featureHash: frozen.featureHash,
    projectionHash,
    markets,
    allUnavailable: markets.every((m) => !m.available),
  };
}

export type NbaProjectionDiagnosticKind = "engine_threw";

export interface NbaProjectionDiagnostic {
  kind: NbaProjectionDiagnosticKind;
  message: string;
}

export interface SafeNbaProjection {
  ok: boolean;
  result: NbaProjectionResult;
  diagnostic: NbaProjectionDiagnostic | null;
}

/** All-unavailable fail-closed sentinel (used when the core throws). */
function allUnavailableResult(input: NbaProjectionEngineInput, reason: string): NbaProjectionResult {
  return {
    playerCanonicalId: input?.playerCanonicalId ?? "",
    gameCanonicalId: input?.gameCanonicalId ?? "",
    season: input?.season ?? 0,
    modelVersion: NBA_PREGAME_MODEL_VERSION,
    featureHash: "",
    projectionHash: "",
    markets: NBA_LAUNCH_MARKETS.map((m) => unavailableMarket(m, reason)),
    allUnavailable: true,
  };
}

/**
 * Fail-closed boundary. Never throws: a throw from the pure core becomes a typed
 * diagnostic and an ALL-UNAVAILABLE result (never a partial projection).
 */
export function safeComputeNbaProjection(input: NbaProjectionEngineInput): SafeNbaProjection {
  try {
    const result = computeNbaProjection(input);
    return { ok: true, result, diagnostic: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      result: allUnavailableResult(input, "engine_error"),
      diagnostic: { kind: "engine_threw", message },
    };
  }
}

export function marketProjection(result: NbaProjectionResult, market: NbaMarketKey): NbaMarketProjection | null {
  return result.markets.find((m) => m.market === market) ?? null;
}
