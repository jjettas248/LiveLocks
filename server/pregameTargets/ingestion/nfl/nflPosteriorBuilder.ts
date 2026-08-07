// PR6 — NFL ingestion: fold as-of feature rows into PR1 posterior states.
//
// Uses the EXISTING PR1 posterior + recency modules unchanged — no new posterior math.
// Only value-bearing readings (observed / observed_zero / imputed) fold; each carries its
// canonical game id so PR1's lineage/dedupe, no-self-update, correction (same game, new
// value), and season-rollover semantics all apply verbatim. Pure and deterministic.
// Imports no other sport engine.

import { updatePosterior, emptyPosteriorState, type PosteriorState } from "../../posteriorState/posteriorState";
import { computeRecencyWeight } from "../../posteriorState/recencyWeights";
import { instantMs, VALUE_BEARING_STATES, type AsOfFeatureRow } from "../../../../shared/pregameTargets/featureStore";
import { NFL_FEATURE_VERSION } from "./nflFeatureBuilder";

const MS_PER_DAY = 86_400_000;

export interface FoldNflPosteriorsArgs {
  rows: readonly AsOfFeatureRow[];
  currentSeason: number;
  /** Recency-WEIGHTING reference instant (ISO) — age/season decay anchor only; NOT
   *  payload availability (knownAt) and NOT a prediction/as-of read time. */
  asOfDate: string;
  priorStates?: ReadonlyMap<string, PosteriorState>;
  excludeGameId?: string;
}

/** Fold value-bearing NFL rows into per-featureKey posterior states. Returns a NEW map
 *  (pure). Non-value-bearing rows (missing / not_applicable / stale / disagreement) are
 *  skipped. Deterministic given identical inputs (rows sorted by featureKey, validAt,
 *  gameId). NFL per-game rate features all age as SKILL. */
export function foldNflPosteriors(args: FoldNflPosteriorsArgs): Map<string, PosteriorState> {
  const asOfMs = instantMs(args.asOfDate);
  const out = new Map<string, PosteriorState>();

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
      state = args.priorStates?.get(row.featureKey) ?? emptyPosteriorState(row.featureKey, NFL_FEATURE_VERSION, row.entityCanonicalId);
    }

    const seasonOffset = Math.max(0, args.currentSeason - row.season);
    const validMs = instantMs(row.validAt);
    const ageDays = Number.isFinite(asOfMs) && Number.isFinite(validMs) ? Math.max(0, (asOfMs - validMs) / MS_PER_DAY) : 0;
    const { weight } = computeRecencyWeight({ ageDays, seasonOffset, featureClass: "skill" });

    const gameId = row.derivedFromGameIds?.[0];
    state = updatePosterior(state, { value: row.value, weight, season: row.season, gameId }, { excludeGameId: args.excludeGameId });
    out.set(row.featureKey, state);
  }

  return out;
}
