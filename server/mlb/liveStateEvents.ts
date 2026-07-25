// ── MLB Live Edge — baseball state-event classification ───────────────────────
// Pure, I/O-free. Owns the ONE question the state watcher asks every poll:
// "did anything baseball-meaningful actually happen since the last observation?"
//
// This module exists because MLB is discrete and event-driven. Time is only
// used to DETECT events; events (never elapsed time) are what authorize an
// engine recomputation. Nothing here fetches, caches, scores, or mutates —
// it maps two GameStateCache snapshots to a list of real triggers.
//
// Extracted out of LiveGameOrchestrator.detectStateChange so it can be unit
// tested without booting the engine. The orchestrator method now delegates
// here; behaviour is identical except for the corrections documented below.

import type { GameStateCache } from "./dataPullService";
import type { MLBMarket } from "./types";
import { ALL_MLB_MARKETS } from "./types";
import { MLB_MARKET_FAMILIES } from "./marketFamily";

export type StateChangeTrigger =
  | "new_ab"
  | "ab_completed"
  | "ball_in_play"
  | "inning_change"
  | "pitcher_change"
  | "runner_change"
  | "pitch_count_threshold"
  | "tto_shift"
  | "lineup_substitution"
  | "hard_hit_event"
  | "out_recorded"
  | "score_change"
  | "odds_update"
  | "heartbeat_refresh";

export const HIGH_IMPACT_TRIGGERS = new Set<StateChangeTrigger>([
  "new_ab", "ab_completed", "inning_change", "pitcher_change",
  "tto_shift", "lineup_substitution", "out_recorded", "score_change",
]);

// Triggers that materially change remaining opportunity / matchup for EVERY
// actor in the game, so player-level narrowing is not valid for them.
export const GAME_WIDE_TRIGGERS = new Set<StateChangeTrigger>([
  "inning_change", "pitcher_change", "lineup_substitution", "tto_shift",
  "score_change", "out_recorded", "odds_update", "heartbeat_refresh",
]);

export const TRIGGER_IMPACTED_MARKETS: Record<StateChangeTrigger, MLBMarket[] | "all"> = {
  new_ab: "all",
  ab_completed: "all",
  ball_in_play: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed"],
  inning_change: "all",
  pitcher_change: "all",
  runner_change: ["hits", "total_bases", "hrr"],
  pitch_count_threshold: ["pitcher_strikeouts", "pitcher_outs", "hits_allowed"],
  tto_shift: "all",
  lineup_substitution: "all",
  hard_hit_event: ["hits", "total_bases", "home_runs", "hrr", "hits_allowed"],
  out_recorded: "all",
  score_change: "all",
  odds_update: "all",
  // Reconciliation backstop. NOT a synthetic baseball event — the backstop only
  // ever reaches triggerEngine when a real state divergence was found and
  // classified, in which case the real triggers are passed instead. This entry
  // exists solely so the record stays exhaustive for the type checker.
  heartbeat_refresh: "all",
};

// Canonical MLB pitcher deterioration thresholds. Unchanged from the original
// implementation — these are the Goldmaster thresholds and must not be
// re-derived, extended, or replaced with arbitrary values.
export const PITCH_COUNT_THRESHOLDS = [50, 65, 75, 85, 95, 105] as const;

/**
 * Classify the delta between two authoritative game-state snapshots into real
 * baseball events.
 *
 * Two corrections vs. the original inline implementation:
 *
 *  1. `ball_in_play` is derived from the play feed's batted-ball count
 *     (`battedBallEvents`), NOT from a pitch-count delta. A called strike, a
 *     ball, a swinging strike and a foul all increment `pitchCount` without a
 *     ball ever being put in play; treating that as contact made the engine
 *     recompute on essentially every pitch.
 *
 *  2. When `battedBallEvents` is absent from BOTH snapshots (older cached
 *     state written before the field existed, or a feed that didn't report it)
 *     no contact trigger is inferred at all. We never manufacture contact from
 *     a proxy — a missing counter means "unknown", not "yes".
 *
 * Everything else (inning, batter, pitcher, runners, outs, completed plays,
 * score, pitch-count threshold crossings, times-through-order, lineup size)
 * is unchanged from the original logic.
 */
export function classifyStateChange(
  oldState: GameStateCache,
  newState: GameStateCache,
): StateChangeTrigger[] {
  const triggers: StateChangeTrigger[] = [];

  if (oldState.inning !== newState.inning || oldState.isTopInning !== newState.isTopInning) {
    triggers.push("inning_change");
  }

  if (oldState.currentBatter?.playerId !== newState.currentBatter?.playerId) {
    triggers.push("new_ab");
  }

  if (oldState.pitcherInGame?.playerId !== newState.pitcherInGame?.playerId) {
    triggers.push("pitcher_change");
  }

  const oldRunners = JSON.stringify((oldState.runnersOnBase ?? []).sort());
  const newRunners = JSON.stringify((newState.runnersOnBase ?? []).sort());
  if (oldRunners !== newRunners) {
    triggers.push("runner_change");
  }

  // Real contact only. `battedBallEvents` is the play feed's cumulative count
  // of balls actually put in play (details.isInPlay / hitData present).
  const oldBip = oldState.battedBallEvents;
  const newBip = newState.battedBallEvents;
  if (typeof oldBip === "number" && typeof newBip === "number" && newBip > oldBip) {
    triggers.push("ball_in_play");
  }

  if (newState.outs !== oldState.outs) {
    triggers.push("out_recorded");
  }

  const oldTotal = oldState.totalPlays ?? 0;
  const newTotal = newState.totalPlays ?? 0;
  if (newTotal > oldTotal) {
    triggers.push("ab_completed");
  }

  const oldHomeScore = oldState.homeScore ?? 0;
  const oldAwayScore = oldState.awayScore ?? 0;
  const newHomeScore = newState.homeScore ?? 0;
  const newAwayScore = newState.awayScore ?? 0;
  if (newHomeScore !== oldHomeScore || newAwayScore !== oldAwayScore) {
    triggers.push("score_change");
  }

  // Threshold CROSSINGS only — 74→75 fires, 75→76 does not. Edge-triggered by
  // construction (old < t && new >= t), so a sustained high pitch count can
  // never re-fire the same threshold.
  for (const threshold of PITCH_COUNT_THRESHOLDS) {
    if (oldState.pitchCount < threshold && newState.pitchCount >= threshold) {
      triggers.push("pitch_count_threshold");
      break;
    }
  }

  const oldTTO = (oldState as any).timesThrough ?? 1;
  const newTTO = (newState as any).timesThrough ?? 1;
  if (newTTO > oldTTO) {
    triggers.push("tto_shift");
  }

  const oldBatterCount = (oldState as any).battingOrder?.length ?? 0;
  const newBatterCount = (newState as any).battingOrder?.length ?? 0;
  if (newBatterCount !== oldBatterCount && oldBatterCount > 0) {
    triggers.push("lineup_substitution");
  }

  return triggers;
}

/** True when the classified delta contains at least one real baseball event. */
export function isMaterialChange(triggers: readonly StateChangeTrigger[]): boolean {
  return triggers.length > 0;
}

/**
 * Markets impacted by a trigger set, closed over market families.
 *
 * Family closure matters: `runner_change` impacts {hits, total_bases, hrr} but
 * the `power` family is [home_runs, total_bases]. Without closure `total_bases`
 * would be re-ranked by applyFamilySuppression against a family missing its
 * `home_runs` sibling, and BOTH could end up isFlagship for the same player.
 * Closing the set makes "a family is never split" an invariant instead of a
 * coincidence. Closure only ever widens the set, never narrows it.
 */
export function computeImpactedMarkets(triggers: readonly StateChangeTrigger[]): Set<MLBMarket> {
  const impacted = new Set<MLBMarket>();
  for (const t of triggers) {
    const markets = TRIGGER_IMPACTED_MARKETS[t];
    if (markets === "all") {
      return new Set(ALL_MLB_MARKETS);
    }
    for (const m of markets) impacted.add(m);
  }

  // Family closure — pull in every sibling of an already-impacted market.
  // Restricted to ALL_MLB_MARKETS so disabled markets (walks_allowed,
  // hr_allowed, batter_strikeouts) are never resurrected by closure.
  const enabled = new Set<MLBMarket>(ALL_MLB_MARKETS);
  for (const m of Array.from(impacted)) {
    for (const members of Object.values(MLB_MARKET_FAMILIES)) {
      if (!members.includes(m)) continue;
      for (const sibling of members) {
        if (enabled.has(sibling)) impacted.add(sibling);
      }
    }
  }

  return impacted;
}

/**
 * Which actors a trigger set actually affects.
 *
 * Returns `all: true` whenever any trigger changes the game context for every
 * actor (inning, pitcher change, lineup, TTO, score, outs) — narrowing is only
 * valid for the strictly local triggers (`new_ab`, `ab_completed`,
 * `ball_in_play`, `runner_change`).
 *
 * On `ab_completed` the batter who just finished is the PREVIOUS
 * `currentBatter`; `newState.currentBatter` has already advanced. Both are
 * included, which is why this needs the prev/next pair rather than just the
 * current state.
 */
export function affectedActors(
  triggers: readonly StateChangeTrigger[],
  oldState: GameStateCache | null,
  newState: GameStateCache,
): { all: boolean; playerIds: Set<string> } {
  const playerIds = new Set<string>();
  const all = triggers.length === 0 || triggers.some(t => GAME_WIDE_TRIGGERS.has(t));

  const add = (id: string | null | undefined) => {
    if (id && id !== "unknown") playerIds.add(id);
  };

  add(oldState?.currentBatter?.playerId);
  add(newState.currentBatter?.playerId);
  add(oldState?.pitcherInGame?.playerId);
  add(newState.pitcherInGame?.playerId);

  // On-deck — the next batter in the order after the current one. A completed
  // PA changes their remaining-PA estimate too.
  const order = newState.battingOrder ?? [];
  const currentId = newState.currentBatter?.playerId;
  if (currentId) {
    const idx = order.findIndex(b => b.playerId === currentId);
    if (idx >= 0 && order.length > 0) {
      add(order[(idx + 1) % order.length]?.playerId);
    }
  }

  return { all, playerIds };
}
