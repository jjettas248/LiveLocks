// PR5 — NBA ingestion: fold as-of feature rows into PR1 posterior states.
//
// Uses the EXISTING PR1 posterior + recency modules unchanged — no new posterior
// math. Only value-bearing readings (observed / observed_zero / imputed) fold;
// each observation carries its canonical game id so PR1's lineage/dedupe,
// no-self-update, correction (same game, new value), and season-rollover
// semantics all apply verbatim. Recency weight = the PR1 §5B product, computed
// relative to a caller-supplied as-of instant + current season.
//
// Pure and deterministic.

import { updatePosterior, emptyPosteriorState, type PosteriorState } from "../posteriorState/posteriorState";
import { computeRecencyWeight, type FeatureClass } from "../posteriorState/recencyWeights";
import { instantMs, VALUE_BEARING_STATES, type AsOfFeatureRow } from "../../../shared/pregameTargets/featureStore";
import { NBA_FEATURE_VERSION, NBA_MINUTES_FEATURE } from "./nbaFeatureBuilder";

const MS_PER_DAY = 86_400_000;

/** Minutes ages as ROLE (faster decay); scoring/usage rates age as SKILL. */
function featureClassFor(featureKey: string): FeatureClass {
  return featureKey === NBA_MINUTES_FEATURE ? "role" : "skill";
}

export interface FoldNbaPosteriorsArgs {
  rows: readonly AsOfFeatureRow[];
  currentSeason: number;
  /** Reference instant for recency (ISO). Typically the ingestion "as of now". */
  asOfDate: string;
  /** Existing posterior states keyed by featureKey (from the DB), if any. */
  priorStates?: ReadonlyMap<string, PosteriorState>;
  /** Canonical id of a game to exclude (no-self-update); usually unused at ingestion. */
  excludeGameId?: string;
}

/**
 * Fold value-bearing rows into per-featureKey posterior states. Returns a NEW map
 * (pure). Non-value-bearing rows (missing / not_applicable / stale / disagreement)
 * are skipped — they carry no observation. Deterministic given identical inputs.
 */
export function foldNbaPosteriors(args: FoldNbaPosteriorsArgs): Map<string, PosteriorState> {
  const asOfMs = instantMs(args.asOfDate);
  const out = new Map<string, PosteriorState>();

  // Deterministic order: sort rows by (featureKey, validAt, gameId) so the folded
  // aggregate never depends on input ordering.
  const ordered = [...args.rows].sort((a, b) => {
    if (a.featureKey !== b.featureKey) return a.featureKey < b.featureKey ? -1 : 1;
    if (a.validAt !== b.validAt) return a.validAt < b.validAt ? -1 : 1;
    const ga = a.derivedFromGameIds?.[0] ?? "";
    const gb = b.derivedFromGameIds?.[0] ?? "";
    return ga < gb ? -1 : ga > gb ? 1 : 0;
  });

  for (const row of ordered) {
    if (!VALUE_BEARING_STATES.has(row.state)) continue;
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) continue;

    let state = out.get(row.featureKey);
    if (state === undefined) {
      state =
        args.priorStates?.get(row.featureKey) ??
        emptyPosteriorState(row.featureKey, NBA_FEATURE_VERSION, row.entityCanonicalId);
    }

    const seasonOffset = Math.max(0, args.currentSeason - row.season);
    const validMs = instantMs(row.validAt);
    const ageDays = Number.isFinite(asOfMs) && Number.isFinite(validMs) ? Math.max(0, (asOfMs - validMs) / MS_PER_DAY) : 0;
    const { weight } = computeRecencyWeight({ ageDays, seasonOffset, featureClass: featureClassFor(row.featureKey) });

    const gameId = row.derivedFromGameIds?.[0];
    state = updatePosterior(state, { value: row.value, weight, season: row.season, gameId }, { excludeGameId: args.excludeGameId });
    out.set(row.featureKey, state);
  }

  return out;
}
