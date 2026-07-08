// ─────────────────────────────────────────────────────────────────────────────
// HR Board Studio — shared transport contract (client + server)
//
// Admin-only growth/conversion layer that turns the existing Pre-Game HR Power
// Board into a daily content + movement + recap workflow. This module is purely
// additive and read-only with respect to the engine:
//   • It NEVER mutates HR Radar math, MLB probability logic, the signal bus, or
//     any canonical/lifecycle field. It reads server-stamped engine output.
//   • No projections/confidence are recomputed — the studio renders engine
//     output and packages it into X-native, no-link content assets.
//
// Types live in `shared/` so the admin UI and the API speak the same contract.
// ─────────────────────────────────────────────────────────────────────────────

import type { PregamePowerTier } from "../server/mlb/pregamePowerRadar/types";

/** The eight content asset types the studio can generate. */
export type HrBoardAssetType =
  | "daily_board"
  | "top_player_spotlight"
  | "top3_watchlist"
  | "movement_alert"
  | "ready_fire_alert"
  | "cashed_proof"
  | "near_miss_transparency"
  | "postgame_recap"
  | "live_best_contacts";

export const HR_BOARD_ASSET_LABELS: Record<HrBoardAssetType, string> = {
  daily_board: "Daily Board Post",
  top_player_spotlight: "Top Player Spotlight",
  top3_watchlist: "Top 3 Watchlist",
  movement_alert: "Movement Alert",
  ready_fire_alert: "Playable/Attack Alert",
  cashed_proof: "Cashed Proof",
  near_miss_transparency: "Near-Miss Transparency",
  postgame_recap: "Postgame Recap",
  live_best_contacts: "Best Contacts of the Day",
};

/** Image template families (structured payload for future rendering). */
export type HrBoardImageTemplate =
  | "daily_board"
  | "spotlight"
  | "movement"
  | "proof"
  | "recap";

export interface HrBoardImageRow {
  rank?: number;
  player: string;
  team?: string;
  score?: number;
  stage?: string;
  drivers?: string[];
}

/** Brand identity used across every studio asset (handle + site watermark). */
export const HR_BOARD_BRAND_HANDLE = "@LiveLocksAI" as const;
export const HR_BOARD_BRAND_SITE = "www.livelocksai.app" as const;
export const HR_BOARD_BRAND_HASHTAG = "#LiveLocks" as const;

/**
 * Structured image payload — no external image service required. The UI renders
 * this as a styled card; screenshot/export tooling can consume it later.
 */
export interface HrBoardImagePayload {
  template: HrBoardImageTemplate;
  title: string;
  subtitle?: string;
  rows?: HrBoardImageRow[];
  footer: string;
  brand: "LiveLocks HR Power Board";
  /** Brand handle watermark for the rendered card (e.g. "@LiveLocksAI"). */
  handle?: string;
  /** Brand site watermark for the rendered card (e.g. "www.livelocksai.app"). */
  site?: string;
  /** Optional accent label for diverse template styling. */
  accent?: string;
}

export type ComplianceStatus = "clean" | "flagged";

export interface ComplianceResult {
  complianceStatus: ComplianceStatus;
  blockedTerms: string[];
  safeCopy: string;
}

/** Default no-link CTA variants. Links are opt-in only (see `includeLink`). */
export type CtaVariant =
  | "board_in_bio"
  | "movement_on_jump"
  | "follow_for_movement"
  | "not_a_pick"
  | "none";

export const HR_BOARD_CTA_TEXT: Record<CtaVariant, string> = {
  board_in_bio: "Full board is in bio.",
  movement_on_jump: "I'll post movement when someone jumps.",
  follow_for_movement: "Follow for Playable/Attack movement.",
  not_a_pick: "Not a pick. This is a signal board.",
  none: "",
};

export interface HrBoardAsset {
  assetType: HrBoardAssetType;
  title: string;
  /** Compliance-safe body copy (identical to `safeCopy`). No URLs by default. */
  body: string;
  imagePayload: HrBoardImagePayload;
  /** Human-readable recommended posting time / cadence. */
  recommendedTiming: string;
  sourcePlayerIds: string[];
  sourceSignalIds: string[];
  complianceStatus: ComplianceStatus;
  blockedTerms: string[];
  safeCopy: string;
  ctaVariant: CtaVariant;
  cta: string;
  /**
   * High-traction X hashtags curated per asset type (always brand-tagged).
   * Folded into the copy body and surfaced as chips on the admin card.
   */
  hashtags: string[];
  /**
   * Cashtags ($TEAM / $MLB) derived from the players featured in the asset.
   * Folded into the copy body and surfaced as chips on the admin card.
   */
  cashtags: string[];
  /** No-link native posts by default. */
  includeLink: boolean;
  /** Only populated when an admin explicitly toggles links on. */
  link: string | null;
}

/** A single pre-game board row (engine output, repackaged for the studio). */
export interface HrBoardRow {
  rank: number;
  signalId: string;
  playerId: string;
  player: string;
  team: string;
  opponent: string;
  game: string;
  gameId: string;
  gameTime: string | null;
  score: number;
  stage: string;
  tier: PregamePowerTier;
  drivers: string[];
  tags: string[];
  parkTags: string[];
  pitcherVulnerabilityTags: string[];
}

export interface HrBoardTodayResponse {
  date: string;
  generatedAt: string;
  source: "memory" | "rebuilt" | "db_fallback";
  rows: HrBoardRow[];
  counts: { total: number; byTier: Record<string, number> };
}

export interface HrBoardContentPack {
  date: string;
  generatedAt: string;
  includeLink: boolean;
  assets: HrBoardAsset[];
  counts: { total: number; flagged: number };
}

/** A pre-game board player who moved into / through the live HR Radar. */
export interface HrMovementRow {
  signalId: string;
  playerId: string;
  player: string;
  team: string;
  game: string;
  gameId: string;
  pregameRank: number | null;
  previousStage: string;
  currentStage: string;
  movementTime: string;
  topDriver: string | null;
  pregameScore: number | null;
  currentScore: number | null;
  scoreChange: number | null;
  result: string | null;
}

export interface HrMovementFeedResponse {
  date: string;
  generatedAt: string;
  movements: HrMovementRow[];
}

export interface HrRecapSummary {
  cashed: number;
  nearMiss: number;
  missed: number;
}

export interface HrRecapResponse {
  date: string;
  generatedAt: string;
  assets: HrBoardAsset[];
  summary: HrRecapSummary;
}

// ── Analytics ───────────────────────────────────────────────────────────────

export type HrBoardAnalyticsEventType =
  | "hr_board_pack_generated"
  | "hr_board_asset_copied"
  | "hr_board_image_payload_downloaded"
  | "hr_board_link_toggle_enabled"
  | "hr_movement_asset_generated"
  | "hr_movement_asset_copied"
  | "hr_recap_generated"
  | "hr_recap_copied"
  | "hr_board_admin_viewed";

export const HR_BOARD_ANALYTICS_EVENT_TYPES: HrBoardAnalyticsEventType[] = [
  "hr_board_pack_generated",
  "hr_board_asset_copied",
  "hr_board_image_payload_downloaded",
  "hr_board_link_toggle_enabled",
  "hr_movement_asset_generated",
  "hr_movement_asset_copied",
  "hr_recap_generated",
  "hr_recap_copied",
  "hr_board_admin_viewed",
];

export interface HrBoardAnalyticsEvent {
  eventId: string;
  eventType: HrBoardAnalyticsEventType;
  timestamp: number;
  date: string;
  assetType?: HrBoardAssetType | null;
  template?: HrBoardImageTemplate | null;
  player?: string | null;
  signalId?: string | null;
  count?: number | null;
}

export interface HrBoardAnalyticsSummary {
  date: string;
  generatedAt: string;
  assetsGeneratedToday: number;
  assetsCopiedToday: number;
  mostCopiedPlayer: string | null;
  mostCopiedTemplate: HrBoardImageTemplate | null;
  movementAssetsAvailable: number;
  recapStatus: "not_generated" | "generated";
  recentEvents: HrBoardAnalyticsEvent[];
}
