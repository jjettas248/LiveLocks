// MLB Runtime Qualification Audit
//
// Passive instrumentation: records every reason an MLB market was REJECTED,
// SUPPRESSED, DOWNGRADED, or QUALIFIED across the engine's per-cycle
// pipeline. NEVER influences engine math, qualification thresholds, or
// surfacing — write-only diagnostic surface for /api/admin/mlb-qualification.
//
// Categories (10) are stable taxonomy used by the admin UI:
//   1. probability        — engine probability fails an absolute / market floor or is invalid
//   2. signalScore        — composed signalScore is below the family minScore gate
//   3. qualification      — generic qualifier failed (catch-all for sites not falling in the others)
//   4. staleOdds          — no book line / no real odds / hydration gate failed (stale or missing odds)
//   5. lifecycle          — family suppression demoted to watch / lifecycle terminal
//   6. marketValidation   — invalid side / bookLine / firewall hard-reject / guard error / engine error
//   7. suppression        — engine output.suppressed / HR UNDER unplayable / HR Watch suppression reasons
//   8. tier               — qualifier returned a watch-tier signal (downgraded out of the actionable tier)
//   9. missingContext     — required input missing (playerId, slot, gameId, inning)
//  10. cooldown           — orchestrator dedup window suppressed the whole cycle

import { boundedPush } from "../utils/ringBuffer";

export type RejectionCategory =
  | "probability"
  | "signalScore"
  | "qualification"
  | "staleOdds"
  | "lifecycle"
  | "marketValidation"
  | "suppression"
  | "tier"
  | "missingContext"
  | "cooldown";

const ALL_CATEGORIES: RejectionCategory[] = [
  "probability", "signalScore", "qualification", "staleOdds", "lifecycle",
  "marketValidation", "suppression", "tier", "missingContext", "cooldown",
];

interface CycleCounters {
  gameId: string;
  startedAt: number;
  endedAt: number | null;
  // Candidate pipeline counts
  rawCandidates: number;       // batters considered + pitcher considered
  normalizedCandidates: number; // markets that survived input gates and reached the engine call
  qualifiedSignals: number;
  rejectedSignals: number;
  watchSignals: number;
  // Distributions
  probabilities: number[];     // qualified-side probabilities
  signalScores: number[];
  edges: number[];
  hrWatchCount: number;
  // Rejection counters by category
  rejections: Record<RejectionCategory, number>;
  // Top reasons (free-form sub-reasons)
  reasons: Record<string, number>;
  // Per-market rejection counts (which markets bottleneck)
  byMarket: Record<string, { rejected: number; qualified: number }>;
  // Threshold currently applied for the dominant family (informational)
  thresholdsApplied: {
    batterOverAbsoluteFloor: number;
    batterOverScoreMinimum: number;
    pitcherScoreMinimum: number;
    highProbBypassThreshold: number;
    hrWatchGate: number; // base value (lowered to 25 when nearHr fires)
  };
}

const RING_SIZE = 50;             // most recent cycles
const ROLLING_AGE_MS = 30 * 60_000; // 30-minute rolling window for summary

// Rolling ring buffer of completed cycles (newest pushed at end).
const completedCycles: CycleCounters[] = [];
// Open cycles keyed by gameId — replaced when beginCycle fires again.
const openCycles = new Map<string, CycleCounters>();

function emptyCounters(gameId: string): CycleCounters {
  const rejections = {} as Record<RejectionCategory, number>;
  for (const c of ALL_CATEGORIES) rejections[c] = 0;
  return {
    gameId,
    startedAt: Date.now(),
    endedAt: null,
    rawCandidates: 0,
    normalizedCandidates: 0,
    qualifiedSignals: 0,
    rejectedSignals: 0,
    watchSignals: 0,
    probabilities: [],
    signalScores: [],
    edges: [],
    hrWatchCount: 0,
    rejections,
    reasons: {},
    byMarket: {},
    thresholdsApplied: {
      batterOverAbsoluteFloor: 40,
      batterOverScoreMinimum: 46,
      pitcherScoreMinimum: 50,
      highProbBypassThreshold: 65,
      hrWatchGate: 35,
    },
  };
}

export function beginCycle(gameId: string): void {
  openCycles.set(gameId, emptyCounters(gameId));
}

export function endCycle(gameId: string): void {
  const c = openCycles.get(gameId);
  if (!c) return;
  c.endedAt = Date.now();
  boundedPush(completedCycles, c, RING_SIZE);
  openCycles.delete(gameId);
}

function bump(gameId: string, mutate: (c: CycleCounters) => void): void {
  let c = openCycles.get(gameId);
  if (!c) {
    // Auto-open if a recorder is called before beginCycle (defensive — keeps
    // the audit honest if we ever miss a beginCycle wire-up).
    c = emptyCounters(gameId);
    openCycles.set(gameId, c);
  }
  mutate(c);
}

export function recordRawCandidate(gameId: string): void {
  bump(gameId, (c) => { c.rawCandidates++; });
}

export function recordNormalizedCandidate(gameId: string, market: string): void {
  bump(gameId, (c) => {
    c.normalizedCandidates++;
    if (!c.byMarket[market]) c.byMarket[market] = { rejected: 0, qualified: 0 };
  });
}

export function recordRejection(
  gameId: string,
  category: RejectionCategory,
  market: string | null,
  reason: string,
  ctx?: { probability?: number; signalScore?: number },
): void {
  bump(gameId, (c) => {
    c.rejectedSignals++;
    c.rejections[category]++;
    c.reasons[reason] = (c.reasons[reason] ?? 0) + 1;
    if (market) {
      if (!c.byMarket[market]) c.byMarket[market] = { rejected: 0, qualified: 0 };
      c.byMarket[market].rejected++;
    }
    if (ctx?.probability != null && Number.isFinite(ctx.probability)) {
      c.probabilities.push(ctx.probability);
    }
    if (ctx?.signalScore != null && Number.isFinite(ctx.signalScore)) {
      c.signalScores.push(ctx.signalScore);
    }
  });
}

export function recordQualified(
  gameId: string,
  signal: { market: string; probability: number; signalScore: number; edge: number; isHrWatch?: boolean },
): void {
  bump(gameId, (c) => {
    c.qualifiedSignals++;
    if (!c.byMarket[signal.market]) c.byMarket[signal.market] = { rejected: 0, qualified: 0 };
    c.byMarket[signal.market].qualified++;
    if (Number.isFinite(signal.probability)) c.probabilities.push(signal.probability);
    if (Number.isFinite(signal.signalScore)) c.signalScores.push(signal.signalScore);
    if (Number.isFinite(signal.edge)) c.edges.push(signal.edge);
    if (signal.isHrWatch) c.hrWatchCount++;
  });
}

// Counts a signal that was rejected from the actionable feed but surfaced
// as a Pre-AB / HR Watch entry instead. Does NOT bump rejections.tier — the
// underlying reject reason is already recorded by qualifySignal so adding
// tier here would double-count. Only the watchSignals tally is bumped.
export function recordWatchSurfaced(gameId: string, market: string): void {
  bump(gameId, (c) => {
    c.watchSignals++;
    if (!c.byMarket[market]) c.byMarket[market] = { rejected: 0, qualified: 0 };
  });
}

export function recordCooldown(gameId: string, ageMs: number, windowMs: number): void {
  // Cooldown is a whole-cycle event: open a synthetic cycle, mark, and close.
  beginCycle(gameId);
  bump(gameId, (c) => {
    c.rejections.cooldown++;
    c.reasons[`cooldown:${windowMs}ms`] = (c.reasons[`cooldown:${windowMs}ms`] ?? 0) + 1;
  });
  endCycle(gameId);
}

// ── Summary builders ─────────────────────────────────────────────────────

function pct(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((n / total) * 1000) / 10;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
}

function distribution(arr: number[], buckets: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i];
    const hi = buckets[i + 1];
    const key = `${lo}-${hi}`;
    out[key] = arr.filter(v => v >= lo && v < hi).length;
  }
  const last = buckets[buckets.length - 1];
  out[`${last}+`] = arr.filter(v => v >= last).length;
  return out;
}

export interface AuditSummary {
  windowMs: number;
  cyclesObserved: number;
  gamesObserved: number;
  totals: {
    rawCandidates: number;
    normalizedCandidates: number;
    qualifiedSignals: number;
    rejectedSignals: number;
    watchSignals: number;
    hrWatchCount: number;
  };
  averages: {
    probability: number;
    signalScore: number;
    edge: number;
    qualifiedPerCycle: number;
    rejectedPerCycle: number;
  };
  rejectionsByCategory: Record<RejectionCategory, number>;
  rejectionsByCategoryPct: Record<RejectionCategory, number>;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  qualificationBottlenecks: Array<{ market: string; rejected: number; qualified: number; rejectRate: number }>;
  suppressionBottlenecks: Array<{ reason: string; count: number }>;
  probabilityDistribution: Record<string, number>;
  signalScoreDistribution: Record<string, number>;
  thresholdsCurrentlyApplied: CycleCounters["thresholdsApplied"];
  recentCycles: Array<{
    gameId: string; startedAt: number; endedAt: number | null;
    qualified: number; rejected: number; watch: number;
    topCategory: RejectionCategory | null;
  }>;
}

export function getAuditSummary(): AuditSummary {
  const now = Date.now();
  const recent = completedCycles.filter(c => (c.endedAt ?? c.startedAt) > now - ROLLING_AGE_MS);

  const totals = {
    rawCandidates: 0, normalizedCandidates: 0, qualifiedSignals: 0,
    rejectedSignals: 0, watchSignals: 0, hrWatchCount: 0,
  };
  const rejectionsByCategory = {} as Record<RejectionCategory, number>;
  for (const c of ALL_CATEGORIES) rejectionsByCategory[c] = 0;
  const reasons: Record<string, number> = {};
  const byMarket: Record<string, { rejected: number; qualified: number }> = {};
  const probs: number[] = [];
  const scores: number[] = [];
  const edges: number[] = [];
  const games = new Set<string>();
  let lastThresholds: CycleCounters["thresholdsApplied"] | null = null;

  for (const cyc of recent) {
    games.add(cyc.gameId);
    totals.rawCandidates += cyc.rawCandidates;
    totals.normalizedCandidates += cyc.normalizedCandidates;
    totals.qualifiedSignals += cyc.qualifiedSignals;
    totals.rejectedSignals += cyc.rejectedSignals;
    totals.watchSignals += cyc.watchSignals;
    totals.hrWatchCount += cyc.hrWatchCount;
    for (const c of ALL_CATEGORIES) rejectionsByCategory[c] += cyc.rejections[c];
    for (const [k, v] of Object.entries(cyc.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
    for (const [m, v] of Object.entries(cyc.byMarket)) {
      if (!byMarket[m]) byMarket[m] = { rejected: 0, qualified: 0 };
      byMarket[m].rejected += v.rejected;
      byMarket[m].qualified += v.qualified;
    }
    probs.push(...cyc.probabilities);
    scores.push(...cyc.signalScores);
    edges.push(...cyc.edges);
    lastThresholds = cyc.thresholdsApplied;
  }

  const totalRejections = Object.values(rejectionsByCategory).reduce((s, v) => s + v, 0);
  const rejectionsByCategoryPct = {} as Record<RejectionCategory, number>;
  for (const c of ALL_CATEGORIES) rejectionsByCategoryPct[c] = pct(rejectionsByCategory[c], totalRejections);

  const topRejectionReasons = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  const qualificationBottlenecks = Object.entries(byMarket)
    .map(([market, v]) => {
      const denom = v.rejected + v.qualified;
      return { market, rejected: v.rejected, qualified: v.qualified, rejectRate: pct(v.rejected, denom) };
    })
    .sort((a, b) => b.rejected - a.rejected)
    .slice(0, 10);

  const suppressionBottlenecks = Object.entries(reasons)
    .filter(([k]) => /suppress|hr_under|hr_watch|tier_downgrade/i.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  return {
    windowMs: ROLLING_AGE_MS,
    cyclesObserved: recent.length,
    gamesObserved: games.size,
    totals,
    averages: {
      probability: avg(probs),
      signalScore: avg(scores),
      edge: avg(edges),
      qualifiedPerCycle: recent.length ? Math.round((totals.qualifiedSignals / recent.length) * 10) / 10 : 0,
      rejectedPerCycle: recent.length ? Math.round((totals.rejectedSignals / recent.length) * 10) / 10 : 0,
    },
    rejectionsByCategory,
    rejectionsByCategoryPct,
    topRejectionReasons,
    qualificationBottlenecks,
    suppressionBottlenecks,
    probabilityDistribution: distribution(probs, [0, 30, 40, 50, 55, 60, 65, 70, 80]),
    signalScoreDistribution: distribution(scores, [0, 20, 30, 40, 46, 50, 55, 70, 85]),
    thresholdsCurrentlyApplied: lastThresholds ?? {
      batterOverAbsoluteFloor: 40,
      batterOverScoreMinimum: 46,
      pitcherScoreMinimum: 50,
      highProbBypassThreshold: 65,
      hrWatchGate: 35,
    },
    recentCycles: recent.slice(-15).map(c => {
      let topCategory: RejectionCategory | null = null;
      let topCount = 0;
      for (const cat of ALL_CATEGORIES) {
        if (c.rejections[cat] > topCount) { topCount = c.rejections[cat]; topCategory = cat; }
      }
      return {
        gameId: c.gameId, startedAt: c.startedAt, endedAt: c.endedAt,
        qualified: c.qualifiedSignals, rejected: c.rejectedSignals, watch: c.watchSignals,
        topCategory,
      };
    }),
  };
}

// Test/debug only — never call in prod request paths.
export function _resetAuditForTests(): void {
  completedCycles.length = 0;
  openCycles.clear();
}
