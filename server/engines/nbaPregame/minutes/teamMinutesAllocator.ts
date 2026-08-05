// PR3 — NBA Pregame Targets: roster-level team minutes allocator.
//
// Minutes are the multiplier that turns a per-minute rate into a game count, so
// the projection is only as honest as its minutes model. This allocator is
// ROSTER-LEVEL by design: team minutes are a CONSERVED quantity, and a player's
// minutes distribution is derived from the team allocation rather than guessed in
// isolation. The hard constraint is
//
//     Σ_i E[minutes_i]  =  240 + 25 · E[OT periods]
//
// (48 min × 5 on-court = 240 regulation player-minutes; each 5-min overtime adds
// 5 × 5 = 25). The conservation test asserts this against the REAL allocator
// output, never a detached re-derivation.
//
// Three properties the correction requires and this construction guarantees:
//   • DNP / inactive mass is a DISTINCT atom at 0 minutes (sized by 1 − playProb),
//     never smeared into the active role variance.
//   • Overtime is PROBABILITY MASS: a player's higher-minute support points appear
//     only with their overtime-period probabilities, not as a blanket bonus added
//     to everyone's mean.
//   • Fail closed: absent/empty roster info throws (the engine's safe boundary
//     turns that into a typed unavailable result) rather than inventing minutes.
//
// Pure, deterministic, line-free. No imports outside this engine.

export interface RosterPlayerMinutesInput {
  playerId: string;
  /** P(player is active / plays at all) in [0,1]. Drives the DNP atom. */
  playProbability: number;
  /** Role central regulation minutes if active (>= 0). */
  projectedMinutesIfActive: number;
  /** Role std-dev of active minutes (spread). Absent → a default fraction of the mean. */
  minutesSpread?: number;
  /** Relative overtime-participation weight. Absent → projectedMinutesIfActive (starters play OT). */
  otParticipation?: number;
}

export interface TeamMinutesInput {
  players: RosterPlayerMinutesInput[];
  /**
   * Probability of exactly [0,1,2,…] overtime periods, index = period count.
   * Absent/empty → [1] (regulation certain). Normalized internally.
   */
  otPeriodProbabilities?: number[];
}

export interface MinutesSupportPoint {
  minutes: number;
  prob: number;
}

export interface PlayerMinutesDistribution {
  playerId: string;
  /** Discrete minutes support (minutes, prob), probabilities sum to 1. */
  support: MinutesSupportPoint[];
  /** Σ prob · minutes. */
  expectedMinutes: number;
  /** P(0 minutes) = 1 − playProbability — the DNP/inactive atom, kept distinct. */
  dnpProbability: number;
}

export interface TeamMinutesAllocation {
  players: PlayerMinutesDistribution[];
  /** Σ_i expectedMinutes — equals minuteBudget by construction (conservation). */
  expectedTeamMinutes: number;
  expectedOtPeriods: number;
  /** 240 + 25 · E[OT periods]. */
  minuteBudget: number;
  /** Normalized overtime-period distribution actually used. */
  otPeriodProbabilities: number[];
}

const REGULATION_TEAM_MINUTES = 240;
const OT_TEAM_MINUTES_PER_PERIOD = 25;
const OT_PLAYER_MINUTES_PER_PERIOD = 5;
const REGULATION_PLAYER_MAX = 48;
const DEFAULT_SPREAD_FRACTION = 0.18;
const MIN_ACTIVE_SPREAD = 1.5;

/** Mean-preserving 3-point discretization of active role variance. */
const ROLE_SPREAD_POINTS = [-1, 0, 1] as const;
const ROLE_SPREAD_WEIGHTS = [0.25, 0.5, 0.25] as const;

function normalizeOtProbabilities(raw: number[] | undefined): number[] {
  if (!raw || raw.length === 0) return [1];
  for (const p of raw) {
    if (!Number.isFinite(p) || p < 0) {
      throw new Error(`teamMinutes: overtime probability must be finite non-negative, got ${p}`);
    }
  }
  const total = raw.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("teamMinutes: overtime probabilities sum to zero");
  return raw.map((p) => p / total);
}

function validatePlayer(p: RosterPlayerMinutesInput): void {
  if (typeof p.playerId !== "string" || p.playerId.length === 0) {
    throw new Error("teamMinutes: player missing playerId");
  }
  if (!Number.isFinite(p.playProbability) || p.playProbability < 0 || p.playProbability > 1) {
    throw new Error(`teamMinutes: ${p.playerId} playProbability out of [0,1]: ${p.playProbability}`);
  }
  if (!Number.isFinite(p.projectedMinutesIfActive) || p.projectedMinutesIfActive < 0) {
    throw new Error(`teamMinutes: ${p.playerId} projectedMinutesIfActive invalid: ${p.projectedMinutesIfActive}`);
  }
  if (p.minutesSpread !== undefined && (!Number.isFinite(p.minutesSpread) || p.minutesSpread < 0)) {
    throw new Error(`teamMinutes: ${p.playerId} minutesSpread invalid: ${p.minutesSpread}`);
  }
  if (p.otParticipation !== undefined && (!Number.isFinite(p.otParticipation) || p.otParticipation < 0)) {
    throw new Error(`teamMinutes: ${p.playerId} otParticipation invalid: ${p.otParticipation}`);
  }
}

/**
 * Allocate team minutes across the roster under the conservation constraint, then
 * derive each player's minutes distribution. Pure and deterministic; THROWS on an
 * absent/empty roster or a roster with no allocatable active minutes (fail closed).
 */
export function allocateTeamMinutes(input: TeamMinutesInput): TeamMinutesAllocation {
  if (!input || !Array.isArray(input.players) || input.players.length === 0) {
    throw new Error("teamMinutes: roster info absent (fail closed)");
  }
  for (const p of input.players) validatePlayer(p);

  const otProbs = normalizeOtProbabilities(input.otPeriodProbabilities);
  const expectedOtPeriods = otProbs.reduce((acc, q, n) => acc + q * n, 0);
  const minuteBudget = REGULATION_TEAM_MINUTES + OT_TEAM_MINUTES_PER_PERIOD * expectedOtPeriods;
  const maxOt = otProbs.length - 1;

  // Active-weighted raw regulation minutes; scale so Σ π_i r_i = 240 exactly.
  const rawWeighted = input.players.map((p) => p.playProbability * p.projectedMinutesIfActive);
  const rawSum = rawWeighted.reduce((a, b) => a + b, 0);
  if (rawSum <= 0) throw new Error("teamMinutes: no allocatable active minutes (fail closed)");
  const alpha = REGULATION_TEAM_MINUTES / rawSum;

  // Overtime-participation shares s_i normalized so Σ π_i s_i = 1 (⇒ the 25·n OT
  // minutes are conserved per overtime count, and hence in expectation).
  const otWeights = input.players.map((p) => p.otParticipation ?? p.projectedMinutesIfActive);
  const otWeightedSum = input.players.reduce((acc, p, i) => acc + p.playProbability * otWeights[i], 0);
  const otShareDenom = otWeightedSum > 0 ? otWeightedSum : 1;

  const players: PlayerMinutesDistribution[] = input.players.map((p, i) => {
    const pi = p.playProbability;
    const rI = p.projectedMinutesIfActive * alpha; // scaled regulation mean (if active)
    const sI = otWeightedSum > 0 ? otWeights[i] / otShareDenom : 0; // OT share
    const spread = Math.max(MIN_ACTIVE_SPREAD, p.minutesSpread ?? DEFAULT_SPREAD_FRACTION * rI);

    const support: MinutesSupportPoint[] = [];
    const dnpProbability = 1 - pi;
    if (dnpProbability > 0) {
      support.push({ minutes: 0, prob: dnpProbability }); // DNP atom — distinct from role variance
    }
    for (let n = 0; n < otProbs.length; n++) {
      const qn = otProbs[n];
      if (qn <= 0) continue;
      // OT extra = this player's share (s_i) of the team's 25·n overtime
      // minutes, so Σ π_i·(s_i·25·n) = 25·n conserves the team total. The
      // per-player 5-min-per-period figure bounds the PHYSICAL max, not the mean.
      const condMean = Math.min(rI + sI * OT_TEAM_MINUTES_PER_PERIOD * n, REGULATION_PLAYER_MAX + OT_PLAYER_MINUTES_PER_PERIOD * n);
      const physicalMax = REGULATION_PLAYER_MAX + OT_PLAYER_MINUTES_PER_PERIOD * n;
      // Shrink the spread SYMMETRICALLY so both extreme points stay within
      // [0, physicalMax]. A symmetric ±spread with weights 0.25/0.5/0.25 has mean
      // exactly condMean — preserving it (rather than clamping an out-of-range
      // point) is what keeps team-minute conservation EXACT at the boundaries.
      const effectiveSpread = Math.max(0, Math.min(spread, physicalMax - condMean, condMean));
      for (let d = 0; d < ROLE_SPREAD_POINTS.length; d++) {
        const minutes = condMean + ROLE_SPREAD_POINTS[d] * effectiveSpread;
        const prob = pi * qn * ROLE_SPREAD_WEIGHTS[d];
        if (prob > 0) support.push({ minutes, prob });
      }
    }
    const expectedMinutes = support.reduce((acc, s) => acc + s.prob * s.minutes, 0);
    return { playerId: p.playerId, support, expectedMinutes, dnpProbability };
  });

  const expectedTeamMinutes = players.reduce((acc, p) => acc + p.expectedMinutes, 0);

  return { players, expectedTeamMinutes, expectedOtPeriods, minuteBudget, otPeriodProbabilities: otProbs };
}

/** Convenience: the single-player minutes distribution for a given id (or null). */
export function playerMinutes(
  allocation: TeamMinutesAllocation,
  playerId: string,
): PlayerMinutesDistribution | null {
  return allocation.players.find((p) => p.playerId === playerId) ?? null;
}

export {
  REGULATION_TEAM_MINUTES,
  OT_TEAM_MINUTES_PER_PERIOD,
  OT_PLAYER_MINUTES_PER_PERIOD,
  REGULATION_PLAYER_MAX,
};
