// MLB Shadow Qualification Mode
//
// Parallel runtime path that evaluates a CANDIDATE qualification rule
// (`batter_over signalScore >= 43`) alongside the LIVE rule
// (`batter_over signalScore >= 46`) WITHOUT surfacing anything to users.
//
// HARD CONTRACT (do not violate):
//   * Shadow signals MUST NOT surface to users
//   * MUST NOT trigger alerts
//   * MUST NOT enter grading
//   * MUST NOT enter ROI analytics that affect product decisions
//   * MUST NOT persist as live plays
//   * MUST NOT mutate engineProbability / calibratedProbability / signalScore /
//     edge / drivers — the live engine math is already final by the time
//     shadow eval runs at the qualifySignal reject site
//
// All shadow signals carry `shadowQualified: true` and live ONLY in this
// in-process store. They are visible only via /api/admin/mlb-shadow-qualification.
//
// Diagnostics tags emitted by this module:
//   [LL_SHADOW_SIGNAL_QUALIFIED]
//   [LL_SHADOW_SIGNAL_REJECTED]
//   [LL_SHADOW_OUTCOME_RESOLVED]   — outcome successfully matched + recorded (cashed/missed/push)
//   [LL_SHADOW_OUTCOME_MISSING]    — boxscore present but player/market unresolvable
//   [LL_SHADOW_OUTCOME_PUSH]       — outcome resolved as push (finalStat == bookLine)
//   [LL_SHADOW_OUTCOME_EXPIRED]    — TTL or sweeper marked record expired
// Legacy tags retained for backwards compatibility:
//   [LL_SHADOW_SIGNAL_CASHED] [LL_SHADOW_SIGNAL_MISSED] [LL_SHADOW_SIGNAL_EXPIRED]

const SHADOW_BATTER_OVER_FLOOR = 43;
const LIVE_BATTER_OVER_FLOOR = 46;
const SHADOW_SAMPLE_SIZE_FLOOR = 50;
// ROI proxy: shadow records do NOT carry odds. We approximate at standard
// -110 vig (cashed pays 0.909u net, missed loses 1.0u, push = 0). This is a
// *directional* indicator, never a real money figure.
const ROI_VIG_PAYOUT = 0.909;

export type ShadowOutcome = "pending" | "cashed" | "missed" | "push" | "expired";

export interface ShadowEvalCandidate {
  gameId: string;
  market: string;
  playerName: string;
  playerId?: string | null;
  side: string;
  probability: number;
  signalScore: number;
  bookLine?: number | null;
  projection?: number | null;
  edge?: number | null;
  // Subscores so we can preserve the live conviction-cluster check at the
  // 43–46 band (matchup>=55 || liveContext>=55 || form>=60).
  scoreBreakdown: {
    matchup: number;
    liveContext: number;
    form: number;
    total: number;
    confidenceTier?: string;
  };
}

export interface ShadowSignalRecord {
  signalId: string;
  gameId: string;
  market: string;
  playerName: string;
  playerId?: string | null;
  side: string;
  probability: number;
  signalScore: number;
  edge: number | null;
  bookLine: number | null;
  projection: number | null;
  qualifiedAt: number;
  expectedToBeatLiveAt: number; // signalScore at which it would have qualified live (46)
  outcome: ShadowOutcome;
  outcomeAt: number | null;
  // Tracks any lifecycle-style transitions we observe for the shadow signal.
  history: Array<{ at: number; event: string; note?: string }>;
  shadowQualified: true;
}

export interface ShadowDecision {
  decision: "qualified" | "rejected";
  reason: string;
  signalId?: string;
}

interface ShadowMarketStats {
  shadowQualified: number;
  shadowRejected: number;
  cashed: number;
  missed: number;
  push: number;
  expired: number;
  pending: number;
  avgSignalScore: number;
  avgProbability: number;
  // Running mean accumulators
  _ssSum: number;
  _probSum: number;
  _ssCount: number;
}

interface ShadowSideStats {
  shadowQualified: number;
  cashed: number;
  missed: number;
  push: number;
  expired: number;
  pending: number;
}

interface ShadowAggregates {
  shadowQualifiedTotal: number;
  shadowRejectedTotal: number;
  cashedTotal: number;
  missedTotal: number;
  pushTotal: number;
  expiredTotal: number;
  pendingTotal: number;
  byMarket: Record<string, ShadowMarketStats>;
  bySide: Record<string, ShadowSideStats>;
  scoreDistribution: { "43-44": number; "44-45": number; "45-46": number };
  rejectReasons: Record<string, number>;
  // Last-decision ring buffer for debugging
  recent: Array<{
    at: number;
    decision: "qualified" | "rejected";
    gameId: string;
    market: string;
    playerName: string;
    signalScore: number;
    probability: number;
    reason: string;
    signalId?: string;
  }>;
}

const RECENT_RING_SIZE = 100;
const SHADOW_TTL_MS = 60 * 60 * 1000; // 1h — shadow signals expire after one hour without resolution

const store = new Map<string, ShadowSignalRecord>();
const aggregates: ShadowAggregates = {
  shadowQualifiedTotal: 0,
  shadowRejectedTotal: 0,
  cashedTotal: 0,
  missedTotal: 0,
  pushTotal: 0,
  expiredTotal: 0,
  pendingTotal: 0,
  byMarket: {},
  bySide: {},
  scoreDistribution: { "43-44": 0, "44-45": 0, "45-46": 0 },
  rejectReasons: {},
  recent: [],
};

function ensureMarket(market: string): ShadowMarketStats {
  if (!aggregates.byMarket[market]) {
    aggregates.byMarket[market] = {
      shadowQualified: 0,
      shadowRejected: 0,
      cashed: 0,
      missed: 0,
      push: 0,
      expired: 0,
      pending: 0,
      avgSignalScore: 0,
      avgProbability: 0,
      _ssSum: 0,
      _probSum: 0,
      _ssCount: 0,
    };
  }
  return aggregates.byMarket[market];
}

function ensureSide(side: string): ShadowSideStats {
  const k = (side || "unknown").toLowerCase();
  if (!aggregates.bySide[k]) {
    aggregates.bySide[k] = {
      shadowQualified: 0,
      cashed: 0,
      missed: 0,
      push: 0,
      expired: 0,
      pending: 0,
    };
  }
  return aggregates.bySide[k];
}

function pushRecent(entry: ShadowAggregates["recent"][number]): void {
  aggregates.recent.unshift(entry);
  if (aggregates.recent.length > RECENT_RING_SIZE) {
    aggregates.recent.length = RECENT_RING_SIZE;
  }
}

function buildSignalId(c: ShadowEvalCandidate): string {
  const actor = c.playerId ?? c.playerName.replace(/\s+/g, "_").toLowerCase();
  return `mlb-shadow:${c.gameId}:${actor}:${c.market}:${c.side.toLowerCase()}`;
}

/**
 * Evaluate a candidate against the SHADOW rule (batter_over signalScore >= 43)
 * with the same conviction-cluster preservation the live rule applies in the
 * 46–54 band.
 *
 * MUST be called ONLY from the live signalScore<46 reject site, AFTER all
 * other live gates (probability floor, side validation, hydration, HR-UNDER
 * block, suppression, HIGH_PROB_BYPASS, EARLY_BYPASS, HR_WATCH) have been
 * checked. This guarantees we are evaluating the SAME population the live
 * rule is rejecting — only the signalScore floor differs.
 */
export function evaluateShadowBatterOver(c: ShadowEvalCandidate): ShadowDecision {
  // The shadow rule is scoped to the batter_over family ONLY. Caller must gate.
  const ss = c.scoreBreakdown.total;

  // Below shadow floor → not even shadow-qualified. Track as shadow reject.
  if (ss < SHADOW_BATTER_OVER_FLOOR) {
    const reason = `signalScore_below_shadow_floor:${SHADOW_BATTER_OVER_FLOOR}`;
    aggregates.shadowRejectedTotal++;
    aggregates.rejectReasons[reason] = (aggregates.rejectReasons[reason] ?? 0) + 1;
    ensureMarket(c.market).shadowRejected++;
    pushRecent({
      at: Date.now(),
      decision: "rejected",
      gameId: c.gameId,
      market: c.market,
      playerName: c.playerName,
      signalScore: ss,
      probability: c.probability,
      reason,
    });
    console.log(
      `[LL_SHADOW_SIGNAL_REJECTED] ${c.playerName}/${c.market} game=${c.gameId} signalScore=${ss} reason=${reason}`,
    );
    return { decision: "rejected", reason };
  }

  // 43–46 band: preserve the conviction-cluster check the live rule applies
  // at 46–54 (one strong driver required). This protects the shadow path
  // from rescuing genuinely-weak setups.
  const hasConviction =
    c.scoreBreakdown.matchup >= 55 ||
    c.scoreBreakdown.liveContext >= 55 ||
    c.scoreBreakdown.form >= 60;

  if (!hasConviction) {
    const reason = "no_conviction_cluster";
    aggregates.shadowRejectedTotal++;
    aggregates.rejectReasons[reason] = (aggregates.rejectReasons[reason] ?? 0) + 1;
    ensureMarket(c.market).shadowRejected++;
    pushRecent({
      at: Date.now(),
      decision: "rejected",
      gameId: c.gameId,
      market: c.market,
      playerName: c.playerName,
      signalScore: ss,
      probability: c.probability,
      reason,
    });
    console.log(
      `[LL_SHADOW_SIGNAL_REJECTED] ${c.playerName}/${c.market} game=${c.gameId} signalScore=${ss} reason=${reason} (matchup=${c.scoreBreakdown.matchup} live=${c.scoreBreakdown.liveContext} form=${c.scoreBreakdown.form})`,
    );
    return { decision: "rejected", reason };
  }

  // Shadow-qualified.
  const signalId = buildSignalId(c);
  const now = Date.now();

  // Idempotent: same signalId can re-evaluate within the same game without
  // double-counting. Updated probability/signalScore are kept fresh.
  const existing = store.get(signalId);
  if (existing) {
    existing.probability = c.probability;
    existing.signalScore = ss;
    existing.edge = c.edge ?? existing.edge;
    // Outcome wiring uses bookLine for cashed/missed/push classification, so
    // re-evaluation MUST refresh it when the line moves. Same for projection.
    if (c.bookLine !== undefined) existing.bookLine = c.bookLine;
    if (c.projection !== undefined) existing.projection = c.projection;
    existing.history.push({ at: now, event: "shadow_re_evaluated" });
    return { decision: "qualified", reason: "re_evaluated", signalId };
  }

  const record: ShadowSignalRecord = {
    signalId,
    gameId: c.gameId,
    market: c.market,
    playerName: c.playerName,
    playerId: c.playerId ?? null,
    side: c.side,
    probability: c.probability,
    signalScore: ss,
    edge: c.edge ?? null,
    bookLine: c.bookLine ?? null,
    projection: c.projection ?? null,
    qualifiedAt: now,
    expectedToBeatLiveAt: LIVE_BATTER_OVER_FLOOR,
    outcome: "pending",
    outcomeAt: null,
    history: [{ at: now, event: "shadow_qualified" }],
    shadowQualified: true,
  };
  store.set(signalId, record);

  // Aggregates
  aggregates.shadowQualifiedTotal++;
  aggregates.pendingTotal++;
  const ms = ensureMarket(c.market);
  ms.shadowQualified++;
  ms.pending++;
  ms._ssSum += ss;
  ms._probSum += c.probability;
  ms._ssCount++;
  ms.avgSignalScore = ms._ssSum / ms._ssCount;
  ms.avgProbability = ms._probSum / ms._ssCount;
  const ss2 = ensureSide(c.side);
  ss2.shadowQualified++;
  ss2.pending++;

  if (ss < 44) aggregates.scoreDistribution["43-44"]++;
  else if (ss < 45) aggregates.scoreDistribution["44-45"]++;
  else aggregates.scoreDistribution["45-46"]++;

  pushRecent({
    at: now,
    decision: "qualified",
    gameId: c.gameId,
    market: c.market,
    playerName: c.playerName,
    signalScore: ss,
    probability: c.probability,
    reason: "shadow_qualified",
    signalId,
  });

  console.log(
    `[LL_SHADOW_SIGNAL_QUALIFIED] ${c.playerName}/${c.market} game=${c.gameId} signalScore=${ss} prob=${c.probability.toFixed(1)} signalId=${signalId}`,
  );

  return { decision: "qualified", reason: "shadow_qualified", signalId };
}

/**
 * Record an outcome for a shadow signal. Hooked from the existing MLB
 * grading flow — for now, this can be called manually or from a future
 * grader extension. Idempotent: an outcome can only be set once.
 */
export function recordShadowOutcome(
  signalId: string,
  outcome: Exclude<ShadowOutcome, "pending">,
  note?: string,
): boolean {
  const rec = store.get(signalId);
  if (!rec) return false;
  if (rec.outcome !== "pending") return false;
  rec.outcome = outcome;
  rec.outcomeAt = Date.now();
  rec.history.push({ at: rec.outcomeAt, event: `outcome_${outcome}`, note });

  aggregates.pendingTotal = Math.max(0, aggregates.pendingTotal - 1);
  const ms = ensureMarket(rec.market);
  ms.pending = Math.max(0, ms.pending - 1);
  const sd = ensureSide(rec.side);
  sd.pending = Math.max(0, sd.pending - 1);

  if (outcome === "cashed") {
    aggregates.cashedTotal++;
    ms.cashed++;
    sd.cashed++;
    console.log(
      `[LL_SHADOW_OUTCOME_RESOLVED] ${rec.playerName}/${rec.market} side=${rec.side} signalId=${signalId} outcome=cashed${note ? ` note=${note}` : ""}`,
    );
    console.log(`[LL_SHADOW_SIGNAL_CASHED] ${rec.playerName}/${rec.market} signalId=${signalId}`);
  } else if (outcome === "missed") {
    aggregates.missedTotal++;
    ms.missed++;
    sd.missed++;
    console.log(
      `[LL_SHADOW_OUTCOME_RESOLVED] ${rec.playerName}/${rec.market} side=${rec.side} signalId=${signalId} outcome=missed${note ? ` note=${note}` : ""}`,
    );
    console.log(`[LL_SHADOW_SIGNAL_MISSED] ${rec.playerName}/${rec.market} signalId=${signalId}`);
  } else if (outcome === "push") {
    aggregates.pushTotal++;
    ms.push++;
    sd.push++;
    console.log(
      `[LL_SHADOW_OUTCOME_PUSH] ${rec.playerName}/${rec.market} side=${rec.side} signalId=${signalId}${note ? ` note=${note}` : ""}`,
    );
    console.log(
      `[LL_SHADOW_OUTCOME_RESOLVED] ${rec.playerName}/${rec.market} side=${rec.side} signalId=${signalId} outcome=push`,
    );
  } else {
    aggregates.expiredTotal++;
    ms.expired++;
    sd.expired++;
    console.log(
      `[LL_SHADOW_OUTCOME_EXPIRED] ${rec.playerName}/${rec.market} side=${rec.side} signalId=${signalId}${note ? ` note=${note}` : ""}`,
    );
    console.log(`[LL_SHADOW_SIGNAL_EXPIRED] ${rec.playerName}/${rec.market} signalId=${signalId}`);
  }
  return true;
}

// ── Outcome resolver ─────────────────────────────────────────────────────────
// Resolve all pending shadow records for finished MLB games. The grader injects
// MLB Stats API helpers so this module stays decoupled from the grading layer
// and shadow logic stays the only owner of the in-memory store.
//
// HARD CONTRACT:
//   * Only writes shadow store. NEVER touches storage.settlePlay or
//     persisted_plays. ROI / W-L analytics are unaffected.
//   * Match strategy:
//       (1) signalId direct lookup (callers can supply when known)
//       (2) gameId + playerId + market (+ side, line) fallback key
//   * Unmatched / unresolvable → leaves record pending; sweeper TTL will
//     eventually mark it expired.

export interface ResolvedPlayerEntry {
  id: string;
  name: string;
}

export interface ResolveShadowDeps<P extends ResolvedPlayerEntry> {
  /**
   * Returns boxscore-derived player map for a finished game, or null if the
   * game is not final / boxscore unavailable. Map is keyed by playerId.
   */
  fetchPlayerMap(gameId: string): Promise<Map<string, P> | null>;
  /**
   * Returns the resolved final stat for the given (player, market), or null
   * if the market cannot be computed (DNP, unsupported market, etc.).
   */
  getStatValue(entry: P, market: string): number | null;
}

export interface ResolveShadowSummary {
  gamesScanned: number;
  gamesSkippedNoBoxscore: number;
  recordsScanned: number;
  cashed: number;
  missed: number;
  push: number;
  missing: number;
}

function normalizeNameForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['.\-\s]+/g, "")
    .replace(/jr$|sr$|ii$|iii$|iv$/, "");
}

/**
 * Lookup a pending shadow record by either signalId (preferred) or by the
 * canonical fallback key (gameId + playerId + market + side, optionally line).
 * Returns the FIRST pending match — shadow records are unique per signalId so
 * the fallback lookup also resolves at most one record.
 */
export function findPendingShadowRecord(query: {
  signalId?: string;
  gameId?: string;
  playerId?: string | null;
  playerName?: string;
  market?: string;
  side?: string;
  line?: number | null;
}): ShadowSignalRecord | undefined {
  if (query.signalId) {
    const direct = store.get(query.signalId);
    if (direct && direct.outcome === "pending") return direct;
  }
  if (!query.gameId || !query.market || !query.side) return undefined;
  const sideLc = query.side.toLowerCase();
  const wantPid = query.playerId != null ? String(query.playerId) : null;
  const wantNameNorm = query.playerName ? normalizeNameForMatch(query.playerName) : null;
  for (const rec of Array.from(store.values())) {
    if (rec.outcome !== "pending") continue;
    if (rec.gameId !== query.gameId) continue;
    if (rec.market !== query.market) continue;
    if (rec.side.toLowerCase() !== sideLc) continue;
    if (wantPid != null) {
      if (String(rec.playerId ?? "") !== wantPid) continue;
    } else if (wantNameNorm != null) {
      if (normalizeNameForMatch(rec.playerName) !== wantNameNorm) continue;
    }
    if (query.line != null) {
      // Strict line guard: when caller supplies a line, reject the record
      // unless its stored bookLine matches. A null stored line is NOT a free
      // pass — that would let stale lineless records absorb fresh queries.
      if (rec.bookLine == null) continue;
      if (Math.abs(Number(rec.bookLine) - Number(query.line)) > 1e-6) continue;
    }
    return rec;
  }
  return undefined;
}

/**
 * Compute the cashed / missed / push outcome for a shadow record given a
 * resolved final stat. Pure function — exposed for tests.
 */
export function classifyShadowOutcome(
  side: string,
  bookLine: number | null,
  finalStat: number,
): "cashed" | "missed" | "push" | null {
  if (bookLine == null || !Number.isFinite(bookLine)) return null;
  if (!Number.isFinite(finalStat)) return null;
  if (finalStat === bookLine) return "push";
  const sideLc = side.toLowerCase();
  if (sideLc === "over") return finalStat > bookLine ? "cashed" : "missed";
  if (sideLc === "under") return finalStat < bookLine ? "cashed" : "missed";
  return null;
}

/**
 * Resolve outcomes for all pending shadow records by gameId. Iterates every
 * pending record, groups by gameId, fetches the boxscore via injected deps,
 * and records outcomes. Idempotent — already-settled records are skipped.
 *
 * Used by the persisted-play grader at the end of each grading tick. Safe to
 * call when there are zero pending shadow records (returns early).
 */
export async function resolvePendingShadowOutcomes<P extends ResolvedPlayerEntry>(
  deps: ResolveShadowDeps<P>,
): Promise<ResolveShadowSummary> {
  const summary: ResolveShadowSummary = {
    gamesScanned: 0,
    gamesSkippedNoBoxscore: 0,
    recordsScanned: 0,
    cashed: 0,
    missed: 0,
    push: 0,
    missing: 0,
  };
  // Group pending records by gameId — batches box-score fetches.
  const byGame = new Map<string, ShadowSignalRecord[]>();
  for (const rec of Array.from(store.values())) {
    if (rec.outcome !== "pending") continue;
    const list = byGame.get(rec.gameId) ?? [];
    list.push(rec);
    byGame.set(rec.gameId, list);
  }
  if (byGame.size === 0) return summary;

  for (const [gameId, recs] of Array.from(byGame.entries())) {
    summary.gamesScanned++;
    let playerMap: Map<string, P> | null = null;
    try {
      playerMap = await deps.fetchPlayerMap(gameId);
    } catch (err: any) {
      console.warn(
        `[LL_SHADOW_OUTCOME_MISSING] gameId=${gameId} reason=boxscore_fetch_error msg=${err?.message ?? err}`,
      );
      summary.gamesSkippedNoBoxscore++;
      continue;
    }
    if (!playerMap) {
      // Game not final / postponed / boxscore unreachable — leave records
      // pending; sweeper TTL will mark as expired if it persists.
      summary.gamesSkippedNoBoxscore++;
      continue;
    }

    for (const rec of recs) {
      summary.recordsScanned++;
      // Match by playerId first (preferred), then fallback by normalized name.
      let entry: P | undefined;
      if (rec.playerId) {
        entry = playerMap.get(String(rec.playerId));
      }
      if (!entry && rec.playerName) {
        const target = normalizeNameForMatch(rec.playerName);
        for (const e of Array.from(playerMap.values())) {
          if (normalizeNameForMatch(e.name) === target) {
            entry = e;
            break;
          }
        }
      }
      if (!entry) {
        summary.missing++;
        console.warn(
          `[LL_SHADOW_OUTCOME_MISSING] ${rec.playerName}/${rec.market} signalId=${rec.signalId} reason=player_not_in_boxscore`,
        );
        continue;
      }
      const finalStat = deps.getStatValue(entry, rec.market);
      if (finalStat == null) {
        summary.missing++;
        console.warn(
          `[LL_SHADOW_OUTCOME_MISSING] ${rec.playerName}/${rec.market} signalId=${rec.signalId} reason=stat_unresolvable`,
        );
        continue;
      }
      if (rec.bookLine == null) {
        summary.missing++;
        console.warn(
          `[LL_SHADOW_OUTCOME_MISSING] ${rec.playerName}/${rec.market} signalId=${rec.signalId} reason=no_book_line`,
        );
        continue;
      }
      const outcome = classifyShadowOutcome(rec.side, rec.bookLine, finalStat);
      if (!outcome) {
        summary.missing++;
        console.warn(
          `[LL_SHADOW_OUTCOME_MISSING] ${rec.playerName}/${rec.market} signalId=${rec.signalId} reason=invalid_side_or_line side=${rec.side} line=${rec.bookLine}`,
        );
        continue;
      }
      const ok = recordShadowOutcome(
        rec.signalId,
        outcome,
        `finalStat=${finalStat} line=${rec.bookLine}`,
      );
      if (ok) {
        if (outcome === "cashed") summary.cashed++;
        else if (outcome === "missed") summary.missed++;
        else summary.push++;
      }
    }
  }
  return summary;
}

/**
 * Sweeper — expire shadow signals idle past TTL with `expired` outcome so
 * pending counts don't grow unbounded.
 */
export function sweepShadowSignals(): { expired: number; remaining: number } {
  const now = Date.now();
  let expired = 0;
  for (const [signalId, rec] of Array.from(store.entries())) {
    if (rec.outcome !== "pending") continue;
    if (now - rec.qualifiedAt > SHADOW_TTL_MS) {
      recordShadowOutcome(signalId, "expired", "ttl");
      expired++;
    }
  }
  return { expired, remaining: store.size };
}

let sweeperHandle: ReturnType<typeof setInterval> | null = null;
export function startShadowSweeper(intervalMs = 5 * 60 * 1000): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => {
    try {
      const r = sweepShadowSignals();
      if (r.expired > 0) {
        console.log(`[LL_SHADOW_SWEEP] expired=${r.expired} remaining=${r.remaining}`);
      }
    } catch (err: any) {
      console.warn(`[LL_SHADOW_SWEEP_ERROR] ${err?.message ?? err}`);
    }
  }, intervalMs);
  console.log(`[LL_SHADOW_BOOT] sweeper started (interval=${intervalMs}ms ttl=${SHADOW_TTL_MS}ms)`);
}

export interface ShadowSummary {
  liveFloor: number;
  shadowFloor: number;
  scope: "batter_over_only";
  totals: {
    shadowQualified: number;
    shadowRejected: number;
    pending: number;
    cashed: number;
    missed: number;
    push: number;
    expired: number;
    settled: number; // cashed + missed + push
  };
  hitRate: number | null; // cashed / (cashed + missed)  — push excluded
  /**
   * Approximate ROI in units assuming -110 vig per pick. Cashed = +0.909u,
   * missed = -1.0u, push = 0u. Directional only — shadow records do NOT
   * carry real odds.
   */
  roiUnits: number | null;
  roiPerPick: number | null;
  sampleSize: number; // settled (cashed+missed+push)
  sampleSizeWarning: string | null;
  byMarket: Record<
    string,
    {
      shadowQualified: number;
      shadowRejected: number;
      cashed: number;
      missed: number;
      push: number;
      expired: number;
      pending: number;
      hitRate: number | null;
      avgSignalScore: number;
      avgProbability: number;
    }
  >;
  bySide: Record<
    string,
    {
      shadowQualified: number;
      cashed: number;
      missed: number;
      push: number;
      expired: number;
      pending: number;
      hitRate: number | null;
    }
  >;
  scoreDistribution: ShadowAggregates["scoreDistribution"];
  rejectReasons: Record<string, number>;
  activeShadowSignals: number;
  recent: ShadowAggregates["recent"];
  thresholds: {
    SHADOW_BATTER_OVER_FLOOR: number;
    LIVE_BATTER_OVER_FLOOR: number;
    SHADOW_TTL_MS: number;
    SHADOW_SAMPLE_SIZE_FLOOR: number;
  };
  generatedAt: string;
}

export function getShadowSummary(): ShadowSummary {
  const cm = aggregates.cashedTotal + aggregates.missedTotal;
  const hitRate = cm > 0 ? aggregates.cashedTotal / cm : null;
  const settled =
    aggregates.cashedTotal + aggregates.missedTotal + aggregates.pushTotal;
  // ROI proxy at -110 vig: cashed=+0.909u, missed=-1u, push=0.
  const roiUnits =
    settled > 0
      ? aggregates.cashedTotal * ROI_VIG_PAYOUT - aggregates.missedTotal
      : null;
  const roiPerPick = roiUnits != null && settled > 0 ? roiUnits / settled : null;
  const sampleSizeWarning =
    settled < SHADOW_SAMPLE_SIZE_FLOOR
      ? `Directional only — insufficient sample (settled=${settled}, floor=${SHADOW_SAMPLE_SIZE_FLOOR})`
      : null;

  const byMarket: ShadowSummary["byMarket"] = {};
  for (const [market, ms] of Object.entries(aggregates.byMarket)) {
    const subCm = ms.cashed + ms.missed;
    byMarket[market] = {
      shadowQualified: ms.shadowQualified,
      shadowRejected: ms.shadowRejected,
      cashed: ms.cashed,
      missed: ms.missed,
      push: ms.push,
      expired: ms.expired,
      pending: ms.pending,
      hitRate: subCm > 0 ? ms.cashed / subCm : null,
      avgSignalScore: ms._ssCount > 0 ? Math.round(ms.avgSignalScore * 100) / 100 : 0,
      avgProbability: ms._ssCount > 0 ? Math.round(ms.avgProbability * 100) / 100 : 0,
    };
  }
  const bySide: ShadowSummary["bySide"] = {};
  for (const [side, ss] of Object.entries(aggregates.bySide)) {
    const subCm = ss.cashed + ss.missed;
    bySide[side] = {
      shadowQualified: ss.shadowQualified,
      cashed: ss.cashed,
      missed: ss.missed,
      push: ss.push,
      expired: ss.expired,
      pending: ss.pending,
      hitRate: subCm > 0 ? ss.cashed / subCm : null,
    };
  }
  return {
    liveFloor: LIVE_BATTER_OVER_FLOOR,
    shadowFloor: SHADOW_BATTER_OVER_FLOOR,
    scope: "batter_over_only",
    totals: {
      shadowQualified: aggregates.shadowQualifiedTotal,
      shadowRejected: aggregates.shadowRejectedTotal,
      pending: aggregates.pendingTotal,
      cashed: aggregates.cashedTotal,
      missed: aggregates.missedTotal,
      push: aggregates.pushTotal,
      expired: aggregates.expiredTotal,
      settled,
    },
    hitRate,
    roiUnits,
    roiPerPick,
    sampleSize: settled,
    sampleSizeWarning,
    byMarket,
    bySide,
    scoreDistribution: aggregates.scoreDistribution,
    rejectReasons: aggregates.rejectReasons,
    activeShadowSignals: store.size,
    recent: aggregates.recent.slice(0, 50),
    thresholds: {
      SHADOW_BATTER_OVER_FLOOR,
      LIVE_BATTER_OVER_FLOOR,
      SHADOW_TTL_MS,
      SHADOW_SAMPLE_SIZE_FLOOR,
    },
    generatedAt: new Date().toISOString(),
  };
}

export function getShadowSignal(signalId: string): ShadowSignalRecord | undefined {
  return store.get(signalId);
}

export function listShadowSignals(opts?: { gameId?: string; outcome?: ShadowOutcome }): ShadowSignalRecord[] {
  const out: ShadowSignalRecord[] = [];
  for (const rec of Array.from(store.values())) {
    if (opts?.gameId && rec.gameId !== opts.gameId) continue;
    if (opts?.outcome && rec.outcome !== opts.outcome) continue;
    out.push(rec);
  }
  return out.sort((a, b) => b.qualifiedAt - a.qualifiedAt);
}
