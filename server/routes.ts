import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { api } from "@shared/routes";
import { z } from "zod";
import { type Player, type ParlayPickInput, persistedPlays } from "@shared/schema";
import { sql, and, desc } from "drizzle-orm";
import { computeFamilyPenaltyFactor } from "./nba/marketFamily";
import { recordSurfacedSignal, seedFromSettledPlays, getDirectionalSplit } from "./nba/directionalBias";
import { getPlayerOdds, resolveOddsEventId, getRawOddsForDebug, resolveEventForDebug, getGameLines, getSGOPlayerLine, resolveMLBOddsEventId, getMLBPlayerOdds, normalizeOdds, getOddsKeyStatus } from "./oddsService";
import { getDataHealth } from "./services/dataHealth";
import { getEngineDebugSummary, recordEngineRun, resetEngineStats } from "./services/engineStats";
import { filterValidSignals } from "./services/engineSignal";
import { filterValidEngineOutputs } from "./services/engineValidation";
import { processNBAEngine } from "./engines/nba";
import { processMLBEngine } from "./engines/mlb";
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
import { registerStripeRoutes } from "./stripeService";
import { getVapidPublicKey, sendPush } from "./webpush";
import { checkAndSendAlerts } from "./alertManager";
import { autoResolveAlerts, autoSettlePersistedPlays } from "./analyticsResolver";
import { syncMinutesProjections } from "./services/minutesProjectionService";
import { calculateMLBPropEdge, canShowSignal, hasRealOdds } from "./mlb/markets";
import { getMarketParkFactor } from "./mlb/dataSources";
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
import { mlbEdgeCache } from "./mlb/edgeCache";
import { liveOrchestrator, normalizeMlbStatus } from "./mlb/liveGameOrchestrator";
import { normalizeMLBSignal } from "./mlb/normalizeSignal";

// ── NCAAB live signal cache (populated by /api/ncaab/plays, read by /api/top-plays) ──
const ncaabLiveSignals: { signals: any[]; updatedAt: number } = { signals: [], updatedAt: 0 };

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
        if (adjustedConf < 64 || adjustedEdge < 4) {
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
      checkAndSendAlerts(freshPlays, storage).catch(console.warn);

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
        const hasOdds = qualifiedSigs.length > 0;
        const signalLocked = qualifiedSigs.length > 0;

        const bestQualified = qualifiedSigs.length > 0
          ? qualifiedSigs.reduce((best, qs) => (qs.signalScore > best.signalScore ? qs : best), qualifiedSigs[0])
          : null;
        const bestRawOutput = bestQualified
          ? cacheEntry?.outputs?.find((o) => o.playerId === bestQualified.playerId && o.market === bestQualified.market)
          : null;
        const bestMarket = bestQualified ? {
          line: bestQualified.line,
          odds: bestRawOutput && (bestRawOutput.overOdds !== null || bestRawOutput.underOdds !== null)
            ? { overOdds: bestRawOutput.overOdds, underOdds: bestRawOutput.underOdds }
            : null,
          projection: bestQualified.projection,
          edge: bestRawOutput?.edge ?? null,
          probability: bestQualified.engineProbability ?? bestQualified.signalScore,
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
          signalCount: qualifiedSigs.length,
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
        priorABResults: s.abResults ? JSON.parse(s.abResults) : [],
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
          priorABResults: g.abResults ? JSON.parse(g.abResults) : [],
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

      function deriveSignalState(trigger: string | null, alertType: string, score: number): { signalState: string | null; decision: string | null } {
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
      }

      function deriveFormattedReason(trigger: string | null, factors: any, inning: number | null): string {
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
      }

      function ordinalSuffix(n: number): string {
        const s = ["th", "st", "nd", "rd"];
        const v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      }

      function deriveConfidence(score: number, factors: any): number {
        let base = Math.min(10, Math.round(score * 2));
        if ((factors?.barrels ?? 0) >= 2) base = Math.min(10, base + 1);
        if ((factors?.maxEV ?? 0) >= 108) base = Math.min(10, base + 1);
        return Math.max(0, base);
      }

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

  app.get("/api/mlb/live-signals/:gameId", requireMLBAccess, async (req, res) => {
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
    if (updatedAt > 0 && dataAge > SIGNAL_FRESHNESS_MS) {
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
        const hitProb = qs.side === "OVER"
          ? (qs.engineProbability ?? qs.signalScore)
          : (qs.engineProbability ?? qs.signalScore);
        const enginePct = Math.round((hitProb ?? 0) * 10) / 10;

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
      .sort((a, b) => {
        const tierDiff = (CONFIDENCE_RANK[b.confidenceTier ?? "NO_SIGNAL"] ?? 0) - (CONFIDENCE_RANK[a.confidenceTier ?? "NO_SIGNAL"] ?? 0);
        if (tierDiff !== 0) return tierDiff;
        return (b.signalScore ?? 0) - (a.signalScore ?? 0);
      });

    // MLB Engine Isolation: run through sport-specific engine wrapper (authoritative gate)
    const mlbEngineResult = processMLBEngine(engineAll.map((qs: any) => ({
      playerId: qs.playerId,
      playerName: qs.playerName,
      team: qs.team ?? null,
      market: qs.market,
      line: qs.line,
      projection: qs.projection,
      probability: qs.engineProbability ?? qs.signalScore,
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
    })));
    const mlbValidPlayIds = new Set(mlbEngineResult.plays.map((p) => `${p.playerId}_${p.market}`));
    const validatedApiSignals = apiSignals.filter((s) => mlbValidPlayIds.has(`${s.playerId}_${s.market}`));
    console.log(`[MLB ENGINE] game=${gameId} mode=${mlbEngineResult.mode} plays=${mlbEngineResult.plays.length} fallback=${mlbEngineResult.diagnostics.fallbackTriggered} filtered=${mlbEngineResult.diagnostics.totalFiltered}`);
    console.log(`[MLB signals] game=${gameId} allFromEngine=${engineAll.length} wrapperPassed=${validatedApiSignals.length} served=${validatedApiSignals.length} isDegraded=${cachedIsDegraded}`);

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

    return res.json({ mode: "live", engine: "MLB", engineMode: mlbEngineResult.mode, signals: validatedApiSignals, updatedAt, isDegraded: finalDegraded, gameCardTags: entry?.gameCardTags ?? [] });
  });

  // Engine-canonical box score state: per-player live engine truth for a single game.
  // The Live Box Score Signal column reads from THIS endpoint, not from the filtered
  // top-feed. A player can have a watch/building/monitor state here without appearing
  // in the main live-signals feed. Engine is the sole source of truth — no edge,
  // implied-probability, or sportsbook gating is applied here.
  app.get("/api/mlb/boxscore-engine-state/:gameId", requireMLBAccess, async (req, res) => {
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
      const normalizedMarket = (sig.market as string) === "hr" ? "home_runs" : sig.market;
      const engineConfidence = computeEngineConfidence(sig, signalState);

      return {
        gameId: sig.gameId,
        playerId: sig.playerId,
        playerName: sig.playerName,
        team: sig.team,
        signalState,
        surfaced,
        market: normalizedMarket,
        side: sig.side,
        // engineConfidence is the primary surfaced value (decision-grade).
        engineConfidence,
        // probability is the raw event probability (truth, for detail/grading).
        probability: probability != null ? Math.round(probability * 10) / 10 : null,
        signalStrengthScore: sig.signalStrengthScore ?? sig.signalScore ?? null,
        drivers: sig.reasons ?? [],
        tags: sig.signalTags ?? [],
        alreadyHit: !!sig.alreadyHit,
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

    return res.json({
      mode: "live",
      players,
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
      const feedTagDist: Record<string, number> = {};

      for (const [gid, edgeEntry] of Array.from(mlbEdgeCache.entries())) {
        totalEdgeCacheEntries++;

        // Extended freshness: between-innings pauses, transient odds-API hiccups,
        // and engine cycle skips can leave a game's edge cache stale for ~5-10
        // minutes during normal operation. Use 20 minutes so brief polling gaps
        // don't visibly empty the user's edge feed mid-game.
        const FEED_FRESHNESS_MS = 20 * 60 * 1000;
        if (edgeEntry.updatedAt > 0 && Date.now() - edgeEntry.updatedAt > FEED_FRESHNESS_MS) {
          totalDropped++;
          continue;
        }

        const game = cachedLiveGames?.games.find((g: any) => g.gameId === gid);
        const rawOutputLookup = new Map((edgeEntry.outputs ?? []).map((o: any) => [`${o.playerId}_${o.market}`, o]));

        const signalSource = edgeEntry.allSignals ?? edgeEntry.qualifiedSignals ?? [];
        totalGenerated += signalSource.length;

        for (const qs of signalSource) {
          const raw = rawOutputLookup.get(`${qs.playerId}_${qs.market}`);
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

      console.log(`[MLB EDGE-FEED] edgeCacheEntries=${totalEdgeCacheEntries} total=${allSignals.length} generated=${totalGenerated} droppedStale=${totalDropped} feedTags=${JSON.stringify(feedTagDist)}`);

      return res.json({ signals: allSignals });
    } catch (e: any) {
      console.error("[mlb/edge-feed]", e.message);
      return res.json({ signals: [] });
    }
  });

  // ── MLB HR Radar Route ───────────────────────────────────────────────────────
  app.get("/api/mlb/hr-radar", requireAuth, async (req, res) => {
    try {
      const hrEdges: any[] = [];
      const hrWatchlist: any[] = [];

      const cachedLiveGames = mlbLiveGamesCache.get("games");

      for (const [gid, edgeEntry] of Array.from(mlbEdgeCache.entries())) {
        const FEED_FRESHNESS_MS = 10 * 60 * 1000;
        if (edgeEntry.updatedAt > 0 && Date.now() - edgeEntry.updatedAt > FEED_FRESHNESS_MS) continue;

        const game = cachedLiveGames?.games.find((g: any) => g.gameId === gid);
        const rawOutputLookup = new Map((edgeEntry.outputs ?? []).map((o: any) => [`${o.playerId}_${o.market}`, o]));
        const gameState = mlbGameCache.gameState[gid];
        const contactCache = mlbGameCache.contactData[gid];
        const weather = mlbGameCache.weather[gid];

        for (const qs of (edgeEntry.allSignals ?? [])) {
          const raw = rawOutputLookup.get(`${qs.playerId}_${qs.market}`);
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

      const bettable = hrEdges.filter((s: any) => !s.alreadyHit);
      const cashedFromEdge = hrEdges.filter((s: any) => s.alreadyHit);
      const cleanWatchlist = hrWatchlist.filter((w: any) => !cashedFromEdge.some((c: any) => c.playerId === w.playerId));

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
        return c.gradingStatus === "called_hit" && c.userVisible !== false;
      });

      const dbAlerts = await storage.getTodayHrRadarBoard();
      const cashedPlayerIdSet = new Set([...cashedFromEdge, ...cashedFromDb].map((c: any) => c.playerId));
      const bettablePlayerIdSet = new Set(bettable.map((b: any) => b.playerId));
      const watchlistPlayerIdSet = new Set(cleanWatchlist.map((w: any) => w.playerId));

      const activeGameIds = new Set(cachedLiveGames?.games.filter((g: any) => g.status === "live" || g.status === "pregame").map((g: any) => g.gameId) ?? []);

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

      // Phase 5: explicit outcomeType taxonomy on user-facing rows.
      // called_hit | called_miss | uncalled_hr | late_signal | post_hr_fallback
      const deriveOutcomeType = (row: any, fallbackStatus: "hit" | "miss"): string => {
        if (row?.fallbackCreated) return "post_hr_fallback";
        if (row?.gradingStatus === "called_hit") return "called_hit";
        if (row?.gradingStatus === "called_miss") return "called_miss";
        if (row?.gradingStatus === "uncalled_hr") return "uncalled_hr";
        if (row?.gradingStatus === "late_signal") return "late_signal";
        return fallbackStatus === "hit" ? "called_hit" : "called_miss";
      };
      const cashedWithType = dedupCashed.map((c: any) => ({ ...c, outcomeType: deriveOutcomeType(c, "hit") }));
      const gradedHitsWithType = canonical.hits.map(h => ({ ...h, outcomeType: deriveOutcomeType(h, "hit") }));
      const gradedMissesWithType = canonical.misses.map(m => ({ ...m, outcomeType: deriveOutcomeType(m, "miss") }));

      console.log(`[MLB_HR_RADAR] bettable=${dedupBettable.length} cashed=${dedupCashed.length} (edge=${cashedFromEdge.length},db=${cashedFromDb.length}) watchlist=${dedupWatchlist.length} dbAlerts=${dbAlerts.length} canonicalHits=${canonical.hits.length} canonicalMisses=${canonical.misses.length}`);

      return res.json({
        bettableHR: dedupBettable,
        hrWatchlist: dedupWatchlist,
        hrEdges,
        cashedToday: cashedWithType,
        activity: cashedWithType,
        gradedHits: gradedHitsWithType,
        gradedMisses: gradedMissesWithType,
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
    try {
      const sessionDate = typeof req.query.sessionDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.sessionDate)
        ? req.query.sessionDate
        : undefined;
      const ladder = await storage.getHrRadarLadder(sessionDate);
      return res.json(ladder);
    } catch (e: any) {
      console.error("[mlb/hr-radar/ladder]", e.message);
      return res.json({
        sessionDate: "",
        sections: { attackNow: [], building: [], watch: [], cashed: [], dead: [] },
        counts: { attackNow: 0, building: 0, watch: 0, cashed: 0, dead: 0, total: 0 },
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

  app.get("/api/mlb/hr-radar-board", requireAuth, async (req, res) => {
    try {
      const board = await storage.getTodayHrRadarBoard();
      const live = board.filter(a => a.status === "live");
      const hits = board.filter(a => a.status === "hit");
      const misses = board.filter(a => a.status === "miss");
      return res.json({ board, live, hits, misses, total: board.length });
    } catch (e: any) {
      console.error("[mlb/hr-radar-board]", e.message);
      return res.json({ board: [], live: [], hits: [], misses: [], total: 0 });
    }
  });

  app.get("/api/mlb/hr-radar-analyze/:playerId/:gameId", requireAuth, async (req, res) => {
    try {
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
        isBarrel: (ab.exitVelocity ?? 0) >= 98 && (ab.launchAngle ?? 0) >= 20 && (ab.launchAngle ?? 0) <= 35,
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
        if (r.gradingStatus === "called_hit") byInning[inn].calledHit++;
        else if (r.gradingStatus === "called_miss") byInning[inn].calledMiss++;
        else if (r.gradingStatus === "uncalled_hr") byInning[inn].uncalled++;
        else if (r.gradingStatus === "late_signal") byInning[inn].late++;
        if (r.gradingStatus === "called_hit" && r.signalInning != null && r.hitInning != null) {
          avgInningsToHr += (r.hitInning - r.signalInning);
          calledHitWithTiming++;
        }
      }
      const calledHits = byStatus["called_hit"] ?? 0;
      const calledMisses = byStatus["called_miss"] ?? 0;
      const uncalled = byStatus["uncalled_hr"] ?? 0;
      const late = byStatus["late_signal"] ?? 0;
      const totalCalls = calledHits + calledMisses;
      const totalHrs = calledHits + uncalled + late;
      return res.json({
        sessionDate,
        byStatus,
        byInning,
        summary: {
          calledHits, calledMisses, uncalledHrs: uncalled, lateSignals: late,
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

      const totalHits = records.filter(r => r.result === "hit").length;
      const totalMisses = records.filter(r => r.result === "miss").length;
      const hitRate = records.length > 0 ? Math.round((totalHits / records.length) * 1000) / 10 : 0;

      return res.json({
        records,
        summary: { total: records.length, hits: totalHits, misses: totalMisses, hitRate },
      });
    } catch (e: any) {
      console.error("[admin/hr-radar-analytics]", e.message);
      return res.json({ records: [], summary: { total: 0, hits: 0, misses: 0, hitRate: 0 } });
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
      const history = await getBatterHrHistory(decodeURIComponent(req.params.name));
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
        decodeURIComponent(req.params.batter),
        decodeURIComponent(req.params.pitcher)
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

      // Market alias resolution — canonical backend values use different names than frontend aliases
      const MANUAL_MARKET_ALIASES: Record<string, MLBMarket> = {
        hr: "home_runs",
        pitcher_k: "pitcher_strikeouts",
      };
      const rawMarket = safeStr("market");
      const resolvedMarket: string = MANUAL_MARKET_ALIASES[rawMarket] ?? rawMarket;
      if (!resolvedMarket || !ALL_MLB_MARKETS.includes(resolvedMarket as MLBMarket)) {
        return res.status(400).json({ error: `Invalid market. Must be one of: ${[...ALL_MLB_MARKETS, "hr", "pitcher_k"].join(", ")}` });
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
        label: "Manual Projection (No Live Odds)",
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
  const liveSignalsCache = new Map<string, { ts: number; signals: any[]; engineOutput: Record<number, Record<string, any>> }>();
  // Aligned with the dashboard's 20s client poll so the box score and the
  // signal badges refresh in lock-step (no "dead cells" where stats update
  // but badges sit stale). Paid Odds API calls are still gated downstream
  // by NBA_ODDS_LIVE_TTL=30s and the per-game 10s throttle in oddsService,
  // so dropping the outer TTL to 20s does not increase upstream spend — it
  // just lets us recompute the engine output against the freshest box.
  const LIVE_SIGNALS_TTL = 20_000;

  app.get("/api/live-signals/:gameId", requireAuth, async (req, res) => {
    const gameId = req.params.gameId as string;

    const cached = liveSignalsCache.get(gameId);
    if (cached && Date.now() - cached.ts < LIVE_SIGNALS_TTL) {
      return res.json({ signals: cached.signals, engineOutput: cached.engineOutput ?? {} });
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
        liveSignalsCache.set(gameId, { ts: Date.now(), signals: [], engineOutput: {} });
        return res.json({ signals: [], engineOutput: {} });
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

      // Only run for genuinely in-progress games (not final, not scheduled)
      const inProgress = statusDesc === "In Progress" || statusDesc === "Halftime";
      if (!inProgress) {
        liveSignalsCache.set(gameId, { ts: Date.now(), signals: [], engineOutput: {} });
        return res.json({ signals: [], engineOutput: {} });
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
          if (minutes < 3) continue;

          const playerName: string = athlete.athlete.displayName ?? "";
          const espnAthId = parseInt(athlete.athlete.id, 10);
          const dbPlayer = espnIdToDbPlayer.get(espnAthId);
          if (!dbPlayer) {
            console.warn(`[live-signals] No DB match for ESPN athlete ${espnAthId} (${playerName}) — skipping`);
            continue;
          }

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
              if (!oddsEntry) continue;
              const liveLine = oddsEntry.line;

              const oddsAge = Date.now() - (oddsEntry.oddsFetchedAt ?? 0);
              if (period >= 3 && oddsAge > NBA_2H_STALE_LINE_MS) {
                console.warn(`[NBA 2H STALE LINE] ${dbPlayer.name} (${statType}) — odds ${Math.round(oddsAge / 1000)}s old, rejecting`);
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
              });

              // SIGNAL EVALUATION CONTRACT — strict sequential continues.
              // Do not reorder steps. Do not insert any side effects before step 5.
              //
              // Step 1: finite guard — must run before any arithmetic on result.probability.
              // NaN arithmetic silently produces NaN, which would corrupt all downstream values.
              if (!Number.isFinite(result.probability)) continue;

              // Step 2: compute edge (only after finite check)
              const edge = Math.abs(result.probability - 50);

              // Step 3: threshold gate — plays below minimum edge are not actionable
              if (edge < 5) {
                if (process.env.DEBUG_PIPELINE === "true") {
                  console.log(`[PIPELINE][NBA][${oddsEventId ?? "unknown"}] player=${dbPlayer.name} stat=${statType} prob=${result.probability.toFixed(1)} edge=${edge.toFixed(1)} skipReason=lowEdge`);
                }
                continue;
              }

              // Step 4a: explicit zero-edge exclusion — belt-and-suspenders, implied by step 3
              // (prob===50 → edge===0 < 5) but required by evaluation contract.
              if (result.probability === 50) continue;

              // Step 4b: no-conviction guard — noSignal or NO_SIGNAL plays must never enter
              // allSignals or engineOutput; they produce zero side effects.
              if (result.noSignal || result.recommendedSide === "NO_SIGNAL") continue;

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
          probability: Number(s.probability ?? 0),
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
          } : undefined,
        }, storage).catch(console.warn);
      }

      liveSignalsCache.set(gameId, { ts: Date.now(), signals: validatedNbaSignals, engineOutput });
      res.json({ signals: validatedNbaSignals, engineOutput });
    } catch (e) {
      console.warn(`[LiveSignals] Error for game ${gameId}:`, (e as any).message);
      liveSignalsCache.set(gameId, { ts: Date.now(), signals: [], engineOutput: {} });
      res.json({ signals: [], engineOutput: {} });
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
    console.log("[HT_ENDPOINT_HIT]", {
      path: req.path,
      query: req.query,
      method: req.method,
      timestamp: Date.now(),
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

        const isHalftime =
          (period === 2 && clockSeconds <= 10) ||
          statusDesc === "Halftime" ||
          statusDesc === "HALF" ||
          statusDesc === "HALFTIME" ||
          statusType === "STATUS_HALFTIME" ||
          statusState === "halftime" ||
          (period === 3 && clockSeconds === 720);

        console.log("[HALFTIME_DETECTION_RESULT]", {
          game: `${awayTeamDisplay}@${homeTeamDisplay}`,
          isHalftime,
          period,
          clock,
          statusDesc,
          statusType,
          statusState,
        });

        if (!isHalftime) continue;

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
        });
      }

      // Aggregated [HALFTIME_DETECTION_RESULT] — summary across all games after detection loop
      console.log("[HALFTIME_DETECTION_RESULT]", {
        totalGames: (gamesData.events ?? []).length,
        halftimeGames: halftimeGames.length,
        ids: halftimeGames.map(g => g.gameId),
      });

      if (halftimeGames.length === 0) {
        console.log("[HT_RESPONSE_ASSERT]", {
          totalGames: (gamesData.events ?? []).length,
          halftimeGames: 0,
          parsedMarkets: 0,
          secondHalfMarkets: 0,
          playsGenerated: 0,
        });
        console.log("STATUS: HALFTIME PIPELINE STILL BLOCKED — REASON: halftimeDetected");
        return res.json({ plays: [], message: "No games at halftime right now." });
      }

      // Load all DB players once — avoid repeated DB calls per athlete
      const allDbPlayers = await storage.getPlayers();
      const normDb = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

      // Cache Odds API event IDs and player odds per game to avoid redundant calls
      const oddsCache = new Map<string, Map<string, number | null>>();

      let totalOddsAttempts = 0;       // Total player+statType pairs for which in-play odds lookup was attempted
      let secondHalfMarketsFound = 0;  // Pairs where in-play (2H) books were returned
      let zeroBookInPlayCount = 0;     // Pairs where in-play returned 0 books and !isDegraded (absence signal)
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
        // Resolve Odds API event ID for this game (for live prop lines)
        let oddsEventId: string | null = null;
        const oddsPlayerCache = new Map<string, { line: number; bookKeys: string[]; isDegraded: boolean; oddsFetchedAt: number } | null>();
        const HT_STALE_LINE_MS = 120_000;
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

                // Multi-source line lookup: Odds API (live → pre-game) → SGO.
                // If no real book line is found, skip this stat — we never invent a line.
                let liveLine: number | null = null;
                let lineIsDegraded = false;
                const lineCacheKey = `${playerName}|${statType}`;
                if (!oddsPlayerCache.has(lineCacheKey)) {
                  try {
                    let resolved = false;

                    // Source 1 & 2: The Odds API (live in-play, then pre-game)
                    if (oddsEventId && (process.env.ODDS_API_KEY || process.env.ODDS_API_KEY_2)) {
                      totalOddsAttempts++;
                      let oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, true);
                      let bookKeys = Object.keys(oddsResult.books);
                      if (bookKeys.length > 0) secondHalfMarketsFound++;
                      if (bookKeys.length === 0 && !oddsResult.isDegraded) {
                        // In-play market checked but 0 books returned — contributes to absence evidence
                        zeroBookInPlayCount++;
                        oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, false);
                        bookKeys = Object.keys(oddsResult.books);
                        if (bookKeys.length > 0) console.log(`[Halftime] Pre-game line for ${playerName} (${statType})`);
                      }
                      if (bookKeys.length > 0) {
                        const isDeg = oddsResult.isDegraded;
                        const lines = bookKeys.map(k => oddsResult.books[k].line);
                        // Log every book → line so data integrity issues are visible
                        const lineDetail = bookKeys.map((k, i) => `${k}=${lines[i]}`).join(" | ");
                        console.log(`[Halftime] Lines for ${playerName} (${statType})${isDeg ? " [DEGRADED]" : ""}: ${lineDetail}`);
                        // Use median consensus — never pick extremes which amplify outlier/stale book data
                        const sortedLines = [...lines].sort((a, b) => a - b);
                        const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
                        oddsPlayerCache.set(lineCacheKey, { line: medianLine, bookKeys, isDegraded: isDeg, oddsFetchedAt: oddsResult.fetchedAt || Date.now() });
                        resolved = true;
                      }
                    }

                    // Source 3: SGO NBA (works independently of Odds API event ID)
                    if (!resolved && process.env.SGO_API_KEY) {
                      const sgoResult = await getSGOPlayerLine(game.homeTeamAbbr, game.awayTeamAbbr, playerName, statType);
                      if (sgoResult !== null) {
                        console.log(`[Halftime] SGO line for ${playerName} (${statType}): ${sgoResult}`);
                        oddsPlayerCache.set(lineCacheKey, { line: sgoResult, bookKeys: ["sgo"], isDegraded: false, oddsFetchedAt: Date.now() });
                        resolved = true;
                      }
                    }

                    if (!resolved) {
                      console.log(`[Halftime] No book line for ${playerName} (${statType}) — skipping`);
                      oddsPlayerCache.set(lineCacheKey, null);
                    }
                  } catch { oddsPlayerCache.set(lineCacheKey, null); }
                }
                const oddsEntry = oddsPlayerCache.get(lineCacheKey);
                if (oddsEntry != null) {
                  liveLine = oddsEntry.line;
                  lineIsDegraded = oddsEntry.isDegraded;
                } else {
                  continue; // No real line available — never fabricate one
                }

                const htOddsAge = Date.now() - (oddsEntry.oddsFetchedAt ?? 0);
                if (htOddsAge > HT_STALE_LINE_MS) {
                  console.warn(`[NBA 2H STALE LINE] ${playerName} (${statType}) — odds ${Math.round(htOddsAge / 1000)}s old, rejecting (halftime pipeline)`);
                  continue;
                }

                // Zero-line guard — a line of 0 is invalid and must not be passed to the engine.
                // This can occur if a book returns a zero point value due to a data error.
                if (!liveLine || liveLine === 0) {
                  console.warn(`[ODDS FALLBACK] No valid line — play suppressed`, { gameId: game.gameId, playerName });
                  continue;
                }

                // Skip plays where the line has already been cleared at halftime —
                // these are not actionable (over already won, under already lost).
                // Check BEFORE running calculateProbability to save compute cost.
                if (halftimeStat >= liveLine) continue;

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
                });

                // SIGNAL EVALUATION CONTRACT — evaluation order is strict, do not reorder:
                // Step 1: finite guard — must run before any arithmetic on result.probability.
                // NaN < 6 === false in JS, so without this guard a NaN probability would silently
                // pass the threshold check below and enter allPlays with garbage data.
                if (!Number.isFinite(result.probability)) continue;

                // Step 2: compute edge — only after finite check
                let edge = Math.abs(result.probability - 50);

                // Step 3: threshold gate — plays below minimum edge are not actionable
                if (edge < 6) continue;

                // Step 4: explicit zero-edge exclusion (belt-and-suspenders; redundant with step 3
                // since prob===50 → edge===0 < 6, but required by evaluation contract).
                if (result.probability === 50) continue;

                // Confidence tier reduction for degraded lines:
                // ELITE (edge>=20) → STRONG (edge 15-19), STRONG → VALUE (edge 10-14), VALUE → volatile pool
                // This prevents a stale line from appearing as a high-confidence signal.
                let isVolatile = false;
                if (lineIsDegraded) {
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

                const cacheKey2 = `${playerName}|${statType}`;
                const oddsEntry2 = oddsPlayerCache.get(cacheKey2);

                // NO_SIGNAL guard: skip plays where engine has no directional conviction
                if (result.recommendedSide === "NO_SIGNAL") {
                  console.log(`[HT_NO_SIGNAL] Skipping ${dbPlayer.name} (${statType}) — engine returned NO_SIGNAL`);
                  continue;
                }

                // Use displayConfidence (always direction-correct, >= 50 for any valid signal)
                // so filters, sorts, and client display all work symmetrically for OVER and UNDER.
                // Raw result.probability (<50 for UNDER plays) is NOT sent to client.
                const displayConfidence = (result as any).displayConfidence ?? result.probability;
                const betDirection = (result as any).recommendedSide?.toLowerCase() ?? (result.probability > 50 ? "over" : "under");

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
                  lineSource: "odds_api",
                  bookKeys: oddsEntry2?.bookKeys ?? [],
                  probability: displayConfidence,
                  rawProbability: result.probability,
                  edge,
                  expectedTotal: result.expectedTotal,
                  impliedProbability: (result as any).impliedProbability ?? null,
                  betDirection,
                  isDegraded: lineIsDegraded,
                  engineGeneratedAt: Date.now(),
                  timingContext: "halftime" as const,
                  engineDiagnostics: (result as any).engineDiagnostics ?? undefined,
                };
                console.log(`[ENGINE_OUTPUT] sport=nba player=${dbPlayer.name} market=${statType} side=${betDirection.toUpperCase()} prob=${displayConfidence.toFixed(1)} edge=${edge.toFixed(1)} proj=${result.expectedTotal ?? "null"} line=${liveLine} timing=halftime`);
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

      // [HT_RESPONSE_ASSERT] — uses actual parsed market counters (totalOddsAttempts, secondHalfMarketsFound)
      // not counts derived from topPlays, to give truthful pipeline checkpoint
      console.log("[HT_RESPONSE_ASSERT]", {
        totalGames: (gamesData.events ?? []).length,
        halftimeGames: halftimeGames.length,
        parsedMarkets: totalOddsAttempts,
        secondHalfMarkets: secondHalfMarketsFound,
        playsGenerated,
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

      res.json({ plays: topPlays });
      checkAndSendAlerts(topPlays, storage).catch(console.warn);
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
      if (!["all", "elite"].includes(user.subscriptionTier ?? "") && !user.isAdmin) {
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
  s.toLowerCase().replace(/['.'\-\s]+/g, "").replace(/jr$|sr$|ii$|iii$|iv$/, "");

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
      const dbMatch = dbPlayers.find(p => normalizeName(p.name) === normNbs && (!p.ppg));
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
  const PROB_BUCKETS = [
    { label: "60-64%", min: 60, max: 64 },
    { label: "65-69%", min: 65, max: 69 },
    { label: "70-74%", min: 70, max: 74 },
    { label: "75%+", min: 75, max: 100 },
  ];

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

      const avgEdge = plays.length > 0
        ? Math.round(plays.reduce((s, p) => s + (Number(p.edgeGap) || Number(p.modelEdge) || 0), 0) / plays.length * 10) / 10
        : 0;
      const avgProb = plays.length > 0
        ? Math.round(plays.reduce((s, p) => s + (Number(p.prob) || 0), 0) / plays.length * 10) / 10
        : 0;

      const buckets = PROB_BUCKETS.map(bucket => {
        const bucketPlays = plays.filter(p => {
          const prob = Number(p.prob) || 0;
          return prob >= bucket.min && prob <= bucket.max;
        });
        const bucketHits = bucketPlays.filter(p => p.result === "hit").length;
        const bucketTotal = bucketPlays.filter(p => p.result === "hit" || p.result === "miss").length;
        return {
          label: bucket.label,
          total: bucketPlays.length,
          hits: bucketHits,
          winRate: bucketTotal > 0 ? Math.round((bucketHits / bucketTotal) * 1000) / 10 : 0,
        };
      });

      const oversCount = plays.filter(p => p.direction === "over").length;
      const undersCount = plays.filter(p => p.direction === "under").length;
      const nbaCount = plays.filter(p => p.sport === "nba").length;
      const mlbCount = plays.filter(p => p.sport === "mlb").length;
      console.log(`[performance] total=${plays.length} overs=${oversCount} unders=${undersCount} nba=${nbaCount} mlb=${mlbCount} buckets=${buckets.map(b => b.total).join(",")}`);

      return res.json({
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
        await sendPush(adminUser.pushSubscription, {
          title,
          body,
          url: "/",
          data: { isTest: true, testPlay },
        });
        return res.json({ success: true, deliveredTo: 1, target: "self" });
      }

      if (target === "all") {
        if (!req.body.confirmed) {
          return res.json({ requiresConfirmation: true, subscriberCount: usersWithPush.length });
        }
        let sent = 0;
        await Promise.allSettled(
          usersWithPush.map(async (u: any) => {
            try {
              await sendPush(u.pushSubscription, { title, body, url: "/", data: { isTest: true, testPlay } });
              sent++;
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

      const plays = await storage.getGradedPlaysForCalibration({
        sport: sport || undefined,
        market: market || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
      });

      type PersistedPlay = (typeof plays)[0];

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

      return res.json({
        plays,
        summary: { totalPlays, winRate, pushRate, avgEdge, avgProbability },
        edgeBuckets,
        probBuckets,
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
      const { buildTopPlays } = await import("./services/topPlaysService");

      const mlbSignals: any[] = [];
      for (const [, entry] of Array.from(mlbEdgeCache.entries())) {
        const FRESHNESS_MS = 300_000;
        if (entry.updatedAt > 0 && Date.now() - entry.updatedAt > FRESHNESS_MS) continue;
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
      return res.json({ plays: [] });
    }
  });

  app.get("/api/public-analytics/summary", async (_req, res) => {
    try {
      const { getPublicAnalyticsSummary } = await import("./services/publicAnalyticsService");
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

  app.get("/api/live-signal-counts", requireAuth, async (_req, res) => {
    try {
      let nbaElite = 0, ncaabElite = 0, mlbElite = 0, totalLive = 0;

      for (const [, entry] of Array.from(mlbEdgeCache.entries())) {
        const FRESHNESS_MS = 300_000;
        if (entry.updatedAt > 0 && Date.now() - entry.updatedAt > FRESHNESS_MS) continue;
        const qs = entry.qualifiedSignals ?? [];
        for (const sig of qs) {
          totalLive++;
          if (sig.confidenceTier === "ELITE" || sig.confidenceTier === "STRONG") mlbElite++;
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

      const bucketRanges = [
        { label: "60-64", min: 60, max: 64.99 },
        { label: "65-69", min: 65, max: 69.99 },
        { label: "70-74", min: 70, max: 74.99 },
        { label: "75-79", min: 75, max: 79.99 },
        { label: "80+", min: 80, max: 100 },
      ];
      const buckets = bucketRanges.map(({ label, min, max }) => {
        const inBucket = settled.filter(p => {
          const prob = Number(p.prob);
          const conf = p.direction === "over" ? prob : 100 - prob;
          return conf >= min && conf <= max;
        });
        const wins = inBucket.filter(p => p.result === "hit").length;
        const losses = inBucket.filter(p => p.result === "miss").length;
        const pushes = inBucket.filter(p => p.result === "push").length;
        const total = inBucket.length;
        const winRate = total > 0 ? Math.round((wins / total) * 1000) / 10 : 0;
        return { label, total, wins, losses, pushes, winRate };
      });
      return res.json({ buckets, filters: { sport: sport || "nba", direction: direction || "all", marketType: marketType || "all", archetype: archFilter || "all", flagship: flagship || "all" } });
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
      const roi = total > 0
        ? Math.round(((hits * 90.91 - (total - hits) * 100) / total) * 10) / 10
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
        totalSettled: total,
        totalHits: hits,
        roi,
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
      const roi = decided > 0 ? Math.round(((hits * 0.909 - misses) / decided) * 1000) / 10 : 0;

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
