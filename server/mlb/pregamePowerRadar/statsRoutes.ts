// Pre-Game Power Radar — stats endpoints registrar.
//
// Kept isolated from the engine and settlement modules. `server/routes.ts` should
// call registerPregameRadarStatsRoutes(app, { requireMLBAccess, requireAdmin })
// next to the existing pregame routes.

import type { Express, RequestHandler } from "express";
import { slateDateET } from "../../utils/dateUtils";
import { getPlateModelComparison, getPregameRadarCalibrationStats, getPregameRadarPublicStats } from "./statsService";

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

  // Champion vs challenger comparison. Admin-only, read-only, no public
  // surface — the challenger has no production authority and must not appear
  // anywhere a user can see.
  //   ?date=YYYY-MM-DD          single slate day
  //   ?from=YYYY-MM-DD&to=...   inclusive range
  app.get("/api/admin/mlb/plate-model-comparison", guards.requireAdmin, async (req, res) => {
    try {
      const today = slateDateET();
      const single = req.query.date != null ? String(req.query.date) : null;
      const from = single ?? (req.query.from != null ? String(req.query.from) : today);
      const to = single ?? (req.query.to != null ? String(req.query.to) : today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "date/from/to must be YYYY-MM-DD" });
      }
      if (from > to) return res.status(400).json({ error: "from must not be after to" });
      const report = await getPlateModelComparison(from, to);
      return res.json(report);
    } catch (err: any) {
      console.error("[admin/mlb/plate-model-comparison]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to build plate model comparison" });
    }
  });
}
