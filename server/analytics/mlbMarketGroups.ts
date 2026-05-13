// ─────────────────────────────────────────────────────────────────────────────
// MLB analytics market groupings — single source of truth for which markets
// roll up into the "MLB Core ROI" / "Primary MLB ROI" headline vs. which
// belong to admin-only diagnostic lanes.
//
// Spec (LiveLocks Phase 1, Analytics Integrity):
//   PRIMARY_MLB_ROI_MARKETS       — counted in headline ROI / hit rate / calibration
//   EXCLUDED_FROM_PRIMARY_MLB_ROI — explicitly removed from the headline (defensive net for legacy plays)
//   HR_RADAR_ANALYTICS_MARKETS    — admin-only HR Radar performance lane
//
// `home_runs` is no longer produced by the per-AB engine — HR Radar owns the
// entire HR analytics surface (alerts, lifecycle, settlement) and continues
// to persist its plays under the `home_runs` market label. The HR Radar
// admin lane reads those rows. `batter_strikeouts` is fully deprecated and
// has no analytics lane.
//
// Hard rules:
//   - This file MUST NOT be imported by engine math, signal generation, the
//     HR Radar pipeline, or NBA/NCAAB analytics. It is purely a query-layer
//     classification of MLB markets for analytics surfaces.
//   - Persisted plays are NEVER deleted or mutated based on these groupings —
//     they only filter how rows roll up into headline ROI vs. side lanes.
//   - Canonical market keys come from `shared/normalizeMlbMarket.ts`. If a
//     market alias is added there, this file must be updated to match.
// ─────────────────────────────────────────────────────────────────────────────

export type MlbMarketAnalyticsGroup =
  | "primary_mlb_roi"
  | "hr_radar"
  | "other";

/**
 * Markets that count toward the user-facing "MLB Core ROI" headline. Must
 * mirror the canonical keys used by the engine + persisted_plays.market.
 */
export const PRIMARY_MLB_ROI_MARKETS: readonly string[] = Object.freeze([
  "hits",
  "total_bases",
  "hrr",
  "hits_allowed",
  "pitcher_outs",
  "pitcher_strikeouts",
  "hr_allowed",
]);

/**
 * Markets explicitly excluded from primary MLB ROI / hit rate / calibration.
 * Defensive net: ANY persisted_play (including legacy rows) carrying these
 * markets is filtered out of headline ROI. Going forward neither market is
 * produced by the engine — `home_runs` is owned exclusively by HR Radar and
 * `batter_strikeouts` is fully deprecated.
 */
export const EXCLUDED_FROM_PRIMARY_MLB_ROI: readonly string[] = Object.freeze([
  "home_runs",
  "batter_strikeouts",
]);

/** Admin-only HR Radar analytics lane (Unified Analytics card). */
export const HR_RADAR_ANALYTICS_MARKETS: readonly string[] = Object.freeze([
  "home_runs",
]);

/** Returns true iff the market counts toward the primary MLB ROI headline. */
export function isPrimaryMlbRoiMarket(market: string | null | undefined): boolean {
  if (!market) return false;
  return PRIMARY_MLB_ROI_MARKETS.includes(market);
}

/** Returns true iff the market is explicitly excluded from primary MLB ROI. */
export function isExcludedFromPrimaryMlbRoi(market: string | null | undefined): boolean {
  if (!market) return false;
  return EXCLUDED_FROM_PRIMARY_MLB_ROI.includes(market);
}

/**
 * Classify an MLB market into its analytics lane. Markets that neither sit in
 * the primary headline nor the named exclusion lanes are reported as "other"
 * so dashboards can surface anything new the engine starts emitting without
 * silently folding it into the headline.
 */
export function getMlbMarketAnalyticsGroup(
  market: string | null | undefined,
): MlbMarketAnalyticsGroup {
  if (!market) return "other";
  if (HR_RADAR_ANALYTICS_MARKETS.includes(market)) return "hr_radar";
  if (PRIMARY_MLB_ROI_MARKETS.includes(market)) return "primary_mlb_roi";
  return "other";
}

/**
 * Filter MLB plays down to those that belong in the primary ROI headline.
 * Non-MLB rows are passed through untouched so callers can hand a mixed-sport
 * play list in safely.
 */
export function filterPrimaryMlbRoiPlays<T extends { market?: string | null; sport?: string | null }>(
  plays: T[],
): T[] {
  return plays.filter((p) => {
    const sport = (p.sport ?? "").toLowerCase();
    if (sport && sport !== "mlb") return true;
    return !isExcludedFromPrimaryMlbRoi(p.market ?? null);
  });
}

/** Analytics scope tag emitted alongside `[ANALYTICS_QUERY]` log lines. */
export type AnalyticsScope = "primary_mlb_roi" | "hr_radar" | "full";

/**
 * Structured log emitted by every MLB analytics endpoint so observability can
 * confirm exclusion is applied at the right surface. Mirrors the shape of
 * `[ROI_FILTER_APPLIED]` from roiEngine but with sport + scope explicit.
 */
export function logAnalyticsQuery(meta: {
  surface: string;
  sport: string;
  analyticsScope: AnalyticsScope;
  includedMarkets: readonly string[];
  excludedMarkets: readonly string[];
  totalPlays?: number;
  retainedPlays?: number;
}): void {
  console.log("[ANALYTICS_QUERY]", {
    surface: meta.surface,
    sport: meta.sport,
    analyticsScope: meta.analyticsScope,
    includedMarkets: meta.includedMarkets,
    excludedMarkets: meta.excludedMarkets,
    totalPlays: meta.totalPlays,
    retainedPlays: meta.retainedPlays,
  });
}
