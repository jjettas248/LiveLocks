// LiveLocks — HR Radar shadow precision/recall instrumentation.
//
// Read-only rollup that answers the questions a threshold/bridge-path change
// must be measured against BEFORE accepting more sensitivity (Recommendation
// #4): "did recall improve, or did we just manufacture false positives?"
//
// It reconstructs a per-signal HrRadarShadowMetrics record from the analytics
// ring buffer and rolls up:
//   - Ready hit rate / Fire hit rate (and whether Fire actually outperforms Ready)
//   - Ready → Fire conversion rate
//   - False-positive rate sliced by bridge/signal path
//   - Missed HRs that DID have a Track/Build/Ready stage before the HR
//   - Signals per game / HRs captured per game
//
// HARD RULE (CLAUDE.md §3.6): no mutation. Reads from the analytics ring
// buffer only; every consumer is wrapped so analytics can never break runtime.
//
// Data dependencies (all already emitted from read-only taps):
//   - hr_radar_transition       (carries signalPath + score10 — additive fields)
//   - hr_radar_cashed           (called_hit terminal outcome)
//   - hr_radar_missed           (called_miss terminal outcome — precision denominator)
//   - hr_radar_called_hit_lead  (the tracked player hit a HR)
//   - hr_radar_miss_trace       (an HR we failed to call / called late — recall)

import { getAnalyticsEvents } from "./analyticsEvent";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type HrRadarShadowStage = "track" | "build" | "ready" | "fire";

const STAGE_RANK: Record<HrRadarShadowStage, number> = {
  track: 0,
  build: 1,
  ready: 2,
  fire: 3,
};

/** Per-signal precision/recall record (user-specified contract). */
export interface HrRadarShadowMetrics {
  stage: HrRadarShadowStage;     // highest user stage reached
  signalPath: string;            // engine alertPath (bridge path), or "unknown"
  score10: number;               // peak conviction score (0–10) observed
  becameReady: boolean;
  becameFire: boolean;
  hitHr: boolean;                // tracked player homered (cashed / called-hit)
  falsePositive: boolean;        // reached an actionable stage but no HR
  gameId: string;
  playerId: string;
  market: "home_runs";
  generatedAt: string;
}

export interface PathPrecision {
  path: string;
  actionableResolved: number;    // reached ready/fire AND has a terminal outcome
  falsePositives: number;        // of those, ended without a HR
  falsePositiveRate: number | null;
  hits: number;                  // of those, ended in a HR
  hitRate: number | null;
}

export interface HrRadarShadowSnapshot {
  generatedAt: string;
  windowMs: number;
  totals: {
    signalsObserved: number;
    gamesObserved: number;
    terminalOutcomes: number;
    cashed: number;
    missed: number;
  };
  // Precision — does each actionable stage actually produce HRs?
  readyHitRate: number | null;   // reached ready+ & resolved → fraction that hit
  fireHitRate: number | null;    // reached fire & resolved → fraction that hit
  fireOutperformsReady: boolean | null;
  fireMinusReadyHitRate: number | null;
  readyToFireConversion: number | null;
  // Per bridge/signal path false-positive breakdown (sorted worst-first).
  falsePositiveRateByPath: PathPrecision[];
  // Recall — HRs we failed to call cleanly that nonetheless had a prior stage.
  missedHrWithPriorStage: number;
  missedHrTotal: number;
  // Volume — the "more signals" side of the tradeoff.
  signalsPerGame: number | null;
  hrsCapturedPerGame: number | null;
  sampleSizeWarning: string | null;
}

interface ShadowTrace {
  signalId: string;
  gameId: string;
  playerId: string;
  topStage: HrRadarShadowStage | null;
  signalPath: string | null;
  score10: number;
  reachedReady: boolean;
  reachedFire: boolean;
  cashed: boolean;          // hr_radar_cashed
  missed: boolean;          // hr_radar_missed
  calledHitLead: boolean;   // hr_radar_called_hit_lead
}

/**
 * Build per-signal shadow records for the window. Pure read; safe on empty data.
 */
export function computeHrRadarShadowRecords(opts?: { windowMs?: number }): HrRadarShadowMetrics[] {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const since = Date.now() - windowMs;
  const generatedAt = new Date().toISOString();

  const traces = buildTraces(since);
  const out: HrRadarShadowMetrics[] = [];
  for (const t of Array.from(traces.values())) {
    // Only emit a record for signals that actually formed a stage.
    if (t.topStage == null) continue;
    const hitHr = t.cashed || t.calledHitLead;
    const actionable = t.reachedReady || t.reachedFire;
    out.push({
      stage: t.topStage,
      signalPath: t.signalPath ?? "unknown",
      score10: t.score10,
      becameReady: t.reachedReady,
      becameFire: t.reachedFire,
      hitHr,
      // A false positive is an actionable signal that terminally resolved
      // without a HR. Un-resolved (still live / no terminal event) signals are
      // not counted either way.
      falsePositive: actionable && t.missed && !hitHr,
      gameId: t.gameId,
      playerId: t.playerId,
      market: "home_runs",
      generatedAt,
    });
  }
  return out;
}

/**
 * Roll the per-signal records up into precision/recall aggregates.
 */
export function computeHrRadarShadowSnapshot(opts?: { windowMs?: number }): HrRadarShadowSnapshot {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const since = Date.now() - windowMs;
  const generatedAt = new Date().toISOString();

  const traces = buildTraces(since);
  const all = Array.from(traces.values());

  const games = new Set<string>();
  let cashed = 0;
  let missed = 0;

  // Precision counters per actionable stage (signals with a terminal outcome).
  let readyResolved = 0, readyHits = 0;
  let fireResolved = 0, fireHits = 0;
  // Conversion: of signals that reached ready, how many reached fire.
  let reachedReady = 0, reachedFire = 0;
  // Per-path precision.
  const pathAgg = new Map<string, { actionableResolved: number; falsePositives: number; hits: number }>();

  for (const t of all) {
    games.add(t.gameId);
    if (t.cashed) cashed++;
    if (t.missed) missed++;

    const hitHr = t.cashed || t.calledHitLead;
    const resolved = t.cashed || t.missed;

    if (t.reachedReady) {
      reachedReady++;
      if (resolved) { readyResolved++; if (hitHr) readyHits++; }
    }
    if (t.reachedFire) {
      reachedFire++;
      if (resolved) { fireResolved++; if (hitHr) fireHits++; }
    }

    // Per-path: only actionable + resolved signals contribute to precision.
    if ((t.reachedReady || t.reachedFire) && resolved) {
      const key = t.signalPath ?? "unknown";
      const a = pathAgg.get(key) ?? { actionableResolved: 0, falsePositives: 0, hits: 0 };
      a.actionableResolved++;
      if (hitHr) a.hits++;
      else a.falsePositives++;
      pathAgg.set(key, a);
    }
  }

  // Recall: HRs we failed to call cleanly (miss-traces). Cross-reference each
  // miss-trace signal against the transition traces — a missed HR "with prior
  // stage" is one we were already tracking at some stage before the HR landed.
  const missTraces = getAnalyticsEvents({ sport: "mlb", eventType: "hr_radar_miss_trace", sinceMs: since });
  let missedHrWithPriorStage = 0;
  for (const m of missTraces) {
    const t = traces.get(m.signalId);
    if (t && t.topStage != null) missedHrWithPriorStage++;
  }

  const readyHitRate = readyResolved > 0 ? readyHits / readyResolved : null;
  const fireHitRate = fireResolved > 0 ? fireHits / fireResolved : null;
  const fireOutperformsReady =
    readyHitRate != null && fireHitRate != null ? fireHitRate > readyHitRate : null;
  const fireMinusReadyHitRate =
    readyHitRate != null && fireHitRate != null
      ? Math.round((fireHitRate - readyHitRate) * 1000) / 1000
      : null;
  const readyToFireConversion = reachedReady > 0 ? reachedFire / reachedReady : null;

  const falsePositiveRateByPath: PathPrecision[] = Array.from(pathAgg.entries())
    .map(([path, a]) => ({
      path,
      actionableResolved: a.actionableResolved,
      falsePositives: a.falsePositives,
      falsePositiveRate: a.actionableResolved > 0 ? a.falsePositives / a.actionableResolved : null,
      hits: a.hits,
      hitRate: a.actionableResolved > 0 ? a.hits / a.actionableResolved : null,
    }))
    .sort((x, y) => (y.falsePositiveRate ?? -1) - (x.falsePositiveRate ?? -1));

  const signalsObserved = all.filter(t => t.topStage != null).length;
  const gamesObserved = games.size;
  const signalsPerGame = gamesObserved > 0 ? Math.round((signalsObserved / gamesObserved) * 100) / 100 : null;
  const hrsCapturedPerGame = gamesObserved > 0 ? Math.round((cashed / gamesObserved) * 100) / 100 : null;

  const sampleSizeWarning =
    signalsObserved < 25 ? `Directional only — observed signals=${signalsObserved} < 25` : null;

  return {
    generatedAt,
    windowMs,
    totals: {
      signalsObserved,
      gamesObserved,
      terminalOutcomes: cashed + missed,
      cashed,
      missed,
    },
    readyHitRate,
    fireHitRate,
    fireOutperformsReady,
    fireMinusReadyHitRate,
    readyToFireConversion,
    falsePositiveRateByPath,
    missedHrWithPriorStage,
    missedHrTotal: missTraces.length,
    signalsPerGame,
    hrsCapturedPerGame,
    sampleSizeWarning,
  };
}

function buildTraces(since: number): Map<string, ShadowTrace> {
  const transitions = getAnalyticsEvents({ sport: "mlb", eventType: "hr_radar_transition", sinceMs: since });
  const cashes = getAnalyticsEvents({ sport: "mlb", eventType: "hr_radar_cashed", sinceMs: since });
  const misses = getAnalyticsEvents({ sport: "mlb", eventType: "hr_radar_missed", sinceMs: since });
  const leads = getAnalyticsEvents({ sport: "mlb", eventType: "hr_radar_called_hit_lead", sinceMs: since });

  const traces = new Map<string, ShadowTrace>();
  function trace(e: { signalId: string; gameId: string; playerId: string }): ShadowTrace {
    let t = traces.get(e.signalId);
    if (!t) {
      t = {
        signalId: e.signalId,
        gameId: e.gameId,
        playerId: e.playerId,
        topStage: null,
        signalPath: null,
        score10: 0,
        reachedReady: false,
        reachedFire: false,
        cashed: false,
        missed: false,
        calledHitLead: false,
      };
      traces.set(e.signalId, t);
    }
    return t;
  }

  for (const e of transitions) {
    const t = trace(e);
    const to = e.toStage as HrRadarShadowStage | undefined;
    if (to && to in STAGE_RANK) {
      if (t.topStage == null || STAGE_RANK[to] > STAGE_RANK[t.topStage]) t.topStage = to;
      if (to === "ready" || to === "fire") t.reachedReady = true;
      if (to === "fire") t.reachedFire = true;
    }
    // signalPath is stable per signal; first non-empty wins, later non-empty
    // overrides null only.
    if (e.signalPath && !t.signalPath) t.signalPath = e.signalPath;
    if (typeof e.score10 === "number" && e.score10 > t.score10) t.score10 = e.score10;
  }
  for (const e of cashes) {
    const t = trace(e);
    t.cashed = true;
    if (e.signalPath && !t.signalPath) t.signalPath = e.signalPath;
    if (typeof e.score10 === "number" && e.score10 > t.score10) t.score10 = e.score10;
  }
  for (const e of misses) {
    const t = trace(e);
    t.missed = true;
    if (e.signalPath && !t.signalPath) t.signalPath = e.signalPath;
    if (typeof e.score10 === "number" && e.score10 > t.score10) t.score10 = e.score10;
  }
  for (const e of leads) {
    const t = trace(e);
    t.calledHitLead = true;
  }

  return traces;
}
