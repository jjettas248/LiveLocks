// MLB Pre-Game Hub — transport contract shared by The Plate + The Mound.
//
// This is a thin composition envelope ONLY. It does not carry scoring logic
// or drivers of its own — `pregameHubService.ts` reshapes the existing Plate
// response (server/mlb/pregamePowerRadar/*) and the new Mound response
// (server/mlb/pregame/mound/*) into this shared shape. Neither engine's own
// internal types change to accommodate this file.

export type PregameRadarViewKey = "plate" | "mound";
export type PregameRadarActorType = "batter" | "pitcher";
export type PregameRadarTier = "watch" | "strong" | "elite";
export type PregameRadarMarketKey =
  | "home_runs"
  | "hits"
  | "total_bases"
  | "pitcher_strikeouts"
  | "pitcher_outs";

export interface PregameRadarMarket {
  key: PregameRadarMarketKey;
  label: string;
  side: "OVER" | "YES";
  line?: number | null;
  projection?: number | null;
  probability?: number | null;
  tier: PregameRadarTier;
}

export interface PregameRadarTargetTracking {
  flaggedBeforeFirstPitch: boolean;
  outcomeStatus?: "pending" | "hit" | "miss" | "calibration" | null;
  outcomeType?:
    | "plate_hit"
    | "plate_miss_calibration"
    | "mound_hit"
    | "mound_miss_calibration"
    | null;
  /** True only for The Plate — The Mound has no per-AB concept. */
  firstAbCashEligible: boolean;
}

export interface PregameRadarTargetContext {
  venue?: string | null;
  temperature?: number | null;
  windLabel?: string | null;
  parkLabel?: string | null;
  weatherLabel?: string | null;
}

export interface PregameRadarTarget {
  id: string;
  view: PregameRadarViewKey;
  actorType: PregameRadarActorType;
  playerId: string;
  playerName: string;
  team: string;
  opponent: string;
  matchupLabel: string;
  handednessLabel?: string | null;
  rank: number;
  score10: number;
  tier: PregameRadarTier;
  setupLabel: string;
  primaryMarket: PregameRadarMarket;
  markets: PregameRadarMarket[];
  badges: string[];
  drivers: string[];
  warnings: string[];
  context: PregameRadarTargetContext;
  tracking: PregameRadarTargetTracking;
}

export interface PregameRadarFilter {
  key: string;
  label: string;
}

export interface PregameRadarRecord {
  winsToday: number;
  /** Plate only — always 0 on the Mound record. */
  firstAbCashesToday?: number;
  /** Mound only — always 0 on the Plate record. */
  pitcherPropsCashedToday?: number;
  flaggedBeforeFirstPitchToday: number;
  winsLast7Days: number;
}

export interface PregameRadarView {
  key: PregameRadarViewKey;
  label: "The Plate" | "The Mound";
  actorType: PregameRadarActorType;
  title: string;
  subtitle: string;
  targets: PregameRadarTarget[];
  filters: PregameRadarFilter[];
  record: PregameRadarRecord;
  diagnostics: Record<string, unknown>;
}

export interface MlbPregameHubResponse {
  dateET: string;
  updatedAt: string;
  source: "memory" | "api" | "cache";
  slateStatus: "pre_first_pitch" | "in_progress" | "final";
  activeViewDefault: "plate";
  views: {
    plate: PregameRadarView;
    mound: PregameRadarView;
  };
  records: {
    overall: PregameRadarRecord;
    plate: PregameRadarRecord;
    mound: PregameRadarRecord;
  };
  diagnostics: Record<string, unknown>;
}
