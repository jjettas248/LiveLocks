// Pre-Game Power Radar — stats endpoints registrar.
//
// Kept isolated from the engine and settlement modules. `server/routes.ts` should
// call registerPregameRadarStatsRoutes(app, { requireMLBAccess, requireAdmin })
// next to the existing pregame routes.

import type { Express, RequestHandler } from "express";
import { todayET } from "../../utils/dateUtils";
import {
  getPregameRadarCalibrationStats,
  getPregameRadarPublicStats,
  getPregameRadarDailyHistory,
} from "./statsService";

export function registerPregameRadarStatsRoutes(
  app: Express,
  guards: { requireMLBAccess: RequestHandler; requireAdmin: RequestHandler },
): void {
  app.get("/api/mlb/pregame-radar/record", guards.requireMLBAccess, async (req, res) => {
    try {
      const dateET = String(req.query.date ?? todayET());
      const stats = await getPregameRadarPublicStats(dateET);
      return res.json(stats);
    } catch (err: any) {
      console.error("[mlb/pregame-radar/record]", err?.message ?? err);
      return res.json({
        dateET: String(req.query.date ?? todayET()),
        pregameWinsToday: 0,
        firstAbPregameWinsToday: 0,
        pregameWinsLast7Days: 0,
        firstAbPregameWinsLast7Days: 0,
        flaggedBeforeFirstPitchToday: 0,
        topPregameWinPlayers: [],
      });
    }
  });

  app.get("/api/mlb/pregame-radar/history", guards.requireMLBAccess, async (req, res) => {
    try {
      const rawDays = Number(req.query.days ?? 14);
      const days = Number.isFinite(rawDays) ? rawDays : 14;
      const history = await getPregameRadarDailyHistory(days);
      return res.json(history);
    } catch (err: any) {
      console.error("[mlb/pregame-radar/history]", err?.message ?? err);
      return res.json([]);
    }
  });

  app.get("/api/admin/mlb/pregame-radar/calibration", guards.requireAdmin, async (req, res) => {
    try {
      const rawDays = Number(req.query.days ?? 7);
      const days = Number.isFinite(rawDays) ? rawDays : 7;
      const stats = await getPregameRadarCalibrationStats(days);
      return res.json(stats);
    } catch (err: any) {
      console.error("[admin/mlb/pregame-radar/calibration]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to fetch pregame radar calibration stats" });
    }
  });
}
