import type { Sport, FreshnessStatus } from "./oddsConfig";
import { classifyFreshness } from "./oddsConfig";

export interface BookLineSnapshot {
  line: number;
  overOdds: number | null;
  underOdds: number | null;
}

export interface OddsSnapshot {
  sport: Sport;
  eventId: string;
  market: string;
  player?: string | null;
  books: Record<string, BookLineSnapshot>;
  fetchedAt: number;
  source: "api" | "cache" | "lkg";
  isLive: boolean;
}

export interface ReadOddsSnapshot extends OddsSnapshot {
  ageMs: number;
  freshness: FreshnessStatus;
  isStale: boolean;
}

export function annotateSnapshot(snap: OddsSnapshot, now = Date.now()): ReadOddsSnapshot {
  const ageMs = Math.max(0, now - snap.fetchedAt);
  const freshness = classifyFreshness(snap.sport, snap.isLive, ageMs);
  return {
    ...snap,
    ageMs,
    freshness,
    isStale: freshness === "stale" || freshness === "expired",
  };
}

export function snapshotKey(sport: Sport, eventId: string, market: string, player?: string | null): string {
  const p = player ? player.toLowerCase().trim() : "_team";
  return `${sport}|${eventId}|${market}|${p}`;
}
