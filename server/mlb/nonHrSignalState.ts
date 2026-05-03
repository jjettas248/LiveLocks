// MLB Signals audit P2 — engine state machine for non-HR markets.
// Mirrors the HR Radar state machine pattern (BUILDING -> ACTIVE -> COOLING
// -> CLOSED, terminal CLOSED). Engine-as-truth: nothing in the UI or routes
// derives state; the orchestrator owns transitions and persists them in
// memory across recompute ticks so trajectory (rising / falling) can be
// observed.
//
// State semantics:
//   BUILDING — pre-actionable. Engine is gathering enough signal to fire.
//              `signalScore` is below the watchlist threshold (default 55).
//   ACTIVE   — actionable. Score >= threshold; the card is bettable.
//   COOLING  — actionable but trajectory is fading. Score has dropped by
//              >= COOLING_DROP from the peak observed for this entry, or
//              the game has stalled (no fresh play feed events).
//   CLOSED   — terminal. The prop has been resolved (line crossed) or the
//              game has gone final. Cannot be re-entered.
//
// Transition rules (subject to terminal CLOSED guard):
//   * gameFinal === true OR external `closeNonHrSignalOnHit` -> CLOSED
//   * prevState === CLOSED -> CLOSED  (terminal)
//   * score >= ACTIVE_THRESHOLD AND score >= peak - COOLING_DROP -> ACTIVE
//   * score >= ACTIVE_THRESHOLD AND score < peak - COOLING_DROP   -> COOLING
//   * score <  ACTIVE_THRESHOLD                                   -> BUILDING

export type NonHrSignalState = "BUILDING" | "ACTIVE" | "COOLING" | "CLOSED";

interface NonHrStateEntry {
  gameId: string;
  playerId: string;
  market: string;
  currentState: NonHrSignalState;
  peakScore: number;       // highest signalScore observed (used for COOLING)
  peakAtMs: number;        // ms epoch when peakScore was last (re)set
  peakPaCount: number;     // priorABResults.length captured at peak
  peakPitchCount: number;  // pitcher's pitchCount captured at peak (pitcher markets)
  // MLB Signals audit P3 fix — track *last seen* counts independently from
  // peak counts so the "saw a new event" edge fires once per actual PA /
  // pitch increment. Using peak counters here caused `lastEventAtMs` to be
  // reset on every tick where the current count exceeded peak, which
  // suppressed staleness decay and the COOLING transition entirely.
  lastPaCount: number;
  lastPitchCount: number;
  lastScore: number;
  lastEventAtMs: number;   // ms epoch when the player last had a fresh play feed event
  lastTransitionAt: number; // ms epoch — when currentState last changed
  lastUpdateAt: number;     // ms epoch — when entry was last touched
}

const NON_HR_STATES = new Map<string, NonHrStateEntry>();

// Daily slate-reset helper. Drops every entry whose gameId is not in the
// supplied active set. Use this after the slate has rolled to evict residue
// from games whose `final` transition was missed (server restart, API hiccup).
export function clearStaleNonHrStates(activeGameIds: ReadonlySet<string>): number {
  let removed = 0;
  for (const [key, entry] of Array.from(NON_HR_STATES.entries())) {
    if (!activeGameIds.has(entry.gameId)) {
      NON_HR_STATES.delete(key);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[MLB_SLATE_RESET] nonHrSignalState pruned=${removed} kept=${NON_HR_STATES.size}`);
  }
  return removed;
}

export function getNonHrSignalStateSize(): number {
  return NON_HR_STATES.size;
}

const ACTIVE_THRESHOLD = 55;   // matches existing `watchlistThreshold` in orchestrator
const COOLING_DROP = 8;        // points below peak that triggers COOLING

// MLB Signals audit P3 — decay rail. Time half-life mirrors the HR engine
// (10 min). PA half-life is short for batter markets (each completed AB
// without a hit / TB / HRR contribution shrinks the remaining-PA budget).
// Pitch half-life is for pitcher markets (each pitch without a K eats
// remaining-pitch budget). Stale half-life kicks in only after a grace
// window so the rail does not over-decay during natural between-PA gaps.
const TIME_HALF_LIFE_MIN = 10;
const PA_HALF_LIFE_BATTER = 1.5;       // each ~1.5 PAs without progress halves the score
const PITCH_HALF_LIFE_PITCHER = 12;    // each ~12 pitches without a K halves the score
const STALE_GRACE_MIN = 4;             // grace before stale-event decay kicks in
const STALE_HALF_LIFE_MIN = 6;

// MLB Signals audit P3 fix — keep this list in sync with the orchestrator's
// `isPitcherMarket` predicate (see liveGameOrchestrator.ts ~L1710). Drift
// here causes the wrong decay rail to be chosen for pitcher markets — e.g.
// `hr_allowed` was previously falling through to the batter PA rail.
const PITCHER_MARKETS = new Set([
  "pitcher_strikeouts",
  "pitcher_outs",
  "hits_allowed",
  "earned_runs",
  "walks_allowed",
  "hr_allowed",
]);

function computeNonHrDecayFactor(opts: {
  market: string;
  nowMs: number;
  peakAtMs: number;
  paSincePeak: number;
  pitchesSincePeak: number;
  lastEventAtMs: number;
}): number {
  const { market, nowMs, peakAtMs, paSincePeak, pitchesSincePeak, lastEventAtMs } = opts;
  const minutesSincePeak = Math.max(0, (nowMs - peakAtMs) / 60_000);
  const minutesSinceEvent = Math.max(0, (nowMs - lastEventAtMs) / 60_000);

  const timeDecay = Math.pow(0.5, minutesSincePeak / TIME_HALF_LIFE_MIN);

  const usePitchRail = PITCHER_MARKETS.has(market);
  const eventDecay = usePitchRail
    ? Math.pow(0.5, Math.max(0, pitchesSincePeak) / PITCH_HALF_LIFE_PITCHER)
    : Math.pow(0.5, Math.max(0, paSincePeak) / PA_HALF_LIFE_BATTER);

  const staleness = Math.max(0, minutesSinceEvent - STALE_GRACE_MIN);
  const staleDecay = staleness > 0
    ? Math.pow(0.5, staleness / STALE_HALF_LIFE_MIN)
    : 1.0;

  // Worst of the three rails — same conservatism the HR engine uses.
  return Math.min(timeDecay, eventDecay, staleDecay);
}

function key(gameId: string, playerId: string, market: string): string {
  return `${gameId}_${playerId}_${market}`;
}

export function getNonHrSignalState(
  gameId: string,
  playerId: string,
  market: string
): NonHrStateEntry | null {
  return NON_HR_STATES.get(key(gameId, playerId, market)) ?? null;
}

export interface NonHrStateRecomputeResult {
  state: NonHrSignalState;
  changed: boolean;
  prevState: NonHrSignalState | null;
  lastTransitionAt: number;
  peakScore: number;
  decayFactor: number;
}

export function recomputeNonHrSignalState(opts: {
  gameId: string;
  playerId: string;
  playerName?: string;
  market: string;
  signalScore: number;
  paCount?: number;          // priorABResults.length for batter; ignored for pitcher
  pitchCount?: number;       // pitcher's pitchCount; ignored for batter
  gameFinal?: boolean;
  resolvedNow?: boolean;     // true if RESOLVED_NON_HR_MARKETS has stamped this (playFeed crossed line)
}): NonHrStateRecomputeResult {
  const {
    gameId,
    playerId,
    playerName,
    market,
    signalScore,
    paCount = 0,
    pitchCount = 0,
    gameFinal,
    resolvedNow,
  } = opts;
  const k = key(gameId, playerId, market);
  const now = Date.now();
  const prev = NON_HR_STATES.get(k) ?? null;
  const prevState = prev?.currentState ?? null;

  // Terminal CLOSED guard — once CLOSED, never revive. Decay frozen at 0
  // so any consumer reading `decayFactor` sees a fully-decayed signal.
  if (prev?.currentState === "CLOSED") {
    prev.lastScore = signalScore;
    prev.lastUpdateAt = now;
    return {
      state: "CLOSED",
      changed: false,
      prevState: "CLOSED",
      lastTransitionAt: prev.lastTransitionAt,
      peakScore: prev.peakScore,
      decayFactor: 0,
    };
  }
  // Track peak: if score increases, reset peak / peak timestamps / peak counts.
  // The peak resets the decay clock — a fresh surge in score restores
  // freshness, mirroring how HR Radar treats a new contact event.
  const isNewPeak = signalScore > (prev?.peakScore ?? 0);
  const peakScore = isNewPeak ? signalScore : (prev?.peakScore ?? signalScore);
  const peakAtMs = isNewPeak ? now : (prev?.peakAtMs ?? now);
  const peakPaCount = isNewPeak ? paCount : (prev?.peakPaCount ?? paCount);
  const peakPitchCount = isNewPeak ? pitchCount : (prev?.peakPitchCount ?? pitchCount);

  // Track event time: a fresh PA (batter) or pitch (pitcher) bumps lastEventAtMs.
  // Compare against the *previous tick's* observed counts (`lastPaCount` /
  // `lastPitchCount`), NOT against peak counts. Using peak here is wrong:
  // once peak is set, every subsequent tick where the current count exceeds
  // peak would re-stamp `lastEventAtMs = now`, suppressing the staleness
  // rail and the COOLING transition entirely.
  const prevLastPaCount = prev?.lastPaCount ?? paCount;
  const prevLastPitchCount = prev?.lastPitchCount ?? pitchCount;
  const sawNewPa = paCount > prevLastPaCount;
  const sawNewPitch = pitchCount > prevLastPitchCount;
  const lastEventAtMs = (sawNewPa || sawNewPitch) ? now : (prev?.lastEventAtMs ?? now);

  // Compute decay relative to the peak.
  const paSincePeak = Math.max(0, paCount - peakPaCount);
  const pitchesSincePeak = Math.max(0, pitchCount - peakPitchCount);
  const decayFactor = computeNonHrDecayFactor({
    market,
    nowMs: now,
    peakAtMs,
    paSincePeak,
    pitchesSincePeak,
    lastEventAtMs,
  });

  // State derivation. COOLING is reached either by a score drop from peak
  // or by a meaningfully decayed rail (decayFactor < 0.6).
  let nextState: NonHrSignalState;
  if (gameFinal || resolvedNow) {
    nextState = "CLOSED";
  } else if (signalScore >= ACTIVE_THRESHOLD) {
    const droppedFromPeak = signalScore < peakScore - COOLING_DROP;
    const railFaded = decayFactor < 0.6;
    nextState = (droppedFromPeak || railFaded) ? "COOLING" : "ACTIVE";
  } else {
    nextState = "BUILDING";
  }

  const changed = prevState !== nextState;
  const entry: NonHrStateEntry = {
    gameId,
    playerId,
    market,
    currentState: nextState,
    peakScore,
    peakAtMs,
    peakPaCount,
    peakPitchCount,
    lastPaCount: paCount,
    lastPitchCount: pitchCount,
    lastScore: signalScore,
    lastEventAtMs,
    lastTransitionAt: changed ? now : (prev?.lastTransitionAt ?? now),
    lastUpdateAt: now,
  };
  NON_HR_STATES.set(k, entry);

  if (changed) {
    console.log(
      `[NON_HR_STATE] gameId=${gameId} playerId=${playerId}` +
      (playerName ? ` player=${playerName}` : "") +
      ` market=${market} ${prevState ?? "INIT"}->${nextState} ` +
      `score=${signalScore.toFixed(1)} peak=${peakScore.toFixed(1)} decay=${decayFactor.toFixed(2)}`
    );
  }

  return {
    state: nextState,
    changed,
    prevState,
    lastTransitionAt: entry.lastTransitionAt,
    peakScore,
    decayFactor,
  };
}

// Force-CLOSE a single non-HR signal. Called from `maybeMarkNonHrResolved` so
// the state machine and the resolved-set flip in the same tick. Idempotent.
export function closeNonHrSignalOnHit(
  gameId: string,
  playerId: string,
  market: string,
  reason: string
): boolean {
  const k = key(gameId, playerId, market);
  const prev = NON_HR_STATES.get(k);
  if (prev?.currentState === "CLOSED") return false;
  const now = Date.now();
  NON_HR_STATES.set(k, {
    gameId,
    playerId,
    market,
    currentState: "CLOSED",
    peakScore: prev?.peakScore ?? prev?.lastScore ?? 0,
    peakAtMs: prev?.peakAtMs ?? now,
    peakPaCount: prev?.peakPaCount ?? 0,
    peakPitchCount: prev?.peakPitchCount ?? 0,
    lastPaCount: prev?.lastPaCount ?? prev?.peakPaCount ?? 0,
    lastPitchCount: prev?.lastPitchCount ?? prev?.peakPitchCount ?? 0,
    lastScore: prev?.lastScore ?? 0,
    lastEventAtMs: prev?.lastEventAtMs ?? now,
    lastTransitionAt: now,
    lastUpdateAt: now,
  });
  console.log(
    `[NON_HR_STATE_CLOSED] gameId=${gameId} playerId=${playerId} market=${market} ` +
    `prev=${prev?.currentState ?? "INIT"} reason=${reason}`
  );
  return true;
}

// Release all state entries for a game. Called from game-final cleanup.
export function clearNonHrStatesForGame(gameId: string): void {
  for (const k of Array.from(NON_HR_STATES.keys())) {
    if (k.startsWith(`${gameId}_`)) NON_HR_STATES.delete(k);
  }
}
