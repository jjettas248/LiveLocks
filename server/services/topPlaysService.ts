export type TopPlayItem = {
  id: string;
  sport: "NBA" | "NCAAB" | "MLB";
  playerOrTeam: string;
  market?: string;
  marketLabel: string;
  side: string;
  line?: number | string;
  probability: number;
  edge: number;
  projection?: number | null;
  summary?: string;
  gameId?: string;
  playerId?: string | number;
  team?: string;
  betDirection?: string;
  routeTarget: string;
  confidenceTier: "ELITE" | "STRONG" | "VALUE" | "NO_EDGE";
  updatedAt: string;
  signalScore?: number | null;
  timingContext?: string | null;
  batterArchetype?: string | null;
  pitcherArchetype?: string | null;
  thesis?: string | null;
  isFlagship?: boolean;
  currentStats?: { ab: number; h: number; hr: number; tb: number; bb: number; rbi: number; k: number; sb: number } | null;
  lastABContact?: {
    exitVelo: number | null;
    launchAngle: number | null;
    batSpeed: number | null;
    distance: number | null;
    barrelPct: number | null;
    hardHitPct: number | null;
    outcome: string | null;
  } | null;
  matchup?: string;
};

function classifyTier(prob: number): "ELITE" | "STRONG" | "VALUE" | "NO_EDGE" {
  if (prob >= 75) return "ELITE";
  if (prob >= 65) return "STRONG";
  if (prob >= 58) return "VALUE";
  return "NO_EDGE";
}

const TIER_WEIGHT: Record<string, number> = {
  ELITE: 1.0,
  STRONG: 0.75,
  VALUE: 0.50,
  NO_EDGE: 0.10,
};

const MARKET_STABILITY: Record<string, number> = {
  hits: 0.90,
  total_bases: 0.80,
  pitcher_strikeouts: 0.85,
  home_runs: 0.60,
  points: 0.85,
  rebounds: 0.80,
  assists: 0.75,
};

function computeRankScore(play: TopPlayItem): number {
  const edgePart = Math.abs(play.edge);
  const tierPart = TIER_WEIGHT[play.confidenceTier] ?? 0.50;
  const stability = MARKET_STABILITY[play.market ?? ""] ?? 0.70;
  const signalBoost = play.signalScore != null ? (play.signalScore / 100) * 0.3 : 0;
  const flagshipBoost = play.isFlagship ? 0.15 : 0;
  return edgePart * tierPart * stability + signalBoost + flagshipBoost;
}

const MARKET_LABELS: Record<string, string> = {
  points: "Points", rebounds: "Rebounds", assists: "Assists", threes: "Threes",
  steals: "Steals", blocks: "Blocks", pts_reb: "PTS+REB", pts_ast: "PTS+AST",
  pts_reb_ast: "PTS+REB+AST", reb_ast: "REB+AST", stl_blk: "STL+BLK",
  hits: "Hits", total_bases: "Total Bases", hrr: "H+R+RBI",
  pitcher_k: "K (Pitcher)", pitcher_outs: "Pitcher Outs",
  pitcher_strikeouts: "K (Pitcher)", hits_allowed: "Hits Allowed",
  walks_allowed: "Walks Allowed", hr: "Home Runs", home_runs: "Home Runs",
  total: "Total", spread: "Spread", "1h_total": "1H Total", "1h_spread": "1H Spread",
  "2h_total": "2H Total", "2h_spread": "2H Spread",
  full_total: "Total", full_spread: "Spread", h1_total: "1H Total", h1_spread: "1H Spread",
  h2_total: "2H Total", h2_spread: "2H Spread",
};

export function buildTopPlays(
  nbaSignals: any[],
  ncaabSignals: any[],
  mlbSignals: any[],
  maxPlays: number = 10,
): TopPlayItem[] {
  const plays: TopPlayItem[] = [];

  for (const sig of nbaSignals) {
    if (!sig || typeof sig.enginePct !== "number" || !Number.isFinite(sig.enginePct)) continue;
    if (sig.enginePct < 55) continue;
    const edge = typeof sig.edge === "number" && Number.isFinite(sig.edge) ? sig.edge : 0;
    plays.push({
      id: `nba_${sig.playerId ?? sig.player}_${sig.market}`,
      sport: "NBA",
      playerOrTeam: sig.playerName ?? sig.player ?? "Unknown",
      market: sig.market,
      marketLabel: MARKET_LABELS[sig.market] ?? sig.market ?? "Props",
      side: sig.recommendedSide ?? sig.side ?? "OVER",
      line: sig.bookLine ?? sig.line,
      probability: sig.enginePct,
      edge,
      projection: sig.projection ?? null,
      summary: sig.explanationBullets?.[0] ?? null,
      gameId: sig.gameId,
      playerId: sig.playerId,
      team: sig.team,
      betDirection: sig.recommendedSide?.toLowerCase() ?? sig.side?.toLowerCase() ?? "over",
      routeTarget: "nba",
      confidenceTier: classifyTier(sig.enginePct),
      updatedAt: sig.updatedAt ?? new Date().toISOString(),
    });
  }

  for (const sig of ncaabSignals) {
    if (!sig || typeof sig.probability !== "number" || !Number.isFinite(sig.probability)) continue;
    const prob = sig.probability > 1 ? sig.probability : sig.probability * 100;
    if (prob < 55) continue;
    const edge = typeof sig.edge === "number" && Number.isFinite(sig.edge) ? sig.edge : 0;
    plays.push({
      id: `ncaab_${sig.gameId}_${sig.market}`,
      sport: "NCAAB",
      playerOrTeam: sig.teamName ?? sig.matchup ?? "NCAAB Game",
      market: sig.market,
      marketLabel: MARKET_LABELS[sig.market] ?? sig.market ?? "Game",
      side: sig.side ?? sig.recommendedSide ?? "OVER",
      line: sig.line ?? sig.bookLine,
      probability: prob,
      edge,
      projection: sig.projection ?? null,
      summary: sig.explanation ?? sig.explanationBullets?.[0] ?? null,
      gameId: sig.gameId,
      routeTarget: "ncaab",
      confidenceTier: classifyTier(prob),
      updatedAt: sig.updatedAt ?? new Date().toISOString(),
    });
  }

  for (const sig of mlbSignals) {
    if (!sig || typeof sig.enginePct !== "number" || !Number.isFinite(sig.enginePct)) continue;
    if (sig.enginePct < 55) continue;
    const edge = typeof sig.edge === "number" && Number.isFinite(sig.edge) ? sig.edge : 0;
    plays.push({
      id: `mlb_${sig.playerId}_${sig.market}`,
      sport: "MLB",
      playerOrTeam: sig.playerName ?? "Unknown",
      market: sig.market,
      marketLabel: MARKET_LABELS[sig.market] ?? sig.market ?? "Props",
      side: sig.recommendedSide ?? "OVER",
      line: sig.bookLine,
      probability: sig.enginePct,
      edge,
      projection: sig.projection ?? null,
      summary: sig.thesis ?? sig.explanationBullets?.[0] ?? null,
      gameId: sig.gameId,
      routeTarget: "mlb",
      confidenceTier: sig.confidenceTier ?? classifyTier(sig.enginePct),
      updatedAt: sig.updatedAt ?? new Date().toISOString(),
      signalScore: sig.signalScore ?? null,
      timingContext: sig.timingContext ?? null,
      batterArchetype: sig.batterArchetype ?? null,
      pitcherArchetype: sig.pitcherArchetype ?? null,
      thesis: sig.thesis ?? null,
      isFlagship: sig.isFlagship ?? false,
      currentStats: sig.currentStats ?? null,
      lastABContact: sig.lastABContact ?? null,
    });
  }

  plays.sort((a, b) => {
    const aRank = computeRankScore(a);
    const bRank = computeRankScore(b);
    if (Math.abs(bRank - aRank) > 0.01) return bRank - aRank;
    return b.probability - a.probability;
  });

  return plays.slice(0, maxPlays);
}
