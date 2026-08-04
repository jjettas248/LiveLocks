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

/** One game's contribution to a season's sufficient statistics. */
export interface GameContribution {
  w: number; // w
  wx: number; // w·x
  wx2: number; // w·x²
  w2: number; // w²
}

/** Weighted sufficient statistics for a single season. */
export interface SeasonSufficientStats {
  sumW: number; // Σ w
  sumWX: number; // Σ w·x
  sumWX2: number; // Σ w·x²
  sumW2: number; // Σ w²   (for ESS)
  count: number; // number of distinct folds (games + gameless observations)
  /** Sorted, de-duplicated game ids folded into this season (lineage). */
  gameIds: string[];
  /**
   * Per-game contribution, keyed by canonical game id (sorted keys). Retaining
   * each game's contribution is what lets a CORRECTION for an already-folded
   * game REPLACE its prior contribution (append-only correction model) rather
   * than being discarded as a retry — the aggregate sums are adjusted by the
   * delta (new − old), so the posterior tracks the corrected value.
   */
  byGame: Record<string, GameContribution>;
  /** Folds with no game id (cannot be corrected or de-duplicated). */
  gamelessCount: number;
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
  return { sumW: 0, sumWX: 0, sumWX2: 0, sumW2: 0, count: 0, gameIds: [], byGame: {}, gamelessCount: 0 };
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
    if (state.bySeason[Number(season)].byGame[gameId] !== undefined) return true;
  }
  return false;
}

/**
 * Remove a single game's contribution from a season's sufficient statistics
 * (subtract its sums, drop it from `byGame`/`gameIds`, decrement `count`).
 * Returns the reduced season, or `null` when the season is left completely
 * empty (no games and no gameless folds) so the caller can delete the key and
 * keep serialization free of zeroed phantom seasons.
 */
function removeGameFromSeason(
  s: SeasonSufficientStats,
  gameId: string,
  old: GameContribution,
): SeasonSufficientStats | null {
  const byGame: Record<string, GameContribution> = { ...s.byGame };
  delete byGame[gameId];
  const gameIds = Object.keys(byGame).sort();
  const count = s.count - 1;
  if (count <= 0 && s.gamelessCount === 0) return null;
  const sortedByGame: Record<string, GameContribution> = {};
  for (const k of gameIds) sortedByGame[k] = byGame[k];
  return {
    sumW: s.sumW - old.w,
    sumWX: s.sumWX - old.wx,
    sumWX2: s.sumWX2 - old.wx2,
    sumW2: s.sumW2 - old.w2,
    count,
    gameIds,
    byGame: sortedByGame,
    gamelessCount: s.gamelessCount,
  };
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
 *  • the season is not an integer, or
 *  • the observation's game equals `excludeGameId` (self-update).
 *
 * When the observation's game was ALREADY folded in, it is treated as a
 * CORRECTION: the prior per-game contribution is replaced (aggregate sums are
 * adjusted by new − old), honoring the append-only correction model rather than
 * discarding the update. Re-folding an identical value+weight is therefore a
 * true no-op (delta 0); a corrected value moves the posterior. Game count is
 * unchanged on a correction. A gameless observation is purely additive (it can
 * neither be de-duplicated nor corrected). Deterministic; keys kept sorted.
 *
 * A game is folded into AT MOST ONE season. If a correction also fixes the
 * season label (a backfill re-assigning the same canonical game to a different
 * season), the stale contribution is first REMOVED from its old season before
 * the corrected row is applied to the new one — otherwise `combineSeasonWindow`
 * could include both seasons and double-count the same game (keeping the stale
 * value alongside the corrected one).
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

  // Work against an editable clone of bySeason: a cross-season correction below
  // may modify TWO seasons (the old one loses the game, the new one gains it).
  const bySeasonNext: Record<number, SeasonSufficientStats> = { ...state.bySeason };

  // Cross-season relocation: if this game is already folded under a DIFFERENT
  // season, strip its stale contribution from that season first so it survives
  // in exactly one season (the corrected one) and can never be double-counted.
  if (obs.gameId != null) {
    for (const key of Object.keys(bySeasonNext)) {
      const seasonNum = Number(key);
      if (seasonNum === obs.season) continue;
      const stale = bySeasonNext[seasonNum].byGame[obs.gameId];
      if (stale === undefined) continue;
      const reduced = removeGameFromSeason(bySeasonNext[seasonNum], obs.gameId, stale);
      if (reduced === null) delete bySeasonNext[seasonNum];
      else bySeasonNext[seasonNum] = reduced;
    }
  }

  const prev = bySeasonNext[obs.season] ?? emptySeasonStats();
  const w = obs.weight;
  const x = obs.value;
  const contribution: GameContribution = { w, wx: w * x, wx2: w * x * x, w2: w * w };

  let sumW = prev.sumW;
  let sumWX = prev.sumWX;
  let sumWX2 = prev.sumWX2;
  let sumW2 = prev.sumW2;
  let count = prev.count;
  let gamelessCount = prev.gamelessCount;
  const byGame: Record<string, GameContribution> = { ...prev.byGame };

  if (obs.gameId == null) {
    // Gameless: purely additive; no provenance, no correction possible.
    sumW += contribution.w;
    sumWX += contribution.wx;
    sumWX2 += contribution.wx2;
    sumW2 += contribution.w2;
    count += 1;
    gamelessCount += 1;
  } else if (byGame[obs.gameId] !== undefined) {
    // Correction (or identical re-fold): replace the prior contribution.
    const old = byGame[obs.gameId];
    sumW += contribution.w - old.w;
    sumWX += contribution.wx - old.wx;
    sumWX2 += contribution.wx2 - old.wx2;
    sumW2 += contribution.w2 - old.w2;
    byGame[obs.gameId] = contribution; // count unchanged — same fold, new value
  } else {
    // New game.
    sumW += contribution.w;
    sumWX += contribution.wx;
    sumWX2 += contribution.wx2;
    sumW2 += contribution.w2;
    count += 1;
    byGame[obs.gameId] = contribution;
  }

  // Canonical key ordering so serialization is insertion-order-independent.
  const gameIds = Object.keys(byGame).sort();
  const sortedByGame: Record<string, GameContribution> = {};
  for (const k of gameIds) sortedByGame[k] = byGame[k];

  const nextSeason: SeasonSufficientStats = {
    sumW,
    sumWX,
    sumWX2,
    sumW2,
    count,
    gameIds,
    byGame: sortedByGame,
    gamelessCount,
  };

  return {
    ...state,
    bySeason: { ...bySeasonNext, [obs.season]: nextSeason },
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
