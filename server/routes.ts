import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { api } from "@shared/routes";
import { z } from "zod";
import { type Player, type ParlayPickInput, type PersistedPlay, persistedPlays } from "@shared/schema";
import { sql, and, desc, gte } from "drizzle-orm";
import { computeFamilyPenaltyFactor } from "./nba/marketFamily";
import { recordSurfacedSignal, seedFromSettledPlays, getDirectionalSplit } from "./nba/directionalBias";
import { getPlayerOdds, resolveOddsEventId, getRawOddsForDebug, resolveEventForDebug, getGameLines, getSGOPlayerLine, resolveMLBOddsEventId, getMLBPlayerOdds, normalizeOdds, getOddsKeyStatus } from "./oddsService";
import { getDataHealth } from "./services/dataHealth";
import { getEngineDebugSummary, recordEngineRun, resetEngineStats } from "./services/engineStats";
import { filterValidSignals } from "./services/engineSignal";
import { filterValidEngineOutputs } from "./services/engineValidation";
import { processNBAEngine } from "./engines/nba";
import { processMLBEngine } from "./engines/mlb";
import { emitDriftTrace } from "./utils/driftTrace";
import { isValidTimingWindow } from "./services/timingService";
import { filterFreshLines, getBestBet } from "./services/sportsbookService";
import { trackPlay } from "./services/playTracker";
import { gradePersistedPlays } from "./services/gradePersistedPlays";
import { buildEngineInput } from "./services/engineInputBuilder";
import { computeNCAABPlays, getNCAABScoreboard, getNCAABH2H, getNCAABChipOdds, fetch2HLines, calc2HEngineProb } from "./ncaabService";
import { enrichNCAABGameFull, clearEnrichmentCache, getEnrichmentCacheStats } from "./ncaabEnrichment";
import { calculateParlay } from "./parlayService";
import { registerAuthRoutes, requirePlayAccess, requireMLBAccess, requireAuth, requireAdmin, requireTier } from "./auth";
import { resolveAccess } from "./utils/access";
import { todayET, daysAgoET } from "./utils/dateUtils";
import {
  HR_RADAR_GOLDMASTER_V1,
  enrichWithUserStage,
  buildValidationPayload,
} from "./mlb/hrRadarUserStage";
import { CALLED_HIT_OUTCOME_STATUSES } from "./mlb/hrRadarSection";
import { registerStripeRoutes } from "./stripeService";
import { getVapidPublicKey } from "./webpush";
import { sendPushToUser } from "./pushDelivery";
import { checkAndSendAlerts } from "./alertManager";
import { autoResolveAlerts, autoSettlePersistedPlays } from "./analyticsResolver";
import { getROIMetrics } from "./services/roiEngine";
import { syncMinutesProjections } from "./services/minutesProjectionService";
import { calculateMLBPropEdge, canShowSignal, hasRealOdds } from "./mlb/markets";
import { normalizeMlbMarketKey } from "./mlb/normalizeMarketKey";
import { getMarketParkFactor } from "./mlb/dataSources";
import { isBarrel as isCanonicalBarrel } from "./mlb/statcastXBA";
import { validateMlbEngineProbability, logMlbPersistReject, MLB_PROB_BUCKETS, bucketPlaysByCanonicalProb } from "./mlb/probabilityEngine";
import {
  recordMLBDiagnostic,
  getMLBDiagnosticSummary,
  getMLBMarketReport,
  getModifierContributionSummary,
} from "./mlb/diagnostics";
import { runBacktest, runBatchInputs } from "./mlb/backtestHarness";
import { ALL_MLB_MARKETS, type MLBPropInput, type MLBMarket } from "./mlb/types";
import {
  updatePlayerPool,
  updateTeamRosters,
  getPlayer,
  getPlayerPoolCount,
  getTeamCount,
  getPlayerByName,
} from "./mlb/rosterService";
import {
  syncGameState,
  syncContactData,
  syncPitcherContext,
  syncWeather,
  syncBullpenUsage,
  mlbGameCache,
  mlbPlayerCache,
} from "./mlb/dataPullService";
import { getActiveGames } from "./mlb/liveGameRegistry";
import { mlbEdgeCache, isMLBEdgeEntryFresh } from "./mlb/edgeCache";
import { liveOrchestrator, normalizeMlbStatus } from "./mlb/liveGameOrchestrator";
import { normalizeMLBSignal } from "./mlb/normalizeSignal";
import { resolveMlbPlayerMarketSignal } from "./mlb/resolveCanonicalSignal";
import { CALCULATOR_SOURCE_LABEL } from "../shared/mlbCanonicalSignal";
import { normalizeMlbMarket } from "../shared/normalizeMlbMarket";

// ── NCAAB live signal cache (populated by /api/ncaab/plays, read by /api/top-plays) ──
const ncaabLiveSignals: { signals: any[]; updatedAt: number } = { signals: [], updatedAt: 0 };

// Safe per-row JSON-array parse. A single malformed cached blob (e.g. a row's
// `abResults`) must not throw and 500 an entire multi-row response — fall back
// to [] for just that row.
function safeParseJsonArray(raw: string | null | undefined): any[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getPlayKey(p: {
  playerId?: string | number | null;
  playerName: string;
  statType?: string;
  market?: string;
  line: number | string;
  betDirection?: string;
  direction?: string;
  gameId?: string | null;
  timestamp?: Date | string;
}): string {
  const today = p.timestamp
    ? new Date(p.timestamp).toLocaleDateString("en-CA", { timeZone: "America/New_York" })
    : todayET();
  return [
    String(p.playerId ?? p.playerName ?? "").trim(),
    String(p.statType ?? p.market ?? "").toUpperCase().trim(),
    String(p.line ?? ""),
    String(p.betDirection ?? p.direction ?? "").toLowerCase().trim(),
    String(p.gameId ?? "").trim(),
    today,
  ].join("|");
}

interface BatchSignal {
  playerId: number;
  playerName: string;
  statType: string;
  probability: number;
  betDirection: string;
  edge: number;
  line: number;
  currentStat?: number;
  gameId?: string;
  [key: string]: any;
}

// NBA Calibration v2 — conflicting OVER/UNDER suppression. When the engine
// surfaces both sides of the same player+market-family+game on a comparable
// line (alt lines / line variants of the same stat), keep the higher-
// conviction side, drop the weaker, and cap the survivor at 68%.
// Mutates `engineDiagnostics.calibrationVersion` / `confidenceCeilingApplied`
// / `ceilingReason` so admin analytics see the cap.
//
// Market family normalization handles common alt-line / variant naming so
// e.g. `points`, `points_alt`, `points_15.5`, `pts` all collapse to the
// same family — otherwise the suppression silently misses real conflicts.
function nbaMarketFamilyKey(statType: string | undefined): string {
  const raw = String(statType ?? "").toLowerCase().trim();
  if (!raw) return "unknown";
  // Strip trailing line numbers ("points_15.5" → "points") and common
  // variant suffixes (_alt, _alt1, _yes, _no, _o, _u, _over, _under).
  let s = raw
    .replace(/_alt\d*$/i, "")
    .replace(/_(yes|no|o|u|over|under)$/i, "")
    .replace(/[_-]?\d+(\.\d+)?$/, "");
  // Canonical aliases
  const alias: Record<string, string> = {
    pts: "points",
    reb: "rebounds",
    ast: "assists",
    stl: "steals",
    blk: "blocks",
    "3pm": "threes",
    fg3m: "threes",
    three_pointers_made: "threes",
    blocks_steals: "stl_blk",
    steals_blocks: "stl_blk",
    pra: "pts_reb_ast",
    pts_ast_reb: "pts_reb_ast",
    points_rebounds_assists: "pts_reb_ast",
  };
  s = alias[s] ?? s;
  return s;
}
// Pure conflict-suppression logic lives in server/nba/conflictSuppression.ts
// so the regression audit can exercise it without booting Express.
import { applyNbaConflictSuppression as _applyNbaConflictSuppressionPure } from "./nba/conflictSuppression";

function applyNbaConflictSuppression<T extends BatchSignal>(signals: T[]): T[] {
  return _applyNbaConflictSuppressionPure(signals, nbaMarketFamilyKey);
}

function applyBatchFamilySuppression<T extends BatchSignal>(signals: T[]): T[] {
  const familyMap = new Map<string, T[]>();
  for (const s of signals) {
    const dir = s.betDirection.toLowerCase();
    const key = `${s.playerId}_${s.gameId ?? "unknown"}_${dir}`;
    if (!familyMap.has(key)) familyMap.set(key, []);
    familyMap.get(key)!.push(s);
  }

  const result: T[] = [];
  for (const [familyId, members] of Array.from(familyMap.entries())) {
    members.sort((a: any, b: any) => b.edge - a.edge);
    const siblingCount = members.length;
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const rank = i + 1;
      const penalty = computeFamilyPenaltyFactor(rank);
      const role = rank === 1 ? "flagship" : "derivative";

      const diag = (m as any).engineDiagnostics ?? {};
      (m as any).engineDiagnostics = {
        ...diag,
        familyId,
        siblingCount,
        siblingRank: rank,
        flagshipOrDerivative: role,
        familyPenaltyFactor: penalty,
      };

      if (rank > 1) {
        const adjustedConf = 50 + (m.probability - 50) * penalty;
        const adjustedEdge = adjustedConf - 50;
        // Floor aligned with the frontend Value tier (≥60%). Previously this
        // was 64% / edge 4, which silently stripped any derivative signal in
        // the 60-63% band even though the SIGNAL KEY tells the user that
        // band is a real signal. We have plenty of API headroom — let the
        // user see the signal and decide.
        if (adjustedConf < 60 || adjustedEdge < 3) {
          console.log(`[FAMILY_SUPPRESS] ${m.playerName} ${m.statType} rank=${rank} adjConf=${adjustedConf.toFixed(1)} adjEdge=${adjustedEdge.toFixed(1)} — suppressed`);
          continue;
        }
      }
      result.push(m);
    }
  }
  return result;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  await registerAuthRoutes(app);
  await registerStripeRoutes(app);

  // ── Attribution: visit tracking + admin metrics ────────────────────────
  // Public POST: records a visit row (visitor cookie set by global middleware).
  app.post("/api/attribution/visit", async (req, res) => {
    try {
      const { recordVisit } = await import("./services/attributionService");
      const result = await recordVisit(req, req.body ?? {});
      return res.json(result);
    } catch (e: any) {
      // Never surface errors to the client — attribution is fire-and-forget.
      console.error("[attribution/visit]", e.message);
      return res.json({ ok: true, deduped: false });
    }
  });

  // Admin-only: per-source attribution summary (Twitter etc).
  app.get("/api/admin/attribution/:source", requireAdmin, async (req, res) => {
    try {
      const source = String(req.params.source || "").toLowerCase();
      if (!source) return res.status(400).json({ error: "missing source" });
      const rawDays = Number(req.query.days);
      const windowDays: 7 | 30 | 90 = (rawDays === 7 || rawDays === 30 || rawDays === 90) ? rawDays as 7 | 30 | 90 : 30;
      const { getAttributionSummary } = await import("./services/attributionService");
      const summary = await getAttributionSummary(source, windowDays);
      return res.json(summary);
    } catch (e: any) {
      console.error("[admin/attribution]", e.message);
      return res.status(500).json({ error: "summary failed" });
    }
  });

  storage.getPlays({ sport: "nba", limit: 200, settled: "settled" }).then(({ plays }) => {
    const recent7d = plays.filter(p => {
      const d = p.gameDate;
      const cutoff = daysAgoET(7);
      return d >= cutoff;
    });
    seedFromSettledPlays(recent7d.map(p => ({
      direction: p.direction,
      result: p.result,
      displayConfidence: p.prob ? Number(p.prob) : null,
    })));
    console.log(`[directional-bias] Seeded from ${recent7d.length} settled NBA plays (7d)`);
  }).catch(e => console.warn("[directional-bias] Seed failed:", (e as any).message));

  // ── Admin Routes ──────────────────────────────────────────────────────────

  app.get("/api/admin/churn", requireAdmin, async (_req, res) => {
    try {
      const churned = await storage.getChurnedUsers();
      return res.json(churned);
    } catch (err) {
      console.error("[admin/churn]", err);
      return res.status(500).json({ error: "Failed to fetch churn data" });
    }
  });

  // Pass 6 — Lifecycle reporting endpoint (admin-only).
  // Surfaces trial starts, active trials, trial dropoff, trial→paid conversion, paid churn,
  // and the alerts/telegram channel status distributions. All values come from the
  // additive lifecycle columns introduced in Pass 2 + the existing churn_tracking flow.
  // ── LiveLocks Batch B — Signal Lifecycle admin debug ──────────────
  // Read-only inspection of CanonicalSignal lifecycle state + history.
  // Distinct namespace (`signal-lifecycle/`) from the existing
  // subscription `/lifecycle-metrics` to avoid collision.
  app.get("/api/admin/signal-lifecycle", requireAdmin, async (req, res) => {
    try {
      const { listCanonical } = await import("./services/lifecycleStore");
      const sportQ = req.query.sport;
      const sport = typeof sportQ === "string" ? sportQ : undefined;
      const limit = req.query.limit ? Math.min(500, Number(req.query.limit) || 200) : 200;
      const items = listCanonical({ sport, limit });
      return res.json({
        count: items.length,
        items: items.map((s) => ({
          signalId: s.signalId,
          sport: s.sport,
          actor: s.actorName,
          market: s.market,
          side: s.side,
          signalTier: s.signalTier,
          lifecycleState: s.lifecycleState,
          updatedAt: s.updatedAt,
          surfacedAt: s.surfacedAt,
          expiresAt: s.expiresAt,
          historyLen: s.lifecycleHistory.length,
        })),
      });
    } catch (err) {
      console.error("[admin/signal-lifecycle list]", err);
      return res.status(500).json({ error: "Failed to fetch signal lifecycle list" });
    }
  });

  // ── LiveLocks Batch C — LiveSignalBus runtime metrics (constraint 14) ──
  // Read-only admin surface exposing registration / dedupe / freshness /
  // legacy-consumer counts and propagation timing percentiles. Used to
  // verify "no signal disappearance between engine and UI" before Batch D.
  app.get("/api/admin/signal-bus", requireAdmin, async (_req, res) => {
    try {
      const { getMetrics, SIGNAL_FRESHNESS_MS } = await import("./services/liveSignalBus");
      const { getBridgeMetrics } = await import("./services/canonicalSignalViewModel");
      const { getAlertMetrics } = await import("./services/alertSubscriber");
      const { listCanonical } = await import("./services/lifecycleStore");
      // Lifecycle event counts by current state (snapshot of the store).
      const lifecycleEventCountsByState: Record<string, number> = {};
      try {
        for (const sig of listCanonical()) {
          lifecycleEventCountsByState[sig.lifecycleState] =
            (lifecycleEventCountsByState[sig.lifecycleState] ?? 0) + 1;
        }
      } catch {}
      return res.json({
        freshnessMs: SIGNAL_FRESHNESS_MS,
        ...getMetrics(),
        bridge: getBridgeMetrics(),
        alerts: getAlertMetrics(),
        lifecycleEventCountsByState,
      });
    } catch (err) {
      console.error("[admin/signal-bus]", err);
      return res.status(500).json({ error: "Failed to fetch signal bus metrics" });
    }
  });

  // ── Batch E — MLB Signal Intelligence dashboard payload ──────────────
  // Aggregates analytics ring buffer + shadow store + bus metrics into a
  // single read-only snapshot. Server aggregates; client renders only.
  app.get("/api/admin/mlb-signal-intelligence", requireAdmin, async (req, res) => {
    try {
      const windowMs = req.query.windowMs
        ? Math.max(60_000, Math.min(7 * 24 * 60 * 60 * 1000, parseInt(String(req.query.windowMs), 10)))
        : undefined;

      const [
        { computeMlbIntelligence },
        { computeHrRadarIntelligence },
        { computeDriverIntelligence },
        { computeShadowAnalytics },
        { getMetrics, SIGNAL_FRESHNESS_MS },
        { getBridgeMetrics },
        { getAlertMetrics },
        { listCanonical },
        { getAnalyticsBufferSize },
      ] = await Promise.all([
        import("./analytics/mlbSignalIntelligence"),
        import("./analytics/hrRadarIntelligence"),
        import("./analytics/driverIntelligence"),
        import("./analytics/shadowAnalytics"),
        import("./services/liveSignalBus"),
        import("./services/canonicalSignalViewModel"),
        import("./services/alertSubscriber"),
        import("./services/lifecycleStore"),
        import("./analytics/analyticsEvent"),
      ]);

      const lifecycleEventCountsByState: Record<string, number> = {};
      const tierCountsCurrent: Record<string, number> = {};
      try {
        for (const sig of listCanonical({ sport: "mlb" })) {
          lifecycleEventCountsByState[sig.lifecycleState] =
            (lifecycleEventCountsByState[sig.lifecycleState] ?? 0) + 1;
          tierCountsCurrent[sig.signalTier] =
            (tierCountsCurrent[sig.signalTier] ?? 0) + 1;
        }
      } catch {}

      return res.json({
        runtimeHealth: {
          freshnessMs: SIGNAL_FRESHNESS_MS,
          ...getMetrics(),
          bridge: getBridgeMetrics(),
          alerts: getAlertMetrics(),
          lifecycleEventCountsByState,
          tierCountsCurrent,
          analyticsBufferSize: getAnalyticsBufferSize(),
        },
        lifecycle: computeMlbIntelligence({ windowMs }),
        hrRadar: computeHrRadarIntelligence({ windowMs }),
        drivers: computeDriverIntelligence({ windowMs }),
        shadow: computeShadowAnalytics({ windowMs }),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[admin/mlb-signal-intelligence]", err);
      return res.status(500).json({ error: "Failed to fetch MLB signal intelligence" });
    }
  });

  // MLB Runtime Qualification audit — rolling-window summary of every
  // rejection, suppression, and qualified signal across the engine pipeline.
  // Used to diagnose qualified=0 cycles and propose threshold tuning.
  app.get("/api/admin/mlb-qualification", requireAdmin, async (_req, res) => {
    try {
      const { getAuditSummary } = await import("./mlb/qualificationAudit");
      return res.json(getAuditSummary());
    } catch (err) {
      console.error("[admin/mlb-qualification]", err);
      return res.status(500).json({ error: "Failed to fetch MLB qualification audit" });
    }
  });

  // MLB Shadow Qualification panel — passive parallel-runtime evaluation of a
  // candidate threshold (batter_over signalScore >= 43) vs the live floor (46).
  // Shadow signals are recorded for analytics ONLY and never surface to users,
  // alerts, grading, or ROI. Use this to compare hit rate / volatility before
  // proposing any live threshold change.
  app.get("/api/admin/mlb-shadow-qualification", requireAdmin, async (req, res) => {
    try {
      const { getShadowSummary, listShadowSignals } = await import("./mlb/shadowQualification");
      const includeRecords = String(req.query.includeRecords ?? "") === "1";
      const outcomeFilter = req.query.outcome ? String(req.query.outcome) : undefined;
      const summary = getShadowSummary();
      const enriched = {
        ...summary,
        // Surfaced for admin UI: outcome distribution + side breakdown +
        // sample-size warning are now first-class fields on the summary.
        outcomeBreakdown: {
          cashed: summary.totals.cashed,
          missed: summary.totals.missed,
          push: summary.totals.push,
          expired: summary.totals.expired,
          pending: summary.totals.pending,
          settled: summary.totals.settled,
        },
        roiProxy: {
          unitsAt110: summary.roiUnits,
          perPick: summary.roiPerPick,
          sampleSize: summary.sampleSize,
          warning: summary.sampleSizeWarning,
          note: "Approximate ROI assuming standard -110 vig. Shadow records do not carry real odds.",
        },
      };
      if (includeRecords) {
        const gameId = req.query.gameId ? String(req.query.gameId) : undefined;
        const records = listShadowSignals(
          outcomeFilter ? { gameId, outcome: outcomeFilter as any } : { gameId },
        );
        return res.json({ ...enriched, records });
      }
      return res.json(enriched);
    } catch (err) {
      console.error("[admin/mlb-shadow-qualification]", err);
      return res.status(500).json({ error: "Failed to fetch MLB shadow qualification summary" });
    }
  });

  // ── MLB Pre-Game Power Radar (additive, confirmed-lineup targets) ───────────
  // Admin debug: includes suppressed rows + full diagnostics.
  app.get("/api/admin/mlb/pregame-power-radar/debug", requireAdmin, async (_req, res) => {
    try {
      const { getRadarSnapshot } = await import("./mlb/pregamePowerRadar/pregamePowerRadarService");
      const { buildResponse } = await import("./mlb/pregamePowerRadar/diagnostics");
      const { getPregameOutcomeSummary } = await import("./mlb/pregamePowerRadar/shadowOutcomes");
      const { todayET } = await import("./utils/dateUtils");
      const { snapshot, source } = await getRadarSnapshot();
      if (!snapshot) {
        return res.json({
          date: todayET(), buildId: "", generatedAt: "", source, gamesScanned: 0,
          signals: [], diagnostics: { lineupCoverage: 0, weatherCoverage: 0, batterCoverage: 0, pitcherCoverage: 0, totalBattersEvaluated: 0, publicSignals: 0, suppressedSignals: 0, topSuppressionReasons: [] },
        });
      }
      const signals = Array.from(snapshot.signals.values());
      const resp = buildResponse(snapshot.sessionDate, snapshot.buildId, snapshot.generatedAt, source, signals, {
        gamesScanned: snapshot.gamesScanned, battersEvaluated: snapshot.battersEvaluated,
        ...snapshot.coverage,
      }, true);
      return res.json({ ...resp, outcomeSummary: getPregameOutcomeSummary() });
    } catch (err) {
      console.error("[admin/mlb/pregame-power-radar/debug]", err);
      return res.status(500).json({ error: "Failed to fetch pre-game power radar debug" });
    }
  });

  // Public: confirmed-lineup, non-suppressed targets for today's slate.
  app.get("/api/mlb/pregame-power-radar", requireMLBAccess, async (_req, res) => {
    try {
      const { getRadarSnapshot } = await import("./mlb/pregamePowerRadar/pregamePowerRadarService");
      const { buildResponse } = await import("./mlb/pregamePowerRadar/diagnostics");
      const { todayET } = await import("./utils/dateUtils");
      const { snapshot, source } = await getRadarSnapshot();
      if (!snapshot) {
        return res.json({
          date: todayET(), buildId: "", generatedAt: "", source, gamesScanned: 0,
          signals: [], diagnostics: { lineupCoverage: 0, weatherCoverage: 0, batterCoverage: 0, pitcherCoverage: 0, totalBattersEvaluated: 0, publicSignals: 0, suppressedSignals: 0, topSuppressionReasons: [] },
        });
      }
      const signals = Array.from(snapshot.signals.values());
      return res.json(buildResponse(snapshot.sessionDate, snapshot.buildId, snapshot.generatedAt, source, signals, {
        gamesScanned: snapshot.gamesScanned, battersEvaluated: snapshot.battersEvaluated,
        ...snapshot.coverage,
      }, false));
    } catch (err) {
      console.error("[mlb/pregame-power-radar]", err);
      return res.status(500).json({ error: "Failed to fetch pre-game power radar" });
    }
  });

  // Public: one game's confirmed-lineup targets.
  app.get("/api/mlb/pregame-power-radar/:gameId", requireMLBAccess, async (req, res) => {
    try {
      const { getRadarSnapshot } = await import("./mlb/pregamePowerRadar/pregamePowerRadarService");
      const { buildResponse } = await import("./mlb/pregamePowerRadar/diagnostics");
      const { todayET } = await import("./utils/dateUtils");
      const gameId = String(req.params.gameId);
      const { snapshot, source } = await getRadarSnapshot();
      if (!snapshot) {
        return res.json({
          date: todayET(), buildId: "", generatedAt: "", source, gamesScanned: 0,
          signals: [], diagnostics: { lineupCoverage: 0, weatherCoverage: 0, batterCoverage: 0, pitcherCoverage: 0, totalBattersEvaluated: 0, publicSignals: 0, suppressedSignals: 0, topSuppressionReasons: [] },
        });
      }
      const signals = Array.from(snapshot.signals.values()).filter((s) => s.gameId === gameId);
      return res.json(buildResponse(snapshot.sessionDate, snapshot.buildId, snapshot.generatedAt, source, signals, {
        gamesScanned: 1, battersEvaluated: signals.length, ...snapshot.coverage,
      }, false));
    } catch (err) {
      console.error("[mlb/pregame-power-radar/:gameId]", err);
      return res.status(500).json({ error: "Failed to fetch pre-game power radar for game" });
    }
  });

  app.get("/api/admin/signal-lifecycle/:signalId", requireAdmin, async (req, res) => {
    try {
      const { getCanonical } = await import("./services/lifecycleStore");
      const sig = getCanonical(String(req.params.signalId));
      if (!sig) return res.status(404).json({ error: "signalId not found" });
      return res.json({
        signalId: sig.signalId,
        sport: sig.sport,
        actor: sig.actorName,
        market: sig.market,
        side: sig.side,
        signalTier: sig.signalTier,
        signalScore: sig.signalScore,
        displayProbability: sig.displayProbability,
        lifecycleState: sig.lifecycleState,
        lifecycleHistory: sig.lifecycleHistory,
        surfacedAt: sig.surfacedAt,
        updatedAt: sig.updatedAt,
        expiresAt: sig.expiresAt,
        suppressionReason: sig.suppressionReason ?? null,
        expirationReason: sig.expirationReason ?? null,
        gradingLink: sig.gradingLink ?? null,
        sourceRef: sig.sourceRef ?? null,
      });
    } catch (err) {
      console.error("[admin/signal-lifecycle get]", err);
      return res.status(500).json({ error: "Failed to fetch signal lifecycle" });
    }
  });

  app.get("/api/admin/lifecycle-metrics", requireAdmin, async (_req, res) => {
    try {
      const metrics = await storage.getLifecycleMetrics();
      return res.json(metrics);
    } catch (err) {
      console.error("[admin/lifecycle-metrics]", err);
      return res.status(500).json({ error: "Failed to fetch lifecycle metrics" });
    }
  });

  app.get("/api/admin/users", requireAdmin, async (_req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      return res.json(allUsers);
    } catch (err) {
      console.error("[admin/users]", err);
      return res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.patch("/api/admin/users/:id/tier", requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(String(req.params.id), 10);
      const { tier } = req.body as { tier: string | null };
      if (tier !== null && tier !== "all" && tier !== "elite") {
        return res.status(400).json({ error: "Invalid tier. Use null, 'all', or 'elite'" });
      }
      await storage.setUserSubscriptionTier(userId, tier);
      console.log("[ADMIN] Tier written:", { userId, tier, timestamp: new Date().toISOString() });
      return res.json({ success: true });
    } catch (err) {
      console.error("[admin/tier]", err);
      return res.status(500).json({ error: "Failed to update tier" });
    }
  });

  app.patch("/api/admin/users/:id/reset-plays", requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(String(req.params.id), 10);
      await storage.resetUserPlays(userId);
      return res.json({ success: true });
    } catch (err) {
      console.error("[admin/reset-plays]", err);
      return res.status(500).json({ error: "Failed to reset plays" });
    }
  });

  // ── Admin: Change tier with Stripe integration ──────────────────────────────
  // STRIPE AUDIT
  // Client: getUncachableStripeClient() via Replit Connector — no STRIPE_SECRET_KEY env var
  // Existing calls: checkout.sessions, billingPortal.sessions, products/prices (setup-products)
  // Price IDs (env: STRIPE_PRO_PRICE_ID for all=$40, STRIPE_ALL_SPORTS_PRICE_ID for elite=$65)
  // User schema: subscriptionTier (null/"all"/"elite"), stripeCustomerId, stripeSubscriptionId, playsUsed
  // Storage: setUserSubscriptionTier, updateUserStripeCustomer, resetUserPlays
  // stripeCustomerId: yes, on user object

  const ADMIN_TIER_PRICES: Record<string, { label: string; pricePerMonth: number; stripePriceId: string | null }> = {
    "":      { label: "Free",                pricePerMonth: 0,  stripePriceId: null },
    "all":   { label: "Pro ($40/mo)",        pricePerMonth: 40, stripePriceId: process.env.STRIPE_PRO_PRICE_ID        || "price_1TJJ4M2ceUNmv10tYSsYXA6T" },
    "elite": { label: "All Sports ($65/mo)", pricePerMonth: 65, stripePriceId: process.env.STRIPE_ALL_SPORTS_PRICE_ID || "price_1TJJ4M2ceUNmv10tB8JCzPYe" },
  };

  app.post("/api/admin/change-tier", requireAdmin, async (req, res) => {
    try {
      const { userId, newTierKey } = req.body as { userId: number; newTierKey: string };
      if (typeof userId !== "number" || !Number.isInteger(userId)) {
        return res.status(400).json({ error: "Invalid userId" });
      }
      if (!Object.keys(ADMIN_TIER_PRICES).includes(newTierKey)) {
        return res.status(400).json({ error: "Invalid tier. Use '', 'all', or 'elite'" });
      }

      const user = await storage.getUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      const tierMeta = ADMIN_TIER_PRICES[newTierKey]!;
      const currentTierMeta = ADMIN_TIER_PRICES[user.subscriptionTier ?? ""] ?? ADMIN_TIER_PRICES[""];
      const priceDiff = tierMeta.pricePerMonth - currentTierMeta.pricePerMonth;

      // If downgrading to free AND user has an active Stripe subscription, cancel it gracefully
      if (newTierKey === "" && user.stripeCustomerId) {
        try {
          const { getUncachableStripeClient } = await import("./stripeClient");
          const stripe = await getUncachableStripeClient();
          const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "active" });
          for (const sub of subs.data) {
            await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
          }
        } catch (stripeErr: any) {
          console.warn("[ADMIN] Stripe cancel skipped (non-fatal):", stripeErr.message);
        }
      }

      // Always update DB directly — admin overrides do not require Stripe price IDs
      await storage.setUserSubscriptionTier(userId, newTierKey === "" ? null : newTierKey);
      console.log("[ADMIN] change-tier written:", { userId, newTierKey, priceDiff, timestamp: new Date().toISOString() });

      if (priceDiff > 0) {
        await storage.resetUserPlays(userId);
        await storage.setUpgradedAt(userId, new Date().toISOString());
      }

      const message = newTierKey === ""
        ? "Downgraded to Free."
        : priceDiff > 0
        ? `Upgraded to ${tierMeta.label}.`
        : `Tier updated to ${tierMeta.label}.`;

      return res.json({ message });
    } catch (err: any) {
      console.error("[admin/change-tier]", err.message);
      return res.status(500).json({ error: err.message || "Failed to change tier" });
    }
  });

  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    try {
      const requestingUserId = (req as any).resolvedUserId!;
      const targetUserId = parseInt(String(req.params.id), 10);
      if (targetUserId === requestingUserId) {
        return res.status(400).json({ error: "Cannot delete your own account" });
      }
      const target = await storage.getUserById(targetUserId);
      if (!target) return res.status(404).json({ error: "User not found" });
      if (target.isAdmin) return res.status(403).json({ error: "Cannot delete admin accounts" });
      await storage.deleteUser(targetUserId);
      return res.json({ success: true });
    } catch (err) {
      console.error("[admin/delete-user]", err);
      return res.status(500).json({ error: "Failed to delete user" });
    }
  });

  // ── Admin: Debug user Stripe state ──────────────────────────────────────────
  app.get("/api/admin/debug-user/:id", requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(String(req.params.id), 10);
      const user = await storage.getUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      let stripeInfo: any = null;
      if (user.stripeCustomerId) {
        try {
          const { getUncachableStripeClient } = await import("./stripeClient");
          const stripe = await getUncachableStripeClient();
          const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "all", limit: 5 });
          stripeInfo = subs.data.map((s: any) => ({
            subscriptionId: s.id,
            status: s.status,
            priceId: s.items.data[0]?.price?.id ?? null,
          }));
        } catch (stripeErr: any) {
          stripeInfo = { error: stripeErr.message };
        }
      }

      return res.json({
        userId: user.id,
        email: user.email,
        plan: user.subscriptionTier ?? null,
        stripeCustomerId: user.stripeCustomerId ?? null,
        stripeSubscriptionId: user.stripeSubscriptionId ?? null,
        stripeSubscriptions: stripeInfo,
      });
    } catch (err: any) {
      console.error("[admin/debug-user]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/nba-bias", requireAdmin, (_req, res) => {
    return res.json(getDirectionalSplit());
  });

  // Freshness Integrity Fix #7 — admin diagnostic for the MLB live pipeline.
  // Lets admins confirm cache freshness, signal counts, and active games at a
  // glance. No engine recompute is triggered; pure read of in-memory state.
  app.get("/api/admin/mlb-live-debug", requireAdmin, async (_req, res) => {
    try {
      const games = getActiveGames();
      const now = Date.now();
      const edgeEntries = Array.from(mlbEdgeCache.entries()).map(([gameId, entry]) => ({
        gameId,
        updatedAt: entry.updatedAt,
        ageSec: entry.updatedAt ? Math.round((now - entry.updatedAt) / 1000) : null,
        createdAt: entry.createdAt,
        outputs: entry.outputs?.length ?? 0,
        qualifiedSignals: entry.qualifiedSignals?.length ?? 0,
        allSignals: entry.allSignals?.length ?? 0,
        isDegraded: entry.isDegraded ?? false,
        signalLocked: entry.signalLocked ?? false,
        tags: entry.gameCardTags ?? [],
      }));

      return res.json({
        now,
        activeGames: games.length,
        games: games.map((g) => ({
          gameId: g.gameId,
          gamePk: g.gamePk,
          status: (g as any).espnStatus ?? null,
          startTime: (g as any).startTime ?? null,
        })),
        edgeEntries,
      });
    } catch (e: any) {
      console.error("[admin/mlb-live-debug]", e.message);
      return res.status(500).json({ error: "Failed to fetch MLB live debug snapshot" });
    }
  });

  // Admin MLB Engine Debug — exposes the entire signal pipeline for visibility.
  // Read-only snapshot of in-memory engine state + diagnostics ring buffers.
  // Never recomputes engine math, never surfaces to non-admin users.
  app.get("/api/admin/mlb/engine-debug", requireAdmin, async (req, res) => {
    try {
      const now = Date.now();
      const selectedGameId = (req.query.gameId as string | undefined) ?? null;
      const games = getActiveGames();

      const edgeEntries = Array.from(mlbEdgeCache.entries()).map(([gameId, entry]) => ({
        gameId,
        ageSec: entry.updatedAt ? Math.round((now - entry.updatedAt) / 1000) : null,
        qualifiedSignals: entry.qualifiedSignals?.length ?? 0,
        allSignals: entry.allSignals?.length ?? 0,
        outputs: entry.outputs?.length ?? 0,
        isDegraded: entry.isDegraded ?? false,
        signalLocked: entry.signalLocked ?? false,
        tags: entry.gameCardTags ?? [],
      }));

      // Aggregate pipeline counts. If a specific game is selected, scope
      // pipeline counts to that game; otherwise aggregate across all games.
      const scopedEntries = selectedGameId
        ? edgeEntries.filter((e) => e.gameId === selectedGameId)
        : edgeEntries;
      const rawSignalCount = scopedEntries.reduce((s, e) => s + e.allSignals, 0);
      const qualifiedSignalCount = scopedEntries.reduce((s, e) => s + e.qualifiedSignals, 0);
      const suppressedCount = Math.max(0, rawSignalCount - qualifiedSignalCount);

      // Persistence section.
      const today = todayET();
      let persistedTodayCount = 0;
      let pendingPlayCount = 0;
      try {
        const { plays: todayPlays } = await storage.getPlays({ sport: "mlb", date: today, limit: 500 });
        persistedTodayCount = todayPlays.length;
        pendingPlayCount = todayPlays.filter((p: any) => !p.result || p.result === "pending").length;
      } catch (err) {
        console.warn("[admin/mlb/engine-debug] persistence summary failed:", (err as any)?.message);
      }

      // Top plays count — derived from current MLB cache (orchestrator output).
      // We deliberately do NOT recompute via buildTopPlays here; this is just a
      // visibility figure showing how many qualified MLB rows exist right now.
      const topPlaysCount = qualifiedSignalCount;

      // Diagnostics ring buffer reads.
      const diag = await import("./mlb/diagnosticsBuffer");
      const counts = diag.getDiagnosticsCounts(10 * 60 * 1000);
      const recentHrWatchDetections = diag.getHrWatchDetections(20).map((r) => ({
        ts: r.ts, player: r.player, market: r.market, signalTier: r.signalTier,
        ev: r.ev, la: r.la, drivers: r.drivers,
      }));
      const recentHrWatchSuppressed = diag.getHrWatchSuppressed(20).map((r) => ({
        ts: r.ts, player: r.player, market: r.market, reason: r.reason,
      }));
      const recentPersistRejects = diag.getPersistRejects(20).map((r) => ({
        ts: r.ts, reason: r.reason, player: r.player, market: r.market,
      }));
      // Phase 3 — market calibration audit reads.
      const recentHrrCalibrations = diag.getHrrCalibrations(20).map((r) => ({
        ts: r.ts, player: r.player, rawProbability: r.rawProbability,
        adjustedProbability: r.adjustedProbability, capApplied: r.capApplied,
        usedTbFallback: r.usedTbFallback, reason: r.reason,
      }));
      const recentHitsAllowedCalibrations = diag.getHitsAllowedCalibrations(20).map((r) => ({
        ts: r.ts, pitcher: r.pitcher, side: r.side, rawProbability: r.rawProbability,
        adjustedProbability: r.adjustedProbability, fallbackUsed: r.fallbackUsed,
      }));
      const recentHrWatchContextUses = diag.getHrWatchContextUses(20).map((r) => ({
        ts: r.ts, player: r.player, market: r.market, nearHrCount: r.nearHrCount,
        contactScore: r.contactScore, affectedSignalScore: r.affectedSignalScore,
        affectedProbability: r.affectedProbability, signalTier: r.signalTier,
      }));
      const recentSelfLearningCalibrations = diag.getSelfLearningCalibrations(20);
      const recentCapsApplied = diag.getCapsApplied(20);

      // Empty-state reason resolver — admin sees the SPECIFIC cause.
      let emptyStateReason: string | null = null;
      const showsZero = qualifiedSignalCount === 0;
      if (showsZero) {
        if (games.length === 0) {
          emptyStateReason = "No active MLB games right now.";
        } else if (selectedGameId && !edgeEntries.some((e) => e.gameId === selectedGameId)) {
          emptyStateReason = `No engine cache entry yet for selected game ${selectedGameId} — engine has not run a cycle for this game.`;
        } else if (scopedEntries.length === 0) {
          emptyStateReason = "Engine has no cache entries — has not run a qualifying cycle yet.";
        } else if (rawSignalCount === 0) {
          emptyStateReason = "Engine ran but produced 0 raw signals — odds may be missing or markets not yet open.";
        } else if (qualifiedSignalCount === 0) {
          emptyStateReason = `Engine produced ${rawSignalCount} raw signals but ${suppressedCount} were filtered (below probability threshold, missing line, or stale odds).`;
        }
        const stale = scopedEntries.find((e) => e.ageSec != null && e.ageSec > 240);
        if (stale && !emptyStateReason) {
          emptyStateReason = `Cache entry for ${stale.gameId} is stale (${stale.ageSec}s old) — engine cycle delayed.`;
        }
      }

      return res.json({
        now,
        selectedGameId,
        activeGames: games.length,
        games: games.map((g) => ({
          gameId: g.gameId,
          status: (g as any).espnStatus ?? null,
          startTime: (g as any).startTime ?? null,
        })),
        edgeEntries,
        totals: {
          rawSignalCount,
          qualifiedSignalCount,
          suppressedCount,
          persistedTodayCount,
          pendingPlayCount,
          hrWatchDetectedCount: counts.hrWatchDetected,
          hrWatchSuppressedCount: counts.hrWatchSuppressed,
          persistRejectedCount: counts.persistRejected,
          topPlaysCount,
          // Phase 3 — market-calibration audit counters (10m window).
          hrrCalibrationCount: counts.hrrCalibrations,
          hitsAllowedCalibrationCount: counts.hitsAllowedCalibrations,
          selfLearningCalibrationCount: counts.selfLearningCalibrations,
          hrWatchContextUseCount: counts.hrWatchContextUses,
          capsAppliedCount: counts.capsApplied,
        },
        emptyStateReason,
        recentHrWatchDetections,
        recentHrWatchSuppressed,
        recentPersistRejects,
        // Phase 3 — recent calibration events for the admin debug panel.
        recentHrrCalibrations,
        recentHitsAllowedCalibrations,
        recentHrWatchContextUses,
        recentSelfLearningCalibrations,
        recentCapsApplied,
        semantics: {
          probability: "Phase 1 canonical — engine probability only; signalScore never substituted",
          tier: "Phase 2 lowercase 4-state (watch | lean | strong | elite)",
          calibrationVersion: diag.MLB_CALIBRATION_VERSION,
          phase3Note: "HRR uses TB-distribution fallback; hits_allowed uses normal-CDF fallback. Phase 3 logs every call so deferred market wrappers can be calibrated against real traffic.",
        },
      });
    } catch (e: any) {
      console.error("[admin/mlb/engine-debug]", e?.message ?? e);
      return res.status(500).json({ error: "Failed to build engine debug snapshot", detail: e?.message ?? String(e) });
    }
  });

  // Phase 8.4 — admin force-grade endpoint to re-run grader on demand for
  // ungraded plays. Body is optional; sport/gameId are accepted for future
  // scoping but the current grader processes all unsettled plays.
  app.post("/api/admin/force-grade", requireAdmin, async (req, res) => {
    try {
      const { sport, gameId } = (req.body ?? {}) as { sport?: string; gameId?: string };
      console.log(`[ADMIN_FORCE_GRADE] requested sport=${sport ?? "any"} gameId=${gameId ?? "any"}`);
      const { gradePersistedPlays } = await import("./services/gradePersistedPlays");
      const result = await gradePersistedPlays(storage);
      console.log(`[ADMIN_FORCE_GRADE] complete settled=${result.settled} failed=${result.failed} skipped=${result.skipped}`);
      return res.json({ ok: true, requested: { sport: sport ?? null, gameId: gameId ?? null }, ...result });
    } catch (e: any) {
      console.error("[admin/force-grade]", e?.message ?? e);
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/admin/odds-health", requireAdmin, async (_req, res) => {
    try {
      const { getOddsHealthSnapshot } = await import("./odds/oddsDiagnostics");
      const { getCacheSize, getCacheKeys, pruneExpired } = await import("./odds/oddsCache");
      const pruned = pruneExpired();
      return res.json({
        ...getOddsHealthSnapshot(),
        cache: { size: getCacheSize(), prunedNow: pruned, keys: getCacheKeys().slice(0, 50) },
      });
    } catch (e: any) {
      console.error("[admin/odds-health]", e.message);
      return res.status(500).json({ error: "Failed to fetch odds health" });
    }
  });

  app.get("/api/admin/roi", requireAdmin, async (req, res) => {
    try {
      const { buildFullROIReport } = await import("./services/roiEngine");
      const sport = req.query.sport as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;
      const plays = await storage.getAllSettledPlays({ sport, startDate, endDate });
      const report = buildFullROIReport(plays);
      return res.json(report);
    } catch (e: any) {
      console.error("[admin/roi]", e.message);
      return res.status(500).json({ error: "Failed to generate ROI report" });
    }
  });

  // ── Buyer Track Record — credibility view (read-only) ──────────────────────
  // Single source of truth for "what happened to every surfaced play". Reads
  // persisted_plays (the durable historical engine record) + the shadow store
  // (experimental, non-surfaced, MLB-only, session-scoped). NEVER mutates the
  // engine, bus, lifecycle, or any canonical field (CLAUDE.md §3.6).
  const trackRecordStartDate = (range: string): string => {
    if (range === "1d" || range === "today") return todayET();
    if (range === "7d") return daysAgoET(7);
    if (range === "30d") return daysAgoET(30);
    return ""; // "all"
  };

  app.get("/api/admin/track-record", requireAdmin, async (req, res) => {
    try {
      const sport = ((req.query.sport as string) || "all").toLowerCase();
      const market = (req.query.market as string) || "";
      const tier = ((req.query.tier as string) || "").toLowerCase();
      const range = ((req.query.range as string) || "all").toLowerCase();

      const { buildFullROIReport, normalizeTier } = await import("./services/roiEngine");
      const { getShadowSummary } = await import("./mlb/shadowQualification");
      const { MLB_GOLDMASTER_VERSION } = await import("./mlb/goldmasterGuard");

      const startDate = trackRecordStartDate(range);
      let plays = await storage.getPlaysInRange({
        sport: sport === "all" ? undefined : sport,
        startDate: startDate || undefined,
      });
      if (market) plays = plays.filter(p => p.market === market);
      if (tier) plays = plays.filter(p => normalizeTier(p.confidenceTier) === tier);

      const report = buildFullROIReport(plays as unknown as PersistedPlay[]);

      return res.json({
        filters: { sport, market: market || "all", tier: tier || "all", range },
        engineVersion: MLB_GOLDMASTER_VERSION,
        generatedAt: new Date().toISOString(),
        historical: {
          surfaced: plays.length,
          settled: report.global.totalBets,
          pending: report.global.pending,
          ...report,
        },
        shadow: getShadowSummary(),
      });
    } catch (e: any) {
      console.error("[admin/track-record]", e.message);
      return res.status(500).json({ error: "Failed to generate track record" });
    }
  });

  // RFC-4180-ish CSV serialization. No dependency added (do not edit package.json).
  const csvCell = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvRows = (rows: unknown[][]): string =>
    rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

  const TRACK_RECORD_CSV_HEADER = [
    "record_type", "signal_timestamp", "game_date", "sport", "player", "market",
    "direction", "line", "odds", "probability", "signal_tier", "signal_score",
    "engine_version", "result", "status", "final_stat", "profit_loss", "profit_loss_basis",
  ];

  app.get("/api/admin/track-record/export/historical.csv", requireAdmin, async (req, res) => {
    try {
      const sport = ((req.query.sport as string) || "all").toLowerCase();
      const market = (req.query.market as string) || "";
      const tier = ((req.query.tier as string) || "").toLowerCase();
      const range = ((req.query.range as string) || "all").toLowerCase();

      const { calculatePayout, normalizeTier } = await import("./services/roiEngine");
      const startDate = trackRecordStartDate(range);
      let plays = await storage.getPlaysInRange({
        sport: sport === "all" ? undefined : sport,
        startDate: startDate || undefined,
      });
      if (market) plays = plays.filter(p => p.market === market);
      if (tier) plays = plays.filter(p => normalizeTier(p.confidenceTier) === tier);

      const body = (plays as unknown as PersistedPlay[]).map(p => {
        // A "void" (DNP) result is terminal & financially neutral — the ROI
        // engine drops it from both settled and pending. Treat any non-null
        // result as terminal so the CSV never mislabels a void as pending.
        const financiallySettled = p.result === "hit" || p.result === "miss" || p.result === "push";
        const isVoid = p.result === "void";
        const terminal = p.result != null;
        const hasOdds = p.odds != null && Number.isFinite(Number(p.odds));
        return [
          "historical_engine",
          (p.timestamp ?? p.createdAt)?.toISOString?.() ?? "",
          p.gameDate ?? "",
          p.sport ?? "",
          p.playerName ?? "",
          p.market ?? "",
          p.direction ?? "",
          p.line ?? "",
          hasOdds ? p.odds : "",
          p.prob ?? "",
          p.confidenceTier ?? "untiered",
          p.signalScore ?? "",
          p.engineVersion ?? "unknown",
          p.result ?? "",
          terminal ? "settled" : "pending",
          p.finalStat ?? "",
          financiallySettled ? Math.round(calculatePayout(p) * 1000) / 1000 : isVoid ? 0 : "",
          financiallySettled ? (hasOdds ? "actual_odds" : "assumed_-110") : isVoid ? "void_no_action" : "",
        ];
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="livelocks-historical-track-record-${range}.csv"`,
      );
      return res.send(csvRows([TRACK_RECORD_CSV_HEADER, ...body]));
    } catch (e: any) {
      console.error("[admin/track-record/historical.csv]", e.message);
      return res.status(500).json({ error: "Failed to export historical track record" });
    }
  });

  app.get("/api/admin/track-record/export/shadow.csv", requireAdmin, async (req, res) => {
    try {
      const market = (req.query.market as string) || "";
      const range = ((req.query.range as string) || "all").toLowerCase();
      const { listShadowSignals } = await import("./mlb/shadowQualification");

      // Shadow ROI proxy at -110 vig (cashed=+0.909u, missed=-1u, push=0).
      const SHADOW_VIG_PAYOUT = 0.909;
      let records = listShadowSignals();
      if (market) records = records.filter(r => r.market === market);

      const body = records.map(r => {
        // "expired" (TTL reached without resolution) is terminal but has no
        // financial outcome — mirror the historical void handling so it is not
        // mislabeled as pending.
        const financiallySettled = r.outcome === "cashed" || r.outcome === "missed" || r.outcome === "push";
        const terminal = r.outcome != null && r.outcome !== "pending";
        const pl = r.outcome === "cashed" ? SHADOW_VIG_PAYOUT : r.outcome === "missed" ? -1 : r.outcome === "push" ? 0 : "";
        return [
          "shadow_experimental",
          new Date(r.qualifiedAt).toISOString(),
          "", // shadow store does not retain gameDate
          "mlb",
          r.playerName ?? "",
          r.market ?? "",
          r.side ?? "",
          r.bookLine ?? "",
          "", // no real odds
          r.probability ?? "",
          "", // no confidence tier
          r.signalScore ?? "",
          "shadow",
          r.outcome ?? "",
          terminal ? "settled" : "pending",
          "", // final stat not retained on shadow record
          pl,
          financiallySettled ? "shadow_proxy_-110" : "",
        ];
      });

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="livelocks-shadow-track-record-${range}.csv"`,
      );
      return res.send(csvRows([TRACK_RECORD_CSV_HEADER, ...body]));
    } catch (e: any) {
      console.error("[admin/track-record/shadow.csv]", e.message);
      return res.status(500).json({ error: "Failed to export shadow track record" });
    }
  });

  app.get("/api/recent-results", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      
      if (!user?.isAdmin) {
        return res.status(403).json({ error: "Admin only" });
      }
      
      const results = await storage.getRecentGradedSignals(20);
      const safe = results.map(p => ({
        id: p.id,
        playerName: p.playerName,
        team: p.team,
        sport: p.sport,
        market: p.market,
        direction: p.direction,
        line: p.line,
        prob: p.prob,
        result: p.result,
        finalStat: p.finalStat,
        gameDate: p.gameDate,
        settledAt: p.settledAt,
        confidenceTier: p.confidenceTier,
      }));
      return res.json({ results: safe });
    } catch (e: any) {
      console.error("[recent-results]", e.message);
      return res.json({ results: [] });
    }
  });

  app.post("/api/signal-interaction", requireAuth, async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user?.id) return res.status(401).json({ error: "Not authenticated" });
      const { signalId, action, sport, market } = req.body;
      if (!action) return res.status(400).json({ error: "action is required" });
      await storage.recordSignalInteraction({
        userId: user.id,
        signalId: signalId ?? undefined,
        action,
        sport: sport ?? undefined,
        market: market ?? undefined,
      });
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[signal-interaction]", e.message);
      return res.status(500).json({ error: "Failed to record interaction" });
    }
  });

  // ── NCAAB Routes (Pro "all" + Elite "elite" + Admin) ────────────────────────
  app.get("/api/ncaab/plays", requireTier("all", "elite"), async (_req, res) => {
    try {
      const plays = await computeNCAABPlays();
      const now = Date.now();
      const MAX_ENGINE_AGE_MS = 30_000;
      const freshPlays = plays.filter(play => {
        if (!play.engineGeneratedAt) return true;
        if ((now - play.engineGeneratedAt) > MAX_ENGINE_AGE_MS) {
          console.warn(`[NCAAB STALE] Dropping stale play for ${play.gameId} — ${((now - play.engineGeneratedAt) / 1000).toFixed(0)}s old`);
          return false;
        }
        return true;
      });

      if (process.env.DEBUG_PIPELINE === "true") {
        for (const play of freshPlays) {
          console.log(`[PIPELINE][NCAAB][${play.gameId}] engineOutput: line=${play.total} proj=${play.engineOutput?.projectedTotal ?? null} side=${play.engineOutput?.recommendedSide ?? null} prob=${play.engineOutput?.displayProbability ?? null} markets=${JSON.stringify(play.engineOutput?.marketVerdicts ?? [])}`);
        }
      }

      // ─── Engine stats observability ──────────────────────────────────────
      const ncaabEngineStart = Date.now();
      console.log(`[ENGINE START][NCAAB] games=${freshPlays.length}`);
      const ncaabValidationAcc = { skipped: 0, failureReasons: [] as string[] };
      const ncaabOutputAcc = { rejected: 0, rejectionReasons: [] as string[] };
      const ncaabRawOutputs = freshPlays.map((p) => {
        // Phase 13/17: Timing gate — only generate signals at halftime or < 5 min remaining
        // NCAABPlay exposes bettingWindow ("HALFTIME" | "LATE_WINDOW" | "1H_WINDOW" | "NONE")
        const bettingWindow = (p as any).bettingWindow as string | undefined;
        const timingValid = bettingWindow === "HALFTIME" || bettingWindow === "LATE_WINDOW";
        if (!timingValid) console.log(`[TIMING GATE][NCAAB] Suppressed game=${p.gameId} bettingWindow=${bettingWindow ?? "unknown"}`);
        const isDerived = !p.total;
        // Phase 4: lineSource from engine output or inferred from derivedLine flag
        const lineSource: "sportsbook" | "inferred" | "derived" =
          p.engineOutput?.lineSource ?? (isDerived ? "derived" : "sportsbook");
        console.log(`[NCAAB LINE SOURCE] game=${p.gameId} type=${lineSource} timingValid=${timingValid}`);
        const input = buildEngineInput({
          gameId: p.gameId ?? "",
          sport: "ncaab",
          teamId: p.homeTeam ?? p.awayTeam ?? undefined,
          marketType: "total",
          line: p.total ?? null,
          derivedLine: isDerived,
          lineSource,
          context: {
            score: { home: p.homeScore ?? 0, away: p.awayScore ?? 0 },
          },
        });
        const line = input.line;
        const projection = p.engineOutput?.projectedTotal ?? null;
        // Apply confidence penalty when derivedLine — reduce probability toward 50 (neutral)
        const rawProb = typeof p.engineOutput?.displayProbability === "number" ? p.engineOutput.displayProbability : null;
        const penalizedProb = rawProb != null
          ? 50 + (rawProb - 50) * input.confidencePenalty
          : null;
        const prob = penalizedProb != null ? penalizedProb / 100 : null;
        const edge = penalizedProb != null ? Math.abs(penalizedProb - 50) / 100 : null;
        const side = (p.engineOutput?.recommendedSide === "UNDER" ? "UNDER" : "OVER") as "OVER" | "UNDER";
        // Phase 7: compute confidence tier from probability
        const probPct = penalizedProb ?? 50;
        const confidenceTier = probPct >= 75 && !isDerived ? "ELITE" as const
          : probPct >= 65 ? "STRONG" as const
          : probPct >= 55 ? "LEAN" as const
          : "NO_EDGE" as const;
        console.log(`[ENGINE INPUT][NCAAB] game=${p.gameId} line=${line} proj=${projection} prob=${rawProb} penalizedProb=${penalizedProb} edge=${edge} derivedLine=${isDerived} lineSource=${lineSource} confidence=${confidenceTier}`);
        // Sport-isolation drift trace (additive observability, no behavior change).
        emitDriftTrace("ncaab", {
          engineOwner: "route_inline:routes.ts:NCAAB-tier",
          routeOwner: "GET /api/ncaab-signals",
          oddsSource: lineSource ?? "unknown",
          confidenceSource: "route_inline",
          fallbackPath: isDerived ? "consensus_only" : "none",
          thresholdSource: "route_inline:routes.ts:513",
          staleHandling: isDerived ? "derived" : "n/a",
          gameId: p.gameId ?? undefined,
          edge: edge ?? undefined,
          probability: typeof penalizedProb === "number" ? penalizedProb : undefined,
          confidenceTier,
        });
        return {
          id: p.gameId ?? "",
          sport: "ncaab" as const,
          market: "total",
          team: p.homeTeam ?? p.awayTeam ?? undefined,
          playerName: p.gameId ?? "",
          gameId: p.gameId ?? "",
          line,
          projection,
          probability: prob,
          edge,
          recommendedSide: side,
          confidence: confidenceTier,
          sportsbook: "consensus",
          derivedLine: isDerived,
          lineSource,
          signalTimestamp: input.createdAt,
          timingValid,
          createdAt: input.createdAt,
        };
      });
      // Phase 3+8: validate output consistency before signal promotion
      const ncaabConsistentOutputs = filterValidEngineOutputs(ncaabRawOutputs, ncaabOutputAcc);
      // Convert to EngineSignal shape for filterValidSignals
      const ncaabEngineSignals = ncaabConsistentOutputs.map(({ playerName: _pn, gameId: _gid, ...rest }) => rest);
      const validNcaabEngineSignals = filterValidSignals(ncaabEngineSignals, ncaabValidationAcc);
      const validNcaabGameIds = new Set(validNcaabEngineSignals.map((s) => s.id));
      const validatedPlays = freshPlays.filter((p) => validNcaabGameIds.has(p.gameId ?? ""));
      for (const sig of validNcaabEngineSignals) console.log(`[ENGINE OUTPUT VALID][NCAAB] game=${sig.id} line=${sig.line} proj=${sig.projection} sportsbook=${sig.sportsbook}`);
      if (ncaabValidationAcc.skipped > 0) console.warn(`[ENGINE OUTPUT SKIPPED][NCAAB] count=${ncaabValidationAcc.skipped} reasons=${ncaabValidationAcc.failureReasons.join("; ")}`);
      if (ncaabOutputAcc.rejected > 0) console.warn(`[ENGINE OUTPUT SKIPPED][NCAAB] outputValidation rejected=${ncaabOutputAcc.rejected} reasons=${ncaabOutputAcc.rejectionReasons.join("; ")}`);
      // Phase 10: tally lineSource distribution across all NCAAB plays
      const ncaabLineSources = ncaabRawOutputs.map((o) => (o as any).lineSource ?? "sportsbook");
      const ncaabDerivedCount = ncaabLineSources.filter((s: string) => s === "derived").length;
      const ncaabInferredCount = ncaabLineSources.filter((s: string) => s === "inferred").length;
      recordEngineRun("ncaab", {
        gamesProcessed: freshPlays.length,
        signalsGenerated: validNcaabEngineSignals.length,
        signalsSkipped: ncaabValidationAcc.skipped,
        rejectedSignals: ncaabOutputAcc.rejected,
        rejectionReasons: ncaabOutputAcc.rejectionReasons,
        failureReasons: ncaabValidationAcc.failureReasons,
        latencyMs: Date.now() - ncaabEngineStart,
        lineSource: ncaabDerivedCount > 0 ? "derived" : ncaabInferredCount > 0 ? "inferred" : "sportsbook",
      });

      // Phase 16: Signal Priority Engine — rank NCAAB plays by probability then edge, max 10 global
      const MAX_NCAAB_SIGNALS = 10;
      const prioritizedNcaabPlays = [...validatedPlays]
        .sort((a, b) => {
          const probA = parseFloat(String(a.engineOutput?.displayProbability ?? "50")) || 50;
          const probB = parseFloat(String(b.engineOutput?.displayProbability ?? "50")) || 50;
          return Math.abs(probB - 50) - Math.abs(probA - 50);
        })
        .slice(0, MAX_NCAAB_SIGNALS);
      console.log(`[SIGNAL PRIORITY][NCAAB] before=${validatedPlays.length} after=${prioritizedNcaabPlays.length}`);

      res.json({ plays: prioritizedNcaabPlays });
      checkAndSendAlerts({ sport: "ncaab", plays: freshPlays }, storage).catch(console.warn);

      const ncaabTopPlaySignals: any[] = [];
      for (const p of prioritizedNcaabPlays) {
        const eo = p.engineOutput;
        if (!eo?.markets) continue;
        const mktKeys = ["full_total", "full_spread", "h1_total", "h1_spread", "h2_total", "h2_spread"] as const;
        for (const key of mktKeys) {
          const mkt = (eo.markets as any)[key];
          if (!mkt?.available || mkt.modelProb == null) continue;
          if (Math.abs((mkt.modelProb ?? 50) - 50) < 5) continue;
          const isSpreadMkt = key.includes("spread");
          const displaySide = isSpreadMkt
            ? (mkt.side === "HOME" ? "HOME" : mkt.side === "AWAY" ? "AWAY" : "OVER")
            : (mkt.side === "UNDER" ? "UNDER" : "OVER");
          ncaabTopPlaySignals.push({
            gameId: p.gameId,
            teamName: `${p.awayTeamAbbr ?? p.awayTeam} @ ${p.homeTeamAbbr ?? p.homeTeam}`,
            market: key,
            probability: mkt.modelProb,
            edge: mkt.edge ?? 0,
            line: mkt.bookLine ?? null,
            projection: mkt.projection ?? null,
            side: displaySide,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      ncaabLiveSignals.signals = ncaabTopPlaySignals;
      ncaabLiveSignals.updatedAt = Date.now();

      for (const p of prioritizedNcaabPlays) {
        const eo = p.engineOutput;
        if (!eo) continue;
        const mkts = eo.markets;
        if (!mkts) continue;
        const MARKET_KEYS = ["full_total", "full_spread", "h1_total", "h1_spread", "h2_total", "h2_spread"] as const;
        for (const key of MARKET_KEYS) {
          const mkt = (mkts as any)[key];
          if (!mkt?.available) continue;
          if (mkt.modelProb == null || Math.abs((mkt.modelProb ?? 50) - 50) < 5) continue;
          if (mkt.bookLine == null || !Number.isFinite(mkt.bookLine)) continue;
          const isSpread = key.includes("spread");
          const dir = isSpread
            ? (mkt.side === "AWAY" ? "under" : "over")
            : (mkt.side === "UNDER" ? "under" : "over");
          trackPlay({
            gameId: p.gameId ?? "",
            playerId: null,
            playerName: `${p.awayTeamAbbr ?? p.awayTeam} @ ${p.homeTeamAbbr ?? p.homeTeam}`,
            team: null,
            sport: "ncaab",
            market: key,
            direction: dir as "over" | "under",
            line: Number(mkt.bookLine),
            projection: Number(mkt.projection ?? mkt.bookLine),
            probability: Number(mkt.modelProb ?? 0),
            edge: mkt.edge != null ? Number(mkt.edge) : 0,
            sportsbook: mkt.sportsbook ?? "consensus",
            derivedLine: mkt.isDerived === true,
            createdAt: Date.now(),
          }, storage).catch(console.warn);
        }
      }
    } catch (err: any) {
      console.error("[NCAAB plays]", err.message);
      return res.status(500).json({ error: err.message || "NCAAB service error" });
    }
  });

  app.get("/api/ncaab/games", requireTier("all", "elite"), async (_req, res) => {
    try {
      const games = await getNCAABScoreboard();
      return res.json({ games });
    } catch (err: any) {
      console.error("[NCAAB games]", err.message);
      return res.status(500).json({ error: err.message || "Failed to fetch NCAAB scoreboard" });
    }
  });

  app.get("/api/ncaab/h2h", requireTier("all", "elite"), async (req, res) => {
    try {
      const gameId = req.query.gameId as string;
      if (!gameId) return res.status(400).json({ error: "gameId required" });
      const games = await getNCAABH2H(gameId);
      return res.json({ games });
    } catch (err: any) {
      console.error("[NCAAB H2H]", err.message);
      return res.json({ games: [] });
    }
  });

  app.get("/api/ncaab/chip-odds", requireTier("all", "elite"), async (req, res) => {
    try {
      const gameId = String(req.query.gameId ?? "");
      if (!gameId) return res.status(400).json({ error: "gameId required" });
      const data = await getNCAABChipOdds(gameId);
      return res.json(data);
    } catch (err: any) {
      console.error("[NCAAB chip-odds]", err.message);
      return res.json({ overUnder: null, homeWinPct: null, spreadDetails: null });
    }
  });

  app.get("/api/ncaab/enriched", requireTier("all", "elite"), async (req, res) => {
    try {
      const gameId = String(req.query.gameId ?? "");
      if (!gameId) return res.status(400).json({ error: "gameId required" });
      const games = await getNCAABScoreboard();
      const game = games.find((g: any) => g.id === gameId);
      if (!game) return res.status(404).json({ error: "Game not found" });
      const homeTeam: string = game.homeTeam ?? "";
      const awayTeam: string = game.awayTeam ?? "";
      const liveLine: number | null = typeof game.total === "number" ? game.total : null;
      const data = await enrichNCAABGameFull(gameId, homeTeam, awayTeam, liveLine, null);
      return res.json(data);
    } catch (err: any) {
      console.error("[NCAAB enriched]", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/ncaab/2h-lines", requireTier("all", "elite"), async (req, res) => {
    try {
      const gameId = String(req.query.gameId ?? "");
      if (!gameId) return res.status(400).json({ error: "gameId required" });
      const games = await getNCAABScoreboard();
      const game  = games.find((g: any) => g.id === gameId);
      if (!game) return res.json({ h2Total: null, source: null });
      const h1HomeScore = typeof req.query.h1HomeScore === "string" ? parseFloat(req.query.h1HomeScore) : 0;
      const h1AwayScore = typeof req.query.h1AwayScore === "string" ? parseFloat(req.query.h1AwayScore) : 0;
      const fullLine    = typeof req.query.fullLine === "string" ? parseFloat(req.query.fullLine) : null;
      const lines  = await fetch2HLines(gameId, game.homeTeam, h1HomeScore || 0, h1AwayScore || 0, fullLine);
      const engine = calc2HEngineProb(lines, h1HomeScore || 0, h1AwayScore || 0, null);
      return res.json({ lines, engine });
    } catch (err: any) {
      console.error("[NCAAB 2h-lines]", err.message);
      return res.json({ lines: { h2Total: null, source: null }, engine: null });
    }
  });

  app.post("/api/ncaab/admin/cache-clear", requireAdmin, async (_req, res) => {
    clearEnrichmentCache();
    const stats = getEnrichmentCacheStats();
    return res.json({ ok: true, stats });
  });

  app.get("/api/ncaab/live", requireTier("all", "elite"), async (_req, res) => {
    const findBestNcaabMarket = (mkts: any): { key: string } | null => {
      if (!mkts) return null;
      const keys = ["full_total", "full_spread", "h1_total", "h1_spread", "h2_total", "h2_spread"];
      let bestKey: string | null = null;
      let bestScore = -1;
      for (const key of keys) {
        const m = mkts[key];
        if (!m?.available || m.modelProb == null) continue;
        const absEdge = Math.abs(m.edge ?? 0);
        const probSignal = Math.abs((m.modelProb ?? 50) - 50);
        const score = absEdge > 0 ? absEdge : probSignal;
        if (score > bestScore) { bestScore = score; bestKey = key; }
      }
      return bestKey ? { key: bestKey } : null;
    };
    try {
      const plays = await computeNCAABPlays();
      const now = Date.now();
      const MAX_ENGINE_AGE_MS = 30_000;
      const freshPlays = plays.filter(p => {
        if (!p.engineGeneratedAt) return true;
        return (now - p.engineGeneratedAt) <= MAX_ENGINE_AGE_MS;
      });

      const periodFromKey = (key: string): "full_game" | "first_half" | "second_half" => {
        if (key.startsWith("h1_")) return "first_half";
        if (key.startsWith("h2_")) return "second_half";
        return "full_game";
      };
      const marketTypeFromKey = (key: string): "total" | "spread" | "team_total" => {
        if (key.includes("spread")) return "spread";
        if (key.includes("team")) return "team_total";
        return "total";
      };
      const sideFromMarket = (m: any, key: string): "OVER" | "UNDER" | "HOME" | "AWAY" | null => {
        if (!m) return null;
        if (key.includes("spread")) return m.side === "HOME" ? "HOME" : m.side === "AWAY" ? "AWAY" : null;
        return m.side === "UNDER" ? "UNDER" : m.side === "OVER" ? "OVER" : null;
      };

      const buildSelectedMarket = (m: any, key: string) => {
        const coverProb = m?.modelProb ?? null;
        const engineProb = m?.modelProb ?? null;
        const bookProb = m?.bookImpliedProb ?? null;
        const edge = m?.edge ?? null;
        const side = sideFromMarket(m, key);

        let confidenceLabel: string | null = null;
        if (coverProb !== null && side) {
          const absCover = Math.abs(coverProb - 50);
          const tier = absCover >= 25 ? "Strong" : absCover >= 15 ? "Moderate" : "Lean";
          const sideLabel = side === "OVER" || side === "UNDER" ? side.charAt(0) + side.slice(1).toLowerCase() : side;
          confidenceLabel = `${tier} ${sideLabel} EV`;
        }

        let signalTag: string | null = null;
        let signalDirection: "OVER" | "UNDER" | "HOME" | "AWAY" | null = null;
        if (edge !== null && Math.abs(edge) >= 5 && side) {
          const isSpread = key.includes("spread");
          const tagLabel = isSpread
            ? (side === "HOME" ? "Home" : "Away")
            : (side === "OVER" ? "Over" : "Under");
          signalTag = `${tagLabel} CLV`;
          signalDirection = side;
        }

        return {
          marketType: marketTypeFromKey(key),
          period: periodFromKey(key),
          side,
          line: m?.bookLine ?? null,
          coverProbability: coverProb,
          edge,
          confidenceLabel,
          engineProbability: engineProb,
          bookProbability: bookProb,
          signalTag,
          signalDirection,
          sportsbook: m?.sportsbook ?? null,
        };
      };

      const cards = freshPlays.map(play => {
        const mkts = play.engineOutput?.markets as any;
        const ftMarket = mkts?.full_total;

        const bestMarket = findBestNcaabMarket(mkts);
        const bm = bestMarket ? mkts[bestMarket.key] : null;
        const bmKey = bestMarket?.key ?? "full_total";

        const tierBadge = bm?.confidenceTier === "ELITE" ? "Elite"
          : bm?.confidenceTier === "STRONG" ? "Strong"
          : bm?.confidenceTier === "VALUE" ? "Value"
          : null;

        const periodLabel = play.bettingWindow === "HALFTIME" ? "HT"
          : `H${play.half}`;
        const liveTag = `LIVE • ${periodLabel} ${play.clock}`;

        const sportsbookCount = play.bookLines?.length ?? 0;

        const ftOverProb = ftMarket?.available && ftMarket.modelProb != null ? ftMarket.modelProb : null;
        const ftUnderProb = ftOverProb !== null ? Math.round((100 - ftOverProb) * 10) / 10 : null;

        const periodMarkets: Record<string, any> = {};
        for (const period of ["full", "h1", "h2"] as const) {
          const prefix = period === "h1" ? "h1_" : period === "h2" ? "h2_" : "full_";
          const totalMkt = mkts?.[`${prefix}total`];
          const spreadMkt = mkts?.[`${prefix}spread`];
          const activeMkt = (totalMkt?.available && totalMkt.modelProb != null) ? totalMkt
            : (spreadMkt?.available && spreadMkt.modelProb != null) ? spreadMkt
            : totalMkt;
          const activeKey = (totalMkt?.available && totalMkt.modelProb != null) ? `${prefix}total`
            : (spreadMkt?.available && spreadMkt.modelProb != null) ? `${prefix}spread`
            : `${prefix}total`;
          if (activeMkt?.available && activeMkt.modelProb != null) {
            periodMarkets[period] = buildSelectedMarket(activeMkt, activeKey);
          }
        }

        return {
          gameId: play.gameId,
          awayTeam: play.awayTeam,
          homeTeam: play.homeTeam,
          awayTeamAbbr: play.awayTeamAbbr,
          homeTeamAbbr: play.homeTeamAbbr,
          awayScore: play.awayScore,
          homeScore: play.homeScore,
          periodLabel,
          gameClock: play.clock,
          selectedMarket: buildSelectedMarket(bm, bmKey),
          fullGameTotal: {
            line: ftMarket?.bookLine ?? play.total ?? null,
            overProbability: ftOverProb,
            underProbability: ftUnderProb,
            sportsbookCount,
          },
          badges: {
            tierBadge,
            liveTag,
          },
          diagnostics: {
            oddsUpdatedAt: null,
            engineGeneratedAt: play.engineGeneratedAt ? new Date(play.engineGeneratedAt).toISOString() : null,
            dataFreshnessMs: play.engineGeneratedAt ? now - play.engineGeneratedAt : null,
            fallbackTriggered: false,
          },
          markets: mkts ? Object.fromEntries(
            Object.entries(mkts).map(([key, m]: [string, any]) => [key, {
              available: m?.available ?? false,
              marketKey: key,
              label: m?.label ?? key,
              sportsbook: m?.sportsbook ?? null,
              bookLine: m?.bookLine ?? null,
              projection: m?.projection ?? null,
              modelProb: m?.modelProb ?? null,
              bookImpliedProb: m?.bookImpliedProb ?? null,
              edge: m?.edge ?? null,
              side: m?.side ?? null,
              confidenceTier: m?.confidenceTier ?? "NONE",
            }])
          ) : {},
          periodMarkets,
          bettingWindow: play.bettingWindow,
          bettingWindowLabel: play.bettingWindowLabel,
        };
      });

      const topPlays = [...cards]
        .filter(c => c.selectedMarket.coverProbability !== null && Math.abs((c.selectedMarket.coverProbability ?? 50) - 50) >= 10)
        .sort((a, b) => Math.abs((b.selectedMarket.coverProbability ?? 50) - 50) - Math.abs((a.selectedMarket.coverProbability ?? 50) - 50))
        .slice(0, 3);

      return res.json({ cards, topPlays, updatedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error("[NCAAB live]", err.message);
      return res.status(500).json({ error: err.message || "NCAAB live error" });
    }
  });

  // ── MLB Live Routes (Auth-required, Phase B UI) ──────────────────────────────

  const mlbLiveGamesCache = new Map<string, { ts: number; games: any[] }>();
  const MLB_LIVE_GAMES_TTL = 15_000;

  // ── MLB preview player generator ─────────────────────────────────────────────
  // Derives preview cards from REAL game data only — no fabricated names/matchups.
  // Uses probable pitchers from scheduled/live games as the preview content shape.
  function generatePreviewPlayers(games: any[]): any[] {
    const previews: any[] = [];

    for (const game of games) {
      const matchup = `${game.awayAbbr || game.awayTeam} vs ${game.homeAbbr || game.homeTeam}`;
      const isLive = game.status === "live";

      // Add away probable pitcher if known (canonical field: pitcherAway)
      if (game.pitcherAway) {
        previews.push({
          playerName: game.pitcherAway,
          matchup,
          projection: "6.5+ K",
          tags: [
            game.awayPitcherHand === "L" ? "LHP" : game.awayPitcherHand === "R" ? "RHP" : "Pitcher",
            isLive ? "Live" : "Preview",
          ].filter(Boolean),
        });
      }

      // Add home probable pitcher if known and different from away (canonical field: pitcherHome)
      if (game.pitcherHome && game.pitcherHome !== game.pitcherAway) {
        previews.push({
          playerName: game.pitcherHome,
          matchup,
          projection: "6.5+ K",
          tags: [
            game.homePitcherHand === "L" ? "LHP" : game.homePitcherHand === "R" ? "RHP" : "Pitcher",
            isLive ? "Live" : "Preview",
          ].filter(Boolean),
        });
      }

      if (previews.length >= 6) break;
    }

    // If no pitcher data available, return safe game-level previews with no player names
    if (previews.length === 0) {
      for (const game of games.slice(0, 3)) {
        const matchup = `${game.awayAbbr || game.awayTeam} vs ${game.homeAbbr || game.homeTeam}`;
        previews.push({
          playerName: null,
          matchup,
          projection: "Edges Forming",
          tags: [game.status === "live" ? "Live" : "Preview"],
        });
      }
    }

    return previews.slice(0, 6);
  }

  app.get("/api/mlb/live-games", requireAuth, async (req, res) => {
    try { (await import("./services/liveSignalBus")).markLegacyConsumer("/api/mlb/live-games"); } catch {}
    const forceRefresh = req.query.force === "1";
    const cached = mlbLiveGamesCache.get("games");
    if (!forceRefresh && cached && Date.now() - cached.ts < MLB_LIVE_GAMES_TTL) {
      const games = cached.games;
      const hasAnyOdds = games.some((g: any) => g.hasOdds === true);
      if (!hasAnyOdds) {
        return res.json({ mode: "preview", games, previewPlayers: generatePreviewPlayers(games) });
      }
      return res.json({ mode: "live", games });
    }
    try {

      // ── Fetch from ESPN scoreboard ──
      // Use the same EST slate-date logic as NBA: before 6 AM EST show
      // yesterday's date so late-night games stay visible, after 6 AM
      // switch to today so stale "Final" games from yesterday drop off.
      // Also fetch the active (no-date) feed to catch any currently live
      // games that might fall outside the dated window.
      const espnDateStr = getESTSlateDate();
      const espnTodayUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${espnDateStr}`;
      const espnActiveUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard`;

      const todayRes = await fetch(espnTodayUrl, { headers: { "User-Agent": "LiveLocks/1.0" }, signal: AbortSignal.timeout(8000) });
      if (!todayRes.ok) throw new Error(`ESPN scoreboard ${todayRes.status}`);
      const todayData = (await todayRes.json()) as any;

      let activeData: any = { events: [] };
      try {
        const activeRes = await fetch(espnActiveUrl, { headers: { "User-Agent": "LiveLocks/1.0" }, signal: AbortSignal.timeout(8000) });
        if (activeRes.ok) activeData = await activeRes.json();
      } catch { /* active feed is supplementary — continue with today-only */ }

      const eventMap = new Map<string, any>();
      for (const event of todayData.events ?? []) {
        eventMap.set(String(event.id), event);
      }
      // Active-feed merge: only include events that are GENUINELY in-progress.
      // ESPN's no-date active feed also returns recently-completed games for
      // hours after they end, which would otherwise leak yesterday's finals
      // into today's slate (the duplicate matchup display bug).
      let activeMergedIn = 0;
      let activeStatusOverrides = 0;
      let activeRejectedFinal = 0;
      for (const event of activeData.events ?? []) {
        const eid = String(event.id);
        const activeStatusName: string =
          event.competitions?.[0]?.status?.type?.name ??
          event.status?.type?.name ??
          "";
        const isActiveLive = activeStatusName === "STATUS_IN_PROGRESS" || activeStatusName === "STATUS_DELAYED";
        if (!eventMap.has(eid)) {
          if (isActiveLive) {
            eventMap.set(eid, event);
            activeMergedIn++;
            console.log(`[MLB DISCOVERY] Active-feed live game ${eid} not in today's date feed — merged in (status=${activeStatusName})`);
          } else {
            activeRejectedFinal++;
            // Don't pollute today's slate with completed games from other dates.
          }
        } else {
          // Same gameId is in today's slate — refresh the status block in case
          // active feed has fresher info (e.g., live → final transition).
          const existing = eventMap.get(eid)!;
          const activeStatus = event.competitions?.[0]?.status ?? event.status;
          if (activeStatus) {
            if (existing.competitions?.[0]) existing.competitions[0].status = activeStatus;
            if (existing.status) existing.status = activeStatus;
            activeStatusOverrides++;
          }
        }
      }
      const mergedEvents = Array.from(eventMap.values());

      const rawEvents: number = mergedEvents.length;
      console.log(`[MLB DISCOVERY] live-games rawEvents=${rawEvents} (today=${todayData.events?.length ?? 0} active=${activeData.events?.length ?? 0} mergedInLive=${activeMergedIn} statusOverrides=${activeStatusOverrides} rejectedNonLive=${activeRejectedFinal})`);

      // ── Team name fallback chain: displayName → shortDisplayName → name ──
      const resolveTeamName = (team: any): string => {
        if (!team) return "";
        return (
          (team.displayName?.trim() || "") ||
          (team.shortDisplayName?.trim() || "") ||
          (team.name?.trim() || "") ||
          ""
        );
      }

      const games: any[] = [];
      for (const event of mergedEvents) {
        const competition = event.competitions?.[0];
        if (!competition) continue;

        const statusName: string = competition.status?.type?.name ?? event.status?.type?.name ?? "STATUS_SCHEDULED";
        const isLiveEspn = statusName === "STATUS_IN_PROGRESS" || statusName === "STATUS_DELAYED";
        const isFinal = statusName === "STATUS_FINAL" || statusName === "STATUS_FORFEIT";
        // Time-based fallback: if ESPN still shows SCHEDULED but start time has passed, treat as LIVE
        const gameStartMs = event.date ? new Date(event.date).getTime() : 0;
        const startedByTime = gameStartMs > 0 && Date.now() >= gameStartMs;
        const isLive = isLiveEspn || startedByTime;
        const canonicalState = isFinal ? "final" : isLive ? "live" : "pregame";
        console.log(`[MLB STATUS] ${statusName} → ${canonicalState} (espnLive=${isLiveEspn} timeLive=${startedByTime}) ${event.date ?? "no-time"}`);
        const gameId = String(event.id);

        const homeCompetitor = competition.competitors?.find((c: any) => c.homeAway === "home");
        const awayCompetitor = competition.competitors?.find((c: any) => c.homeAway === "away");

        const awayTeamName = resolveTeamName(awayCompetitor?.team);
        const homeTeamName = resolveTeamName(homeCompetitor?.team);
        if (!awayTeamName && !homeTeamName) {
          console.warn(`[MLB DROP][${gameId}] both team names empty after fallback chain — dropping event`);
          continue;
        }

        const awayAbbrVal: string = awayCompetitor?.team?.abbreviation ?? "";
        const homeAbbrVal: string = homeCompetitor?.team?.abbreviation ?? "";

        // Scores — parse for live and final games
        const homeScore: number = (isLive || isFinal) ? (parseFloat(homeCompetitor?.score ?? "0") || 0) : 0;
        const awayScore: number = (isLive || isFinal) ? (parseFloat(awayCompetitor?.score ?? "0") || 0) : 0;

        // Inning from cached game state (orchestrator-maintained) — fallback to ESPN status detail
        const cachedState = mlbGameCache.gameState[gameId];
        const statusDetail: string = competition.status?.type?.shortDetail ?? "";
        const espnPeriod: number = typeof competition.status?.period === "number"
          ? competition.status.period
          : parseInt(competition.status?.period ?? "0", 10) || 0;
        const inningFromEspn = espnPeriod > 0
          ? espnPeriod
          : (() => { const m = statusDetail.match(/(\d+)/); return m ? parseInt(m[1]) : 0; })();
        const isTopInningFromEspn = /Bot|Bottom/i.test(statusDetail) ? false
          : /^T|Top|Mid/i.test(statusDetail);

        // Weather from cached weather data (orchestrator-maintained)
        const cachedWeather = mlbGameCache.weather[gameId];
        const weatherParts: string[] = [];
        if (cachedWeather?.temperature != null) weatherParts.push(`${cachedWeather.temperature}°F`);
        if (cachedWeather?.windSpeed != null && cachedWeather?.windDirection) {
          weatherParts.push(`${cachedWeather.windSpeed}mph ${cachedWeather.windDirection}`);
        }
        const weatherSummary = weatherParts.join(", ");

        // Venue from ESPN event or competition
        const parkName: string = competition.venue?.fullName ?? event.venue?.fullName ?? "";

        const pitcherInGame = cachedState?.pitcherInGame ?? null;

        const probableHome = competition.situation?.probable?.home?.athlete;
        const probableAway = competition.situation?.probable?.away?.athlete;
        const espnAwayPitcher: string = probableAway?.fullName ?? probableAway?.displayName ?? "";
        const espnHomePitcher: string = probableHome?.fullName ?? probableHome?.displayName ?? "";
        const registeredGame = getActiveGames().find((g) => g.gameId === gameId);
        const awayPitcher: string = espnAwayPitcher || registeredGame?.awayPitcher || "";
        const homePitcher: string = espnHomePitcher || registeredGame?.homePitcher || "";

        const cacheEntry = mlbEdgeCache.get(gameId);
        const qualifiedSigs = cacheEntry?.qualifiedSignals ?? [];
        // Freshness Integrity Fix #3 — game cards must use the same signal
        // pool as /api/mlb/edge-feed (allSignals) so a card never says
        // "no signals" while the feed has watchlist/fallback signals visible.
        // We still surface qualifiedSignalCount separately for any consumer
        // that needs the strict-quality count.
        const allVisibleSigs = cacheEntry?.allSignals ?? cacheEntry?.qualifiedSignals ?? [];
        const hasOdds = allVisibleSigs.length > 0;
        const signalLocked = allVisibleSigs.length > 0;

        const bestQualified = qualifiedSigs.length > 0
          ? qualifiedSigs.reduce((best, qs) => (qs.signalScore > best.signalScore ? qs : best), qualifiedSigs[0])
          : null;
        const bestRawOutput = bestQualified
          ? cacheEntry?.outputs?.find((o) => o.playerId === bestQualified.playerId && o.market === bestQualified.market)
          : null;
        // [MLB Canonical Probability v1] No signalScore fallback. If the engine
        // probability is missing/invalid, surface null on the wire and log the
        // rejection so analytics consumers do not silently get a confidence value
        // masquerading as probability.
        const bestMarketProb = bestQualified ? validateMlbEngineProbability(bestQualified) : null;
        if (bestQualified && bestMarketProb === null) {
          logMlbPersistReject("missing_engine_probability", bestQualified);
        }
        const bestMarket = bestQualified ? {
          line: bestQualified.line,
          odds: bestRawOutput && (bestRawOutput.overOdds !== null || bestRawOutput.underOdds !== null)
            ? { overOdds: bestRawOutput.overOdds, underOdds: bestRawOutput.underOdds }
            : null,
          projection: bestQualified.projection,
          edge: bestRawOutput?.edge ?? null,
          probability: bestMarketProb,
          probabilitySemantics: "recommended_side_calibrated" as const,
          oddsUpdatedAt: bestRawOutput ? new Date(bestRawOutput.oddsUpdatedAt).toISOString() : null,
          projectionUpdatedAt: bestRawOutput ? new Date(bestRawOutput.projectionUpdatedAt).toISOString() : null,
        } : null;

        const pitcherCtx = mlbGameCache.pitcherContext[gameId];
        const activePitcherId = pitcherInGame?.playerId ?? null;
        const activePitcherCtx = activePitcherId && pitcherCtx?.byPitcherId?.[activePitcherId]
          ? pitcherCtx.byPitcherId[activePitcherId] : null;

        if (canonicalState === "live" && (!cachedState?.inning || cachedState.inning < 1)) {
          console.log(`[MLB INNING_WARN] game=${gameId} ${awayAbbrVal}@${homeAbbrVal} cachedInning=${cachedState?.inning ?? "none"} espnPeriod=${espnPeriod} espnInning=${inningFromEspn} detail="${statusDetail}"`);
        }
        // Inning is monotonically increasing — pick the highest of cache and
        // ESPN to avoid a stuck "top of 1st" when one source lags. If both
        // report the same inning but disagree on top/bottom, prefer "bottom"
        // (the later half) since innings progress top → bottom.
        const cachedInn = typeof cachedState?.inning === "number" ? cachedState.inning : 0;
        const espnInn = typeof inningFromEspn === "number" ? inningFromEspn : 0;
        const resolvedInning = Math.max(cachedInn, espnInn) || (cachedInn || espnInn || null);
        let resolvedIsTop: boolean | undefined;
        if (cachedInn === espnInn && cachedInn > 0) {
          resolvedIsTop = (cachedState?.isTopInning === false || isTopInningFromEspn === false) ? false : (cachedState?.isTopInning ?? isTopInningFromEspn);
        } else if (cachedInn >= espnInn) {
          resolvedIsTop = cachedState?.isTopInning ?? isTopInningFromEspn;
        } else {
          resolvedIsTop = isTopInningFromEspn;
        }
        games.push({
          gameId,
          awayTeam: awayTeamName,
          homeTeam: homeTeamName,
          awayAbbr: awayAbbrVal,
          homeAbbr: homeAbbrVal,
          homeScore: (canonicalState === "live" || canonicalState === "final") ? homeScore : null,
          awayScore: (canonicalState === "live" || canonicalState === "final") ? awayScore : null,
          inning: resolvedInning,
          isTopInning: resolvedIsTop,
          status: canonicalState as "live" | "pregame" | "final",
          startTime: event.date ?? null,
          venue: parkName || null,
          weatherSummary: weatherSummary || null,
          weather: cachedWeather ? {
            temperature: cachedWeather.temperature,
            windSpeed: cachedWeather.windSpeed,
            windDirection: cachedWeather.windDirection,
            humidity: cachedWeather.humidity,
          } : null,
          pitcherAway: awayPitcher || null,
          pitcherHome: homePitcher || null,
          awayPitcherHand: (() => {
            const awayP = registeredGame?.awayPitcher || espnAwayPitcher;
            if (!awayP) return null;
            const rp = getPlayerByName(awayP);
            return rp?.throws ?? null;
          })(),
          homePitcherHand: (() => {
            const homeP = registeredGame?.homePitcher || espnHomePitcher;
            if (!homeP) return null;
            const rp = getPlayerByName(homeP);
            return rp?.throws ?? null;
          })(),
          pitcherName: pitcherInGame?.playerName ?? null,
          pitcherThrows: pitcherInGame?.throws ?? null,
          pitcherTeam: pitcherInGame?.team ?? null,
          pitcherContext: activePitcherCtx ? {
            pitchCount: activePitcherCtx.pitchCount,
            timesThroughOrder: activePitcherCtx.timesThroughOrder,
            avgVelocity: activePitcherCtx.avgVelocity,
            velocityDrop: activePitcherCtx.velocityDrop,
          } : null,
          gameState: cachedState ? {
            outs: cachedState.outs,
            runnersOnBase: cachedState.runnersOnBase,
          } : null,
          signalCount: allVisibleSigs.length,
          qualifiedSignalCount: qualifiedSigs.length,
          hasOdds,
          signalLocked,
          market: bestMarket,
          gameCardTags: cacheEntry?.gameCardTags ?? [],
          parkFactor: parkName ? getMarketParkFactor(parkName) : null,
          isIndoors: cachedWeather?.isIndoors ?? false,
        });
      }

      for (const g of games) {
        const gAny = g as any;
        console.log(`[MLB HYDRATION] game=${gAny.gameId} status=${gAny.status} pitcherAway=${gAny.pitcherAway || "MISSING"} pitcherHome=${gAny.pitcherHome || "MISSING"} hasOdds=${gAny.hasOdds} signalCount=${gAny.signalCount} signalLocked=${gAny.signalLocked}`);
      }
      const builtGames = games.length;
      console.log(`[MLB DISCOVERY] live-games builtGames=${builtGames}`);
      if (builtGames === 0) {
        console.warn(`[MLB DISCOVERY] WARNING: live-games builtGames=0 for date=${espnDateStr}`);
      }
      mlbLiveGamesCache.set("games", { ts: Date.now(), games });

      const hasAnyOdds = games.some((g: any) => g.hasOdds === true);
      if (!hasAnyOdds) {
        return res.json({ mode: "preview", games, previewPlayers: generatePreviewPlayers(games) });
      }
      return res.json({ mode: "live", games });
    } catch (e: any) {
      console.error("[mlb/live-games]", e.message);
      return res.status(502).json({ error: "Live games unavailable", games: [] });
    }
  });

  const mlbLiveStatsCache = new Map<string, { ts: number; players: any[]; allRosterIds: Set<string>; gameContext: any }>();
  const MLB_LIVE_STATS_TTL = 15_000;

  const buildGameContext = (gameId: string, boxscore?: any) => {
    const cachedState = mlbGameCache.gameState[gameId];
    const homeAbbr: string = boxscore?.teams?.home?.team?.abbreviation ?? "";
    const awayAbbr: string = boxscore?.teams?.away?.team?.abbreviation ?? "";
    if (!cachedState) {
      return {
        gameState: "pregame" as const,
        inning: 0,
        isTopInning: true,
        halfState: "Top",
        outs: 0,
        homeScore: 0,
        awayScore: 0,
        homeAbbr,
        awayAbbr,
        runners: [] as string[],
        currentBatterId: null,
        currentBatterName: null,
        pitcherId: null,
        pitcherName: null,
        ageMs: null,
      };
    }
    return {
      gameState: "live" as const,
      inning: cachedState.inning ?? 0,
      isTopInning: cachedState.isTopInning ?? true,
      halfState: (cachedState.isTopInning ?? true) ? "Top" : "Bottom",
      outs: cachedState.outs ?? 0,
      homeScore: cachedState.homeScore ?? 0,
      awayScore: cachedState.awayScore ?? 0,
      homeAbbr: homeAbbr || cachedState.homeTeamAbbr || "",
      awayAbbr: awayAbbr || cachedState.awayTeamAbbr || "",
      runners: cachedState.runnersOnBase ?? [],
      currentBatterId: cachedState.currentBatter?.playerId ?? null,
      currentBatterName: cachedState.currentBatter?.playerName ?? null,
      pitcherId: cachedState.pitcherInGame?.playerId ?? null,
      pitcherName: cachedState.pitcherInGame?.playerName ?? null,
      ageMs: cachedState.fetchedAt ? Date.now() - cachedState.fetchedAt : null,
    };
  };

  app.get("/api/mlb/live-stats/:gameId", requireMLBAccess, async (req, res) => {
    const gameId = req.params.gameId as string;
    const cached = mlbLiveStatsCache.get(gameId);
    if (cached && Date.now() - cached.ts < MLB_LIVE_STATS_TTL) {
      return res.json({ ready: true, reason: null, players: cached.players, gameContext: cached.gameContext });
    }
    try {
      const registeredLiveGame = getActiveGames().find((g) => g.gameId === gameId);
      const liveStatsPk: string | undefined = registeredLiveGame?.gamePk;
      if (!liveStatsPk) {
        console.log(`[mlb/live-stats] gameId=${gameId}: gamePk not yet resolved (registered=${!!registeredLiveGame}) — returning readiness metadata`);
        return res.json({ ready: false, reason: "Waiting for official box score", players: [], gameContext: buildGameContext(gameId) });
      }
      const url = `https://statsapi.mlb.com/api/v1/game/${liveStatsPk}/boxscore`;
      const response = await fetch(url, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`MLB boxscore API ${response.status}`);
      const data = (await response.json()) as any;
      const players: any[] = [];
      for (const side of ["away", "home"] as const) {
        const teamData = data.teams?.[side];
        if (!teamData) continue;
        const batters: number[] = teamData.batters ?? [];
        const playerMap = teamData.players ?? {};
        for (const batterId of batters) {
          const entry = playerMap[`ID${batterId}`];
          if (!entry) continue;
          const batting = entry.stats?.batting ?? {};
          const slotRaw: string = entry.battingOrder ?? "0";
          const slot = Math.floor(parseInt(slotRaw, 10) / 100) || 0;
          const contactEntry = mlbGameCache.contactData[gameId]?.byPlayerId?.[String(batterId)];
          const priorABResults = contactEntry?.priorABResults ?? [];
          const lastABOutcome = priorABResults.length > 0
            ? priorABResults[priorABResults.length - 1].outcome
            : null;
          players.push({
            playerId: String(batterId),
            playerName: entry.person?.fullName ?? "",
            teamAbbr: side === "home" ? data.teams?.home?.team?.abbreviation ?? "" : data.teams?.away?.team?.abbreviation ?? "",
            teamSide: side,
            battingOrderSlot: slot,
            ab: batting.atBats ?? 0,
            h: batting.hits ?? 0,
            hr: batting.homeRuns ?? 0,
            tb: batting.totalBases ?? 0,
            r: batting.runs ?? 0,
            rbi: batting.rbi ?? 0,
            bb: batting.baseOnBalls ?? 0,
            sb: batting.stolenBases ?? 0,
            k: batting.strikeOuts ?? 0,
            lastABOutcome,
            exitVelocity: contactEntry?.exitVelocity ?? null,
            barrelPct: contactEntry?.barrelPct ?? null,
            xBA: contactEntry?.xBA ?? null,
            xSLG: contactEntry?.xSLG ?? null,
            hardHitPct: contactEntry?.hardHitPct ?? null,
            priorABResults: priorABResults.map(ab => ({
              outcome: ab.outcome,
              exitVelocity: ab.exitVelocity,
              launchAngle: ab.launchAngle,
              distance: ab.distance,
              pitchType: ab.pitchType ?? null,
              pitchSpeed: ab.pitchSpeed ?? null,
              isBarrel: ab.isBarrel ?? false,
            })),
          });
        }
      }
      players.sort((a, b) => (a.battingOrderSlot || 99) - (b.battingOrderSlot || 99));
      const allRosterIds = new Set<string>(players.map((p: any) => String(p.playerId)));
      for (const side of ["away", "home"] as const) {
        const pitchers: number[] = data.teams?.[side]?.pitchers ?? [];
        for (const pid of pitchers) allRosterIds.add(String(pid));
      }
      const gameContext = buildGameContext(gameId, data);
      mlbLiveStatsCache.set(gameId, { ts: Date.now(), players, allRosterIds, gameContext });
      console.log(`[mlb/live-stats] gameId=${gameId}: hydrated ${players.length} players from gamePk=${liveStatsPk} inning=${gameContext.inning}${gameContext.isTopInning ? "T" : "B"} score=${gameContext.awayScore}-${gameContext.homeScore} batter=${gameContext.currentBatterName ?? "?"}`);
      return res.json({ ready: true, reason: null, players, gameContext });
    } catch (e: any) {
      console.error("[mlb/live-stats]", e.message);
      return res.status(502).json({ ready: false, reason: "Live stats unavailable", players: [], gameContext: buildGameContext(gameId) });
    }
  });

  app.get("/api/mlb/game-stats/:gameId", requireMLBAccess, async (req, res) => {
    try {
      const gameId = req.params.gameId as string;
      const stats = await storage.getGamePlayerStats(gameId);
      const players = stats.map(s => ({
        ...s,
        priorABResults: safeParseJsonArray(s.abResults),
      }));
      return res.json({ ready: true, players });
    } catch (e: any) {
      console.error("[mlb/game-stats]", e.message);
      return res.status(500).json({ ready: false, players: [] });
    }
  });

  app.get("/api/mlb/player-history/:playerId", requireAuth, async (req, res) => {
    try {
      const playerId = req.params.playerId as string;
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const games = await storage.getPlayerHistory(playerId, limit);
      return res.json({
        games: games.map(g => ({
          ...g,
          priorABResults: safeParseJsonArray(g.abResults),
        })),
      });
    } catch (e: any) {
      console.error("[mlb/player-history]", e.message);
      return res.status(500).json({ games: [] });
    }
  });

  app.get("/api/mlb/alerts", requireAuth, async (req, res) => {
    try {
      const minutes = Math.max(1, Math.min(parseInt(req.query.minutes as string) || 60, 120));
      const [alerts, conversionStats] = await Promise.all([
        storage.getRecentAlerts(minutes),
        storage.getAlertConversionStats(),
      ]);

      const deriveSignalState = (trigger: string | null, alertType: string, score: number): { signalState: string | null; decision: string | null } => {
        if (!trigger) return { signalState: null, decision: null };
        if (trigger === "cooldown") return { signalState: "COOLDOWN", decision: null };
        if (trigger.startsWith("hard_trigger") || trigger.startsWith("repeat_contact")) {
          return { signalState: "PEAK", decision: "BET_NOW" };
        }
        if (trigger.startsWith("PATH_A") && score >= 6) return { signalState: "PEAK", decision: "BET_NOW" };
        if (trigger.startsWith("PATH_A")) return { signalState: "BUILDING", decision: "PREPARE" };
        if (trigger.startsWith("PATH_B") && score >= 7) return { signalState: "PEAK", decision: "BET_NOW" };
        if (trigger.startsWith("PATH_B")) return { signalState: "BUILDING", decision: "PREPARE" };
        if (trigger.startsWith("PATH_C") && score >= 7) return { signalState: "PEAK", decision: "BET_NOW" };
        if (trigger.startsWith("PATH_C")) return { signalState: "BUILDING", decision: "PREPARE" };
        if (trigger.startsWith("watch:")) return { signalState: "FORMATION", decision: "MONITOR" };
        if (trigger.startsWith("leaderboard") || trigger.startsWith("late_game_spike")) {
          return { signalState: "BUILDING", decision: "PREPARE" };
        }
        if (trigger.startsWith("soft_trigger")) {
          return { signalState: "FORMATION", decision: "MONITOR" };
        }
        return { signalState: alertType === "HR_EARLY" ? "BUILDING" : "FORMATION", decision: alertType === "HR_EARLY" ? "PREPARE" : "MONITOR" };
      };

      const ordinalSuffix = (n: number): string => {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };

      const deriveFormattedReason = (trigger: string | null, factors: any, inning: number | null): string => {
        if (!trigger) return "";
        if (trigger === "cooldown") return "Recently alerted — signal on cooldown.";
        if (trigger.startsWith("PATH_A")) {
          return `Multiple HR-shaped contact events detected. Quality exit velocity and launch angle pattern building${inning ? ` through ${ordinalSuffix(inning)} inning` : ""}.`;
        }
        if (trigger.startsWith("PATH_B:elite")) {
          return `Elite HR contact with favorable game conditions. Ball flight and exit velocity at HR levels${inning ? ` in ${ordinalSuffix(inning)} inning` : ""}.`;
        }
        if (trigger.startsWith("PATH_B:missed") || trigger.startsWith("PATH_B")) {
          return `Near-miss HR with supporting context. Strong contact quality and pitcher/environment alignment${inning ? ` in ${ordinalSuffix(inning)} inning` : ""}.`;
        }
        if (trigger.startsWith("PATH_C")) {
          return `Late-game HR window with quality contact${inning ? ` (${ordinalSuffix(inning)} inning)` : ""}. Pitcher vulnerability creating opportunity.`;
        }
        if (trigger.startsWith("watch:hrShaped")) {
          return "HR-shaped contact detected. Monitoring for escalation — need repeat confirmation or stronger context.";
        }
        if (trigger.startsWith("watch:")) {
          return "Contact pattern building. Monitoring for HR-shaped escalation.";
        }
        if (trigger.includes("barrel") && trigger.includes("avgEV95")) {
          return `Barrel contact + 95+ EV trend. Power building into ${inning ? ordinalSuffix(inning) : "mid-game"} window.`;
        }
        if (trigger.startsWith("repeat_contact")) {
          return "Back-to-back hard contact (95+ EV, optimal launch angle). HR probability spiking.";
        }
        if (trigger.startsWith("leaderboard:")) {
          if (trigger.includes("topEV")) return `Game-leading exit velocity (${factors?.maxEV?.toFixed(0) ?? "105+"}mph). Elite barrel potential.`;
          if (trigger.includes("topDistance")) return "Deep flyball contact today — distance leaderboard-level. HR conditions active.";
          return "Leaderboard-level contact metrics this game.";
        }
        if (trigger.startsWith("late_game_spike")) {
          return `Late-game power spike (${inning ? ordinalSuffix(inning) : "late"} inning). Contact quality rising against tired bullpen.`;
        }
        if (trigger.startsWith("soft_trigger")) {
          return "Consistent hard contact building. EV averaging 92+ with rising build score.";
        }
        return "Power indicators increasing.";
      };

      const deriveConfidence = (score: number, factors: any): number => {
        let base = Math.min(10, Math.round(score * 2));
        if ((factors?.barrels ?? 0) >= 2) base = Math.min(10, base + 1);
        if ((factors?.maxEV ?? 0) >= 108) base = Math.min(10, base + 1);
        return Math.max(0, base);
      };

      return res.json({
        alerts: alerts.map(a => {
          let factors = null;
          try { factors = a.factors ? JSON.parse(a.factors) : null; } catch {}
          const score = a.hrBuildScore != null ? parseFloat(a.hrBuildScore) : 0;
          const lifecycle = deriveSignalState(a.triggerReason, a.alertType, score);
          return {
            ...a,
            hrBuildScore: score || null,
            factors,
            signalState: lifecycle.signalState,
            decision: lifecycle.decision,
            confidenceScore: deriveConfidence(score, factors),
            formattedReason: deriveFormattedReason(a.triggerReason, factors, a.inning),
          };
        }),
        conversionStats,
      });
    } catch (e: any) {
      console.error("[mlb/alerts]", e.message);
      return res.json({ alerts: [], conversionStats: null });
    }
  });

  const mlbSignalsCache = new Map<string, { ts: number; signals: any[]; updatedAt: number; isDegraded: boolean }>();
  const MLB_SIGNALS_TTL = 30_000;

  // Freshness Integrity Fix #4 — single source of truth for MLB market keys.
  // The legacy "hr"/"pitcher_k" aliases must never collide with the canonical
  // "home_runs"/"pitcher_strikeouts" used by the engine output set, otherwise
  // valid signals silently drop from the validated-set filter.
  // Phase 3.5 ext — single source of truth, shared with the grader.

  app.get("/api/mlb/live-signals/:gameId", requireMLBAccess, async (req, res) => {
    try { (await import("./services/liveSignalBus")).markLegacyConsumer("/api/mlb/live-signals/:gameId"); } catch {}
    const gameId = req.params.gameId as string;

    let gameStatus = "";
    // Resolve statsPk (MLB gamePk) for Stats API calls in this endpoint
    const liveSignalsGame = getActiveGames().find((g) => g.gameId === gameId);
    const liveSignalsStatsPk: string | undefined = liveSignalsGame?.gamePk;

    if (!liveSignalsStatsPk) {
      console.log(`[MLB signals] gameId=${gameId}: gamePk not yet resolved — returning mode:no_lines`);
      return res.json({ mode: "no_lines", signals: [], updatedAt: 0 });
    }

    const cachedLiveGamesList = mlbLiveGamesCache.get("games");
    if (cachedLiveGamesList) {
      const liveGame = cachedLiveGamesList.games.find((g: any) => String(g.gameId) === gameId);
      gameStatus = liveGame?.status ?? "";
    } else {
      try {
        const schedUrl = `https://statsapi.mlb.com/api/v1/game/${liveSignalsStatsPk}/feed/live`;
        const schedRes = await fetch(schedUrl, {
          headers: { "User-Agent": "LiveLocks/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (schedRes.ok) {
          const schedData = (await schedRes.json()) as any;
          const abstractState: string = schedData.gameData?.status?.abstractGameState ?? "";
          const s = abstractState.toLowerCase().replace(/[\s_-]/g, "");
          if (s === "live" || s === "inprogress") gameStatus = "live";
          else if (s === "preview" || s === "pregame") gameStatus = "pregame";
          else if (s === "final") gameStatus = "final";
          else gameStatus = s || "unknown";
        }
      } catch { /* fallback: gameStatus stays "" */ }
    }

    if (gameStatus !== "live") {
      console.log(`[MLB signals] Game ${gameId} status="${gameStatus}" — returning mode:no_lines`);
      mlbSignalsCache.delete(gameId);
      return res.json({ mode: "no_lines", signals: [], updatedAt: 0 });
    }

    const cached = mlbSignalsCache.get(gameId);
    if (cached && Date.now() - cached.ts < MLB_SIGNALS_TTL) {
      const cachedMode = cached.signals.length > 0 ? "live" : "no_lines";
      const cachedEntry = mlbEdgeCache.get(gameId);
      return res.json({ mode: cachedMode, signals: cached.signals, updatedAt: cached.updatedAt, isDegraded: cached.isDegraded, gameCardTags: cachedEntry?.gameCardTags ?? [] });
    }

    const entry = mlbEdgeCache.get(gameId);
    const updatedAt = entry?.updatedAt ?? 0;
    const cachedIsDegraded = entry?.isDegraded ?? false;

    const SIGNAL_FRESHNESS_MS = 10 * 60 * 1000;
    const SIGNAL_DEGRADED_MS = 3 * 60 * 1000;
    const dataAge = updatedAt > 0 ? Date.now() - updatedAt : 0;
    // Two-axis freshness: drops if engine is dead OR last qualifying cycle
    // older than SIGNAL_FRESHNESS_MS, while honoring blank-cycle preserves.
    if (entry && !isMLBEdgeEntryFresh(entry, SIGNAL_FRESHNESS_MS)) {
      const staleAge = Math.round(dataAge / 1000);
      console.warn(`[MLB signals] game=${gameId} — engine data ${staleAge}s old (>${SIGNAL_FRESHNESS_MS / 1000}s limit); returning no_lines`);
      mlbSignalsCache.set(gameId, { ts: Date.now(), signals: [], updatedAt, isDegraded: true });
      return res.json({ mode: "no_lines", signals: [], updatedAt, isDegraded: true });
    }
    const isDataStale = updatedAt > 0 && dataAge > SIGNAL_DEGRADED_MS;

    const engineAll = entry?.allSignals ?? entry?.qualifiedSignals ?? [];

    if (engineAll.length === 0) {
      console.log(`[MLB signals] game=${gameId} — no signals from engine, returning mode:monitoring`);
      mlbSignalsCache.set(gameId, { ts: Date.now(), signals: [], updatedAt, isDegraded: false });
      return res.json({ mode: "monitoring", signals: [], updatedAt });
    }

    const CONFIDENCE_RANK: Record<string, number> = { ELITE: 4, STRONG: 3, SOLID: 2, WATCHLIST: 1, NO_SIGNAL: 0 };

    const apiSignals = engineAll
      .map((qs) => {
        // [MLB Canonical Probability v1] enginePct is recommended-side calibrated
        // probability — never a signalScore fallback. Drop the row if the engine
        // probability is missing/invalid; downstream filtering handles removal.
        const validProb = validateMlbEngineProbability(qs as any);
        if (validProb === null) {
          logMlbPersistReject("missing_engine_probability", qs as any);
          return null;
        }
        const enginePct = Math.round(validProb * 10) / 10;

        let tier: "green" | "yellow" | "teal" | "red";
        if (qs.side === "UNDER" && enginePct >= 85) tier = "red";
        else if (enginePct >= 85) tier = "green";
        else if (enginePct >= 70) tier = "yellow";
        else tier = "teal";

        const rawOutput = entry?.outputs?.find(
          (o) => o.playerId === qs.playerId && o.market === qs.market
        );

        const overO = rawOutput?.overOdds ?? null;
        const underO = rawOutput?.underOdds ?? null;
        let bookImplied: number | null = null;
        if (qs.side === "OVER" && overO != null && overO !== 0) {
          bookImplied = overO < 0 ? Math.abs(overO) / (Math.abs(overO) + 100) * 100 : 100 / (overO + 100) * 100;
        } else if (qs.side === "UNDER" && underO != null && underO !== 0) {
          bookImplied = underO < 0 ? Math.abs(underO) / (Math.abs(underO) + 100) * 100 : 100 / (underO + 100) * 100;
        }

        const normalizedMarket = (qs.market as string) === "hr" ? "home_runs" : qs.market;

        return {
          playerId: qs.playerId,
          playerName: qs.playerName,
          market: normalizedMarket,
          bookLine: qs.line > 0 ? qs.line : null,
          projection: qs.projection ?? null,
          enginePct,
          edge: rawOutput ? (Number.isFinite(rawOutput.edge) ? Math.round(rawOutput.edge * 10) / 10 : null) : null,
          odds: qs.line > 0 ? { bookLine: qs.line } : null,
          recommendedSide: qs.side,
          inning: mlbGameCache.gameState[gameId]?.inning ?? 0,
          tier,
          gameId: qs.gameId,
          sportsbook: qs.sportsbook ?? null,
          derivedLine: rawOutput?.isDerivedLine ?? false,
          signalTimestamp: rawOutput?.signalTimestamp ?? rawOutput?.engineGeneratedAt ?? Date.now(),
          formIndicator: qs.formIndicator ? qs.formIndicator.toUpperCase() : null,
          formScore: rawOutput?.formScore ?? null,
          evPct: qs.evPct ?? null,
          hrFactors: rawOutput?.hrFactors ?? null,
          hrBuildScore: rawOutput?.hrBuildScore ?? null,
          hrIntensity: rawOutput?.hrIntensity ?? null,
          hrAlert: (rawOutput as any)?.hrAlertSnapshot ? (() => {
            const s = (rawOutput as any).hrAlertSnapshot;
            return {
              currentState: s.currentState,
              hrReadinessScore: s.hrReadinessScore,
              hrConversionProbabilityRaw: s.hrConversionProbabilityRaw,
              hrConversionProbabilityCalibrated: s.hrConversionProbabilityCalibrated,
              remainingPAExpectation: s.remainingPAExpectation,
              positiveDrivers: s.positiveDrivers,
              negativeSuppressors: s.negativeSuppressors,
              cooldownReason: s.cooldownReason,
              lastStateChangeAt: s.lastStateChangeAt,
              dataFreshnessMs: s.dataFreshnessMs,
              peakScore: s.peakScore,
              peakState: s.peakState,
              peakAt: s.peakAt,
              detectedInning: s.detectedInning,
              currentInning: s.currentInning,
              pitcherHrVulnerability: s.pitcherHrVulnerability,
              decayFactor: s.decayFactor,
              tickCount: s.tickCount,
              lastRecomputeAt: s.lastRecomputeAt,
            };
          })() : null,
          contextScore: rawOutput?.contextScore ?? null,
          matchupTag: rawOutput?.matchupTag ?? null,
          explanationBullets: qs.reasons ?? [],
          modifiers: rawOutput?.modifiers ? {
            liveForm: rawOutput.modifiers.liveForm ?? 0,
            pitcher: rawOutput.modifiers.pitcher ?? 0,
            pitchType: rawOutput.modifiers.pitchType ?? 0,
            weatherPark: rawOutput.modifiers.weatherPark ?? 0,
            lineup: rawOutput.modifiers.lineup ?? 0,
          } : null,
          signalScore: qs.signalScore,
          confidenceTier: qs.confidenceTier,
          // [MLB Canonical Signal Tier — Phase 2] Pass the orchestrator-stamped
          // canonical tier through to the wire so MlbSignalCard / LiveBoard read
          // sig.signalTier directly via resolveMlbSignalTier() instead of falling
          // through to the legacy [MLB_TIER_FALLBACK] confidenceTier→tier mapping.
          signalTier: (qs as any).signalTier,
          signalTags: qs.signalTags,
          feedTags: qs.feedTags,
          playerGlowEligible: qs.playerGlowEligible,
          reasons: qs.reasons ?? [],
          badges: qs.badges ?? [],
          riskFlags: qs.riskFlags ?? [],
          drivers: qs.drivers ?? {},
          currentStats: qs.currentStats ?? null,
          lastABContact: qs.lastABContact ?? null,
          alreadyHit: qs.alreadyHit ?? false,
          actionable: qs.actionable ?? true,
          stale: qs.stale ?? false,
          watchlist: qs.watchlist ?? false,
          isEarlySignal: (qs as any).isEarlySignal ?? false,
          isDegraded: (qs as any).isDegraded ?? false,
          batterArchetype: qs.batterArchetype ?? null,
          pitcherArchetype: qs.pitcherArchetype ?? null,
          thesis: qs.thesis ?? null,
          isFlagship: qs.isFlagship ?? false,
          familyPenaltyFactor: qs.familyPenaltyFactor ?? null,
          safetyCeilingApplied: qs.safetyCeilingApplied ?? false,
          dataQuality: qs.dataQuality ?? null,
          bookImplied: bookImplied != null ? Math.round(bookImplied * 10) / 10 : null,
          bvp: (qs as any).bvpHistory ?? null,
          rollingForm: (qs as any).rollingForm ?? null,
          pitchMix: (rawOutput as any)?.pitchMix ?? null,
          overOdds: overO,
          underOdds: underO,
          priorABResults: (rawOutput as any)?.priorABResults ?? (qs as any).priorABResults ?? null,
          pitcherAnalysis: qs.pitcherAnalysis ?? (rawOutput as any)?.pitcherAnalysis ?? null,
          pitcherSignals: qs.pitcherSignals ?? (rawOutput as any)?.pitcherSignals ?? null,
          opportunityScore: qs.opportunityScore ?? 0,
          liveScore: qs.liveScore ?? 0,
          eventBoost: qs.eventBoost ?? 0,
          mode: qs.mode ?? null,
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => {
        const tierDiff = (CONFIDENCE_RANK[b.confidenceTier ?? "NO_SIGNAL"] ?? 0) - (CONFIDENCE_RANK[a.confidenceTier ?? "NO_SIGNAL"] ?? 0);
        if (tierDiff !== 0) return tierDiff;
        return (b.signalScore ?? 0) - (a.signalScore ?? 0);
      });

    // MLB Engine Isolation: run through sport-specific engine wrapper (authoritative gate)
    // [MLB Canonical Probability v1] Drop signals with missing/invalid engine
    // probability before they enter the wrapper. Never substitute signalScore.
    const mlbEngineResult = processMLBEngine(
      engineAll
        .map((qs: any) => {
          const validProb = validateMlbEngineProbability(qs);
          if (validProb === null) {
            logMlbPersistReject("missing_engine_probability", qs);
            return null;
          }
          return {
            playerId: qs.playerId,
            playerName: qs.playerName,
            team: qs.team ?? null,
            market: qs.market,
            line: qs.line,
            projection: qs.projection,
            probability: validProb,
            edge: qs.edge ?? 0,
            recommendedSide: qs.side,
            sportsbook: qs.sportsbook,
            derivedLine: qs.derivedLine ?? false,
            gameId: qs.gameId,
            signalScore: qs.signalScore,
            confidenceTier: qs.confidenceTier,
            currentStats: qs.currentStats,
            lastABContact: qs.lastABContact,
            batterArchetype: qs.batterArchetype,
            pitcherArchetype: qs.pitcherArchetype,
            thesis: qs.thesis,
            isFlagship: qs.isFlagship,
            safetyCeilingApplied: qs.safetyCeilingApplied,
            dataQuality: qs.dataQuality,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
    );
    // Freshness Integrity Fix #4 — normalize both sides of the validation
    // key so the engine's "home_runs" plays don't get filtered out by an
    // upstream "hr" alias on apiSignals (and vice-versa).
    const mlbValidPlayIds = new Set(
      mlbEngineResult.plays.map((p) => `${p.playerId}_${normalizeMlbMarketKey(p.market as string)}`)
    );
    const validatedApiSignals = apiSignals.filter((s) =>
      mlbValidPlayIds.has(`${s.playerId}_${normalizeMlbMarketKey(s.market as string)}`)
    );
    console.log(`[MLB ENGINE] game=${gameId} mode=${mlbEngineResult.mode} plays=${mlbEngineResult.plays.length} fallback=${mlbEngineResult.diagnostics.fallbackTriggered} filtered=${mlbEngineResult.diagnostics.totalFiltered}`);
    console.log(`[MLB signals] game=${gameId} allFromEngine=${engineAll.length} wrapperPassed=${validatedApiSignals.length} served=${validatedApiSignals.length} isDegraded=${cachedIsDegraded}`);
    // Sport-isolation drift trace — observe engine output, do not modify it.
    // One trace per engine call summarizing the decision boundary; per-play tracing
    // for MLB stays inside the HR-engine-protected path and is intentionally NOT wired here.
    for (const play of mlbEngineResult.plays) {
      emitDriftTrace("mlb", {
        engineOwner: "engines/mlb/index.ts:processMLBEngine",
        routeOwner: "GET /api/mlb-live-signals",
        oddsSource: cachedIsDegraded ? "stale" : "live_inplay",
        confidenceSource: mlbEngineResult.diagnostics.fallbackTriggered ? "engine_fallback" : "engine_strict",
        fallbackPath: mlbEngineResult.diagnostics.fallbackTriggered ? "strict_fallback" : "none",
        thresholdSource: "engines/mlb/types.ts:MLB_STRICT_RULES",
        staleHandling: cachedIsDegraded ? "accepted" : "n/a",
        gameId,
        playerName: play.playerName,
        market: play.market,
        edge: typeof play.edge === "number" ? play.edge : undefined,
        probability: typeof play.probability === "number" ? play.probability : undefined,
        confidenceTier: (play as any).confidenceTier ?? (play as any).confidence,
      });
    }

    recordEngineRun("mlb", {
      gamesProcessed: 1,
      signalsGenerated: validatedApiSignals.length,
      signalsSkipped: mlbEngineResult.diagnostics.totalFiltered,
      rejectedSignals: apiSignals.length - validatedApiSignals.length,
      rejectionReasons: mlbEngineResult.diagnostics.reasonsFilteredOut.slice(0, 10),
      failureReasons: [],
      latencyMs: 0,
      lineSource: "sportsbook",
      booksAvailable: validatedApiSignals.length > 0 ? 1 : 0,
    });

    const finalDegraded = cachedIsDegraded || isDataStale;
    mlbSignalsCache.set(gameId, { ts: Date.now(), signals: validatedApiSignals, updatedAt, isDegraded: finalDegraded });

    // Audit finding 2.1: MLB display routes are read-from-cache while
    // persistence runs separately inside liveGameOrchestrator.autoPersistMLBSignals.
    // If that orchestrator persist call fails silently, plays appear in the UI
    // but never reach persisted_plays → grading + analytics undercount.
    // Defensive safety-net: fire-and-forget trackPlay for every served qualified
    // signal. Idempotent via duplicateGuard; the UPSERT (storage.recordPlay) only
    // overwrites when newSignalScore > oldSignalScore, so this never clobbers
    // richer orchestrator data with the route's leaner payload.
    if (validatedApiSignals.length > 0) {
      const validIds = new Set(validatedApiSignals.map((s) => `${s.playerId}|${s.market}`));
      for (const qs of (entry?.qualifiedSignals ?? []) as any[]) {
        const dir = qs.side === "OVER" ? "over" : qs.side === "UNDER" ? "under" : null;
        if (!dir) continue;
        const normalizedMarketKey = (qs.market as string) === "hr" ? "home_runs" : qs.market;
        if (!validIds.has(`${qs.playerId}|${normalizedMarketKey}`)) continue;
        if (!Number.isFinite(qs.line) || qs.line <= 0) continue;
        // [MLB Canonical Probability v1] Reject persistence rather than fall back
        // to signalScore. The orchestrator's primary persistence path will retry.
        const validProb = validateMlbEngineProbability(qs);
        if (validProb === null) {
          logMlbPersistReject("missing_engine_probability", qs);
          continue;
        }
        const sbk = qs.sportsbook && String(qs.sportsbook).trim() !== "" ? qs.sportsbook : "odds_api";
        trackPlay({
          gameId,
          playerId: qs.playerId,
          playerName: qs.playerName,
          team: qs.team ?? null,
          sport: "mlb",
          market: qs.market,
          direction: dir as "over" | "under",
          line: qs.line,
          projection: qs.projection,
          probability: validProb,
          edge: qs.evPct ?? 0,
          sportsbook: sbk,
          derivedLine: false,
          createdAt: qs.engineGeneratedAt ?? Date.now(),
          signalScore: qs.signalScore ?? null,
          confidenceTier: qs.confidenceTier ?? null,
          inning: qs.inning ?? null,
          abNumber: qs.completedAB ?? null,
          opportunityScore: qs.opportunityScore ?? null,
          liveScore: qs.liveScore ?? null,
          eventBoost: qs.eventBoost ?? null,
          signalMode: qs.mode ?? null,
          marketFamily: qs.marketFamily ?? null,
        }, storage).catch(err => console.warn(`[MLB_ROUTE_PERSIST_SAFETY] failed for ${qs.playerName}/${qs.market}: ${err?.message ?? err}`));
      }
    }

    return res.json({ mode: "live", engine: "MLB", engineMode: mlbEngineResult.mode, signals: validatedApiSignals, updatedAt, isDegraded: finalDegraded, gameCardTags: entry?.gameCardTags ?? [] });
  });

  // Engine-canonical box score state: per-player live engine truth for a single game.
  // The Live Box Score Signal column reads from THIS endpoint, not from the filtered
  // top-feed. A player can have a watch/building/monitor state here without appearing
  // in the main live-signals feed. Engine is the sole source of truth — no edge,
  // implied-probability, or sportsbook gating is applied here.
  app.get("/api/mlb/boxscore-engine-state/:gameId", requireMLBAccess, async (req, res) => {
    try { (await import("./services/liveSignalBus")).markLegacyConsumer("/api/mlb/boxscore-engine-state/:gameId"); } catch {}
    const gameId = req.params.gameId as string;

    const entry = mlbEdgeCache.get(gameId);
    if (!entry) {
      console.log(`[MLB_BOXSCORE_ENGINE_STATE] gameId=${gameId} no_cache_entry`);
      return res.json({ mode: "no_lines", players: [], updatedAt: 0 });
    }

    const all = entry.allSignals ?? [];
    if (all.length === 0) {
      console.log(`[MLB_BOXSCORE_ENGINE_STATE] gameId=${gameId} total=0 (engine_monitoring)`);
      return res.json({ mode: "monitoring", players: [], updatedAt: entry.updatedAt ?? 0 });
    }

    const qualifiedKeys = new Set(
      (entry.qualifiedSignals ?? []).map((q) => `${q.playerId}:${q.market}:${q.side}`)
    );

    const MODE_RANK: Record<string, number> = {
      elite: 5, hr_elite: 5,
      strong: 4, hr_strong: 4,
      lean: 3,
      heating_up: 2, hr_heating_up: 2,
      watch: 1, hr_watch: 1,
    };

    type EngineSignalState = "strong" | "building" | "watch" | "monitor";

    const mapModeToState = (
      mode: string | null | undefined,
      score: number
    ): EngineSignalState => {
      const m = (mode ?? "").toLowerCase();
      if (m === "elite" || m === "strong" || m === "hr_elite" || m === "hr_strong") return "strong";
      if (m === "lean" || m === "heating_up" || m === "hr_heating_up") return "building";
      if (m === "watch" || m === "hr_watch") return "watch";
      // Engine produced a signal but no canonical mode → treat as monitor when score is meaningful.
      if (score > 0) return "monitor";
      return "monitor";
    };

    // For each player, pick their best engine signal.
    const bestByPlayer = new Map<string, typeof all[number]>();
    for (const sig of all) {
      const existing = bestByPlayer.get(sig.playerId);
      if (!existing) {
        bestByPlayer.set(sig.playerId, sig);
        continue;
      }
      const a = MODE_RANK[(sig.mode ?? "").toLowerCase()] ?? 0;
      const b = MODE_RANK[(existing.mode ?? "").toLowerCase()] ?? 0;
      if (a > b) {
        bestByPlayer.set(sig.playerId, sig);
      } else if (a === b && (sig.signalScore ?? 0) > (existing.signalScore ?? 0)) {
        bestByPlayer.set(sig.playerId, sig);
      }
    }

    // Decision-grade engine confidence: derived from engine conviction (signal
    // strength + mode + opportunity context), NOT from raw event probability.
    // This is what the UI surfaces as the primary "confidence %". The raw
    // event probability is preserved separately for grading and the detail modal.
    const STATE_FLOOR: Record<EngineSignalState, number> = {
      strong: 72,
      building: 58,
      watch: 42,
      monitor: 30,
    };
    const STATE_CEIL: Record<EngineSignalState, number> = {
      strong: 95,
      building: 78,
      watch: 60,
      monitor: 50,
    };

    const computeEngineConfidence = (
      sig: typeof all[number],
      state: EngineSignalState
    ): number => {
      const base = Number.isFinite(sig.signalStrengthScore as number)
        ? (sig.signalStrengthScore as number)
        : (sig.signalScore ?? 0);
      const opp = Number.isFinite(sig.opportunityScore as number)
        ? Math.max(0, Math.min(100, sig.opportunityScore as number))
        : 0;
      // Blend: 80% intrinsic strength, 20% live-opportunity context.
      const blended = base * 0.8 + opp * 0.2;
      const floor = STATE_FLOOR[state];
      const ceil = STATE_CEIL[state];
      const clamped = Math.max(floor, Math.min(ceil, blended));
      return Math.round(clamped * 10) / 10;
    };

    const players = Array.from(bestByPlayer.values()).map((sig) => {
      const signalState = mapModeToState(sig.mode, sig.signalScore ?? 0);
      const surfaced = qualifiedKeys.has(`${sig.playerId}:${sig.market}:${sig.side}`);
      const probability = sig.engineProbability ?? null;
      const normalizedMarket = normalizeMlbMarket(sig.market as string);
      const engineConfidence = computeEngineConfidence(sig, signalState);

      // Canonical resolver: same code path the calculator uses, so the
      // numbers shown in this badge match the calculator panel exactly.
      const canonical = resolveMlbPlayerMarketSignal({
        gameId,
        playerId: sig.playerId,
        market: normalizedMarket,
        line: (sig as any).line ?? undefined,
      });

      return {
        gameId: sig.gameId,
        playerId: sig.playerId,
        playerName: sig.playerName,
        team: sig.team,
        signalState,
        surfaced,
        market: normalizedMarket,
        side: sig.side,
        // engineConfidence is the engine's conviction value (NOT a probability).
        engineConfidence,
        // probability is the raw event probability (truth, for detail/grading).
        probability: probability != null ? Math.round(probability * 10) / 10 : null,
        // Canonical paired probabilities — the box score badge surfaces these
        // so the same player+market+line shows the same Over/Under % in
        // both the box score and the calculator panel.
        overProbability: canonical?.overProbability ?? null,
        underProbability: canonical?.underProbability ?? null,
        recommendedSide: canonical?.recommendedSide ?? sig.side ?? null,
        signalStrengthScore: sig.signalStrengthScore ?? sig.signalScore ?? null,
        drivers: sig.reasons ?? [],
        tags: sig.signalTags ?? [],
        alreadyHit: !!sig.alreadyHit,
        source: canonical?.source ?? "engine",
      };
    });

    let strong = 0, building = 0, watch = 0, monitor = 0;
    for (const p of players) {
      if (p.signalState === "strong") strong++;
      else if (p.signalState === "building") building++;
      else if (p.signalState === "watch") watch++;
      else monitor++;
    }
    console.log(
      `[MLB_BOXSCORE_ENGINE_STATE] gameId=${gameId} total=${players.length} strong=${strong} building=${building} watch=${watch} monitor=${monitor} surfaced=${players.filter(p => p.surfaced).length}`
    );

    // Per-tuple canonical lookup: every (player, market, line) signal in the
    // cache, resolved through the SAME canonical resolver the calculator uses.
    // The client uses this to render rotating per-play badges with the same
    // numbers the calculator panel would show — no per-row API calls needed.
    const canonicalSignals = all
      .map((sig) => {
        const c = resolveMlbPlayerMarketSignal({
          gameId,
          playerId: sig.playerId,
          market: sig.market as string,
          line: sig.line ?? undefined,
        });
        if (!c) return null;
        return {
          playerId: c.playerId,
          market: c.market,
          line: c.line,
          recommendedSide: c.recommendedSide,
          overProbability: c.overProbability,
          underProbability: c.underProbability,
          engineConfidence: c.engineConfidence,
          signalState: c.signalState,
          source: c.source,
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return res.json({
      mode: "live",
      players,
      canonicalSignals,
      updatedAt: entry.updatedAt ?? 0,
    });
  });

  // TODO: rename to /api/mlb/signal-feed
  app.get("/api/mlb/edge-feed", requireAuth, async (req, res) => {
    try {
      const allSignals: any[] = [];
      const cachedLiveGames = mlbLiveGamesCache.get("games");

      let totalGenerated = 0;
      let totalDropped = 0;
      let totalEdgeCacheEntries = 0;
      let newestUpdatedAt = 0;
      const feedTagDist: Record<string, number> = {};

      for (const [gid, edgeEntry] of Array.from(mlbEdgeCache.entries())) {
        totalEdgeCacheEntries++;

        // Track newest engine recompute timestamp across all games so the
        // client can detect a real feed advance (Freshness Integrity Fix #2).
        if (edgeEntry.updatedAt > newestUpdatedAt) {
          newestUpdatedAt = edgeEntry.updatedAt;
        }

        // Two-axis freshness check (both must pass):
        //
        //  Axis A — Engine liveness (heartbeat alive):
        //    The orchestrator's 25s heartbeat (P5) writes either a fresh
        //    qualifying cycle (updatedAt = now) or a blank-cycle preservation
        //    tick (preservedAt = now). If neither has happened in the last
        //    ACTIVE_FRESHNESS_MS, the engine is effectively dead — drop the
        //    entry regardless of how recent the last preserve was. Without
        //    this gate, an engine that died right after a preserve would
        //    keep stale signals visible for the full preservation window.
        //
        //  Axis B — Last real qualifying cycle:
        //    Even with the engine actively producing blank-cycle preserves,
        //    cap total signal visibility at PRESERVED_FRESHNESS_MS from the
        //    last cycle that actually qualified signals. This matches the
        //    orchestrator's PRESERVE_MAX_AGE_MS (which prevents the
        //    preserve-loop itself from running past this window).
        //
        //  Net effect:
        //    • Active engine, fresh qualifying cycle → kept (axis A passes
        //      via updatedAt, axis B passes trivially).
        //    • Active engine, in a natural game gap (blank-cycle preserves
        //      every 25s) → kept up to 20 min from last qualifying cycle —
        //      eliminates the flicker the user reported as "signals
        //      just disappear".
        //    • Dead engine (no tick at all in 4 min) → dropped immediately,
        //      even if the last preserve was recent.
        const PRESERVED_FRESHNESS_MS = 20 * 60 * 1000;
        if (!isMLBEdgeEntryFresh(edgeEntry, PRESERVED_FRESHNESS_MS)) {
          totalDropped++;
          continue;
        }

        const game = cachedLiveGames?.games.find((g: any) => g.gameId === gid);
        // Freshness Integrity Fix #2.5 — normalize market keys on BOTH sides
        // of the lookup so an `hr` engine output never silently misses a
        // `home_runs` signal (or vice versa) and disappear from the feed.
        const rawOutputLookup = new Map((edgeEntry.outputs ?? []).map((o: any) => [`${o.playerId}_${normalizeMlbMarketKey(o.market)}`, o]));

        const signalSource = edgeEntry.allSignals ?? edgeEntry.qualifiedSignals ?? [];
        totalGenerated += signalSource.length;

        for (const qs of signalSource) {
          const raw = rawOutputLookup.get(`${qs.playerId}_${normalizeMlbMarketKey(qs.market)}`);
          const gameState = mlbGameCache.gameState[gid];

          for (const ft of (qs.feedTags ?? [])) {
            feedTagDist[ft] = (feedTagDist[ft] ?? 0) + 1;
          }

          const pitcherCtxCache = mlbGameCache.pitcherContext[gid];
          let pitchMixFallback: any = null;
          if (!raw?.pitchMix && !raw?.pitcher?.pitchMix && pitcherCtxCache?.byPitcherId) {
            const firstPitcher = Object.values(pitcherCtxCache.byPitcherId)[0];
            pitchMixFallback = (firstPitcher as any)?.pitchMix ?? null;
          }

          allSignals.push(normalizeMLBSignal(qs, {
            gameId: gid,
            rawOutput: raw ?? null,
            gameState: gameState ?? null,
            game: game ?? null,
            pitchMixFallback,
          }));
        }
      }

      allSignals.sort((a, b) => {
        const aLive = a.liveScore ?? 0;
        const bLive = b.liveScore ?? 0;
        if (aLive !== bLive) return bLive - aLive;
        const aEdge = a.edge ?? 0;
        const bEdge = b.edge ?? 0;
        const aPos = aEdge > 0 ? 1 : 0;
        const bPos = bEdge > 0 ? 1 : 0;
        if (aPos !== bPos) return bPos - aPos;
        return (b.signalScore ?? 0) - (a.signalScore ?? 0);
      });

      console.log(`[MLB EDGE-FEED] edgeCacheEntries=${totalEdgeCacheEntries} total=${allSignals.length} generated=${totalGenerated} droppedStale=${totalDropped} feedTags=${JSON.stringify(feedTagDist)} newestUpdatedAt=${newestUpdatedAt}`);

      // ── LiveLocks Batch D — canonical view-model bridge ──────────────
      // The normalize loop above auto-registered each signal in the bus
      // (sole-ingress contract). Now stamp canonical fields onto the
      // wire-shape payload so the UI reads lifecycleState directly without
      // inferring it from probability/score.
      let enrichedSignals: any[] = allSignals;
      try {
        const { attachCanonicalToMlbSignals } = await import("./services/canonicalSignalViewModel");
        enrichedSignals = attachCanonicalToMlbSignals(allSignals as any, "/api/mlb/edge-feed");
      } catch (bridgeErr) {
        console.warn(`[LL_CANONICAL_VIEWMODEL_BRIDGE] enrichment failed: ${(bridgeErr as Error).message}`);
      }

      // ── Signal-First Surfacing (LiveLocks MLB UX Phase 1) ────────────
      // Optional alternate response shape: ?view=market-signals returns
      // pre-grouped, signal-first MarketSignalViewModel rows used by the
      // new MLB Live Feed surface. Default branch unchanged for back-compat.
      const view = (req.query.view as string | undefined) ?? "default";
      if (view === "market-signals") {
        try {
          const liveSignalBus = await import("./services/liveSignalBus");
          const {
            toMarketSignalViewModel,
            sortMarketSignals,
            groupByDisplayGroup,
            summarizeUnknownInning,
          } = await import("./services/mlbMarketSignalViewModel");
          const { inningWindowMatchesFilter } = await import("../shared/mlbInningWindow");

          const inningWindowParam = (req.query.inningWindow as string | undefined) ?? "all";
          const allowedWindows = ["all", "early", "mid", "late"] as const;
          type AllowedWindow = (typeof allowedWindows)[number];
          const filter: AllowedWindow = (allowedWindows.includes(inningWindowParam as AllowedWindow)
            ? (inningWindowParam as AllowedWindow)
            : "all");

          // Map each MLBSignal to a view model. Canonical lookup via the bus
          // by signalId — the bus is the sole-ingress source of truth.
          const rows = enrichedSignals.map((sig: any) => {
            const signalId = sig?.canonicalSignalId
              ?? `mlb:${sig.gameId}:${sig.playerId}:${sig.market}:${sig.recommendedSide ?? "OVER"}`;
            const canonical = liveSignalBus.getRegisteredById?.(signalId) ?? null;
            return toMarketSignalViewModel(sig, {
              canonical,
              sourceEndpoint: "/api/mlb/edge-feed?view=market-signals",
              silent: true,
            });
          });

          // Inning filter — never drops valid signals; unknown rows pass
          // through under any specific filter (de-prioritized in sort).
          const filtered = rows.filter((r) =>
            inningWindowMatchesFilter(r.inningWindow, filter, true),
          );
          const sorted = sortMarketSignals(filtered);
          const grouped = groupByDisplayGroup(sorted);
          const unknownSummary = summarizeUnknownInning(sorted);

          console.log(
            `[MLB_MARKET_SORT] view=market-signals filter=${filter} total=${sorted.length} ` +
              `actionNow=${grouped.ACTION_NOW.length} building=${grouped.BUILDING.length} ` +
              `monitor=${grouped.MONITOR.length} resolved=${grouped.RESOLVED.length} ` +
              `unknownInning=${unknownSummary.unknownInningCount}`,
          );

          return res.json({
            mode: sorted.length > 0 ? "live" : "monitoring",
            view: "market-signals",
            inningWindow: filter,
            rows: sorted,
            grouped,
            unknownInningCount: unknownSummary.unknownInningCount,
            unknownInningReasons: unknownSummary.unknownInningReasons,
            updatedAt: newestUpdatedAt,
            generatedAt: Date.now(),
            staleCount: totalDropped,
            edgeCacheEntries: totalEdgeCacheEntries,
          });
        } catch (vmErr) {
          console.error(`[MLB_MARKET_VIEWMODEL] market-signals view failed: ${(vmErr as Error).message}`);
          // Fall through to default response so the client never breaks.
        }
      }

      return res.json({
        mode: enrichedSignals.length > 0 ? "live" : "monitoring",
        signals: enrichedSignals,
        updatedAt: newestUpdatedAt,
        generatedAt: Date.now(),
        staleCount: totalDropped,
        edgeCacheEntries: totalEdgeCacheEntries,
      });
    } catch (e: any) {
      console.error("[mlb/edge-feed]", e.message);
      return res.json({ mode: "monitoring", signals: [], updatedAt: 0, generatedAt: Date.now(), staleCount: 0, edgeCacheEntries: 0 });
    }
  });

  // ── Admin: MLB Market Signals Debug ──────────────────────────────
  app.get("/api/admin/mlb-market-signals-debug", requireAdmin, async (_req, res) => {
    try {
      const liveSignalBus = await import("./services/liveSignalBus");
      const {
        toMarketSignalViewModel,
        sortMarketSignals,
        summarizeUnknownInning,
      } = await import("./services/mlbMarketSignalViewModel");

      // Reuse the bus's view of registered MLB signals — the canonical truth.
      const registered = liveSignalBus.getRegistered({ sport: "mlb" }) ?? [];
      const rows = registered.map((canonical: any) => {
        // Synthesize a minimal MLBSignal-shaped object from canonical fields
        // so the view model can run without re-reading mlbEdgeCache.
        // For HR/inning context fall back to canonical fields and
        // sourceRef-tagged inning if present.
        const sigShim: any = {
          playerId: canonical.actorId,
          playerName: canonical.actorName,
          gameId: canonical.gameId,
          market: canonical.market,
          recommendedSide: canonical.side,
          displaySide: canonical.side,
          inning: canonical.inning ?? 0,
          isTopInning: false,
          gameStatus: canonical.gameStatus ?? null,
          enginePct: canonical.displayProbability,
          edge: canonical.edge,
          projection: canonical.projection,
          bookLine: canonical.bookLine,
          confidenceTier: canonical.signalTier?.toUpperCase() ?? "WATCH",
          signalTier: canonical.signalTier,
          overOdds: null,
          underOdds: null,
          awayAbbr: null,
          homeAbbr: null,
          hrAlert: null,
          canonicalDrivers: canonical.drivers ?? [],
          triggerSummary: canonical.triggerSummary ?? null,
        };
        const vm = toMarketSignalViewModel(sigShim, {
          canonical,
          sourceEndpoint: "/api/admin/mlb-market-signals-debug",
          silent: true,
        });
        return {
          ...vm,
          // Admin-only diagnostics envelope
          _debug: {
            canonicalSurfacedAt: canonical.surfacedAt,
            canonicalUpdatedAt: canonical.updatedAt,
            canonicalExpiresAt: canonical.expiresAt,
            lifecycleHistoryLen: canonical.lifecycleHistory?.length ?? 0,
            sourceRefKind: canonical.sourceRef?.kind ?? null,
            reasonSurfaced: vm.marketActionability,
            sourceEndpoint: "bus.getRegistered",
          },
        };
      });
      const sorted = sortMarketSignals(rows);
      const summary = summarizeUnknownInning(sorted);
      return res.json({
        total: sorted.length,
        unknownInningCount: summary.unknownInningCount,
        unknownInningReasons: summary.unknownInningReasons,
        rows: sorted,
        generatedAt: Date.now(),
      });
    } catch (e: any) {
      console.error("[admin/mlb-market-signals-debug]", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── MLB HR Radar Route ───────────────────────────────────────────────────────
  app.get("/api/mlb/hr-radar", requireAuth, async (req, res) => {
    try {
      try { (await import("./services/liveSignalBus")).markLegacyConsumer("/api/mlb/hr-radar"); } catch {}
      const hrEdges: any[] = [];
      const hrWatchlist: any[] = [];

      const cachedLiveGames = mlbLiveGamesCache.get("games");

      // HR Radar Final-Game Reconciliation — Phase 2 API guardrail.
      // Set of game IDs whose status is currently `live` or `pregame`. Edge
      // cache entries from games NOT in this set (i.e. final, suspended,
      // postponed, completed) must NEVER produce active HR Radar cards. The
      // orchestrator's Phase 1 transition gate flushes mlbEdgeCache on
      // live → final, but this gate is the belt-and-suspenders authoritative
      // filter at the request boundary so a stale cache entry can never leak.
      // The same `activeGameIds` set is reused below for the dbAlerts loop.
      const activeGameIds = new Set(cachedLiveGames?.games.filter((g: any) => g.status === "live" || g.status === "pregame").map((g: any) => g.gameId) ?? []);
      // Per-game status map keyed by gameId — used by Phase 3 fixup so the
      // engine can route final-game cards to their resolved buckets.
      const gameStatusByGameId = new Map<string, string>(
        (cachedLiveGames?.games ?? []).map((g: any) => [g.gameId, String(g.status ?? "").toLowerCase()])
      );

      for (const [gid, edgeEntry] of Array.from(mlbEdgeCache.entries())) {
        const FEED_FRESHNESS_MS = 10 * 60 * 1000;
        // Two-axis freshness — same engine-liveness gate as the main edge-feed,
        // but with a tighter 10m signal-age cap appropriate for HR Radar.
        if (!isMLBEdgeEntryFresh(edgeEntry, FEED_FRESHNESS_MS)) continue;

        // HR Radar Final-Game Reconciliation — Phase 2.
        // If the game is no longer active (final/suspended/postponed/etc),
        // skip its edge entry entirely. This prevents stale cache data from
        // surfacing as active FIRE/BUILD/WATCH/READY cards after the game
        // ends. The DB-backed cashed/missed display is unaffected — those
        // rows come from `storage.getCanonicalHrRadarOutcomes()` below.
        if (!activeGameIds.has(gid)) {
          const cardCount = (edgeEntry.allSignals ?? []).filter((s: any) => s.market === "home_runs" && (s.feedTags ?? []).includes("hr_radar")).length;
          if (cardCount > 0) {
            console.log(`[HR_RADAR_FINAL_ACTIVE_FIXUP] gameId=${gid} reason=final_game_in_edge_cache cards=${cardCount}`);
          }
          continue;
        }

        const game = cachedLiveGames?.games.find((g: any) => g.gameId === gid);
        // Freshness Integrity Fix #2.5 — symmetric market-key normalization
        // for the same reason as the live-signals endpoint.
        const rawOutputLookup = new Map((edgeEntry.outputs ?? []).map((o: any) => [`${o.playerId}_${normalizeMlbMarketKey(o.market)}`, o]));
        const gameState = mlbGameCache.gameState[gid];
        const contactCache = mlbGameCache.contactData[gid];
        const weather = mlbGameCache.weather[gid];

        for (const qs of (edgeEntry.allSignals ?? [])) {
          const raw = rawOutputLookup.get(`${qs.playerId}_${normalizeMlbMarketKey(qs.market)}`);
          const isHRMarket = qs.market === "home_runs";
          const playerContact = contactCache?.byPlayerId?.[qs.playerId];

          if (isHRMarket && (qs.feedTags ?? []).includes("hr_radar")) {
            const hrSidedProb = qs.side === "OVER"
              ? (raw?.calibratedProbabilityOver ?? qs.engineProbability ?? 0)
              : (raw?.calibratedProbabilityUnder ?? qs.engineProbability ?? 0);
            const hrQsAny = qs as any;
            hrEdges.push({
              playerId: qs.playerId,
              playerName: qs.playerName,
              team: qs.team,
              market: qs.market,
              side: qs.side,
              line: qs.line,
              projection: qs.projection,
              engineProbability: Math.round(hrSidedProb * 10) / 10,
              edge: raw ? Math.round(raw.edge * 100) / 100 : null,
              signalScore: qs.signalScore,
              confidenceTier: qs.confidenceTier,
              badges: qs.badges ?? [],
              reasons: raw?.explanationBullets ?? qs.reasons ?? [],
              explanationBullets: raw?.explanationBullets ?? qs.reasons ?? [],
              hrFactors: raw?.hrFactors ?? null,
              hrBuildScore: raw?.hrBuildScore ?? null,
              hrIntensity: raw?.hrIntensity ?? null,
              gameId: gid,
              awayAbbr: game?.awayAbbr ?? null,
              homeAbbr: game?.homeAbbr ?? null,
              currentStats: qs.currentStats ?? null,
              lastABContact: qs.lastABContact ?? null,
              drivers: qs.drivers ?? {},
              signalTags: qs.signalTags ?? [],
              actionable: hrQsAny.actionable ?? true,
              alreadyHit: hrQsAny.alreadyHit ?? false,
              stale: hrQsAny.stale ?? false,
              watchlist: false,
              fallbackUsed: hrQsAny.fallbackUsed ?? false,
              overOdds: hrQsAny.overOdds ?? raw?.overOdds ?? null,
              underOdds: hrQsAny.underOdds ?? raw?.underOdds ?? null,
              pitcherName: hrQsAny.pitcherName ?? null,
              pitcherHand: hrQsAny.pitcherHand ?? null,
              inning: hrQsAny.inning ?? gameState?.inning ?? 0,
              formIndicator: qs.formIndicator ? String(qs.formIndicator).toUpperCase() : null,
              isHotHitter: hrQsAny.isHotHitter ?? false,
              hotHitterPeriod: hrQsAny.hotHitterPeriod ?? null,
              hotHitterHrCount: hrQsAny.hotHitterHrCount ?? null,
              mode: (qs as any).mode ?? null,
              hrAlert: (raw as any)?.hrAlertSnapshot ? (() => {
                const s = (raw as any).hrAlertSnapshot;
                return {
                  currentState: s.currentState,
                  hrReadinessScore: s.hrReadinessScore,
                  hrConversionProbabilityRaw: s.hrConversionProbabilityRaw,
                  hrConversionProbabilityCalibrated: s.hrConversionProbabilityCalibrated,
                  remainingPAExpectation: s.remainingPAExpectation,
                  positiveDrivers: s.positiveDrivers,
                  negativeSuppressors: s.negativeSuppressors,
                  cooldownReason: s.cooldownReason,
                  lastStateChangeAt: s.lastStateChangeAt,
                  dataFreshnessMs: s.dataFreshnessMs,
                  peakScore: s.peakScore,
                  peakState: s.peakState,
                  peakAt: s.peakAt,
                  detectedInning: s.detectedInning,
                  currentInning: s.currentInning,
                  pitcherHrVulnerability: s.pitcherHrVulnerability,
                  decayFactor: s.decayFactor,
                  tickCount: s.tickCount,
                  lastRecomputeAt: s.lastRecomputeAt,
                };
              })() : null,
            });
          }

          if (isHRMarket && (qs.feedTags ?? []).includes("hr_watchlist")) {
            const hardHitCount = (playerContact?.priorABResults ?? []).filter(
              (ab: any) => (ab.exitVelocity ?? 0) >= 95
            ).length;
            const wlQsAny = qs as any;

            hrWatchlist.push({
              playerId: qs.playerId,
              playerName: qs.playerName,
              team: qs.team,
              hrProbability: qs.engineProbability,
              hardHitEvents: hardHitCount,
              parkFactor: weather ? 1.0 : null,
              windFactor: weather?.windDirection === "out" ? "favorable" : weather?.windDirection === "in" ? "unfavorable" : "neutral",
              reasons: qs.reasons ?? [],
              gameId: gid,
              awayAbbr: game?.awayAbbr ?? null,
              homeAbbr: game?.homeAbbr ?? null,
              badges: qs.badges ?? [],
              watchlist: true,
              actionable: false,
              fallbackUsed: wlQsAny.fallbackUsed ?? false,
              formIndicator: qs.formIndicator ? String(qs.formIndicator).toUpperCase() : null,
              inning: wlQsAny.inning ?? gameState?.inning ?? 0,
              mode: (qs as any).mode ?? null,
              hrAlert: (raw as any)?.hrAlertSnapshot ? (() => {
                const s = (raw as any).hrAlertSnapshot;
                return {
                  currentState: s.currentState,
                  hrReadinessScore: s.hrReadinessScore,
                  hrConversionProbabilityRaw: s.hrConversionProbabilityRaw,
                  hrConversionProbabilityCalibrated: s.hrConversionProbabilityCalibrated,
                  remainingPAExpectation: s.remainingPAExpectation,
                  positiveDrivers: s.positiveDrivers,
                  negativeSuppressors: s.negativeSuppressors,
                  cooldownReason: s.cooldownReason,
                  pitcherHrVulnerability: s.pitcherHrVulnerability,
                  decayFactor: s.decayFactor,
                  tickCount: s.tickCount,
                };
              })() : null,
            });
          }
        }
      }

      hrEdges.sort((a, b) => (b.signalScore ?? 0) - (a.signalScore ?? 0));
      hrWatchlist.sort((a, b) => (b.hrProbability ?? 0) - (a.hrProbability ?? 0));

      // HR Radar audit fix #1+#2 — race-proof "alreadyHit" using the
      // play-feed-stamped RESOLVED_HR_PLAYERS set, then defense-in-depth
      // resolved-state fixup on every active card. Together these guarantee
      // a player who has already homered cannot appear in the bettable list
      // even if their qualified-signal cache hasn't refreshed yet.
      const { RESOLVED_HR_PLAYERS: RESOLVED_HR_PLAYERS_SET } = await import("./mlb/liveGameOrchestrator");
      const { applyHrRadarResolvedStateFixup: hrRadarFixup } = await import("./mlb/hrRadarSection");

      for (const e of hrEdges) {
        if (!e.alreadyHit && RESOLVED_HR_PLAYERS_SET.has(`${e.gameId}_${e.playerId}`)) {
          e.alreadyHit = true;
          if (e.hrCount == null || e.hrCount === 0) e.hrCount = 1;
          console.log(`[HR_RADAR_RACE_FIX] gameId=${e.gameId} playerId=${e.playerId} player=${e.playerName} reason=resolved_hr_players_stamp`);
        }
      }

      const fixedHrEdges = hrEdges.map((e: any) => {
        const gs = gameStatusByGameId.get(e.gameId);
        const fx = hrRadarFixup(e, { gameId: e.gameId, playerId: e.playerId, gameStatus: gs });
        if (fx.canonicalActive === false && !e.alreadyHit) {
          e.alreadyHit = true;
        }
        // HR Radar audit fix #5 — engine-state belt-and-suspenders. The
        // engine produces `hrAlert.currentState`. Per the engine-as-truth
        // rule: if the engine says CLOSED or COOLED_OFF, the card is not
        // bettable. UI rendering should follow `currentState`; this guard
        // ensures the routing layer agrees with the engine output.
        const engineState = e.hrAlert?.currentState ?? null;
        if (engineState === "CLOSED" && !e.alreadyHit) {
          e.alreadyHit = true;
          console.log(`[HR_RADAR_ENGINE_CLOSED_FILTER] gameId=${e.gameId} playerId=${e.playerId} player=${e.playerName} reason=engine_state_closed`);
        }
        return e;
      });

      const bettable = fixedHrEdges.filter((s: any) => !s.alreadyHit);
      const cashedFromEdge = fixedHrEdges.filter((s: any) => s.alreadyHit);
      const cleanWatchlist = hrWatchlist.filter((w: any) =>
        !cashedFromEdge.some((c: any) => c.playerId === w.playerId) &&
        !RESOLVED_HR_PLAYERS_SET.has(`${w.gameId}_${w.playerId}`)
      );

      const canonical = await storage.getCanonicalHrRadarOutcomes();
      const canonicalHitsByGamePlayer = new Map(canonical.hits.map(h => [`${h.gameId}|${h.playerId}`, h]));

      const { getBatterHrHistory } = await import("./mlb/onlyHomersService");
      const todayStr = todayET();

      for (const c of cashedFromEdge) {
        const canonHit = canonicalHitsByGamePlayer.get(`${c.gameId}|${c.playerId}`);
        if (canonHit) {
          c.hitLabel = canonHit.hitLabel;
          c.hitInning = canonHit.hitInning;
          c.hitHalf = canonHit.hitHalf;
          if (!c.detectedLabel) c.detectedLabel = canonHit.detectedLabel;
          if (c.detectedScore == null) c.detectedScore = canonHit.detectedScore;
          if (c.peakScore == null) c.peakScore = canonHit.peakScore;
          if (!c.alertPath) c.alertPath = canonHit.alertPath;
          if (c.conversionPct == null) c.conversionPct = canonHit.conversionPct;
          if (!c.resolvedAt) c.resolvedAt = canonHit.resolvedAt;
          // Surface authoritative grading fields on edge rows so downstream filter and UI agree.
          c.gradingStatus = (canonHit as any).gradingStatus;
          c.gradingReason = (canonHit as any).gradingReason;
          c.matchedBeforeHr = (canonHit as any).matchedBeforeHr;
          c.fallbackCreated = (canonHit as any).fallbackCreated;
          c.userVisible = (canonHit as any).userVisible;
          c.signalDetectedAt = (canonHit as any).signalDetectedAt;
          c.signalInning = (canonHit as any).signalInning;
          c.signalHalf = (canonHit as any).signalHalf;
          c.hitDetectedAt = (canonHit as any).hitDetectedAt;
        }
        try {
          const hrs = await getBatterHrHistory(c.playerName);
          const todayHr = hrs.find((h: any) => h.gameDate === todayStr);
          if (todayHr) {
            c.onlyHomersVerified = true;
            c.ohExitVelocity = todayHr.exitVelocity != null ? parseFloat(String(todayHr.exitVelocity)) : null;
            c.ohLaunchAngle = todayHr.launchAngle != null ? parseFloat(String(todayHr.launchAngle)) : null;
            c.ohDistance = todayHr.distance != null ? parseFloat(String(todayHr.distance)) : null;
            c.ohPitchType = todayHr.pitchType ?? null;
          }
        } catch {}
      }

      const cashedPlayerIds = new Set(cashedFromEdge.map((c: any) => c.playerId));
      const cashedFromDb = canonical.hits
        .filter(h => !cashedPlayerIds.has(h.playerId))
        .map(h => ({
          playerId: h.playerId,
          playerName: h.playerName,
          team: h.team,
          market: "home_runs",
          side: "OVER",
          gameId: h.gameId,
          signalScore: 0,
          alreadyHit: true,
          watchlist: false,
          actionable: false,
          hitLabel: h.hitLabel,
          hitInning: h.hitInning,
          hitHalf: h.hitHalf,
          detectedLabel: h.detectedLabel,
          detectedScore: h.detectedScore,
          peakScore: h.peakScore,
          alertPath: h.alertPath,
          conversionPct: h.conversionPct,
          resolvedAt: h.resolvedAt,
          triggerTags: h.triggerTags ?? [],
          gradingStatus: h.gradingStatus,
          gradingReason: h.gradingReason,
          matchedBeforeHr: h.matchedBeforeHr,
          fallbackCreated: h.fallbackCreated,
          userVisible: h.userVisible,
          signalDetectedAt: h.signalDetectedAt,
          signalInning: h.signalInning,
          signalHalf: h.signalHalf,
          hitDetectedAt: h.hitDetectedAt,
        }));
      // Spec: cashedToday MUST contain only canonical called_hit rows. Uncalled/late never leak to users.
      const allCashed = [...cashedFromEdge, ...cashedFromDb].filter((c: any) => {
        // If gradingStatus is unknown (no canonical match), exclude — we never surface ungraded "cashed" cards.
        if (!c.gradingStatus) return false;
        return CALLED_HIT_OUTCOME_STATUSES.has(c.gradingStatus) && c.userVisible !== false;
      });

      const dbAlerts = await storage.getTodayHrRadarBoard();
      const cashedPlayerIdSet = new Set([...cashedFromEdge, ...cashedFromDb].map((c: any) => c.playerId));
      const bettablePlayerIdSet = new Set(bettable.map((b: any) => b.playerId));
      const watchlistPlayerIdSet = new Set(cleanWatchlist.map((w: any) => w.playerId));

      // `activeGameIds` is now declared at the top of the handler (Phase 2 guardrail).
      // Reused here for the dbAlerts filter below.

      for (const alert of dbAlerts) {
        if (alert.status === "hit" || alert.status === "miss") continue;
        if (cashedPlayerIdSet.has(alert.playerId)) continue;
        if (!activeGameIds.has(alert.gameId)) continue;
        const score = parseFloat(String(alert.currentReadinessScore ?? alert.initialReadinessScore ?? 0));
        const peakScore = parseFloat(String(alert.peakReadinessScore ?? score));
        const game = cachedLiveGames?.games.find((g: any) => g.gameId === alert.gameId);
        // Phase 9: explicit canonical score contract on user-facing rows.
        // readinessScore (0-100), peakReadinessScore (0-100), conversionProbability (0-1).
        // `signalScore`/`peakScore` retained for backward compat but should be considered deprecated.
        const diagAny: any = alert.diagnosticsSnapshot as any;
        const sc = diagAny?.scoreContract ?? {};
        const conversionProbability = sc.conversionProbability
          ?? diagAny?.hrConversion?.calibratedProbability
          ?? null;
        const conversionProbabilityRaw = sc.conversionProbabilityRaw
          ?? diagAny?.hrConversion?.hrConversionProbability
          ?? null;
        const buildScore = sc.buildScore ?? null;
        const peakConversionProbability = sc.peakConversionProbability ?? null;

        // ── Goldmaster Phase 4–8 — derive canonical user-facing copy from
        // the live engine stage instead of the persisted summaryText (which
        // is whatever was generated at last write and goes stale once stage
        // advances). Mirrors the logic in storage.getHrRadarLadder so the
        // legacy /api/mlb/hr-radar consumers (TopLiveOpportunities, etc.)
        // see the same stage-aligned copy as the canonical ladder.
        const stageContractRow: any = diagAny?.stageContract ?? {};
        const abContextRow: any = diagAny?.abContext ?? {};
        const canonicalStage: "watch" | "building" | "attack" | "cooling" | "closed" | null = (() => {
          const s = stageContractRow.currentCanonicalStage;
          return s === "watch" || s === "building" || s === "attack" || s === "cooling" || s === "closed" ? s : null;
        })();
        const plateAppearancesTracked: number | null =
          typeof abContextRow.plateAppearancesTracked === "number" ? abContextRow.plateAppearancesTracked : null;
        const hasLiveABContext: boolean =
          abContextRow.hasLiveABContext === true ? true
            : (plateAppearancesTracked != null && plateAppearancesTracked > 0);
        // Live row (we already filtered out hit/miss above), so currentStatus is "live".
        const currentStage: "watch" | "building" | "attack" | "cooling" | "closed" =
          canonicalStage ?? (alert.confidenceTier === "strong" ? "attack" : alert.confidenceTier === "building" ? "building" : "watch");
        const stageExplanation = (storage as any).buildHrRadarSummary?.({
          currentStage,
          currentStatus: "live",
          outcome: "pending",
          plateAppearancesTracked,
          hasLiveABContext,
          detectedInning: alert.signalInning ?? alert.detectedInning ?? null,
          detectedHalf: alert.signalHalf ?? alert.detectedHalf ?? null,
          hitInning: null,
          hitHalf: null,
        }) ?? alert.summaryText ?? "";
        const reasonSets = (storage as any).buildHrRadarReasonSets?.(alert, {
          plateAppearancesTracked,
          hasLiveABContext,
        }) ?? { userReasons: [], adminReasons: [] };
        const userReasonsArr: string[] = reasonSets.userReasons ?? [];
        const adminReasonsArr: string[] = reasonSets.adminReasons ?? [];
        // Headline reason (single line) + supporting bullets, both jargon-stripped.
        const headlineReason = userReasonsArr[0] ?? stageExplanation ?? "";
        const supportingReasons = userReasonsArr.slice(1, 5);

        const entry = {
          playerId: alert.playerId,
          playerName: alert.playerName,
          team: alert.team,
          market: "home_runs",
          side: "OVER",
          gameId: alert.gameId,
          signalScore: score,
          // Preserve hrBuildScore's historical 0-10 buildScore contract for
          // downstream mappers (mlbUiMappers.radarScoreToTier, BuildScoreMeter,
          // etc.) which are calibrated on the 0-10 scale. The canonical 0-100
          // readiness lives on `readinessScore` / `currentReadinessScore`.
          hrBuildScore: buildScore,
          // Phase 9: canonical score contract (0-100)
          readinessScore: score,
          peakReadinessScore: peakScore,
          // Phase 1: explicit initial readiness so the modal can render the
          // canonical Initial/Current/Peak triple from one source.
          initialReadinessScore: alert.initialReadinessScore ? parseFloat(alert.initialReadinessScore) : score,
          currentReadinessScore: score,
          buildScore,
          conversionProbability,
          conversionProbabilityRaw,
          peakConversionProbability,
          // Phase 4 — canonical stage label (drives client grouping/copy).
          currentStage,
          // Phase 5/6 — stage-aligned, jargon-stripped copy. Replaces the
          // stale persisted summaryText for user-facing rendering.
          stageExplanation,
          headlineReason,
          supportingReasons,
          // Phase 6 — keep raw engine-path detail accessible for admin only.
          enginePath: { reasons: adminReasonsArr, alertPath: alert.alertPath, alertTier: alert.alertTier },
          // Phase 8 — surface AB context so consumers can gate live-contact UI.
          plateAppearancesTracked,
          hasLiveABContext,
          hrIntensity: alert.confidenceTier === "strong" ? "strong" : alert.confidenceTier === "building" ? "watch" : "weak",
          confidenceTier: alert.confidenceTier === "strong" ? "STRONG" : alert.confidenceTier === "building" ? "SOLID" : "WATCHLIST",
          awayAbbr: game?.awayAbbr ?? null,
          homeAbbr: game?.homeAbbr ?? null,
          inning: alert.detectedInning ?? 0,
          alreadyHit: false,
          watchlist: alert.signalState === "watching",
          actionable: alert.signalState === "actionable" || alert.confidenceTier === "strong",
          alertPath: alert.alertPath,
          alertTier: alert.alertTier,
          triggerTags: alert.triggerTags ?? [],
          // summaryText now mirrors the canonical stageExplanation so any
          // consumer still reading the legacy field sees the right copy.
          summaryText: stageExplanation || alert.summaryText,
          peakScore,
          // ── Goldmaster v1 — additive user-stage enrichment ──────────────
          // Pure surfacing — every legacy field above is preserved as-is.
          // Gated by HR_RADAR_GOLDMASTER_V1: when the flag is OFF the IIFE
          // returns an empty object so no v1-only keys appear on the wire.
          ...(HR_RADAR_GOLDMASTER_V1 ? (() => {
            const v1 = enrichWithUserStage({
              legacyTier: alert.confidenceTier,
              legacyState: alert.signalState,
              dynamicState: stageContractRow?.dynamicState ?? null,
              consecutivePromoteTicks: stageContractRow?.consecutivePromoteTicks ?? null,
              canonicalStage,
              outcome: "pending",
              currentReadinessScore: score,
              peakReadinessScore: peakScore,
              initialReadinessScore: alert.initialReadinessScore ? parseFloat(alert.initialReadinessScore) : score,
              factors: (diagAny?.factors ?? alert.contactSnapshot ?? {}) as any,
              triggerTags: alert.triggerTags ?? [],
              positiveDrivers: (diagAny?.positiveDrivers ?? []) as string[],
              conversionProbability: conversionProbability ?? null,
              confidenceScore: typeof diagAny?.confidenceScore === "number" ? diagAny.confidenceScore : null,
              inning: alert.signalInning ?? alert.detectedInning ?? null,
              detectedAt: alert.detectedAt ?? null,
              detectedInning: alert.detectedInning ?? null,
              signalDetectedAt: alert.signalDetectedAt ?? null,
              signalInning: alert.signalInning ?? null,
              hitDetectedAt: null,
              resolvedAt: null,
              hitInning: null,
              userReasons: userReasonsArr,
              adminReasons: adminReasonsArr,
              alertPath: alert.alertPath ?? null,
              useFallbackScore: true,
              gameId: alert.gameId,
              playerId: alert.playerId,
              player: alert.playerName,
            });
            if (HR_RADAR_GOLDMASTER_V1 && process.env.DEBUG_HR_RADAR_V1 === "true") {
              console.log("[HR_RADAR_V1_TRACE]", JSON.stringify(buildValidationPayload({
                player: alert.playerName, oldStage: currentStage, enrichment: v1,
              })));
            }
            return {
              userStage: v1.userStage,
              stageLabel: v1.stageLabel,
              stageDescription: v1.stageDescription,
              qualifyingSignals: v1.qualifyingSignals,
              cleanReasons: v1.cleanReasons,
              currentSignalScore10: v1.currentSignalScore10,
              initialSignalScore10: v1.initialSignalScore10,
              peakSignalScore10: v1.peakSignalScore10,
              officialSignalStage: v1.officialSignalStage,
              officialSignalAt: v1.officialSignalAt,
              officialSignalInning: v1.officialSignalInning,
              firstTrackedAt: v1.firstTrackedAt,
              firstTrackedInning: v1.firstTrackedInning,
              firstBuiltAt: v1.firstBuiltAt,
              firstBuiltInning: v1.firstBuiltInning,
              firstReadyAt: v1.firstReadyAt,
              firstReadyInning: v1.firstReadyInning,
              firstFireAt: v1.firstFireAt,
              firstFireInning: v1.firstFireInning,
              hrOccurredAt: v1.hrOccurredAt,
              hrOccurredInning: v1.hrOccurredInning,
              debugReasons: v1.debugReasons,
              v1EnginePath: v1.enginePath,
            };
          })() : {}),
          detectedLabel: alert.detectedLabel,
          // Phase 3 — frozen HR event fields kept distinct from detection.
          hitInning: alert.hitInning,
          hitHalf: alert.hitHalf,
          hitLabel: alert.hitLabel,
          diagnosticsSnapshot: alert.diagnosticsSnapshot,
          contactSnapshot: alert.contactSnapshot,
          updatedAt: (alert as any).updatedAt ?? null,
          badges: [],
          // Phase 8 — when no live AB context exists, the reasons feed must
          // not include any live-contact bullets; rely on the stage explanation
          // (which already says "no at-bats yet" in that case).
          reasons: hasLiveABContext ? (userReasonsArr.length > 0 ? userReasonsArr.slice(0, 5) : (stageExplanation ? [stageExplanation] : [])) : (stageExplanation ? [stageExplanation] : []),
          explanationBullets: hasLiveABContext ? (userReasonsArr.length > 0 ? userReasonsArr.slice(0, 5) : (stageExplanation ? [stageExplanation] : [])) : (stageExplanation ? [stageExplanation] : []),
        };

        if (entry.actionable && !bettablePlayerIdSet.has(alert.playerId)) {
          bettable.push(entry);
          bettablePlayerIdSet.add(alert.playerId);
        } else if (!entry.actionable && !watchlistPlayerIdSet.has(alert.playerId)) {
          cleanWatchlist.push(entry);
          watchlistPlayerIdSet.add(alert.playerId);
        }
      }

      // Phase 6: composite dedupe key (sessionDate|gameId|playerId) with tie-breaker.
      // Tie-breaker priority: actionable > higher readiness > higher peak readiness > newer.
      const dedupKey = (r: any) => `${todayStr}|${r.gameId ?? "?"}|${r.playerId}`;
      const cmpRow = (a: any, b: any): number => {
        const aAct = a.actionable ? 1 : 0;
        const bAct = b.actionable ? 1 : 0;
        if (aAct !== bAct) return bAct - aAct;
        const aR = Number(a.signalScore ?? a.hrBuildScore ?? a.detectedScore ?? 0);
        const bR = Number(b.signalScore ?? b.hrBuildScore ?? b.detectedScore ?? 0);
        if (aR !== bR) return bR - aR;
        const aP = Number(a.peakScore ?? a.peakReadinessScore ?? 0);
        const bP = Number(b.peakScore ?? b.peakReadinessScore ?? 0);
        if (aP !== bP) return bP - aP;
        const aT = a.resolvedAt ? new Date(a.resolvedAt).getTime() : 0;
        const bT = b.resolvedAt ? new Date(b.resolvedAt).getTime() : 0;
        return bT - aT;
      };
      const dedupeWith = (rows: any[]): any[] => {
        const map = new Map<string, any>();
        for (const r of rows) {
          const k = dedupKey(r);
          const existing = map.get(k);
          if (!existing || cmpRow(r, existing) < 0) map.set(k, r);
        }
        return Array.from(map.values());
      };
      const dedupBettable = dedupeWith(bettable);
      const dedupWatchlist = dedupeWith(cleanWatchlist);
      const dedupCashed = dedupeWith(allCashed);

      // Phase 9: canonical sort — readiness DESC, peakReadiness DESC, freshest first.
      const sortByContract = (a: any, b: any): number => {
        const ar = Number(a.readinessScore ?? a.signalScore ?? 0);
        const br = Number(b.readinessScore ?? b.signalScore ?? 0);
        if (ar !== br) return br - ar;
        const ap = Number(a.peakReadinessScore ?? a.peakScore ?? 0);
        const bp = Number(b.peakReadinessScore ?? b.peakScore ?? 0);
        if (ap !== bp) return bp - ap;
        const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return bt - at;
      };
      dedupBettable.sort(sortByContract);
      dedupWatchlist.sort(sortByContract);

      // Phase 5 + Goldmaster Detection Ledger Phase 10: explicit
      // outcomeType taxonomy on user-facing rows.
      // called_hit | called_miss | uncalled_hr | late_signal |
      // early_window_hr | post_hr_fallback
      // early_window_hr is its own bucket so 1st-inning HRs with no
      // realistic pre-call window do not pollute uncalled or missed.
      const deriveOutcomeType = (row: any, fallbackStatus: "hit" | "miss"): string => {
        if (row?.gradingStatus === "early_hr_no_window" || row?.gradingStatus === "early_window_hr" || row?.gradingStatus === "early_hr_insufficient_sample") return "early_window_hr";
        if (row?.fallbackCreated) return "post_hr_fallback";
        if (row?.gradingStatus && CALLED_HIT_OUTCOME_STATUSES.has(row.gradingStatus)) return "called_hit";
        if (row?.gradingStatus === "called_miss") return "called_miss";
        if (row?.gradingStatus === "uncalled_hr") return "uncalled_hr";
        if (row?.gradingStatus === "late_signal") return "late_signal";
        return fallbackStatus === "hit" ? "called_hit" : "called_miss";
      };
      const cashedWithType = dedupCashed.map((c: any) => ({ ...c, outcomeType: deriveOutcomeType(c, "hit") }));
      const gradedHitsWithType = canonical.hits.map(h => ({ ...h, outcomeType: deriveOutcomeType(h, "hit") }));
      const gradedMissesWithType = canonical.misses.map(m => ({ ...m, outcomeType: deriveOutcomeType(m, "miss") }));

      console.log(`[MLB_HR_RADAR] bettable=${dedupBettable.length} cashed=${dedupCashed.length} (edge=${cashedFromEdge.length},db=${cashedFromDb.length}) watchlist=${dedupWatchlist.length} dbAlerts=${dbAlerts.length} canonicalHits=${canonical.hits.length} canonicalMisses=${canonical.misses.length}`);

      // Master Fix Step 2 — append canonical lifecycleState/section/
      // outcomeStatus to every wire row so /api/mlb/hr-radar consumers can
      // group by them per Spec Step 16. Pure additive — never replaces the
      // existing `outcomeType`, `gradingStatus`, or `currentStage` fields.
      const { applyHrRadarResolvedStateFixup: fixup } = await import("./mlb/hrRadarSection");
      // HR Radar Final-Game Reconciliation — Phase 5.
      // Stamp `isGameFinal` on every row so the client (HrRadarLadder
      // LadderCard) can hide the `Take it / Pass / ~X PA left / expires after T…`
      // CTAs once a game has gone final, even if a stale cache entry briefly
      // slipped through the Phase 2 guardrail. Also passes `gameStatus` into
      // the fixup so the engine routes final-game cards into the correct
      // resolved bucket regardless of upstream signal slip.
      const stamp = (rows: any[]): any[] =>
        rows.map((r) => {
          const gid = r?.gameId ?? r?.game_id;
          const gs = gid ? gameStatusByGameId.get(gid) : undefined;
          const isGameFinal = gs ? (gs === "final" || gs === "completed" || gs === "game_over") : false;
          const fixed = fixup(r, { gameId: gid, playerId: r?.playerId ?? r?.player_id, gameStatus: gs }) as any;
          fixed.isGameFinal = isGameFinal;
          return fixed;
        });

      return res.json({
        bettableHR: stamp(dedupBettable),
        hrWatchlist: stamp(dedupWatchlist),
        hrEdges,
        cashedToday: stamp(cashedWithType),
        activity: stamp(cashedWithType),
        gradedHits: stamp(gradedHitsWithType),
        gradedMisses: stamp(gradedMissesWithType),
        gradingSummary: canonical.summary,
      });
    } catch (e: any) {
      console.error("[mlb/hr-radar]", e.message);
      return res.json({ bettableHR: [], hrEdges: [], hrWatchlist: [], cashedToday: [], gradedHits: [], gradedMisses: [] });
    }
  });

  app.get("/api/mlb/hr-radar-grading-history", requireAuth, async (req, res) => {
    try {
      const days = Math.min(parseInt(String(req.query.days ?? "14"), 10) || 14, 30);
      const history = await storage.getHrRadarGradingHistory(days);
      return res.json({ history });
    } catch (e: any) {
      console.error("[mlb/hr-radar-grading-history]", e.message);
      return res.json({ history: [] });
    }
  });

  // Phase 5 — admin-only calibration endpoint. Returns last N uncalled-HR
  // rows (uncalled_hr + early_hr_insufficient_sample + legacy alias) so the
  // admin panel can review what the engine missed and why. Read-only; no
  // grading-history mutations. Limited to 7 days back, 50 rows by default.
  app.get("/api/admin/hr-radar/uncalled", requireAdmin, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? "50"), 10) || 50));
      const days = Math.max(1, Math.min(30, parseInt(String(req.query.days ?? "7"), 10) || 7));
      const rows = await (storage as any).getUncalledHrReview(limit, days);
      return res.json({ rows });
    } catch (e: any) {
      console.error("[admin/hr-radar/uncalled]", e.message);
      return res.status(500).json({ rows: [], error: "fetch_failed" });
    }
  });

  app.get("/api/mlb/hr-radar-grading/:sessionDate", requireAuth, async (req, res) => {
    try {
      const sessionDate = String(req.params.sessionDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
        return res.status(400).json({ error: "Invalid date format" });
      }
      const canonical = await storage.getCanonicalHrRadarOutcomes(sessionDate);
      return res.json({
        sessionDate,
        gradedHits: canonical.hits,
        gradedMisses: canonical.misses,
        gradingSummary: canonical.summary,
      });
    } catch (e: any) {
      console.error("[mlb/hr-radar-grading]", e.message);
      return res.json({ gradedHits: [], gradedMisses: [], gradingSummary: { wins: 0, losses: 0, totalGraded: 0, hitRate: 0 } });
    }
  });

  // ── HR Radar Decision Ladder (Phase 2 of HR ledger spec) ──
  // Returns today's HR radar bucketed into 5 user-facing sections:
  // attackNow | building | watch | cashed | dead.
  // Phase 8: Detection coverage analytics (admin-only).
  app.get("/api/mlb/admin/hr-radar/coverage", requireAdmin, async (req, res) => {
    try {
      const daysBack = req.query.daysBack ? Math.max(1, Math.min(60, parseInt(String(req.query.daysBack), 10) || 7)) : 7;
      const metrics = await (storage as any).getHrRadarCoverageMetrics(daysBack);
      return res.json(metrics);
    } catch (e: any) {
      console.error("[mlb/admin/hr-radar/coverage]", e.message);
      return res.status(500).json({ error: "coverage_metrics_unavailable", message: e.message });
    }
  });

  app.get("/api/mlb/hr-radar/ladder", requireAuth, async (req, res) => {
    // ── LiveLocks Batch D — HR Radar canonical-aware read ──────────
    // Read bus inventory of HR-Watch-flagged canonicals first; the
    // ladder still sources its FIRE/READY/BUILDING buckets from the
    // engine via storage.getHrRadarLadder, but we cross-reference
    // canonical lifecycle to suppress duplicates.
    let busHrWatchIds = new Set<string>();
    try {
      const { readBusInventory } = await import("./services/canonicalSignalViewModel");
      const inv = readBusInventory({ route: "/api/mlb/hr-radar/ladder", excludeTerminal: true });
      for (const item of inv) {
        const drv = item.canonical.drivers ?? [];
        const isHrWatch = drv.some((d) => /hr.?watch|near.?hr/i.test(d?.label ?? ""));
        if (isHrWatch) busHrWatchIds.add(`${item.canonical.actorId}:${item.canonical.gameId}`);
      }
      console.log(`[LL_HR_RADAR_CANONICAL_READ] busInventory=${inv.length} hrWatchInBus=${busHrWatchIds.size}`);
      console.log(`[LL_HR_RADAR_LIFECYCLE_SYNC] sync={total:${inv.length}}`);
    } catch (e) {
      console.warn(`[LL_HR_RADAR_CANONICAL_READ] bus read failed: ${(e as Error).message}`);
    }
    // Helper — count live MLB games right now from the orchestrator cache.
    // Used purely for diagnostics on the response so an empty radar can be
    // explained ("0 live games" vs "live games but 0 candidates"). Never
    // affects bucket contents.
    const countLiveMlbGames = (): number => {
      try {
        const states = (mlbGameCache as any)?.gameState ?? {};
        let n = 0;
        for (const gid of Object.keys(states)) {
          const raw = (states[gid] as any)?.status ?? (states[gid] as any)?.detailedState ?? "";
          if (normalizeMlbStatus(String(raw)) === "live") n++;
        }
        return n;
      } catch {
        return 0;
      }
    };
    try {
      const sessionDate = typeof req.query.sessionDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.sessionDate)
        ? req.query.sessionDate
        : undefined;
      const ladder = await storage.getHrRadarLadder(sessionDate);
      // HR Radar Final-Game Reconciliation — Phase 5.
      // Stamp `isGameFinal` on every LadderCard so the client can hide the
      // CTAs (Take it / Pass / ~X PA left / expires after T…) once a game
      // has gone final. Storage layer doesn't import the orchestrator's
      // status-normalizer, so we do the join here at the request boundary.
      try {
        const gameStates = (mlbGameCache as any)?.gameState ?? {};
        const finalGameIds = new Set<string>();
        for (const gid of Object.keys(gameStates)) {
          const raw = (gameStates[gid] as any)?.status ?? (gameStates[gid] as any)?.detailedState ?? "";
          const norm = normalizeMlbStatus(String(raw));
          if (norm === "final") finalGameIds.add(gid);
        }
        const ladderSections = (ladder as any)?.sections ?? {};
        for (const bucket of Object.values(ladderSections) as any[]) {
          if (!Array.isArray(bucket)) continue;
          for (const card of bucket) {
            if (card && typeof card === "object") {
              card.isGameFinal = finalGameIds.has(card.gameId);
            }
          }
        }
      } catch {
        // best-effort — clients fall back to existing isResolved logic.
      }
      // Master Fix Phase 6/8 — additive diagnostics block. Lets the empty
      // state on the client (and any operator/admin probe) honestly report
      // why the radar is empty: was it 0 live games, 0 rows in DB, or both?
      // Only adds a key — never replaces or removes existing payload fields.
      const sections = (ladder as any)?.sections ?? {};
      const rowsFound =
        (sections.attackNow?.length ?? 0) +
        (sections.ready?.length ?? 0) +
        (sections.building?.length ?? 0) +
        (sections.watch?.length ?? 0) +
        (sections.cashed?.length ?? 0) +
        (sections.dead?.length ?? 0);
      const liveGamesFound = countLiveMlbGames();

      // ── Phase 2.5 HR Watch Bridge ───────────────────────────────────────
      // Surface near-HR contact detections (signalType="hr_watch") into the
      // ladder response as an additive `hrWatch` array so the UI can render
      // them WITHOUT touching the canonical engine ladder buckets. Pure
      // read of the in-memory cache; no engine recompute, no math change.
      const hrWatchEntries: Array<{
        playerId: string;
        playerName: string;
        team: string | null;
        gameId: string;
        market: string;
        signalScore: number | null;
        signalTier: string | null;
        nearHrEv: number | null;
        nearHrLa: number | null;
        nearHrDistance: number | null;
        nearHrXba: number | null;
        engineGeneratedAt: number | null;
      }> = [];
      const hrWatchSeen = new Set<string>(); // dedupe key: playerId:gameId
      try {
        for (const [, entry] of Array.from(mlbEdgeCache.entries())) {
          if (!isMLBEdgeEntryFresh(entry, 20 * 60 * 1000)) continue;
          for (const sig of (entry.qualifiedSignals ?? []) as any[]) {
            const isHrWatch = sig.signalType === "hr_watch" || sig.mode === "hr_watch" || sig.signalMode === "hr_watch";
            if (!isHrWatch) continue;
            const dedupeKey = `${sig.playerId}:${sig.gameId ?? entry.gameId}`;
            if (hrWatchSeen.has(dedupeKey)) {
              console.log(`[LL_HR_RADAR_DUPLICATE_BLOCKED] playerId=${sig.playerId} gameId=${sig.gameId ?? entry.gameId}`);
              continue;
            }
            hrWatchSeen.add(dedupeKey);
            const drv = (sig.drivers ?? {}) as Record<string, number>;
            hrWatchEntries.push({
              playerId: String(sig.playerId ?? ""),
              playerName: String(sig.playerName ?? ""),
              team: sig.team ?? null,
              gameId: String(sig.gameId ?? entry.gameId),
              market: String(sig.market ?? ""),
              signalScore: typeof sig.signalScore === "number" ? sig.signalScore : null,
              signalTier: sig.signalTier ?? sig.confidenceTier ?? null,
              nearHrEv: typeof drv.nearHrEv === "number" ? drv.nearHrEv : null,
              nearHrLa: typeof drv.nearHrLa === "number" ? drv.nearHrLa : null,
              nearHrDistance: typeof drv.nearHrDistance === "number" ? drv.nearHrDistance : null,
              nearHrXba: typeof drv.nearHrXba === "number" ? drv.nearHrXba : null,
              engineGeneratedAt: typeof sig.engineGeneratedAt === "number" ? sig.engineGeneratedAt : null,
            });
          }
        }
      } catch (err) {
        console.warn("[mlb/hr-radar/ladder] hrWatch bridge failed:", (err as any)?.message);
      }
      (ladder as any).hrWatch = hrWatchEntries;

      (ladder as any).diagnostics = {
        sessionDate: (ladder as any).sessionDate,
        rowsFound,
        liveGamesFound,
        hrWatchCount: hrWatchEntries.length,
        fallbackRowsGenerated: 0,
        source: rowsFound > 0 ? "engine" : (liveGamesFound > 0 ? "engine_no_candidates" : "no_live_games"),
        generatedAt: new Date().toISOString(),
      };
      return res.json(ladder);
    } catch (e: any) {
      console.error("[mlb/hr-radar/ladder]", e.message);
      return res.json({
        sessionDate: "",
        sections: { attackNow: [], building: [], watch: [], cashed: [], dead: [] },
        counts: { attackNow: 0, building: 0, watch: 0, cashed: 0, dead: 0, total: 0 },
        diagnostics: {
          sessionDate: "",
          rowsFound: 0,
          liveGamesFound: countLiveMlbGames(),
          fallbackRowsGenerated: 0,
          source: "error",
          error: e?.message ?? String(e),
          generatedAt: new Date().toISOString(),
        },
      });
    }
  });

  // Goldmaster Phase 10 — validation harness. Runs the canonical-entity
  // invariant checks against the current ladder payload and returns a
  // machine-readable report. Returns 200 with violations:[] when clean so it
  // can be polled cheaply by an external monitor.
  app.get("/api/mlb/hr-radar/ladder/validate", requireAuth, async (req, res) => {
    try {
      const { validateHrRadarLadder } = await import("./validation/hrRadar/ladderInvariants");
      const sessionDate = typeof req.query.sessionDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.sessionDate)
        ? req.query.sessionDate
        : undefined;
      const ladder = await storage.getHrRadarLadder(sessionDate);
      const report = validateHrRadarLadder(ladder);
      return res.json({
        sessionDate: ladder.sessionDate,
        ok: report.violations.length === 0,
        ...report,
      });
    } catch (e: any) {
      console.error("[mlb/hr-radar/ladder/validate]", e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── HR Radar Share Card ──────────────────────────────────────────────────
  // Returns a PNG image directly — no URL, no OG scraping — so Twitter shows
  // the card as a native image upload rather than a link card.
  app.get("/api/mlb/hr-radar/share-card", requireAuth, async (req, res) => {
    try {
      const q = req.query as Record<string, string>;
      const playerName   = String(q.playerName  ?? "").trim().slice(0, 60);
      const team         = String(q.team         ?? "").trim().slice(0, 40);
      const stage        = String(q.stage        ?? "track").trim();
      const score10      = q.score10      != null ? parseFloat(q.score10)      : null;
      const readinessPct = q.readinessPct != null ? parseFloat(q.readinessPct) : null;
      const hrProbPct    = q.hrProbPct    != null ? parseFloat(q.hrProbPct)    : null;
      const headline     = q.headline     ? String(q.headline).trim().slice(0, 120) : null;
      const buildScore   = q.buildScore   != null ? parseFloat(q.buildScore)   : null;
      const pitcherVuln  = q.pitcherVuln  != null ? parseFloat(q.pitcherVuln)  : null;

      if (!playerName) return res.status(400).json({ error: "playerName required" });

      const { generateHrShareCardPng } = await import("./mlb/hrShareCard");
      const buf = await generateHrShareCardPng({ playerName, team, stage, score10, readinessPct, hrProbPct, headline, buildScore, pitcherVuln });

      res.set({ "Content-Type": "image/png", "Cache-Control": "no-store" });
      return res.send(buf);
    } catch (e: any) {
      console.error("[hr-radar/share-card]", e.message);
      return res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/mlb/hr-radar-board", requireAuth, async (req, res) => {
    try {
      const board = await storage.getTodayHrRadarBoard();
      // HR Radar Master Fix Step 2 + 14 — apply canonical lifecycle/section/
      // outcomeStatus + resolved-state fixup + dedupe (resolved record wins)
      // before any further enrichment. Pure additive fields; never replaces
      // legacy `status` / `gradingStatus` / `currentStage`.
      const { applyHrRadarResolvedStateFixup, dedupeHrRadarRecords } = await import("./mlb/hrRadarSection");
      // ── Goldmaster v1 — additive per-row enrichment. The board API was
      // previously a thin pass-through of hrRadarAlerts rows; we keep every
      // legacy field and append userStage/scoreToScore10/qualifyingSignals
      // /first*At/officialSignal* so clients can opt-in without breaking.
      const enrichRow = (r: any) => {
        const diag = (r.diagnosticsSnapshot ?? {}) as any;
        const stage = diag?.stageContract ?? {};
        const canonicalStage = stage?.currentCanonicalStage ?? null;
        const grading = r.gradingStatus ?? "active";
        const outcome =
          CALLED_HIT_OUTCOME_STATUSES.has(grading) ? "called_hit" :
          grading === "called_miss" ? "miss" :
          grading === "uncalled_hr" ? "uncalled_hr" :
          grading === "late_signal" ? "late_signal" :
          grading === "early_window_hr" || grading === "early_hr_no_window" || grading === "early_hr_insufficient_sample" ? "early_window_hr" :
          r.status === "hit" ? "called_hit" :
          "pending";
        const v1 = enrichWithUserStage({
          legacyTier: r.confidenceTier,
          legacyState: r.signalState,
          dynamicState: stage?.dynamicState ?? null,
          consecutivePromoteTicks: stage?.consecutivePromoteTicks ?? null,
          canonicalStage,
          outcome,
          currentReadinessScore: r.currentReadinessScore != null ? parseFloat(r.currentReadinessScore) : null,
          peakReadinessScore: r.peakReadinessScore != null ? parseFloat(r.peakReadinessScore) : null,
          initialReadinessScore: r.initialReadinessScore != null ? parseFloat(r.initialReadinessScore) : null,
          factors: (diag?.factors ?? r.contactSnapshot ?? {}) as any,
          triggerTags: r.triggerTags ?? [],
          positiveDrivers: (diag?.positiveDrivers ?? []) as string[],
          conversionProbability: typeof diag?.scoreContract?.conversionProbability === "number" ? diag.scoreContract.conversionProbability : null,
          confidenceScore: typeof diag?.confidenceScore === "number" ? diag.confidenceScore : null,
          inning: r.signalInning ?? r.detectedInning ?? null,
          detectedAt: r.detectedAt ?? null,
          detectedInning: r.detectedInning ?? null,
          signalDetectedAt: r.signalDetectedAt ?? null,
          signalInning: r.signalInning ?? null,
          hitDetectedAt: r.hitDetectedAt ?? null,
          resolvedAt: r.resolvedAt ?? null,
          hitInning: r.hitInning ?? null,
          userReasons: [],
          adminReasons: [],
          alertPath: r.alertPath ?? null,
          useFallbackScore: true,
          gameId: r.gameId,
          playerId: r.playerId,
          player: r.playerName,
        });
        return { ...r, ...v1 };
      };
      const enrichedRaw = HR_RADAR_GOLDMASTER_V1 ? board.map(enrichRow) : board;
      // Master Fix Step 2 — surface canonical lifecycleState/section/
      // outcomeStatus/active on every board row so clients can group by them
      // (Spec Step 16) without reverse-engineering currentStage + gradingStatus.
      const enrichedWithCanonical = enrichedRaw.map((r: any) =>
        applyHrRadarResolvedStateFixup(
          { ...r, hrCount: r.status === "hit" ? 1 : 0 },
          { gameId: r.gameId, playerId: r.playerId },
        ),
      );
      // Master Fix Step 14 — dedupe by sessionDate/gameId/playerId. Resolved
      // record always wins. Defense-in-depth — getTodayHrRadarBoard already
      // collapses rows but a stale duplicate must never sneak through.
      const enriched = dedupeHrRadarRecords(enrichedWithCanonical as any[]);
      const live = enriched.filter((a: any) => a.status === "live");
      const hits = enriched.filter((a: any) => a.status === "hit");
      const misses = enriched.filter((a: any) => a.status === "miss");
      return res.json({ board: enriched, live, hits, misses, total: enriched.length });
    } catch (e: any) {
      console.error("[mlb/hr-radar-board]", e.message);
      return res.json({ board: [], live: [], hits: [], misses: [], total: 0 });
    }
  });

  app.get("/api/mlb/hr-radar-analyze/:playerId/:gameId", requireAuth, async (req, res) => {
    try {
      try { (await import("./services/liveSignalBus")).markLegacyConsumer("/api/mlb/hr-radar-analyze"); } catch {}
      const playerId = String(req.params.playerId);
      const gameId = String(req.params.gameId);
      const sourceResult = await storage.getHrRadarAnalyzeSource(playerId, gameId);
      if (!sourceResult) return res.status(404).json({ error: "Alert not found" });
      const { source, alert } = sourceResult;

      const contactCache = mlbGameCache.contactData?.[gameId];
      const playerContact = contactCache?.byPlayerId?.[playerId];
      const gameState = mlbGameCache.gameState?.[gameId];
      const boxPlayer = mlbGameCache.gameBoxScore?.[gameId]?.byPlayerId?.[playerId];

      // Live RAM cache is volatile — for finished games or after a restart it
      // can be empty even though the at-bats actually happened. Fall back to
      // the persisted gamePlayerStats.abResults JSON so the at-bat log keeps
      // populating EV/LA/distance/outcome instead of showing blank "PA" rows.
      let resolvedPriorABs: any[] = playerContact?.priorABResults ?? [];
      let priorABSource: "live_cache" | "persisted" | "none" = resolvedPriorABs.length > 0 ? "live_cache" : "none";
      if (resolvedPriorABs.length === 0) {
        try {
          const persistedStats = await storage.getGamePlayerStats(gameId);
          const playerRow = persistedStats.find((r: any) => String(r.playerId) === String(playerId));
          if (playerRow?.abResults) {
            const parsed = JSON.parse(playerRow.abResults);
            if (Array.isArray(parsed) && parsed.length > 0) {
              resolvedPriorABs = parsed;
              priorABSource = "persisted";
            }
          }
        } catch (err: any) {
          console.warn(`[mlb/hr-radar-analyze] persisted abResults parse failed for ${playerId}/${gameId}: ${err.message}`);
        }
      }

      const contactEntries = (resolvedPriorABs ?? []).map((ab: any, idx: number) => ({
        abNumber: idx + 1,
        exitVelocity: ab.exitVelocity ?? null,
        launchAngle: ab.launchAngle ?? null,
        distance: ab.distance ?? null,
        outcome: ab.outcome ?? "unknown",
        pitchType: ab.pitchType ?? null,
        pitchSpeed: ab.pitchSpeed ?? null,
        isBarrel: isCanonicalBarrel(ab.exitVelocity ?? null, ab.launchAngle ?? null),
        isHardHit: (ab.exitVelocity ?? 0) >= 95,
        perABxBA: ab.perABxBA ?? null,
        contactGrade: ab.contactGrade ?? null,
        hrProbability: ab.hrProbability ?? 0,
      }));

      const boxAB = boxPlayer?.ab ?? 0;
      const boxBB = boxPlayer?.bb ?? 0;
      const totalPA = boxAB + boxBB;
      const priorABs = [...contactEntries];
      if (totalPA > priorABs.length) {
        const missing = totalPA - priorABs.length;
        for (let i = 0; i < missing; i++) {
          priorABs.push({
            abNumber: priorABs.length + 1,
            exitVelocity: null,
            launchAngle: null,
            distance: null,
            outcome: "unknown",
            pitchType: null,
            pitchSpeed: null,
            isBarrel: false,
            isHardHit: false,
            perABxBA: null,
            contactGrade: null,
            hrProbability: 0,
          });
        }
      }

      const edgeEntry = mlbEdgeCache.get(gameId);
      const rawOutput = edgeEntry?.outputs?.find((o: any) => o.playerId === playerId && o.market === "home_runs");

      // Distinguish "no AB yet" (early in game, expected empty contact data)
      // from genuinely missing/expired caches. Only mark partial when caches
      // are truly empty AND the player has actually had completed at-bats.
      const noAbsYet = boxAB === 0 && priorABs.length === 0;
      const partial = !noAbsYet && priorABs.length === 0 && !rawOutput && !gameState;
      const partialReason = partial
        ? "cache_expired"
        : noAbsYet
          ? "no_abs_yet"
          : null;
      return res.json({
        alert,
        source,
        partial,
        partialReason,
        analyze: {
          priorABs,
          priorABSource,
          completedAB: boxAB,
          totalPA,
          currentInning: gameState?.inning ?? null,
          isTopInning: gameState?.isTopInning ?? null,
          hrFactors: rawOutput?.hrFactors ?? null,
          hrBuildScore: rawOutput?.hrBuildScore ?? null,
          hrIntensity: rawOutput?.hrIntensity ?? null,
          explanationBullets: rawOutput?.explanationBullets ?? [],
        },
      });
    } catch (e: any) {
      console.error("[mlb/hr-radar-analyze]", e.message);
      return res.status(500).json({ error: "Failed to load analyze data" });
    }
  });

  app.get("/api/admin/hr-radar-grading-breakdown", requireAdmin, async (req, res) => {
    try {
      const sessionDate = req.query.sessionDate ? String(req.query.sessionDate) : todayET();
      const allRows = await storage.getTodayHrRadarBoardForSession(sessionDate);
      const byStatus: Record<string, number> = {};
      const byInning: Record<string, { calledHit: number; calledMiss: number; uncalled: number; late: number }> = {};
      let avgInningsToHr = 0;
      let calledHitWithTiming = 0;
      for (const r of allRows) {
        byStatus[r.gradingStatus] = (byStatus[r.gradingStatus] ?? 0) + 1;
        const inn = (r.signalInning ?? r.detectedInning ?? r.hitInning ?? 0).toString();
        if (!byInning[inn]) byInning[inn] = { calledHit: 0, calledMiss: 0, uncalled: 0, late: 0 };
        if (CALLED_HIT_OUTCOME_STATUSES.has(r.gradingStatus as any)) byInning[inn].calledHit++;
        else if (r.gradingStatus === "called_miss") byInning[inn].calledMiss++;
        else if (r.gradingStatus === "uncalled_hr") byInning[inn].uncalled++;
        else if (r.gradingStatus === "late_signal") byInning[inn].late++;
        if (CALLED_HIT_OUTCOME_STATUSES.has(r.gradingStatus as any) && r.signalInning != null && r.hitInning != null) {
          avgInningsToHr += (r.hitInning - r.signalInning);
          calledHitWithTiming++;
        }
      }
      // Sum across the canonical hit-class set (tiered called_hit_* AND
      // called_near_hr) so new hit-class outcomes are counted in the summary.
      const calledHits = Object.entries(byStatus)
        .filter(([gs]) => CALLED_HIT_OUTCOME_STATUSES.has(gs as any))
        .reduce((sum, [, n]) => sum + n, 0);
      const calledMisses = byStatus["called_miss"] ?? 0;
      const uncalled = byStatus["uncalled_hr"] ?? 0;
      const late = byStatus["late_signal"] ?? 0;
      // Goldmaster Detection Ledger Phase 10 — early-window HRs are
      // exempt from cashed/missed/uncalled trust metrics.
      const earlyWindow = (byStatus["early_hr_no_window"] ?? 0) + (byStatus["early_window_hr"] ?? 0) + (byStatus["early_hr_insufficient_sample"] ?? 0);
      const totalCalls = calledHits + calledMisses;
      const totalHrs = calledHits + uncalled + late; // earlyWindow excluded by design
      return res.json({
        sessionDate,
        byStatus,
        byInning,
        summary: {
          calledHits, calledMisses, uncalledHrs: uncalled, lateSignals: late, earlyWindowHrs: earlyWindow,
          calledHitRate: totalCalls > 0 ? Math.round((calledHits / totalCalls) * 1000) / 10 : 0,
          callCoverageOfHrs: totalHrs > 0 ? Math.round((calledHits / totalHrs) * 1000) / 10 : 0,
          missedDetectionRate: totalHrs > 0 ? Math.round(((uncalled + late) / totalHrs) * 1000) / 10 : 0,
          avgInningsFromSignalToHr: calledHitWithTiming > 0 ? Math.round((avgInningsToHr / calledHitWithTiming) * 10) / 10 : null,
        },
      });
    } catch (e: any) {
      console.error("[admin/hr-radar-grading-breakdown]", e.message);
      return res.status(500).json({ error: "Failed to load grading breakdown" });
    }
  });

  app.get("/api/admin/hr-radar-analytics", requireAdmin, async (req, res) => {
    try {
      const { sessionDate, playerId, team, result, confidenceTier, limit } = req.query;
      const records = await storage.getHrRadarAnalytics({
        sessionDate: sessionDate ? String(sessionDate) : undefined,
        playerId: playerId ? String(playerId) : undefined,
        team: team ? String(team) : undefined,
        result: result ? String(result) : undefined,
        confidenceTier: confidenceTier ? String(confidenceTier) : undefined,
        limit: limit ? parseInt(String(limit)) : 200,
      });

      // Audit fix F3 — only `hit`/`miss` are graded outcomes. Every other
      // terminal status (expired / uncalled_hr / early_hr_insufficient_sample /
      // unresolved …) is "ungraded context" and must NOT silently count as a
      // loss. Hit rate is graded-only: hits / (hits + misses).
      const totalHits = records.filter(r => r.result === "hit").length;
      const totalMisses = records.filter(r => r.result === "miss").length;
      const ungraded = records.length - totalHits - totalMisses;
      const graded = totalHits + totalMisses;
      const hitRate = graded > 0 ? Math.round((totalHits / graded) * 1000) / 10 : 0;

      return res.json({
        records,
        summary: { total: records.length, hits: totalHits, misses: totalMisses, ungraded, hitRate },
      });
    } catch (e: any) {
      console.error("[admin/hr-radar-analytics]", e.message);
      return res.json({ records: [], summary: { total: 0, hits: 0, misses: 0, ungraded: 0, hitRate: 0 } });
    }
  });

  // ── OnlyHomers Data API ────────────────────────────────────────────────────────
  app.get("/api/mlb/onlyhomers/stats", requireAuth, async (_req, res) => {
    try {
      const { getHrOutcomeStats } = await import("./mlb/onlyHomersService");
      const stats = await getHrOutcomeStats();
      return res.json(stats);
    } catch (e: any) {
      console.error("[onlyhomers/stats]", e.message);
      return res.json({ totalHrs2026: 0, totalHrs2025: 0, uniqueBatters: 0, topBallpark: null, lastScrapeDate: null });
    }
  });

  app.get("/api/mlb/onlyhomers/hot-hitters", requireAuth, async (req, res) => {
    try {
      const period = String(req.query.period || "7d");
      const { getHotHitters } = await import("./mlb/onlyHomersService");
      const hitters = await getHotHitters(period);
      return res.json({ hitters, period });
    } catch (e: any) {
      console.error("[onlyhomers/hot-hitters]", e.message);
      return res.json({ hitters: [], period: "7d" });
    }
  });

  app.get("/api/mlb/onlyhomers/batter/:name", requireAuth, async (req, res) => {
    try {
      const { getBatterHrHistory } = await import("./mlb/onlyHomersService");
      const history = await getBatterHrHistory(decodeURIComponent(req.params.name as string));
      return res.json({ batterName: req.params.name, history });
    } catch (e: any) {
      console.error("[onlyhomers/batter]", e.message);
      return res.json({ batterName: req.params.name, history: [] });
    }
  });

  app.get("/api/mlb/onlyhomers/bvp/:batter/:pitcher", requireAuth, async (req, res) => {
    try {
      const { getBatterVsPitcherHrHistory } = await import("./mlb/onlyHomersService");
      const history = await getBatterVsPitcherHrHistory(
        decodeURIComponent(req.params.batter as string),
        decodeURIComponent(req.params.pitcher as string)
      );
      return res.json({ batter: req.params.batter, pitcher: req.params.pitcher, history });
    } catch (e: any) {
      console.error("[onlyhomers/bvp]", e.message);
      return res.json({ batter: req.params.batter, pitcher: req.params.pitcher, history: [] });
    }
  });

  app.post("/api/admin/onlyhomers/scrape", requireAdmin, async (req, res) => {
    try {
      const { runFullOnlyHomersScrape, scrapeOnlyHomersDatabase } = await import("./mlb/onlyHomersService");
      const includeHistorical = req.body?.includeHistorical === true;
      await runFullOnlyHomersScrape();
      if (includeHistorical) {
        await scrapeOnlyHomersDatabase(2025);
      }
      return res.json({ success: true, message: includeHistorical ? "Full scrape + 2025 historical done" : "Daily scrape done" });
    } catch (e: any) {
      console.error("[admin/onlyhomers/scrape]", e.message);
      return res.status(500).json({ success: false, message: e.message });
    }
  });

  // ── MLB Manual Calculation Route ─────────────────────────────────────────────
  app.post("/api/mlb/calculate-manual", requireMLBAccess, async (req, res) => {
    try {
      const raw: Record<string, any> = req.body ?? {};

      const safeStr = (key: string, fallback: string = ""): string => {
        const v = raw[key];
        return v != null ? String(v) : fallback;
      };
      const safeFloat = (key: string, fallback: number): number => {
        const v = raw[key];
        if (v == null) return fallback;
        const n = parseFloat(String(v));
        return Number.isFinite(n) ? n : fallback;
      };
      const safeInt = (key: string, fallback: number): number => {
        const v = raw[key];
        if (v == null) return fallback;
        const n = parseInt(String(v), 10);
        return Number.isFinite(n) ? n : fallback;
      };
      const safeBool = (key: string, fallback: boolean = false): boolean => {
        const v = raw[key];
        if (v === true || v === "true") return true;
        if (v === false || v === "false") return false;
        return fallback;
      };

      // Market alias resolution — use the shared canonical normalizer so
      // any inbound key (HRR, h+r+rbi, hr, pitcher_k, outs_recorded, …)
      // routes to the same canonical market the engine + box score use.
      const rawMarket = safeStr("market");
      const resolvedMarket: string = normalizeMlbMarket(rawMarket);
      if (!resolvedMarket || !ALL_MLB_MARKETS.includes(resolvedMarket as MLBMarket)) {
        return res.status(400).json({ error: `Invalid market. Must be one of: ${ALL_MLB_MARKETS.join(", ")}` });
      }
      const market = resolvedMarket as MLBMarket;

      const bookLine = safeFloat("bookLine", NaN);
      if (!Number.isFinite(bookLine) || bookLine <= 0) {
        return res.status(400).json({ error: "bookLine must be a positive number" });
      }

      const currentStats = raw.currentStats && typeof raw.currentStats === "object" ? raw.currentStats as Record<string, unknown> : {};
      const pitcherProps = raw.pitcherProps && typeof raw.pitcherProps === "object" ? raw.pitcherProps as Record<string, unknown> : {};
      const gameContext = raw.gameContext && typeof raw.gameContext === "object" ? raw.gameContext as Record<string, unknown> : {};

      const statsAB = parseInt(String(currentStats.pa ?? currentStats.ab ?? 0), 10) || 0;
      const statsH = parseInt(String(currentStats.hits ?? currentStats.h ?? 0), 10) || 0;
      const statsTB = parseInt(String(currentStats.totalBases ?? currentStats.tb ?? 0), 10) || 0;
      const statsK = parseInt(String(currentStats.k ?? 0), 10) || 0;
      const statsWalks = parseInt(String(currentStats.walks ?? currentStats.bb ?? 0), 10) || 0;

      const inning = parseInt(String(gameContext.inning ?? raw.currentInning ?? 1), 10) || 1;
      const isTopInning = gameContext.isTopInning === true || gameContext.isTopInning === "true" || safeBool("isTopInning", true);
      const battingOrderSlot = parseInt(String(currentStats.battingOrder ?? raw.battingOrderSlot ?? 5), 10) || 5;
      const runners = parseInt(String(gameContext.runners ?? 0), 10) || 0;

      const pitchCount = parseInt(String(pitcherProps.pitchCount ?? 0), 10) || 0;
      const pitcherIP = pitcherProps.ip != null ? parseFloat(String(pitcherProps.ip)) : null;
      const pitcherK = pitcherProps.k != null ? parseInt(String(pitcherProps.k), 10) : null;
      const pitcherHitsAllowed = pitcherProps.hitsAllowed != null ? parseInt(String(pitcherProps.hitsAllowed), 10) : null;
      const pitcherWalks = pitcherProps.walks != null ? parseInt(String(pitcherProps.walks), 10) : null;
      const pitcherHRAllowed = pitcherProps.hrAllowed != null ? parseInt(String(pitcherProps.hrAllowed), 10) : null;
      const pitcherOuts = pitcherIP != null ? Math.floor(pitcherIP) * 3 + Math.round((pitcherIP % 1) * 10) : null;

      const isPitcherMarketManual = market === "pitcher_strikeouts" || market === "hits_allowed" || market === "walks_allowed" || market === "hr_allowed" || market === "pitcher_outs";
      let currentStatValue: number;
      if (isPitcherMarketManual) {
        if (market === "pitcher_strikeouts") currentStatValue = pitcherK != null ? pitcherK : 0;
        else if (market === "hits_allowed") currentStatValue = pitcherHitsAllowed != null ? pitcherHitsAllowed : 0;
        else if (market === "walks_allowed") currentStatValue = pitcherWalks != null ? pitcherWalks : 0;
        else if (market === "hr_allowed") currentStatValue = pitcherHRAllowed != null ? pitcherHRAllowed : 0;
        else currentStatValue = pitcherOuts != null ? pitcherOuts : 0;
      } else {
        if (market === "hits") currentStatValue = statsH;
        else if (market === "total_bases") currentStatValue = statsTB;
        else if (market === "home_runs") currentStatValue = currentStats ? parseInt(String((currentStats as any).hr ?? 0), 10) || 0 : 0;
        else if (market === "hrr") currentStatValue = statsH + (currentStats ? parseInt(String((currentStats as any).rbi ?? 0), 10) || 0 : 0) + (currentStats ? parseInt(String((currentStats as any).r ?? 0), 10) || 0 : 0);
        else if (market === "batter_strikeouts") currentStatValue = statsK;
        else currentStatValue = 0;
      }

      const timesThrough = pitcherIP != null && pitcherIP > 0
        ? Math.floor(pitcherIP / 3) + 1
        : Math.floor(pitchCount / 27) + 1;

      const rawPlayerId = safeStr("playerId");
      const rawPlayerName = safeStr("playerName");
      const rosterPlayer = (rawPlayerId ? getPlayer(rawPlayerId) : null) ?? getPlayerByName(rawPlayerName);
      const resolvedPlayerId = rosterPlayer?.playerId ?? rawPlayerId;
      const resolvedPlayerName = rosterPlayer?.playerName ?? rawPlayerName;
      const resolvedTeam = safeStr("team") || rosterPlayer?.team || "";
      const resolvedBatterHand = rosterPlayer?.bats ?? null;

      const gameId = safeStr("gameId");

      // Canonical short-circuit — when the live engine has a signal for this
      // (gameId, playerId, market[, line]) tuple, return THAT instead of
      // recomputing manually. This guarantees the calculator panel shows
      // the same numbers the box score badge does.
      if (gameId && resolvedPlayerId) {
        const canonical = resolveMlbPlayerMarketSignal({
          gameId,
          playerId: resolvedPlayerId,
          market,
          line: bookLine,
        });
        if (canonical) {
          console.log(`[MLB_CANONICAL_RESOLVE] hit player=${canonical.playerName} market=${canonical.market} line=${canonical.line} side=${canonical.recommendedSide} over=${canonical.overProbability} under=${canonical.underProbability} state=${canonical.signalState}`);
          return res.json({
            // Canonical fields the client relies on for display.
            playerId: canonical.playerId,
            playerName: canonical.playerName,
            team: canonical.team,
            market: canonical.market,
            bookLine: canonical.line ?? bookLine,
            recommendedSide: canonical.recommendedSide,
            calibratedProbabilityOver: canonical.overProbability,
            calibratedProbabilityUnder: canonical.underProbability,
            calibratedProbability: canonical.recommendedSide === "UNDER"
              ? canonical.underProbability
              : canonical.overProbability,
            probability: canonical.recommendedSide === "UNDER"
              ? canonical.underProbability
              : canonical.overProbability,
            modelProbability: canonical.recommendedSide === "UNDER"
              ? canonical.underProbability
              : canonical.overProbability,
            engineConfidence: canonical.engineConfidence,
            rawProbability: canonical.rawProbability,
            signalState: canonical.signalState,
            drivers: canonical.drivers,
            // Source contract — clients render the badge based on this.
            source: canonical.source,
            label: canonical.label,
            mode: "engine",
            isManual: false,
            updatedAt: canonical.updatedAt,
          });
        }
        console.log(`[MLB_CANONICAL_RESOLVE] miss player=${resolvedPlayerName} market=${market} line=${bookLine} — falling back to calculator estimate`);
      }

      const rolling = resolvedPlayerId ? mlbPlayerCache.batterRollingStats[resolvedPlayerId] : null;
      const MLB_LEAGUE_AVG_BA = 0.248;
      const resolvedSeasonAvg = rolling?.seasonAvg ?? rolling?.last30?.avg ?? rolling?.last15?.avg ?? MLB_LEAGUE_AVG_BA;

      const gameState = gameId ? mlbGameCache.gameState?.[gameId] : null;
      const activePitcherId = gameState?.pitcherInGame?.playerId;
      const pitcherSeason = activePitcherId ? mlbPlayerCache.pitcherSeasonStats[activePitcherId] : null;

      const weatherCache = gameId ? mlbGameCache.weather?.[gameId] : null;
      const parkFactor = weatherCache?.venueName
        ? getMarketParkFactor(weatherCache.venueName, market)
        : 1.0;

      console.log(`[MLB_CALC_INPUT] ${JSON.stringify({
        resolvedPlayerId, resolvedPlayerName, resolvedTeam, gameId, market, bookLine,
        seasonAvg: resolvedSeasonAvg,
        hasBatterHand: !!resolvedBatterHand,
        hasRolling: !!rolling,
        hasPitcherSeason: !!pitcherSeason,
        hasGameState: !!gameState,
        hasWeather: !!weatherCache,
        parkFactor,
      })}`);

      const input: MLBPropInput = {
        playerId: resolvedPlayerId,
        playerName: resolvedPlayerName,
        team: resolvedTeam,
        opponent: safeStr("opponent"),
        gameId,
        market,
        bookLine,
        seasonAvg: resolvedSeasonAvg,
        plateAppearances: statsAB + statsWalks,
        atBats: statsAB,
        currentStatValue,
        remainingPA: Math.max(0, 4 - Math.floor(inning / 3)),
        remainingAB: Math.max(0, 4 - Math.floor(inning / 3)),
        completedAB: statsAB,
        inning,
        isTopInning,
        batterHand: resolvedBatterHand,
        contactQuality: {
          exitVelocity: null,
          launchAngle: null,
          hitDistance: null,
          hardHitRateSeason: null,
          barrelRateProxySeason: null,
          avgBatSpeed: null,
          avgSwingLength: null,
          priorABResults: [],
          xBA: null,
          xSLG: null,
        },
        pitcher: {
          pitchCount,
          timesThrough,
          era: pitcherSeason?.era ?? null,
          whip: pitcherSeason?.whip ?? null,
          kPer9: pitcherSeason?.kPer9 ?? (pitcherK != null && pitcherIP != null && pitcherIP > 0 ? (pitcherK / pitcherIP) * 9 : null),
          bbPer9: pitcherSeason?.bbPer9 ?? (pitcherWalks != null && pitcherIP != null && pitcherIP > 0 ? (pitcherWalks / pitcherIP) * 9 : null),
          managerLeashShort: timesThrough >= 3 && pitchCount > 80,
          isPitcherCollapsing: false,
          pitchMix: [],
          throws: gameState?.pitcherInGame?.throws ?? null,
        },
        lineup: {
          battingOrderSlot,
          orderTurnoverProximity: 0.5,
          lineupSectionStrength: battingOrderSlot <= 3 ? "strong" : battingOrderSlot <= 6 ? "neutral" : "weak",
          hittersAheadOnBase: runners,
          pocketWeakness: null,
        },
        weatherPark: {
          parkFactor,
          temperature: weatherCache?.temperature ?? null,
          windSpeed: weatherCache?.windSpeed ?? null,
          windDirection: weatherCache?.windDirection ?? null,
          humidity: weatherCache?.humidity ?? null,
          isIndoors: weatherCache?.isIndoors ?? false,
          parkHistoryFactor: null,
        },
        bullpen: {
          bullpenEra: null,
          bullpenUsageLastThreeDays: null,
          isTopRelieverAvailable: true,
        },
      };

      const output = calculateMLBPropEdge(input);
      recordMLBDiagnostic(output);

      console.log(`[MLB_CALC_OUTPUT] ${JSON.stringify({
        player: output.playerName, market: output.market,
        probability: Math.round(output.calibratedProbability * 100) / 100,
        projection: Math.round(output.projection * 1000) / 1000,
        edge: Math.round(output.edge * 100) / 100,
        side: output.recommendedSide, tier: output.confidenceTier,
      })}`);

      return res.json({
        ...output,
        probability: output.calibratedProbability,
        modelProbability: output.calibratedProbability,
        mode: "manual",
        isManual: true,
        // Source contract — calculator estimate (no live engine signal for this tuple).
        source: "calculator",
        label: CALCULATOR_SOURCE_LABEL,
      });
    } catch (err: any) {
      console.error("[MLB calculate-manual]", err.message);
      return res.status(400).json({ error: err.message || "Manual calculation error" });
    }
  });

  // ── MLB Admin Debug Endpoint (Phase 8) ───────────────────────────────────────
  app.get("/api/mlb/debug", requireAuth, async (req, res) => {
    const reqUser = (req as any).user ?? (req as any).resolvedUser ?? null;
    if (!reqUser?.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try { (await import("./services/liveSignalBus")).markLegacyConsumer("/api/mlb/debug"); } catch {}

    const activeGames = getActiveGames();
    const allGameIds = activeGames.map((g) => g.gameId);

    const gamesDebug = allGameIds.map((gameId) => {
      const edgeCacheEntry = mlbEdgeCache.get(gameId);
      const liveGamesEntry = mlbLiveGamesCache.get("games");
      const gameInfo = liveGamesEntry?.games.find((g: any) => String(g.gameId) === gameId) ?? null;

      return {
        gameId,
        gameInfo: gameInfo ? {
          awayTeam: gameInfo.awayTeam,
          homeTeam: gameInfo.homeTeam,
          awayAbbr: gameInfo.awayAbbr,
          homeAbbr: gameInfo.homeAbbr,
          status: gameInfo.status,
          inning: gameInfo.inning,
          venue: gameInfo.venue,
        } : null,
        edgeCache: edgeCacheEntry ? {
          updatedAt: new Date(edgeCacheEntry.updatedAt).toISOString(),
          outputCount: edgeCacheEntry.outputs.length,
          isDegraded: edgeCacheEntry.isDegraded,
          outputs: edgeCacheEntry.outputs.map((o) => ({
            playerName: o.playerName,
            playerId: o.playerId,
            market: o.market,
            bookLine: o.bookLine,
            projection: o.projection,
            edge: o.edge,
            calibratedProbOver: o.calibratedProbabilityOver,
            calibratedProbUnder: o.calibratedProbabilityUnder,
            recommendedSide: o.recommendedSide,
            suppressed: o.suppressed,
            suppressionReason: o.suppressionReason,
            overOdds: o.overOdds,
            underOdds: o.underOdds,
            projectionSource: o.projectionSource ?? null,
            projectionQuality: o.projectionQuality ?? null,
            trustScore: o.projectionTrustScore ?? null,
            modelMethod: o.modelMethod ?? null,
            variance: o.variance ?? null,
          })),
        } : null,
      };
    });

    return res.json({
      ts: new Date().toISOString(),
      activeGameCount: allGameIds.length,
      activeGameIds: allGameIds,
      games: gamesDebug,
    });
  });

  // ── MLB Routes (Admin-only in Phase A) ──────────────────────────────────────
  const mlbPropsHandler: import("express").RequestHandler = async (req, res) => {
    try {
      const raw: Record<string, any> = { ...(req.body ?? {}) };

      const safeStr = (key: string, fallback: string = ""): string => {
        const v = raw[key];
        return v != null ? String(v) : fallback;
      };
      const safeFloat = (key: string, fallback: number): number => {
        const v = raw[key];
        if (v == null) return fallback;
        const n = parseFloat(String(v));
        return Number.isFinite(n) ? n : fallback;
      };
      const safeInt = (key: string, fallback: number): number => {
        const v = raw[key];
        if (v == null) return fallback;
        const n = parseInt(String(v), 10);
        return Number.isFinite(n) ? n : fallback;
      };
      const safeBool = (key: string, fallback: boolean = false): boolean => {
        const v = raw[key];
        if (v === true || v === "true") return true;
        if (v === false || v === "false") return false;
        return fallback;
      };
      const safeJsonArray = (key: string): any[] => {
        const v = raw[key];
        if (Array.isArray(v)) return v;
        if (typeof v === "string" && v.length > 0) {
          try { return JSON.parse(v); } catch { return []; }
        }
        return [];
      };

      const MARKET_ALIASES: Record<string, MLBMarket> = {};
      const ACCEPTED_MARKETS = [...ALL_MLB_MARKETS, ...Object.keys(MARKET_ALIASES)];
      const rawMarket = safeStr("market");
      if (!rawMarket || !ACCEPTED_MARKETS.includes(rawMarket)) {
        return res.status(400).json({ error: `Invalid market. Must be one of: ${ACCEPTED_MARKETS.join(", ")}` });
      }
      const displayMarket = rawMarket;
      const market: MLBMarket = MARKET_ALIASES[rawMarket] ?? rawMarket as MLBMarket;

      const rawLine = safeFloat("line", NaN);
      const bookLine = Number.isFinite(rawLine) ? rawLine : safeFloat("bookLine", NaN);
      if (!Number.isFinite(bookLine)) {
        return res.status(400).json({ error: "line is required and must be a number" });
      }

      const stats = raw.currentStats && typeof raw.currentStats === "object" ? raw.currentStats as Record<string, unknown> : null;
      const statsAB = stats ? parseInt(String(stats.ab ?? 0), 10) || 0 : safeInt("atBats", 0);
      const statsH = stats ? parseInt(String(stats.h ?? 0), 10) || 0 : 0;
      const statsTB = stats ? parseInt(String(stats.tb ?? 0), 10) || 0 : 0;
      const statsK = stats ? parseInt(String(stats.k ?? 0), 10) || 0 : 0;
      const currentStatValue = stats
        ? (market === "hits" ? statsH : market === "total_bases" ? statsTB : market === "home_runs" ? parseInt(String((stats as any).hr ?? 0), 10) || 0 : market === "hrr" ? statsH + (parseInt(String((stats as any).rbi ?? 0), 10) || 0) + (parseInt(String((stats as any).r ?? 0), 10) || 0) : market === "batter_strikeouts" ? statsK : 0)
        : safeFloat("currentStatValue", 0);

      const overOdds = safeFloat("overOdds", NaN);
      let bookImplied: number | null = null;
      if (Number.isFinite(overOdds)) {
        bookImplied = overOdds < 0
          ? Math.abs(overOdds) / (Math.abs(overOdds) + 100) * 100
          : 100 / (overOdds + 100) * 100;
        bookImplied = Math.round(bookImplied * 10) / 10;
      }

      const inning = raw.currentInning != null ? safeInt("currentInning", 1) : safeInt("inning", 1);

      const input: MLBPropInput = {
        playerId: safeStr("playerId"),
        playerName: safeStr("playerName"),
        team: safeStr("team"),
        opponent: safeStr("opponent"),
        gameId: safeStr("gameId"),
        market,
        bookLine,
        seasonAvg: safeFloat("seasonAvg", 0),
        plateAppearances: safeInt("plateAppearances", 0),
        atBats: statsAB,
        currentStatValue,
        remainingPA: safeInt("remainingPA", 4),
        remainingAB: safeInt("remainingAB", 4),
        completedAB: statsAB,
        inning,
        isTopInning: safeBool("isTopInning"),
        batterHand: (safeStr("batterHand") as "L" | "R" | "S") || null,
        pitcherThrows: (raw.pitcherThrows === "L" || raw.pitcherThrows === "R") ? raw.pitcherThrows : undefined,
        parkHistoryFactor: raw.parkHistoryFactor != null ? safeFloat("parkHistoryFactor", 0) : undefined,
        bvpPlateAppearances: raw.bvpPlateAppearances != null ? safeInt("bvpPlateAppearances", 0) : undefined,
        bvpOpsLikeFactor: raw.bvpOpsLikeFactor != null ? safeFloat("bvpOpsLikeFactor", 0) : undefined,
        pitcherVsHandednessFactor: raw.pitcherVsHandednessFactor != null ? safeFloat("pitcherVsHandednessFactor", 0) : undefined,
        lineupPocketWeakness: raw.lineupPocketWeakness != null ? safeFloat("lineupPocketWeakness", 0) : undefined,
        contactQuality: raw.contactQuality && typeof raw.contactQuality === "object"
          ? raw.contactQuality
          : {
              exitVelocity: raw.exitVelocity != null ? safeFloat("exitVelocity", 0) : null,
              launchAngle: raw.launchAngle != null ? safeFloat("launchAngle", 0) : null,
              hitDistance: raw.hitDistance != null ? safeFloat("hitDistance", 0) : null,
              hardHitRateSeason: (raw.hardHitRateSeason ?? raw.hardHitRate) != null ? safeFloat(raw.hardHitRateSeason != null ? "hardHitRateSeason" : "hardHitRate", 0) : null,
              barrelRateProxySeason: (raw.barrelRateProxySeason ?? raw.barrelRate) != null ? safeFloat(raw.barrelRateProxySeason != null ? "barrelRateProxySeason" : "barrelRate", 0) : null,
              priorABResults: safeJsonArray("priorABResults"),
            },
        pitcher: raw.pitcher && typeof raw.pitcher === "object"
          ? raw.pitcher
          : {
              pitchCount: safeInt("pitchCount", 0),
              timesThrough: safeInt("timesThrough", 1),
              era: raw.era != null ? safeFloat("era", 0) : null,
              whip: raw.whip != null ? safeFloat("whip", 0) : null,
              kPer9: raw.kPer9 != null ? safeFloat("kPer9", 0) : null,
              bbPer9: raw.bbPer9 != null ? safeFloat("bbPer9", 0) : null,
              managerLeashShort: safeBool("managerLeashShort"),
              isPitcherCollapsing: safeBool("isPitcherCollapsing"),
              pitchMix: safeJsonArray("pitchMix"),
              throws: (safeStr("throws") as "L" | "R") || null,
            },
        lineup: raw.lineup && typeof raw.lineup === "object"
          ? raw.lineup
          : {
              battingOrderSlot: safeInt("battingOrderSlot", 5),
              orderTurnoverProximity: safeInt("orderTurnoverProximity", 5),
              lineupSectionStrength: (safeStr("lineupSectionStrength", "neutral") as "strong" | "neutral" | "weak"),
              hittersAheadOnBase: safeInt("hittersAheadOnBase", 0),
              pocketWeakness: raw.pocketWeakness != null ? safeFloat("pocketWeakness", 0) : null,
            },
        weatherPark: raw.weatherPark && typeof raw.weatherPark === "object"
          ? raw.weatherPark
          : {
              parkFactor: safeFloat("parkFactor", 1.0),
              temperature: raw.temperature != null ? safeFloat("temperature", 0) : null,
              windSpeed: raw.windSpeed != null ? safeFloat("windSpeed", 0) : null,
              windDirection: (safeStr("windDirection") as "in" | "out" | "cross" | "calm") || null,
              humidity: raw.humidity != null ? safeFloat("humidity", 0) : null,
              isIndoors: safeBool("isIndoors"),
              parkHistoryFactor: raw.parkHistoryFactor != null ? safeFloat("parkHistoryFactor", 0) : null,
            },
        bullpen: raw.bullpen && typeof raw.bullpen === "object"
          ? raw.bullpen
          : {
              bullpenEra: raw.bullpenEra != null ? safeFloat("bullpenEra", 0) : null,
              bullpenUsageLastThreeDays: raw.bullpenUsageLastThreeDays != null ? safeFloat("bullpenUsageLastThreeDays", 0) : null,
              isTopRelieverAvailable: safeBool("isTopRelieverAvailable", true),
            },
        bvpHistory: raw.bvpHistory && typeof raw.bvpHistory === "object"
          ? raw.bvpHistory
          : undefined,
        hrrComponents: raw.hrrComponents && typeof raw.hrrComponents === "object"
          ? raw.hrrComponents
          : (raw.hitsRate != null || raw.runsRate != null || raw.rbisRate != null)
            ? {
                hitsRate: safeFloat("hitsRate", 0),
                runsRate: safeFloat("runsRate", 0),
                rbisRate: safeFloat("rbisRate", 0),
                currentHits: safeFloat("currentHits", 0),
                currentRuns: safeFloat("currentRuns", 0),
                currentRBIs: safeFloat("currentRBIs", 0),
              }
            : undefined,
      };

      const cachedLiveGames = mlbLiveGamesCache.get("games");
      if (cachedLiveGames) {
        const liveGame = cachedLiveGames.games.find((g: any) => String(g.gameId) === input.gameId);
        if (liveGame && liveGame.homeScore != null && liveGame.awayScore != null) {
          input.currentRuns = liveGame.homeScore + liveGame.awayScore;
          input.leagueAvgRuns = 8.5;
        }
      }

      const output = calculateMLBPropEdge(input);
      if (bookImplied != null) {
        output.bookImplied = bookImplied;
      }
      recordMLBDiagnostic(output);
      return res.json({ ...output, probability: output.calibratedProbability, modelProbability: output.calibratedProbability, market: displayMarket });
    } catch (err: any) {
      console.error("[MLB props]", err.message);
      return res.status(400).json({ error: err.message || "MLB prop engine error" });
    }
  };
  app.post("/api/mlb/props", requireMLBAccess, mlbPropsHandler);
  app.post("/api/mlb/calculate", requireMLBAccess, mlbPropsHandler);

  app.get("/api/mlb/odds", requireAuth, async (req, res) => {
    try {
      const { playerTeam, opponentTeam, playerName, statType, inPlay } = req.query;

      if (!playerName || !statType) {
        return res.status(400).json({ message: "Missing required parameters: playerName, statType" });
      }

      if (!process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY_2) {
        return res.status(503).json({ message: "ODDS_API_KEY not configured" });
      }

      const teamA = playerTeam as string | undefined;
      const teamB = opponentTeam as string | undefined;

      if (!teamA || !teamB) {
        return res.json({});
      }

      const oddsEventId = await resolveMLBOddsEventId(teamA, teamB);

      if (!oddsEventId) {
        return res.json({});
      }

      const isInPlay = inPlay === "true";
      let formattedOdds = await getMLBPlayerOdds(oddsEventId, playerName as string, statType as string, isInPlay);

      if (formattedOdds._quotaExhausted) {
        return res.json({ _quotaExhausted: true });
      }

      const liveKeys = Object.keys(formattedOdds).filter(k => k !== "_quotaExhausted");
      if (isInPlay && liveKeys.length === 0) {
        console.log(`[MLB Odds] No live lines for "${playerName}" (${statType}) — falling back to pre-game`);
        formattedOdds = await getMLBPlayerOdds(oddsEventId, playerName as string, statType as string, false);
        if (formattedOdds._quotaExhausted) {
          return res.json({ _quotaExhausted: true });
        }
      }

      res.json(formattedOdds);
    } catch (err: any) {
      console.error("[MLB Odds API Error]", err.message);
      res.status(500).json({ message: err.message || "Failed to fetch MLB odds" });
    }
  });

  app.get("/api/mlb/diagnostics", requireAdmin, async (_req, res) => {
    try {
      const summary = getMLBDiagnosticSummary();
      return res.json(summary);
    } catch (err: any) {
      console.error("[MLB diagnostics]", err.message);
      return res.status(500).json({ error: err.message || "Failed to fetch MLB diagnostics" });
    }
  });

  app.post("/api/mlb/backtest", requireAdmin, async (req, res) => {
    try {
      const body = req.body ?? {};

      if (Array.isArray(body.inputs)) {
        if (body.inputs.length === 0) {
          return res.status(400).json({ error: "inputs array must not be empty" });
        }
        if (body.inputs.length > 200) {
          return res.status(400).json({ error: "Maximum 200 inputs per batch request" });
        }
        const result = runBatchInputs(body.inputs);
        return res.json(result);
      }

      const { cases } = body;
      if (!Array.isArray(cases) || cases.length === 0) {
        return res.status(400).json({
          error: "Request body must contain either a non-empty 'cases' array (labeled backtest) or 'inputs' array (batch shadow test)",
        });
      }
      if (cases.length > 200) {
        return res.status(400).json({ error: "Maximum 200 cases per request" });
      }
      const result = runBacktest(cases);
      return res.json(result);
    } catch (err: any) {
      console.error("[MLB backtest]", err.message);
      return res.status(500).json({ error: err.message || "Backtest error" });
    }
  });

  app.get("/api/mlb/market-report", requireAdmin, async (_req, res) => {
    try {
      const report = getMLBMarketReport();
      return res.json(report);
    } catch (err: any) {
      console.error("[MLB market-report]", err.message);
      return res.status(500).json({ error: err.message || "Failed to fetch market report" });
    }
  });

  app.get("/api/mlb/modifier-summary", requireAdmin, async (_req, res) => {
    try {
      const summary = getModifierContributionSummary();
      return res.json(summary);
    } catch (err: any) {
      console.error("[MLB modifier-summary]", err.message);
      return res.status(500).json({ error: err.message || "Failed to fetch modifier summary" });
    }
  });

  app.post("/api/mlb/refresh-data", requireAdmin, async (req, res) => {
    try {
      const { gameId } = req.body ?? {};
      if (!gameId || typeof gameId !== "string") {
        return res.status(400).json({ error: "gameId is required" });
      }
      const adminRegisteredGame = getActiveGames().find((g) => g.gameId === gameId);
      const adminStatsPk: string = adminRegisteredGame?.gamePk ?? gameId;
      await syncGameState(adminStatsPk, gameId);
      await syncContactData(adminStatsPk, gameId);
      await syncPitcherContext(adminStatsPk, gameId);
      await syncWeather(adminStatsPk, gameId);
      await syncBullpenUsage(adminStatsPk, gameId);
      // Admin manual trigger — fetch actual status; engine only runs if genuinely live
      // Default to "unknown" — engine will skip unless status resolves to "live"
      let adminNormalizedStatus: "live" | "pregame" | "final" | "unknown" = "unknown";
      try {
        const adminStatusRes = await fetch(`https://statsapi.mlb.com/api/v1/game/${adminStatsPk}/feed/live`, {
          headers: { "User-Agent": "LiveLocks/1.0" },
          signal: AbortSignal.timeout(4000),
        });
        if (adminStatusRes.ok) {
          const adminStatusData = (await adminStatusRes.json()) as any;
          const adminRawState: string = adminStatusData.gameData?.status?.abstractGameState ?? "";
          adminNormalizedStatus = normalizeMlbStatus(adminRawState);
        }
      } catch {
        console.warn(`[MLB admin refresh] Could not fetch status for game ${gameId} — status unknown, engine will skip`);
      }
      const outputs = await liveOrchestrator.triggerEngine(gameId, adminNormalizedStatus);
      return res.json(outputs);
    } catch (err: any) {
      console.error("[MLB refresh-data]", err.message);
      return res.status(500).json({ error: err.message || "Refresh failed" });
    }
  });

  app.post("/api/mlb/sync-rosters", requireAdmin, async (_req, res) => {
    try {
      await updatePlayerPool();
      await updateTeamRosters();
      return res.json({
        playersLoaded: getPlayerPoolCount(),
        teamsLoaded: getTeamCount(),
      });
    } catch (err: any) {
      console.error("[MLB sync-rosters]", err.message);
      return res.status(500).json({ error: err.message || "Roster sync failed" });
    }
  });

  app.get("/api/admin/settings", requireAdmin, async (_req, res) => {
    try {
      const settings = await storage.getAppSettings();
      return res.json(settings);
    } catch (err) {
      console.error("[admin/settings GET]", err);
      return res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.post("/api/admin/settings", requireAdmin, async (req, res) => {
    try {
      const { slateResetHour, slateResetMinute } = req.body as { slateResetHour?: number; slateResetMinute?: number };
      if (slateResetHour == null || typeof slateResetHour !== "number" || slateResetHour < 0 || slateResetHour > 23) {
        return res.status(400).json({ error: "slateResetHour must be 0–23" });
      }
      const minute = slateResetMinute ?? 0;
      if (typeof minute !== "number" || minute < 0 || minute > 59) {
        return res.status(400).json({ error: "slateResetMinute must be 0–59" });
      }
      await storage.saveAppSettings(slateResetHour, minute);
      return res.json({ success: true, slateResetHour, slateResetMinute: minute });
    } catch (err) {
      console.error("[admin/settings POST]", err);
      return res.status(500).json({ error: "Failed to save settings" });
    }
  });

  app.get("/api/admin/feedback", requireAdmin, async (_req, res) => {
    try {
      const rows = await storage.getAllFeedback();
      return res.json(rows);
    } catch (err) {
      console.error("[admin/feedback]", err);
      return res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  app.get("/api/admin/verify-access", requireAdmin, async (req, res) => {
    try {
      const userId = parseInt(String(req.query.userId), 10);
      if (!userId || isNaN(userId)) return res.status(400).json({ error: "Invalid userId" });
      const user = await storage.getUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const tier = user.subscriptionTier;
      const access = resolveAccess(tier, user.isAdmin ?? false);
      return res.json({
        dbTier: tier ?? null,
        hasNcaabAccess: access.hasNCAAB,
        hasNBA: access.hasNBA,
        hasMLB: access.hasMLB,
        hasUnlimited: access.hasUnlimited,
        requiresRefresh: user.requiresRefresh ?? false,
        email: user.email,
        isAdmin: user.isAdmin,
      });
    } catch (err: any) {
      console.error("[admin/verify-access]", err);
      return res.status(500).json({ error: err.message || "Failed to verify access" });
    }
  });

  // ── /api/me — always reads fresh from DB ──────────────────────────────────

  app.get("/api/me", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId as number;
      let user = await storage.getUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      try {
        const { getUncachableStripeClient } = await import("./stripeClient");
        const { resolveTierFromSubscription } = await import("./utils/resolveTier");
        const stripe = await getUncachableStripeClient();

        let customerId = user.stripeCustomerId;

        if (!customerId && user.email) {
          const customers = await stripe.customers.list({ email: user.email, limit: 1 });
          if (customers.data[0]) {
            customerId = customers.data[0].id;
            await storage.updateUserStripeCustomer(userId, customerId);
            console.log(`[stripe-fallback] Linked customer ${customerId} to user ${userId} via email lookup`);
          }
        }

        if (customerId) {
          const [activeSubs, trialingSubs] = await Promise.all([
            stripe.subscriptions.list({ customer: customerId, status: "active", limit: 1 }),
            stripe.subscriptions.list({ customer: customerId, status: "trialing", limit: 1 }),
          ]);
          const validSub = activeSubs.data[0] || trialingSubs.data[0];
          if (validSub) {
            const activeSub = validSub;
            const stripeTier = resolveTierFromSubscription(activeSub);
            if (stripeTier && stripeTier !== user.subscriptionTier) {
              await storage.updateUserSubscription(userId, stripeTier, customerId, activeSub.id);
              user = await storage.getUserById(userId) ?? user;
              console.log("[stripe-fallback] repaired tier", {
                userId: user.id,
                dbTier: user.subscriptionTier,
                stripeTier,
              });
            }
          } else if (user.subscriptionTier) {
            await storage.setUserSubscriptionTier(user.id, null);
            user = await storage.getUserById(userId) ?? user;
            console.warn("[stripe-fallback] revoked stale paid tier", {
              userId: user.id,
              previousTier: user.subscriptionTier,
            });
          }
        }
      } catch (stripeErr: any) {
        console.warn(`[stripe-fallback] Stripe lookup failed for user ${userId}:`, stripeErr.message);
      }

      const tier = user.subscriptionTier;
      const access = resolveAccess(tier, user.isAdmin ?? false);
      // Pass 4 — lifecycle fields are additive; pre-existing keys are preserved exactly.
      const subscriptionStatus = user.subscriptionStatus ?? null;
      return res.json({
        id: user.id,
        email: user.email,
        isAdmin: user.isAdmin,
        subscriptionTier: tier ?? null,
        requiresRefresh: user.requiresRefresh ?? false,
        hasNcaabAccess: access.hasNCAAB,
        hasNBA: access.hasNBA,
        hasNCAAB: access.hasNCAAB,
        hasMLB: access.hasMLB,
        hasUnlimited: access.hasUnlimited,
        // Pass 4 — lifecycle additions (nullable; safe defaults).
        subscriptionStatus,
        subscriptionSource: user.subscriptionSource ?? null,
        trialStartedAt: user.trialStartedAt ? user.trialStartedAt.toISOString() : null,
        trialEndsAt: user.trialEndsAt ? user.trialEndsAt.toISOString() : null,
        cancelAtPeriodEnd: user.cancelAtPeriodEnd ?? null,
        convertedToPaidAt: user.convertedToPaidAt ? user.convertedToPaidAt.toISOString() : null,
        alertsChannelStatus: user.alertsChannelStatus ?? null,
        telegramConnectionStatus: user.telegramConnectionStatus ?? null,
        telegramUsername: user.telegramUsername ?? null,
        isOnTrial: subscriptionStatus === "trialing",
        isFreeAccount: !tier && !(user.isAdmin ?? false),
      });
    } catch (err: any) {
      console.error("[/api/me]", err);
      return res.status(500).json({ error: err.message || "Failed to fetch user" });
    }
  });

  // ── /api/auth/refresh-tier — client polls this to detect admin-triggered changes ──
  app.get("/api/auth/refresh-tier", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId as number;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const rawTier = user.subscriptionTier ?? null;
      const access = resolveAccess(rawTier, user.isAdmin ?? false);
      if (user.requiresRefresh) {
        await storage.clearRequiresRefresh(userId);
      }
      return res.json({
        tier: rawTier,
        hasNcaabAccess: access.hasNCAAB,
        hasNBA: access.hasNBA,
        hasNCAAB: access.hasNCAAB,
        hasMLB: access.hasMLB,
        hasUnlimited: access.hasUnlimited,
        userId,
        requiresRefresh: user.requiresRefresh ?? false,
        refreshedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[auth/refresh-tier]", err.message);
      return res.status(500).json({ error: "Failed to refresh tier" });
    }
  });

  // ── Feedback Route ────────────────────────────────────────────────────────

  app.post("/api/feedback", requireAuth, async (req, res) => {
    try {
      const { message } = req.body as { message?: string };
      if (!message || message.trim().length < 3) {
        return res.status(400).json({ error: "Message must be at least 3 characters" });
      }
      const row = await storage.createFeedback((req as any).resolvedUserId!, message.trim());
      return res.status(201).json(row);
    } catch (err) {
      console.error("[feedback]", err);
      return res.status(500).json({ error: "Failed to save feedback" });
    }
  });

  app.get("/api/odds", async (req, res) => {
    try {
      // Accept either full team names (homeTeam/awayTeam from game selection)
      // OR abbreviations (playerTeam/opponentTeam from player selection without a game).
      const { homeTeam, awayTeam, playerTeam, opponentTeam, playerName, statType, inPlay } = req.query;

      if (!playerName || !statType) {
        return res.status(400).json({ message: "Missing required parameters: playerName, statType" });
      }

      if (!process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY_2) {
        return res.status(503).json({ message: "ODDS_API_KEY not configured" });
      }

      // Determine which team identifiers to use
      const teamA = (playerTeam ?? homeTeam) as string | undefined;
      const teamB = (opponentTeam ?? awayTeam) as string | undefined;

      if (!teamA || !teamB) {
        return res.json({ _error: "Select a player and opponent to see live lines" });
      }

      // resolveOddsEventId handles both full names and abbreviations
      const oddsEventId = await resolveOddsEventId(teamA, teamB);

      if (!oddsEventId) {
        return res.json({}); // No matching event found — graceful empty response
      }

      // inPlay=true fetches live in-play lines (90-sec cache) rather than pre-game lines (5-min cache).
      // If live returns no results (books haven't posted live props yet), fall back to pre-game lines.
      const isInPlay = inPlay === "true";
      let oddsResult = await getPlayerOdds(oddsEventId, playerName as string, statType as string, isInPlay);

      if (oddsResult.quotaExhausted) {
        return res.json({ _quotaExhausted: true });
      }

      // Live fallback: if game is live but no live lines found yet, serve pre-game lines
      if (isInPlay && Object.keys(oddsResult.books).length === 0 && !oddsResult.isDegraded) {
        console.log(`[Odds] No live lines for "${playerName}" (${statType}) — falling back to pre-game`);
        oddsResult = await getPlayerOdds(oddsEventId, playerName as string, statType as string, false);
        if (oddsResult.quotaExhausted) {
          return res.json({ _quotaExhausted: true });
        }
      }

      res.json(oddsResult.books);
    } catch (err: any) {
      console.error("[Odds API Error]", err.message);
      res.status(500).json({ message: err.message || "Failed to fetch odds" });
    }
  });

  // Debug endpoint: returns raw Odds API structure for a given matchup
  // Usage: GET /api/debug/odds-raw?teamA=DEN&teamB=BOS
  app.get("/api/debug/odds-raw", async (req, res) => {
    try {
      const { teamA, teamB } = req.query as { teamA?: string; teamB?: string };
      if (!teamA || !teamB) return res.status(400).json({ message: "Pass ?teamA=&teamB=" });
      const eventId = await resolveEventForDebug(teamA, teamB);
      if (!eventId) return res.json({ error: "No event found for these teams", teamA, teamB });
      const raw = await getRawOddsForDebug(eventId);
      const summary = (raw.bookmakers ?? []).map((bk: any) => ({
        bookmaker: bk.key,
        markets: (bk.markets ?? []).map((m: any) => ({
          key: m.key,
          playerCount: Array.from(new Set((m.outcomes ?? []).map((o: any) => o.description ?? "?"))).length,
          samplePlayers: Array.from(new Set((m.outcomes ?? []).map((o: any) => o.description ?? "?"))).slice(0, 5),
        })),
      }));
      res.json({ eventId, summary });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  // Game-level spread and total — auto-fetched from The Odds API
  app.get("/api/game-lines", async (req, res) => {
    try {
      const { team, opponent } = req.query as { team?: string; opponent?: string };
      if (!team || !opponent) {
        return res.json({ spread: null, total: null, favorite: null });
      }
      if (!process.env.ODDS_API_KEY && !process.env.ODDS_API_KEY_2) {
        return res.json({ spread: null, total: null, favorite: null });
      }
      const eventId = await resolveOddsEventId(team, opponent);
      if (!eventId) return res.json({ spread: null, total: null, favorite: null });
      const lines = await getGameLines(eventId);
      return res.json(lines ?? { spread: null, total: null, favorite: null });
    } catch (err: any) {
      console.warn("[GameLines] error:", err.message);
      res.json({ spread: null, total: null, favorite: null });
    }
  });

  app.get(api.players.list.path, async (req, res) => {
    try {
      const players = await storage.getPlayers();
      res.json(players);
    } catch (e) {
      res.status(500).json({ message: "Failed to fetch players" });
    }
  });

  app.get(api.teams.list.path, async (req, res) => {
    try {
      const teams = await storage.getTeams();
      res.json(teams);
    } catch (e) {
      res.status(500).json({ message: "Failed to fetch teams" });
    }
  });

  app.post(api.calculator.calculate.path, requirePlayAccess, async (req, res) => {
    try {
      const input = api.calculator.calculate.input.parse(req.body);
      const result = await storage.calculateProbability(input);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      const msg = (err as any).message ?? "";
      if (msg.includes("not found") || msg.includes("not exist")) {
        return res.status(400).json({ message: msg });
      }
      res.status(500).json({ message: "Internal server error", details: msg });
    }
  });

  // Returns today's date in EST as YYYYMMDD, rolling over at 6am EST
  // (games that finish after midnight still belong to the previous slate until 6am)
  function getESTSlateDate(): string {
    const now = new Date();
    const estOffset = -5 * 60; // EST = UTC-5 (standard); close enough for 6am cutoff
    const estMs = now.getTime() + (now.getTimezoneOffset() + estOffset) * 60 * 1000;
    const est = new Date(estMs);
    if (est.getHours() < 6) {
      est.setDate(est.getDate() - 1);
    }
    const y = est.getFullYear();
    const m = String(est.getMonth() + 1).padStart(2, "0");
    const d = String(est.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  // Proxy ESPN live NBA scoreboard to avoid CORS
  app.get("/api/live-games", async (req, res) => {
    try {
      const slateDate = getESTSlateDate();
      const response = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${slateDate}`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!response.ok) throw new Error("ESPN API unavailable");
      const data = await response.json() as any;
      const games = (data.events || []).map((event: any) => {
        const comp = event.competitions?.[0];
        const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
        const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
        const status = comp?.status;
        const statusDesc: string = status?.type?.description ?? "Scheduled";
        const isScheduled = statusDesc === "Scheduled" || statusDesc === "Pre-Game";
        return {
          id: event.id,
          homeTeam: home?.team?.displayName ?? "",
          homeTeamAbbr: home?.team?.abbreviation ?? "",
          homeScore: parseInt(home?.score ?? "0", 10),
          awayTeam: away?.team?.displayName ?? "",
          awayTeamAbbr: away?.team?.abbreviation ?? "",
          awayScore: parseInt(away?.score ?? "0", 10),
          status: statusDesc,
          period: status?.period ?? 0,
          clock: status?.displayClock ?? "",
          startTime: isScheduled ? (event.date ?? comp?.date ?? undefined) : undefined,
        };
      });
      res.json(games);
    } catch (e) {
      res.status(502).json({ message: "Live data unavailable", games: [] });
    }
  });

  app.get("/api/live-stats/:gameId", async (req, res) => {
    try {
      const { gameId } = req.params;
      const response = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!response.ok) throw new Error("ESPN Boxscore API unavailable");
      const data = await response.json() as any;
      
      const boxscore = data.boxscore;
      if (!boxscore) throw new Error("Boxscore data not found");

      // Build ESPN athlete ID → DB player ID lookup map
      const allDbPlayers = await storage.getPlayers();
      const espnToDbId = new Map<number, number>();
      for (const p of allDbPlayers) {
        if (p.espnAthleteId) espnToDbId.set(p.espnAthleteId, p.id);
      }

      const players: any[] = [];
      const teams = boxscore.players || [];

      teams.forEach((teamData: any) => {
        const teamAbbr = teamData.team?.abbreviation;
        const athletes = teamData.statistics?.[0]?.athletes || [];
        const labels = teamData.statistics?.[0]?.labels || [];

        athletes.forEach((athlete: any) => {
          if (!athlete.athlete) return;
          
          const stats = athlete.stats || [];
          const statMap: Record<string, any> = {};
          
          labels.forEach((label: string, idx: number) => {
            statMap[label.toLowerCase()] = stats[idx];
          });

          // ESPN stats often come as strings like "24", or for rebounds "2-4-6" (off-def-tot)
          // Shooting stats come as "made-attempted" (e.g. "3-7" for 3-of-7)
          // parseStat: for rebound-style "a-b-c" grabs the LAST part (total)
          const parseStat = (val: string) => {
            if (!val) return 0;
            if (val.includes("-")) {
              const parts = val.split("-");
              return parseInt(parts[parts.length - 1], 10) || 0;
            }
            return parseInt(val, 10) || 0;
          };
          // parseMade: for shooting "made-attempted" grabs the FIRST part (made)
          const parseMade = (val: string) => {
            if (!val) return 0;
            if (val.includes("-")) return parseInt(val.split("-")[0], 10) || 0;
            return parseInt(val, 10) || 0;
          };
          const parseAttempted = (val: string) => {
            if (!val) return 0;
            if (val.includes("-")) {
              const parts = val.split("-");
              return parseInt(parts[1] ?? parts[0], 10) || 0;
            }
            return 0;
          };

          const fgRaw = statMap["fg"] ?? statMap["fgm"] ?? "";
          const ftRaw = statMap["ft"] ?? statMap["ftm"] ?? "";
          const fg3Raw = statMap["3pt"] ?? statMap["fg3m"] ?? statMap["3ptm"] ?? "";

          const espnAthId = parseInt(athlete.athlete.id, 10);
          const dbPlayerId = espnToDbId.get(espnAthId) ?? null;
          if (!dbPlayerId) {
            console.warn(`[live-stats] Could not resolve ESPN athlete ${espnAthId} (${athlete.athlete.displayName}) to DB player — playerId will be null`);
          }
          players.push({
            playerId: dbPlayerId,
            playerName: athlete.athlete.displayName,
            teamAbbr: teamAbbr,
            gameId,
            minutes: statMap["min"] || "0",
            points: parseStat(statMap["pts"]),
            rebounds: parseStat(statMap["reb"]),
            assists: parseStat(statMap["ast"]),
            steals: parseStat(statMap["stl"]),
            blocks: parseStat(statMap["blk"]),
            fouls: parseStat(statMap["pf"]),
            threes: parseMade(fg3Raw),
            fgm: parseMade(fgRaw),
            fga: parseAttempted(fgRaw),
            ftm: parseMade(ftRaw),
            fta: parseAttempted(ftRaw),
            fg3m: parseMade(fg3Raw),
            fg3a: parseAttempted(fg3Raw),
          });
        });
      });

      res.json(players);
    } catch (e) {
      res.status(502).json({ message: "Live stats unavailable", details: (e as any).message });
    }
  });

  // ── Live Prop Signals (any game state: Q1–Q4) ───────────────────────────────
  // Game-specific endpoint that runs prop edge calculations for any live period,
  // not just halftime. Used to color box score rows/cells during the full game.
  // Per-entry TTL so a transient odds miss does not poison the cache for the
  // full 20s window. Healthy results cache for the full poll interval; empty
  // results (no actionable signals OR pre-flight failure) cache briefly so
  // the next client poll re-runs and recovers automatically.
  type LiveSignalsCacheEntry = {
    ts: number;
    ttl: number;
    payload: { signals: any[]; engineOutput: Record<number, Record<string, any>>; diagnostics: any };
  };
  const liveSignalsCache = new Map<string, LiveSignalsCacheEntry>();
  // Phase 5.2 — TTL aligned to the 15s client poll so each tick triggers a real
  // engine recompute. Empty/preflight TTLs stay shorter to recover even faster.
  const LIVE_SIGNALS_TTL_HEALTHY = 15_000;     // matches 15s client poll (Phase 5.1)
  const LIVE_SIGNALS_TTL_EMPTY   = 5_000;      // recover quickly from transient miss
  const LIVE_SIGNALS_TTL_PREFLIGHT = 3_000;    // ESPN/odds bootstrap failure — retry fast

  app.get("/api/live-signals/:gameId", requireAuth, async (req, res) => {
    const gameId = req.params.gameId as string;

    const cached = liveSignalsCache.get(gameId);
    if (cached && Date.now() - cached.ts < cached.ttl) {
      // Freshness Integrity Fix #3.3 — every NBA live-signals response carries
      // engine timestamp + freshness flag so the UI can prove freshness or
      // hide last-cycle dots when the server is in error mode.
      return res.json({
        ...cached.payload,
        updatedAt: cached.ts,
        generatedAt: Date.now(),
        stale: false,
      });
    }

    try {
      const ESPN_TO_DB_LOCAL: Record<string, string> = {
        GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
        PHO: "PHX", UTH: "UTA", UTAH: "UTA", WSH: "WAS", CHO: "CHA",
      };
      const normAbbr = (a: string) => ESPN_TO_DB_LOCAL[a.toUpperCase()] ?? a.toUpperCase();

      const summaryRes = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
      );
      if (!summaryRes.ok) throw new Error("ESPN summary unavailable");
      const summaryData = await summaryRes.json() as any;

      const boxscore = summaryData.boxscore;
      const header = summaryData.header;
      if (!boxscore || !header) {
        const nowTs = Date.now();
        const payload = { signals: [], engineOutput: {}, diagnostics: { reason: "espn_no_boxscore", inProgress: false } };
        liveSignalsCache.set(gameId, { ts: nowTs, ttl: LIVE_SIGNALS_TTL_PREFLIGHT, payload });
        // Freshness Integrity Fix #3.3 — empty preflight is honestly empty,
        // not stale: the engine just has nothing to score yet.
        return res.json({ ...payload, updatedAt: nowTs, generatedAt: nowTs, stale: false, mode: "monitoring" });
      }

      const comp = header.competitions?.[0];
      const statusDesc: string = comp?.status?.type?.description ?? "";
      const period: number = comp?.status?.period ?? 0;
      const displayClock: string = comp?.status?.displayClock ?? "0:00";
      const homeComp = comp?.competitors?.find((c: any) => c.homeAway === "home");
      const awayComp = comp?.competitors?.find((c: any) => c.homeAway === "away");
      const homeTeamAbbr = normAbbr(homeComp?.team?.abbreviation ?? "");
      const awayTeamAbbr = normAbbr(awayComp?.team?.abbreviation ?? "");
      const homeScore = parseInt(homeComp?.score ?? "0", 10);
      const awayScore = parseInt(awayComp?.score ?? "0", 10);
      const scoreStr = `${awayScore}-${homeScore}`;

      // Only run for genuinely in-progress games (not final, not scheduled).
      // End-of-period / end-of-quarter breaks are still LIVE — keep signals
      // flowing through quarter breaks instead of blanking the box score.
      const inProgress =
        statusDesc === "In Progress" ||
        statusDesc === "Halftime" ||
        statusDesc === "End of Period" ||
        statusDesc.startsWith("End of ") ||
        statusDesc.startsWith("End Period") ||
        statusDesc.startsWith("End of Quarter");
      if (!inProgress) {
        const nowTs = Date.now();
        const payload = { signals: [], engineOutput: {}, diagnostics: { reason: "not_in_progress", statusDesc, inProgress: false, period } };
        liveSignalsCache.set(gameId, { ts: nowTs, ttl: LIVE_SIGNALS_TTL_PREFLIGHT, payload });
        // Freshness Integrity Fix #3.3 — game not currently in play; honest
        // empty + mode tag, not a stale flag.
        return res.json({ ...payload, updatedAt: nowTs, generatedAt: nowTs, stale: false, mode: "monitoring" });
      }

      const allDbPlayers = await storage.getPlayers();
      const { getPlayerOdds, resolveOddsEventId, getSGOPlayerLine, getGameLines, preWarmOddsCache } = await import("./oddsService");

      let oddsEventId: string | null = null;
      try {
        oddsEventId = await resolveOddsEventId(homeTeamAbbr, awayTeamAbbr);
      } catch { /* continue without odds event ID */ }

      // Fetch game-level spread/total once per game for pace & garbage-time modifiers
      let gameLines: { spread: number | null; total: number | null; favorite: string | null } | null = null;
      if (oddsEventId && (process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2)) {
        try { gameLines = await getGameLines(oddsEventId); } catch { /* optional */ }
      }

      const oddsPlayerCache = new Map<string, { line: number; bookKeys: string[]; isDegraded: boolean; oddsFetchedAt: number } | null>();
      const NBA_2H_STALE_LINE_MS = 120_000;

      const LIVE_STAT_CONFIGS: Array<{ statType: string; components: string[] }> = [
        { statType: "points",      components: ["points"] },
        { statType: "rebounds",    components: ["rebounds"] },
        { statType: "assists",     components: ["assists"] },
        { statType: "threes",      components: ["threes"] },
        { statType: "steals",      components: ["steals"] },
        { statType: "blocks",      components: ["blocks"] },
        { statType: "pts_reb_ast", components: ["points", "rebounds", "assists"] },
        { statType: "pts_reb",     components: ["points", "rebounds"] },
        { statType: "pts_ast",     components: ["points", "assists"] },
        { statType: "reb_ast",     components: ["rebounds", "assists"] },
        { statType: "stl_blk",     components: ["steals", "blocks"] },
      ];

      if (oddsEventId && (process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2)) {
        const allStatTypes = LIVE_STAT_CONFIGS.map(c => c.statType);
        await preWarmOddsCache(oddsEventId, allStatTypes, true);
      }

      const parseStat = (val: string) => {
        if (!val) return 0;
        if (val.includes("-")) { const p = val.split("-"); return parseInt(p[p.length - 1], 10) || 0; }
        return parseInt(val, 10) || 0;
      };
      const parseMade = (val: string) => {
        if (!val) return 0;
        if (val.includes("-")) return parseInt(val.split("-")[0], 10) || 0;
        return parseInt(val, 10) || 0;
      };
      const parseAttempted = (val: string) => {
        if (!val) return 0;
        if (val.includes("-")) { const p = val.split("-"); return parseInt(p[1] ?? p[0], 10) || 0; }
        return 0;
      };

      const allSignals: any[] = [];
      const engineOutput: Record<number, Record<string, any>> = {};

      // Per-stage diagnostics surfaced to the client so it can display *why*
      // signals are empty (odds outage vs all-rejected vs game state) instead
      // of rendering an indistinguishable blank.
      const diag = {
        inProgress: true,
        period,
        oddsEventResolved: !!oddsEventId,
        oddsApiKeyAvailable: !!(process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2),
        sgoApiKeyAvailable: !!process.env.SGO_API_KEY,
        playersAttempted: 0,
        oddsLineResolved: 0,
        oddsLineMissing: 0,
        staleLineRejected: 0,
        zeroLineRejected: 0,
        nonFiniteRejected: 0,
        lowEdgeRejected: 0,
        zeroEdgeRejected: 0,
        noSignalRejected: 0,
        engineErrors: 0,
        signalsBeforeSuppression: 0,
        signalsAfterSuppression: 0,
        engineDurationMs: 0,
        startedAt: Date.now(),
      };

      // Build ESPN athlete ID → DB player map for O(1) lookup
      const espnIdToDbPlayer = new Map<number, typeof allDbPlayers[0]>();
      for (const p of allDbPlayers) {
        if (p.espnAthleteId) espnIdToDbPlayer.set(p.espnAthleteId, p);
      }

      // Flatten both teams' players into a single list for uniform processing
      const allAthletes: Array<{ athlete: any; statMap: Record<string, any>; teamAbbr: string; opponentAbbr: string; minutes: number }> = [];
      for (const teamData of (boxscore.players ?? [])) {
        const teamAbbr = normAbbr(teamData.team?.abbreviation ?? "");
        const opponentAbbr = teamAbbr === homeTeamAbbr ? awayTeamAbbr : homeTeamAbbr;
        const athletes = teamData.statistics?.[0]?.athletes ?? [];
        const labels: string[] = teamData.statistics?.[0]?.labels ?? [];
        for (const athlete of athletes) {
          if (!athlete.athlete) continue;
          const stats = athlete.stats ?? [];
          const statMap: Record<string, any> = {};
          labels.forEach((label: string, idx: number) => { statMap[label.toLowerCase()] = stats[idx]; });
          const minStr: string = statMap["min"] || "0";
          const minParts = minStr.split(":");
          const minutes = minParts.length === 2
            ? parseInt(minParts[0]) + parseInt(minParts[1]) / 60
            : parseFloat(minStr) || 0;
          allAthletes.push({ athlete, statMap, teamAbbr, opponentAbbr, minutes });
        }
      }

      for (const { athlete, statMap, teamAbbr, opponentAbbr, minutes } of allAthletes) {
          // Loosened from 3 → 1 minute. Early-game scenarios (e.g. a starter
          // who just checked in or returned from a sub) were being skipped
          // entirely. With ample API headroom we'd rather evaluate them.
          if (minutes < 1) continue;

          const playerName: string = athlete.athlete.displayName ?? "";
          const espnAthId = parseInt(athlete.athlete.id, 10);
          const dbPlayer = espnIdToDbPlayer.get(espnAthId);
          if (!dbPlayer) {
            console.warn(`[live-signals] No DB match for ESPN athlete ${espnAthId} (${playerName}) — skipping`);
            continue;
          }
          diag.playersAttempted += 1;

          // Initialize engineOutput entry for this player
          if (!engineOutput[dbPlayer.id]) engineOutput[dbPlayer.id] = {};

          const liveStats: Record<string, number> = {
            points:   parseStat(statMap["pts"]),
            rebounds: parseStat(statMap["reb"]),
            assists:  parseStat(statMap["ast"]),
            steals:   parseStat(statMap["stl"]),
            blocks:   parseStat(statMap["blk"]),
            threes:   parseMade(statMap["3pt"] ?? statMap["fg3m"] ?? "0"),
          };
          const fouls = parseStat(statMap["pf"]);

          // Live shooting splits for hot/cold efficiency modifier
          const fgRaw  = statMap["fg"]  ?? "";
          const ftRaw  = statMap["ft"]  ?? "";
          const fg3Raw = statMap["3pt"] ?? statMap["fg3m"] ?? "";
          const liveFgm  = parseMade(fgRaw);  const liveFga  = parseAttempted(fgRaw);
          const liveFtm  = parseMade(ftRaw);  const liveFta  = parseAttempted(ftRaw);
          const liveFg3m = parseMade(fg3Raw); const liveFg3a = parseAttempted(fg3Raw);

          for (const { statType, components } of LIVE_STAT_CONFIGS) {
            try {
              const currentStat = components.reduce((sum, c) => sum + (liveStats[c] ?? 0), 0);
              const lineCacheKey = `${playerName}|${statType}`;

              if (!oddsPlayerCache.has(lineCacheKey)) {
                let resolved = false;
                if (oddsEventId && (process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2)) {
                  let oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, true);
                  let bookKeys = Object.keys(oddsResult.books);
                  if (bookKeys.length === 0 && !oddsResult.isDegraded) {
                    oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, false);
                    bookKeys = Object.keys(oddsResult.books);
                  }
                  if (process.env.DEBUG_PIPELINE === "true") {
                    console.log(`[PIPELINE][NBA][${oddsEventId ?? "unknown"}] raw: player=${playerName} stat=${statType} books=${bookKeys.join(",") || "none"} isDegraded=${oddsResult.isDegraded}`);
                  }
                  if (bookKeys.length > 0) {
                    const oddsBookDict: Record<string, { line: number; overOdds: number; underOdds: number }> = {};
                    for (const k of bookKeys) {
                      const b = oddsResult.books[k];
                      if (b && Number.isFinite(b.line) && Number.isFinite(b.overOdds) && Number.isFinite(b.underOdds)) {
                        oddsBookDict[k] = { line: b.line, overOdds: b.overOdds, underOdds: b.underOdds };
                      }
                    }
                    const normalized = normalizeOdds(oddsBookDict);
                    const medianLine = normalized.medianLine ?? (() => {
                      const lines = bookKeys.map(k => oddsResult.books[k].line);
                      const sortedLines = [...lines].sort((a, b) => a - b);
                      return sortedLines[Math.floor(sortedLines.length / 2)];
                    })();
                    if (process.env.DEBUG_PIPELINE === "true") {
                      console.log(`[PIPELINE][NBA][${oddsEventId ?? "unknown"}] processed: player=${playerName} stat=${statType} medianLine=${medianLine} books=${normalized.booksAvailable} isDegraded=${oddsResult.isDegraded}`);
                    }
                    oddsPlayerCache.set(lineCacheKey, { line: medianLine, bookKeys, isDegraded: oddsResult.isDegraded, oddsFetchedAt: oddsResult.fetchedAt || Date.now() });
                    resolved = true;
                  }
                }
                if (!resolved && process.env.SGO_API_KEY) {
                  const sgoResult = await getSGOPlayerLine(homeTeamAbbr, awayTeamAbbr, playerName, statType);
                  if (sgoResult !== null) {
                    if (process.env.DEBUG_PIPELINE === "true") {
                      console.log(`[PIPELINE][NBA][sgo] processed: player=${playerName} stat=${statType} sgoLine=${sgoResult}`);
                    }
                    oddsPlayerCache.set(lineCacheKey, { line: sgoResult, bookKeys: ["sgo"], isDegraded: false, oddsFetchedAt: Date.now() });
                    resolved = true;
                  }
                }
                if (!resolved) {
                  if (process.env.DEBUG_PIPELINE === "true") {
                    console.log(`[PIPELINE][NBA] raw: player=${playerName} stat=${statType} skipReason=noLineResolved`);
                  }
                  oddsPlayerCache.set(lineCacheKey, null);
                }
              }

              const oddsEntry = oddsPlayerCache.get(lineCacheKey);
              if (!oddsEntry) { diag.oddsLineMissing += 1; continue; }
              diag.oddsLineResolved += 1;
              const liveLine = oddsEntry.line;

              const oddsAge = Date.now() - (oddsEntry.oddsFetchedAt ?? 0);
              if (period >= 3 && oddsAge > NBA_2H_STALE_LINE_MS) {
                console.warn(`[NBA 2H STALE LINE] ${dbPlayer.name} (${statType}) — odds ${Math.round(oddsAge / 1000)}s old, rejecting`);
                diag.staleLineRejected += 1;
                continue;
              }

              // buildEngineInput is the canonical gate for engine computation: called BEFORE
              // calculateProbability so that engineInput.line (not raw oddsEntry.line) drives the calc.
              const nbaPreInput = buildEngineInput({
                gameId,
                sport: "nba",
                playerId: String(dbPlayer.id),
                marketType: statType,
                line: liveLine,
              });
              const canonicalLine = nbaPreInput.line ?? liveLine;

              if (!canonicalLine || canonicalLine === 0) {
                if (process.env.DEBUG_PIPELINE === "true") {
                  console.log(`[PIPELINE][NBA] engineInput: player=${dbPlayer.name} stat=${statType} skipReason=zeroLine`);
                }
                console.warn(`[NBA] No valid line — play suppressed`, { playerName: dbPlayer.name, statType });
                diag.zeroLineRejected += 1;
                continue;
              }

              if (process.env.DEBUG_PIPELINE === "true") {
                console.log(`[PIPELINE][NBA][${oddsEventId ?? "unknown"}] engineInput: player=${dbPlayer.name} stat=${statType} canonicalLine=${canonicalLine} rawLine=${liveLine} halftimeStat=${currentStat} isDegraded=${oddsEntry.isDegraded ?? false}`);
              }

              const result = await storage.calculateProbability({
                playerId: dbPlayer.id,
                opponentTeam: opponentAbbr,
                halftimeMinutes: Math.round(minutes * 10) / 10,
                halftimeFouls: fouls,
                halftimeStat: currentStat,
                liveLine: canonicalLine,
                statType,
                halftimeScore: scoreStr,
                currentPeriod: period,
                gameClock: displayClock,
                gameSpread: gameLines?.spread ?? undefined,
                gameTotalLine: gameLines?.total ?? undefined,
                liveFgm,
                liveFga,
                liveFtm,
                liveFta,
                liveFg3m,
                liveFg3a,
                // Forward measured odds-fetch age (sec) so the NBA finalizer
                // elite gate can pass under genuinely fresh odds. Missing
                // oddsFetchedAt → NaN → finalizer treats as not-fresh
                // (fail-closed via deriveFreshOdds).
                oddsAgeSec: typeof oddsEntry.oddsFetchedAt === "number"
                  ? Math.max(0, Math.round((Date.now() - oddsEntry.oddsFetchedAt) / 1000))
                  : undefined,
              });

              // SIGNAL EVALUATION CONTRACT — strict sequential continues.
              // Do not reorder steps. Do not insert any side effects before step 5.
              //
              // Step 1: finite guard — must run before any arithmetic on result.probability.
              // NaN arithmetic silently produces NaN, which would corrupt all downstream values.
              if (!Number.isFinite(result.probability)) { diag.nonFiniteRejected += 1; continue; }

              // Step 2: compute edge (only after finite check)
              const edge = Math.abs(result.probability - 50);

              // Step 3: threshold gate — plays below minimum edge are not actionable.
              // Playoff calibration recovery: route-level cutoff is the loose
              // first pass (3-edge); the engine strict rules layer is the
              // canonical actionable gate. Stacking both at 5+8 starved the
              // high-confidence bucket in playoffs.
              if (edge < 3) {
                if (process.env.DEBUG_PIPELINE === "true" || process.env.DEBUG_NBA === "true") {
                  console.log(`[NBA_ROUTE_FILTER]`, { player: dbPlayer.name, market: statType, prob: Math.round(result.probability * 10) / 10, edge: Math.round(edge * 10) / 10, reason: "lowEdge_route_live" });
                }
                diag.lowEdgeRejected += 1;
                continue;
              }

              // Step 4a: explicit zero-edge exclusion — belt-and-suspenders, implied by step 3
              // (prob===50 → edge===0 < 5) but required by evaluation contract.
              if (result.probability === 50) {
                if (process.env.DEBUG_NBA === "true") {
                  console.log(`[NBA_FINAL_REJECT_REASON]`, { player: dbPlayer.name, market: statType, prob: result.probability, edge, reason: "zeroEdge_live" });
                }
                diag.zeroEdgeRejected += 1;
                continue;
              }

              // Step 4b: no-conviction guard.
              //
              // The engine's `noSignal` flag fires whenever ANY of the
              // following are true:
              //   • rawSide === "NO_SIGNAL"            (no direction at all)
              //   • preCalibrationNoSignal             (pre-cal modelEdgeRaw < 0.04)
              //   • displayConfidence < 58             (confidence floor)
              //   • modelEdgeFinal < 4                 (post-cal edge floor)
              //   • hasProjectionMismatch              (direction-projection conflict)
              //
              // Previously the live route skipped EVERY noSignal play, which
              // meant the live box score effectively required edge ≥ 8 to
              // surface anything — far stricter than the halftime route
              // (which only requires edge ≥ 4 + recommendedSide ≠ NO_SIGNAL).
              // Result: live games in Q1/Q2/Q3/Q4 commonly showed "no plays"
              // even when the engine had clear directional leans at edge 5–7.
              //
              // New rule: still skip true NO_SIGNAL (no direction) and
              // projection-mismatch plays (internally inconsistent), but
              // surface noSignal plays whose edge is at or above the route's
              // own actionable floor (edge ≥ 6). This aligns the live route
              // with halftime Tier C semantics without touching the engine.
              if (result.recommendedSide === "NO_SIGNAL") {
                if (process.env.DEBUG_NBA === "true") {
                  console.log(`[NBA_FINAL_REJECT_REASON]`, { player: dbPlayer.name, market: statType, prob: result.probability, edge, reason: "noDirection_live", recommendedSide: result.recommendedSide });
                }
                diag.noSignalRejected += 1;
                continue;
              }
              const projectionMismatch =
                Array.isArray((result as any).engineDiagnostics?.warnings) &&
                (result as any).engineDiagnostics.warnings.includes("direction_projection_mismatch");
              if (projectionMismatch) {
                if (process.env.DEBUG_NBA === "true") {
                  console.log(`[NBA_FINAL_REJECT_REASON]`, { player: dbPlayer.name, market: statType, prob: result.probability, edge, reason: "projectionMismatch_live" });
                }
                diag.noSignalRejected += 1;
                continue;
              }
              if (result.noSignal && edge < 6) {
                if (process.env.DEBUG_NBA === "true") {
                  console.log(`[NBA_FINAL_REJECT_REASON]`, { player: dbPlayer.name, market: statType, prob: result.probability, edge, reason: "noSignal_lowEdge_live" });
                }
                diag.noSignalRejected += 1;
                continue;
              }

              // Step 5: direction — derive from recommendedSide (strict > 50 / < 50 already
              // applied in storage.calculateProbability). All continue guards have passed.
              if (process.env.DEBUG_PIPELINE === "true") {
                console.log(`[PIPELINE][NBA][${oddsEventId ?? "unknown"}] player=${dbPlayer.name} stat=${statType} prob=${result.probability.toFixed(1)} edge=${edge.toFixed(1)} included=true`);
              }

              // NOTE: engineOutput is only populated for plays that pass all gates above.
              // Plays skipped by the continue guards will NOT have a stat-specific entry here.
              // The safety pass below (~line 2026) sets engineOutput[id] = {} for all
              // players that attempted calculation, ensuring top-level presence for all;
              // only per-stat data (engineOutput[id][statType]) is gate-guarded.
              // This is intentional: low-edge and noSignal plays are not actionable and
              // should not appear as candidate signals in any consumer.
              const engineBetDirection: "OVER" | "UNDER" =
                result.recommendedSide === "UNDER" ? "UNDER" :
                result.recommendedSide === "OVER" ? "OVER" :
                (result.probability > 50 ? "OVER" : "UNDER");

              engineOutput[dbPlayer.id][statType] = {
                probability: result.displayConfidence ?? Math.abs(result.probability - 50) + 50,
                betDirection: engineBetDirection,
                edge,
                line: canonicalLine,
                statType,
              };

              allSignals.push({
                playerName: dbPlayer.name,
                playerId: dbPlayer.id,
                statType,
                probability: result.displayConfidence ?? result.probability,
                betDirection: result.recommendedSide === "UNDER" ? "under" : "over",
                edge,
                line: canonicalLine,
                currentStat,
                gameId,
                team: teamAbbr,
                expectedTotal: result.expectedTotal,
                impliedProbability: result.impliedProbability ?? null,
                engineGeneratedAt: Date.now(),
                timingContext: "live" as const,
                engineDiagnostics: (result as any).engineDiagnostics ?? undefined,
              });
              console.log(`[ENGINE_OUTPUT] sport=nba player=${dbPlayer.name} market=${statType} side=${engineBetDirection} prob=${(result.displayConfidence ?? result.probability).toFixed(1)} edge=${edge.toFixed(1)} proj=${result.expectedTotal ?? "null"} line=${canonicalLine} timing=live`);
            } catch (calcErr: any) {
              diag.engineErrors += 1;
              console.warn(`[NBA][engineError] player=${dbPlayer?.name ?? playerName} stat=${statType} error=${calcErr?.message ?? String(calcErr)}`);
              if (process.env.DEBUG_PIPELINE === "true") {
                console.log(`[PIPELINE][NBA][${oddsEventId ?? "unknown"}] engineOutput: player=${dbPlayer?.name ?? playerName} stat=${statType} skipReason=engineError error=${calcErr?.message ?? String(calcErr)}`);
              }
            }
          }
      }

      // Safety pass: ensure all attempted players have an engineOutput entry
      for (const { athlete, minutes } of allAthletes) {
        if (!athlete.athlete) continue;
        const espnAthId = parseInt(athlete.athlete.id, 10);
        const dbPlayer = espnIdToDbPlayer.get(espnAthId);
        if (dbPlayer && minutes >= 3 && !engineOutput[dbPlayer.id]) {
          engineOutput[dbPlayer.id] = {};
        }
      }

      // Debug validation: confirm both teams covered and counts match
      const enginePlayerCount = Object.keys(engineOutput).length;
      const totalAttempted = allAthletes.filter(a => {
        if (!a.athlete.athlete) return false;
        const espnAthId = parseInt(a.athlete.athlete.id, 10);
        return espnIdToDbPlayer.has(espnAthId) && a.minutes >= 3;
      }).length;
      const teamAbbrsPresent = new Set(
        allAthletes
          .filter(a => {
            if (!a.athlete.athlete) return false;
            const espnAthId = parseInt(a.athlete.athlete.id, 10);
            return espnIdToDbPlayer.has(espnAthId) && a.minutes >= 3;
          })
          .map(a => a.teamAbbr)
      );
      console.log(`[live-signals] totalPlayers=${totalAttempted} enginePlayers=${enginePlayerCount} teams=${Array.from(teamAbbrsPresent).join(",")}`);

      const overSignals = allSignals.filter(s => s.betDirection === "over").length;
      const underSignals = allSignals.filter(s => s.betDirection === "under").length;
      const totalSignals = overSignals + underSignals;
      const overRatio = totalSignals > 0 ? overSignals / totalSignals : 0;
      const underRatio = totalSignals > 0 ? underSignals / totalSignals : 0;
      const avgEdgeOver = overSignals > 0 ? allSignals.filter(s => s.betDirection === "over").reduce((sum, s) => sum + s.edge, 0) / overSignals : 0;
      const avgEdgeUnder = underSignals > 0 ? allSignals.filter(s => s.betDirection === "under").reduce((sum, s) => sum + s.edge, 0) / underSignals : 0;
      const engineOverCount = Object.values(engineOutput).reduce((sum, pData) => {
        return sum + Object.values(pData).filter((v: any) => v?.betDirection === "OVER").length;
      }, 0);
      const engineUnderCount = Object.values(engineOutput).reduce((sum, pData) => {
        return sum + Object.values(pData).filter((v: any) => v?.betDirection === "UNDER").length;
      }, 0);
      const engineTotal = engineOverCount + engineUnderCount;
      const engineOverRatio = engineTotal > 0 ? engineOverCount / engineTotal : 0;
      console.log(
        `[live-signals-summary] totalPlayers=${totalAttempted} enginePlayers=${enginePlayerCount} ` +
        `overCount=${overSignals} underCount=${underSignals} ` +
        `overRatio=${overRatio.toFixed(2)} underRatio=${underRatio.toFixed(2)} ` +
        `avgEdgeOver=${avgEdgeOver.toFixed(1)} avgEdgeUnder=${avgEdgeUnder.toFixed(1)} ` +
        `noSignals=${totalAttempted - totalSignals} ` +
        `engineOverUnder=${engineOverCount}/${engineUnderCount} engineOverRatio=${engineOverRatio.toFixed(2)}`
      );
      if (totalSignals > 4 && underRatio > 0.75) {
        console.warn(`[NBA SKEW WARNING] Under-heavy distribution detected: underRatio=${underRatio.toFixed(2)} (${underSignals}/${totalSignals})`);
      } else if (totalSignals > 4 && overRatio > 0.75) {
        console.warn(`[NBA SKEW WARNING] Over-heavy distribution detected: overRatio=${overRatio.toFixed(2)} (${overSignals}/${totalSignals})`);
      }
      console.log(`[QUICK VIEW DEBUG] live-signals total engine plays: ${allSignals.length}`);

      const preSuppressionCount = allSignals.length;
      const suppressedSignals = applyBatchFamilySuppression(allSignals);
      allSignals.length = 0;
      allSignals.push(...suppressedSignals);
      console.log(`[FAMILY_SUPPRESS] live-signals: ${preSuppressionCount} → ${allSignals.length} after family suppression`);

      // NBA Calibration v2 — conflicting OVER/UNDER side suppression.
      const preConflictCount = allSignals.length;
      const conflictResolved = applyNbaConflictSuppression(allSignals);
      allSignals.length = 0;
      allSignals.push(...conflictResolved);
      if (preConflictCount !== allSignals.length) {
        console.log(`[NBA_CONFLICT_SUPPRESS] live-signals: ${preConflictCount} → ${allSignals.length}`);
      }

      const survivingKeys = new Set(allSignals.map(s => `${s.playerId}|${s.statType}`));
      for (const pid of Object.keys(engineOutput)) {
        const pData = engineOutput[Number(pid)];
        if (!pData) continue;
        for (const st of Object.keys(pData)) {
          if (!survivingKeys.has(`${pid}|${st}`)) {
            delete pData[st];
          }
        }
      }

      console.log("[DIRECTIONAL_SPLIT]", JSON.stringify(getDirectionalSplit()));
      console.log(`[QUICK VIEW DEBUG] live-signals final rendered: ${allSignals.length}`);

      allSignals.sort((a, b) => {
        if (b.edge !== a.edge) return b.edge - a.edge;
        return b.probability - a.probability;
      });

      // ─── Engine stats observability ────────────────────────────────────────
      const nbaEngineStart = Date.now();
      console.log(`[ENGINE START][NBA] game=${gameId} signals=${allSignals.length}`);
      const nbaValidationAcc = { skipped: 0, failureReasons: [] as string[] };
      const nbaOutputAcc = { rejected: 0, rejectionReasons: [] as string[] };
      const nbaRawOutputs = allSignals.map((s) => {
        const input = buildEngineInput({
          gameId,
          sport: "nba",
          playerId: String(s.playerId),
          marketType: s.statType,
          line: s.line,
        });
        const line = input.line;
        const projection = line != null ? line + (s.edge * (s.betDirection === "over" ? 1 : -1)) : null;
        const edge = Number.isFinite(s.edge) ? s.edge : null;
        const side = (s.betDirection === "over" ? "OVER" : "UNDER") as "OVER" | "UNDER";
        console.log(`[ENGINE INPUT][NBA] player=${s.playerName} stat=${s.statType} line=${line} proj=${projection} edge=${edge}`);
        console.log(`[ENGINE PROJECTION][NBA] player=${s.playerName} stat=${s.statType} projection=${projection} side=${side}`);
        return {
          id: `${s.playerId}_${s.statType}`,
          sport: "nba" as const,
          market: s.statType,
          player: s.playerName,
          playerName: s.playerName,
          gameId,
          line,
          projection,
          probability: s.probability / 100,
          edge,
          recommendedSide: side,
          confidence: s.edge >= 10 ? "ELITE" as const : s.edge >= 7 ? "STRONG" as const : "LEAN" as const,
          sportsbook: "consensus",
          derivedLine: false,
          createdAt: input.createdAt,
        };
      });
      // NBA Engine Isolation: use sport-specific validation (no shared filters)
      const nbaEngineResult = processNBAEngine(nbaRawOutputs.map(o => ({
        ...o,
        probability: typeof o.probability === "number" ? o.probability * 100 : o.probability,
      })));
      const validNbaEngineSignals = nbaEngineResult.plays;
      const validNbaSignalIds = new Set(validNbaEngineSignals.map((s) => s.id));
      const validatedNbaSignals = allSignals.filter((s) => validNbaSignalIds.has(`${s.playerId}_${s.statType}`));
      for (const sig of validNbaEngineSignals) console.log(`[ENGINE OUTPUT VALID][NBA] player=${sig.playerName} stat=${sig.market} line=${sig.line} proj=${sig.projection}`);
      console.log(`[NBA ENGINE] mode=${nbaEngineResult.mode} plays=${nbaEngineResult.plays.length} fallback=${nbaEngineResult.diagnostics.fallbackTriggered} filtered=${nbaEngineResult.diagnostics.totalFiltered}`);
      if (nbaEngineResult.diagnostics.reasonsFilteredOut.length > 0) {
        console.warn(`[NBA ENGINE FILTERED] reasons=${nbaEngineResult.diagnostics.reasonsFilteredOut.slice(0, 5).join("; ")}`);
      }
      // Sport-isolation drift trace — observe engine output, do not modify it.
      for (const play of nbaEngineResult.plays) {
        emitDriftTrace("nba", {
          engineOwner: "engines/nba/index.ts:processNBAEngine",
          routeOwner: "GET /api/live-signals",
          oddsSource: (play as any).lineSource ?? "live_inplay",
          confidenceSource: nbaEngineResult.diagnostics.fallbackTriggered ? "engine_fallback" : "engine_strict",
          fallbackPath: nbaEngineResult.diagnostics.fallbackTriggered ? "strict_fallback" : "none",
          thresholdSource: "engines/nba/types.ts:NBA_STRICT_RULES",
          staleHandling: (play as any).derivedLine ? "derived" : "n/a",
          playerName: play.playerName,
          market: play.market,
          edge: typeof play.edge === "number" ? play.edge : undefined,
          probability: typeof play.probability === "number" ? play.probability : undefined,
          confidenceTier: (play as any).confidence ?? (play as any).confidenceTier,
        });
      }
      recordEngineRun("nba", {
        gamesProcessed: 1,
        signalsGenerated: validNbaEngineSignals.length,
        signalsSkipped: nbaEngineResult.diagnostics.totalFiltered,
        rejectedSignals: nbaEngineResult.diagnostics.totalFiltered,
        rejectionReasons: nbaEngineResult.diagnostics.reasonsFilteredOut.slice(0, 10),
        failureReasons: [],
        latencyMs: Date.now() - nbaEngineStart,
      });

      for (const s of validatedNbaSignals) {
        const dir = (s.betDirection ?? "").toUpperCase();
        if (dir === "OVER" || dir === "UNDER") {
          recordSurfacedSignal(dir, Number(s.probability ?? 50) / 100, s.statType, s.edge, (s as any).timingContext ?? "live");
        }
        const diag = (s as any).engineDiagnostics;
        const engineProjection = (s as any).expectedTotal != null ? Number((s as any).expectedTotal) : Number(s.line) + (s.edge * (s.betDirection === "over" ? 1 : -1));
        // [NBA Hardening v1] Strict probability validation at the route boundary.
        // Replaces the legacy `Number(s.probability ?? 0)` silent coercion.
        // Type-check FIRST so null/""/undefined cannot coerce to 0 via Number().
        // signalScore is NEVER substituted; invalid probability => skip + log.
        const rawProb = s.probability;
        const probValid = typeof rawProb === "number" && Number.isFinite(rawProb) && rawProb >= 0 && rawProb <= 100;
        if (!probValid) {
          console.warn("[NBA_PERSIST_REJECT]", {
            reason: "invalid_probability_at_route",
            player: s.playerName,
            market: s.statType,
            recommendedSide: dir,
            probability: rawProb,
            probabilityType: typeof rawProb,
            edge: s.edge,
          });
          continue;
        }
        const probNum = rawProb;
        console.log(`[PERSIST_CHECK] sport=nba player=${s.playerName} market=${s.statType} proj=${engineProjection} line=${s.line} timing=${(s as any).timingContext ?? "live"}`);
        trackPlay({
          gameId: (s as any).gameId || gameId,
          playerId: s.playerId ? String(s.playerId) : null,
          playerName: s.playerName,
          team: (s as any).team ?? null,
          sport: "nba",
          market: s.statType,
          direction: s.betDirection as "over" | "under",
          line: Number(s.line),
          projection: engineProjection,
          probability: probNum,
          edge: s.edge != null ? Number(s.edge) : 0,
          sportsbook: "consensus",
          derivedLine: false,
          createdAt: (s as any).engineGeneratedAt ?? Date.now(),
          diagnostics: diag ? {
            archetype: diag.archetype,
            fragilityScore: diag.fragilityScore,
            fragilityPenalty: diag.fragilityPenalty,
            fragilityReasons: diag.fragilityReasons,
            familyId: diag.familyId,
            siblingCount: diag.siblingCount,
            siblingRank: diag.siblingRank,
            flagshipOrDerivative: diag.flagshipOrDerivative,
            familyPenaltyFactor: diag.familyPenaltyFactor,
            calibrationTrack: diag.calibrationTrack,
            confidenceCeilingApplied: diag.confidenceCeilingApplied,
            ceilingReason: diag.ceilingReason,
            rawProbOver: diag.rawProbOver,
            rawProbUnder: diag.rawProbUnder,
            finalProbOver: diag.finalProbOver,
            finalProbUnder: diag.finalProbUnder,
            displayConfidence: diag.displayConfidence,
            modelEdge: diag.modelEdge,
            minutesExpected: diag.minutesExpected,
            minutesVariance: diag.minutesVariance,
            marketType: diag.marketType,
            playerVolatilityScore: diag.playerVolatilityScore,
            comboCovarianceEstimate: diag.comboCovarianceEstimate,
            engineVersion: diag.engineVersion,
            // NBA Calibration v2 — forward finalizer telemetry through to
            // playTracker so the persistence layer can emit structured
            // [NBA_CALIBRATION_V2_PERSIST] logs (no DB column needed).
            calibrationVersion: diag.calibrationVersion,
            finalizerCapReason: diag.finalizerCapReason,
            finalizerMarketRiskTier: diag.finalizerMarketRiskTier,
            finalizerEliteGateApplied: diag.finalizerEliteGateApplied,
            finalizerHighBucketCapped: diag.finalizerHighBucketCapped,
            finalizerInitialPct: diag.finalizerInitialPct,
            finalizerFinalPct: diag.finalizerFinalPct,
            conflictingSideSuppressed: diag.conflictingSideSuppressed,
            conflictingSignalSuppressed: diag.conflictingSignalSuppressed ?? diag.conflictingSideSuppressed,
          } : undefined,
        }, storage).catch(console.warn);
      }

      diag.signalsBeforeSuppression = preSuppressionCount;
      diag.signalsAfterSuppression = validatedNbaSignals.length;
      diag.engineDurationMs = Date.now() - diag.startedAt;

      // Smarter cache TTL: a healthy result with actionable signals can be
      // cached for the full client poll interval, but an empty result
      // (transient odds miss, all gates rejected) is cached briefly so the
      // very next client poll re-runs and recovers — preventing the "AGAIN"
      // failure mode where a momentary miss hides badges for 20s.
      const enginePlayersWithStats = Object.values(engineOutput).filter(
        (p) => p && Object.keys(p).length > 0
      ).length;
      const ttl = (validatedNbaSignals.length > 0 || enginePlayersWithStats > 0)
        ? LIVE_SIGNALS_TTL_HEALTHY
        : LIVE_SIGNALS_TTL_EMPTY;

      const nowTs = Date.now();
      const payload = { signals: validatedNbaSignals, engineOutput, diagnostics: diag };
      liveSignalsCache.set(gameId, { ts: nowTs, ttl, payload });
      // Freshness Integrity Fix #3.3 — successful engine recompute carries a
      // real timestamp; UI uses this to detect feed advance and prove freshness.
      res.json({ ...payload, updatedAt: nowTs, generatedAt: nowTs, stale: false });
    } catch (e) {
      console.warn(`[LiveSignals] Error for game ${gameId}:`, (e as any).message);
      const nowTs = Date.now();
      // Phase 5.4 — do not blow away a recent good cache on a transient failure.
      // If a previous payload exists and is < 60s old, serve it back marked as
      // degraded so the UI keeps showing the last-known-good signals (with a
      // stale badge) instead of clearing during a brief upstream blip.
      const previous = liveSignalsCache.get(gameId);
      if (previous && nowTs - previous.ts <= 60_000) {
        const ageSec = Math.round((nowTs - previous.ts) / 1000);
        console.log(`[LiveSignals] Serving preserved payload for ${gameId} during transient failure (age=${ageSec}s)`);
        return res.json({
          ...previous.payload,
          updatedAt: previous.ts,
          generatedAt: nowTs,
          stale: true,
          degraded: true,
          mode: "preserved",
        });
      }
      const payload = { signals: [], engineOutput: {}, diagnostics: { reason: "exception", error: (e as any)?.message ?? String(e), inProgress: false } };
      liveSignalsCache.set(gameId, { ts: nowTs, ttl: LIVE_SIGNALS_TTL_PREFLIGHT, payload });
      // Freshness Integrity Fix #3.3 — exception path is genuinely stale:
      // updatedAt=0 + stale=true so the UI clears prior dots (Fix #3.6).
      res.json({ ...payload, updatedAt: 0, generatedAt: nowTs, stale: true, mode: "error" });
    }
  });

  // ── Unified Live Debug (admin) ─────────────────────────────────────────────
  // Phase 5 — single endpoint to verify MLB + NBA live freshness end-to-end.
  // Defined here (not with the other /api/admin/* routes) because the NBA
  // liveSignalsCache is route-scoped to registerRoutes and only in scope after
  // its declaration above. This is a pure read of in-memory state — no engine
  // recomputes are triggered.
  app.get("/api/admin/live-debug", requireAdmin, async (_req, res) => {
    try {
      const now = Date.now();
      const mlbEntries = Array.from(mlbEdgeCache.entries()).map(([gameId, entry]) => ({
        sport: "mlb" as const,
        gameId,
        updatedAt: entry.updatedAt,
        ageSec: entry.updatedAt ? Math.round((now - entry.updatedAt) / 1000) : null,
        createdAt: entry.createdAt,
        outputs: entry.outputs?.length ?? 0,
        qualifiedSignals: entry.qualifiedSignals?.length ?? 0,
        allSignals: entry.allSignals?.length ?? 0,
        isDegraded: entry.isDegraded ?? false,
        signalLocked: entry.signalLocked ?? false,
        preservedAt: (entry as any).preservedAt ?? null,
        tags: entry.gameCardTags ?? [],
      }));

      const nbaEntries = Array.from(liveSignalsCache.entries()).map(([gameId, entry]) => ({
        sport: "nba" as const,
        gameId,
        updatedAt: entry.ts,
        ageSec: entry.ts ? Math.round((now - entry.ts) / 1000) : null,
        ttlMs: entry.ttl,
        ttlExpiresInMs: entry.ts + entry.ttl - now,
        signals: entry.payload?.signals?.length ?? 0,
        engineOutputPlayers: entry.payload?.engineOutput
          ? Object.keys(entry.payload.engineOutput).length
          : 0,
        diagnosticsReason: (entry.payload as any)?.diagnostics?.reason ?? null,
      }));

      // Phase 11 — persistence section: pending plays, settled today, and a
      // best-effort failed counter. We compute these from a single recent slice
      // of persisted_plays to keep the call cheap. settledToday uses settledAt
      // (when grading actually finalized) rather than gameDate so late-grades
      // are counted correctly. failedLastRun is a placeholder until the grader
      // emits a structured failure counter.
      let persistenceSummary: {
        pendingPlays: number;
        settledToday: number;
        failedLastRun: number | null;
        failedLastRunNote?: string;
      } = { pendingPlays: 0, settledToday: 0, failedLastRun: null, failedLastRunNote: "not_yet_implemented" };
      try {
        const recent = await db
          .select({ id: persistedPlays.id, result: persistedPlays.result, gameDate: persistedPlays.gameDate, settledAt: persistedPlays.settledAt })
          .from(persistedPlays)
          .where(gte(persistedPlays.gameDate, daysAgoET(2)));
        const today = todayET();
        const isSettledToday = (p: any) => {
          if (!p.result || p.result === "pending") return false;
          if (p.settledAt) {
            const d = new Date(p.settledAt);
            if (!Number.isNaN(d.getTime())) {
              const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
              return etDate === today;
            }
          }
          return p.gameDate === today;
        };
        persistenceSummary = {
          pendingPlays: recent.filter((p: any) => !p.result || p.result === "pending").length,
          settledToday: recent.filter(isSettledToday).length,
          failedLastRun: null,
          failedLastRunNote: "not_yet_implemented",
        };
      } catch (err) {
        console.warn("[admin/live-debug] persistence summary unavailable:", (err as any)?.message);
      }

      return res.json({
        now,
        mlb: {
          activeGames: getActiveGames().length,
          edgeEntries: mlbEntries,
        },
        nba: {
          cachedGames: nbaEntries.length,
          cacheEntries: nbaEntries,
          ttls: {
            healthyMs: LIVE_SIGNALS_TTL_HEALTHY,
            emptyMs: LIVE_SIGNALS_TTL_EMPTY,
            preflightMs: LIVE_SIGNALS_TTL_PREFLIGHT,
          },
        },
        persistence: persistenceSummary,
      });
    } catch (e: any) {
      console.error("[admin/live-debug]", e.message);
      return res.status(500).json({ error: "Failed to fetch unified live debug snapshot" });
    }
  });

  // ── Injury Report ──────────────────────────────────────────────────────────
  // Polls ESPN's public injury feed and caches results for 5 minutes.
  let injuryCache: { data: any[]; timestamp: number } | null = null;
  const INJURY_TTL = 5 * 60 * 1000;

  app.get("/api/injuries", async (_req, res) => {
    try {
      if (injuryCache && Date.now() - injuryCache.timestamp < INJURY_TTL) {
        return res.json(injuryCache.data);
      }
      const response = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
      );
      if (!response.ok) throw new Error("ESPN injuries API unavailable");
      const data = await response.json() as any;

      const injuries: any[] = [];
      for (const team of (data.injuries ?? [])) {
        const teamAbbr: string = team.team?.abbreviation ?? "";
        for (const item of (team.injuries ?? [])) {
          const athlete = item.athlete ?? {};
          injuries.push({
            playerId: athlete.id ?? "",
            playerName: athlete.displayName ?? athlete.fullName ?? "",
            team: teamAbbr,
            status: item.status ?? "Unknown",
            type: item.type ?? "",
            detail: item.longComment ?? item.shortComment ?? "",
          });
        }
      }
      injuryCache = { data: injuries, timestamp: Date.now() };
      res.json(injuries);
    } catch (e) {
      if (injuryCache) return res.json(injuryCache.data);
      res.status(502).json({ message: "Injury data unavailable" });
    }
  });

  // ── Per-game 2H view — consumes 1 free play for free users ─────────────────
  app.post("/api/2h-game-view", requirePlayAccess, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      res.json({ ok: true, playsUsed: user?.playsUsed ?? 0, playsUsedToday: user?.playsUsedToday ?? 0 });
    } catch (err) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Halftime Best Plays ─────────────────────────────────────────────────────
  // Returns top probability plays across all live halftime games.
  // All authenticated users can fetch — free users pay 1 play per game unlock via /api/2h-game-view.
  //
  // HALFTIME LINE AUDIT
  // Current line source: getPlayerOdds() → The Odds API /v4/sports/basketball_nba/events/{id}/odds
  //   with in_play=true (live halftime-adjusted lines, not pre-game lines)
  // H1 stat field: play.halftimeStat — sum of live box score components from ESPN summary API
  // Line field: play.line — real book line from Odds API or SGO (never fabricated)
  // lineSource: always "odds_api" — plays are skipped if no book line is available
  // Confirmed fix: added inPlay=true to getPlayerOdds() call so lines reflect current
  //   halftime-adjusted (in-game) odds rather than stale pre-game full-game prop lines.
  // APIs wired: ESPN scoreboard, ESPN boxscore/summary, The Odds API (player props + in_play)
  // Per-user verification state — keyed by userId to prevent cross-user false positives
  const halftimePipelineVerificationMap = new Map<number, {
    clientReceived: boolean;
    quickViewRendered: boolean;
    sourceCount: number;
    renderedCount: number;
    verifiedAt: number;
  }>();

  // Lightweight verification bridge — client posts back after receiving data and rendering Quick View
  app.post("/api/halftime-plays/verify-client", requireAuth, (req, res) => {
    const userId = req.session?.userId ?? 0;
    const { clientReceived, quickViewRendered, sourceCount, renderedCount } = req.body ?? {};
    const prev = halftimePipelineVerificationMap.get(userId) ?? {
      clientReceived: false, quickViewRendered: false, sourceCount: 0, renderedCount: 0, verifiedAt: 0,
    };
    const updated = {
      clientReceived: clientReceived === true ? true : prev.clientReceived,
      quickViewRendered: quickViewRendered === true ? true : prev.quickViewRendered,
      sourceCount: Number(sourceCount) || prev.sourceCount,
      renderedCount: Number(renderedCount) || prev.renderedCount,
      verifiedAt: Date.now(),
    };
    halftimePipelineVerificationMap.set(userId, updated);
    console.log("[HT_CLIENT_VERIFICATION]", { userId, ...updated });
    res.json({ ok: true });
  });

  app.get("/api/halftime-plays", requireAuth, async (req, res) => {
    // Observability flag for the NBA halftime pipeline. Defaults ON so the
    // existing DEBUG_NBA-gated diagnostic logs ([NBA_HT_LINE_TRACE],
    // [NBA_HT_NO_LIVE_LINE_SKIP], [NBA_HT_LINE_REJECTED],
    // [NBA_HT_LINE_SOFT_STALE], [NBA_ROUTE_FILTER], [NBA_FINAL_REJECT_REASON],
    // [NBA_HT_FINAL_SURFACED]) emit unconditionally during a 2H surfacing
    // investigation. Set OBSERVE_NBA_HT=false in env to silence once the
    // investigation closes. Scoped to this endpoint only — DEBUG_NBA is
    // unaffected elsewhere.
    const OBSERVE_NBA_HT = process.env.OBSERVE_NBA_HT !== "false";
    console.log("[HT_ENDPOINT_HIT]", {
      path: req.path,
      query: req.query,
      method: req.method,
      timestamp: Date.now(),
      observe: OBSERVE_NBA_HT,
    });
    try {
      const slateDate = getESTSlateDate();
      const gamesRes = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${slateDate}`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
      );
      if (!gamesRes.ok) throw new Error("ESPN API unavailable");
      const gamesData = await gamesRes.json() as any;

      const ESPN_TO_DB_LOCAL: Record<string, string> = {
        GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
        PHO: "PHX", UTH: "UTA", UTAH: "UTA", WSH: "WAS", CHO: "CHA",
      };
      const normAbbr = (a: string) => ESPN_TO_DB_LOCAL[a.toUpperCase()] ?? a.toUpperCase();

      const parseClockToSeconds = (c: string | null | undefined): number => {
        if (!c) return 0;
        if (c.includes(":")) {
          const [m, s] = c.split(":").map(Number);
          return m * 60 + s;
        }
        if (c.includes(".")) {
          return Math.floor(parseFloat(c));
        }
        return Number(c) || 0;
      };

      // ── Phase 1: tolerant halftime/early-3Q detection ──────────────────────
      // Returns isEligible + phase so the route can keep generating 2H plays
      // through the brittle end-of-Q2 → halftime → start-of-Q3 transition that
      // ESPN reports inconsistently across status fields.
      const isNbaHalftimeWindow = (args: {
        period: number;
        clockSeconds: number;
        statusDesc?: string;
        statusType?: string;
        statusState?: string;
      }): { isEligible: boolean; phase: "halftime" | "end_2q" | "early_3q" | "none" } => {
        const desc = String(args.statusDesc ?? "").toLowerCase();
        const type = String(args.statusType ?? "").toLowerCase();
        const state = String(args.statusState ?? "").toLowerCase();

        const explicitHalftime =
          desc.includes("half") ||
          type.includes("half") ||
          state.includes("half");

        const endSecondQuarter =
          args.period === 2 &&
          args.clockSeconds <= 15 &&
          (
            desc.includes("end") ||
            type.includes("end") ||
            desc.includes("halftime") ||
            args.clockSeconds <= 5
          );

        // Early-Q3 grace: keep 2H plays alive for the first 2 minutes of Q3
        // (clock counts down from 720s, so >=600s means <=2 min elapsed).
        const earlyThirdQuarter =
          args.period === 3 &&
          args.clockSeconds >= 600;

        if (explicitHalftime) return { isEligible: true, phase: "halftime" };
        if (endSecondQuarter) return { isEligible: true, phase: "end_2q" };
        if (earlyThirdQuarter) return { isEligible: true, phase: "early_3q" };

        return { isEligible: false, phase: "none" };
      }

      // ── Phase 4: derived 2H line helper ────────────────────────────────────
      // Used only as a fallback when no real live 2H book line is available.
      // Output is honestly labelled `lineSource: "derived_2h_fallback"` and
      // `isDegraded: true` upstream — it is NEVER passed off as a book line.
      const deriveSecondHalfLine = (args: {
        fullGameLine?: number | null;
        halftimeStat: number;
        seasonAvg: number;
        currentMinutes: number;
        projectedSecondHalfValue?: number | null;
      }): number | null => {
        if (args.fullGameLine && args.fullGameLine > args.halftimeStat) {
          return Math.round((args.fullGameLine - args.halftimeStat) * 2) / 2;
        }

        const remainingEstimate =
          args.projectedSecondHalfValue ??
          Math.max(0, args.seasonAvg - args.halftimeStat);

        if (!Number.isFinite(remainingEstimate) || remainingEstimate <= 0) return null;

        return Math.max(0.5, Math.round(remainingEstimate * 2) / 2);
      }

      const halftimeGames: any[] = [];
      for (const event of (gamesData.events ?? [])) {
        const comp = event.competitions?.[0];
        const status = comp?.status;
        const period = status?.period ?? 0;
        const clock = status?.displayClock ?? "";
        const statusType = status?.type?.name ?? "";
        const statusDesc: string = status?.type?.description ?? "";
        const statusState: string = status?.type?.state ?? "";
        const homeTeamDisplay = comp?.competitors?.find((c: any) => c.homeAway === "home")?.team?.displayName ?? "?";
        const awayTeamDisplay = comp?.competitors?.find((c: any) => c.homeAway === "away")?.team?.displayName ?? "?";

        const clockSeconds = parseClockToSeconds(clock);

        console.log("[GAME_STATE_AUDIT]", {
          game: `${awayTeamDisplay}@${homeTeamDisplay}`,
          period,
          clock,
          displayClock: clock,
          clockSeconds,
          statusType,
          statusDesc,
          statusState,
        });

        const htCheck = isNbaHalftimeWindow({
          period,
          clockSeconds,
          statusDesc,
          statusType,
          statusState,
        });

        console.log("[HALFTIME_DETECTION_RESULT]", {
          game: `${awayTeamDisplay}@${homeTeamDisplay}`,
          isHalftime: htCheck.isEligible,
          phase: htCheck.phase,
          period,
          clock,
          statusDesc,
          statusType,
          statusState,
        });

        if (!htCheck.isEligible) continue;

        const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
        const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
        halftimeGames.push({
          gameId: event.id,
          homeTeamAbbr: normAbbr(home?.team?.abbreviation ?? ""),
          awayTeamAbbr: normAbbr(away?.team?.abbreviation ?? ""),
          homeScore: parseInt(home?.score ?? "0", 10),
          awayScore: parseInt(away?.score ?? "0", 10),
          homeFull: home?.team?.displayName ?? "",
          awayFull: away?.team?.displayName ?? "",
          // Phase 2: phase metadata flows into per-play context so downstream
          // can downgrade early-Q3 grace plays if needed.
          halftimePhase: htCheck.phase,
          isEarly3QGrace: htCheck.phase === "early_3q",
        });
      }

      // Aggregated [HALFTIME_DETECTION_RESULT] — summary across all games after detection loop
      console.log("[HALFTIME_DETECTION_RESULT]", {
        totalGames: (gamesData.events ?? []).length,
        halftimeGames: halftimeGames.length,
        ids: halftimeGames.map(g => g.gameId),
      });

      if (halftimeGames.length === 0) {
        const emptyDiagnostics = {
          halftimeGamesDetected: 0,
          eligibleGames: 0,
          playersParsed: 0,
          oddsAttempts: 0,
          true2hLinesFound: 0,
          sgoLinesFound: 0,
          derivedFallbackLines: 0,
          skippedNoLine: 0,
          skippedStaleLine: 0,
          skippedAlreadyCleared: 0,
          playsGenerated: 0,
        };
        console.log("[HT_RESPONSE_ASSERT]", {
          totalGames: (gamesData.events ?? []).length,
          halftimeGames: 0,
          parsedMarkets: 0,
          secondHalfMarkets: 0,
          ...emptyDiagnostics,
        });
        console.log("STATUS: HALFTIME PIPELINE STILL BLOCKED — REASON: halftimeDetected");
        return res.json({
          plays: [],
          message: "No games at halftime right now.",
          eligibleGames: 0,
          eligibleGameDetails: [],
          diagnostics: emptyDiagnostics,
        });
      }

      // Load all DB players once — avoid repeated DB calls per athlete
      const allDbPlayers = await storage.getPlayers();
      const normDb = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

      // Cache Odds API event IDs and player odds per game to avoid redundant calls
      const oddsCache = new Map<string, Map<string, number | null>>();

      let totalOddsAttempts = 0;       // Total player+statType pairs for which in-play odds lookup was attempted
      let secondHalfMarketsFound = 0;  // Pairs where in-play (2H) books were returned
      let zeroBookInPlayCount = 0;     // Pairs where in-play returned 0 books and !isDegraded (absence signal)
      // Phase 7 — pipeline-reason counters surfaced under [HT_RESPONSE_ASSERT] and on the response.
      let playersParsed = 0;
      let true2hLinesFound = 0;
      let sgoLinesFound = 0;            // SGO path is currently disabled — counter reserved for the future
      let derivedFallbackLines = 0;
      let skippedNoLine = 0;
      let skippedStaleLine = 0;
      let skippedAlreadyCleared = 0;
      // secondHalfSourceAbsenceConfirmed computed AFTER loop: true only when ALL in-play lookups confirmed absent
      const allPlays: any[] = [];
      const volatilePlays: any[] = []; // Plays suppressed by degraded-line VALUE-tier filter — used in low-supply mode
      console.log(`[QUICK VIEW DEBUG] halftime games detected: ${halftimeGames.length} (${halftimeGames.map(g => `${g.awayTeamAbbr}@${g.homeTeamAbbr}`).join(", ")})`);
      console.log(`[QUICK VIEW DEBUG] data source: same calculateProbability engine as main plays feed (/api/live-signals)`);
      const ALL_STAT_CONFIGS: Array<{ statType: string; components: string[] }> = [
        { statType: "points",      components: ["points"] },
        { statType: "rebounds",    components: ["rebounds"] },
        { statType: "assists",     components: ["assists"] },
        { statType: "threes",      components: ["threes"] },
        { statType: "steals",      components: ["steals"] },
        { statType: "blocks",      components: ["blocks"] },
        { statType: "pts_reb",     components: ["points", "rebounds"] },
        { statType: "pts_ast",     components: ["points", "assists"] },
        { statType: "pts_reb_ast", components: ["points", "rebounds", "assists"] },
        { statType: "reb_ast",     components: ["rebounds", "assists"] },
        { statType: "stl_blk",     components: ["steals", "blocks"] },
      ];

      for (const game of halftimeGames) {
        // ── NBA_HT_GAME_SUMMARY observability: per-game counter snapshots ──
        // Record cumulative-counter values at the start of this game's loop
        // so the per-game delta can be reported in [NBA_HT_GAME_SUMMARY]
        // below. perGameRejectSamples collects up to 10 dropped
        // player+market+reason tuples to spot patterns (all-no-line vs
        // all-stale vs all-low-edge etc.) without flooding logs.
        const _gameStartAttempts = totalOddsAttempts;
        const _gameStartMarketsFound = secondHalfMarketsFound;
        const _gameStartZeroBook = zeroBookInPlayCount;
        const _gameStartSkippedNoLine = skippedNoLine;
        const _gameStartSkippedStale = skippedStaleLine;
        const _gameStartSkippedCleared = skippedAlreadyCleared;
        const perGameRejectSamples: Array<{ player: string; stat: string; reason: string }> = [];
        let perGameSurfaced = 0;
        // gameError is captured in [NBA_HT_GAME_SUMMARY] when an inner fetch
        // (boxscore, odds) or parsing step fails for this game. The outer
        // try/catch around the whole per-game body keeps an exception in one
        // game from killing the rest of the halftime cycle and guarantees the
        // summary still emits via the finally block.
        let gameError: string | null = null;
        // Resolve Odds API event ID for this game (for live prop lines)
        let oddsEventId: string | null = null;
        const oddsPlayerCache = new Map<string, { line: number; bookKeys: string[]; isDegraded: boolean; oddsFetchedAt: number; source?: string } | null>();
        // Phase 5 (relaxed 2026-05-02): book lines can be temporarily pulled
        // and slow-reposted around halftime. The original 5-min fresh / 10-min
        // hard-cap pair was too tight for playoff games where books routinely
        // suspend player props for 8-15 min through the intermission then
        // refresh with the 2H-adjusted line. Result: every line was hard-stale
        // rejected and the pipeline went empty for 7 days. New windows:
        //   Fresh: <= 8 min   (accept normally)
        //   Soft-stale: 8-25 min   (accept but flag degraded → engine demotion)
        //   Hard-stale: > 25 min   (route hard-cap reject)
        const HT_STALE_LINE_MS = 8 * 60 * 1000;
        const HT_HARD_STALE_LINE_MS = 25 * 60 * 1000;
        try {
        try {
          const { resolveOddsEventId: resolveId } = await import("./oddsService");
          oddsEventId = await resolveId(game.homeTeamAbbr, game.awayTeamAbbr);
        } catch { /* continue without odds */ }

        // Fetch game-level spread/total for pace & garbage-time modifiers
        let htGameLines: { spread: number | null; total: number | null; favorite: string | null } | null = null;
        if (oddsEventId && (process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2)) {
          try {
            const { getGameLines: fetchGameLines } = await import("./oddsService");
            htGameLines = await fetchGameLines(oddsEventId);
          } catch { /* optional */ }
        }

        const bsRes = await fetch(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.gameId}`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
        );
        if (!bsRes.ok) continue;
        const bsData = await bsRes.json() as any;
        const boxscore = bsData.boxscore;
        if (!boxscore) continue;

        const scoreStr = `${game.awayScore}-${game.homeScore}`;

        for (const teamData of (boxscore.players ?? [])) {
          const teamAbbr = normAbbr(teamData.team?.abbreviation ?? "");
          const opponentAbbr = teamAbbr === game.homeTeamAbbr ? game.awayTeamAbbr : game.homeTeamAbbr;
          const athletes = teamData.statistics?.[0]?.athletes ?? [];
          const labels: string[] = teamData.statistics?.[0]?.labels ?? [];

          for (const athlete of athletes) {
            if (!athlete.athlete) continue;
            const stats = athlete.stats ?? [];
            const statMap: Record<string, any> = {};
            labels.forEach((label: string, idx: number) => {
              statMap[label.toLowerCase()] = stats[idx];
            });

            const parseStat = (val: string) => {
              if (!val) return 0;
              if (val.includes("-")) {
                const parts = val.split("-");
                return parseInt(parts[parts.length - 1], 10) || 0;
              }
              return parseInt(val, 10) || 0;
            };
            const parseMade = (val: string) => {
              if (!val) return 0;
              if (val.includes("-")) return parseInt(val.split("-")[0], 10) || 0;
              return parseInt(val, 10) || 0;
            };
            const parseAttempted = (val: string) => {
              if (!val) return 0;
              if (val.includes("-")) { const p = val.split("-"); return parseInt(p[1] ?? p[0], 10) || 0; }
              return 0;
            };

            const minStr: string = statMap["min"] || "0";
            const minParts = minStr.split(":");
            const minutes = minParts.length === 2
              ? parseInt(minParts[0]) + parseInt(minParts[1]) / 60
              : parseFloat(minStr) || 0;

            if (minutes < 3) continue;

            const playerName: string = athlete.athlete.displayName ?? "";
            const normPlayerName = normDb(playerName);

            // Fast lookup — exact match first, then first+last fuzzy fallback
            let dbPlayer = allDbPlayers.find(p => normDb(p.name) === normPlayerName);
            if (!dbPlayer) {
              // Fuzzy: split ESPN name and match against DB first+last token set
              const espnWords = playerName.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/);
              const espnFirst = espnWords[0] ?? "";
              const espnLast = espnWords[espnWords.length - 1] ?? "";
              dbPlayer = allDbPlayers.find(p => {
                const dbWords = p.name.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/);
                const dbFirst = dbWords[0] ?? "";
                const dbLast = dbWords[dbWords.length - 1] ?? "";
                return dbFirst === espnFirst && dbLast === espnLast;
              });
            }
            if (!dbPlayer) {
              console.log(`[Halftime] Player not in DB: "${playerName}" (${teamAbbr})`);
              continue;
            }

            const liveStats: Record<string, number> = {
              points: parseStat(statMap["pts"]),
              rebounds: parseStat(statMap["reb"]),
              assists: parseStat(statMap["ast"]),
              steals: parseStat(statMap["stl"]),
              blocks: parseStat(statMap["blk"]),
              threes: parseMade(statMap["3pt"] ?? statMap["fg3m"] ?? "0"),
            };

            // H1 shooting splits for hot/cold efficiency modifier
            const htFgRaw  = statMap["fg"]  ?? "";
            const htFtRaw  = statMap["ft"]  ?? "";
            const htFg3Raw = statMap["3pt"] ?? statMap["fg3m"] ?? "";
            const htLiveFgm  = parseMade(htFgRaw);  const htLiveFga  = parseAttempted(htFgRaw);
            const htLiveFtm  = parseMade(htFtRaw);  const htLiveFta  = parseAttempted(htFtRaw);
            const htLiveFg3m = parseMade(htFg3Raw); const htLiveFg3a = parseAttempted(htFg3Raw);

            // Build season stat baselines from DB (fast) — fall back to ESPN live fetch only if null
            const dbSeasonStat: Record<string, number | null> = {
              points: dbPlayer.ppg ? Number(dbPlayer.ppg) : null,
              rebounds: dbPlayer.rpg ? Number(dbPlayer.rpg) : null,
              assists: dbPlayer.apg ? Number(dbPlayer.apg) : null,
              steals: dbPlayer.spg ? Number(dbPlayer.spg) : null,
              blocks: dbPlayer.bpg ? Number(dbPlayer.bpg) : null,
              threes: (dbPlayer as any).tpg ? Number((dbPlayer as any).tpg) : null,
            };

            // If any DB stat component is missing, fetch from ESPN to fill gaps
            const needsEspnFetch = Object.values(dbSeasonStat).some(v => v === null);
            if (needsEspnFetch) {
              try {
                const espnStatRes = await fetch(
                  `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${athlete.athlete.id}/statistics?lang=en&region=us`,
                  { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4000) }
                );
                if (espnStatRes.ok) {
                  const espnStatData = await espnStatRes.json() as any;
                  const espnStats: Record<string, number> = {};
                  for (const cat of (espnStatData.splits?.categories ?? [])) {
                    for (const s of (cat.stats ?? [])) espnStats[s.name] = s.value;
                  }
                  if (dbSeasonStat.points == null) dbSeasonStat.points = espnStats.avgPoints ?? null;
                  if (dbSeasonStat.rebounds == null) dbSeasonStat.rebounds = espnStats.avgRebounds ?? null;
                  if (dbSeasonStat.assists == null) dbSeasonStat.assists = espnStats.avgAssists ?? null;
                  if (dbSeasonStat.steals == null) dbSeasonStat.steals = espnStats.avgSteals ?? null;
                  if (dbSeasonStat.blocks == null) dbSeasonStat.blocks = espnStats.avgBlocks ?? null;
                  if (dbSeasonStat.threes == null) dbSeasonStat.threes = espnStats.avgThreePointFieldGoalsMade ?? null;
                }
              } catch { /* ignore */ }
            }

            const snapToHalf = (n: number) => Math.round(n * 2) / 2;

            for (const { statType, components } of ALL_STAT_CONFIGS) {
              try {
                // Season avg: sum of each component's average (null if any component is missing)
                const seasonParts = components.map(c => dbSeasonStat[c]);
                if (seasonParts.some(v => v == null)) continue;
                const seasonAvg = seasonParts.reduce((sum: number, v) => sum + (v as number), 0);
                if (seasonAvg < 0.5) continue;

                // H1 live stat: sum of each component from the live box score
                const halftimeStat = components.reduce((sum, c) => sum + (liveStats[c] ?? 0), 0);

                // Halftime odds lookup — STRICT LIVE 2H ONLY.
                // No pre-game fallback. No SGO scalar fallback. No degraded
                // last-known cache. If no fresh live 2H line exists, skip the
                // play. Source provenance is captured in oddsSource so the
                // surfaced play can prove which path delivered the line.
                let liveLine: number | null = null;
                let lineIsDegraded = false;
                let oddsSourceTag: string = "none";
                const lineCacheKey = `${playerName}|${statType}`;
                if (!oddsPlayerCache.has(lineCacheKey)) {
                  try {
                    if (oddsEventId && (process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2)) {
                      totalOddsAttempts++;
                      const oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, {
                        inPlay: true,
                        strictLive: true,
                        maxAgeMs: HT_STALE_LINE_MS,
                        allowDegraded: false,
                        allowCacheFirst: false,
                        allowThrottleFallback: false,
                      });
                      const bookKeys = Object.keys(oddsResult.books);
                      if (bookKeys.length === 0) {
                        zeroBookInPlayCount++;
                        if (OBSERVE_NBA_HT) {
                          console.log("[NBA_HT_LINE_TRACE]", JSON.stringify({
                            player: playerName, statType, bookKeys: [], rejectReason: "no_live_2h_line", source: "live_2h_odds_api",
                          }));
                        }
                        console.log(`[NBA_HT_LIVE_LINE_MISSING] ${playerName} (${statType}) — skipped (no fresh live 2H line)`);
                        oddsPlayerCache.set(lineCacheKey, null);
                      } else if (oddsResult.isDegraded) {
                        // Phase 9 — strict mode now returns isDegraded=true when
                        // every accepted book was inside the soft-stale window
                        // (lastUpdate within 5-15 min). Accept the line and let
                        // downstream tier reduction (lineIsDegraded → engine
                        // confidence floor) handle the trust loss instead of
                        // dropping the play entirely. This keeps the 2H pipeline
                        // alive during the brittle 5-10 min window when books
                        // slow-refresh player props around the half.
                        secondHalfMarketsFound++;
                        const lines = bookKeys.map(k => oddsResult.books[k].line);
                        const lineDetail = bookKeys.map((k, i) => `${k}=${lines[i]}`).join(" | ");
                        console.log(`[Halftime] Live 2H lines (DEGRADED soft-stale) for ${playerName} (${statType}): ${lineDetail}`);
                        const sortedLines = [...lines].sort((a, b) => a - b);
                        const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
                        oddsPlayerCache.set(lineCacheKey, {
                          line: medianLine,
                          bookKeys,
                          isDegraded: true,
                          oddsFetchedAt: oddsResult.fetchedAt || Date.now(),
                          source: "live_2h_odds_api_soft_stale",
                        });
                        if (OBSERVE_NBA_HT) {
                          console.log("[NBA_HT_LINE_TRACE]", JSON.stringify({
                            player: playerName, statType, bookKeys, oddsFetchedAt: oddsResult.fetchedAt,
                            oddsAgeMs: Date.now() - (oddsResult.fetchedAt || Date.now()), isDegraded: true,
                            line: medianLine, source: "live_2h_odds_api_soft_stale",
                          }));
                        }
                      } else {
                        secondHalfMarketsFound++;
                        const lines = bookKeys.map(k => oddsResult.books[k].line);
                        const lineDetail = bookKeys.map((k, i) => `${k}=${lines[i]}`).join(" | ");
                        console.log(`[Halftime] Live 2H lines for ${playerName} (${statType}): ${lineDetail}`);
                        // Median consensus — outlier-resistant
                        const sortedLines = [...lines].sort((a, b) => a - b);
                        const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
                        oddsPlayerCache.set(lineCacheKey, {
                          line: medianLine,
                          bookKeys,
                          isDegraded: false,
                          oddsFetchedAt: oddsResult.fetchedAt || Date.now(),
                          source: "live_2h_odds_api",
                        });
                        if (OBSERVE_NBA_HT) {
                          console.log("[NBA_HT_LINE_TRACE]", JSON.stringify({
                            player: playerName, statType, bookKeys, oddsFetchedAt: oddsResult.fetchedAt,
                            oddsAgeMs: Date.now() - (oddsResult.fetchedAt || Date.now()), isDegraded: false,
                            line: medianLine, source: "live_2h_odds_api",
                          }));
                        }
                      }
                    } else {
                      console.log(`[NBA_HT_LIVE_LINE_MISSING] ${playerName} (${statType}) — no Odds API event id or key`);
                      oddsPlayerCache.set(lineCacheKey, null);
                    }
                    // SGO halftime fallback intentionally disabled. SGO does not
                    // currently expose a verified live-2H freshness flag; using
                    // its scalar as a halftime line risks reintroducing pre-game
                    // values. Re-enable only via a new SGO function that returns
                    // { line, isLive2H: true, updatedAt } with updatedAt age
                    // <= HT_STALE_LINE_MS.
                  } catch (oddsErr: any) {
                    console.warn(`[NBA_HT_ODDS_ERROR] ${playerName} (${statType}) — ${oddsErr?.message ?? String(oddsErr)}`);
                    oddsPlayerCache.set(lineCacheKey, null);
                  }
                }
                playersParsed++;
                const oddsEntry = oddsPlayerCache.get(lineCacheKey);
                let derivedEntry: { line: number; bookKeys: string[]; isDegraded: boolean; oddsFetchedAt: number; source?: string } | null = null;
                if (oddsEntry != null) {
                  liveLine = oddsEntry.line;
                  lineIsDegraded = oddsEntry.isDegraded;
                  oddsSourceTag = (oddsEntry as any).source ?? "live_2h_odds_api";
                  if (oddsSourceTag === "live_2h_odds_api" && !lineIsDegraded) {
                    true2hLinesFound++;
                  }
                } else {
                  // ENGINE PROTOCOL — STRICT LIVE 2H ONLY (matches the contract
                  // declared at line ~5541). When no real live 2H book line is
                  // available we MUST skip the play. Synthetic derived lines
                  // (season-average minus halftime stat, full-game minus H1,
                  // etc.) are NOT allowed to surface as bettable plays — they
                  // produce phantom signals graded against a line that doesn't
                  // exist at any sportsbook. The previous "Phase 3 derived
                  // fallback" violated this protocol and is intentionally
                  // removed. The deriveSecondHalfLine helper above is kept
                  // only for potential internal calculator/audit use.
                  skippedNoLine++;
                  perGameRejectSamples.push({ player: playerName, stat: statType, reason: "no_live_2h_book_line_protocol" });
                  if (OBSERVE_NBA_HT) {
                    console.log(`[NBA_HT_NO_LIVE_LINE_SKIP]`, JSON.stringify({
                      playerName, statType, halftimeStat, seasonAvg,
                      reason: "no_live_2h_book_line_protocol",
                    }));
                  }
                  continue;
                }
                // Note: lineIsDegraded is no longer auto-rejected here. Soft-stale
                // book lines (Phase 5) and derived fallbacks (Phase 3) both ride
                // the degraded flag; downstream tier reduction handles confidence.
                // Use the effective entry (real book entry OR the derived fallback).
                const effectiveEntry = oddsEntry ?? derivedEntry!;
                const htOddsAge = Date.now() - (effectiveEntry.oddsFetchedAt ?? 0);
                // Phase 5: hard-reject only if line is older than the absolute
                // 10-min ceiling. The 5-min soft window is enforced upstream by
                // getPlayerOdds(maxAgeMs); anything that slipped past that gate
                // and survives this hard cap will be flagged as degraded below.
                if (!Number.isFinite(htOddsAge) || htOddsAge < 0 || htOddsAge > HT_HARD_STALE_LINE_MS) {
                  skippedStaleLine++;
                  perGameRejectSamples.push({ player: playerName, stat: statType, reason: `stale_line_hard_cap_${Math.round(htOddsAge / 1000)}s` });
                  if (OBSERVE_NBA_HT) {
                    console.warn(`[NBA_HT_LINE_REJECTED]`, JSON.stringify({
                      playerName, statType, ageMs: htOddsAge, maxAgeMs: HT_HARD_STALE_LINE_MS, rejectReason: "stale_line_hard_cap",
                    }));
                  }
                  continue;
                }
                // Soft-stale (5-10 min): keep the line but flag as degraded so
                // downstream confidence-tier reduction kicks in.
                if (htOddsAge > HT_STALE_LINE_MS) {
                  lineIsDegraded = true;
                  if (OBSERVE_NBA_HT) {
                    console.log(`[NBA_HT_LINE_SOFT_STALE]`, JSON.stringify({
                      playerName, statType, ageMs: htOddsAge, softCapMs: HT_STALE_LINE_MS,
                    }));
                  }
                }

                // Zero-line guard — a line of 0 is invalid and must not be passed to the engine.
                // This can occur if a book returns a zero point value due to a data error.
                if (!liveLine || liveLine === 0) {
                  perGameRejectSamples.push({ player: playerName, stat: statType, reason: "zero_line" });
                  if (OBSERVE_NBA_HT) {
                    console.warn(`[NBA_HT_LINE_REJECTED]`, JSON.stringify({
                      playerName, statType, liveLine, rejectReason: "zero_line",
                    }));
                  }
                  continue;
                }

                // Skip plays where the line has already been cleared at halftime —
                // these are not actionable (over already won, under already lost).
                // Check BEFORE running calculateProbability to save compute cost.
                if (halftimeStat >= liveLine) {
                  skippedAlreadyCleared++;
                  perGameRejectSamples.push({ player: playerName, stat: statType, reason: `already_cleared_${halftimeStat}vs${liveLine}` });
                  continue;
                }

                if (process.env.DEBUG_PIPELINE === "true") {
                  console.log(`[PIPELINE][NBA][HT] engineInput: player=${dbPlayer.name} stat=${statType} line=${liveLine} halftimeStat=${halftimeStat}`);
                }

                const result = await storage.calculateProbability({
                  playerId: dbPlayer.id,
                  opponentTeam: opponentAbbr,
                  halftimeMinutes: Math.round(minutes * 10) / 10,
                  halftimeFouls: parseStat(statMap["pf"]),
                  halftimeStat,
                  liveLine,
                  statType,
                  halftimeScore: scoreStr,
                  currentPeriod: 3,
                  gameClock: "12:00",
                  gameSpread: htGameLines?.spread ?? undefined,
                  gameTotalLine: htGameLines?.total ?? undefined,
                  liveFgm: htLiveFgm,
                  liveFga: htLiveFga,
                  liveFtm: htLiveFtm,
                  liveFta: htLiveFta,
                  liveFg3m: htLiveFg3m,
                  liveFg3a: htLiveFg3a,
                  // Unification with NBA Playoff Rotation Truth Layer:
                  // Pass gameId so getPlayoffRotationProfile() can use it for
                  // provenance, and gameDate (ET-local slate date) so
                  // seasonPhase resolves deterministically — not from raw
                  // UTC system clock, which can flip the slate date during
                  // late-night ET halftime windows. Without these the
                  // playoff rotation profile fetch path can be skipped or
                  // mis-bucketed and the engine falls back to season averages.
                  gameId: game.gameId,
                  gameDate: todayET(),
                  // Forward measured odds-fetch age (sec) so the NBA finalizer
                  // elite gate can pass under genuinely fresh odds. Missing
                  // oddsFetchedAt → undefined → finalizer treats as not-fresh
                  // (fail-closed via deriveFreshOdds).
                  oddsAgeSec: typeof effectiveEntry.oddsFetchedAt === "number"
                    ? Math.max(0, Math.round(htOddsAge / 1000))
                    : undefined,
                });

                // SIGNAL EVALUATION CONTRACT — evaluation order is strict, do not reorder:
                // Step 1: finite guard — must run before any arithmetic on result.probability.
                // NaN < 6 === false in JS, so without this guard a NaN probability would silently
                // pass the threshold check below and enter allPlays with garbage data.
                if (!Number.isFinite(result.probability)) {
                  perGameRejectSamples.push({ player: dbPlayer.name, stat: statType, reason: "non_finite_probability" });
                  continue;
                }

                // Step 2: compute edge — only after finite check
                let edge = Math.abs(result.probability - 50);

                // Step 3: threshold gate — plays below minimum edge are not actionable.
                // Playoff calibration recovery: lowered 6 → 4 → 3 (2026-05-02)
                // to align exactly with the NBA engine fallback rule
                // (NBA_FALLBACK_RULES.minEdge = 3 in server/engines/nba/types.ts).
                // The route should not be stricter than the engine itself —
                // anything the engine accepts as actionable should reach the
                // route's downstream qualification logic.
                if (edge < 3) {
                  perGameRejectSamples.push({ player: dbPlayer.name, stat: statType, reason: `lowEdge_route_halftime_e${Math.round(edge * 10) / 10}` });
                  if (OBSERVE_NBA_HT) {
                    console.log(`[NBA_ROUTE_FILTER]`, { player: dbPlayer.name, market: statType, prob: Math.round(result.probability * 10) / 10, edge: Math.round(edge * 10) / 10, reason: "lowEdge_route_halftime" });
                  }
                  continue;
                }

                // Step 4: explicit zero-edge exclusion (belt-and-suspenders; redundant with step 3
                // since prob===50 → edge===0 < 6, but required by evaluation contract).
                if (result.probability === 50) {
                  perGameRejectSamples.push({ player: dbPlayer.name, stat: statType, reason: "zeroEdge_halftime" });
                  if (OBSERVE_NBA_HT) {
                    console.log(`[NBA_FINAL_REJECT_REASON]`, { player: dbPlayer.name, market: statType, prob: result.probability, edge, reason: "zeroEdge_halftime" });
                  }
                  continue;
                }

                // Confidence tier reduction for degraded lines — UNIFIED with
                // the NBA Playoff Rotation Truth Layer. The flat "subtract 5"
                // demotion is now role-aware:
                //   STARTER       → no demotion (the player's 2H minutes
                //                   projection is well-anchored by playoff
                //                   evidence, so a stale book line is a
                //                   weaker signal than the role evidence).
                //   CORE_ROTATION → half demotion (-2) and never volatile;
                //                   role is solid but not bullet-proof.
                //   FRINGE / NONE → original behavior: -5 across the board,
                //                   VALUE-tier falls into the volatile pool.
                // Buckets are computed in storage.ts (engineDiagnostics.playoffRoleBucket).
                let isVolatile = false;
                const _eng: any = (result as any).engineDiagnostics ?? {};
                const playoffRoleBucket: "STARTER" | "CORE_ROTATION" | "FRINGE" | "NONE" =
                  _eng.playoffRoleBucket ?? "NONE";
                const _edgeBefore = edge;
                if (lineIsDegraded) {
                  if (playoffRoleBucket === "STARTER") {
                    // No demotion — keep the engine's conviction intact.
                  } else if (playoffRoleBucket === "CORE_ROTATION") {
                    // Half demotion (-2) but clamp to the tier FLOOR so an
                    // ELITE play stays ELITE, a STRONG play stays STRONG,
                    // and a VALUE play stays VALUE. The role evidence is
                    // strong enough that a stale book line shouldn't drop
                    // a tier — only erode within-tier conviction.
                    if (edge >= 20) {
                      edge = Math.max(edge - 2, 20); // floor at ELITE
                    } else if (edge >= 15) {
                      edge = Math.max(edge - 2, 15); // floor at STRONG
                    } else {
                      edge = Math.max(edge - 2, 10); // floor at VALUE; never volatile
                    }
                  } else {
                    // FRINGE / NONE — original demotion ladder.
                    if (edge >= 20) {
                      edge = Math.min(edge - 5, 19); // ELITE → STRONG
                    } else if (edge >= 15) {
                      edge = Math.min(edge - 5, 14); // STRONG → VALUE
                    } else {
                      // VALUE tier with degraded line — move to volatile pool for low-supply mode
                      console.log(`[QUICK VIEW DEBUG][ODDS FALLBACK] Degraded VALUE-tier play moved to volatile pool for ${playerName} (${statType})`);
                      isVolatile = true;
                    }
                  }
                  console.log("[NBA_HT_PLAYOFF_UNIFY]", JSON.stringify({
                    player: playerName,
                    statType,
                    bucket: playoffRoleBucket,
                    roleCert: _eng.playoffRoleCertainty ?? null,
                    rotationRank: _eng.rotationRankEstimate ?? null,
                    closeTrust: _eng.closeGameTrustScore ?? null,
                    edgeBefore: Math.round(_edgeBefore * 10) / 10,
                    edgeAfter: Math.round(edge * 10) / 10,
                    isVolatile,
                    rotationDataSource: _eng.playoffRotationDataSource ?? null,
                  }));
                }

                // NO_SIGNAL guard: skip plays where engine has no directional conviction
                if (result.recommendedSide === "NO_SIGNAL") {
                  perGameRejectSamples.push({ player: dbPlayer.name, stat: statType, reason: "no_signal" });
                  console.log(`[HT_NO_SIGNAL] Skipping ${dbPlayer.name} (${statType}) — engine returned NO_SIGNAL`);
                  continue;
                }

                // ENGINE-AS-TRUTH: derived-line + role-gate "double-degraded"
                // suppression removed. Derived-line provenance is still
                // surfaced via oddsSourceTag and the isDerivedLine response
                // field so the UI can render an unverified-line warning
                // without hiding the engine's true conviction.

                // Use displayConfidence (always direction-correct, >= 50 for any valid signal)
                // so filters, sorts, and client display all work symmetrically for OVER and UNDER.
                // Raw result.probability (<50 for UNDER plays) is NOT sent to client.
                // Engine-as-truth (halftime): no post-engine display cap. Degraded
                // line provenance is surfaced separately via oddsSourceTag and the
                // derived-line tag in the response so the UI can render the
                // unverified-line warning without rewriting the engine's number.
                const displayConfidence = (result as any).displayConfidence ?? result.probability;
                const betDirection = (result as any).recommendedSide?.toLowerCase() ?? (result.probability > 50 ? "over" : "under");

                // Per-source provenance — every surfaced halftime play must
                // be able to prove which API delivered each input. Pulled
                // from the engine diagnostics block (storage.ts) plus odds
                // metadata captured above. If any source is missing the
                // engine has already logged why; the tag here lets the
                // client surface "missing" cleanly without a second lookup.
                // Read provenance straight from engineDiagnostics (which is
                // returned unconditionally by calculateProbability — unlike
                // result.debug which is only emitted when req.isDebug=true).
                const eng: any = (result as any).engineDiagnostics ?? {};
                const rotationSource: string = eng.rotationSource ?? "season_avg";
                const playoffRotationDataSource: string | null =
                  eng.playoffRotationDataSource ?? null;
                const estimatedMinutesSource: string =
                  eng.projectionSource ?? "model_default";
                // Playoff history + coaching style live inside the playoff
                // rotation profile (closeGameTrustScore, coachShortBenchIndex,
                // coachStarRideIndex). When the profile dataSource is
                // "playoffs" both signals are real; when it falls back to
                // "regular_season_fallback"/"none" both are derived/missing.
                const playoffHistorySource: string = playoffRotationDataSource
                  ? (playoffRotationDataSource === "playoffs" ? "playoff_logs" : `fallback:${playoffRotationDataSource}`)
                  : "unavailable";
                const coachingStyleSource: string = playoffRotationDataSource
                  ? (playoffRotationDataSource === "playoffs" ? "coach_playoff_tendencies" : `fallback:${playoffRotationDataSource}`)
                  : "unavailable";
                const dvpSource: string =
                  eng.playoffDataResolved
                    ? "nba_defense_matchup_playoffs"
                    : (eng.playoffMode ? "nba_defense_matchup_rs_fallback" : "nba_defense_matchup_regular");
                const matchupSource: string = dvpSource; // share storage path
                const liveBoxScoreSource: string = "espn_summary_v2";
                const oddsFreshnessMs: number = htOddsAge;
                const sourceProvenance = {
                  rotationSource,
                  estimatedMinutesSource,
                  playoffHistorySource,
                  coachingStyleSource,
                  dvpSource,
                  matchupSource,
                  liveBoxScoreSource,
                  oddsSource: oddsSourceTag,
                  oddsFreshnessMs,
                };

                const playEntry = {
                  gameId: game.gameId,
                  homeTeamAbbr: game.homeTeamAbbr,
                  awayTeamAbbr: game.awayTeamAbbr,
                  homeFull: game.homeFull,
                  awayFull: game.awayFull,
                  homeScore: game.homeScore,
                  awayScore: game.awayScore,
                  playerId: dbPlayer.id,
                  playerName: dbPlayer.name,
                  team: teamAbbr,
                  opponent: opponentAbbr,
                  statType,
                  halftimeStat,
                  halftimeMinutes: Math.round(minutes * 10) / 10,
                  halftimeFouls: parseStat(statMap["pf"]),
                  line: liveLine,
                  // lineSource: "odds_api" preserved for legacy client checks
                  // (e.g. dashboard.tsx hasLiveLine flag) when the line is a real
                  // book line. Derived fallbacks are honestly tagged so the UI
                  // can show "no book line — model-derived" rather than implying
                  // a sportsbook posted this number.
                  lineSource: oddsSourceTag === "derived_2h_fallback"
                    ? "derived_2h_fallback"
                    : "odds_api",
                  bookKeys: effectiveEntry?.bookKeys ?? [],
                  probability: displayConfidence,
                  rawProbability: result.probability,
                  edge,
                  expectedTotal: result.expectedTotal,
                  impliedProbability: (result as any).impliedProbability ?? null,
                  betDirection,
                  isDegraded: lineIsDegraded,
                  // Surface a dedicated derived flag so the dashboard's existing
                  // "Derived" badge (keyed off play.isDerivedLine) lights up for
                  // 2H fallback cards. isDegraded stays true so the stale/cap
                  // policies still apply downstream.
                  isDerivedLine: oddsSourceTag === "derived_2h_fallback",
                  // Phase 2 — pass game-level halftime phase down so the client
                  // can surface "Early Q3 grace" badges without re-detecting.
                  halftimePhase: (game as any).halftimePhase ?? "halftime",
                  isEarly3QGrace: (game as any).isEarly3QGrace === true,
                  engineGeneratedAt: Date.now(),
                  timingContext: "halftime" as const,
                  engineDiagnostics: (result as any).engineDiagnostics ?? undefined,
                  sourceProvenance,
                };
                console.log(`[ENGINE_OUTPUT] sport=nba player=${dbPlayer.name} market=${statType} side=${betDirection.toUpperCase()} prob=${displayConfidence.toFixed(1)} edge=${edge.toFixed(1)} proj=${result.expectedTotal ?? "null"} line=${liveLine} timing=halftime`);
                if (OBSERVE_NBA_HT) {
                  console.log("[NBA_HT_FINAL_SURFACED]", JSON.stringify({
                    player: dbPlayer.name,
                    statType,
                    line: liveLine,
                    probability: Math.round(displayConfidence * 10) / 10,
                    edge: Math.round(edge * 10) / 10,
                    side: betDirection,
                    sourceProvenance,
                  }));
                }
                perGameSurfaced++;
                if (isVolatile) {
                  volatilePlays.push(playEntry);
                } else {
                  allPlays.push(playEntry);
                }
              } catch (calcErr2: any) {
                console.warn(`[NBA][halftime][engineError] player=${dbPlayer?.name ?? playerName} stat=${statType} error=${calcErr2?.message ?? String(calcErr2)}`);
              }
            }
          }
        }
        } catch (gameErr: any) {
          // Catch per-game so an exception in one game (boxscore fetch, ESPN
          // schema change, network blip) does not kill the whole halftime
          // cycle. The error is recorded in [NBA_HT_GAME_SUMMARY] below.
          gameError = `game_error:${gameErr?.message ?? String(gameErr)}`;
          console.warn(`[NBA_HT_GAME_ERROR] gameId=${game.gameId} ${gameError}`);
        } finally {
          // ── NBA_HT_GAME_SUMMARY: per-game aggregate emission ───────────
          // One line per halftime game showing exactly where the funnel
          // narrowed. Pair this with the always-on [SECOND_HALF_MARKET_AUDIT]
          // / [SECOND_HALF_MARKET_RESULT] lines from oddsService to
          // triangulate upstream availability vs downstream rejection.
          // Wrapped in finally so we get a summary even when the game body
          // hit an early `continue` (boxscore fetch failed, no players, etc.)
          // or threw an exception caught above.
          const _gameAttempts        = totalOddsAttempts       - _gameStartAttempts;
          const _gameMarketsFound    = secondHalfMarketsFound  - _gameStartMarketsFound;
          const _gameZeroBook        = zeroBookInPlayCount     - _gameStartZeroBook;
          const _gameSkippedNoLine   = skippedNoLine           - _gameStartSkippedNoLine;
          const _gameSkippedStale    = skippedStaleLine        - _gameStartSkippedStale;
          const _gameSkippedCleared  = skippedAlreadyCleared   - _gameStartSkippedCleared;
          console.log("[NBA_HT_GAME_SUMMARY]", JSON.stringify({
            gameId: game.gameId,
            matchup: `${game.awayTeamAbbr}@${game.homeTeamAbbr}`,
            phase: (game as any).halftimePhase ?? "halftime",
            oddsEventId,
            attempts: _gameAttempts,
            marketsFoundWithBooks: _gameMarketsFound,
            zeroBookResults: _gameZeroBook,
            skippedNoLine: _gameSkippedNoLine,
            skippedStaleLine: _gameSkippedStale,
            skippedAlreadyCleared: _gameSkippedCleared,
            surfacedToEngineOutput: perGameSurfaced,
            rejectSamples: perGameRejectSamples.slice(0, 10),
            gameError,
          }));
        }
      }

      console.log(`[QUICK VIEW DEBUG] total engine plays after validation: ${allPlays.length} (volatile pool: ${volatilePlays.length})`);

      const htPreSuppression = allPlays.length;
      const htSuppressed = applyBatchFamilySuppression(allPlays);
      allPlays.length = 0;
      allPlays.push(...htSuppressed);

      const volPreSuppression = volatilePlays.length;
      const volSuppressed = applyBatchFamilySuppression(volatilePlays);
      volatilePlays.length = 0;
      volatilePlays.push(...volSuppressed);

      console.log(`[FAMILY_SUPPRESS] halftime-plays: ${htPreSuppression} → ${allPlays.length}, volatile: ${volPreSuppression} → ${volatilePlays.length}`);

      // NBA Calibration v2 — conflicting OVER/UNDER suppression on both pools.
      const htConflictPre = allPlays.length;
      const htConflictResolved = applyNbaConflictSuppression(allPlays);
      allPlays.length = 0;
      allPlays.push(...htConflictResolved);
      const volConflictPre = volatilePlays.length;
      const volConflictResolved = applyNbaConflictSuppression(volatilePlays);
      volatilePlays.length = 0;
      volatilePlays.push(...volConflictResolved);
      if (htConflictPre !== allPlays.length || volConflictPre !== volatilePlays.length) {
        console.log(`[NBA_CONFLICT_SUPPRESS] halftime: ${htConflictPre}→${allPlays.length}, volatile: ${volConflictPre}→${volatilePlays.length}`);
      }

      const familyMap = new Map<string, { player: string; gameId: string; familyId: string; markets: string[]; flagship: string | null; derivatives: string[] }>();
      for (const p of allPlays) {
        const fid = `${p.playerName}|${p.gameId}|${p.betDirection}`;
        if (!familyMap.has(fid)) familyMap.set(fid, { player: p.playerName, gameId: p.gameId, familyId: fid, markets: [], flagship: null, derivatives: [] });
        const f = familyMap.get(fid)!;
        f.markets.push(p.statType);
        if (f.markets.length === 1) f.flagship = p.statType;
        else f.derivatives.push(p.statType);
      }
      for (const [, fam] of Array.from(familyMap.entries())) {
        if (fam.markets.length > 1) {
          console.log("[MARKET_FAMILY]", JSON.stringify({
            player: fam.player,
            gameId: fam.gameId,
            familyId: fam.familyId,
            surfacedMarkets: fam.markets,
            flagshipMarket: fam.flagship,
            derivativeMarkets: fam.derivatives,
          }));
        }
      }

      // Tiered selection: Tier A (edge >= 15), Tier B (edge >= 10), Tier C (edge >= 6)
      // Always include Tier A + B; include Tier C only if combined count < 8
      const tierA = allPlays.filter(p => p.edge >= 15);
      const tierB = allPlays.filter(p => p.edge >= 10 && p.edge < 15);
      const tierC = allPlays.filter(p => p.edge >= 6 && p.edge < 10);

      let selectedPlays = [...tierA, ...tierB];
      console.log(`[QUICK VIEW DEBUG] after tiering (A+B): ${selectedPlays.length} plays (A=${tierA.length}, B=${tierB.length}, C=${tierC.length})`);

      if (selectedPlays.length < 8) {
        selectedPlays = [...selectedPlays, ...tierC];
        console.log(`[QUICK VIEW DEBUG] after adding Tier C: ${selectedPlays.length} plays`);
      }

      // Low-supply mode: if still below 6, widen the probability band by including
      // volatile plays (degraded-line VALUE-tier plays previously suppressed) and
      // all edge >= 6 plays from allPlays. This relaxes quality constraints to
      // ensure the display is never empty when the engine has produced valid plays.
      if (selectedPlays.length < 6) {
        selectedPlays = [...allPlays, ...volatilePlays];
        console.log(`[QUICK VIEW DEBUG] low-supply mode activated — widened to include volatile plays, pool=${selectedPlays.length}`);
      }

      // Deduplicate by playerId+statType (keeps best edge for each unique combo)
      const dedupMap = new Map<string, typeof selectedPlays[0]>();
      for (const p of selectedPlays) {
        const key = `${p.playerId ?? p.playerName}|${p.statType}`;
        const existing = dedupMap.get(key);
        if (!existing || p.edge > existing.edge) dedupMap.set(key, p);
      }
      selectedPlays = Array.from(dedupMap.values());
      console.log(`[QUICK VIEW DEBUG] after dedup (player+market): ${selectedPlays.length} plays`);

      // Sort by edge DESC, then probability DESC
      // Both OVER and UNDER plays now have probability = displayConfidence (always >= 50)
      // so the secondary sort is direction-neutral — no OVER/UNDER bias.
      selectedPlays.sort((a, b) => {
        if (b.edge !== a.edge) return b.edge - a.edge;
        return b.probability - a.probability;
      });

      const topPlays = selectedPlays.slice(0, 20);
      console.log(`[QUICK VIEW DEBUG] final rendered: ${topPlays.length} plays`);

      // [HT_SORTED_TOP20] — confirms whether the edge sort is itself OVER/UNDER heavy
      const sortedTop20 = topPlays.map(p => ({
        player: p.playerName,
        stat: p.statType,
        dir: p.betDirection,
        prob: p.probability,
        edge: p.edge,
      }));
      const top20Over = topPlays.filter(p => p.betDirection === "over").length;
      const top20Under = topPlays.filter(p => p.betDirection === "under").length;
      console.log("[HT_SORTED_TOP20]", { total: topPlays.length, over: top20Over, under: top20Under, plays: sortedTop20 });

      const playsGenerated = topPlays.length;

      // Confirmed absence: ALL in-play lookups returned 0 books and !isDegraded — not just any single one.
      // This distinguishes true source absence from per-player key mismatches or partial quota failures.
      const secondHalfSourceAbsenceConfirmed =
        totalOddsAttempts > 0 && zeroBookInPlayCount === totalOddsAttempts;

      // Phase 7 — pipeline reason counters (truthful per-stage view, not derived from topPlays)
      const diagnostics = {
        halftimeGamesDetected: halftimeGames.length,
        eligibleGames: halftimeGames.length,
        playersParsed,
        oddsAttempts: totalOddsAttempts,
        true2hLinesFound,
        sgoLinesFound,
        derivedFallbackLines,
        skippedNoLine,
        skippedStaleLine,
        skippedAlreadyCleared,
        playsGenerated,
      };

      // [HT_RESPONSE_ASSERT] — uses actual parsed market counters (totalOddsAttempts, secondHalfMarketsFound)
      // not counts derived from topPlays, to give truthful pipeline checkpoint
      console.log("[HT_RESPONSE_ASSERT]", {
        totalGames: (gamesData.events ?? []).length,
        halftimeGames: halftimeGames.length,
        parsedMarkets: totalOddsAttempts,
        secondHalfMarkets: secondHalfMarketsFound,
        ...diagnostics,
      });

      // secondHalfValid: 2H lines present OR source confirmed absent (valid absence is not a code failure)
      const secondHalfValid =
        secondHalfMarketsFound > 0 || secondHalfSourceAbsenceConfirmed;

      // Read per-user verification state written by POST /api/halftime-plays/verify-client
      const userId = req.session?.userId ?? 0;
      const verification = halftimePipelineVerificationMap.get(userId) ?? {
        clientReceived: false,
        quickViewRendered: false,
        sourceCount: 0,
        renderedCount: 0,
        verifiedAt: 0,
      };

      const successGate = {
        endpointHitConfirmed: true,                                // [HT_ENDPOINT_HIT] fired above
        halftimeDetected: halftimeGames.length > 0,               // [HALFTIME_DETECTION_RESULT]
        secondHalfValid,                                           // [SECOND_HALF_MARKET_RESULT]
        responseHasPlays: playsGenerated > 0,                     // [HT_RESPONSE_ASSERT]
        clientReceived: verification.clientReceived === true,      // [HT_CLIENT_VERIFICATION]
        quickViewRendered: verification.quickViewRendered === true, // [HT_CLIENT_VERIFICATION]
      };

      const missing = Object.entries(successGate)
        .filter(([, value]) => value !== true)
        .map(([key]) => key);

      console.log("[PIPELINE_SERVER_GATE]", successGate);
      if (missing.length === 0) {
        console.log("STATUS: HALFTIME PIPELINE RESTORED — TASK #50 UNBLOCKED");
      } else {
        console.log("STATUS: HALFTIME PIPELINE STILL BLOCKED — REASON:", missing.join(", "));
      }

      // [HT_RESPONSE_FINAL] — final plays leaving server: counts + 10-play sample
      const finalOver = topPlays.filter(p => p.betDirection === "over").length;
      const finalUnder = topPlays.filter(p => p.betDirection === "under").length;
      console.log("[HT_RESPONSE_FINAL]", {
        total: topPlays.length,
        over: finalOver,
        under: finalUnder,
        sample: topPlays.slice(0, 10).map(p => ({
          player: p.playerName,
          stat: p.statType,
          dir: p.betDirection,
          prob: p.probability,
          edge: p.edge,
          proj: p.expectedTotal,
          line: p.line,
        })),
      });

      // Phase 8 — surface eligibility + diagnostics so the UI can show
      // "1 game eligible · waiting for 2H lines" even when topPlays is empty.
      const eligibleGameDetails = halftimeGames.map(g => ({
        gameId: g.gameId,
        homeTeamAbbr: g.homeTeamAbbr,
        awayTeamAbbr: g.awayTeamAbbr,
        homeFull: g.homeFull,
        awayFull: g.awayFull,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        halftimePhase: g.halftimePhase,
        isEarly3QGrace: g.isEarly3QGrace === true,
      }));
      const responsePayload: any = {
        plays: topPlays,
        eligibleGames: halftimeGames.length,
        eligibleGameDetails,
        diagnostics,
      };
      if (topPlays.length === 0 && halftimeGames.length > 0) {
        responsePayload.message =
          halftimeGames.length === 1
            ? "Game detected at halftime. Waiting for 2H lines / engine output."
            : `${halftimeGames.length} games detected at halftime. Waiting for 2H lines / engine output.`;
      }
      res.json(responsePayload);
      checkAndSendAlerts({ sport: "nba", plays: topPlays }, storage).catch(console.warn);
      // NBA halftime ledger persistence — record every surfaced play into
      // halftime_play_alerts so daily grading + history reflects what users
      // were actually shown. Fire-and-forget; never blocks the live response.
      if (topPlays.length > 0) {
        storage.savePlayAlerts(topPlays)
          .then(() => console.log(`[NBA_HT_PERSIST] persisted ${topPlays.length} halftime plays`))
          .catch(err => console.warn(`[NBA_HT_PERSIST] failed: ${err?.message ?? err}`));
      }
      for (const p of topPlays) {
        const pDir = (p.betDirection ?? "").toUpperCase();
        if (pDir === "OVER" || pDir === "UNDER") {
          recordSurfacedSignal(pDir, Number(p.probability ?? p.prob ?? 50) / 100, p.statType, p.edge, (p as any).timingContext ?? "halftime");
        }
      }
      for (const p of topPlays) {
        const sbSource: string = (p as any).bookKeys?.[0] ?? (p as any).lineSource ?? "odds_api";
        const diag = (p as any).engineDiagnostics;
        const htProjection = Number(p.expectedTotal ?? p.line);
        console.log(`[PERSIST_CHECK] sport=nba player=${p.playerName} market=${p.statType} proj=${htProjection} line=${p.line} timing=${(p as any).timingContext ?? "halftime"}`);
        trackPlay({
          gameId: p.gameId ?? "",
          playerId: p.playerId ? String(p.playerId) : null,
          playerName: p.playerName,
          team: p.team ?? null,
          sport: "nba",
          market: p.statType,
          direction: p.betDirection as "over" | "under",
          line: Number(p.line),
          projection: htProjection,
          probability: Number(p.probability ?? p.prob ?? 0),
          edge: p.edge != null ? Number(p.edge) : 0,
          sportsbook: sbSource,
          derivedLine: false,
          createdAt: (p as any).engineGeneratedAt ?? Date.now(),
          diagnostics: diag ? {
            archetype: diag.archetype,
            fragilityScore: diag.fragilityScore,
            fragilityPenalty: diag.fragilityPenalty,
            fragilityReasons: diag.fragilityReasons,
            familyId: diag.familyId,
            siblingCount: diag.siblingCount,
            siblingRank: diag.siblingRank,
            flagshipOrDerivative: diag.flagshipOrDerivative,
            familyPenaltyFactor: diag.familyPenaltyFactor,
            calibrationTrack: diag.calibrationTrack,
            confidenceCeilingApplied: diag.confidenceCeilingApplied,
            ceilingReason: diag.ceilingReason,
            rawProbOver: diag.rawProbOver,
            rawProbUnder: diag.rawProbUnder,
            finalProbOver: diag.finalProbOver,
            finalProbUnder: diag.finalProbUnder,
            displayConfidence: diag.displayConfidence,
            modelEdge: diag.modelEdge,
            minutesExpected: diag.minutesExpected,
            minutesVariance: diag.minutesVariance,
            marketType: diag.marketType,
            playerVolatilityScore: diag.playerVolatilityScore,
            comboCovarianceEstimate: diag.comboCovarianceEstimate,
            engineVersion: diag.engineVersion,
            // NBA Calibration v2 — forward finalizer telemetry (halftime path).
            calibrationVersion: diag.calibrationVersion,
            finalizerCapReason: diag.finalizerCapReason,
            finalizerMarketRiskTier: diag.finalizerMarketRiskTier,
            finalizerEliteGateApplied: diag.finalizerEliteGateApplied,
            finalizerHighBucketCapped: diag.finalizerHighBucketCapped,
            finalizerInitialPct: diag.finalizerInitialPct,
            finalizerFinalPct: diag.finalizerFinalPct,
            conflictingSideSuppressed: diag.conflictingSideSuppressed,
            conflictingSignalSuppressed: diag.conflictingSignalSuppressed ?? diag.conflictingSideSuppressed,
          } : undefined,
        }, storage).catch(console.warn);
      }
    } catch (e) {
      res.status(502).json({ message: "Halftime plays unavailable", details: (e as any).message });
    }
  });

  app.post("/api/parlay/calculate", async (req, res) => {
    try {
      const picks = req.body.picks as ParlayPickInput[];
      if (!picks || !Array.isArray(picks)) {
        return res.status(400).json({ message: "Invalid picks provided" });
      }
      const result = calculateParlay(picks);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: "Internal server error", details: (err as any).message });
    }
  });

  // ── Alert / notification routes ───────────────────────────────────────────

  app.get("/api/vapid-public-key", (_req, res) => {
    const key = getVapidPublicKey();
    if (!key) return res.status(503).json({ error: "Push notifications not configured" });
    res.json({ publicKey: key });
  });

  app.get("/api/user/alerts", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not found" });
      res.json({
        pushAlerts: user.pushAlerts,
        hasSubscription: !!user.pushSubscription,
        smsAlerts: user.smsAlerts,
        phoneNumber: user.phoneNumber ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch alert settings" });
    }
  });

  app.post("/api/user/alerts/push-subscription", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const { subscription } = req.body;
      if (!subscription || typeof subscription !== "object") {
        return res.status(400).json({ error: "Invalid subscription" });
      }
      await storage.updateUserAlerts(userId, {
        pushSubscription: JSON.stringify(subscription),
        pushAlerts: true,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save push subscription" });
    }
  });

  app.delete("/api/user/alerts/push-subscription", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      await storage.updateUserAlerts(userId, { pushSubscription: null, pushAlerts: false });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to remove push subscription" });
    }
  });

  app.post("/api/user/alerts/sms", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not found" });
      // Use canonical access resolution so legacy/alias tier labels (e.g. "all_sports")
      // are accepted, not just literal "all"/"elite". hasUnlimited covers both paid tiers.
      const smsAccess = resolveAccess(user.subscriptionTier, user.isAdmin ?? false);
      if (!smsAccess.hasUnlimited) {
        return res.status(403).json({ error: "SMS alerts require a Pro or All Sports subscription" });
      }
      const { phoneNumber, smsAlerts } = req.body;
      await storage.updateUserAlerts(userId, {
        phoneNumber: phoneNumber ?? null,
        smsAlerts: !!smsAlerts,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update SMS settings" });
    }
  });

  // ── Pass 7 — Future alerts abstraction (channel-agnostic) ─────────────────
  // Generic state machine over the `alertsChannelStatus` column added in Pass 2.
  // No Telegram backend, no bot tokens, no webhook logic — Pass 8 will wire a
  // real channel implementation behind these endpoints. The UI in Pass 5 can
  // already drive its alerts CTA against this surface today.
  //
  //   status values:
  //     - "unavailable"             → default; user has not opted in
  //     - "available_not_connected" → user opted in; awaiting channel connect
  //     - "connected"               → user has a live alerts channel
  app.get("/api/user/alerts/status", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not found" });
      const status = user.alertsChannelStatus ?? "unavailable";
      return res.json({
        status,
        telegramConnectionStatus: user.telegramConnectionStatus ?? null,
        telegramUsername: user.telegramUsername ?? null,
        telegramConnectedAt: user.telegramConnectedAt
          ? user.telegramConnectedAt.toISOString()
          : null,
      });
    } catch (err) {
      console.error("[alerts/status]", err);
      res.status(500).json({ error: "Failed to fetch alerts status" });
    }
  });

  app.post("/api/user/alerts/request-access", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not found" });
      const current = user.alertsChannelStatus ?? "unavailable";
      // Idempotent: never downgrade an already-connected channel.
      const next = current === "connected" ? "connected" : "available_not_connected";
      if (next !== current) {
        await storage.updateUserAlertsChannelState(userId, {
          alertsChannelStatus: next,
        });
      }
      return res.json({ status: next, changed: next !== current });
    } catch (err) {
      console.error("[alerts/request-access]", err);
      res.status(500).json({ error: "Failed to request alerts access" });
    }
  });

  app.post("/api/user/alerts/disconnect", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const user = await storage.getUserById(userId);
      if (!user) return res.status(401).json({ error: "Not found" });
      // Drop back to "available_not_connected" and wipe channel-specific fields.
      // Stays opt-in so re-connecting later does not require another request.
      await storage.updateUserAlertsChannelState(userId, {
        alertsChannelStatus: "available_not_connected",
        telegramChatId: null,
        telegramUsername: null,
        telegramConnectedAt: null,
        telegramConnectionStatus: null,
      });
      return res.json({ status: "available_not_connected" });
    } catch (err) {
      console.error("[alerts/disconnect]", err);
      res.status(500).json({ error: "Failed to disconnect alerts" });
    }
  });

  // ── Clear new-pro flag after welcome banner is shown ──────────────────────
  app.post("/api/user/clear-new-pro-flag", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      await storage.clearNewProFlag(userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to clear flag" });
    }
  });

  app.post("/api/user/complete-onboarding", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      await storage.updateUser(userId, { hasCompletedOnboarding: true } as any);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to update onboarding status" });
    }
  });

  app.post("/api/user/sport-focus", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).resolvedUserId!;
      const { sportFocus } = req.body;
      if (!sportFocus || !["nba", "mlb", "both"].includes(sportFocus)) {
        return res.status(400).json({ error: "Invalid sport focus. Must be 'nba', 'mlb', or 'both'." });
      }
      await storage.updateUser(userId, { sportFocus } as any);
      res.json({ success: true, sportFocus });
    } catch (err) {
      res.status(500).json({ error: "Failed to update sport preference" });
    }
  });

  // ── Twilio STOP webhook ────────────────────────────────────────────────────
  app.post("/api/webhooks/twilio", async (req, res) => {
    try {
      const from: string = req.body?.From ?? "";
      const body: string = (req.body?.Body ?? "").trim().toUpperCase();
      const stopWords = ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
      if (stopWords.includes(body) && from) {
        const user = await storage.getUserByPhoneNumber(from);
        if (user) {
          await storage.updateUserAlerts(user.id, { smsAlerts: false, smsConsent: false });
        }
      }
    } catch (err) {
      console.error("[twilio webhook]", err);
    }
    res.set("Content-Type", "text/xml").status(200).send("<Response></Response>");
  });

  // Roster sync from ESPN API — updates player team assignments from live rosters
  app.post("/api/sync-rosters", async (req, res) => {
    const normR = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['.'\-\s]+/g, "").replace(/jr$|sr$|ii$|iii$|iv$/, "");
    const ROSTER_ALIASES: Record<string, string> = {
      "alexsarr": "alexandresarr",
      "cameronthomas": "camthomas",
      "camthomas": "camthomas",
      "ojbamidele": "ojbamidele",
    };
    const normRA = (s: string) => { const n = normR(s); return ROSTER_ALIASES[n] ?? n; };

    // ── Helper: ESPN fallback roster sync ────────────────────────────────────
    async function espnFallback(dbPlayers: any[]) {
      const ESPN_TO_DB_R: Record<string, string> = {
        GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
        PHO: "PHX", UTH: "UTA", UTAH: "UTA", WSH: "WAS", CHO: "CHA",
      };
      const teamsRes = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32",
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) }
      );
      if (!teamsRes.ok) throw new Error("ESPN teams API also unavailable");
      const teamsData = await teamsRes.json() as any;
      const espnTeams: any[] = teamsData.sports?.[0]?.leagues?.[0]?.teams ?? [];
      let updated = 0, added = 0, skipped = 0;
      const seen = new Set<number>();
      for (const tw of espnTeams) {
        const espnTeam = tw.team;
        const dbTeam = ESPN_TO_DB_R[espnTeam.abbreviation ?? ""] ?? espnTeam.abbreviation;
        try {
          const rr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeam.id}/roster`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
          if (!rr.ok) continue;
          const rd = await rr.json() as any;
          const athletes: any[] = Array.isArray(rd.athletes) ? rd.athletes.flat() : [];
          const ESPN_POS: Record<string, string> = { PG:"PG",SG:"SG",SF:"SF",PF:"PF",C:"C",G:"SG",F:"SF",FC:"PF",GF:"SF" };
          for (const a of athletes) {
            const name: string = a.displayName ?? a.fullName ?? "";
            if (!name) continue;
            const pos = ESPN_POS[(a.position?.abbreviation ?? "").toUpperCase()] ?? "SF";
            const espnId = a.id ? parseInt(a.id, 10) : null;
            const match = dbPlayers.find(p => normRA(p.name) === normRA(name));
            if (match && !seen.has(match.id)) {
              seen.add(match.id);
              const updates: Record<string, any> = {};
              if (match.team !== dbTeam) { updates.team = dbTeam; match.team = dbTeam; }
              if (espnId && match.espnAthleteId !== espnId) { updates.espnAthleteId = espnId; match.espnAthleteId = espnId; }
              if (Object.keys(updates).length > 0) { await storage.updatePlayerStats(match.id, updates as any); updated++; }
              else skipped++;
            } else if (!match) {
              const created = await storage.createPlayer({ name, team: dbTeam, position: pos, avgMinutes: "20.0", avgFouls: "2.0", ...(espnId ? { espnAthleteId: espnId } : {}) } as any);
              dbPlayers.push({ ...created } as any);
              added++;
            }
          }
        } catch { /* skip team on error */ }
        await new Promise(r => setTimeout(r, 100));
      }
      return { updated, added, skipped, source: "espn" };
    }

    try {
      const dbPlayers = await storage.getPlayers();

      // ── Primary: NBA.com commonallplayers ───────────────────────────────────
      // This is the most authoritative source — reflects every trade, waiver, and signing.
      let result: { updated: number; added: number; skipped: number; notFound?: number; source: string };

      try {
        const nbaUrl = "https://stats.nba.com/stats/commonallplayers?IsOnlyCurrentSeason=1&LeagueID=00&Season=2025-26";
        const nbaRes = await fetch(nbaUrl, { headers: NBA_HEADERS, signal: AbortSignal.timeout(14000) });
        if (!nbaRes.ok) throw new Error(`NBA.com returned HTTP ${nbaRes.status}`);

        const nbaData = await nbaRes.json() as any;
        const rs = nbaData.resultSets?.[0];
        if (!rs) throw new Error("No resultSet in NBA.com response");

        const hdrs: string[] = rs.headers;
        const rows: any[][] = rs.rowSet;
        const iName = hdrs.indexOf("DISPLAY_FIRST_LAST");
        const iTeam = hdrs.indexOf("TEAM_ABBREVIATION");
        const iStatus = hdrs.indexOf("ROSTERSTATUS");
        const iPosIdx = hdrs.indexOf("POSITION");

        const ESPN_POS_NBA: Record<string, string> = {
          "Guard": "SG", "Forward": "SF", "Center": "C",
          "Guard-Forward": "SG", "Forward-Guard": "SF", "Forward-Center": "PF", "Center-Forward": "C",
          "G": "SG", "F": "SF", "C": "C", "G-F": "SF", "F-G": "SF", "F-C": "PF", "C-F": "C",
        };

        let updated = 0, added = 0, skipped = 0, notFound = 0;

        for (const row of rows) {
          const rosterStatus = iStatus >= 0 ? row[iStatus] : 1;
          if (!rosterStatus) continue;
          const name = row[iName] as string;
          const rawTeam = row[iTeam] as string;
          if (!name || !rawTeam) continue;
          const team = normTeam(rawTeam);

          const normName = normRA(name);
          const match = dbPlayers.find(p => normRA(p.name) === normName);
          if (match) {
            const updates: any = {};
            if (match.team !== team) updates.team = team;
            if (iPosIdx >= 0 && row[iPosIdx]) {
              const mappedPos = ESPN_POS_NBA[row[iPosIdx] as string];
              if (mappedPos && match.position !== mappedPos) updates.position = mappedPos;
            }
            if (Object.keys(updates).length > 0) {
              await storage.updatePlayerStats(match.id, updates);
              Object.assign(match, updates);
              updated++;
            } else {
              skipped++;
            }
          } else {
            notFound++;
          }
        }
        result = { updated, added, skipped, notFound, source: "nba.com" };
        console.log(`[sync-rosters] NBA.com: ${updated} updated, ${skipped} already correct, ${notFound} not in DB`);

      } catch (nbaErr) {
        console.warn("[sync-rosters] NBA.com failed, falling back to ESPN:", (nbaErr as any).message);
        const fb = await espnFallback(dbPlayers);
        result = fb;
      }

      res.json({ message: "Roster sync complete", ...result, totalDbPlayers: dbPlayers.length });
      runFullStatSync().catch(console.error);

    } catch (e) {
      console.error("[sync-rosters] Fatal:", (e as any).message);
      res.status(500).json({ message: "Roster sync failed", error: (e as any).message });
    }
  });

  app.post("/api/sync-stats", async (req, res) => {
    runFullStatSync().catch(console.error);
    res.json({ message: "Stats sync started (NBA.com + NBaStuffer + ESPN)", status: "background" });
  });

  app.post("/api/admin/sync-minutes-projections", requireAdmin, async (_req, res) => {
    try {
      const result = await syncMinutesProjections();
      res.json({ message: "Minutes projection sync complete", ...result });
    } catch (err: unknown) {
      console.error("[admin] sync-minutes-projections error:", err);
      res.status(500).json({ error: "Projection sync failed" });
    }
  });

  await seedDatabase();

  // ── Projected minutes: sync on startup + every 30 min ───────────────────
  syncMinutesProjections().catch((err: unknown) =>
    console.error("[startup] Minutes projection sync failed:", err)
  );
  setInterval(() => {
    syncMinutesProjections().catch((err: unknown) =>
      console.error("[interval] Minutes projection sync failed:", err)
    );
  }, 30 * 60 * 1000);

  return httpServer;
}

// ─── NBA.com required headers (verified working 2026-02-26) ──────────────────
const NBA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer": "https://www.nba.com/",
  "Origin": "https://www.nba.com",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "Connection": "keep-alive",
};

const NBA_PARAMS_BASE = "DateFrom=&DateTo=&LastNGames=0&LeagueID=00&Location=&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2025-26&SeasonSegment=&SeasonType=Regular+Season&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=";
const NBA_PARAMS = `GameSegment=&${NBA_PARAMS_BASE}`;
const NBA_PARAMS_H2 = `GameSegment=Second+Half&${NBA_PARAMS_BASE}`;

// Team abbreviation normalization for NBA.com abbreviations → our DB format
const NBA_TO_DB: Record<string, string> = {
  UTA: "UTA", SAS: "SAS", PHX: "PHX", NOP: "NOP", NYK: "NYK",
  GSW: "GSW", WAS: "WAS", CHA: "CHA", SA: "SAS", NO: "NOP",
  NY: "NYK", GS: "GSW", PHO: "PHX", UTH: "UTA", WSH: "WAS", CHO: "CHA",
};
const normTeam = (t: string) => NBA_TO_DB[t.toUpperCase()] ?? t.toUpperCase();

const normalizeName = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
   .toLowerCase().replace(/['.'\-\s]+/g, "").replace(/jr$|sr$|ii$|iii$|iv$/, "");

async function syncStatsFromNBA(): Promise<{ matched: number; unmatched: number }> {
  console.log("[nba-sync] Starting NBA.com stats sync…");
  try {
    const baseUrl = "https://stats.nba.com/stats/leaguedashplayerstats";
    const [baseRes, advRes, h2Res] = await Promise.all([
      fetch(`${baseUrl}?MeasureType=Base&PerMode=PerGame&${NBA_PARAMS}`, { headers: NBA_HEADERS, signal: AbortSignal.timeout(20000) }),
      fetch(`${baseUrl}?MeasureType=Advanced&PerMode=PerGame&${NBA_PARAMS}`, { headers: NBA_HEADERS, signal: AbortSignal.timeout(20000) }),
      fetch(`${baseUrl}?MeasureType=Base&PerMode=PerGame&${NBA_PARAMS_H2}`, { headers: NBA_HEADERS, signal: AbortSignal.timeout(20000) }),
    ]);

    if (!baseRes.ok || !advRes.ok || !h2Res.ok) {
      console.error("[nba-sync] NBA.com API request failed:", baseRes.status, advRes.status, h2Res.status);
      return { matched: 0, unmatched: 0 };
    }

    const [baseData, advData, h2Data] = await Promise.all([baseRes.json(), advRes.json(), h2Res.json()]) as [any, any, any];

    // Build per-player merged maps keyed by PLAYER_ID
    const playerMap = new Map<number, Record<string, any>>();

    const baseHeaders: string[] = baseData.resultSets?.[0]?.headers ?? [];
    for (const row of (baseData.resultSets?.[0]?.rowSet ?? [])) {
      const o: Record<string, any> = {};
      baseHeaders.forEach((h: string, i: number) => o[h] = row[i]);
      playerMap.set(o.PLAYER_ID, {
        name: o.PLAYER_NAME,
        team: normTeam(o.TEAM_ABBREVIATION),
        ppg: o.PTS?.toString(),
        rpg: o.REB?.toString(),
        apg: o.AST?.toString(),
        spg: o.STL?.toString(),
        bpg: o.BLK?.toString(),
        tpg: o.FG3M?.toString(),
        avgMinutes: o.MIN?.toString(),
        avgFouls: o.PF?.toString(),
      });
    }

    const advHeaders: string[] = advData.resultSets?.[0]?.headers ?? [];
    for (const row of (advData.resultSets?.[0]?.rowSet ?? [])) {
      const o: Record<string, any> = {};
      advHeaders.forEach((h: string, i: number) => o[h] = row[i]);
      const existing = playerMap.get(o.PLAYER_ID) ?? {};
      playerMap.set(o.PLAYER_ID, {
        ...existing,
        // NBA.com Advanced endpoint returns USG_PCT as a decimal (e.g. 0.289 = 28.9%).
        // Do NOT divide by 100 — NBaStuffer gets a percentage string and divides, ESPN
        // computes from raw box score. Only this source needs the value used directly.
        usageRate: o.USG_PCT != null ? o.USG_PCT.toString() : existing.usageRate,
        tsPct: o.TS_PCT?.toString(),
        offRating: o.OFF_RATING?.toString(),
      });
    }

    const h2Headers: string[] = h2Data.resultSets?.[0]?.headers ?? [];
    for (const row of (h2Data.resultSets?.[0]?.rowSet ?? [])) {
      const o: Record<string, any> = {};
      h2Headers.forEach((h: string, i: number) => o[h] = row[i]);
      const existing = playerMap.get(o.PLAYER_ID) ?? {};
      playerMap.set(o.PLAYER_ID, {
        ...existing,
        h2ppg: o.PTS?.toString(),
        h2rpg: o.REB?.toString(),
        h2apg: o.AST?.toString(),
        h2spg: o.STL?.toString(),
        h2bpg: o.BLK?.toString(),
        h2tpg: o.FG3M?.toString(),
        h2avgMinutes: o.MIN?.toString(),
      });
    }

    // Match NBA.com players to DB players
    const dbPlayers = await storage.getPlayers();
    let matched = 0, unmatched = 0;

    const fields = ["ppg","rpg","apg","spg","bpg","tpg","avgMinutes","avgFouls","usageRate","tsPct","offRating","h2ppg","h2rpg","h2apg","h2spg","h2bpg","h2tpg","h2avgMinutes"];
    for (const nbaPlayer of Array.from(playerMap.values())) {
      const normNba = normalizeName(nbaPlayer.name ?? "");
      const dbMatch = dbPlayers.find(p => normalizeName(p.name) === normNba);
      if (dbMatch) {
        const update: Record<string, any> = { statsUpdatedAt: new Date() };
        for (const f of fields) {
          if (nbaPlayer[f] != null && nbaPlayer[f] !== "null") update[f] = nbaPlayer[f];
        }
        await storage.updatePlayerStats(dbMatch.id, update as any);
        matched++;
      } else {
        unmatched++;
      }
    }

    console.log(`[nba-sync] Complete: ${matched} matched, ${unmatched} unmatched`);
    return { matched, unmatched };
  } catch (e) {
    console.error("[nba-sync] Error:", (e as any).message);
    return { matched: 0, unmatched: 0 };
  }
}

async function syncStatsFromNBAStuffer(): Promise<{ matched: number; unmatched: number }> {
  console.log("[nbastuffer-sync] Starting NBaStuffer scrape…");
  try {
    const res = await fetch("https://www.nbastuffer.com/2025-2026-nba-player-stats/", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept": "text/html" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error("[nbastuffer-sync] HTTP", res.status); return { matched: 0, unmatched: 0 }; }
    const html = await res.text();

    // Extract headers from <th> elements
    const tableMatch = html.match(/<table[^>]*>([\s\S]*?)<\/table>/);
    if (!tableMatch) { console.error("[nbastuffer-sync] No table found"); return { matched: 0, unmatched: 0 }; }
    const tableHtml = tableMatch[0];
    // Use exec-loop instead of matchAll to avoid es2018 regex flag requirement
    const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    const headers: string[] = [];
    let thM: RegExpExecArray | null;
    while ((thM = thRegex.exec(tableHtml)) !== null) {
      headers.push(thM[1].replace(/<[^>]*>/g, "").trim());
    }

    // Extract player rows
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rowMatches: string[] = [];
    let trM: RegExpExecArray | null;
    while ((trM = trRegex.exec(tableHtml)) !== null) {
      if (trM[1].includes("<td")) rowMatches.push(trM[1]);
    }

    const nameIdx = headers.indexOf("NAME");
    const curIdx = headers.indexOf("CUR");
    const gpIdx = headers.indexOf("GP");

    // Group by name, pick current team row
    const byName = new Map<string, any[]>();
    for (const rowHtml of rowMatches) {
      const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const cells: string[] = [];
      let tdM: RegExpExecArray | null;
      while ((tdM = tdRegex.exec(rowHtml)) !== null) {
        cells.push(tdM[1].replace(/<[^>]*>/g, "").trim());
      }
      const name = cells[nameIdx];
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(cells);
    }

    const dbPlayers = await storage.getPlayers();
    let matched = 0, unmatched = 0;

    for (const [name, rows] of Array.from(byName.entries())) {
      // Pick current team row: prefer CUR="*", else highest GP
      let row = rows[0];
      const curRow = rows.find((r: any[]) => r[curIdx] === "*");
      if (curRow) {
        row = curRow;
      } else if (rows.length > 1) {
        row = rows.reduce((best: any[], r: any[]) => parseInt(r[gpIdx]) > parseInt(best[gpIdx]) ? r : best, rows[0]);
      }

      const get = (col: string) => parseFloat(row[headers.indexOf(col)] ?? "0") || 0;
      const gp = get("GP") || 1;
      const threePA = get("3PA");
      const threePPct = get("3P%");

      const update: Record<string, any> = {
        ppg: get("PpG").toString(),
        rpg: get("RpG").toString(),
        apg: get("ApG").toString(),
        spg: get("SpG").toString(),
        bpg: get("BpG").toString(),
        tpg: ((threePA * threePPct) / gp).toFixed(2),
        avgMinutes: get("MpG").toString(),
        usageRate: (get("USG%") / 100).toFixed(4),
        statsUpdatedAt: new Date(),
      };

      const normNbs = normalizeName(name);
      // Phase 9.3 — nbastuffer acts as enrichment overlay (rebound %, usage,
      // efg %, etc.). Previously gated on `!p.ppg` which always failed because
      // syncStatsFromNBA runs first and populates ppg → 0/229 match rate.
      const dbMatch = dbPlayers.find(p => normalizeName(p.name) === normNbs);
      if (dbMatch) {
        await storage.updatePlayerStats(dbMatch.id, update as any);
        matched++;
      } else {
        unmatched++;
      }
    }

    console.log(`[nbastuffer-sync] Complete: ${matched} matched, ${unmatched} skipped/unmatched`);
    return { matched, unmatched };
  } catch (e) {
    console.error("[nbastuffer-sync] Error:", (e as any).message);
    return { matched: 0, unmatched: 0 };
  }
}

async function syncStatsFromESPN(): Promise<{ matched: number }> {
  console.log("[espn-sync] Starting ESPN gap-fill sync…");
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const ESPN_TO_DB_MAP: Record<string, string> = {
    GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
    PHO: "PHX", UTH: "UTA", WSH: "WAS", CHO: "CHA",
  };
  const normE = (a: string) => ESPN_TO_DB_MAP[a.toUpperCase()] ?? a.toUpperCase();

  try {
    const teamsRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
    if (!teamsRes.ok) { console.error("[espn-sync] Teams fetch failed"); return { matched: 0 }; }
    const teamsData = await teamsRes.json() as any;
    const espnTeams: any[] = teamsData.sports?.[0]?.leagues?.[0]?.teams ?? [];

    const dbPlayers = await storage.getPlayers();
    // Only sync players missing ppg
    const needsSync = dbPlayers.filter(p => !p.ppg);
    if (needsSync.length === 0) { console.log("[espn-sync] All players already have stats — skipping"); return { matched: 0 }; }

    let matched = 0;

    for (const teamWrapper of espnTeams) {
      const espnTeam = teamWrapper.team;
      try {
        const rosterRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeam.id}/roster`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
        if (!rosterRes.ok) continue;
        const rosterData = await rosterRes.json() as any;
        let athletes: any[] = Array.isArray(rosterData.athletes) ? rosterData.athletes.flat() : [];

        for (const athlete of athletes) {
          const name: string = athlete.displayName ?? athlete.fullName ?? "";
          if (!name) continue;
          const normEspn = normalizeName(name);
          const dbMatch = needsSync.find(p => normalizeName(p.name) === normEspn);
          if (!dbMatch) continue;

          try {
            const statRes = await fetch(
              `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/${athlete.id}/statistics?lang=en&region=us`,
              { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
            );
            if (!statRes.ok) { await sleep(80); continue; }
            const statData = await statRes.json() as any;
            const stats: Record<string, number> = {};
            for (const cat of (statData.splits?.categories ?? [])) {
              for (const s of (cat.stats ?? [])) stats[s.name] = s.value;
            }

            const avgMin = stats.avgMinutes ?? 20;
            const avgFGA = stats.avgFieldGoalAttempts ?? 0;
            const avgFTA = stats.avgFreeThrowAttempts ?? 0;
            const avgTOV = stats.avgTurnovers ?? 0;
            const usageRate = avgMin > 0 ? (avgFGA + 0.44 * avgFTA + avgTOV) / ((avgMin / 48) * 110) : 0.22;

            const espnAthleteId = athlete.id ? parseInt(athlete.id, 10) : null;
            await storage.updatePlayerStats(dbMatch.id, {
              ppg: (stats.avgPoints ?? 0).toFixed(1),
              rpg: (stats.avgRebounds ?? 0).toFixed(1),
              apg: (stats.avgAssists ?? 0).toFixed(1),
              spg: (stats.avgSteals ?? 0).toFixed(1),
              bpg: (stats.avgBlocks ?? 0).toFixed(1),
              tpg: (stats.avgThreePointFieldGoalsMade ?? 0).toFixed(1),
              avgMinutes: avgMin.toFixed(1),
              avgFouls: (stats.avgFouls ?? 2.0).toFixed(1),
              usageRate: usageRate.toFixed(4),
              statsUpdatedAt: new Date(),
              ...(espnAthleteId ? { espnAthleteId } : {}),
            } as any);
            matched++;
          } catch { /* skip athlete on error */ }
          await sleep(80);
        }
      } catch (teamErr) {
        console.error("[espn-sync] Team error:", (teamErr as any).message);
      }
    }

    console.log(`[espn-sync] Complete: ${matched} gap-filled from ESPN`);
    return { matched };
  } catch (e) {
    console.error("[espn-sync] Error:", (e as any).message);
    return { matched: 0 };
  }
}

// ── Live DvP sync from NBA.com opponent stats ──────────────────────────────
// Replaces static editorial seed values with real current-season data.
// Source: leaguedashteamstats?MeasureType=Opponent — OPP_PTS per team.
// NBA.com returns TEAM_NAME (full name) not TEAM_ABBREVIATION for this endpoint.
// Multiplier: team's OPP_PTS relative to league average → defRating.
// Lower OPP_PTS = better defense = defRating < 1.0. Cap: 0.86 – 1.14.
async function syncDvP(): Promise<void> {
  console.log("[dvp-sync] Starting DvP sync from NBA.com opponent stats…");

  // Map NBA.com full team names → our DB abbreviations
  const NBA_NAME_TO_ABBR: Record<string, string> = {
    "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN",
    "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE",
    "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET",
    "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
    "LA Clippers": "LAC", "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL",
    "Memphis Grizzlies": "MEM", "Miami Heat": "MIA", "Milwaukee Bucks": "MIL",
    "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP", "New York Knicks": "NYK",
    "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI",
    "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC",
    "San Antonio Spurs": "SAS", "Toronto Raptors": "TOR", "Utah Jazz": "UTA",
    "Washington Wizards": "WAS",
  };

  try {
    const url = `https://stats.nba.com/stats/leaguedashteamstats?MeasureType=Opponent&PerMode=PerGame&${NBA_PARAMS_BASE}`;
    const res = await fetch(url, { headers: NBA_HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`NBA.com opponent stats returned ${res.status}`);
    const data = await res.json() as any;

    const headers: string[] = data.resultSets?.[0]?.headers ?? [];
    const rows: any[][] = data.resultSets?.[0]?.rowSet ?? [];
    if (rows.length === 0) throw new Error("Empty result set from NBA.com opponent stats");

    // NBA.com uses TEAM_NAME (full name) for this endpoint, not TEAM_ABBREVIATION
    const iTeam = headers.indexOf("TEAM_NAME");
    const iPts  = headers.indexOf("OPP_PTS");
    if (iTeam < 0) throw new Error(`TEAM_NAME column not found. Available: ${headers.slice(0,5).join(',')}`);
    if (iPts < 0)  throw new Error(`OPP_PTS column not found. Available: ${headers.slice(0,10).join(',')}`);

    // Compute league average OPP_PTS across all teams
    const allPts = rows.map(r => Number(r[iPts])).filter(n => n > 0);
    const leagueAvg = allPts.reduce((a, b) => a + b, 0) / allPts.length;
    console.log(`[dvp-sync] League avg OPP_PTS/g: ${leagueAvg.toFixed(1)} across ${allPts.length} teams`);

    const positions = ["PG", "SG", "SF", "PF", "C"];
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const teamFullName = String(row[iTeam] ?? "");
      const teamAbbr = NBA_NAME_TO_ABBR[teamFullName];
      if (!teamAbbr) { skipped++; continue; }

      const oppPts = Number(row[iPts]);
      if (oppPts <= 0) continue;

      // Base multiplier: how much does this team allow vs league avg
      // Teams allowing more points → defRating > 1.0 (opponents score more)
      // Teams allowing fewer points → defRating < 1.0 (opponents score less)
      const rawRatio = oppPts / leagueAvg;
      // Soft damp to prevent single extreme outliers from dominating
      const baseDefRating = Math.max(0.86, Math.min(1.14, rawRatio));

      for (const pos of positions) {
        await storage.upsertTeamDefense(teamAbbr, pos, baseDefRating.toFixed(3));
        updated++;
      }
    }

    const teamsUpdated = updated / positions.length;
    console.log(`[dvp-sync] Updated ${teamsUpdated} teams × ${positions.length} positions from live NBA.com data (${skipped} unmatched)`);
    if (teamsUpdated < 25) {
      console.warn(`[dvp-sync] Warning: only ${teamsUpdated} teams updated — expected 30`);
    }
  } catch (e) {
    console.warn(`[dvp-sync] NBA.com sync failed — keeping existing DvP ratings: ${(e as any).message}`);
  }
}

async function runFullStatSync(): Promise<void> {
  console.log("[stat-sync] Starting full stat sync chain…");
  await syncStatsFromNBA();
  await syncStatsFromNBAStuffer();
  await syncStatsFromESPN();
  await syncDvP();
  console.log("[stat-sync] Full sync chain complete.");
}

async function syncEspnAthleteIds(): Promise<void> {
  console.log("[espn-id-sync] Seeding ESPN athlete IDs for existing players…");
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const normalizeName = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['.'\-\s]+/g, "").replace(/jr$|sr$|ii$|iii$|iv$/, "");
  try {
    const teamsRes = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) });
    if (!teamsRes.ok) { console.error("[espn-id-sync] Teams fetch failed"); return; }
    const teamsData = await teamsRes.json() as any;
    const espnTeams: any[] = teamsData.sports?.[0]?.leagues?.[0]?.teams ?? [];
    const dbPlayers = await storage.getPlayers();
    const needsId = dbPlayers.filter(p => !p.espnAthleteId);
    if (needsId.length === 0) { console.log("[espn-id-sync] All players already have ESPN IDs — skipping"); return; }
    let seeded = 0;
    for (const teamWrapper of espnTeams) {
      const espnTeam = teamWrapper.team;
      try {
        const rosterRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeam.id}/roster`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
        if (!rosterRes.ok) continue;
        const rosterData = await rosterRes.json() as any;
        const athletes: any[] = Array.isArray(rosterData.athletes) ? rosterData.athletes.flat() : [];
        for (const a of athletes) {
          const name: string = a.displayName ?? a.fullName ?? "";
          if (!name || !a.id) continue;
          const espnId = parseInt(a.id, 10);
          const dbMatch = needsId.find(p => normalizeName(p.name) === normalizeName(name));
          if (dbMatch) {
            await storage.updatePlayerStats(dbMatch.id, { espnAthleteId: espnId });
            dbMatch.espnAthleteId = espnId;
            seeded++;
          }
        }
      } catch { /* skip team on error */ }
      await sleep(80);
    }
    console.log(`[espn-id-sync] Seeded ESPN IDs for ${seeded} players`);
  } catch (e) {
    console.error("[espn-id-sync] Error:", (e as any).message);
  }
}

async function seedDatabase() {
  const existingPlayers = await storage.getPlayers();

  // Auto-trigger stats sync on startup if any player lacks stats
  if (existingPlayers.length > 0 && existingPlayers.some(p => !p.ppg)) {
    console.log("[startup] Detected players with null stats — triggering full stat sync in background…");
    runFullStatSync().catch(console.error);
  }

  // Seed ESPN athlete IDs for players that lack them (runs in background)
  if (existingPlayers.length > 0 && existingPlayers.some(p => !p.espnAthleteId)) {
    syncEspnAthleteIds().catch(console.error);
  }

  {
    // ── 2025-26 NBA ROSTERS (accurate as of Mar 3, 2026) ─────────────────────
    // All Feb 5, 2026 trade deadline moves reflected (28 trades, 73 players moved).
    // Key offseason moves (summer 2025):
    //  • Luka Doncic → LAL; Anthony Davis → DAL (then →WAS at deadline)
    //  • De'Aaron Fox → SAS; Jimmy Butler → GSW (ACL, out for season – omitted)
    //  • Jayson Tatum – Achilles rupture May 2025, out for season – omitted
    //  • Domantas Sabonis → MIL; Cooper Flagg #1 pick → NOP
    //  • Al Horford signed with GSW (FA); Jrue Holiday → POR (Simons deal)
    //  • Anfernee Simons: POR → BOS → CHI; Kristaps Porzingis: BOS → ATL → GSW
    // Key Feb 5 deadline moves:
    //  • Anthony Davis → WAS (from DAL); Trae Young → WAS (from ATL, Jan 9)
    //  • James Harden → CLE; Darius Garland → LAC
    //  • Jaren Jackson Jr. → UTA; Lonzo Ball → UTA
    //  • Kristaps Porzingis → GSW (from ATL); Jonathan Kuminga, Buddy Hield → ATL
    //  • Ivica Zubac → IND; Bennedict Mathurin → LAC
    //  • Nikola Vucevic → BOS; Anfernee Simons → CHI
    //  • Jaden Ivey → CHI (from DET); Rob Dillingham, Leonard Miller → CHI (from MIN)
    //  • Coby White → CHA; Collin Sexton → CHI (from UTA via CHA)
    //  • Ayo Dosunmu, Julian Phillips → MIN; Guerschon Yabusele → CHI (from NYK)
    //  • Jose Alvarado → NYK (from NOP); Dalen Terry → NOP (from CHI via NYK)
    //  • Luke Kennard → LAL; Gabe Vincent → ATL (from LAL)
    //  • Jared McCain → OKC (from PHI)
    //  • De'Andre Hunter → SAC (from CLE, via ATL)
    //  • Dennis Schroder, Keon Ellis → CLE (from SAC)
    //  • Eric Gordon → MEM (from PHI); Taylor Hendricks, Kyle Anderson, etc. → MEM
    //  • Ty Jerome → MEM (confirmed via live odds data)
    //  • Chris Paul → TOR (from LAC, buyout expected); Trayce Jackson-Davis → TOR
    //  • Ochai Agbaji → BKN (from TOR); Josh Minott → BKN (from BOS)
    //  • Ousmane Dieng → MIL (from CHI, via OKC → CHA → CHI)
    //  • Cole Anthony → PHX (from ORL via MIL); Amir Coffey → PHX
    //  • Khris Middleton → DAL; Tyus Jones → DAL (from ORL via CHA)
    const playersToSeed = [
      // ATL Hawks — rebuilt at deadline; Kuminga/Hield/CJ McCollum added
      { name: "Jalen Johnson", team: "ATL", position: "PF", avgMinutes: "34.5", avgFouls: "2.1" },
      { name: "Dyson Daniels", team: "ATL", position: "SG", avgMinutes: "33.5", avgFouls: "2.0" },
      { name: "AJ Griffin", team: "ATL", position: "SF", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Garrison Mathews", team: "ATL", position: "SG", avgMinutes: "17.0", avgFouls: "1.1" },
      { name: "Larry Nance Jr.", team: "ATL", position: "PF", avgMinutes: "20.0", avgFouls: "2.1" },
      { name: "CJ McCollum", team: "ATL", position: "SG", avgMinutes: "29.0", avgFouls: "1.5" },
      { name: "Corey Kispert", team: "ATL", position: "SF", avgMinutes: "27.0", avgFouls: "1.6" },
      { name: "Jonathan Kuminga", team: "ATL", position: "SF", avgMinutes: "27.0", avgFouls: "2.4" },
      { name: "Buddy Hield", team: "ATL", position: "SG", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Gabe Vincent", team: "ATL", position: "SG", avgMinutes: "20.0", avgFouls: "1.5" },
      { name: "Jock Landale", team: "ATL", position: "C", avgMinutes: "16.0", avgFouls: "2.0" },
      { name: "Duop Reath", team: "ATL", position: "C", avgMinutes: "18.0", avgFouls: "2.1" },
      // BKN Nets — added Agbaji, Minott, Hunter Tyson at deadline
      { name: "Cameron Johnson", team: "BKN", position: "SF", avgMinutes: "31.0", avgFouls: "1.6" },
      { name: "Nic Claxton", team: "BKN", position: "C", avgMinutes: "27.0", avgFouls: "3.0" },
      { name: "Ben Simmons", team: "BKN", position: "PG", avgMinutes: "22.0", avgFouls: "1.9" },
      { name: "Ziaire Williams", team: "BKN", position: "SF", avgMinutes: "24.0", avgFouls: "1.7" },
      { name: "Ochai Agbaji", team: "BKN", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Josh Minott", team: "BKN", position: "SF", avgMinutes: "18.0", avgFouls: "1.6" },
      { name: "Hunter Tyson", team: "BKN", position: "SF", avgMinutes: "20.0", avgFouls: "1.5" },
      // BOS Celtics — Tatum (Achilles, out) not listed; Vucevic added; Horford/Porzingis/Holiday gone
      { name: "Jaylen Brown", team: "BOS", position: "SG", avgMinutes: "35.5", avgFouls: "2.4" },
      { name: "Derrick White", team: "BOS", position: "SG", avgMinutes: "33.0", avgFouls: "2.2" },
      { name: "Payton Pritchard", team: "BOS", position: "PG", avgMinutes: "27.0", avgFouls: "1.3" },
      { name: "Sam Hauser", team: "BOS", position: "SF", avgMinutes: "25.5", avgFouls: "1.1" },
      { name: "Nikola Vucevic", team: "BOS", position: "C", avgMinutes: "31.5", avgFouls: "2.5" },
      // CHA Hornets — major pickup of Coby White, Malaki Branham, Dieng, Tillman, Conley
      { name: "LaMelo Ball", team: "CHA", position: "PG", avgMinutes: "33.5", avgFouls: "2.0" },
      { name: "Miles Bridges", team: "CHA", position: "SF", avgMinutes: "34.5", avgFouls: "2.2" },
      { name: "Brandon Miller", team: "CHA", position: "SF", avgMinutes: "33.0", avgFouls: "2.1" },
      { name: "Mark Williams", team: "CHA", position: "C", avgMinutes: "27.5", avgFouls: "2.7" },
      { name: "Tre Mann", team: "CHA", position: "SG", avgMinutes: "27.0", avgFouls: "1.6" },
      { name: "Coby White", team: "CHA", position: "PG", avgMinutes: "36.0", avgFouls: "2.2" },
      { name: "Malaki Branham", team: "CHA", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Xavier Tillman Sr.", team: "CHA", position: "C", avgMinutes: "18.0", avgFouls: "2.1" },
      // CHI Bulls — massive rebuild; Simons, Ivey, Dillingham, Miller, Sexton, Richards, Yabusele added
      { name: "Josh Giddey", team: "CHI", position: "PG", avgMinutes: "35.0", avgFouls: "1.8" },
      { name: "Zach LaVine", team: "CHI", position: "SG", avgMinutes: "33.5", avgFouls: "1.8" },
      { name: "Patrick Williams", team: "CHI", position: "PF", avgMinutes: "29.5", avgFouls: "2.0" },
      { name: "Anfernee Simons", team: "CHI", position: "SG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Jaden Ivey", team: "CHI", position: "SG", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Rob Dillingham", team: "CHI", position: "PG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Leonard Miller", team: "CHI", position: "SF", avgMinutes: "20.0", avgFouls: "1.8" },
      { name: "Collin Sexton", team: "CHI", position: "PG", avgMinutes: "29.0", avgFouls: "2.0" },
      { name: "Nick Richards", team: "CHI", position: "C", avgMinutes: "21.0", avgFouls: "2.3" },
      { name: "Guerschon Yabusele", team: "CHI", position: "PF", avgMinutes: "22.0", avgFouls: "2.0" },
      // CLE Cavaliers — Harden in, Garland out; Ellis/Schroder/E.Miller added
      { name: "Donovan Mitchell", team: "CLE", position: "SG", avgMinutes: "35.5", avgFouls: "2.1" },
      { name: "Evan Mobley", team: "CLE", position: "PF", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Jarrett Allen", team: "CLE", position: "C", avgMinutes: "29.0", avgFouls: "2.2" },
      { name: "Sam Merrill", team: "CLE", position: "SG", avgMinutes: "17.0", avgFouls: "1.0" },
      { name: "James Harden", team: "CLE", position: "PG", avgMinutes: "33.0", avgFouls: "2.1" },
      { name: "Keon Ellis", team: "CLE", position: "SG", avgMinutes: "25.0", avgFouls: "1.6" },
      { name: "Dennis Schroder", team: "CLE", position: "PG", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Emanuel Miller", team: "CLE", position: "SF", avgMinutes: "20.0", avgFouls: "1.8" },
      // DAL Mavericks — Davis/Russell out; Middleton/Jones/Bagley/AJ Johnson added
      { name: "Kyrie Irving", team: "DAL", position: "SG", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Klay Thompson", team: "DAL", position: "SG", avgMinutes: "30.0", avgFouls: "1.7" },
      { name: "PJ Washington", team: "DAL", position: "PF", avgMinutes: "29.0", avgFouls: "2.1" },
      { name: "Daniel Gafford", team: "DAL", position: "C", avgMinutes: "22.0", avgFouls: "2.6" },
      { name: "Dereck Lively II", team: "DAL", position: "C", avgMinutes: "24.0", avgFouls: "2.4" },
      { name: "Spencer Dinwiddie", team: "DAL", position: "PG", avgMinutes: "20.0", avgFouls: "1.8" },
      { name: "Khris Middleton", team: "DAL", position: "SF", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Tyus Jones", team: "DAL", position: "PG", avgMinutes: "22.0", avgFouls: "1.4" },
      { name: "Marvin Bagley III", team: "DAL", position: "C", avgMinutes: "18.0", avgFouls: "2.3" },
      { name: "AJ Johnson", team: "DAL", position: "SF", avgMinutes: "20.0", avgFouls: "1.7" },
      // DEN Nuggets — Jokic-centric; Hunter Tyson traded
      { name: "Nikola Jokic", team: "DEN", position: "C", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Jamal Murray", team: "DEN", position: "PG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Michael Porter Jr.", team: "DEN", position: "SF", avgMinutes: "32.5", avgFouls: "1.5" },
      { name: "Aaron Gordon", team: "DEN", position: "PF", avgMinutes: "32.5", avgFouls: "2.3" },
      { name: "Christian Braun", team: "DEN", position: "SG", avgMinutes: "29.0", avgFouls: "1.8" },
      { name: "Julian Strawther", team: "DEN", position: "SG", avgMinutes: "21.0", avgFouls: "1.5" },
      { name: "Reggie Jackson", team: "DEN", position: "PG", avgMinutes: "18.0", avgFouls: "1.6" },
      // DET Pistons — Ivey gone to CHI; Huerter and Saric added
      { name: "Cade Cunningham", team: "DET", position: "PG", avgMinutes: "35.0", avgFouls: "2.1" },
      { name: "Jalen Duren", team: "DET", position: "C", avgMinutes: "28.5", avgFouls: "2.9" },
      { name: "Ausar Thompson", team: "DET", position: "SF", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Isaiah Stewart", team: "DET", position: "C", avgMinutes: "29.0", avgFouls: "2.6" },
      { name: "Ron Holland", team: "DET", position: "SF", avgMinutes: "22.0", avgFouls: "1.9" },
      { name: "Tim Hardaway Jr.", team: "DET", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Kevin Huerter", team: "DET", position: "SG", avgMinutes: "26.0", avgFouls: "1.5" },
      { name: "Dario Saric", team: "DET", position: "C", avgMinutes: "22.0", avgFouls: "2.2" },
      // GSW Warriors — Porzingis + Horford added; Kuminga/Hield/TJD gone; Butler (ACL) omitted; Curry injured
      { name: "Stephen Curry", team: "GSW", position: "PG", avgMinutes: "33.0", avgFouls: "1.6" },
      { name: "Draymond Green", team: "GSW", position: "PF", avgMinutes: "26.5", avgFouls: "2.9" },
      { name: "Andrew Wiggins", team: "GSW", position: "SF", avgMinutes: "28.5", avgFouls: "1.9" },
      { name: "Moses Moody", team: "GSW", position: "SG", avgMinutes: "26.0", avgFouls: "1.6" },
      { name: "Brandin Podziemski", team: "GSW", position: "SG", avgMinutes: "29.5", avgFouls: "1.6" },
      { name: "De'Anthony Melton", team: "GSW", position: "SG", avgMinutes: "28.0", avgFouls: "1.8" },
      { name: "Al Horford", team: "GSW", position: "C", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Kristaps Porzingis", team: "GSW", position: "C", avgMinutes: "27.0", avgFouls: "2.7" },
      // HOU Rockets — Kevin Durant arrived from PHX; Dillon Brooks traded to PHX
      { name: "Jalen Green", team: "HOU", position: "SG", avgMinutes: "34.0", avgFouls: "2.1" },
      { name: "Alperen Sengun", team: "HOU", position: "C", avgMinutes: "31.0", avgFouls: "3.0" },
      { name: "Amen Thompson", team: "HOU", position: "SF", avgMinutes: "30.0", avgFouls: "2.2" },
      { name: "Fred VanVleet", team: "HOU", position: "PG", avgMinutes: "31.0", avgFouls: "1.8" },
      { name: "Jabari Smith Jr.", team: "HOU", position: "PF", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Tari Eason", team: "HOU", position: "PF", avgMinutes: "23.0", avgFouls: "2.4" },
      { name: "Reed Sheppard", team: "HOU", position: "SG", avgMinutes: "25.0", avgFouls: "1.6" },
      { name: "Kevin Durant", team: "HOU", position: "PF", avgMinutes: "36.0", avgFouls: "2.1" },
      { name: "Clint Capela", team: "HOU", position: "C", avgMinutes: "20.0", avgFouls: "2.8" },
      { name: "Dorian Finney-Smith", team: "HOU", position: "SF", avgMinutes: "18.0", avgFouls: "1.4" },
      { name: "Josh Okogie", team: "HOU", position: "SF", avgMinutes: "18.0", avgFouls: "1.8" },
      { name: "Aaron Holiday", team: "HOU", position: "PG", avgMinutes: "13.0", avgFouls: "1.2" },
      { name: "Steven Adams", team: "HOU", position: "C", avgMinutes: "16.0", avgFouls: "2.1" },
      // IND Pacers — Zubac + Kobe Brown added; Mathurin/I.Jackson gone
      { name: "Tyrese Haliburton", team: "IND", position: "PG", avgMinutes: "33.0", avgFouls: "1.1" },
      { name: "Pascal Siakam", team: "IND", position: "PF", avgMinutes: "36.0", avgFouls: "2.1" },
      { name: "Myles Turner", team: "IND", position: "C", avgMinutes: "31.0", avgFouls: "2.5" },
      { name: "Andrew Nembhard", team: "IND", position: "PG", avgMinutes: "29.0", avgFouls: "1.7" },
      { name: "Aaron Nesmith", team: "IND", position: "SF", avgMinutes: "28.0", avgFouls: "2.3" },
      { name: "TJ McConnell", team: "IND", position: "PG", avgMinutes: "21.0", avgFouls: "1.5" },
      { name: "Ivica Zubac", team: "IND", position: "C", avgMinutes: "27.5", avgFouls: "2.8" },
      { name: "Kobe Brown", team: "IND", position: "SF", avgMinutes: "22.0", avgFouls: "1.9" },
      // LAC Clippers — Harden/Zubac gone; Garland/Mathurin/I.Jackson added
      { name: "Kawhi Leonard", team: "LAC", position: "SF", avgMinutes: "33.0", avgFouls: "1.6" },
      { name: "Norman Powell", team: "LAC", position: "SG", avgMinutes: "27.0", avgFouls: "1.7" },
      { name: "Bones Hyland", team: "LAC", position: "PG", avgMinutes: "21.0", avgFouls: "1.8" },
      { name: "Terance Mann", team: "LAC", position: "SF", avgMinutes: "24.0", avgFouls: "1.9" },
      { name: "Darius Garland", team: "LAC", position: "PG", avgMinutes: "34.0", avgFouls: "1.9" },
      { name: "Bennedict Mathurin", team: "LAC", position: "SG", avgMinutes: "30.0", avgFouls: "2.2" },
      { name: "Isaiah Jackson", team: "LAC", position: "C", avgMinutes: "24.0", avgFouls: "2.7" },
      // LAL Lakers — Luka/LeBron; D'Angelo Russell/Gabe Vincent gone; Kennard added
      { name: "Luka Doncic", team: "LAL", position: "PG", avgMinutes: "37.0", avgFouls: "2.2" },
      { name: "LeBron James", team: "LAL", position: "SF", avgMinutes: "35.0", avgFouls: "2.0" },
      { name: "Austin Reaves", team: "LAL", position: "SG", avgMinutes: "33.0", avgFouls: "1.7" },
      { name: "Rui Hachimura", team: "LAL", position: "PF", avgMinutes: "25.0", avgFouls: "1.7" },
      { name: "Jarred Vanderbilt", team: "LAL", position: "PF", avgMinutes: "22.0", avgFouls: "2.3" },
      { name: "Luke Kennard", team: "LAL", position: "SG", avgMinutes: "24.0", avgFouls: "1.3" },
      // MEM Grizzlies — JJJ traded to UTA; many new pieces arrived; Ty Jerome here per live odds
      { name: "Ja Morant", team: "MEM", position: "PG", avgMinutes: "33.5", avgFouls: "1.9" },
      { name: "Desmond Bane", team: "MEM", position: "SG", avgMinutes: "33.0", avgFouls: "1.8" },
      { name: "Jaylen Wells", team: "MEM", position: "SG", avgMinutes: "24.0", avgFouls: "1.5" },
      { name: "Santi Aldama", team: "MEM", position: "PF", avgMinutes: "25.0", avgFouls: "1.8" },
      { name: "Scotty Pippen Jr.", team: "MEM", position: "PG", avgMinutes: "21.0", avgFouls: "1.3" },
      { name: "Zach Edey", team: "MEM", position: "C", avgMinutes: "24.0", avgFouls: "2.8" },
      { name: "GG Jackson", team: "MEM", position: "SF", avgMinutes: "22.0", avgFouls: "1.7" },
      { name: "Walter Clayton Jr.", team: "MEM", position: "PG", avgMinutes: "22.0", avgFouls: "1.4" },
      { name: "Kyle Anderson", team: "MEM", position: "SF", avgMinutes: "20.0", avgFouls: "1.9" },
      { name: "Taylor Hendricks", team: "MEM", position: "PF", avgMinutes: "20.0", avgFouls: "1.8" },
      { name: "Eric Gordon", team: "MEM", position: "SG", avgMinutes: "19.0", avgFouls: "1.3" },
      { name: "Georges Niang", team: "MEM", position: "PF", avgMinutes: "18.0", avgFouls: "1.4" },
      { name: "Ty Jerome", team: "MEM", position: "PG", avgMinutes: "22.0", avgFouls: "1.2" },
      // MIA Heat — Butler gone (GSW); Herro/Adebayo anchor
      { name: "Bam Adebayo", team: "MIA", position: "C", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Tyler Herro", team: "MIA", position: "SG", avgMinutes: "34.5", avgFouls: "2.1" },
      { name: "Terry Rozier", team: "MIA", position: "PG", avgMinutes: "29.0", avgFouls: "1.9" },
      { name: "Haywood Highsmith", team: "MIA", position: "SF", avgMinutes: "25.0", avgFouls: "2.0" },
      { name: "Nikola Jovic", team: "MIA", position: "PF", avgMinutes: "26.0", avgFouls: "1.8" },
      // MIL Bucks — Middleton gone to DAL; Ousmane Dieng added; Giannis/Lillard/Sabonis core
      { name: "Giannis Antetokounmpo", team: "MIL", position: "PF", avgMinutes: "35.5", avgFouls: "2.9" },
      { name: "Damian Lillard", team: "MIL", position: "PG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Domantas Sabonis", team: "MIL", position: "C", avgMinutes: "33.0", avgFouls: "3.1" },
      { name: "Brook Lopez", team: "MIL", position: "C", avgMinutes: "27.0", avgFouls: "2.1" },
      { name: "Bobby Portis", team: "MIL", position: "PF", avgMinutes: "22.0", avgFouls: "2.2" },
      { name: "Ousmane Dieng", team: "MIL", position: "SF", avgMinutes: "22.0", avgFouls: "1.7" },
      // MIN Timberwolves — Conley/Dillingham/Miller gone; Dosunmu + Phillips added
      { name: "Anthony Edwards", team: "MIN", position: "SG", avgMinutes: "35.5", avgFouls: "1.8" },
      { name: "Julius Randle", team: "MIN", position: "PF", avgMinutes: "35.0", avgFouls: "2.6" },
      { name: "Rudy Gobert", team: "MIN", position: "C", avgMinutes: "32.5", avgFouls: "2.5" },
      { name: "Naz Reid", team: "MIN", position: "C", avgMinutes: "24.5", avgFouls: "2.4" },
      { name: "Nickeil Alexander-Walker", team: "MIN", position: "SG", avgMinutes: "21.0", avgFouls: "1.7" },
      { name: "Donte DiVincenzo", team: "MIN", position: "SG", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Ayo Dosunmu", team: "MIN", position: "SG", avgMinutes: "30.0", avgFouls: "1.7" },
      { name: "Julian Phillips", team: "MIN", position: "SF", avgMinutes: "22.0", avgFouls: "1.7" },
      // NOP Pelicans — CJ McCollum gone to WAS/ATL; Dalen Terry added
      { name: "Cooper Flagg", team: "NOP", position: "PF", avgMinutes: "30.0", avgFouls: "2.0" },
      { name: "Zion Williamson", team: "NOP", position: "PF", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "Brandon Ingram", team: "NOP", position: "SF", avgMinutes: "33.0", avgFouls: "1.8" },
      { name: "Dejounte Murray", team: "NOP", position: "PG", avgMinutes: "33.5", avgFouls: "2.3" },
      { name: "Herbert Jones", team: "NOP", position: "SF", avgMinutes: "28.0", avgFouls: "2.6" },
      { name: "Jordan Hawkins", team: "NOP", position: "SG", avgMinutes: "23.0", avgFouls: "1.4" },
      { name: "Dalen Terry", team: "NOP", position: "SG", avgMinutes: "18.0", avgFouls: "1.5" },
      // NYK Knicks — Yabusele gone; Jose Alvarado added
      { name: "Jalen Brunson", team: "NYK", position: "PG", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Karl-Anthony Towns", team: "NYK", position: "C", avgMinutes: "35.0", avgFouls: "2.8" },
      { name: "OG Anunoby", team: "NYK", position: "SF", avgMinutes: "33.5", avgFouls: "2.1" },
      { name: "Josh Hart", team: "NYK", position: "SF", avgMinutes: "33.5", avgFouls: "2.3" },
      { name: "Mikal Bridges", team: "NYK", position: "SG", avgMinutes: "35.5", avgFouls: "1.4" },
      { name: "Miles McBride", team: "NYK", position: "PG", avgMinutes: "23.0", avgFouls: "1.6" },
      { name: "Jose Alvarado", team: "NYK", position: "PG", avgMinutes: "18.0", avgFouls: "1.7" },
      // OKC Thunder — Jared McCain added from PHI
      { name: "Shai Gilgeous-Alexander", team: "OKC", position: "PG", avgMinutes: "34.5", avgFouls: "2.5" },
      { name: "Chet Holmgren", team: "OKC", position: "C", avgMinutes: "30.0", avgFouls: "2.3" },
      { name: "Jalen Williams", team: "OKC", position: "SG", avgMinutes: "34.0", avgFouls: "2.0" },
      { name: "Alex Caruso", team: "OKC", position: "SG", avgMinutes: "29.0", avgFouls: "2.3" },
      { name: "Luguentz Dort", team: "OKC", position: "SG", avgMinutes: "29.5", avgFouls: "2.3" },
      { name: "Isaiah Hartenstein", team: "OKC", position: "C", avgMinutes: "26.5", avgFouls: "2.7" },
      { name: "Aaron Wiggins", team: "OKC", position: "SG", avgMinutes: "20.0", avgFouls: "1.5" },
      { name: "Jared McCain", team: "OKC", position: "SG", avgMinutes: "24.0", avgFouls: "1.6" },
      // ORL Magic — Cole Anthony and Tyus Jones gone
      { name: "Franz Wagner", team: "ORL", position: "SF", avgMinutes: "35.0", avgFouls: "2.1" },
      { name: "Paolo Banchero", team: "ORL", position: "PF", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Jalen Suggs", team: "ORL", position: "PG", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "Jonathan Isaac", team: "ORL", position: "PF", avgMinutes: "26.0", avgFouls: "2.1" },
      { name: "Wendell Carter Jr.", team: "ORL", position: "C", avgMinutes: "27.0", avgFouls: "2.5" },
      // PHI 76ers — McCain/Gordon gone; core remains
      { name: "Joel Embiid", team: "PHI", position: "C", avgMinutes: "33.5", avgFouls: "2.9" },
      { name: "Tyrese Maxey", team: "PHI", position: "PG", avgMinutes: "36.0", avgFouls: "1.8" },
      { name: "Paul George", team: "PHI", position: "SF", avgMinutes: "34.0", avgFouls: "2.7" },
      { name: "Kelly Oubre Jr.", team: "PHI", position: "SF", avgMinutes: "27.0", avgFouls: "2.1" },
      { name: "KJ Martin", team: "PHI", position: "PF", avgMinutes: "22.5", avgFouls: "2.0" },
      { name: "Andre Drummond", team: "PHI", position: "C", avgMinutes: "21.0", avgFouls: "2.7" },
      // PHX Suns — Dillon Brooks arrived from HOU; Kevin Durant traded to HOU
      { name: "Devin Booker", team: "PHX", position: "SG", avgMinutes: "36.5", avgFouls: "2.3" },
      { name: "Dillon Brooks", team: "PHX", position: "SF", avgMinutes: "29.0", avgFouls: "2.8" },
      { name: "Bradley Beal", team: "PHX", position: "SG", avgMinutes: "30.5", avgFouls: "1.8" },
      { name: "Grayson Allen", team: "PHX", position: "SG", avgMinutes: "32.0", avgFouls: "2.0" },
      { name: "Jusuf Nurkic", team: "PHX", position: "C", avgMinutes: "26.0", avgFouls: "2.7" },
      { name: "Cole Anthony", team: "PHX", position: "PG", avgMinutes: "21.0", avgFouls: "1.9" },
      { name: "Amir Coffey", team: "PHX", position: "SF", avgMinutes: "20.0", avgFouls: "1.6" },
      { name: "Ryan Dunn", team: "PHX", position: "SF", avgMinutes: "22.0", avgFouls: "1.9" },
      // POR Trail Blazers — Simons gone; Jrue Holiday added; Krejci gone (to ATL)
      { name: "Scoot Henderson", team: "POR", position: "PG", avgMinutes: "30.0", avgFouls: "2.5" },
      { name: "Shaedon Sharpe", team: "POR", position: "SG", avgMinutes: "27.5", avgFouls: "1.8" },
      { name: "Jerami Grant", team: "POR", position: "PF", avgMinutes: "31.0", avgFouls: "2.1" },
      { name: "Toumani Camara", team: "POR", position: "SF", avgMinutes: "23.0", avgFouls: "2.0" },
      { name: "Deandre Ayton", team: "POR", position: "C", avgMinutes: "28.0", avgFouls: "2.3" },
      { name: "Jrue Holiday", team: "POR", position: "PG", avgMinutes: "31.5", avgFouls: "2.5" },
      // SAC Kings — De'Andre Hunter added; Huerter/Ellis/Schroder gone
      { name: "Keegan Murray", team: "SAC", position: "SF", avgMinutes: "32.0", avgFouls: "1.6" },
      { name: "Malik Monk", team: "SAC", position: "SG", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Harrison Barnes", team: "SAC", position: "SF", avgMinutes: "27.0", avgFouls: "1.7" },
      { name: "Davion Mitchell", team: "SAC", position: "PG", avgMinutes: "24.0", avgFouls: "1.6" },
      { name: "Trey Lyles", team: "SAC", position: "C", avgMinutes: "24.0", avgFouls: "2.4" },
      { name: "De'Andre Hunter", team: "SAC", position: "SF", avgMinutes: "30.5", avgFouls: "1.9" },
      // SAS Spurs — Wemby + Fox elite duo; no significant deadline moves
      { name: "Victor Wembanyama", team: "SAS", position: "C", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "De'Aaron Fox", team: "SAS", position: "PG", avgMinutes: "35.5", avgFouls: "2.5" },
      { name: "Devin Vassell", team: "SAS", position: "SG", avgMinutes: "29.5", avgFouls: "1.9" },
      { name: "Jeremy Sochan", team: "SAS", position: "PF", avgMinutes: "28.5", avgFouls: "2.2" },
      { name: "Stephon Castle", team: "SAS", position: "PG", avgMinutes: "26.0", avgFouls: "1.8" },
      { name: "Keldon Johnson", team: "SAS", position: "SF", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Julian Champagnie", team: "SAS", position: "SF", avgMinutes: "22.0", avgFouls: "1.6" },
      // TOR Raptors — Agbaji gone to BKN; Trayce Jackson-Davis added; Chris Paul (buyout)
      { name: "Scottie Barnes", team: "TOR", position: "PF", avgMinutes: "35.0", avgFouls: "2.3" },
      { name: "RJ Barrett", team: "TOR", position: "SF", avgMinutes: "34.5", avgFouls: "2.0" },
      { name: "Immanuel Quickley", team: "TOR", position: "PG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Jakob Poeltl", team: "TOR", position: "C", avgMinutes: "30.5", avgFouls: "2.6" },
      { name: "Gradey Dick", team: "TOR", position: "SG", avgMinutes: "26.0", avgFouls: "1.6" },
      { name: "Trayce Jackson-Davis", team: "TOR", position: "C", avgMinutes: "22.0", avgFouls: "2.1" },
      // UTA Jazz — massive deadline haul: JJJ + Lonzo Ball added; Sexton/Konchar/etc. gone
      { name: "Lauri Markkanen", team: "UTA", position: "PF", avgMinutes: "33.5", avgFouls: "1.8" },
      { name: "Walker Kessler", team: "UTA", position: "C", avgMinutes: "29.0", avgFouls: "2.4" },
      { name: "Keyonte George", team: "UTA", position: "PG", avgMinutes: "30.0", avgFouls: "1.9" },
      { name: "Jordan Clarkson", team: "UTA", position: "SG", avgMinutes: "25.5", avgFouls: "1.8" },
      { name: "John Collins", team: "UTA", position: "PF", avgMinutes: "27.5", avgFouls: "2.2" },
      { name: "Jaren Jackson Jr.", team: "UTA", position: "PF", avgMinutes: "31.0", avgFouls: "3.0" },
      { name: "Lonzo Ball", team: "UTA", position: "PG", avgMinutes: "26.0", avgFouls: "1.6" },
      // WAS Wizards — Rebuilding; Poole/Kuzma gone; Trae Young, AD, Russell, Hardy, Exum added
      { name: "Trae Young", team: "WAS", position: "PG", avgMinutes: "35.5", avgFouls: "2.0" },
      { name: "Anthony Davis", team: "WAS", position: "C", avgMinutes: "34.5", avgFouls: "2.5" },
      { name: "Alexandre Sarr", team: "WAS", position: "C", avgMinutes: "27.0", avgFouls: "2.5" },
      { name: "Kyshawn George", team: "WAS", position: "SF", avgMinutes: "28.0", avgFouls: "1.8" },
      { name: "Bilal Coulibaly", team: "WAS", position: "SF", avgMinutes: "29.0", avgFouls: "2.1" },
      { name: "D'Angelo Russell", team: "WAS", position: "PG", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Jaden Hardy", team: "WAS", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Dante Exum", team: "WAS", position: "PG", avgMinutes: "18.0", avgFouls: "1.6" },
      { name: "Tristan Vukcevic", team: "WAS", position: "C", avgMinutes: "22.0", avgFouls: "2.3" },
      { name: "Bub Carrington", team: "WAS", position: "SG", avgMinutes: "20.0", avgFouls: "1.4" },
      { name: "Tre Johnson", team: "WAS", position: "SG", avgMinutes: "21.0", avgFouls: "1.6" },
      { name: "Sharife Cooper", team: "WAS", position: "PG", avgMinutes: "15.0", avgFouls: "1.5" },
      { name: "Will Riley", team: "WAS", position: "SF", avgMinutes: "16.0", avgFouls: "1.3" },
      { name: "Justin Champagnie", team: "WAS", position: "SF", avgMinutes: "14.0", avgFouls: "1.6" },
      { name: "Julian Reese", team: "WAS", position: "C", avgMinutes: "15.0", avgFouls: "2.1" },
      { name: "Jamir Watkins", team: "WAS", position: "SF", avgMinutes: "12.0", avgFouls: "1.4" },
    ];

    const existingByName = new Map(existingPlayers.map(p => [p.name.toLowerCase(), p]));
    let seeded = 0, updated = 0;
    for (const p of playersToSeed) {
      const existing = existingByName.get(p.name.toLowerCase());
      if (existing) {
        if (existing.team !== p.team || existing.position !== p.position) {
          await storage.updatePlayerStats(existing.id, { team: p.team, position: p.position });
          updated++;
        }
      } else {
        await storage.createPlayer(p);
        seeded++;
      }
    }
    if (seeded > 0 || updated > 0) {
      console.log(`[seed] ${seeded} new players inserted, ${updated} players updated (team/position)`);
    }

    // ── 2025-26 DEFENSIVE RATINGS by team & position ─────────────────────────
    // Scale: 0.88 (elite) to 1.12 (poor). 1.00 = league average.
    // Updated post-Feb 5, 2026 deadline to reflect new team compositions.
    const teamDefenseSeeds: Record<string, Record<string, number>> = {
      ATL: { PG: 1.05, SG: 1.04, SF: 1.03, PF: 1.03, C: 1.02 }, // Kuminga/Daniels add athleticism but still weak
      BKN: { PG: 1.08, SG: 1.07, SF: 1.06, PF: 1.05, C: 1.04 }, // rebuilding, poor D
      BOS: { PG: 0.90, SG: 0.89, SF: 0.90, PF: 0.89, C: 0.90 }, // Tatum out hurts D, Vucevic replaces Porzingis
      CHA: { PG: 1.05, SG: 1.05, SF: 1.04, PF: 1.04, C: 1.04 }, // influx of new players, still weak
      CHI: { PG: 1.03, SG: 1.03, SF: 1.03, PF: 1.02, C: 1.01 }, // rebuilding but young/athletic
      CLE: { PG: 0.93, SG: 0.92, SF: 0.92, PF: 0.90, C: 0.89 }, // Harden hurts PG D; Mobley/Allen elite
      DAL: { PG: 0.98, SG: 0.97, SF: 0.97, PF: 0.97, C: 0.96 }, // lost Davis anchor; still solid Kyrie/Klay
      DEN: { PG: 1.01, SG: 1.01, SF: 1.00, PF: 0.99, C: 0.98 }, // Jokic-anchored, average
      DET: { PG: 1.04, SG: 1.03, SF: 1.04, PF: 1.03, C: 1.02 }, // young core, still improving
      GSW: { PG: 0.96, SG: 0.95, SF: 0.95, PF: 0.96, C: 0.95 }, // Draymond + Porzingis rim protection; Butler out
      HOU: { PG: 0.97, SG: 0.97, SF: 0.97, PF: 0.98, C: 0.96 }, // Brooks/Amen defensive
      IND: { PG: 1.04, SG: 1.03, SF: 1.03, PF: 1.04, C: 1.00 }, // Zubac major upgrade at C
      LAC: { PG: 0.98, SG: 0.97, SF: 0.96, PF: 0.97, C: 1.00 }, // lost Zubac interior; Kawhi/Powell solid
      LAL: { PG: 0.98, SG: 0.98, SF: 0.97, PF: 0.96, C: 0.97 }, // LeBron/Luka; AD gone hurts interior
      MEM: { PG: 1.02, SG: 1.01, SF: 1.01, PF: 1.02, C: 1.00 }, // lost JJJ (DPOY); influx of new parts
      MIA: { PG: 0.95, SG: 0.94, SF: 0.95, PF: 0.96, C: 0.95 }, // Spoelstra defensive system
      MIL: { PG: 0.94, SG: 0.94, SF: 0.95, PF: 0.93, C: 0.92 }, // Giannis + Sabonis elite D
      MIN: { PG: 0.89, SG: 0.89, SF: 0.90, PF: 0.89, C: 0.88 }, // Gobert/Edwards, best D in NBA
      NOP: { PG: 1.02, SG: 1.01, SF: 1.01, PF: 1.00, C: 1.01 }, // Flagg developing; Murray defensive
      NYK: { PG: 0.94, SG: 0.93, SF: 0.93, PF: 0.94, C: 0.92 }, // OG/Bridges/Hart elite D
      OKC: { PG: 0.90, SG: 0.89, SF: 0.90, PF: 0.91, C: 0.89 }, // Holmgren/Hartenstein; top D in league
      ORL: { PG: 0.93, SG: 0.92, SF: 0.92, PF: 0.93, C: 0.90 }, // Isaac/Suggs elite D
      PHI: { PG: 1.00, SG: 0.99, SF: 1.00, PF: 1.01, C: 0.98 }, // Embiid interior D
      PHX: { PG: 1.05, SG: 1.04, SF: 1.04, PF: 1.05, C: 1.04 }, // poor defensive team
      POR: { PG: 1.07, SG: 1.07, SF: 1.06, PF: 1.07, C: 1.05 }, // rebuilding, weak D
      SAC: { PG: 1.05, SG: 1.05, SF: 1.04, PF: 1.05, C: 1.03 }, // Hunter adds wing D; still below avg
      SAS: { PG: 1.02, SG: 1.02, SF: 1.03, PF: 1.03, C: 0.97 }, // Wemby elite C D; Fox improves guards
      TOR: { PG: 1.03, SG: 1.02, SF: 1.02, PF: 1.02, C: 1.01 }, // Barnes defensive anchor
      UTA: { PG: 1.04, SG: 1.04, SF: 1.03, PF: 0.97, C: 0.95 }, // JJJ transforms PF/C defense; elite rim protection
      WAS: { PG: 1.04, SG: 1.05, SF: 1.05, PF: 0.95, C: 0.92 }, // Anthony Davis elite C D; Young/Poole hurt PG/SG D
    };

    const positions = ["PG", "SG", "SF", "PF", "C"];
    for (const [team, posMap] of Object.entries(teamDefenseSeeds)) {
      for (const pos of positions) {
        await storage.createTeamDefense({
          teamName: team,
          position: pos,
          defRating: (posMap[pos] ?? 1.0).toFixed(2),
        });
      }
    }
  }
}

// ── Persistent plays routes ────────────────────────────────────────────────────
export function registerPlaysRoutes(app: Express): void {

  app.post("/api/plays/record", requireAdmin, async (req, res) => {
    try {
      const body = req.body as any;
      if (!body.playerName || !body.market || !body.direction || body.line == null || body.prob == null) {
        return res.status(400).json({ error: "Missing required play fields" });
      }
      const result = await trackPlay({
        gameId: body.gameId ?? "",
        playerId: body.playerId ? String(body.playerId) : null,
        playerName: body.playerName,
        team: body.team ?? null,
        sport: body.sport ?? "nba",
        market: body.market,
        direction: body.direction as "over" | "under",
        line: Number(body.line),
        projection: body.projection != null ? Number(body.projection) : Number(body.line),
        probability: Number(body.prob),
        edge: body.edgeGap != null ? Number(body.edgeGap) : 0,
        sportsbook: body.sportsbook ?? "consensus",
        derivedLine: Boolean(body.derivedLine ?? false),
        createdAt: body.timestamp ? new Date(body.timestamp).getTime() : Date.now(),
      }, storage);
      return res.json({ success: true, ...result });
    } catch (e) {
      return res.status(500).json({ error: "Failed to record play", details: (e as any).message });
    }
  });

  app.get("/api/plays", requireAdmin, async (req, res) => {
    try {
      const { sport, limit, settled, date } = req.query as Record<string, string>;
      const result = await storage.getPlays({
        sport: sport || "all",
        limit: limit ? parseInt(limit, 10) : 100,
        settled: settled || "all",
        date: date || undefined,
      });
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ error: "Failed to fetch plays" });
    }
  });

  app.patch("/api/plays/:id/settle", requireAdmin, async (req, res) => {
    try {
      const id = String(req.params.id);
      const { result, finalStat, settledAt } = req.body as { result: string; finalStat?: number | null; settledAt?: string };
      if (!result) return res.status(400).json({ error: "result is required" });
      const play = await storage.settlePlay(
        id,
        result,
        finalStat ?? null,
        settledAt ? new Date(settledAt) : new Date()
      );
      if (!play) return res.status(404).json({ error: "Play not found" });
      return res.json({ success: true, play });
    } catch (e) {
      return res.status(500).json({ error: "Failed to settle play" });
    }
  });

  app.get("/api/plays/stats", requireAdmin, async (_req, res) => {
    try {
      const stats = await storage.getPlayStats();
      return res.json(stats);
    } catch (e) {
      return res.status(500).json({ error: "Failed to fetch play stats" });
    }
  });

  app.post("/api/plays/cleanup", requireAdmin, async (_req, res) => {
    try {
      const deleted = await storage.cleanupOldPlays();
      return res.json({ success: true, deleted, message: `Removed ${deleted} settled plays older than 90 days` });
    } catch (e) {
      return res.status(500).json({ error: "Cleanup failed" });
    }
  });

  app.post("/api/plays/dedupe", requireAdmin, async (_req, res) => {
    try {
      const [playsResult, alertsResult] = await Promise.all([
        storage.cleanDuplicatePlays(),
        storage.cleanDuplicateAlerts(),
      ]);
      return res.json({
        success: true,
        plays: playsResult,
        alerts: alertsResult,
        message: `Removed ${playsResult.removed} duplicate plays and ${alertsResult.removed} duplicate alerts`,
      });
    } catch (e) {
      return res.status(500).json({ error: "Dedupe failed", details: (e as any).message });
    }
  });
}

// ── Performance Analytics (Truth Layer) ──────────────────────────────────────
export function registerPerformanceRoutes(app: Express): void {
  // [MLB Canonical Probability v1] Buckets are defined in probabilityEngine.ts
  // and shared with the validation harness so the analytics math is the same
  // single source of truth as the canonical persisted probability.
  const PROB_BUCKETS = MLB_PROB_BUCKETS;

  app.get("/api/performance", requireAdmin, async (req, res) => {
    try {
      const sport = (req.query.sport as string || "all").toLowerCase();
      const direction = (req.query.direction as string || "all").toLowerCase();
      const range = (req.query.range as string || "all").toLowerCase();

      const conds = [sql`${persistedPlays.result} IS NOT NULL`];

      if (sport !== "all") {
        conds.push(sql`${persistedPlays.sport} = ${sport}`);
      }
      if (direction !== "all") {
        conds.push(sql`${persistedPlays.direction} = ${direction}`);
      }

      if (range !== "all") {
        let startDate: string;
        if (range === "1d" || range === "today") {
          startDate = todayET();
        } else if (range === "7d") {
          startDate = daysAgoET(7);
        } else if (range === "30d") {
          startDate = daysAgoET(30);
        } else {
          startDate = "";
        }
        if (startDate) {
          conds.push(sql`${persistedPlays.gameDate} >= ${startDate}`);
        }
      }

      const plays = await db
        .select()
        .from(persistedPlays)
        .where(and(...conds))
        .orderBy(desc(persistedPlays.settledAt), desc(persistedPlays.timestamp))
        .limit(2000);

      const hits = plays.filter(p => p.result === "hit").length;
      const misses = plays.filter(p => p.result === "miss").length;
      const pushes = plays.filter(p => p.result === "push").length;
      const decided = hits + misses;

      // [PRIMARY ROI EXCLUSION v1] Compute Core Engine ROI alongside the
      // existing full-market summary. /api/performance is admin-facing so
      // we expose BOTH numbers; existing fields (winRate, hits, misses) keep
      // their full-market semantics for backward compatibility — primary
      // numbers are added under `primaryROI`/`primaryWinRate`/`primaryHits`.
      const { getPrimaryROIMetrics, getROIMetrics, filterPrimaryRoiPlays, logRoiFilterApplied } = await import("./services/roiEngine");
      const playsForRoi = plays as unknown as PersistedPlay[];
      const primaryPlays = filterPrimaryRoiPlays(playsForRoi);
      logRoiFilterApplied({
        surface: `performance.${sport}.${range}.${direction}`,
        totalPlays: playsForRoi.length,
        primaryPlays: primaryPlays.length,
      });
      const primaryROI = getPrimaryROIMetrics(playsForRoi).roi;
      const fullROI = getROIMetrics(playsForRoi).roi;
      // [ANALYTICS_QUERY] log — confirms the headline ROI block on
      // /api/performance applied the MLB primary filter when relevant.
      if (sport === "mlb" || sport === "all") {
        const { PRIMARY_MLB_ROI_MARKETS, EXCLUDED_FROM_PRIMARY_MLB_ROI, logAnalyticsQuery } =
          await import("./analytics/mlbMarketGroups");
        logAnalyticsQuery({
          surface: "/api/performance",
          sport,
          analyticsScope: "primary_mlb_roi",
          includedMarkets: PRIMARY_MLB_ROI_MARKETS,
          excludedMarkets: EXCLUDED_FROM_PRIMARY_MLB_ROI,
          totalPlays: playsForRoi.length,
          retainedPlays: primaryPlays.length,
        });
      }
      const primaryHits = primaryPlays.filter(p => p.result === "hit").length;
      const primaryMisses = primaryPlays.filter(p => p.result === "miss").length;
      const primaryDecided = primaryHits + primaryMisses;
      const primaryWinRate = primaryDecided > 0
        ? Math.round((primaryHits / primaryDecided) * 1000) / 10
        : 0;

      const avgEdge = plays.length > 0
        ? Math.round(plays.reduce((s, p) => s + (Number(p.edgeGap) || Number(p.modelEdge) || 0), 0) / plays.length * 10) / 10
        : 0;
      const avgProb = plays.length > 0
        ? Math.round(plays.reduce((s, p) => s + (Number(p.prob) || 0), 0) / plays.length * 10) / 10
        : 0;

      const buckets = bucketPlaysByCanonicalProb(
        plays.map(p => ({ prob: p.prob, result: p.result })),
        PROB_BUCKETS,
      );

      const oversCount = plays.filter(p => p.direction === "over").length;
      const undersCount = plays.filter(p => p.direction === "under").length;
      const nbaCount = plays.filter(p => p.sport === "nba").length;
      const mlbCount = plays.filter(p => p.sport === "mlb").length;
      console.log(`[performance] total=${plays.length} overs=${oversCount} unders=${undersCount} nba=${nbaCount} mlb=${mlbCount} buckets=${buckets.map(b => b.total).join(",")}`);
      // [MLB Canonical Probability v1] Buckets above key off persisted_plays.prob,
      // which is the canonical recommended-side calibrated probability for MLB.
      // No signalScore, edge, dominant probability, or display confidence is
      // ever used to bucket MLB plays.
      if (mlbCount > 0) {
        console.log("[MLB_ANALYTICS_PROBABILITY_SEMANTICS]", {
          source: "persisted_plays",
          probabilitySemantics: "recommended_side_calibrated",
          route: "/api/performance",
          mlbPlays: mlbCount,
        });
      }

      return res.json({
        probabilitySemantics: "recommended_side_calibrated",
        plays: plays.map(p => ({
          id: p.id,
          sport: p.sport,
          player: p.playerName,
          stat: p.market,
          direction: p.direction === "over" ? "O" : p.direction === "under" ? "U" : p.direction,
          line: Number(p.line),
          probability: Number(p.prob) || 0,
          edge: Number(p.edgeGap) || Number(p.modelEdge) || 0,
          finalStat: p.finalStat != null ? Number(p.finalStat) : null,
          result: p.result ? p.result.toUpperCase() as "HIT" | "MISS" | "PUSH" : null,
          gameId: p.gameId,
          createdAt: p.createdAt?.toISOString() ?? p.timestamp?.toISOString() ?? "",
          settledAt: p.settledAt?.toISOString() ?? null,
          confidenceTier: p.confidenceTier ?? null,
          team: p.team ?? null,
        })),
        buckets,
        summary: {
          total: plays.length,
          hits,
          misses,
          pushes,
          winRate: decided > 0 ? Math.round((hits / decided) * 1000) / 10 : 0,
          // [PRIMARY ROI EXCLUSION v1] Core Engine numbers (excludes
          // home_runs + batter_strikeouts) — opt-in for callers that want to
          // render the user-facing headline alongside the full-market view.
          primaryTotal: primaryPlays.length,
          primaryHits,
          primaryMisses,
          primaryWinRate,
          primaryROI,
          fullROI,
          excludedFromPrimary: ["home_runs", "batter_strikeouts"],
          avgEdge,
          avgProb,
        },
      });
    } catch (e: any) {
      console.error("[performance] Error:", e.message);
      return res.status(500).json({ error: "Failed to fetch performance data" });
    }
  });

  app.post("/api/performance/settle", requireAdmin, async (_req, res) => {
    try {
      const result = await gradePersistedPlays(storage);
      return res.json({ ...result, triggeredAt: new Date().toISOString() });
    } catch (e: any) {
      return res.status(500).json({ error: "Settlement failed", details: e.message });
    }
  });
}

// ── Admin test-alert route ─────────────────────────────────────────────────────
export function registerTestAlertRoute(app: Express): void {

  app.post("/api/admin/test-alert", requireAdmin, async (req: any, res) => {
    try {
      const { title, body, target, testPlay } = req.body as {
        title: string;
        body: string;
        target: "self" | "all";
        testPlay?: any;
        confirmed?: boolean;
      };

      if (!title || !body) return res.status(400).json({ error: "title and body are required" });

      let allUsers: any[] = [];
      try {
        allUsers = await storage.getAllUsers();
      } catch (e) {
        return res.status(500).json({ error: "Failed to fetch users" });
      }

      const usersWithPush = allUsers.filter((u: any) => u.pushSubscription);

      if (target === "self") {
        const adminUser = allUsers.find((u: any) => u.id === req.user?.id);
        if (!adminUser?.pushSubscription) {
          return res.status(404).json({ error: "No push subscription found. Install app to home screen first." });
        }
        const selfResult = await sendPushToUser(adminUser, {
          title,
          body,
          url: "/",
          data: { isTest: true, testPlay },
        });
        if (selfResult === "sent") {
          return res.json({ success: true, deliveredTo: 1, target: "self" });
        }
        // Don't report success when nothing was actually delivered (rate-limited,
        // expired subscription just cleaned up, invalid payload, or send failure).
        const selfStatus = selfResult === "rate_limited" ? 429 : selfResult === "expired" ? 410 : 502;
        return res.status(selfStatus).json({
          success: false,
          deliveredTo: 0,
          target: "self",
          reason: selfResult,
        });
      }

      if (target === "all") {
        if (!req.body.confirmed) {
          return res.json({ requiresConfirmation: true, subscriberCount: usersWithPush.length });
        }
        let sent = 0;
        await Promise.allSettled(
          usersWithPush.map(async (u: any) => {
            try {
              const result = await sendPushToUser(u, { title, body, url: "/", data: { isTest: true, testPlay } });
              if (result === "sent") sent++;
            } catch (_) {}
          })
        );
        return res.json({ success: true, deliveredTo: sent, target: "all" });
      }

      return res.status(400).json({ error: "target must be 'self' or 'all'" });
    } catch (e: any) {
      return res.status(500).json({ error: "Test alert failed", details: e.message });
    }
  });
}

// Calibration routes (admin only)
export function registerCalibrationRoutes(app: Express): void {
  app.get("/api/mlb/self-learning-status", requireAdmin, async (req, res) => {
    try {
      const { getAllCalibrationData, getLearnedContactProfile, getLearnedPitchVulnerability } = await import("./mlb/selfLearning");
      const calData = getAllCalibrationData();
      const contactProfile = getLearnedContactProfile();
      const pitchVuln = getLearnedPitchVulnerability();
      return res.json({
        lastRefresh: calData.lastRefresh,
        sampleCounts: calData.sampleCounts,
        marketCalibrations: calData.marketCalibrations,
        contactProfile,
        pitchVulnerability: pitchVuln,
      });
    } catch (e) {
      console.error("[self-learning-status]", (e as Error).message);
      return res.status(500).json({ error: "Failed to get self-learning status" });
    }
  });

  app.get("/api/persisted-plays/calibration", requireAdmin, async (req, res) => {
    try {
      const { sport, market, startDate, endDate } = req.query as Record<string, string>;
      // Analytics scope: "primary" (default for MLB) excludes home_runs +
      // batter_strikeouts; "hr_radar" isolates home_runs; "full" returns
      // every market untouched (admin only — already gated by requireAdmin).
      // The legacy "experimental" / "experimental_mlb" scope (batter_strikeouts)
      // is collapsed onto "full" — batter_strikeouts is deprecated and no
      // longer has a dedicated analytics lane.
      const scopeRaw = String((req.query as any).scope ?? "primary").toLowerCase();
      const analyticsScope: "primary_mlb_roi" | "hr_radar" | "full" =
        scopeRaw === "hr_radar" ? "hr_radar"
        : scopeRaw === "full" || scopeRaw === "experimental" || scopeRaw === "experimental_mlb" ? "full"
        : "primary_mlb_roi";

      const allPlays = await storage.getGradedPlaysForCalibration({
        sport: sport || undefined,
        market: market || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });

      type PersistedPlay = (typeof allPlays)[0];

      const sportLower = (sport || "").toLowerCase();
      const isMlb = sportLower === "mlb";
      const {
        PRIMARY_MLB_ROI_MARKETS,
        EXCLUDED_FROM_PRIMARY_MLB_ROI,
        HR_RADAR_ANALYTICS_MARKETS,
        filterPrimaryMlbRoiPlays,
        logAnalyticsQuery,
      } = await import("./analytics/mlbMarketGroups");

      // Apply MLB scope filter only when the request targets MLB. Non-MLB
      // (NBA / NCAAB / cross-sport) requests pass through untouched per the
      // hard rule that NBA/NCAAB analytics are unaffected by this change.
      let plays = allPlays as PersistedPlay[];
      if (isMlb) {
        if (analyticsScope === "primary_mlb_roi") {
          plays = filterPrimaryMlbRoiPlays(plays);
        } else if (analyticsScope === "hr_radar") {
          plays = plays.filter((p) => HR_RADAR_ANALYTICS_MARKETS.includes(p.market));
        }
        logAnalyticsQuery({
          surface: "/api/persisted-plays/calibration",
          sport: "mlb",
          analyticsScope,
          includedMarkets:
            analyticsScope === "primary_mlb_roi" ? PRIMARY_MLB_ROI_MARKETS
            : analyticsScope === "hr_radar" ? HR_RADAR_ANALYTICS_MARKETS
            : [],
          excludedMarkets:
            analyticsScope === "primary_mlb_roi" ? EXCLUDED_FROM_PRIMARY_MLB_ROI : [],
          totalPlays: allPlays.length,
          retainedPlays: plays.length,
        });
      }

      const totalPlays = plays.length;
      const wins = plays.filter((p: PersistedPlay) => p.result === "hit").length;
      const pushes = plays.filter((p: PersistedPlay) => p.result === "push").length;
      const nonPushes = totalPlays - pushes;
      const winRate = nonPushes > 0 ? Math.round((wins / nonPushes) * 1000) / 10 : 0;
      const pushRate = totalPlays > 0 ? Math.round((pushes / totalPlays) * 1000) / 10 : 0;

      const playsWithEdge = plays.filter((p: PersistedPlay) => p.edgeGap != null);
      const edgeValues = playsWithEdge.map((p: PersistedPlay) => Number(p.edgeGap));
      const probValues = plays.map((p: PersistedPlay) => Number(p.prob ?? 0));
      const avgEdge = edgeValues.length > 0
        ? Math.round(edgeValues.reduce((a: number, b: number) => a + b, 0) / edgeValues.length * 10) / 10
        : 0;
      const avgProbability = probValues.length > 0
        ? Math.round(probValues.reduce((a: number, b: number) => a + b, 0) / probValues.length * 10) / 10
        : 0;

      const makeBucketStats = (
        items: PersistedPlay[],
        label: string,
        filterFn: (p: PersistedPlay) => boolean
      ) => {
        const bucket = items.filter(filterFn);
        const bTotal = bucket.length;
        const bWins = bucket.filter((p: PersistedPlay) => p.result === "hit").length;
        const bPushes = bucket.filter((p: PersistedPlay) => p.result === "push").length;
        const bNonPush = bTotal - bPushes;
        const bWinRate = bNonPush > 0 ? Math.round((bWins / bNonPush) * 1000) / 10 : 0;
        const bPushRate = bTotal > 0 ? Math.round((bPushes / bTotal) * 1000) / 10 : 0;
        return { label, total: bTotal, wins: bWins, pushes: bPushes, winRate: bWinRate, pushRate: bPushRate };
      }

      const edgeBuckets = [
        makeBucketStats(plays, "0–5%",  (p: PersistedPlay) => p.edgeGap != null && Number(p.edgeGap) >= 0 && Number(p.edgeGap) < 5),
        makeBucketStats(plays, "5–10%", (p: PersistedPlay) => p.edgeGap != null && Number(p.edgeGap) >= 5 && Number(p.edgeGap) < 10),
        makeBucketStats(plays, "10%+",  (p: PersistedPlay) => p.edgeGap != null && Number(p.edgeGap) >= 10),
      ];

      const probBuckets = [
        makeBucketStats(plays, "50–60",  (p: PersistedPlay) => { const prob = Number(p.prob); return prob >= 50 && prob < 60; }),
        makeBucketStats(plays, "60–70",  (p: PersistedPlay) => { const prob = Number(p.prob); return prob >= 60 && prob < 70; }),
        makeBucketStats(plays, "70–80",  (p: PersistedPlay) => { const prob = Number(p.prob); return prob >= 70 && prob < 80; }),
        makeBucketStats(plays, "80–100", (p: PersistedPlay) => { const prob = Number(p.prob); return prob >= 80 && prob <= 100; }),
      ];

      const sportForResponse = (sport || "").toLowerCase();
      const isMlbResponse = sportForResponse === "mlb";
      const scopeForResponseRaw = String((req.query as any).scope ?? "primary").toLowerCase();
      const scopeForResponse = scopeForResponseRaw === "hr_radar" ? "hr_radar"
        : scopeForResponseRaw === "experimental" || scopeForResponseRaw === "experimental_mlb" ? "experimental_mlb"
        : scopeForResponseRaw === "full" ? "full"
        : "primary_mlb_roi";

      return res.json({
        plays,
        summary: { totalPlays, winRate, pushRate, avgEdge, avgProbability },
        edgeBuckets,
        probBuckets,
        analyticsScope: isMlbResponse ? scopeForResponse : "full",
        excludedMarkets: isMlbResponse && scopeForResponse === "primary_mlb_roi"
          ? Array.from(EXCLUDED_FROM_PRIMARY_MLB_ROI)
          : [],
      });
    } catch (e) {
      console.error("[calibration]", (e as Error).message);
      return res.status(500).json({ error: "Failed to load calibration data" });
    }
  });
}

// Analytics routes (admin only)
export function registerAnalyticsRoutes(app: Express): void {
  // ── NBA Engine Audit endpoint ────────────────────────────────────────────
  // Returns directional pipeline trace (5 UNDER plays), full audit object,
  // and post-filter results summary from the in-memory calc log + persisted plays.
  //
  // AUDIT ENDPOINT CONTRACT (STRICT — DO NOT VIOLATE):
  // - This endpoint reads signal results from calcLogEntries ONLY.
  app.get("/api/top-plays", requireAuth, async (_req, res) => {
    try {
      // ── LiveLocks Batch D — canonical-aware top-plays ──────────────
      // Bus is the primary inventory source. When the bus has registered
      // signals, build the top-plays input from bus items (canonical +
      // matched MLBSignal payload). When the bus is empty (cold start /
      // pre-engine-cycle), fall back to mlbEdgeCache iteration tagged
      // with [LL_TOP_PLAYS_CACHE_FALLBACK] so the gap is observable.
      const { buildTopPlays } = await import("./services/topPlaysService");
      const { readBusInventory } = await import("./services/canonicalSignalViewModel");

      const mlbSignals: any[] = [];
      let usedBus = false;

      try {
        const inv = readBusInventory({ route: "/api/top-plays", excludeTerminal: true });
        if (inv.length > 0) {
          usedBus = true;
          console.log(`[LL_TOP_PLAYS_CANONICAL_READ] busItems=${inv.length}`);
          for (const item of inv) {
            const sig: any = item.mlbSignal;
            if (!sig) continue; // bridge miss — payload not in cache, skip
            const entry = mlbEdgeCache.get(item.canonical.gameId) as any;
            const rawOutput = entry?.outputs?.find((o: any) => o.playerId === sig.playerId && o.market === sig.market);
            const sigAny = sig as any;
            const inning = entry?.inning ?? sigAny.inning ?? null;
            const gameStatus = entry?.status ?? sigAny.status ?? null;
            const timingLabel = inning != null ? `Inning ${inning}` : gameStatus === "pre" ? "Pre-game" : gameStatus === "in" ? "Live" : null;
            mlbSignals.push({
              playerId: sig.playerId,
              playerName: sig.playerName,
              market: sig.market,
              enginePct: Math.round((sig.engineProbability ?? 0) * 10) / 10,
              edge: rawOutput ? Math.round(rawOutput.edge * 100) / 100 : null,
              bookLine: sig.line,
              projection: sig.projection ?? null,
              recommendedSide: sig.side,
              gameId: sig.gameId,
              signalScore: sig.signalScore,
              confidenceTier: sig.confidenceTier,
              signalTier: sig.signalTier,
              timingContext: sigAny.timingContext ?? timingLabel,
              currentStats: sig.currentStats ?? null,
              lastABContact: sig.lastABContact ?? null,
              batterArchetype: sig.batterArchetype ?? null,
              pitcherArchetype: sig.pitcherArchetype ?? null,
              thesis: sig.thesis ?? null,
              isFlagship: sig.isFlagship ?? false,
              safetyCeilingApplied: sig.safetyCeilingApplied ?? false,
              dataQuality: sig.dataQuality ?? null,
              canonicalLifecycleState: item.canonical.lifecycleState,
              canonicalSurfacedAt: item.canonical.surfacedAt,
              canonicalUpdatedAt: item.canonical.updatedAt,
            });
          }
        }
      } catch (e) {
        console.warn(`[LL_TOP_PLAYS_CACHE_FALLBACK] bus read failed: ${(e as Error).message}`);
      }

      if (!usedBus) {
        console.log(`[LL_TOP_PLAYS_CACHE_FALLBACK] bus empty — falling back to mlbEdgeCache`);
        for (const [, entry] of Array.from(mlbEdgeCache.entries())) {
          // Two-axis freshness — match the bettable edge-feed window (20m)
          // so the top-plays widget stays consistent with the main feed and
          // never drops a preserved blank-cycle signal that the feed still shows.
          const FRESHNESS_MS = 20 * 60 * 1000;
          if (!isMLBEdgeEntryFresh(entry, FRESHNESS_MS)) continue;
          const qs = entry.qualifiedSignals ?? [];
          for (const sig of qs) {
            const rawOutput = entry.outputs?.find((o: any) => o.playerId === sig.playerId && o.market === sig.market);
            const gameEntry = entry as any;
            const sigAny = sig as any;
            const inning = gameEntry.inning ?? sigAny.inning ?? null;
            const gameStatus = gameEntry.status ?? sigAny.status ?? null;
            const timingLabel = inning != null ? `Inning ${inning}` : gameStatus === "pre" ? "Pre-game" : gameStatus === "in" ? "Live" : null;
            mlbSignals.push({
            playerId: sig.playerId,
            playerName: sig.playerName,
            market: sig.market,
            enginePct: Math.round((sig.engineProbability ?? 0) * 10) / 10,
            edge: rawOutput ? Math.round(rawOutput.edge * 100) / 100 : null,
            bookLine: sig.line,
            projection: sig.projection ?? null,
            recommendedSide: sig.side,
            gameId: sig.gameId,
            signalScore: sig.signalScore,
            confidenceTier: sig.confidenceTier,
            // [MLB Canonical Signal Tier — Phase 2] Pass the orchestrator-stamped
            // canonical tier through to topPlaysService so the Top Plays surface
            // renders the SAME tier as LiveBoard / MlbSignalCard. Missing this
            // pass-through caused topPlaysService to fall through to the legacy
            // confidenceTier path and emit [MLB_TIER_FALLBACK] for every MLB row.
            signalTier: sig.signalTier,
            timingContext: sigAny.timingContext ?? timingLabel,
            currentStats: sig.currentStats ?? null,
            lastABContact: sig.lastABContact ?? null,
            batterArchetype: sig.batterArchetype ?? null,
            pitcherArchetype: sig.pitcherArchetype ?? null,
            thesis: sig.thesis ?? null,
            isFlagship: sig.isFlagship ?? false,
            safetyCeilingApplied: sig.safetyCeilingApplied ?? false,
            dataQuality: sig.dataQuality ?? null,
          });
        }
        }
      }

      const today = todayET();
      const { plays: recentPlays } = await storage.getPlays({ date: today, settled: "pending", limit: 50 });
      const nbaSignals = recentPlays
        .filter((p: any) => p.sport === "nba" && p.prob)
        .map((p: any) => ({
          playerId: p.playerId,
          playerName: p.playerName,
          market: p.market,
          enginePct: parseFloat(String(p.prob)),
          edge: p.edgeGap ? parseFloat(String(p.edgeGap)) : 0,
          bookLine: p.line ? parseFloat(String(p.line)) : null,
          projection: p.projection ? parseFloat(String(p.projection)) : null,
          recommendedSide: p.direction?.toUpperCase() ?? "OVER",
          gameId: p.gameId,
          updatedAt: p.timestamp?.toISOString() ?? new Date().toISOString(),
        }));

      const ncaabStorageSignals = recentPlays
        .filter((p: any) => p.sport === "ncaab" && p.prob)
        .map((p: any) => ({
          gameId: p.gameId,
          teamName: p.playerName ?? p.team ?? "NCAAB",
          market: p.market,
          probability: parseFloat(String(p.prob)),
          edge: p.edgeGap ? parseFloat(String(p.edgeGap)) : 0,
          line: p.line ? parseFloat(String(p.line)) : null,
          projection: p.projection ? parseFloat(String(p.projection)) : null,
          side: p.direction?.toUpperCase() ?? "OVER",
          updatedAt: p.timestamp?.toISOString() ?? new Date().toISOString(),
        }));

      const NCAAB_FRESHNESS_MS = 120_000;
      const ncaabLive = (Date.now() - ncaabLiveSignals.updatedAt < NCAAB_FRESHNESS_MS) ? ncaabLiveSignals.signals : [];
      const ncaabSeenKeys = new Set(ncaabLive.map((s: any) => `${s.gameId}_${s.market}`));
      const ncaabSignals = [
        ...ncaabLive,
        ...ncaabStorageSignals.filter((s: any) => !ncaabSeenKeys.has(`${s.gameId}_${s.market}`)),
      ];

      const plays = buildTopPlays(nbaSignals, ncaabSignals, mlbSignals, 10);
      return res.json({ plays });
    } catch (e: any) {
      console.error("[top-plays]", e.message);
      // Return a real error (not 200 {plays:[]}) so the client can distinguish
      // a backend failure from a genuinely empty slate and surface a retry.
      return res.status(500).json({ error: "Failed to load top plays" });
    }
  });

  // Task #134 — Free user activation rail event sink.
  // requireAuth is used because the FreeActivationRail / PublicProofStrip
  // surface is only rendered to logged-in free users today. Validation
  // failures return 400 with the issue list; the client helper
  // (`trackRailEvent`) is fire-and-forget and swallows errors so a stray
  // payload never breaks the page render.
  app.post("/api/analytics/rail-event", requireAuth, async (req, res) => {
    try {
      const { railEventClientSchema } = await import("@shared/schema");
      const parsed = railEventClientSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid rail event payload", issues: parsed.error.issues });
      }
      const userId = (req as any).resolvedUserId ?? null;
      await storage.recordRailEvent({
        userId,
        eventType: parsed.data.eventType,
        exhausted: parsed.data.exhausted ?? null,
        playsUsedToday: parsed.data.playsUsedToday ?? null,
        playsLimit: parsed.data.playsLimit ?? null,
      });
      return res.json({ ok: true });
    } catch (e: any) {
      console.error("[rail-event]", e?.message);
      return res.status(500).json({ message: "Failed to record rail event" });
    }
  });

  app.get("/api/admin/rail-analytics", requireAdmin, async (req, res) => {
    try {
      const range = parseInt(String(req.query.range ?? "7"), 10);
      const stats = await storage.getRailEventStats(Number.isFinite(range) ? range : 7);
      return res.json(stats);
    } catch (e: any) {
      console.error("[admin/rail-analytics]", e?.message);
      return res.status(500).json({ message: "Failed to load rail analytics" });
    }
  });

  app.get("/api/public-analytics/summary", async (_req, res) => {
    try {
      const { getPublicAnalyticsSummary } = await import("./services/publicAnalyticsService");
      // Public response — admin-only calibration diagnostics
      // (highBucketWarning / overconfidenceDelta) are stripped by default.
      const summary = await getPublicAnalyticsSummary();
      return res.json(summary);
    } catch (e: any) {
      console.error("[public-analytics]", e.message);
      return res.json({
        last7Days: { winRate: 0, roi: 0, plays: 0 },
        bySport: [],
        recentResults: [],
      });
    }
  });

  // Admin-gated variant — includes NBA Calibration v2 high-bucket warning
  // and overconfidence delta for internal calibration monitoring. Same
  // data shape as the public summary, plus the admin-only fields.
  app.get("/api/admin/analytics/summary", requireAdmin, async (_req, res) => {
    try {
      const { getPublicAnalyticsSummary } = await import("./services/publicAnalyticsService");
      const summary = await getPublicAnalyticsSummary({ admin: true });
      return res.json(summary);
    } catch (e: any) {
      console.error("[admin/analytics-summary]", e.message);
      return res.status(500).json({ error: "Failed to load admin analytics summary" });
    }
  });

  app.get("/api/live-signal-counts", requireAuth, async (_req, res) => {
    try {
      let nbaElite = 0, ncaabElite = 0, mlbElite = 0, totalLive = 0;

      for (const [, entry] of Array.from(mlbEdgeCache.entries())) {
        // Two-axis freshness — match the bettable edge-feed window (20m)
        // so badge counts stay consistent with what the feed actually shows.
        const FRESHNESS_MS = 20 * 60 * 1000;
        if (!isMLBEdgeEntryFresh(entry, FRESHNESS_MS)) continue;
        const qs = entry.qualifiedSignals ?? [];
        for (const sig of qs) {
          totalLive++;
          // [MLB Canonical Signal Tier — Phase 2] Prefer the orchestrator-stamped
          // canonical signalTier ("elite" | "strong" => high-confidence MLB row).
          // Fall back to the legacy uppercase confidenceTier mapping so older
          // cache entries written before the stamp shipped still count correctly.
          const tier = (sig as any).signalTier as string | undefined;
          const isHighConfidence = tier
            ? (tier === "elite" || tier === "strong")
            : (sig.confidenceTier === "ELITE" || sig.confidenceTier === "STRONG");
          if (isHighConfidence) mlbElite++;
        }
      }

      const today = todayET();
      const { plays: recentPlays } = await storage.getPlays({ date: today, settled: "pending", limit: 200 });
      for (const p of recentPlays) {
        const prob = p.prob ? parseFloat(String(p.prob)) : 0;
        totalLive++;
        if (p.sport === "nba" && prob >= 75) nbaElite++;
        if (p.sport === "ncaab" && prob >= 75) ncaabElite++;
        if (p.sport === "mlb" && prob >= 65) mlbElite++;
      }

      return res.json({ nbaElite, ncaabElite, mlbElite, totalLive });
    } catch (e: any) {
      console.error("[live-signal-counts]", e.message);
      return res.json({ nbaElite: 0, ncaabElite: 0, mlbElite: 0, totalLive: 0 });
    }
  });

  // - It must NEVER reimplement, recompute, or approximate any helper logic
  //   from the production signal evaluation path (routes.ts live-signals /
  //   halftime handler, or storage.ts calculateProbability).
  // - Direction classification here must mirror the production rule exactly:
  //   probability > 50 → OVER, probability < 50 → UNDER, probability === 50 → excluded.
  // - Any future change to signal evaluation logic must update BOTH the production
  //   handler and this endpoint simultaneously to prevent audit drift.
  app.get("/api/analytics/nba-audit", requireAdmin, async (_req, res) => {
    try {
      const { calcLogEntries } = await import("./storage");
      const entries = [...calcLogEntries];

      // ── Section A: Directional pipeline trace — 5 UNDER plays ──────────
      // For each UNDER play, log the probability as returned (response),
      // the edge raw (model edge), the probability as persisted (same value),
      // and the persisted edge (|probability - 50|).
      // Mismatch = direction label disagrees with probability position.
      // Entries with probability === 50 are excluded (zero-edge, NO_SIGNAL —
      // they should not be in calcLogEntries at all per the calc log contract).
      const underEntries = entries.filter(e => e.direction === "UNDER" && e.probability !== 50);
      const tracePlays = underEntries.slice(-5);
      const pipelineTrace = tracePlays.map(e => {
        const responseProbability = e.probability;
        const edgeInputProbability = e.edgeRaw;
        const persistedProbability = e.probability;
        const persistedEdge = Math.abs(e.probability - 50);
        // DIRECTION CONTRACT: strict > 50 / < 50 — probability === 50 is excluded above.
        const mismatch: "YES" | "NO" =
          (e.direction === "UNDER" && e.probability > 50) ||
          (e.direction === "OVER" && e.probability < 50)
            ? "YES" : "NO";
        return {
          player: e.player,
          direction: "UNDER",
          responseProbability,
          edgeInputProbability,
          persistedProbability,
          persistedEdge,
          noSignal: e.noSignal,
          mismatch,
          archetype: e.archetype,
          avgMinutes: e.avgMinutes,
          warnings: e.warnings ?? [],
          bookImplied: e.bookImplied,
          edgeVsBook: e.edgeVsBook,
        };
      });

      for (const t of pipelineTrace) {
        console.log(`[NBA-AUDIT] Player: ${t.player}`);
        console.log(`[NBA-AUDIT] Direction: UNDER`);
        console.log(`[NBA-AUDIT] Response probability: ${t.responseProbability}`);
        console.log(`[NBA-AUDIT] Edge input probability: ${t.edgeInputProbability}`);
        console.log(`[NBA-AUDIT] Persisted probability: ${t.persistedProbability}`);
        console.log(`[NBA-AUDIT] Persisted edge: ${t.persistedEdge}`);
        console.log(`[NBA-AUDIT] noSignal: ${t.noSignal}`);
        console.log(`[NBA-AUDIT] Mismatch: ${t.mismatch}`);
      }
      const mismatchFound = pipelineTrace.some(t => t.mismatch === "YES");

      // ── Section B: Full audit object from persisted plays ───────────────
      // Win rates, archetype win rates, probability bucket accuracy, and miss
      // breakdown are computed from the persisted_plays table (settled plays only).
      const gradedPlays = await storage.getGradedPlaysForCalibration({ sport: "nba" });

      const settledNBA = gradedPlays.filter(p => p.result === "hit" || p.result === "miss");
      const nbaHits   = settledNBA.filter(p => p.result === "hit").length;
      const nbaTotal  = settledNBA.length;
      const overallWinRate = nbaTotal > 0 ? Math.round((nbaHits / nbaTotal) * 1000) / 10 : 0;

      const overPlays  = settledNBA.filter(p => p.direction === "over");
      const underPlays = settledNBA.filter(p => p.direction === "under");
      const overWinRate = overPlays.length > 0
        ? Math.round((overPlays.filter(p => p.result === "hit").length / overPlays.length) * 1000) / 10 : 0;
      const underWinRate = underPlays.length > 0
        ? Math.round((underPlays.filter(p => p.result === "hit").length / underPlays.length) * 1000) / 10 : 0;
      const underRate = nbaTotal > 0 ? Math.round((underPlays.length / nbaTotal) * 1000) / 10 : 0;
      const overRate  = nbaTotal > 0 ? Math.round((overPlays.length / nbaTotal) * 1000) / 10 : 0;

      // Probability bucket accuracy from persisted plays
      const persistedBucket = (label: string, minP: number, maxP: number) => {
        const inBucket = settledNBA.filter(p => {
          const prob = Number(p.prob);
          const conf = p.direction === "over" ? prob : 100 - prob;
          return conf >= minP && conf <= maxP;
        });
        const hits = inBucket.filter(p => p.result === "hit").length;
        const total = inBucket.length;
        const winRate = total > 0 ? Math.round((hits / total) * 1000) / 10 : 0;
        return { label, total, hits, winRate };
      }
      const probabilityBuckets = [
        persistedBucket("60-64", 60, 64.99),
        persistedBucket("65-69", 65, 69.99),
        persistedBucket("70-74", 70, 74.99),
        persistedBucket("75-79", 75, 79.99),
        persistedBucket("80+", 80, 100),
      ];

      // Miss breakdown — from persisted plays (categories approximated from edge data)
      const misses = settledNBA.filter(p => p.result === "miss");
      const volatileMisses   = misses.filter(p => p.edgeGap != null && Number(p.edgeGap) >= 20).length;
      const superstarssMisses = misses.filter(p => p.edgeGap != null && Number(p.prob) >= 75 && p.direction === "under").length;
      const blowoutMisses    = misses.filter(p => p.edgeGap != null && Number(p.edgeGap) < 10).length;
      const standardMisses   = misses.length - volatileMisses - superstarssMisses - blowoutMisses;

      // Archetype win rates — join persisted plays to player avgMinutes to classify
      const allPlayers = await storage.getPlayers();
      const playerMinutesMap = new Map<string, number>();
      for (const p of allPlayers) {
        if (p.id != null && p.avgMinutes != null) {
          playerMinutesMap.set(String(p.id), Number(p.avgMinutes));
        }
      }
      const classifyArchetypeForAudit = (mins: number): string => {
        if (mins >= 32) return "superstar";
        if (mins >= 26) return "primary";
        if (mins >= 20) return "role";
        if (mins >= 15) return "rotation";
        return "volatile";
      }
      type Archetype = "superstar" | "primary" | "role" | "rotation" | "volatile";
      const archetypes: Archetype[] = ["superstar", "primary", "role", "rotation", "volatile"];
      const archetypeStats: Record<string, { total: number; hits: number; misses: number; winRate: number }> = {};
      for (const arch of archetypes) {
        const archPlays = settledNBA.filter(p => {
          const mins = p.playerId ? playerMinutesMap.get(String(p.playerId)) : undefined;
          if (mins == null) return false;
          return classifyArchetypeForAudit(mins) === arch;
        });
        const hits = archPlays.filter(p => p.result === "hit").length;
        const total = archPlays.length;
        archetypeStats[arch] = {
          total,
          hits,
          misses: total - hits,
          winRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0,
        };
      }

      // ── Section D: Post-filter results summary ──────────────────────────
      const totalEntries = entries.length;
      const noSignalTotal                  = entries.filter(e => e.noSignal).length;
      const projectionMismatchCount        = entries.filter(e => (e.warnings ?? []).includes("direction_projection_mismatch")).length;

      const audit = {
        meta: {
          totalCalcLogEntries: totalEntries,
          totalPersistedNBAPlays: nbaTotal,
          snapshotTime: new Date().toISOString(),
        },
        plumbingAudit: {
          mismatchFound,
          scenario: mismatchFound ? "Scenario 1 (Plumbing mismatch detected)" : "Scenario 2 (No mismatch)",
          finding: mismatchFound
            ? "At least one UNDER play shows edgeRaw > 0 (model favours OVER) but direction is UNDER — directional inversion detected."
            : "All three values (response probability, edge input probability, persisted probability) flow from the same finalProbability. No directional inversion detected.",
        },
        directionalSplit: {
          underRate, overRate,
          underCount: underPlays.length, overCount: overPlays.length,
          underWinRate, overWinRate, overallWinRate,
        },
        archetypeWinRates: archetypeStats,
        probabilityBuckets,
        missBreakdown: {
          total: misses.length,
          volatile: volatileMisses,
          superstar: superstarssMisses,
          blowout: blowoutMisses,
          standard: Math.max(0, standardMisses),
        },
        postFilterSummary: {
          noSignalTotal,
          projectionMismatch: projectionMismatchCount,
        },
        pipelineTrace,
      };

      return res.json(audit);
    } catch (e: any) {
      console.error("[nba-audit]", e.message);
      return res.status(500).json({ error: "Audit failed", details: e.message });
    }
  });

  app.get("/api/analytics/confidence-buckets", requireAdmin, async (req, res) => {
    try {
      const { sport, direction, marketType, archetype: archFilter, flagship, startDate, endDate } = req.query as Record<string, string>;
      const gradedPlays = await storage.getGradedPlaysForCalibration({
        sport: sport || "nba",
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      let settled = gradedPlays.filter(p => p.result === "hit" || p.result === "miss" || p.result === "push");
      if (direction) settled = settled.filter(p => p.direction === direction);
      if (marketType) {
        const combos = ["pts_reb", "pts_ast", "reb_ast", "pts_reb_ast"];
        if (marketType === "single") settled = settled.filter(p => !combos.includes(p.market));
        else if (marketType === "combo") settled = settled.filter(p => combos.includes(p.market));
      }
      if (archFilter) settled = settled.filter(p => (p as any).archetype === archFilter);
      if (flagship === "flagship") settled = settled.filter(p => (p as any).flagshipOrDerivative === "flagship");
      if (flagship === "derivative") settled = settled.filter(p => (p as any).flagshipOrDerivative === "derivative");

      // Analytics scope for MLB calibration. Defaults to "primary" so the
      // confidence-bucket dashboard reflects the headline lane (excludes
      // home_runs + batter_strikeouts). Admin can pass ?scope=hr_radar or
      // ?scope=experimental to inspect the side lanes; ?scope=full keeps
      // everything (legacy behaviour).
      const sportLowerScope = (sport || "nba").toLowerCase();
      const isMlbScope = sportLowerScope === "mlb";
      const scopeRaw = String((req.query as any).scope ?? "primary").toLowerCase();
      // Legacy "experimental"/"experimental_mlb" scope collapsed onto "full" —
      // batter_strikeouts is deprecated and no longer has a dedicated lane.
      const analyticsScope: "primary_mlb_roi" | "hr_radar" | "full" =
        scopeRaw === "hr_radar" ? "hr_radar"
        : scopeRaw === "full" || scopeRaw === "experimental" || scopeRaw === "experimental_mlb" ? "full"
        : "primary_mlb_roi";
      if (isMlbScope) {
        const {
          PRIMARY_MLB_ROI_MARKETS,
          EXCLUDED_FROM_PRIMARY_MLB_ROI,
          HR_RADAR_ANALYTICS_MARKETS,
          filterPrimaryMlbRoiPlays,
          logAnalyticsQuery,
        } = await import("./analytics/mlbMarketGroups");
        const beforeCount = settled.length;
        if (analyticsScope === "primary_mlb_roi") {
          settled = filterPrimaryMlbRoiPlays(settled);
        } else if (analyticsScope === "hr_radar") {
          settled = settled.filter((p: any) => HR_RADAR_ANALYTICS_MARKETS.includes(p.market));
        }
        logAnalyticsQuery({
          surface: "/api/analytics/confidence-buckets",
          sport: "mlb",
          analyticsScope,
          includedMarkets:
            analyticsScope === "primary_mlb_roi" ? PRIMARY_MLB_ROI_MARKETS
            : analyticsScope === "hr_radar" ? HR_RADAR_ANALYTICS_MARKETS
            : [],
          excludedMarkets:
            analyticsScope === "primary_mlb_roi" ? EXCLUDED_FROM_PRIMARY_MLB_ROI : [],
          totalPlays: beforeCount,
          retainedPlays: settled.length,
        });
      }

      const bucketRanges = [
        { label: "60-64", min: 60, max: 64.99 },
        { label: "65-69", min: 65, max: 69.99 },
        { label: "70-74", min: 70, max: 74.99 },
        { label: "75-79", min: 75, max: 79.99 },
        { label: "80+", min: 80, max: 100 },
      ];
      // [MLB Canonical Probability v1] For MLB, persisted_plays.prob IS the
      // recommended-side calibrated probability — i.e. the operator's confidence
      // in the recommended side. Bucketing by `prob` directly is the canonical
      // path; the historical `100 - prob` flip for UNDER plays would re-apply
      // dominant-probability semantics (forbidden by spec). NBA/NCAAB still
      // persist dominant probability, so they keep the legacy transform.
      const sportLower = (sport || "nba").toLowerCase();
      const isMlbView = sportLower === "mlb";
      const buckets = bucketRanges.map(({ label, min, max }) => {
        const inBucket = settled.filter(p => {
          const prob = Number(p.prob);
          const conf = isMlbView
            ? prob
            : (p.direction === "over" ? prob : 100 - prob);
          return conf >= min && conf <= max;
        });
        const wins = inBucket.filter(p => p.result === "hit").length;
        const losses = inBucket.filter(p => p.result === "miss").length;
        const pushes = inBucket.filter(p => p.result === "push").length;
        const total = inBucket.length;
        const winRate = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0;
        return { label, total, wins, losses, pushes, winRate };
      });
      if (isMlbView) {
        console.log("[MLB_ANALYTICS_PROBABILITY_SEMANTICS]", {
          source: "persisted_plays",
          probabilitySemantics: "recommended_side_calibrated",
          route: "/api/analytics/confidence-buckets",
          mlbPlays: settled.length,
        });
      }
      return res.json({
        buckets,
        probabilitySemantics: isMlbView ? "recommended_side_calibrated" : "dominant_over_oriented",
        filters: { sport: sport || "nba", direction: direction || "all", marketType: marketType || "all", archetype: archFilter || "all", flagship: flagship || "all" },
        analyticsScope: isMlbView ? analyticsScope : "full",
        excludedMarkets: isMlbView && analyticsScope === "primary_mlb_roi"
          ? Array.from((await import("./analytics/mlbMarketGroups")).EXCLUDED_FROM_PRIMARY_MLB_ROI)
          : [],
      });
    } catch (e: any) {
      return res.status(500).json({ error: "Confidence buckets failed", details: e.message });
    }
  });

  app.get("/api/analytics/calibration-views", requireAdmin, async (req, res) => {
    try {
      const { sport, startDate, endDate, view } = req.query as Record<string, string>;
      const gradedPlays = await storage.getGradedPlaysForCalibration({
        sport: sport || "nba",
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });
      const settled = gradedPlays.filter(p => p.result === "hit" || p.result === "miss" || p.result === "push");

      const viewMode = view || "row";

      if (viewMode === "row") {
        const rows = settled.map(p => ({
          id: p.id,
          player: p.playerName,
          market: p.market,
          direction: p.direction,
          line: Number(p.line),
          prob: Number(p.prob),
          result: p.result,
          finalStat: p.finalStat != null ? Number(p.finalStat) : null,
          gameDate: p.gameDate,
          archetype: (p as any).archetype ?? null,
          flagshipOrDerivative: (p as any).flagshipOrDerivative ?? null,
          familyId: (p as any).familyId ?? null,
          calibrationTrack: (p as any).calibrationTrack ?? null,
        }));
        return res.json({ view: "row", total: rows.length, rows });
      }

      if (viewMode === "player-game") {
        const pgMap = new Map<string, { player: string; gameId: string; gameDate: string; plays: number; wins: number; losses: number; pushes: number }>();
        for (const p of settled) {
          const key = `${p.playerName}|${p.gameId}`;
          if (!pgMap.has(key)) pgMap.set(key, { player: p.playerName, gameId: p.gameId, gameDate: p.gameDate, plays: 0, wins: 0, losses: 0, pushes: 0 });
          const entry = pgMap.get(key)!;
          entry.plays++;
          if (p.result === "hit") entry.wins++;
          else if (p.result === "miss") entry.losses++;
          else entry.pushes++;
        }
        const rows = Array.from(pgMap.values()).map(e => ({
          ...e,
          winRate: e.plays > 0 ? Math.round((e.wins / e.plays) * 1000) / 10 : 0,
        }));
        return res.json({ view: "player-game", total: rows.length, rows });
      }

      if (viewMode === "market-family") {
        const fMap = new Map<string, { player: string; gameId: string; familyId: string; direction: string; markets: string[]; plays: number; wins: number; losses: number; pushes: number }>();
        for (const p of settled) {
          const fid = (p as any).familyId || `${p.playerName}|${p.gameId}|${p.direction}`;
          if (!fMap.has(fid)) fMap.set(fid, { player: p.playerName, gameId: p.gameId, familyId: fid, direction: p.direction, markets: [], plays: 0, wins: 0, losses: 0, pushes: 0 });
          const entry = fMap.get(fid)!;
          if (!entry.markets.includes(p.market)) entry.markets.push(p.market);
          entry.plays++;
          if (p.result === "hit") entry.wins++;
          else if (p.result === "miss") entry.losses++;
          else entry.pushes++;
        }
        const rows = Array.from(fMap.values()).map(e => ({
          ...e,
          winRate: e.plays > 0 ? Math.round((e.wins / e.plays) * 1000) / 10 : 0,
        }));
        return res.json({ view: "market-family", total: rows.length, rows });
      }

      return res.status(400).json({ error: "Invalid view parameter. Use: row, player-game, or market-family" });
    } catch (e: any) {
      return res.status(500).json({ error: "Calibration views failed", details: e.message });
    }
  });

  app.get("/api/analytics/summary", requireAdmin, async (req, res) => {
    try {
      const range = (req.query.range as string) || "all";
      const leagueRaw = ((req.query.league as string) || "NBA").toUpperCase();
      const league = ["NBA", "MLB", "NCAAB"].includes(leagueRaw) ? leagueRaw : "NBA";
      const sport = league.toLowerCase();

      let startDate: string | undefined;
      if (range === "7d") {
        startDate = daysAgoET(7);
      } else if (range === "30d") {
        startDate = daysAgoET(30);
      } else if (range === "today") {
        startDate = todayET();
      }

      const [settled, recentResult] = await Promise.all([
        storage.getGradedPlaysForCalibration({ sport, startDate }),
        storage.getPlays({ sport, limit: 20 }),
      ]);

      const hits = settled.filter((p) => p.result === "hit").length;
      const total = settled.length;
      const winRate = total > 0 ? Math.round((hits / total) * 1000) / 10 : 0;
      // [PRIMARY ROI EXCLUSION v1] Headline `roi` excludes home_runs +
      // batter_strikeouts (Core Engine ROI); `roiFull` keeps everything for
      // admin observability. Both use the canonical roiEngine helpers (per-play
      // odds, -110 fallback only when missing) — replaces the prior inline
      // flat-vig calc which assumed every play was -110.
      const { getPrimaryROIMetrics, getROIMetrics, logRoiFilterApplied, filterPrimaryRoiPlays } = await import("./services/roiEngine");
      const settledForRoi = settled as unknown as PersistedPlay[];
      const primaryPlays = filterPrimaryRoiPlays(settledForRoi);
      logRoiFilterApplied({
        surface: `analytics.summary.${league}.${range}`,
        totalPlays: settledForRoi.length,
        primaryPlays: primaryPlays.length,
      });
      const roi = getPrimaryROIMetrics(settledForRoi).roi;
      const roiFull = getROIMetrics(settledForRoi).roi;
      const primaryHits = primaryPlays.filter((p) => p.result === "hit").length;
      const primaryWinRate = primaryPlays.length > 0
        ? Math.round((primaryHits / primaryPlays.length) * 1000) / 10
        : 0;

      const pending = recentResult.plays.filter((p) => p.result === null).length;

      const overPlays = settled.filter((p) => p.direction === "over");
      const underPlays = settled.filter((p) => p.direction === "under");
      const overWinRate = overPlays.length > 0
        ? Math.round((overPlays.filter((p) => p.result === "hit").length / overPlays.length) * 1000) / 10 : 0;
      const underWinRate = underPlays.length > 0
        ? Math.round((underPlays.filter((p) => p.result === "hit").length / underPlays.length) * 1000) / 10 : 0;

      res.json({
        league,
        range,
        winRate,
        primaryWinRate,
        totalSettled: total,
        totalSettledPrimary: primaryPlays.length,
        totalHits: hits,
        roi,
        roiFull,
        excludedFromPrimary: ["home_runs", "batter_strikeouts"],
        pending,
        overWinRate,
        underWinRate,
        recentPlays: recentResult.plays.slice(0, 20).map((p) => ({
          id: p.id,
          playerName: p.playerName,
          team: p.team,
          market: p.market,
          direction: p.direction,
          line: p.line,
          prob: p.prob,
          gameDate: p.gameDate,
          result: p.result,
          finalStat: p.finalStat,
        })),
      });
    } catch (e) {
      res.status(500).json({ message: "Failed to load analytics summary" });
    }
  });

  app.get("/api/analytics/alerts", requireAdmin, async (_req, res) => {
    try {
      const alerts = await storage.getRecentPlayAlerts(100);
      res.json({ alerts });
    } catch (e) {
      res.status(500).json({ message: "Failed to load analytics alerts" });
    }
  });

  app.get("/api/analytics/verify", requireAdmin, async (_req, res) => {
    try {
      const [summary, unresolved, nbaResult, ncaabResult, mlbResult] = await Promise.all([
        storage.getAnalyticsSummary("all"),
        storage.getUnresolvedAlerts(),
        storage.getPlays({ sport: "nba", limit: 500 }),
        storage.getPlays({ sport: "ncaab", limit: 500 }),
        storage.getPlays({ sport: "mlb", limit: 500 }),
      ]);

      const rawTotal = summary?.totalPlays;
      const totalRecords = Number.isFinite(rawTotal) && rawTotal != null ? rawTotal : 0;

      const rawUnresolved = unresolved?.length;
      const unresolvedAlerts = Number.isFinite(rawUnresolved) && rawUnresolved != null ? rawUnresolved : 0;

      const rawNba = nbaResult?.total;
      const rawNcaab = ncaabResult?.total;
      const rawMlb = mlbResult?.total;
      const bySport: { nba: number; ncaab: number; mlb: number } = {
        nba: Number.isFinite(rawNba) && rawNba != null ? rawNba : 0,
        ncaab: Number.isFinite(rawNcaab) && rawNcaab != null ? rawNcaab : 0,
        mlb: Number.isFinite(rawMlb) && rawMlb != null ? rawMlb : 0,
      };

      res.json({ totalRecords, bySport, unresolvedAlerts });
    } catch (e) {
      res.status(500).json({ message: "Failed to load analytics verification" });
    }
  });

  // Manual settle: trigger autoResolveAlerts on-demand and return count
  app.post("/api/analytics/settle", requireAdmin, async (_req, res) => {
    try {
      const before = await storage.getUnresolvedAlerts();
      await autoResolveAlerts(storage);
      const after  = await storage.getUnresolvedAlerts();
      const settled = Math.max(0, before.length - after.length);
      const stillPending = after.length;
      res.json({ settled, stillPending });
    } catch (e) {
      res.status(500).json({ message: "Settle failed", error: (e as any).message });
    }
  });

  app.post("/api/admin/mlb/grade", requireAdmin, async (_req, res) => {
    try {
      const result = await gradePersistedPlays(storage);
      res.json({ ...result, triggeredAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: "MLB grading failed", details: e.message });
    }
  });

  // Manual backstop for the daily 04:30 ET slate-reset cron. Sweeps every
  // gameId-keyed in-memory cache in the MLB pipeline whose game is no longer
  // in the live registry. Use this if the user reports MLB signals or HR
  // Radar are stuck/stale and the morning cron didn't fire.
  app.post("/api/admin/mlb/reset-slate-state", requireAdmin, async (_req, res) => {
    try {
      const { pruneStaleSlateMemory } = await import("./mlb/liveGameOrchestrator");
      const result = await pruneStaleSlateMemory("admin_manual_trigger");
      res.json({ ...result, triggeredAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: "MLB slate reset failed", details: e.message });
    }
  });

  app.post("/api/admin/mlb/clean-duplicates", requireAdmin, async (_req, res) => {
    try {
      const result = await storage.cleanDuplicatePlays();
      res.json({ ...result, triggeredAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: "Duplicate cleanup failed", details: e.message });
    }
  });

  app.get("/api/admin/mlb/grading-summary", requireAdmin, async (req, res) => {
    try {
      const range = (req.query.range as string) || "7d";
      let startDate: string | undefined;
      if (range === "7d") { startDate = daysAgoET(7); }
      else if (range === "30d") { startDate = daysAgoET(30); }
      else if (range === "today") { startDate = todayET(); }

      const [graded, pendingResult] = await Promise.all([
        storage.getGradedPlaysForCalibration({ sport: "mlb", startDate }),
        storage.getPlays({ sport: "mlb", settled: "pending", limit: 500 }),
      ]);

      const hits = graded.filter(p => p.result === "hit").length;
      const misses = graded.filter(p => p.result === "miss").length;
      const pushes = graded.filter(p => p.result === "push").length;
      const decided = hits + misses;
      const winRate = decided > 0 ? Math.round((hits / decided) * 1000) / 10 : 0;
      // Audit finding 1.4: canonical roiEngine helper (per-play odds, -110
      // fallback only when odds missing). Was previously hardcoded
      // `hits * 0.909 - misses` which assumed every play priced at -110.
      const roi = getROIMetrics(graded).roi;

      const byMarket = new Map<string, { wins: number; losses: number; pushes: number; total: number }>();
      for (const p of graded) {
        const m = p.market || "unknown";
        if (!byMarket.has(m)) byMarket.set(m, { wins: 0, losses: 0, pushes: 0, total: 0 });
        const e = byMarket.get(m)!;
        e.total++;
        if (p.result === "hit") e.wins++;
        else if (p.result === "miss") e.losses++;
        else e.pushes++;
      }

      const byDirection = { over: { wins: 0, losses: 0, total: 0 }, under: { wins: 0, losses: 0, total: 0 } };
      for (const p of graded) {
        const dir = (p.direction ?? "").toLowerCase() as "over" | "under";
        if (dir !== "over" && dir !== "under") continue;
        byDirection[dir].total++;
        if (p.result === "hit") byDirection[dir].wins++;
        else if (p.result === "miss") byDirection[dir].losses++;
      }

      const recentGraded = graded.slice(0, 20).map(p => ({
        id: p.id,
        player: p.playerName,
        market: p.market,
        direction: p.direction,
        line: Number(p.line),
        prob: p.prob ? parseFloat(String(p.prob)) : 0,
        result: p.result,
        finalStat: p.finalStat != null ? parseFloat(String(p.finalStat)) : null,
        gameDate: p.gameDate,
        settledAt: p.settledAt?.toISOString() ?? null,
      }));

      res.json({
        range,
        totalGraded: graded.length,
        pending: pendingResult.plays.length,
        hits, misses, pushes, winRate, roi,
        byMarket: Object.fromEntries(Array.from(byMarket.entries()).map(([m, d]) => {
          const dec = d.wins + d.losses;
          return [m, { ...d, winRate: dec > 0 ? Math.round((d.wins / dec) * 1000) / 10 : 0 }];
        })),
        byDirection: {
          over: { ...byDirection.over, winRate: byDirection.over.total > 0 ? Math.round((byDirection.over.wins / (byDirection.over.wins + byDirection.over.losses || 1)) * 1000) / 10 : 0 },
          under: { ...byDirection.under, winRate: byDirection.under.total > 0 ? Math.round((byDirection.under.wins / (byDirection.under.wins + byDirection.under.losses || 1)) * 1000) / 10 : 0 },
        },
        recentGraded,
      });
    } catch (e: any) {
      res.status(500).json({ error: "MLB grading summary failed", details: e.message });
    }
  });

  // ── Engine Debug + Observability Endpoints ────────────────────────────────────
  // Returns in-memory engine run stats, quota/cache status, and signal counts.
  // Available only to admin users.

  app.get("/api/debug/nba", requireAdmin, (_req, res) => {
    try {
      const summary = getEngineDebugSummary("nba");
      res.json({
        sport: "nba",
        engine: "NBA",
        engineIsolation: true,
        engineWrapper: "server/engines/nba/index.ts",
        model: "regression-based, edge threshold, low-frequency",
        ...summary,
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/debug/ncaab", requireAdmin, (_req, res) => {
    try {
      const summary = getEngineDebugSummary("ncaab");
      res.json({
        sport: "ncaab",
        ...summary,
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/debug/mlb", requireAdmin, async (_req, res) => {
    try {
      const summary = getEngineDebugSummary("mlb");
      const mlbDiag = getMLBDiagnosticSummary();
      res.json({
        sport: "mlb",
        engine: "MLB",
        engineIsolation: true,
        engineWrapper: "server/engines/mlb/index.ts",
        model: "contact-based, event-driven, high-frequency",
        ...summary,
        mlbDiagnostics: mlbDiag,
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/debug/reset/:sport", requireAdmin, (req, res) => {
    const sport = req.params.sport as "nba" | "ncaab" | "mlb";
    if (!["nba", "ncaab", "mlb"].includes(sport)) {
      return res.status(400).json({ error: "Invalid sport — must be nba, ncaab, or mlb" });
    }
    resetEngineStats(sport);
    res.json({ reset: true, sport, resetAt: new Date().toISOString() });
  });

  app.get("/api/debug/nba/validate", requireAdmin, async (_req, res) => {
    try {
      const { runNBAValidation, formatValidationReport } = await import("./validation/nba/harness");
      const result = runNBAValidation();
      const report = formatValidationReport(result);
      console.log("[NBA_VALIDATION_HARNESS]\n" + report);
      res.json({
        ...result,
        report,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/debug/data-health", requireAdmin, (_req, res) => {
    const health = getDataHealth();
    const keyStatus = getOddsKeyStatus();
    res.json({
      ...health,
      oddsKeyStatus: {
        totalKeys: keyStatus.totalKeys,
        activeKeyIndex: keyStatus.activeKeyIndex,
        exhaustedKeys: keyStatus.exhaustedKeys,
        allKeysHealthy: keyStatus.exhaustedKeys.length === 0,
      },
    });
  });

  app.get("/api/debug/engine-isolation", requireAdmin, (_req, res) => {
    try {
      const nbaStats = getEngineDebugSummary("nba");
      const mlbStats = getEngineDebugSummary("mlb");

      const nbaSharedImports: string[] = [];
      const mlbSharedImports: string[] = [];

      const isolation = {
        status: "ACTIVE",
        version: "v1.0",
        engines: {
          nba: {
            wrapper: "server/engines/nba/index.ts",
            validation: "server/engines/nba/validation.ts",
            types: "server/engines/nba/types.ts",
            spec: "docs/agents/nba-agent.md",
            model: "regression-based, edge threshold, low-frequency",
            confidenceTiers: ["low", "medium", "high"],
            sharedImportsDetected: nbaSharedImports,
            isolated: nbaSharedImports.length === 0,
            lastRun: nbaStats,
          },
          mlb: {
            wrapper: "server/engines/mlb/index.ts",
            validation: "server/engines/mlb/validation.ts",
            types: "server/engines/mlb/types.ts",
            spec: "docs/agents/mlb-agent.md",
            model: "contact-based, event-driven, high-frequency",
            confidenceTiers: ["developing", "strong", "elite"],
            sharedImportsDetected: mlbSharedImports,
            isolated: mlbSharedImports.length === 0,
            lastRun: mlbStats,
          },
        },
        crossContamination: {
          detected: false,
          sharedServicesStillUsed: ["NCAAB only (not isolated yet)"],
          nbaUsesSharedFilters: false,
          mlbUsesSharedFilters: false,
        },
        generatedAt: new Date().toISOString(),
      };

      res.json(isolation);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/debug/odds/normalize", requireAdmin, async (req, res) => {
    try {
      const line = parseFloat(String(req.query.line ?? "0"));
      const overOdds = parseFloat(String(req.query.overOdds ?? "-110"));
      const underOdds = parseFloat(String(req.query.underOdds ?? "-110"));
      const sampleBooks = {
        draftkings: { line, overOdds, underOdds },
        fanduel: { line: line + 0.5, overOdds, underOdds },
        hardrockbet: { line: line - 0.5, overOdds, underOdds },
      };
      const normalized = normalizeOdds(sampleBooks);
      res.json({ input: sampleBooks, normalized });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
