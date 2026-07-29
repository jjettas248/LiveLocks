// Mound Radar — stats endpoints registrar.
//
// Kept isolated from the engine and settlement modules. `server/routes.ts`
// calls registerMoundRadarStatsRoutes(app, { requireMLBAccess, requireAdmin })
// next to the existing pregame/mound-hub routes.

import type { Express, RequestHandler } from "express";
import { slateDateET } from "../../../utils/dateUtils";
import { getMoundRadarCalibrationStats, getMoundRadarPublicStats } from "./moundStatsService";
import { gatherMoundV2ComparisonReport } from "./v2/moundV2ComparisonGatherer";

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

  // Mound V2 (shadow) vs V1 comparison — Flagship Program Phase 2, Part 6.
  // Admin-only, read-only. V2 has zero production authority; this exists
  // purely to produce evidence for the promotion gate (moundV2PromotionGate.ts).
  //   ?date=YYYY-MM-DD          single slate day
  //   ?from=YYYY-MM-DD&to=...   inclusive range
  app.get("/api/admin/mlb/mound-v2-comparison", guards.requireAdmin, async (req, res) => {
    try {
      const today = slateDateET();
      const single = req.query.date != null ? String(req.query.date) : null;
      const from = single ?? (req.query.from != null ? String(req.query.from) : today);
      const to = single ?? (req.query.to != null ? String(req.query.to) : today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "date/from/to must be YYYY-MM-DD" });
      }
      if (from > to) return res.status(400).json({ error: "from must not be after to" });
      const report = await gatherMoundV2ComparisonReport({ windowStart: from, windowEnd: to });
      return res.json(report);
    } catch (err: any) {
      console.error("[admin/mlb/mound-v2-comparison]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to build Mound V2 comparison report" });
    }
  });
}
