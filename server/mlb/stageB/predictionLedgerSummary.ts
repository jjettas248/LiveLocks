// ── MLB Live Edge Stage B — ledger summary (pure, read-only) ─────────────────
// Aggregates captured all-lane predictions into an admin-facing calibration
// snapshot. Pure: no I/O, never mutates its input. Feeds
// GET /api/admin/mlb/stage-b-ledger. This is measurement reporting only — it can
// never influence the engine or any public surface.
//
// Hit rate deliberately excludes push AND void (same convention as the shadow
// store / persisted-play hit rate): a push is a non-decision and a void is
// excluded-through-no-fault. Coverage = fraction of captured rows that have
// reached a terminal state (settled/void/expired).

import {
  MLB_PREDICTION_LANES,
  type MlbLanePrediction,
  type MlbPredictionLane,
} from "@shared/mlbPredictionLedger";

export interface StageBLaneSummary {
  total: number;
  captured: number;   // still pending
  settled: number;    // status === "settled" (cashed|missed|push)
  void: number;
  expired: number;
  cashed: number;
  missed: number;
  push: number;
  // cashed / (cashed + missed) × 100, or null when no decided (non-push) results.
  hitRatePct: number | null;
  // (settled + void + expired) / total × 100 — fraction resolved.
  coveragePct: number;
}

export interface StageBLedgerSummary {
  total: number;
  byLane: Record<MlbPredictionLane, StageBLaneSummary>;
  overall: StageBLaneSummary;
  generatedAtMs: number;
}

function emptyLane(): StageBLaneSummary {
  return {
    total: 0, captured: 0, settled: 0, void: 0, expired: 0,
    cashed: 0, missed: 0, push: 0, hitRatePct: null, coveragePct: 0,
  };
}

function tally(acc: StageBLaneSummary, p: MlbLanePrediction): void {
  acc.total++;
  switch (p.status) {
    case "captured": acc.captured++; break;
    case "settled": acc.settled++; break;
    case "void": acc.void++; break;
    case "expired": acc.expired++; break;
  }
  switch (p.settlementResult) {
    case "cashed": acc.cashed++; break;
    case "missed": acc.missed++; break;
    case "push": acc.push++; break;
    // "void" settlementResult is counted via status === "void" above.
    default: break;
  }
}

function finalize(acc: StageBLaneSummary): void {
  const decided = acc.cashed + acc.missed;
  acc.hitRatePct = decided > 0 ? Math.round((acc.cashed / decided) * 1000) / 10 : null;
  acc.coveragePct = acc.total > 0
    ? Math.round(((acc.settled + acc.void + acc.expired) / acc.total) * 1000) / 10
    : 0;
}

export function summarizeStageBLedger(
  predictions: readonly MlbLanePrediction[],
  generatedAtMs: number,
): StageBLedgerSummary {
  const byLane = {} as Record<MlbPredictionLane, StageBLaneSummary>;
  for (const lane of MLB_PREDICTION_LANES) byLane[lane] = emptyLane();
  const overall = emptyLane();

  for (const p of predictions) {
    const laneAcc = byLane[p.lane as MlbPredictionLane];
    if (laneAcc) tally(laneAcc, p);
    tally(overall, p);
  }

  for (const lane of MLB_PREDICTION_LANES) finalize(byLane[lane]);
  finalize(overall);

  return { total: overall.total, byLane, overall, generatedAtMs };
}
