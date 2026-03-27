export type TopPlayItem = {
  id: string;
  sport: "NBA" | "NCAAB" | "MLB";
  playerOrTeam: string;
  marketLabel: string;
  side: string;
  line?: number | string;
  probability: number;
  edge: number;
  projection?: number | null;
  summary?: string;
  gameId?: string;
  routeTarget: string;
  confidenceTier: "ELITE" | "STRONG" | "VALUE" | "NO_EDGE";
  updatedAt: string;
};

function classifyTier(prob: number): "ELITE" | "STRONG" | "VALUE" | "NO_EDGE" {
  if (prob >= 75) return "ELITE";
  if (prob >= 65) return "STRONG";
  if (prob >= 58) return "VALUE";
  return "NO_EDGE";
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
      marketLabel: MARKET_LABELS[sig.market] ?? sig.market ?? "Props",
      side: sig.recommendedSide ?? sig.side ?? "OVER",
      line: sig.bookLine ?? sig.line,
      probability: sig.enginePct,
      edge,
      projection: sig.projection ?? null,
      summary: sig.explanationBullets?.[0] ?? null,
      gameId: sig.gameId,
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
      marketLabel: MARKET_LABELS[sig.market] ?? sig.market ?? "Props",
      side: sig.recommendedSide ?? "OVER",
      line: sig.bookLine,
      probability: sig.enginePct,
      edge,
      projection: sig.projection ?? null,
      summary: sig.explanationBullets?.[0] ?? null,
      gameId: sig.gameId,
      routeTarget: "mlb",
      confidenceTier: classifyTier(sig.enginePct),
      updatedAt: sig.updatedAt ?? new Date().toISOString(),
    });
  }

  plays.sort((a, b) => {
    const edgeDiff = Math.abs(b.edge) - Math.abs(a.edge);
    if (Math.abs(edgeDiff) > 0.5) return edgeDiff;
    return b.probability - a.probability;
  });

  return plays.slice(0, maxPlays);
}
