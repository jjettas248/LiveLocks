// PR1 — Posterior sufficient-statistics state (temporal data foundation, §5B.5).
//
// A per-entity, per-feature running summary of weighted observations, kept as
// SUFFICIENT STATISTICS (weighted sums) rather than raw histories, and split BY
// SEASON so the rolling "current + two prior seasons" window can drop the oldest
// season without re-reading the past. Every design property here is pure and
// deterministic:
//
//  • Effective sample size  ESS = (Σw)² / Σw²  — the honest count of independent
//    observations behind a weighted mean; drives prior-mass shrinkage.
//  • Rolling window: combining respects [currentSeason-(N-1), currentSeason];
//    older seasons are excluded (season rollover) without mutating stored state.
//  • Deterministic update with lineage: an observation is keyed by its game id;
//    re-adding the same game is a no-op (idempotent), and the game being
//    predicted can be explicitly excluded (no self-update).
//
// Nothing here contacts a database; persistence of these states is a separate
// layer. Values are plain numbers; instants/season are the caller's concern.

export const POSTERIOR_STATE_VERSION = 1;

/** Weighted sufficient statistics for a single season. */
export interface SeasonSufficientStats {
  sumW: number; // Σ w
  sumWX: number; // Σ w·x
  sumWX2: number; // Σ w·x²
  sumW2: number; // Σ w²   (for ESS)
  count: number; // raw number of observations folded in
  /** Sorted, de-duplicated game ids folded into this season (lineage). */
  gameIds: string[];
}

export interface PosteriorState {
  version: number;
  featureKey: string;
  featureVersion: string;
  entityCanonicalId: string;
  /** Per-season stats, keyed by season number (e.g. 2026). */
  bySeason: Record<number, SeasonSufficientStats>;
}

export interface PosteriorObservation {
  value: number;
  weight: number;
  season: number;
  /** Canonical game id this observation came from (lineage / dedupe key). */
  gameId?: string;
}

function emptySeasonStats(): SeasonSufficientStats {
  return { sumW: 0, sumWX: 0, sumWX2: 0, sumW2: 0, count: 0, gameIds: [] };
}

export function emptyPosteriorState(
  featureKey: string,
  featureVersion: string,
  entityCanonicalId: string,
): PosteriorState {
  return {
    version: POSTERIOR_STATE_VERSION,
    featureKey,
    featureVersion,
    entityCanonicalId,
    bySeason: {},
  };
}

/** True iff `gameId` has already been folded into any season of this state. */
export function posteriorIncludesGame(state: PosteriorState, gameId: string): boolean {
  for (const season of Object.keys(state.bySeason)) {
    if (state.bySeason[Number(season)].gameIds.includes(gameId)) return true;
  }
  return false;
}

export interface UpdatePosteriorOptions {
  /**
   * Canonical id of the game being predicted. An observation drawn from this
   * game is refused (no self-update) — the single most important leakage guard
   * at the aggregation layer, complementing the feature-level firewall.
   */
  excludeGameId?: string;
}

/**
 * Fold one observation into the state, returning a NEW state (pure). No-ops when:
 *  • the weight is non-finite or <= 0 (nothing to add),
 *  • the value is non-finite,
 *  • the observation's game equals `excludeGameId` (self-update), or
 *  • the observation's game was already folded in (idempotent lineage).
 * Otherwise the season's sufficient statistics advance deterministically.
 */
export function updatePosterior(
  state: PosteriorState,
  obs: PosteriorObservation,
  options: UpdatePosteriorOptions = {},
): PosteriorState {
  if (!Number.isFinite(obs.weight) || obs.weight <= 0) return state;
  if (!Number.isFinite(obs.value)) return state;
  if (!Number.isInteger(obs.season)) return state;
  if (obs.gameId != null && options.excludeGameId != null && obs.gameId === options.excludeGameId) {
    return state; // no self-update
  }
  if (obs.gameId != null && posteriorIncludesGame(state, obs.gameId)) {
    return state; // idempotent — the same game never double-counts
  }

  const prev = state.bySeason[obs.season] ?? emptySeasonStats();
  const w = obs.weight;
  const x = obs.value;
  const nextSeason: SeasonSufficientStats = {
    sumW: prev.sumW + w,
    sumWX: prev.sumWX + w * x,
    sumWX2: prev.sumWX2 + w * x * x,
    sumW2: prev.sumW2 + w * w,
    count: prev.count + 1,
    gameIds:
      obs.gameId != null
        ? [...prev.gameIds, obs.gameId].sort()
        : prev.gameIds.slice(),
  };

  return {
    ...state,
    bySeason: { ...state.bySeason, [obs.season]: nextSeason },
  };
}

/** Combined (window-aggregated) sufficient statistics. */
export interface CombinedStats {
  sumW: number;
  sumWX: number;
  sumWX2: number;
  sumW2: number;
  count: number;
  seasonsIncluded: number[];
}

export const DEFAULT_SEASON_WINDOW = 3; // current + 2 priors

/**
 * Aggregate the sufficient statistics across the rolling season window
 * [currentSeason - (windowSize-1), currentSeason]. Seasons outside the window
 * are excluded — this is the rollover: when `currentSeason` advances, the oldest
 * season silently leaves the combined view without any stored state changing.
 */
export function combineSeasonWindow(
  state: PosteriorState,
  currentSeason: number,
  windowSize: number = DEFAULT_SEASON_WINDOW,
): CombinedStats {
  const oldest = currentSeason - (windowSize - 1);
  const combined: CombinedStats = {
    sumW: 0,
    sumWX: 0,
    sumWX2: 0,
    sumW2: 0,
    count: 0,
    seasonsIncluded: [],
  };
  for (const key of Object.keys(state.bySeason)) {
    const season = Number(key);
    if (season < oldest || season > currentSeason) continue;
    const s = state.bySeason[season];
    combined.sumW += s.sumW;
    combined.sumWX += s.sumWX;
    combined.sumWX2 += s.sumWX2;
    combined.sumW2 += s.sumW2;
    combined.count += s.count;
    combined.seasonsIncluded.push(season);
  }
  combined.seasonsIncluded.sort((a, b) => a - b);
  return combined;
}

/** Effective sample size ESS = (Σw)² / Σw². 0 when there is no mass. */
export function effectiveSampleSize(stats: CombinedStats): number {
  if (stats.sumW2 <= 0) return 0;
  return (stats.sumW * stats.sumW) / stats.sumW2;
}

/** Weighted mean, or null when there is no mass. */
export function posteriorMean(stats: CombinedStats): number | null {
  if (stats.sumW <= 0) return null;
  return stats.sumWX / stats.sumW;
}

/**
 * Weighted (population) variance, or null when there is no mass. Guards tiny
 * negative values from floating-point cancellation up to 0.
 */
export function posteriorVariance(stats: CombinedStats): number | null {
  if (stats.sumW <= 0) return null;
  const mean = stats.sumWX / stats.sumW;
  const raw = stats.sumWX2 / stats.sumW - mean * mean;
  return raw < 0 ? 0 : raw;
}

export interface Prior {
  mean: number;
  /** Prior strength in the SAME units as ESS (pseudo-observations). */
  strength: number;
}

/**
 * Prior-mass–guarded mean: blends the data mean with the prior by ESS, so at low
 * effective sample size the prior dominates and at high ESS the data dominates.
 *
 *   shrunk = (ESS·dataMean + strength·priorMean) / (ESS + strength)
 *
 * With no data (ESS 0) it returns exactly the prior; the denominator is only 0
 * when both ESS and strength are 0, in which case there is nothing to say → null.
 */
export function shrunkPosteriorMean(stats: CombinedStats, prior: Prior): number | null {
  const ess = effectiveSampleSize(stats);
  const denom = ess + prior.strength;
  if (denom <= 0) return null;
  const dataMean = posteriorMean(stats);
  const dataContribution = dataMean == null ? 0 : ess * dataMean;
  return (dataContribution + prior.strength * prior.mean) / denom;
}
