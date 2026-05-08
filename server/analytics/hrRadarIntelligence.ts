// LiveLocks Batch E — HR Radar Intelligence aggregator.
//
// Read-only roll-up of HR Radar stage transitions. Computes:
//   - stage distributions (current snapshot — number of signals per stage)
//   - stage conversion rates (TRACK→BUILD→READY→FIRE→CASHED)
//   - average stage duration
//   - false FIRE rate (FIRE that ended in MISSED)
//   - READY effectiveness (READY that progressed to FIRE)
//   - BUILD maturation rates (BUILD that progressed beyond)
//
// HARD RULE: no mutation. Reads from analytics ring buffer + bus only.

import { getAnalyticsEvents } from "./analyticsEvent";

const STAGES = ["track", "build", "ready", "fire", "cashed", "missed", "dead"] as const;
type HrStage = (typeof STAGES)[number];

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface HrRadarIntelligenceSnapshot {
  generatedAt: string;
  windowMs: number;
  totals: {
    transitionsObserved: number;
    cashedObserved: number;
    missedObserved: number;
  };
  stageDistribution: Record<HrStage, number>;
  conversion: {
    trackToBuild: number | null;
    buildToReady: number | null;
    readyToFire: number | null;
    fireToCashed: number | null;
  };
  averageDurationMs: {
    track: number | null;
    build: number | null;
    ready: number | null;
    fire: number | null;
  };
  falseFireRate: number | null; // FIRE → MISSED / total FIRE outcomes
  readyEffectiveness: number | null; // READY → FIRE / total READY outcomes
  buildMaturation: number | null; // BUILD → READY+ / total BUILD outcomes
  sampleSizeWarning: string | null;
}

interface SignalTrace {
  signalId: string;
  reachedTrack?: number;
  reachedBuild?: number;
  reachedReady?: number;
  reachedFire?: number;
  cashedAt?: number;
  missedAt?: number;
  finalStage?: HrStage;
}

function isHrStage(s: string | undefined): s is HrStage {
  return !!s && (STAGES as readonly string[]).includes(s);
}

export function computeHrRadarIntelligence(opts?: {
  windowMs?: number;
}): HrRadarIntelligenceSnapshot {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const since = Date.now() - windowMs;

  const transitions = getAnalyticsEvents({
    sport: "mlb",
    eventType: "hr_radar_transition",
    sinceMs: since,
  });
  const cashes = getAnalyticsEvents({
    sport: "mlb",
    eventType: "hr_radar_cashed",
    sinceMs: since,
  });
  const misses = getAnalyticsEvents({
    sport: "mlb",
    eventType: "hr_radar_missed",
    sinceMs: since,
  });

  // Group all events per signalId so we can reconstruct trajectories.
  const traces = new Map<string, SignalTrace>();
  function trace(id: string): SignalTrace {
    let t = traces.get(id);
    if (!t) {
      t = { signalId: id };
      traces.set(id, t);
    }
    return t;
  }

  const stageDistribution: Record<HrStage, number> = {
    track: 0,
    build: 0,
    ready: 0,
    fire: 0,
    cashed: 0,
    missed: 0,
    dead: 0,
  };

  for (const e of transitions) {
    const to = e.toStage as HrStage | undefined;
    if (!isHrStage(to)) continue;
    const t = trace(e.signalId);
    switch (to) {
      case "track":
        if (t.reachedTrack == null) t.reachedTrack = e.timestamp;
        break;
      case "build":
        if (t.reachedBuild == null) t.reachedBuild = e.timestamp;
        break;
      case "ready":
        if (t.reachedReady == null) t.reachedReady = e.timestamp;
        break;
      case "fire":
        if (t.reachedFire == null) t.reachedFire = e.timestamp;
        break;
    }
    t.finalStage = to;
  }

  for (const e of cashes) {
    const t = trace(e.signalId);
    t.cashedAt = e.timestamp;
    t.finalStage = "cashed";
  }
  for (const e of misses) {
    const t = trace(e.signalId);
    t.missedAt = e.timestamp;
    t.finalStage = "missed";
  }

  for (const t of Array.from(traces.values())) {
    if (t.finalStage) stageDistribution[t.finalStage as HrStage]++;
  }

  // Conversion rates from observed trajectories.
  let nTrack = 0,
    nTrackToBuild = 0;
  let nBuild = 0,
    nBuildToReady = 0;
  let nReady = 0,
    nReadyToFire = 0;
  let nFire = 0,
    nFireToCashed = 0;

  // Stage duration sums.
  let dTrackSum = 0,
    dTrackCount = 0;
  let dBuildSum = 0,
    dBuildCount = 0;
  let dReadySum = 0,
    dReadyCount = 0;
  let dFireSum = 0,
    dFireCount = 0;

  let falseFire = 0,
    fireOutcomes = 0;
  let readyAdvanced = 0,
    readyOutcomes = 0;
  let buildAdvanced = 0,
    buildOutcomes = 0;

  for (const t of Array.from(traces.values())) {
    if (t.reachedTrack != null) {
      nTrack++;
      if (t.reachedBuild != null) {
        nTrackToBuild++;
        dTrackSum += t.reachedBuild - t.reachedTrack;
        dTrackCount++;
      }
    }
    if (t.reachedBuild != null) {
      nBuild++;
      buildOutcomes++;
      if (t.reachedReady != null) {
        nBuildToReady++;
        buildAdvanced++;
        dBuildSum += t.reachedReady - t.reachedBuild;
        dBuildCount++;
      }
    }
    if (t.reachedReady != null) {
      nReady++;
      readyOutcomes++;
      if (t.reachedFire != null) {
        nReadyToFire++;
        readyAdvanced++;
        dReadySum += t.reachedFire - t.reachedReady;
        dReadyCount++;
      }
    }
    if (t.reachedFire != null) {
      nFire++;
      const closedAt = t.cashedAt ?? t.missedAt;
      if (closedAt != null) {
        fireOutcomes++;
        dFireSum += closedAt - t.reachedFire;
        dFireCount++;
        if (t.cashedAt != null) nFireToCashed++;
        if (t.missedAt != null) falseFire++;
      }
    }
  }

  const sampleSize = traces.size;
  const sampleSizeWarning =
    sampleSize < 25
      ? `Directional only — observed signals=${sampleSize} < 25`
      : null;

  return {
    generatedAt: new Date().toISOString(),
    windowMs,
    totals: {
      transitionsObserved: transitions.length,
      cashedObserved: cashes.length,
      missedObserved: misses.length,
    },
    stageDistribution,
    conversion: {
      trackToBuild: nTrack > 0 ? nTrackToBuild / nTrack : null,
      buildToReady: nBuild > 0 ? nBuildToReady / nBuild : null,
      readyToFire: nReady > 0 ? nReadyToFire / nReady : null,
      fireToCashed: nFire > 0 ? nFireToCashed / nFire : null,
    },
    averageDurationMs: {
      track: dTrackCount > 0 ? Math.round(dTrackSum / dTrackCount) : null,
      build: dBuildCount > 0 ? Math.round(dBuildSum / dBuildCount) : null,
      ready: dReadyCount > 0 ? Math.round(dReadySum / dReadyCount) : null,
      fire: dFireCount > 0 ? Math.round(dFireSum / dFireCount) : null,
    },
    falseFireRate: fireOutcomes > 0 ? falseFire / fireOutcomes : null,
    readyEffectiveness: readyOutcomes > 0 ? readyAdvanced / readyOutcomes : null,
    buildMaturation: buildOutcomes > 0 ? buildAdvanced / buildOutcomes : null,
    sampleSizeWarning,
  };
}

let _hrRadarTimer: ReturnType<typeof setInterval> | null = null;
export function startHrRadarIntelligenceAggregator(intervalMs: number = 5 * 60 * 1000): void {
  if (_hrRadarTimer) return;
  _hrRadarTimer = setInterval(() => {
    try {
      const snap = computeHrRadarIntelligence({ windowMs: 60 * 60 * 1000 });
      console.log(
        `[LL_ANALYTICS_HR_RADAR] transitions=${snap.totals.transitionsObserved} ` +
          `cashed=${snap.totals.cashedObserved} missed=${snap.totals.missedObserved} ` +
          `fireToCashed=${snap.conversion.fireToCashed ?? "n/a"} ` +
          `falseFireRate=${snap.falseFireRate ?? "n/a"}`,
      );
    } catch (err: any) {
      console.warn(`[LL_ANALYTICS_HR_RADAR] snapshot failed err=${err?.message ?? err}`);
    }
  }, intervalMs);
  if (typeof _hrRadarTimer.unref === "function") _hrRadarTimer.unref();
}
