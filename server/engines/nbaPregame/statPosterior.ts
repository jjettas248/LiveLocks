// PR3 — NBA Pregame Targets: posterior → game-total moments bridge.
//
// The single, explicit bridge from PR1's as-of Bayesian posteriors to the
// game-total count MOMENTS the projection distribution is built from. One bridge
// per base stat (points, rebounds, assists, three_pointers_made), each fully
// specified below so there is no hidden modeling step:
//
//   • MODELED RATE UNIT — a PER-MINUTE rate. The posterior state stores weighted
//     sufficient statistics of the player's observed per-minute production for
//     the stat; the game total is that rate carried over the minutes the player
//     is expected to play.
//   • SUFFICIENT STATISTICS CONSUMED — combineSeasonWindow over the rolling
//     current + two-prior-season window (PR1), giving Σw, Σwx, Σwx², Σw² and the
//     effective sample size ESS = (Σw)²/Σw².
//   • PRIOR — a Prior{mean, strength} per-minute-rate prior (league/positional).
//     shrunkPosteriorMean blends the data rate toward it by ESS, so at low ESS the
//     prior dominates (reason `prior_dominant`) and the stat STILL projects.
//   • POSTERIOR MEAN + VARIANCE — the shrunk per-minute rate mean, and a
//     prior-shrunk per-minute rate variance (game-to-game rate dispersion).
//   • MIXING OVER MINUTES — the rate is mixed over the player's minutes
//     distribution EXACTLY ONCE. The game-total mean is rateMean · E[minutes];
//     there is no second game-total mixture on top of an already-minutes-mixed
//     total (that would double-count the minutes/rate uncertainty).
//   • OVERDISPERSION — introduced through (a) game-to-game rate variance and
//     (b) minutes variance, via the law of total variance:
//         Var[count] = rateMean·E[m] + rateVar·E[m²] + rateMean²·Var[m]
//     so Var[count] > E[count] whenever minutes or the rate carry any spread.
//
// The bridge PROJECTS for reasons `available` and `prior_dominant`. It returns a
// typed UNAVAILABLE (no moments) only for genuine absence/invalidity:
// `missing_posterior` (no posterior state at all), `missing_minutes` (no minutes
// distribution), `invalid_input` (malformed prior/state). Low ESS is never by
// itself a reason to withhold a projection.
//
// Pure, deterministic, line-free.

import {
  combineSeasonWindow,
  effectiveSampleSize,
  posteriorMean,
  posteriorVariance,
  shrunkPosteriorMean,
  DEFAULT_SEASON_WINDOW,
  type PosteriorState,
  type Prior,
} from "../../pregameTargets/posteriorState/posteriorState";
import type { NbaBaseStat } from "./markets";
import type { JointComponentMoments } from "./joint/pointsReboundsAssistsJoint";
import type { PlayerMinutesDistribution } from "./minutes/teamMinutesAllocator";

export type StatPosteriorReason =
  | "available" // posterior present, ESS >= minEss — data-informed
  | "prior_dominant" // posterior present but ESS < minEss — prior dominates, still projects
  | "missing_posterior" // no posterior state supplied (genuine absence) — unavailable
  | "missing_minutes" // no minutes distribution supplied — unavailable
  | "invalid_input"; // malformed prior/state/config — unavailable

/** ESS at/above which the projection is considered data-driven (`available`). */
export const DEFAULT_MIN_ESS = 5;

/** Prior coefficient-of-variation² used for the rate-variance prior at low ESS. */
export const DEFAULT_PRIOR_DISPERSION_CV2 = 0.05;

export interface StatPosteriorInputs {
  stat: NbaBaseStat;
  /** Per-minute-rate posterior for this stat (PR1). Null → missing_posterior. */
  posterior: PosteriorState | null;
  /** Current season anchor for the rolling window. */
  currentSeason: number;
  /** Per-minute-rate prior (league/positional). Required. */
  prior: Prior;
  /** This player's minutes distribution (allocator). Null → missing_minutes. */
  minutes: PlayerMinutesDistribution | null;
  /** ESS threshold for `available`. Default DEFAULT_MIN_ESS. */
  minEss?: number;
  /** Season-window size. Default DEFAULT_SEASON_WINDOW (current + 2 priors). */
  windowSize?: number;
  /** Prior cv² for the rate-variance prior. Default DEFAULT_PRIOR_DISPERSION_CV2. */
  priorDispersionCv2?: number;
}

export interface StatPosteriorResult {
  stat: NbaBaseStat;
  reason: StatPosteriorReason;
  projected: boolean;
  /** Game-total count moments feeding the distribution, or null when unavailable. */
  moments: JointComponentMoments | null;
  /** Posterior per-minute rate mean, or null when unavailable. */
  rateMean: number | null;
  /** Prior-shrunk per-minute rate variance (game-to-game dispersion), or null. */
  rateVariance: number | null;
  /** Effective sample size behind the rate. */
  ess: number;
  /** E[minutes] used in the single rate×minutes mix, or null. */
  minutesMean: number | null;
}

function unavailable(stat: NbaBaseStat, reason: StatPosteriorReason, ess = 0): StatPosteriorResult {
  return { stat, reason, projected: false, moments: null, rateMean: null, rateVariance: null, ess, minutesMean: null };
}

function validPrior(prior: Prior | undefined | null): prior is Prior {
  return (
    prior != null &&
    Number.isFinite(prior.mean) &&
    prior.mean >= 0 &&
    Number.isFinite(prior.strength) &&
    prior.strength >= 0
  );
}

/** First three raw minutes moments E[m], E[m²], Var[m] from a minutes distribution. */
function minutesMoments(dist: PlayerMinutesDistribution): { em: number; em2: number; varm: number } {
  let em = 0;
  let em2 = 0;
  for (const s of dist.support) {
    em += s.prob * s.minutes;
    em2 += s.prob * s.minutes * s.minutes;
  }
  const varm = Math.max(0, em2 - em * em);
  return { em, em2, varm };
}

/**
 * Bridge one base stat's posterior to game-total count moments. Pure and
 * deterministic. Never throws on well-typed input — genuine absence/invalidity is
 * returned as a typed unavailable result (the engine's pure core may still throw
 * on a downstream impossible state; that is a separate layer).
 */
export function bridgeStatPosterior(inputs: StatPosteriorInputs): StatPosteriorResult {
  const { stat } = inputs;
  if (!validPrior(inputs.prior)) return unavailable(stat, "invalid_input");
  if (!Number.isInteger(inputs.currentSeason)) return unavailable(stat, "invalid_input");
  if (inputs.minutes == null || !Array.isArray(inputs.minutes.support)) {
    return unavailable(stat, "missing_minutes");
  }
  if (inputs.posterior == null) return unavailable(stat, "missing_posterior");

  const windowSize = inputs.windowSize ?? DEFAULT_SEASON_WINDOW;
  const minEss = inputs.minEss ?? DEFAULT_MIN_ESS;
  const priorCv2 = inputs.priorDispersionCv2 ?? DEFAULT_PRIOR_DISPERSION_CV2;

  const combined = combineSeasonWindow(inputs.posterior, inputs.currentSeason, windowSize);
  const ess = effectiveSampleSize(combined);

  // Posterior per-minute rate mean — prior-shrunk (prior dominates at low ESS).
  const rateMean = shrunkPosteriorMean(combined, inputs.prior);
  if (rateMean == null || !Number.isFinite(rateMean) || rateMean < 0) {
    // Only possible when ESS and prior strength are both 0 → nothing to say.
    return unavailable(stat, "invalid_input", ess);
  }

  // Rate variance (game-to-game per-minute dispersion), prior-shrunk by ESS so a
  // thin sample does not claim a spuriously tiny/huge dispersion. The prior
  // dispersion is priorCv2 · rateMean² (a cv² prior in per-minute-rate units).
  const dataVar = posteriorVariance(combined);
  const priorVar = priorCv2 * rateMean * rateMean;
  const denom = ess + inputs.prior.strength;
  const rateVariance =
    denom > 0 ? (ess * (dataVar ?? 0) + inputs.prior.strength * priorVar) / denom : priorVar;

  // Single mix over minutes → game-total moments.
  const { em, em2, varm } = minutesMoments(inputs.minutes);
  const mean = rateMean * em;
  // Var[count] = rateMean·E[m] (Poisson part) + rateVar·E[m²] + rateMean²·Var[m].
  const variance = rateMean * em + rateVariance * em2 + rateMean * rateMean * varm;

  // A degenerate all-DNP minutes distribution (E[m]=0) yields a point mass at 0;
  // that is a real (if trivial) projection, not an error.
  const safeVariance = mean > 0 ? Math.max(variance, mean * 1.000001 + 1e-9) : Math.max(variance, 1e-9);

  const reason: StatPosteriorReason = ess >= minEss ? "available" : "prior_dominant";
  return {
    stat,
    reason,
    projected: true,
    moments: { mean, variance: safeVariance },
    rateMean,
    rateVariance,
    ess,
    minutesMean: em,
  };
}
