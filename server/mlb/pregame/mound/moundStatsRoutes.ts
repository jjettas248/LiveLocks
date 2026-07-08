// Mound Radar — stats endpoints registrar.
//
// Kept isolated from the engine and settlement modules. `server/routes.ts`
// calls registerMoundRadarStatsRoutes(app, { requireMLBAccess, requireAdmin })
// next to the existing pregame/mound-hub routes.

import type { Express, RequestHandler } from "express";
import { slateDateET } from "../../../utils/dateUtils";
import { getMoundRadarCalibrationStats, getMoundRadarPublicStats } from "./moundStatsService";

export function registerMoundRadarStatsRoutes(
  app: Express,
  guards: { requireMLBAccess: RequestHandler; requireAdmin: RequestHandler },
): void {
  app.get("/api/mlb/mound-radar/record", guards.requireMLBAccess, async (req, res) => {
    try {
      const dateET = String(req.query.date ?? slateDateET());
      const stats = await getMoundRadarPublicStats(dateET);
      return res.json(stats);
    } catch (err: any) {
      console.error("[mlb/mound-radar/record]", err?.message ?? err);
      return res.json({
        dateET: String(req.query.date ?? slateDateET()),
        moundWinsToday: 0,
        pitcherPropsCashedToday: 0,
        moundWinsLast7Days: 0,
        flaggedBeforeFirstPitchToday: 0,
        topMoundWinPlayers: [],
        moundFadeWinsToday: 0,
        fadePropsCashedToday: 0,
        moundFadeWinsLast7Days: 0,
        flaggedFadeBeforeFirstPitchToday: 0,
        topMoundFadeWinPlayers: [],
      });
    }
  });

  app.get("/api/admin/mlb/mound-radar/calibration", guards.requireAdmin, async (req, res) => {
    try {
      const rawDays = Number(req.query.days ?? 7);
      const days = Number.isFinite(rawDays) ? rawDays : 7;
      const stats = await getMoundRadarCalibrationStats(days);
      return res.json(stats);
    } catch (err: any) {
      console.error("[admin/mlb/mound-radar/calibration]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to fetch mound radar calibration stats" });
    }
  });
}
