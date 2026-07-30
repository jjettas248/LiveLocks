// Mound Radar — stats endpoints registrar.
//
// Kept isolated from the engine and settlement modules. `server/routes.ts`
// calls registerMoundRadarStatsRoutes(app, { requireMLBAccess, requireAdmin })
// next to the existing pregame/mound-hub routes.

import type { Express, RequestHandler } from "express";
import { slateDateET } from "../../../utils/dateUtils";
import { getMoundRadarCalibrationStats, getMoundRadarPublicStats } from "./moundStatsService";
import { gatherMoundV2ComparisonReport, gatherMoundV2PromotionReadiness } from "./v2/moundV2ComparisonGatherer";
import { gatherMoundV2ShadowGradingCoverageReport } from "./v2/moundV2ShadowReconciliationSweep";
import { gatherMoundOfficialFirewallMeasurement } from "./moundOfficialFirewallGate";

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

  // Mound V2 promotion-readiness evidence — Part 7. Evidence + a criteria
  // verdict ONLY; this endpoint cannot promote anything, and nothing is
  // triggered by hitting it. Fails closed: regressionDetected defaults to
  // true (blocked) unless the caller explicitly asserts "false" — there is
  // no live runtime monitor for a V2-caused regression today, so a human
  // reviewing the structural evidence (moundV2ShadowWiring.test.ts +
  // moundV2Engine.test.ts's isolation check) must consciously pass
  // ?regressionDetected=false to even attempt clearing that blocker.
  //   ?date=YYYY-MM-DD          single slate day
  //   ?from=YYYY-MM-DD&to=...   inclusive range
  //   ?regressionDetected=false lifts the fail-closed regression blocker (explicit opt-in only)
  //   ?comparator=climatology|market_implied  which non-V1 probability reference to score against (default climatology)
  app.get("/api/admin/mlb/mound-v2-promotion-readiness", guards.requireAdmin, async (req, res) => {
    try {
      const today = slateDateET();
      const single = req.query.date != null ? String(req.query.date) : null;
      const from = single ?? (req.query.from != null ? String(req.query.from) : today);
      const to = single ?? (req.query.to != null ? String(req.query.to) : today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "date/from/to must be YYYY-MM-DD" });
      }
      if (from > to) return res.status(400).json({ error: "from must not be after to" });
      const settlementOrProvenanceRegressionDetected = req.query.regressionDetected !== "false";
      const probabilityComparator = req.query.comparator === "market_implied" ? "market_implied" : "climatology";
      const result = await gatherMoundV2PromotionReadiness({
        windowStart: from,
        windowEnd: to,
        probabilityComparator,
        settlementOrProvenanceRegressionDetected,
      });
      return res.json(result);
    } catch (err: any) {
      console.error("[admin/mlb/mound-v2-promotion-readiness]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to build Mound V2 promotion readiness evidence" });
    }
  });

  // Mound V2 (shadow) grading coverage/reconciliation report — Correction 3.
  // Admin-only, read-only diagnostic: pending completed games, oldest
  // pending prediction, grading coverage ratio, provider-failure count,
  // unresolved pitcher identities, and suspended/postponed counts. Nothing
  // is triggered by hitting this endpoint — it only lists and reports.
  //   ?from=ISO&to=ISO   optional evaluationTimestamp window (defaults to no bound = all rows, bounded internally to 5000)
  app.get("/api/admin/mlb/mound-v2-grading-coverage", guards.requireAdmin, async (req, res) => {
    try {
      const from = req.query.from != null ? new Date(String(req.query.from)) : undefined;
      const to = req.query.to != null ? new Date(String(req.query.to)) : undefined;
      if (from && Number.isNaN(from.getTime())) return res.status(400).json({ error: "from must be a valid ISO timestamp" });
      if (to && Number.isNaN(to.getTime())) return res.status(400).json({ error: "to must be a valid ISO timestamp" });
      const report = await gatherMoundV2ShadowGradingCoverageReport({ fromEvaluationTimestamp: from, toEvaluationTimestamp: to });
      return res.json(report);
    } catch (err: any) {
      console.error("[admin/mlb/mound-v2-grading-coverage]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to build Mound V2 grading coverage report" });
    }
  });

  // Phase 1 official-recommendation-firewall MEASUREMENT for Mound's own
  // (V1) publication path — Part 8. Diagnostic only: never suppresses,
  // blocks, or changes what Mound actually publishes. Gated behind
  // MOUND_OFFICIAL_FIREWALL_MEASUREMENT_ENABLED (default off) — with the
  // flag off this returns measurementEnabled:false and fetches nothing.
  //   ?date=YYYY-MM-DD          single slate day
  //   ?from=YYYY-MM-DD&to=...   inclusive range
  app.get("/api/admin/mlb/mound-official-firewall-measurement", guards.requireAdmin, async (req, res) => {
    try {
      const today = slateDateET();
      const single = req.query.date != null ? String(req.query.date) : null;
      const from = single ?? (req.query.from != null ? String(req.query.from) : today);
      const to = single ?? (req.query.to != null ? String(req.query.to) : today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: "date/from/to must be YYYY-MM-DD" });
      }
      if (from > to) return res.status(400).json({ error: "from must not be after to" });
      const result = await gatherMoundOfficialFirewallMeasurement({ windowStart: from, windowEnd: to });
      return res.json(result);
    } catch (err: any) {
      console.error("[admin/mlb/mound-official-firewall-measurement]", err?.message ?? err);
      return res.status(500).json({ error: "Failed to build Mound official-firewall measurement" });
    }
  });
}
