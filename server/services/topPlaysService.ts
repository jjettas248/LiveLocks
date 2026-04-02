import {
  assignExpansionTier,
  deriveConfidenceFromTrust,
  type ExpansionTier,
  type ProjectionQuality,
} from "../projectionIntegrity";

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
  expansionTier?: ExpansionTier;
  projectionSource?: string;
  projectionQuality?: string;
  projectionTrustScore?: number;
};

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

const NBA_TARGET_PER_TEAM = 10;
const NBA_MAX_PER_TEAM = 13;

const MLB_MARKET_TARGETS: Record<string, { min: number; max: number }> = {
  hits: { min: 4, max: 8 },
  total_bases: { min: 4, max: 6 },
  pitcher_strikeouts: { min: 1, max: 2 },
  home_runs: { min: 2, max: 4 },
};

const MAX_PLAYS_PER_PLAYER = 3;

interface InternalCandidate extends TopPlayItem {
  trustScore: number;
  quality: ProjectionQuality;
  fallbackUsed: boolean;
  marketValidationPassed: boolean;
  expansionTier: ExpansionTier;
  playerKey: string;
}

function computeTrustScore(sig: any, sport: "NBA" | "NCAAB" | "MLB"): number {
  if (sport === "MLB" && typeof sig.projectionTrustScore === "number") {
    return sig.projectionTrustScore;
  }
  if (sport === "NBA" && typeof sig.projectionTrustScore === "number") {
    return sig.projectionTrustScore;
  }

  const prob = sig.enginePct ?? sig.probability ?? 50;
  const edge = typeof sig.edge === "number" ? Math.abs(sig.edge) : 0;
  return Math.min(1, (prob - 50) / 50 * 0.5 + edge / 20 * 0.3 + 0.2);
}

function getQuality(sig: any): ProjectionQuality {
  if (sig.projectionQuality === "high" || sig.projectionQuality === "medium" || sig.projectionQuality === "low") {
    return sig.projectionQuality;
  }
  return "medium";
}

function applyDuplicateControl(candidates: InternalCandidate[]): InternalCandidate[] {
  const playerCounts = new Map<string, number>();
  const result: InternalCandidate[] = [];

  for (const c of candidates) {
    const count = playerCounts.get(c.playerKey) ?? 0;
    if (count >= MAX_PLAYS_PER_PLAYER) continue;
    playerCounts.set(c.playerKey, count + 1);
    result.push(c);
  }

  return result;
}

function trustBasedSort(a: InternalCandidate, b: InternalCandidate): number {
  const tierOrder: Record<ExpansionTier, number> = { A: 0, B: 1, C: 2, REJECT: 3 };
  const tierDiff = tierOrder[a.expansionTier] - tierOrder[b.expansionTier];
  if (tierDiff !== 0) return tierDiff;

  const trustDiff = b.trustScore - a.trustScore;
  if (Math.abs(trustDiff) > 0.05) return trustDiff;

  const edgeDiff = Math.abs(b.edge) - Math.abs(a.edge);
  if (Math.abs(edgeDiff) > 0.5) return edgeDiff;

  return b.probability - a.probability;
}

function buildNBACandidate(sig: any): InternalCandidate | null {
  if (!sig || typeof sig.enginePct !== "number" || !Number.isFinite(sig.enginePct)) return null;
  if (sig.enginePct < 55) return null;

  const edge = typeof sig.edge === "number" && Number.isFinite(sig.edge) ? sig.edge : 0;
  const trustScore = computeTrustScore(sig, "NBA");
  const quality = getQuality(sig);
  const fallbackUsed = sig.fallbackUsed === true;
  const marketValid = sig.marketValidationPassed !== false;

  const tier = assignExpansionTier(trustScore, sig.enginePct, fallbackUsed, marketValid);
  if (tier === "REJECT") return null;

  const confidence = deriveConfidenceFromTrust(sig.enginePct, trustScore, fallbackUsed, marketValid, quality);

  return {
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
    confidenceTier: confidence,
    updatedAt: sig.updatedAt ?? new Date().toISOString(),
    trustScore,
    quality,
    fallbackUsed,
    marketValidationPassed: marketValid,
    expansionTier: tier,
    playerKey: `nba_${sig.playerId ?? sig.playerName ?? sig.player}`,
    projectionSource: sig.projectionSource ?? null,
    projectionQuality: quality,
    projectionTrustScore: trustScore,
  };
}

function buildMLBCandidate(sig: any): InternalCandidate | null {
  if (!sig || typeof sig.enginePct !== "number" || !Number.isFinite(sig.enginePct)) return null;
  if (sig.enginePct < 55) return null;

  const edge = typeof sig.edge === "number" && Number.isFinite(sig.edge) ? sig.edge : 0;
  const trustScore = computeTrustScore(sig, "MLB");
  const quality = getQuality(sig);
  const fallbackUsed = sig.fallbackUsed === true;
  const marketValid = sig.marketValidationPassed !== false;

  const tier = assignExpansionTier(trustScore, sig.enginePct, fallbackUsed, marketValid);
  if (tier === "REJECT") return null;

  const confidence = deriveConfidenceFromTrust(sig.enginePct, trustScore, fallbackUsed, marketValid, quality);

  return {
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
    summary: sig.explanationBullets?.[0] ?? null,
    gameId: sig.gameId,
    playerId: sig.playerId,
    routeTarget: "mlb",
    confidenceTier: confidence,
    updatedAt: sig.updatedAt ?? new Date().toISOString(),
    currentStats: sig.currentStats ?? null,
    lastABContact: sig.lastABContact ?? null,
    trustScore,
    quality,
    fallbackUsed,
    marketValidationPassed: marketValid,
    expansionTier: tier,
    playerKey: `mlb_${sig.playerId ?? sig.playerName}`,
    projectionSource: sig.projectionSource ?? null,
    projectionQuality: quality,
    projectionTrustScore: trustScore,
  };
}

function buildNCAAbCandidate(sig: any): InternalCandidate | null {
  if (!sig || typeof sig.probability !== "number" || !Number.isFinite(sig.probability)) return null;
  const prob = sig.probability > 1 ? sig.probability : sig.probability * 100;
  if (prob < 55) return null;

  const edge = typeof sig.edge === "number" && Number.isFinite(sig.edge) ? sig.edge : 0;
  const trustScore = computeTrustScore(sig, "NCAAB");
  const quality: ProjectionQuality = "medium";
  const tier = assignExpansionTier(trustScore, prob, false, true);
  if (tier === "REJECT") return null;

  const confidence = deriveConfidenceFromTrust(prob, trustScore, false, true, quality);

  return {
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
    confidenceTier: confidence,
    updatedAt: sig.updatedAt ?? new Date().toISOString(),
    trustScore,
    quality,
    fallbackUsed: false,
    marketValidationPassed: true,
    expansionTier: tier,
    playerKey: `ncaab_${sig.gameId}_${sig.market}`,
    projectionSource: null,
    projectionQuality: quality,
    projectionTrustScore: trustScore,
  };
}

function buildPerGameBoard(
  candidates: InternalCandidate[],
  sport: "NBA" | "MLB" | "NCAAB",
): InternalCandidate[] {
  const byGame = new Map<string, InternalCandidate[]>();
  for (const c of candidates) {
    const key = c.gameId ?? "unknown";
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key)!.push(c);
  }

  const result: InternalCandidate[] = [];

  for (const [, gameCandidates] of byGame) {
    gameCandidates.sort(trustBasedSort);

    if (sport === "NBA") {
      const byTeam = new Map<string, InternalCandidate[]>();
      for (const c of gameCandidates) {
        const teamKey = c.team ?? "unknown";
        if (!byTeam.has(teamKey)) byTeam.set(teamKey, []);
        byTeam.get(teamKey)!.push(c);
      }

      for (const [, teamPlays] of byTeam) {
        const deduped = applyDuplicateControl(teamPlays);
        const tierA = deduped.filter(c => c.expansionTier === "A");
        const tierB = deduped.filter(c => c.expansionTier === "B");
        const tierC = deduped.filter(c => c.expansionTier === "C");

        const selected: InternalCandidate[] = [];
        selected.push(...tierA.slice(0, 5));

        const remaining = NBA_TARGET_PER_TEAM - selected.length;
        if (remaining > 0) selected.push(...tierB.slice(0, Math.min(remaining, 4)));

        const remaining2 = NBA_TARGET_PER_TEAM - selected.length;
        if (remaining2 > 0) selected.push(...tierC.slice(0, Math.min(remaining2, 4)));

        result.push(...selected.slice(0, NBA_MAX_PER_TEAM));
      }
    } else if (sport === "MLB") {
      const deduped = applyDuplicateControl(gameCandidates);

      const byMarket = new Map<string, InternalCandidate[]>();
      for (const c of deduped) {
        const mkt = c.market ?? "other";
        if (!byMarket.has(mkt)) byMarket.set(mkt, []);
        byMarket.get(mkt)!.push(c);
      }

      const selected: InternalCandidate[] = [];
      for (const [market, mktPlays] of byMarket) {
        const targets = MLB_MARKET_TARGETS[market];
        if (targets) {
          selected.push(...mktPlays.slice(0, targets.max));
        } else {
          selected.push(...mktPlays.slice(0, 2));
        }
      }

      selected.sort(trustBasedSort);
      result.push(...selected);
    } else {
      const deduped = applyDuplicateControl(gameCandidates);
      result.push(...deduped.slice(0, 10));
    }
  }

  return result;
}

function stripInternalFields(c: InternalCandidate): TopPlayItem {
  const { trustScore: _ts, quality: _q, fallbackUsed: _f, marketValidationPassed: _m, playerKey: _pk, ...play } = c;
  return play;
}

export function buildTopPlays(
  nbaSignals: any[],
  ncaabSignals: any[],
  mlbSignals: any[],
  _maxPlays: number = 10,
): TopPlayItem[] {
  const nbaCandidates: InternalCandidate[] = [];
  for (const sig of nbaSignals) {
    const c = buildNBACandidate(sig);
    if (c) nbaCandidates.push(c);
  }

  const mlbCandidates: InternalCandidate[] = [];
  for (const sig of mlbSignals) {
    const c = buildMLBCandidate(sig);
    if (c) mlbCandidates.push(c);
  }

  const ncaabCandidates: InternalCandidate[] = [];
  for (const sig of ncaabSignals) {
    const c = buildNCAAbCandidate(sig);
    if (c) ncaabCandidates.push(c);
  }

  const nbaBoard = buildPerGameBoard(nbaCandidates, "NBA");
  const mlbBoard = buildPerGameBoard(mlbCandidates, "MLB");
  const ncaabBoard = buildPerGameBoard(ncaabCandidates, "NCAAB");

  const allPlays = [...nbaBoard, ...mlbBoard, ...ncaabBoard];
  allPlays.sort(trustBasedSort);

  const boardStats = {
    nba: nbaBoard.length,
    mlb: mlbBoard.length,
    ncaab: ncaabBoard.length,
    total: allPlays.length,
    nbaGames: new Set(nbaBoard.map(p => p.gameId)).size,
    mlbGames: new Set(mlbBoard.map(p => p.gameId)).size,
    tierBreakdown: {
      A: allPlays.filter(p => p.expansionTier === "A").length,
      B: allPlays.filter(p => p.expansionTier === "B").length,
      C: allPlays.filter(p => p.expansionTier === "C").length,
    },
  };

  console.log(`[TopPlays Board] NBA: ${boardStats.nba} plays / ${boardStats.nbaGames} games | MLB: ${boardStats.mlb} plays / ${boardStats.mlbGames} games | NCAAB: ${boardStats.ncaab} | Tiers: A=${boardStats.tierBreakdown.A} B=${boardStats.tierBreakdown.B} C=${boardStats.tierBreakdown.C}`);

  return allPlays.map(stripInternalFields);
}
