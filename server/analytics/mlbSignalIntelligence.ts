// LiveLocks Batch E — MLB Signal Intelligence aggregator.
//
// Periodic read-only roll-up of analytics events into a snapshot the
// admin dashboard renders. Does NOT mutate any runtime state. Emits
// [LL_ANALYTICS_AGGREGATE] once per snapshot cycle (default 60s).

import { getAnalyticsEvents, type AnalyticsEvent } from "./analyticsEvent";

const ROI_VIG_PAYOUT = 0.909; // -110 vig payout per cashed unit
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RoiBucket {
  cashed: number;
  missed: number;
  settled: number;
  hitRate: number | null;
  roiUnits: number | null;
  roiPerPick: number | null;
  sampleSizeWarning: string | null;
}

function emptyBucket(): RoiBucket {
  return {
    cashed: 0,
    missed: 0,
    settled: 0,
    hitRate: null,
    roiUnits: null,
    roiPerPick: null,
    sampleSizeWarning: null,
  };
}

function finalizeBucket(b: RoiBucket, sampleFloor: number): RoiBucket {
  b.settled = b.cashed + b.missed;
  if (b.settled > 0) {
    b.hitRate = b.cashed / b.settled;
    b.roiUnits = b.cashed * ROI_VIG_PAYOUT - b.missed;
    b.roiPerPick = b.roiUnits / b.settled;
  }
  if (b.settled < sampleFloor) {
    b.sampleSizeWarning = `Directional only — settled=${b.settled} < ${sampleFloor}`;
  }
  return b;
}

function add(map: Map<string, RoiBucket>, key: string, kind: "cashed" | "missed"): void {
  if (!map.has(key)) map.set(key, emptyBucket());
  const b = map.get(key)!;
  if (kind === "cashed") b.cashed++;
  else b.missed++;
}

export interface MlbIntelligenceSnapshot {
  generatedAt: string;
  windowMs: number;
  sampleSizeFloor: number;
  totals: {
    eventsObserved: number;
    signalCreated: number;
    signalUpgraded: number;
    signalDowngraded: number;
    signalCashed: number;
    signalMissed: number;
    signalExpired: number;
  };
  alerts: {
    queued: number;
    sent: number;
    opened: number;
    clicked: number;
    openRate: number | null;
    clickThroughRate: number | null;
  };
  roi: {
    overall: RoiBucket;
    byTier: Record<string, RoiBucket>;
    byLifecycleState: Record<string, RoiBucket>;
    byMarket: Record<string, RoiBucket>;
    bySide: Record<string, RoiBucket>;
  };
  signalAging: {
    cycles: number;
    avgSignalScore: number | null;
    avgProbability: number | null;
  };
}

export function computeMlbIntelligence(opts?: {
  windowMs?: number;
  sampleFloor?: number;
}): MlbIntelligenceSnapshot {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const sampleFloor = opts?.sampleFloor ?? 50;
  const since = Date.now() - windowMs;

  const evts = getAnalyticsEvents({ sport: "mlb", sinceMs: since });

  const totals = {
    eventsObserved: evts.length,
    signalCreated: 0,
    signalUpgraded: 0,
    signalDowngraded: 0,
    signalCashed: 0,
    signalMissed: 0,
    signalExpired: 0,
  };

  const alerts = { queued: 0, sent: 0, opened: 0, clicked: 0 };

  const overall = emptyBucket();
  const byTier = new Map<string, RoiBucket>();
  const byState = new Map<string, RoiBucket>();
  const byMarket = new Map<string, RoiBucket>();
  const bySide = new Map<string, RoiBucket>();

  let scoreSum = 0;
  let scoreCount = 0;
  let probSum = 0;
  let probCount = 0;

  for (const e of evts) {
    switch (e.eventType) {
      case "signal_created":
        totals.signalCreated++;
        break;
      case "signal_upgraded":
        totals.signalUpgraded++;
        break;
      case "signal_downgraded":
        totals.signalDowngraded++;
        break;
      case "signal_cashed":
        totals.signalCashed++;
        if (e.signalTier) add(byTier, e.signalTier, "cashed");
        if (e.lifecycleState) add(byState, e.lifecycleState, "cashed");
        if (e.market) add(byMarket, e.market, "cashed");
        if (e.side) add(bySide, e.side, "cashed");
        overall.cashed++;
        break;
      case "signal_missed":
        totals.signalMissed++;
        if (e.signalTier) add(byTier, e.signalTier, "missed");
        if (e.lifecycleState) add(byState, e.lifecycleState, "missed");
        if (e.market) add(byMarket, e.market, "missed");
        if (e.side) add(bySide, e.side, "missed");
        overall.missed++;
        break;
      case "signal_expired":
        totals.signalExpired++;
        break;
      case "alert_queued":
        alerts.queued++;
        break;
      case "alert_sent":
        alerts.sent++;
        break;
      case "alert_opened":
        alerts.opened++;
        break;
      case "alert_clicked":
        alerts.clicked++;
        break;
    }

    if (typeof e.signalScore === "number" && e.signalScore > 0) {
      scoreSum += e.signalScore;
      scoreCount++;
    }
    if (typeof e.probability === "number" && e.probability > 0) {
      probSum += e.probability;
      probCount++;
    }
  }

  finalizeBucket(overall, sampleFloor);
  for (const b of Array.from(byTier.values())) finalizeBucket(b, sampleFloor);
  for (const b of Array.from(byState.values())) finalizeBucket(b, sampleFloor);
  for (const b of Array.from(byMarket.values())) finalizeBucket(b, sampleFloor);
  for (const b of Array.from(bySide.values())) finalizeBucket(b, sampleFloor);

  return {
    generatedAt: new Date().toISOString(),
    windowMs,
    sampleSizeFloor: sampleFloor,
    totals,
    alerts: {
      ...alerts,
      openRate: alerts.sent > 0 ? alerts.opened / alerts.sent : null,
      clickThroughRate: alerts.opened > 0 ? alerts.clicked / alerts.opened : null,
    },
    roi: {
      overall,
      byTier: Object.fromEntries(byTier),
      byLifecycleState: Object.fromEntries(byState),
      byMarket: Object.fromEntries(byMarket),
      bySide: Object.fromEntries(bySide),
    },
    signalAging: {
      cycles: evts.length,
      avgSignalScore: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 100) / 100 : null,
      avgProbability: probCount > 0 ? Math.round((probSum / probCount) * 100) / 100 : null,
    },
  };
}

// ── Periodic snapshot logger (one-line aggregate, NOT spammy) ─────────
let _snapshotTimer: ReturnType<typeof setInterval> | null = null;
export function startMlbIntelligenceAggregator(intervalMs: number = 60 * 1000): void {
  if (_snapshotTimer) return;
  _snapshotTimer = setInterval(() => {
    try {
      const snap = computeMlbIntelligence({ windowMs: 30 * 60 * 1000 });
      console.log(
        `[LL_ANALYTICS_AGGREGATE] sport=mlb windowMs=${snap.windowMs} ` +
          `events=${snap.totals.eventsObserved} created=${snap.totals.signalCreated} ` +
          `cashed=${snap.totals.signalCashed} missed=${snap.totals.signalMissed} ` +
          `alerts.queued=${snap.alerts.queued} alerts.sent=${snap.alerts.sent} ` +
          `roi.units=${snap.roi.overall.roiUnits ?? "n/a"}`,
      );
    } catch (err: any) {
      console.warn(`[LL_ANALYTICS_AGGREGATE] snapshot failed err=${err?.message ?? err}`);
    }
  }, intervalMs);
  if (typeof _snapshotTimer.unref === "function") _snapshotTimer.unref();
  console.log(`[LL_ANALYTICS_AGGREGATE] aggregator started intervalMs=${intervalMs}`);
}
