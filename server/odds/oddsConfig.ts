export type Sport = "mlb" | "nba" | "ncaab";

export type FreshnessStatus = "fresh" | "aging" | "stale" | "expired";

export type PollingTier = "critical" | "high" | "normal" | "low" | "idle";

export interface FreshnessThresholds {
  freshMs: number;
  agingMs: number;
  staleMs: number;
}

const FRESHNESS_BY_SPORT: Record<Sport, { live: FreshnessThresholds; pregame: FreshnessThresholds }> = {
  mlb: {
    live:    { freshMs: 30_000,  agingMs: 90_000,  staleMs: 180_000 },
    pregame: { freshMs: 120_000, agingMs: 300_000, staleMs: 600_000 },
  },
  nba: {
    live:    { freshMs: 30_000,  agingMs: 75_000,  staleMs: 150_000 },
    pregame: { freshMs: 120_000, agingMs: 240_000, staleMs: 480_000 },
  },
  ncaab: {
    live:    { freshMs: 45_000,  agingMs: 120_000, staleMs: 240_000 },
    pregame: { freshMs: 180_000, agingMs: 360_000, staleMs: 600_000 },
  },
};

export function getFreshnessThresholds(sport: Sport, isLive: boolean): FreshnessThresholds {
  return FRESHNESS_BY_SPORT[sport][isLive ? "live" : "pregame"];
}

export function classifyFreshness(sport: Sport, isLive: boolean, ageMs: number): FreshnessStatus {
  const t = getFreshnessThresholds(sport, isLive);
  if (ageMs <= t.freshMs) return "fresh";
  if (ageMs <= t.agingMs) return "aging";
  if (ageMs <= t.staleMs) return "stale";
  return "expired";
}

const POLLING_CADENCE_MS: Record<PollingTier, number> = {
  critical: 10_000,
  high:     15_000,
  normal:   45_000,
  low:      120_000,
  idle:     600_000,
};

export function getPollingCadenceMs(tier: PollingTier): number {
  return POLLING_CADENCE_MS[tier];
}

const PREFERRED_BOOKS_BY_SPORT: Record<Sport, string[]> = {
  mlb:   ["draftkings", "fanduel", "hardrockbet", "betmgm", "betrivers", "espnbet"],
  nba:   ["draftkings", "fanduel", "hardrockbet", "betmgm", "betrivers", "espnbet"],
  ncaab: ["draftkings", "fanduel", "hardrockbet", "betmgm", "betrivers", "espnbet"],
};

const FALLBACK_BOOKS_BY_SPORT: Record<Sport, string[]> = {
  mlb:   ["prizepicks", "underdogfantasy", "betonlineag", "bovada", "williamhill_us"],
  nba:   ["prizepicks", "underdogfantasy", "betonlineag", "bovada", "williamhill_us"],
  ncaab: ["betonlineag", "bovada", "williamhill_us"],
};

export function getPreferredBooks(sport: Sport): string[] {
  return PREFERRED_BOOKS_BY_SPORT[sport];
}

export function getAllPriorityBooks(sport: Sport): string[] {
  return [...PREFERRED_BOOKS_BY_SPORT[sport], ...FALLBACK_BOOKS_BY_SPORT[sport]];
}

export function getPropBookmakersCsv(sport: Sport): string {
  return getAllPriorityBooks(sport).join(",");
}

export function isPreferredBook(sport: Sport, bookKey: string): boolean {
  return PREFERRED_BOOKS_BY_SPORT[sport].includes(bookKey);
}

export function rankBook(sport: Sport, bookKey: string): number {
  const all = getAllPriorityBooks(sport);
  const idx = all.indexOf(bookKey);
  return idx === -1 ? all.length + 1 : idx;
}
