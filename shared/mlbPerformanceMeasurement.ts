// ── MLB Performance Measurement Contract (transport shapes) ───────────────
// Pure result shapes for the frozen-episode-based measurement contract. The
// actual math lives server-side in server/mlb/episodes/mlbEpisodeMeasurement.ts
// and is NEVER computed client-side (CLAUDE.md: "UI never calculates
// projections, probabilities, grades, or settlement" — the same applies to
// performance stats; the client renders this shape verbatim).

import type { MlbRecommendationProduct } from "./mlbRecommendationEpisode";

export interface MlbPerformanceMetrics {
  sampleSize: number;               // count of official episodes in scope
  settledCount: number;             // count with status === "settled"
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  winRate: number | null;           // wins / (wins+losses); null if nothing decided
  unitsWonLost: number;             // sum of captured-price payouts, real American odds
  roi: number | null;               // unitsWonLost / staked-unit-count; null if nothing staked
  brierScore: number | null;        // decided (cashed/missed) settlements only
  logLoss: number | null;           // decided settlements only
  calibrationError: number | null;  // expected calibration error (ECE), decided settlements only
  coverage: number;                 // settledCount / sampleSize (0 when sampleSize is 0)
  clv: number | null;               // null unless closing prices were supplied for this window
}

export type MlbPerformanceBreakdownDimension =
  | "product" | "market" | "side" | "setupGrade" | "modelVersion"
  | "gamePhase" | "dataQuality";

export interface MlbPerformanceBreakdownRow {
  dimension: MlbPerformanceBreakdownDimension;
  key: string;
  metrics: MlbPerformanceMetrics;
}

export interface MlbPerformanceReport {
  windowStart: string | null;
  windowEnd: string | null;
  overall: MlbPerformanceMetrics;
  byProduct: MlbPerformanceBreakdownRow[];
  byMarket: MlbPerformanceBreakdownRow[];
  bySide: MlbPerformanceBreakdownRow[];
  bySetupGrade: MlbPerformanceBreakdownRow[];
  byModelVersion: MlbPerformanceBreakdownRow[];
  byGamePhase: MlbPerformanceBreakdownRow[];
  byDataQuality: MlbPerformanceBreakdownRow[];
}

export const MLB_PRODUCTS_FOR_MEASUREMENT: readonly MlbRecommendationProduct[] = ["plate", "mound", "live_edge"];
