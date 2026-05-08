// LiveLocks Batch E — Driver Intelligence aggregator.
//
// Correlates driver labels (carried on every CanonicalSignal via
// drivers[].label, mirrored into AnalyticsEvent.drivers[]) against
// settled outcomes (signal_cashed / signal_missed) to identify which
// drivers correlate to winners.
//
// HARD RULE: read-only. No mutation of drivers, no fabrication.

import { getAnalyticsEvents, type AnalyticsEvent } from "./analyticsEvent";

const ROI_VIG_PAYOUT = 0.909;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SAMPLE_FLOOR = 20;

export interface DriverPerformance {
  driver: string;
  appearances: number; // appears on a settled signal
  cashed: number;
  missed: number;
  hitRate: number | null;
  roiUnits: number | null;
  roiPerPick: number | null;
  avgProbability: number | null;
  avgSignalScore: number | null;
  sampleSizeWarning: string | null;
}

export interface DriverComboPerformance {
  combo: string; // sorted "A + B" pair
  appearances: number;
  cashed: number;
  missed: number;
  hitRate: number | null;
  roiUnits: number | null;
}

export interface DriverIntelligenceSnapshot {
  generatedAt: string;
  windowMs: number;
  sampleSizeFloor: number;
  observedDrivers: number;
  topDrivers: DriverPerformance[]; // top by hit rate (min appearances)
  bottomDrivers: DriverPerformance[]; // worst by hit rate (min appearances)
  topCombos: DriverComboPerformance[]; // top driver pairs by hit rate
}

interface DriverAccumulator {
  appearances: number;
  cashed: number;
  missed: number;
  probSum: number;
  probCount: number;
  scoreSum: number;
  scoreCount: number;
}

function newAcc(): DriverAccumulator {
  return {
    appearances: 0,
    cashed: 0,
    missed: 0,
    probSum: 0,
    probCount: 0,
    scoreSum: 0,
    scoreCount: 0,
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} + ${b}` : `${b} + ${a}`;
}

export function computeDriverIntelligence(opts?: {
  windowMs?: number;
  sampleFloor?: number;
  topN?: number;
}): DriverIntelligenceSnapshot {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const sampleFloor = opts?.sampleFloor ?? DEFAULT_SAMPLE_FLOOR;
  const topN = opts?.topN ?? 10;
  const since = Date.now() - windowMs;

  const settled = getAnalyticsEvents({
    sport: "mlb",
    eventType: ["signal_cashed", "signal_missed"],
    sinceMs: since,
  });

  const single = new Map<string, DriverAccumulator>();
  const combo = new Map<string, DriverAccumulator>();

  for (const e of settled) {
    const labels = (e.drivers ?? []).filter((s) => typeof s === "string" && s.length > 0);
    if (labels.length === 0) continue;
    const cashed = e.eventType === "signal_cashed";

    const seen = new Set<string>();
    for (const l of labels) {
      if (seen.has(l)) continue;
      seen.add(l);
      let acc = single.get(l);
      if (!acc) {
        acc = newAcc();
        single.set(l, acc);
      }
      acc.appearances++;
      if (cashed) acc.cashed++;
      else acc.missed++;
      if (typeof e.probability === "number") {
        acc.probSum += e.probability;
        acc.probCount++;
      }
      if (typeof e.signalScore === "number") {
        acc.scoreSum += e.signalScore;
        acc.scoreCount++;
      }
    }

    // Pairs (combinations of two distinct drivers).
    const arr = Array.from(seen);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const k = pairKey(arr[i], arr[j]);
        let acc = combo.get(k);
        if (!acc) {
          acc = newAcc();
          combo.set(k, acc);
        }
        acc.appearances++;
        if (cashed) acc.cashed++;
        else acc.missed++;
      }
    }
  }

  function finalize(label: string, a: DriverAccumulator): DriverPerformance {
    const settledN = a.cashed + a.missed;
    const hitRate = settledN > 0 ? a.cashed / settledN : null;
    const roiUnits = settledN > 0 ? a.cashed * ROI_VIG_PAYOUT - a.missed : null;
    return {
      driver: label,
      appearances: a.appearances,
      cashed: a.cashed,
      missed: a.missed,
      hitRate,
      roiUnits,
      roiPerPick: roiUnits != null && settledN > 0 ? roiUnits / settledN : null,
      avgProbability:
        a.probCount > 0 ? Math.round((a.probSum / a.probCount) * 100) / 100 : null,
      avgSignalScore:
        a.scoreCount > 0 ? Math.round((a.scoreSum / a.scoreCount) * 100) / 100 : null,
      sampleSizeWarning:
        settledN < sampleFloor ? `Directional only — settled=${settledN} < ${sampleFloor}` : null,
    };
  }

  const allDrivers = Array.from(single.entries()).map(([k, v]) => finalize(k, v));
  const eligible = allDrivers.filter((d) => d.appearances >= Math.max(3, sampleFloor / 4));

  const top = [...eligible]
    .filter((d) => d.hitRate != null)
    .sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0))
    .slice(0, topN);
  const bottom = [...eligible]
    .filter((d) => d.hitRate != null)
    .sort((a, b) => (a.hitRate ?? 0) - (b.hitRate ?? 0))
    .slice(0, topN);

  const combos: DriverComboPerformance[] = Array.from(combo.entries())
    .filter(([, a]) => a.appearances >= Math.max(3, sampleFloor / 4))
    .map(([k, a]) => {
      const settledN = a.cashed + a.missed;
      return {
        combo: k,
        appearances: a.appearances,
        cashed: a.cashed,
        missed: a.missed,
        hitRate: settledN > 0 ? a.cashed / settledN : null,
        roiUnits: settledN > 0 ? a.cashed * ROI_VIG_PAYOUT - a.missed : null,
      };
    })
    .filter((c) => c.hitRate != null)
    .sort((a, b) => (b.hitRate ?? 0) - (a.hitRate ?? 0))
    .slice(0, topN);

  return {
    generatedAt: new Date().toISOString(),
    windowMs,
    sampleSizeFloor: sampleFloor,
    observedDrivers: allDrivers.length,
    topDrivers: top,
    bottomDrivers: bottom,
    topCombos: combos,
  };
}

let _driverTimer: ReturnType<typeof setInterval> | null = null;
export function startDriverIntelligenceAggregator(intervalMs: number = 10 * 60 * 1000): void {
  if (_driverTimer) return;
  _driverTimer = setInterval(() => {
    try {
      const snap = computeDriverIntelligence();
      console.log(
        `[LL_ANALYTICS_DRIVER] observed=${snap.observedDrivers} ` +
          `top=${snap.topDrivers[0]?.driver ?? "n/a"}@${snap.topDrivers[0]?.hitRate ?? "n/a"} ` +
          `topCombo=${snap.topCombos[0]?.combo ?? "n/a"}@${snap.topCombos[0]?.hitRate ?? "n/a"}`,
      );
    } catch (err: any) {
      console.warn(`[LL_ANALYTICS_DRIVER] snapshot failed err=${err?.message ?? err}`);
    }
  }, intervalMs);
  if (typeof _driverTimer.unref === "function") _driverTimer.unref();
}
