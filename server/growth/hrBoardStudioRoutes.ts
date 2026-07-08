// ─────────────────────────────────────────────────────────────────────────────
// HR Board Studio — admin API routes (all gated by requireAdmin)
//
// Thin route layer: validates input, delegates to the service, and records
// workflow analytics. No engine state is mutated anywhere in this file.
// ─────────────────────────────────────────────────────────────────────────────

import type { Express } from "express";
import { requireAdmin } from "../auth";
import { todayET } from "../utils/dateUtils";
import {
  getTodayBoard,
  getMovementFeed,
  generateContentPack,
  generateRecap,
  getLiveBestContacts,
} from "./hrBoardStudioService";
import {
  recordHrBoardEvent,
  getHrBoardSummary,
} from "./hrBoardAnalytics";
import {
  HR_BOARD_ANALYTICS_EVENT_TYPES,
  type HrBoardAnalyticsEventType,
} from "../../shared/hrBoardStudio";

/** Default CTA link when the admin enables links but doesn't supply a URL. */
const DEFAULT_BOARD_LINK = "https://www.livelocksai.app";

export function registerHrBoardStudioRoutes(app: Express): void {
  // GET today's pre-game HR board rows.
  app.get("/api/admin/hr-board-studio/today", requireAdmin, async (req, res) => {
    try {
      const forceFresh = req.query.fresh === "1" || req.query.fresh === "true";
      const payload = await getTodayBoard(forceFresh);
      return res.json(payload);
    } catch (err: any) {
      console.error("[admin/hr-board-studio/today]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to load HR board" });
    }
  });

  // POST generate today's content pack (does not post anywhere).
  app.post("/api/admin/hr-board-studio/generate-pack", requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { includeLink?: unknown; link?: unknown };
      const includeLink = body.includeLink === true;
      const suppliedLink =
        typeof body.link === "string" && body.link.trim() ? body.link.trim() : null;
      // When links are enabled but none is supplied, default to the brand site.
      const link = includeLink ? suppliedLink ?? DEFAULT_BOARD_LINK : null;
      const pack = await generateContentPack({ includeLink, link });
      recordHrBoardEvent({
        eventType: "hr_board_pack_generated",
        date: pack.date,
        count: pack.assets.length,
      });
      if (includeLink) {
        recordHrBoardEvent({ eventType: "hr_board_link_toggle_enabled", date: pack.date });
      }
      return res.json(pack);
    } catch (err: any) {
      console.error("[admin/hr-board-studio/generate-pack]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to generate content pack" });
    }
  });

  // GET live movement feed from the pre-game board.
  app.get("/api/admin/hr-board-studio/movement-feed", requireAdmin, async (_req, res) => {
    try {
      const feed = await getMovementFeed();
      return res.json(feed);
    } catch (err: any) {
      console.error("[admin/hr-board-studio/movement-feed]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to load movement feed" });
    }
  });

  // GET today's live Best Contacts (top Attack/Ready HR Radar signals, ranked by score).
  app.get("/api/admin/hr-board-studio/live-best-contacts", requireAdmin, async (req, res) => {
    try {
      const parsedLimit = parseInt(String(req.query.limit ?? "5"), 10);
      const limit = Math.max(1, Math.min(10, Number.isFinite(parsedLimit) ? parsedLimit : 5));
      const payload = await getLiveBestContacts(limit);
      return res.json(payload);
    } catch (err: any) {
      console.error("[admin/hr-board-studio/live-best-contacts]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to load live best contacts" });
    }
  });

  // POST generate postgame recap assets for the selected date.
  app.post("/api/admin/hr-board-studio/generate-recap", requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { date?: unknown };
      const date =
        typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
          ? body.date
          : todayET();
      const recap = await generateRecap(date);
      recordHrBoardEvent({
        eventType: "hr_recap_generated",
        date: recap.date,
        count: recap.assets.length,
      });
      return res.json(recap);
    } catch (err: any) {
      console.error("[admin/hr-board-studio/generate-recap]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to generate recap" });
    }
  });

  // POST record an admin copy/download/generate/view action for analytics.
  app.post("/api/admin/hr-board-studio/log-action", requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const event = body.event;
      if (
        typeof event !== "string" ||
        !HR_BOARD_ANALYTICS_EVENT_TYPES.includes(event as HrBoardAnalyticsEventType)
      ) {
        return res.status(400).json({ error: "Invalid analytics event" });
      }
      recordHrBoardEvent({
        eventType: event as HrBoardAnalyticsEventType,
        date: typeof body.date === "string" ? body.date : undefined,
        assetType: (body.assetType as any) ?? null,
        template: (body.template as any) ?? null,
        player: typeof body.player === "string" ? body.player : null,
        signalId: typeof body.signalId === "string" ? body.signalId : null,
        count: typeof body.count === "number" ? body.count : null,
      });
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[admin/hr-board-studio/log-action]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to log action" });
    }
  });

  // GET the admin workflow summary (read-only rollup of the analytics buffer).
  app.get("/api/admin/hr-board-studio/analytics", requireAdmin, async (req, res) => {
    try {
      const date = typeof req.query.date === "string" ? req.query.date : todayET();
      let movementAssetsAvailable = 0;
      try {
        const feed = await getMovementFeed();
        movementAssetsAvailable = feed.movements.length;
      } catch {
        /* movement feed is best-effort for the summary */
      }
      const summary = getHrBoardSummary({ date, movementAssetsAvailable });
      return res.json(summary);
    } catch (err: any) {
      console.error("[admin/hr-board-studio/analytics]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to load analytics summary" });
    }
  });
}
