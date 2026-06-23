// LiveLocks Batch E — HR Radar Intelligence aggregator.
//
// Read-only roll-up of HR Radar stage transitions. Computes:
//   - stage distributions (current snapshot — number of signals per stage)
//   - stage conversion rates (TRACK→BUILD→READY→FIRE→CASHED)
//   - average stage duration
//   - false FIRE rate (FIRE that ended in MISSED)
//   - READY effectiveness (READY that progressed to FIRE)
//   - BUILD maturation rates (BUILD that progressed beyond)
//   - computeCalibrationBuckets: empirical calibration from settled outcome stamps
//
// HARD RULE: no mutation. Reads from analytics ring buffer + bus only.

import { getAnalyticsEvents } from "./analyticsEvent";
import type { HrCalibrationBucket } from "../mlb/hrConversionModel";
import { CALIBRATION_BIN_EDGES } from "../mlb/hrConversionModel";
import { CALLED_HIT_OUTCOME_STATUSES } from "../mlb/hrRadarSection";
// Lane 2 — static import. The previous inline `require(...)` threw
// "require is not defined" under ESM (how the server runs via tsx), so the
// calibration cron silently failed every cycle. Analytics is a top-level
// consumer and hrRadarOutcomeStamp is a leaf (imports only hrRadarSection
// types) — no circular dependency.
import { _getAllHrRadarOutcomeStamps } from "../mlb/hrRadarOutcomeStamp";

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
  // Recall / lead-time (from miss-tracer + called-hit lead events).
  recall: number | null; // calledHits / (calledHits + uncalledHr + lateSignal)
  missBreakdown: Record<string, number>; // counts per derived blockedGate
  missedWithStrongContact: number; // misses where engine had barrel/high-xBA evidence
  leadTimeMs: { p50: number | null; p90: number | null }; // lead before HR on called hits
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
  const missTraces = getAnalyticsEvents({
    sport: "mlb",
    eventType: "hr_radar_miss_trace",
    sinceMs: since,
  });
  const leadEvents = getAnalyticsEvents({
    sport: "mlb",
    eventType: "hr_radar_called_hit_lead",
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

  // ── Recall / lead-time from the miss-tracer + called-hit lead events ──────
  // Miss traces carry a derived `blockedGate` (in `outcome` we stored the
  // grading status; `blockedGate` + `strongContact` are first-class fields).
  const missBreakdown: Record<string, number> = {};
  let uncalledOrLate = 0;
  let missedWithStrongContact = 0;
  for (const m of missTraces) {
    const gate = m.blockedGate ?? "unknown";
    missBreakdown[gate] = (missBreakdown[gate] ?? 0) + 1;
    // `early_hr_no_window` is excluded from recall (no realistic pre-call window),
    // matching the coverage exclusion in storage.ts.
    if (m.outcome !== "early_hr_no_window") uncalledOrLate += 1;
    if (m.strongContact) missedWithStrongContact += 1;
  }
  const calledHits = leadEvents.length;
  const recallDenom = calledHits + uncalledOrLate;
  const recall = recallDenom > 0 ? calledHits / recallDenom : null;

  const leadTimes = leadEvents
    .map((e) => e.leadTimeMs)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  function pct(arr: number[], p: number): number | null {
    if (arr.length === 0) return null;
    const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
    return arr[idx];
  }
  const leadTimeMs = { p50: pct(leadTimes, 50), p90: pct(leadTimes, 90) };

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
    recall,
    missBreakdown,
    missedWithStrongContact,
    leadTimeMs,
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
          `falseFireRate=${snap.falseFireRate ?? "n/a"} ` +
          `recall=${snap.recall ?? "n/a"} ` +
          `missStrongContact=${snap.missedWithStrongContact}`,
      );
      // Precision/recall shadow rollup (Recommendation #4) — keep the bridge-path
      // false-positive picture visible per cycle so a threshold change can be
      // judged against it, not assumed safe.
      try {
        const { computeHrRadarShadowSnapshot } = require("./hrRadarShadowMetrics");
        const sh = computeHrRadarShadowSnapshot({ windowMs: 60 * 60 * 1000 });
        const worstPath = sh.falsePositiveRateByPath[0];
        console.log(
          `[LL_ANALYTICS_HR_RADAR_SHADOW] signals=${sh.totals.signalsObserved} ` +
            `games=${sh.totals.gamesObserved} ` +
            `readyHitRate=${sh.readyHitRate ?? "n/a"} fireHitRate=${sh.fireHitRate ?? "n/a"} ` +
            `fireOutperformsReady=${sh.fireOutperformsReady ?? "n/a"} ` +
            `readyToFire=${sh.readyToFireConversion ?? "n/a"} ` +
            `signalsPerGame=${sh.signalsPerGame ?? "n/a"} hrsPerGame=${sh.hrsCapturedPerGame ?? "n/a"} ` +
            `worstPath=${worstPath ? `${worstPath.path}:${worstPath.falsePositiveRate ?? "n/a"}` : "n/a"}`,
        );
      } catch (e: any) {
        console.warn(`[LL_ANALYTICS_HR_RADAR_SHADOW] snapshot failed err=${e?.message ?? e}`);
      }
    } catch (err: any) {
      console.warn(`[LL_ANALYTICS_HR_RADAR] snapshot failed err=${err?.message ?? err}`);
    }
  }, intervalMs);
  if (typeof _hrRadarTimer.unref === "function") _hrRadarTimer.unref();
}

// Empirical calibration update from settled HR Radar outcome stamps.
// Called by the 30-minute cron in server/index.ts.
// HARD RULE: read-only — calls setEmpiricalCalibrationBuckets externally; does not mutate here.
// Requires n >= 30 settled outcomes per bucket before overriding the static table.
export function computeCalibrationBuckets(): HrCalibrationBucket[] {
  try {
    const stamps = _getAllHrRadarOutcomeStamps();

    // Lane 2.2/2.3 — correct outcome-status classification.
    //   cashed (HR occurred) = the full CALLED_HIT_OUTCOME_STATUSES set
    //     (called_hit + all tiered called_hit_attack/ready/build/watch). The
    //     previous filter dropped called_hit_build / called_hit_watch entirely.
    //   non-HR (no HR while we tracked) = "called_miss". The previous filter
    //     tested "missed"/"expired", which are NOT valid HrRadarOutcomeStatus
    //     values — so the non-HR denominator was always empty and every bin
    //     would have calibrated≈1.0 if it ever crossed the sample floor.
    //   Ambiguous statuses (uncalled_hr / early_hr_insufficient_sample /
    //     late_signal / active / unresolved) are excluded: they lack a clean
    //     predicted-probability → observed-outcome pairing for calibration.
    // Audit fix C4 — `uncalled_hr` is a genuine HR-occurred outcome (a homer we
    // tracked but never formally called). When it carries a predicted
    // probability it is a valid positive for calibration, and excluding it was a
    // major source of the starved denominator that kept empirical buckets from
    // ever qualifying. Count it as cashed.
    // NOTE: `called_near_hr` is a product-level "danger called" win, NOT an
    // actual home run. It must be EXCLUDED from probability calibration —
    // counting near-HRs as HRs would bias the conversion model upward. The
    // product hit-rate (storage.getCanonicalHrRadarOutcomes) still credits it.
    const isCashed = (status: string): boolean =>
      (CALLED_HIT_OUTCOME_STATUSES.has(status as any) && status !== "called_near_hr") ||
      status === "uncalled_hr";
    const settled = stamps.filter(s =>
      s.rawConversionProbability != null &&
      (isCashed(s.outcomeStatus) || s.outcomeStatus === "called_miss"),
    );

    // Lane 2.1 — bins shared 1:1 with CALIBRATION_TABLE via CALIBRATION_BIN_EDGES.
    const BIN_EDGES = CALIBRATION_BIN_EDGES;
    const buckets: HrCalibrationBucket[] = [];

    for (let i = 0; i < BIN_EDGES.length - 1; i++) {
      const min = BIN_EDGES[i];
      const max = BIN_EDGES[i + 1];
      const inBin = settled.filter(s => {
        const p = s.rawConversionProbability!;
        return p >= min && p < max;
      });
      const cashed = inBin.filter(s => isCashed(s.outcomeStatus)).length;
      // Per-bin minimum. Audit fix C4 — the old 30/20 floors were almost never
      // reached (a single process rarely settles 30 graded outcomes per bin in a
      // bin's lifetime before restart), so empirical buckets stayed empty and the
      // static table ruled forever. Lower to 15 (dense low bins) / 12 (sparse
      // high bins, min>=0.20). Laplace smoothing below keeps small-n bins honest.
      const minSamples = min >= 0.20 ? 12 : 15;
      if (inBin.length >= minSamples) {
        // Lane 2.3 — Laplace smoothing: (cashed+1)/(n+2) so a bin that happens
        // to see all-misses (or all-hits) can't snap the calibrated value to a
        // hard 0 (or 1), which would over-correct off a finite sample.
        const calibrated = (cashed + 1) / (inBin.length + 2);
        buckets.push({ min, max, calibrated, samples: inBin.length });
      }
    }

    console.log(`[LL_ANALYTICS_HR_RADAR] calibration update: ${buckets.length} qualifying bins from ${settled.length} settled outcomes`);
    return buckets;
  } catch (err: any) {
    console.warn(`[LL_ANALYTICS_HR_RADAR] computeCalibrationBuckets failed: ${err?.message ?? err}`);
    return [];
  }
}
