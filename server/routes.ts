import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { type Player, type ParlayPickInput } from "@shared/schema";
import { getPlayerOdds, resolveOddsEventId, getRawOddsForDebug, resolveEventForDebug, getGameLines, getSGOPlayerLine, resolveMLBOddsEventId, getMLBPlayerOdds } from "./oddsService";
import { computeNCAABPlays, getNCAABScoreboard, getNCAABH2H, getNCAABChipOdds, fetch2HLines, calc2HEngineProb } from "./ncaabService";
import { enrichNCAABGameFull, clearEnrichmentCache, getEnrichmentCacheStats } from "./ncaabEnrichment";
import { calculateParlay } from "./parlayService";
import { registerAuthRoutes, requirePlayAccess, requireAuth, requireAdmin, requireTier } from "./auth";
import { registerStripeRoutes } from "./stripeService";
import { getVapidPublicKey, sendPush } from "./webpush";
import { checkAndSendAlerts } from "./alertManager";
import { autoResolveAlerts, autoSettlePersistedPlays } from "./analyticsResolver";
import { syncMinutesProjections } from "./services/minutesProjectionService";
import { calculateMLBPropEdge } from "./mlb/markets";
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
  getPlayerPoolCount,
  getTeamCount,
} from "./mlb/rosterService";
import {
  syncGameState,
  syncContactData,
  syncPitcherContext,
  syncWeather,
  syncBullpenUsage,
  mlbGameCache,
} from "./mlb/dataPullService";
import { getActiveGames } from "./mlb/liveGameRegistry";
import { mlbEdgeCache } from "./mlb/edgeCache";
import { liveOrchestrator } from "./mlb/liveGameOrchestrator";

// ── Module-level play dedup guard (persists for process lifetime) ─────────────
const recordedPlayKeys = new Set<string>();

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
    ? new Date(p.timestamp).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return [
    String(p.playerId ?? p.playerName ?? "").trim(),
    String(p.statType ?? p.market ?? "").toUpperCase().trim(),
    String(p.line ?? ""),
    String(p.betDirection ?? p.direction ?? "").toLowerCase().trim(),
    String(p.gameId ?? "").trim(),
    today,
  ].join("|");
}

async function recordPlayOnce(play: Parameters<typeof import("./storage").storage.recordPlay>[0]): Promise<void> {
  const key = play.duplicateGuard;
  if (recordedPlayKeys.has(key)) return;
  recordedPlayKeys.add(key);
  try {
    await import("./storage").then(m => m.storage.recordPlay(play));
  } catch (err) {
    console.warn("[recordPlayOnce] DB write failed:", (err as any).message);
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  await registerAuthRoutes(app);
  await registerStripeRoutes(app);

  // ── Admin Routes ──────────────────────────────────────────────────────────

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
  // Price IDs (hardcoded in PLAN_META): all=$40 price_1T6fl12cW8Vmrgt3B6ffBIuw, elite=$65 price_1T6fly2cW8Vmrgt3WU9uHL7L
  // User schema: subscriptionTier (null/"all"/"elite"), stripeCustomerId, stripeSubscriptionId, playsUsed
  // Storage: setUserSubscriptionTier, updateUserStripeCustomer, resetUserPlays
  // stripeCustomerId: yes, on user object

  const ADMIN_TIER_PRICES: Record<string, { label: string; pricePerMonth: number; stripePriceId: string | null }> = {
    "":      { label: "Free",                pricePerMonth: 0,  stripePriceId: null },
    "all":   { label: "Pro ($40/mo)",        pricePerMonth: 40, stripePriceId: "price_1T6fl12cW8Vmrgt3B6ffBIuw" },
    "elite": { label: "All Sports ($65/mo)", pricePerMonth: 65, stripePriceId: "price_1T6fly2cW8Vmrgt3WU9uHL7L" },
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

      if (process.env.NODE_ENV !== "production") {
        for (const play of freshPlays) {
          console.log("[NCAAB DEBUG]", {
            gameId: play.gameId,
            line: play.total,
            projection: play.engineOutput?.projectedTotal ?? null,
            recommendedSide: play.engineOutput?.recommendedSide ?? null,
            displayProbability: play.engineOutput?.displayProbability ?? null,
            marketVerdicts: play.engineOutput?.marketVerdicts ?? [],
          });
        }
      }

      res.json({ plays: freshPlays });
      checkAndSendAlerts(freshPlays, storage).catch(console.warn);
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

  // ── MLB Live Routes (Auth-required, Phase B UI) ──────────────────────────────

  const mlbLiveGamesCache = new Map<string, { ts: number; games: any[] }>();
  const MLB_LIVE_GAMES_TTL = 30_000;

  app.get("/api/mlb/live-games", requireAuth, async (_req, res) => {
    const cached = mlbLiveGamesCache.get("games");
    if (cached && Date.now() - cached.ts < MLB_LIVE_GAMES_TTL) {
      return res.json(cached.games);
    }
    try {
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=linescore`;
      const response = await fetch(scheduleUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`MLB API ${response.status}`);
      const data = (await response.json()) as any;
      const registeredIds = new Set(getActiveGames().map((g) => g.gameId));

      const games: any[] = [];
      for (const date of data.dates ?? []) {
        for (const game of date.games ?? []) {
          const state = game.status?.abstractGameState as string;
          if (state !== "Live" && state !== "Preview") continue;
          const gameId = String(game.gamePk);
          const linescore = game.linescore ?? {};
          const inning: number = linescore.currentInning ?? 0;
          const isTopInning: boolean = linescore.isTopInning ?? true;
          const homeScore: number = linescore.teams?.home?.runs ?? 0;
          const awayScore: number = linescore.teams?.away?.runs ?? 0;
          const cachedState = mlbGameCache.gameState[gameId];
          games.push({
            gameId,
            homeTeam: game.teams?.home?.team?.abbreviation ?? "",
            awayTeam: game.teams?.away?.team?.abbreviation ?? "",
            homeName: game.teams?.home?.team?.name ?? "",
            awayName: game.teams?.away?.team?.name ?? "",
            homeScore,
            awayScore,
            inning: cachedState?.inning ?? inning,
            isTopInning: cachedState?.isTopInning ?? isTopInning,
            status: state === "Live" ? "live" : "preview",
            inRegisty: registeredIds.has(gameId),
          });
        }
      }
      mlbLiveGamesCache.set("games", { ts: Date.now(), games });
      return res.json(games);
    } catch (e: any) {
      console.error("[mlb/live-games]", e.message);
      return res.status(502).json({ error: "Live games unavailable", games: [] });
    }
  });

  const mlbLiveStatsCache = new Map<string, { ts: number; players: any[] }>();
  const MLB_LIVE_STATS_TTL = 30_000;

  app.get("/api/mlb/live-stats/:gameId", requireAuth, async (req, res) => {
    const gameId = req.params.gameId as string;
    const cached = mlbLiveStatsCache.get(gameId);
    if (cached && Date.now() - cached.ts < MLB_LIVE_STATS_TTL) {
      return res.json(cached.players);
    }
    try {
      const url = `https://statsapi.mlb.com/api/v1/game/${gameId}/boxscore`;
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
          players.push({
            playerId: String(batterId),
            playerName: entry.person?.fullName ?? "",
            teamAbbr: side === "home" ? data.teams?.home?.team?.abbreviation ?? "" : data.teams?.away?.team?.abbreviation ?? "",
            battingOrderSlot: slot,
            ab: batting.atBats ?? 0,
            h: batting.hits ?? 0,
            tb: batting.totalBases ?? 0,
            r: batting.runs ?? 0,
            rbi: batting.rbi ?? 0,
            bb: batting.baseOnBalls ?? 0,
            sb: batting.stolenBases ?? 0,
            k: batting.strikeOuts ?? 0,
          });
        }
      }
      players.sort((a, b) => (a.battingOrderSlot || 99) - (b.battingOrderSlot || 99));
      mlbLiveStatsCache.set(gameId, { ts: Date.now(), players });
      return res.json(players);
    } catch (e: any) {
      console.error("[mlb/live-stats]", e.message);
      return res.status(502).json({ error: "Live stats unavailable", players: [] });
    }
  });

  const mlbSignalsCache = new Map<string, { ts: number; signals: any[]; updatedAt: number }>();
  const MLB_SIGNALS_TTL = 90_000;

  app.get("/api/mlb/live-signals/:gameId", requireAuth, async (req, res) => {
    const gameId = req.params.gameId as string;
    const cached = mlbSignalsCache.get(gameId);
    if (cached && Date.now() - cached.ts < MLB_SIGNALS_TTL) {
      return res.json({ signals: cached.signals, updatedAt: cached.updatedAt });
    }
    const entry = mlbEdgeCache.get(gameId);
    const allOutputs = entry?.outputs ?? [];
    const updatedAt = entry?.updatedAt ?? 0;

    const signals = allOutputs
      .filter((o) => o.bookLine > 0 && (o.calibratedProbabilityOver > 0 || o.calibratedProbabilityUnder > 0))
      .filter((o) => Math.abs(o.edge) >= 5)
      .map((o) => {
        const hitProb =
          o.recommendedSide === "OVER" ? o.calibratedProbabilityOver : o.calibratedProbabilityUnder;
        let tier: "green" | "yellow" | "teal" | "red";
        if (o.recommendedSide === "UNDER" && hitProb >= 85) tier = "red";
        else if (hitProb >= 85) tier = "green";
        else if (hitProb >= 70) tier = "yellow";
        else tier = "teal";
        return {
          playerId: o.playerId,
          playerName: o.playerName,
          market: o.market,
          bookLine: o.bookLine,
          enginePct: Math.round(hitProb * 10) / 10,
          edge: Math.round(Math.abs(o.edge) * 10) / 10,
          recommendedSide: o.recommendedSide,
          inning: mlbGameCache.gameState[gameId]?.inning ?? 0,
          tier,
          gameId,
        };
      });

    mlbSignalsCache.set(gameId, { ts: Date.now(), signals, updatedAt });
    return res.json({ signals, updatedAt });
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

      const market = safeStr("market") as MLBMarket;
      if (!market || !ALL_MLB_MARKETS.includes(market)) {
        return res.status(400).json({ error: `Invalid market. Must be one of: ${ALL_MLB_MARKETS.join(", ")}` });
      }

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
        ? (market === "hits" ? statsH : market === "total_bases" ? statsTB : statsK)
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
      return res.json(output);
    } catch (err: any) {
      console.error("[MLB props]", err.message);
      return res.status(400).json({ error: err.message || "MLB prop engine error" });
    }
  };
  app.post("/api/mlb/props", requireAuth, mlbPropsHandler);
  app.post("/api/mlb/calculate", requireAuth, mlbPropsHandler);

  app.get("/api/mlb/odds", requireAuth, async (req, res) => {
    try {
      const { playerTeam, opponentTeam, playerName, statType, inPlay } = req.query;

      if (!playerName || !statType) {
        return res.status(400).json({ message: "Missing required parameters: playerName, statType" });
      }

      if (!process.env.ODDS_API_KEY) {
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
      await syncGameState(gameId);
      await syncContactData(gameId);
      await syncPitcherContext(gameId);
      await syncWeather(gameId);
      await syncBullpenUsage(gameId);
      const outputs = await liveOrchestrator.triggerEngine(gameId);
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
      const hasNcaabAccess = user.isAdmin || tier === "all" || tier === "elite";
      return res.json({
        dbTier: tier ?? null,
        hasNcaabAccess,
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
      const user = await storage.getUserById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      const tier = user.subscriptionTier;
      return res.json({
        id: user.id,
        email: user.email,
        isAdmin: user.isAdmin,
        subscriptionTier: tier ?? null,
        requiresRefresh: user.requiresRefresh ?? false,
        hasNcaabAccess: user.isAdmin || tier === "all" || tier === "elite",
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
      const hasNcaabAccess = user.isAdmin || rawTier === "all" || rawTier === "elite";
      // Clear requiresRefresh after client has acknowledged it
      if (user.requiresRefresh) {
        await storage.clearRequiresRefresh(userId);
      }
      return res.json({
        tier: rawTier,
        hasNcaabAccess,
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

      if (!process.env.ODDS_API_KEY) {
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
      let formattedOdds = await getPlayerOdds(oddsEventId, playerName as string, statType as string, isInPlay);

      if ((formattedOdds as any)._quotaExhausted) {
        return res.json({ _quotaExhausted: true });
      }

      // Live fallback: if game is live but no live lines found yet, serve pre-game lines
      const liveKeys = Object.keys(formattedOdds).filter(k => k !== "_quotaExhausted");
      if (isInPlay && liveKeys.length === 0) {
        console.log(`[Odds] No live lines for "${playerName}" (${statType}) — falling back to pre-game`);
        formattedOdds = await getPlayerOdds(oddsEventId, playerName as string, statType as string, false);
        if ((formattedOdds as any)._quotaExhausted) {
          return res.json({ _quotaExhausted: true });
        }
      }

      res.json(formattedOdds);
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
      if (!process.env.ODDS_API_KEY) {
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

          players.push({
            playerId: parseInt(athlete.athlete.id, 10),
            playerName: athlete.athlete.displayName,
            teamAbbr: teamAbbr,
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
  const liveSignalsCache = new Map<string, { ts: number; signals: any[] }>();
  const LIVE_SIGNALS_TTL = 45_000;

  app.get("/api/live-signals/:gameId", requireAuth, async (req, res) => {
    const gameId = req.params.gameId as string;
    const cached = liveSignalsCache.get(gameId);
    if (cached && Date.now() - cached.ts < LIVE_SIGNALS_TTL) {
      return res.json({ signals: cached.signals });
    }

    try {
      const ESPN_TO_DB_LOCAL: Record<string, string> = {
        GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
        PHO: "PHX", UTH: "UTA", UTAH: "UTA", WSH: "WAS", CHO: "CHA",
      };
      const normAbbr = (a: string) => ESPN_TO_DB_LOCAL[a.toUpperCase()] ?? a.toUpperCase();
      const normDb = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

      const summaryRes = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
      );
      if (!summaryRes.ok) throw new Error("ESPN summary unavailable");
      const summaryData = await summaryRes.json() as any;

      const boxscore = summaryData.boxscore;
      const header = summaryData.header;
      if (!boxscore || !header) {
        liveSignalsCache.set(gameId, { ts: Date.now(), signals: [] });
        return res.json({ signals: [] });
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
        liveSignalsCache.set(gameId, { ts: Date.now(), signals: [] });
        return res.json({ signals: [] });
      }

      const allDbPlayers = await storage.getPlayers();
      const { getPlayerOdds, resolveOddsEventId, getSGOPlayerLine, getGameLines } = await import("./oddsService");

      let oddsEventId: string | null = null;
      try {
        oddsEventId = await resolveOddsEventId(homeTeamAbbr, awayTeamAbbr);
      } catch { /* continue without odds event ID */ }

      // Fetch game-level spread/total once per game for pace & garbage-time modifiers
      let gameLines: { spread: number | null; total: number | null; favorite: string | null } | null = null;
      if (oddsEventId && process.env.ODDS_API_KEY) {
        try { gameLines = await getGameLines(oddsEventId); } catch { /* optional */ }
      }

      const oddsPlayerCache = new Map<string, { line: number; bookKeys: string[] } | null>();

      const LIVE_STAT_CONFIGS: Array<{ statType: string; components: string[] }> = [
        { statType: "points",      components: ["points"] },
        { statType: "rebounds",    components: ["rebounds"] },
        { statType: "assists",     components: ["assists"] },
        { statType: "threes",      components: ["threes"] },
        { statType: "pts_reb_ast", components: ["points", "rebounds", "assists"] },
      ];

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
          if (minutes < 3) continue;

          const playerName: string = athlete.athlete.displayName ?? "";
          const normPlayerName = normDb(playerName);

          let dbPlayer = allDbPlayers.find(p => normDb(p.name) === normPlayerName);
          if (!dbPlayer) {
            const espnWords = playerName.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/);
            const espnFirst = espnWords[0] ?? "";
            const espnLast = espnWords[espnWords.length - 1] ?? "";
            dbPlayer = allDbPlayers.find(p => {
              const dbWords = p.name.toLowerCase().replace(/[^a-z ]/g, "").trim().split(/\s+/);
              return dbWords[0] === espnFirst && dbWords[dbWords.length - 1] === espnLast;
            });
          }
          if (!dbPlayer) continue;

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
                if (oddsEventId && process.env.ODDS_API_KEY) {
                  let oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, true);
                  let bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
                  if (bookKeys.length === 0) {
                    oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, false);
                    bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
                  }
                  if (bookKeys.length > 0) {
                    const lines = bookKeys.map(k => (oddsResult as any)[k].line as number);
                    const sortedLines = [...lines].sort((a, b) => a - b);
                    const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
                    oddsPlayerCache.set(lineCacheKey, { line: medianLine, bookKeys });
                    resolved = true;
                  }
                }
                if (!resolved && process.env.SGO_API_KEY) {
                  const sgoResult = await getSGOPlayerLine(homeTeamAbbr, awayTeamAbbr, playerName, statType);
                  if (sgoResult !== null) {
                    oddsPlayerCache.set(lineCacheKey, { line: sgoResult, bookKeys: ["sgo"] });
                    resolved = true;
                  }
                }
                if (!resolved) oddsPlayerCache.set(lineCacheKey, null);
              }

              const oddsEntry = oddsPlayerCache.get(lineCacheKey);
              if (!oddsEntry) continue;
              const liveLine = oddsEntry.line;

              

              const result = await storage.calculateProbability({
                playerId: dbPlayer.id,
                opponentTeam: opponentAbbr,
                halftimeMinutes: Math.round(minutes * 10) / 10,
                halftimeFouls: fouls,
                halftimeStat: currentStat,
                liveLine,
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

              const edge = Math.abs(result.probability - 50);
              if (edge < 5) continue;

              allSignals.push({
                playerName: dbPlayer.name,
                playerId: dbPlayer.id,
                statType,
                probability: result.probability,
                betDirection: result.probability > 50 ? "over" : "under",
                edge,
                line: liveLine,
                currentStat,
              });
            } catch { /* skip calc errors silently */ }
          }
        }
      }

      allSignals.sort((a, b) => b.edge - a.edge);
      liveSignalsCache.set(gameId, { ts: Date.now(), signals: allSignals });
      res.json({ signals: allSignals });
    } catch (e) {
      console.warn(`[LiveSignals] Error for game ${gameId}:`, (e as any).message);
      liveSignalsCache.set(gameId, { ts: Date.now(), signals: [] });
      res.json({ signals: [] });
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
    const userId = (req as any).resolvedUserId!;
    const user = await storage.getUserById(userId);
    res.json({ ok: true, playsUsed: user?.playsUsed ?? 0 });
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
  app.get("/api/halftime-plays", requireAuth, async (req, res) => {
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
        const statusDesc: string = status?.type?.description ?? "";

        const clockSeconds = parseClockToSeconds(clock);

        const isHalftime =
          (period === 2 && clockSeconds <= 10) ||
          statusDesc === "Halftime" ||
          statusDesc === "HALF" ||
          statusDesc === "HALFTIME" ||
          (period === 3 && clockSeconds === 720);
        if (!isHalftime) continue;

        console.log("HALFTIME DETECTED:", {
          home: comp?.competitors?.find((c: any) => c.homeAway === "home")?.team?.displayName,
          away: comp?.competitors?.find((c: any) => c.homeAway === "away")?.team?.displayName,
          period: period,
          clock: clock
        });

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

      if (halftimeGames.length === 0) {
        return res.json({ plays: [], message: "No games at halftime right now." });
      }

      // Load all DB players once — avoid repeated DB calls per athlete
      const allDbPlayers = await storage.getPlayers();
      const normDb = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

      // Cache Odds API event IDs and player odds per game to avoid redundant calls
      const oddsCache = new Map<string, Map<string, number | null>>();

      const allPlays: any[] = [];
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
        const oddsPlayerCache = new Map<string, { line: number; bookKeys: string[] } | null>(); // "playerName|statType" → { line, bookKeys }
        try {
          const { resolveOddsEventId: resolveId } = await import("./oddsService");
          oddsEventId = await resolveId(game.homeTeamAbbr, game.awayTeamAbbr);
        } catch { /* continue without odds */ }

        // Fetch game-level spread/total for pace & garbage-time modifiers
        let htGameLines: { spread: number | null; total: number | null; favorite: string | null } | null = null;
        if (oddsEventId && process.env.ODDS_API_KEY) {
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
                const lineCacheKey = `${playerName}|${statType}`;
                if (!oddsPlayerCache.has(lineCacheKey)) {
                  try {
                    let resolved = false;

                    // Source 1 & 2: The Odds API (live in-play, then pre-game)
                    if (oddsEventId && process.env.ODDS_API_KEY) {
                      let oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, true);
                      let bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
                      if (bookKeys.length === 0) {
                        oddsResult = await getPlayerOdds(oddsEventId, playerName, statType, false);
                        bookKeys = Object.keys(oddsResult).filter(k => !k.startsWith("_"));
                        if (bookKeys.length > 0) console.log(`[Halftime] Pre-game line for ${playerName} (${statType})`);
                      }
                      if (bookKeys.length > 0) {
                        const books = bookKeys.map(k => (oddsResult as any)[k]);
                        const lines = books.map((b: any) => b.line as number);
                        // Log every book → line so data integrity issues are visible
                        const lineDetail = bookKeys.map((k, i) => `${k}=${lines[i]}`).join(" | ");
                        console.log(`[Halftime] Lines for ${playerName} (${statType}): ${lineDetail}`);
                        // Use median consensus — never pick extremes which amplify outlier/stale book data
                        const sortedLines = [...lines].sort((a, b) => a - b);
                        const medianLine = sortedLines[Math.floor(sortedLines.length / 2)];
                        oddsPlayerCache.set(lineCacheKey, { line: medianLine, bookKeys });
                        resolved = true;
                      }
                    }

                    // Source 3: SGO NBA (works independently of Odds API event ID)
                    if (!resolved && process.env.SGO_API_KEY) {
                      const sgoResult = await getSGOPlayerLine(game.homeTeamAbbr, game.awayTeamAbbr, playerName, statType);
                      if (sgoResult !== null) {
                        console.log(`[Halftime] SGO line for ${playerName} (${statType}): ${sgoResult}`);
                        oddsPlayerCache.set(lineCacheKey, { line: sgoResult, bookKeys: ["sgo"] });
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
                } else {
                  continue; // No real line available — never fabricate one
                }

                // Skip plays where the line has already been cleared at halftime —
                // these are not actionable (over already won, under already lost).
                // Check BEFORE running calculateProbability to save compute cost.
                if (halftimeStat >= liveLine) continue;

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

                // Minimum edge threshold of 10 (was 5). The tighter filter eliminates
                // marginal 55-65% signals that were padding the 70-79% display bucket
                // without genuine statistical edge after the regression corrections above.
                const edge = Math.abs(result.probability - 50);
                if (edge < 10) continue;

                const cacheKey2 = `${playerName}|${statType}`;
                const oddsEntry2 = oddsPlayerCache.get(cacheKey2);
                allPlays.push({
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
                  probability: result.probability,
                  edge,
                  expectedTotal: result.expectedTotal,
                  betDirection: result.probability > 50 ? "over" : "under",
                });
              } catch {
                // skip calc errors silently
              }
            }
          }
        }
      }

      // Balance OVER/UNDER play selection — split into overs and unders,
      // take up to 10 from each, then merge for final ranking.
      const overs = allPlays.filter(p => p.betDirection === "over").sort((a, b) => b.edge - a.edge).slice(0, 10);
      const unders = allPlays.filter(p => p.betDirection === "under").sort((a, b) => b.edge - a.edge).slice(0, 10);
      const balancedPlays = [...overs, ...unders];
      // Sort merged list by edge descending (highest edge = most confident call)
      balancedPlays.sort((a, b) => b.edge - a.edge);
      const topPlays = balancedPlays.slice(0, 20);
      res.json({ plays: topPlays });
      // Fire-and-forget: alerts + persist plays for analytics
      checkAndSendAlerts(topPlays, storage).catch(console.warn);
      storage.savePlayAlerts(topPlays).catch(console.warn);
      // Persist each play to persisted_plays table
      const today = new Date().toISOString().slice(0, 10);
      for (const p of topPlays) {
        const key = `${p.playerId ?? p.playerName}|${p.statType}|${p.line}|${p.betDirection}|${p.gameId ?? ""}|${today}`;
        storage.recordPlay({
          id: `play-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          gameId: p.gameId ?? "",
          playerId: p.playerId ? String(p.playerId) : undefined,
          playerName: p.playerName,
          team: p.team,
          sport: "nba",
          market: p.statType,
          direction: p.betDirection,
          line: Number(p.line),
          prob: Number(p.probability ?? p.prob ?? 50),
          engineProb: p.engineProb != null ? Number(p.engineProb) : undefined,
          bookImplied: p.bookImplied != null ? Number(p.bookImplied) : undefined,
          edgeGap: p.edge != null ? Number(p.edge) : undefined,
          gameDate: today,
          timestamp: new Date(),
          duplicateGuard: key,
        }).catch(console.warn);
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
            const match = dbPlayers.find(p => normRA(p.name) === normRA(name));
            if (match && !seen.has(match.id)) {
              seen.add(match.id);
              if (match.team !== dbTeam) { await storage.updatePlayerStats(match.id, { team: dbTeam } as any); match.team = dbTeam; updated++; }
              else skipped++;
            } else if (!match) {
              await storage.createPlayer({ name, team: dbTeam, position: pos, avgMinutes: "20.0", avgFouls: "2.0" });
              dbPlayers.push({ id: -1, name, team: dbTeam, position: pos, avgMinutes: "20.0", avgFouls: "2.0" } as any);
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

async function seedDatabase() {
  const existingPlayers = await storage.getPlayers();

  // Auto-trigger stats sync on startup if any player lacks stats
  if (existingPlayers.length > 0 && existingPlayers.some(p => !p.ppg)) {
    console.log("[startup] Detected players with null stats — triggering full stat sync in background…");
    runFullStatSync().catch(console.error);
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
      const today = new Date().toISOString().slice(0, 10);
      const duplicateGuard = body.duplicateGuard ??
        `${body.playerId ?? body.playerName}|${body.market}|${body.line}|${body.direction}|${body.gameId ?? ""}|${today}`;
      const id = body.id ?? `play-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const result = await storage.recordPlay({
        id,
        gameId: body.gameId ?? "",
        playerId: body.playerId,
        playerName: body.playerName,
        team: body.team,
        sport: body.sport ?? "nba",
        market: body.market,
        direction: body.direction,
        line: Number(body.line),
        prob: Number(body.prob),
        engineProb: body.engineProb != null ? Number(body.engineProb) : undefined,
        bookImplied: body.bookImplied != null ? Number(body.bookImplied) : undefined,
        edgeGap: body.edgeGap != null ? Number(body.edgeGap) : undefined,
        gameDate: body.gameDate ?? today,
        timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
        duplicateGuard,
      });
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

// Analytics routes (admin only)
export function registerAnalyticsRoutes(app: Express): void {
  app.get("/api/analytics/summary", requireAdmin, async (req, res) => {
    try {
      const range = (req.query.range as string) || "all";
      const validRanges = ["today", "yesterday", "7d", "30d", "all"];
      const effectiveRange = validRanges.includes(range) ? range as "today" | "yesterday" | "7d" | "30d" | "all" : "all";
      const summary = await storage.getAnalyticsSummary(effectiveRange);
      res.json(summary);
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
}
