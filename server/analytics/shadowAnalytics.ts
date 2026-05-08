// LiveLocks Batch E — Shadow Qualification Analytics.
//
// Wraps the existing shadow-qualification store and compares it against
// live-qualified signal performance (drawn from the analytics ring
// buffer). Surfaces a delta between the two paths so the team can see
// whether the shadow floor would have outperformed the live floor.
//
// HARD RULE: read-only. Does NOT mutate shadow records. Does NOT
// affect production surfacing, alerts, or ROI.

import { getShadowSummary } from "../mlb/shadowQualification";
import { getAnalyticsEvents } from "./analyticsEvent";

const ROI_VIG_PAYOUT = 0.909;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SAMPLE_SIZE_FLOOR = 50;

export interface ShadowAnalyticsSnapshot {
  generatedAt: string;
  windowMs: number;
  sampleSizeFloor: number;
  shadow: {
    settled: number;
    cashed: number;
    missed: number;
    push: number;
    expired: number;
    pending: number;
    hitRate: number | null;
    roiUnits: number | null;
    roiPerPick: number | null;
    sampleSizeWarning: string | null;
  };
  live: {
    settled: number;
    cashed: number;
    missed: number;
    hitRate: number | null;
    roiUnits: number | null;
    roiPerPick: number | null;
    sampleSizeWarning: string | null;
  };
  delta: {
    hitRateDelta: number | null; // shadow - live, fraction (e.g. +0.03 = +3pp)
    roiPerPickDelta: number | null;
  };
  byMarket: Record<
    string,
    {
      shadow: { settled: number; cashed: number; hitRate: number | null };
    }
  >;
  bySide: Record<
    string,
    {
      shadow: { settled: number; cashed: number; hitRate: number | null };
    }
  >;
  thresholds: { liveFloor: number; shadowFloor: number };
}

export function computeShadowAnalytics(opts?: {
  windowMs?: number;
  sampleFloor?: number;
}): ShadowAnalyticsSnapshot {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const sampleFloor = opts?.sampleFloor ?? SAMPLE_SIZE_FLOOR;
  const since = Date.now() - windowMs;

  const shadowSum = getShadowSummary();

  // Live performance is computed from the analytics ring buffer —
  // settled live-qualified signals (signal_cashed / signal_missed).
  const liveCashed = getAnalyticsEvents({
    sport: "mlb",
    eventType: "signal_cashed",
    sinceMs: since,
  }).length;
  const liveMissed = getAnalyticsEvents({
    sport: "mlb",
    eventType: "signal_missed",
    sinceMs: since,
  }).length;
  const liveSettled = liveCashed + liveMissed;
  const liveHitRate = liveSettled > 0 ? liveCashed / liveSettled : null;
  const liveRoi = liveSettled > 0 ? liveCashed * ROI_VIG_PAYOUT - liveMissed : null;
  const liveRoiPerPick = liveRoi != null && liveSettled > 0 ? liveRoi / liveSettled : null;

  const shadowSettled = shadowSum.totals.settled;
  const shadowHitRate = shadowSum.hitRate;
  const shadowRoiPerPick = shadowSum.roiPerPick;

  const byMarket: ShadowAnalyticsSnapshot["byMarket"] = {};
  for (const [m, ms] of Object.entries(shadowSum.byMarket)) {
    byMarket[m] = {
      shadow: {
        settled: ms.cashed + ms.missed,
        cashed: ms.cashed,
        hitRate: ms.hitRate,
      },
    };
  }
  const bySide: ShadowAnalyticsSnapshot["bySide"] = {};
  for (const [s, ss] of Object.entries(shadowSum.bySide)) {
    bySide[s] = {
      shadow: {
        settled: ss.cashed + ss.missed,
        cashed: ss.cashed,
        hitRate: ss.hitRate,
      },
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    windowMs,
    sampleSizeFloor: sampleFloor,
    shadow: {
      settled: shadowSettled,
      cashed: shadowSum.totals.cashed,
      missed: shadowSum.totals.missed,
      push: shadowSum.totals.push,
      expired: shadowSum.totals.expired,
      pending: shadowSum.totals.pending,
      hitRate: shadowHitRate,
      roiUnits: shadowSum.roiUnits,
      roiPerPick: shadowRoiPerPick,
      sampleSizeWarning: shadowSum.sampleSizeWarning,
    },
    live: {
      settled: liveSettled,
      cashed: liveCashed,
      missed: liveMissed,
      hitRate: liveHitRate,
      roiUnits: liveRoi,
      roiPerPick: liveRoiPerPick,
      sampleSizeWarning:
        liveSettled < sampleFloor
          ? `Directional only — live settled=${liveSettled} < ${sampleFloor}`
          : null,
    },
    delta: {
      hitRateDelta:
        shadowHitRate != null && liveHitRate != null ? shadowHitRate - liveHitRate : null,
      roiPerPickDelta:
        shadowRoiPerPick != null && liveRoiPerPick != null
          ? shadowRoiPerPick - liveRoiPerPick
          : null,
    },
    byMarket,
    bySide,
    thresholds: {
      liveFloor: shadowSum.thresholds.LIVE_BATTER_OVER_FLOOR,
      shadowFloor: shadowSum.thresholds.SHADOW_BATTER_OVER_FLOOR,
    },
  };
}

let _shadowTimer: ReturnType<typeof setInterval> | null = null;
export function startShadowAnalyticsAggregator(intervalMs: number = 5 * 60 * 1000): void {
  if (_shadowTimer) return;
  _shadowTimer = setInterval(() => {
    try {
      const snap = computeShadowAnalytics();
      console.log(
        `[LL_ANALYTICS_SHADOW] shadowSettled=${snap.shadow.settled} ` +
          `liveSettled=${snap.live.settled} ` +
          `hitRateDelta=${snap.delta.hitRateDelta ?? "n/a"} ` +
          `roiDelta=${snap.delta.roiPerPickDelta ?? "n/a"}`,
      );
    } catch (err: any) {
      console.warn(`[LL_ANALYTICS_SHADOW] snapshot failed err=${err?.message ?? err}`);
    }
  }, intervalMs);
  if (typeof _shadowTimer.unref === "function") _shadowTimer.unref();
}
