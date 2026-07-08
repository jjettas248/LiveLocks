// Pre-Game Power Radar — stats endpoints registrar.
//
// Kept isolated from the engine and settlement modules. `server/routes.ts` should
// call registerPregameRadarStatsRoutes(app, { requireMLBAccess, requireAdmin })
// next to the existing pregame routes.

import type { Express, RequestHandler } from "express";
import { slateDateET } from "../../utils/dateUtils";
import { getPregameRadarCalibrationStats, getPregameRadarPublicStats } from "./statsService";

export function registerPregameRadarStatsRoutes(
  app: Express,
  guards: { requireMLBAccess: RequestHandler; requireAdmin: RequestHandler },
): void {
  app.get("/api/mlb/pregame-radar/record", guards.requireMLBAccess, async (req, res) => {
    try {
      // Default to the slate day (6am-ET rollover) — matches the sessionDate
      // stamped on every pregame signal, so post-midnight grades still land on
      // the slate that is actually in play.
      const dateET = String(req.query.date ?? slateDateET());
      const stats = await getPregameRadarPublicStats(dateET);
      return res.json(stats);
    } catch (err: any) {
      console.error("[PREGAME_RADAR_RECORD_ROUTE_FAILED]", err?.message ?? err, err?.stack);
      return res.json({
        dateET: String(req.query.date ?? slateDateET()),
        pregameWinsToday: 0,
        firstAbPregameWinsToday: 0,
        pregameWinsLast7Days: 0,
        firstAbPregameWinsLast7Days: 0,
        flaggedBeforeFirstPitchToday: 0,
        topPregameWinPlayers: [],
        degraded: true,
      });
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
