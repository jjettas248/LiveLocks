const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ESPN_NCAAB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball";

interface CacheEntry { data: any; timestamp: number; }
const cache = new Map<string, CacheEntry>();
const GAMES_TTL   = 90 * 1000;      // 90 sec — live scoreboard
const BOX_TTL     = 60 * 1000;      // 1 min  — live box score
const LINES_TTL   = 5 * 60 * 1000;  // 5 min  — Odds API (save credits)

function isFresh(e: CacheEntry | undefined, ttl: number) {
  return !!e && Date.now() - e.timestamp < ttl;
}

// ── Team name normalizer / fuzzy matcher ─────────────────────────────────────
function normTeam(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}
function teamsMatch(a: string, b: string): boolean {
  const na = normTeam(a); const nb = normTeam(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ── Sigmoid ───────────────────────────────────────────────────────────────────
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

// ── ESPN NCAAB Scoreboard ────────────────────────────────────────────────────
export async function getNCAABScoreboard(): Promise<any[]> {
  const key = "ncaab_scoreboard";
  const cached = cache.get(key);
  if (isFresh(cached, GAMES_TTL)) return cached!.data;

  let res: Response;
  try {
    res = await fetch(`${ESPN_NCAAB}/scoreboard`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn("[NCAAB] Scoreboard fetch failed (network):", err);
    if (cached) return cached.data; // serve stale cache if available
    return [];
  }
  if (!res.ok) {
    console.warn(`[NCAAB] Scoreboard HTTP ${res.status}`);
    if (cached) return cached.data; // serve stale cache if available
    return [];
  }
  const data = await res.json() as any;

  const games = (data.events ?? []).map((event: any) => {
    const comp = event.competitions?.[0];
    const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
    const status = comp?.status;
    const statusDesc: string = status?.type?.description ?? "Scheduled";
    const period: number = status?.period ?? 0;
    const clock: string = status?.displayClock ?? "";
    const isHalftime = statusDesc === "Halftime" || (period === 1 && (clock === "0:00" || clock === "00.0"));
    const isInProgress = statusDesc === "In Progress";
    return {
      id: event.id as string,
      name: event.name as string,
      shortName: event.shortName as string,
      homeTeam: home?.team?.displayName ?? "",
      homeTeamAbbr: home?.team?.abbreviation ?? "",
      homeTeamId: home?.team?.id ?? "",
      homeScore: parseInt(home?.score ?? "0", 10),
      awayTeam: away?.team?.displayName ?? "",
      awayTeamAbbr: away?.team?.abbreviation ?? "",
      awayTeamId: away?.team?.id ?? "",
      awayScore: parseInt(away?.score ?? "0", 10),
      status: statusDesc,
      period,
      clock,
      isHalftime,
      isInProgress,
      isLive: isHalftime || isInProgress,
    };
  });

  cache.set(key, { data: games, timestamp: Date.now() });
  console.log(`[NCAAB] Scoreboard: ${games.length} games`);
  return games;
}

// ── ESPN NCAAB Box Score ─────────────────────────────────────────────────────
export async function getNCAABBoxScore(gameId: string): Promise<any | null> {
  const key = `ncaab_box_${gameId}`;
  const cached = cache.get(key);
  if (isFresh(cached, BOX_TTL)) return cached!.data;

  const res = await fetch(`${ESPN_NCAAB}/summary?event=${gameId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json() as any;

  const boxscore = data.boxscore;
  const status = data.header?.competitions?.[0]?.status;
  const period: number = status?.period ?? 1;
  const clock: string = status?.displayClock ?? "";
  const statusDesc: string = status?.type?.description ?? "";
  const isHalftime = statusDesc === "Halftime" || (period === 1 && (clock === "0:00" || clock === "00.0"));

  // Parse clock → seconds remaining in current half (NCAAB halves = 20 min = 1200 sec)
  const [minStr, secStr] = clock.split(":");
  const mins = parseInt(minStr ?? "0", 10);
  const secs = parseInt(secStr ?? "0", 10);
  const clockSeconds = (isNaN(mins) || isNaN(secs)) ? 0 : mins * 60 + secs;
  const secondsRemainingInHalf = isHalftime ? 1200 : clockSeconds;

  // Half 1 or 2 — NCAAB has 2 halves; overtime periods > 2
  const half = period <= 1 ? 1 : 2;

  // Scoring by period per team: { abbr: [h1pts, h2pts, ...] }
  const scoringByPeriod: Record<string, number[]> = {};
  for (const teamObj of (boxscore?.teams ?? [])) {
    const abbr: string = teamObj.team?.abbreviation ?? "";
    const lineScores: number[] = (teamObj.lineScores ?? []).map((ls: any) =>
      parseInt(ls.value ?? "0", 10)
    );
    if (abbr) scoringByPeriod[abbr] = lineScores;
  }

  // Team-level aggregated stats (FGA, 3PA, fouls)
  const teamStats: Record<string, any> = {};
  for (const teamObj of (boxscore?.teams ?? [])) {
    const abbr: string = teamObj.team?.abbreviation ?? "";
    if (!abbr) continue;
    const stats: any[] = teamObj.statistics ?? [];
    const map: Record<string, string> = {};
    for (const s of stats) map[s.name] = s.displayValue;
    teamStats[abbr] = {
      fieldGoalsAttempted: parseInt(map["fieldGoalsAttempted"] ?? map["fga"] ?? "0", 10),
      threePointAttempted: parseInt(map["threePointFieldGoalsAttempted"] ?? map["fg3a"] ?? "0", 10),
      freeThrowAttempted:  parseInt(map["freeThrowsAttempted"] ?? map["fta"] ?? "0", 10),
      fouls:               parseInt(map["fouls"] ?? map["pf"] ?? "0", 10),
      fieldGoalsMade:      parseInt(map["fieldGoalsMade"] ?? map["fgm"] ?? "0", 10),
      threePointMade:      parseInt(map["threePointFieldGoalsMade"] ?? map["fg3m"] ?? "0", 10),
    };
  }

  const result = {
    gameId,
    period,
    half,
    clock,
    clockSeconds,
    isHalftime,
    secondsRemainingInHalf,
    scoringByPeriod,
    teamStats,
    statusDesc,
  };

  cache.set(key, { data: result, timestamp: Date.now() });
  return result;
}

// ── The Odds API — NCAAB game lines (spreads + totals, all live games) ────────
export async function getNCAABOddsLines(): Promise<any[]> {
  const key = "ncaab_odds_lines";
  const cached = cache.get(key);
  if (isFresh(cached, LINES_TTL)) return cached!.data;

  if (!ODDS_API_KEY) {
    console.warn("[NCAAB] ODDS_API_KEY not set — skipping Odds API");
    return [];
  }

  try {
    const url = `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=spreads,totals&bookmakers=fanduel,draftkings,betmgm,betrivers&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[NCAAB Odds] ${res.status}: ${body}`);
      return [];
    }
    const data = await res.json() as any[];
    cache.set(key, { data, timestamp: Date.now() });
    console.log(`[NCAAB] Odds API: ${data.length} events`);
    return data;
  } catch (err) {
    console.warn("[NCAAB Odds] error:", err);
    return [];
  }
}

// ── Match ESPN game → Odds API event ─────────────────────────────────────────
function matchOddsEvent(game: any, oddsEvents: any[]): any | null {
  for (const ev of oddsEvents) {
    const evHome = ev.home_team ?? "";
    const evAway = ev.away_team ?? "";
    if (
      (teamsMatch(game.homeTeam, evHome) && teamsMatch(game.awayTeam, evAway)) ||
      (teamsMatch(game.homeTeam, evAway) && teamsMatch(game.awayTeam, evHome))
    ) return ev;
  }
  return null;
}

// ── Extract consensus spread / total from Odds API event ─────────────────────
function extractLines(oddsEvent: any): {
  spread: number | null;
  total: number | null;
  favorite: string;
  bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string }>;
} {
  let spread: number | null = null;
  let total: number | null = null;
  let favorite = "";
  const bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string }> = [];

  for (const bk of (oddsEvent.bookmakers ?? [])) {
    const spreadsMarket = (bk.markets ?? []).find((m: any) => m.key === "spreads");
    const totalsMarket  = (bk.markets ?? []).find((m: any) => m.key === "totals");

    let bkSpread: number | null = null;
    let bkTotal: number | null = null;
    let bkFav = "";

    if (spreadsMarket?.outcomes?.length >= 2) {
      const favOutcome = spreadsMarket.outcomes.find((o: any) => o.point < 0);
      if (favOutcome) {
        bkSpread = Math.abs(favOutcome.point);
        bkFav = favOutcome.name;
      } else {
        const sorted = [...spreadsMarket.outcomes].sort((a: any, b: any) => Math.abs(a.point) - Math.abs(b.point));
        bkSpread = Math.abs(sorted[0].point);
        bkFav = sorted[0].name;
      }
    }
    if (totalsMarket?.outcomes?.length >= 1) {
      const over = totalsMarket.outcomes.find((o: any) => o.name === "Over");
      if (over) bkTotal = over.point as number;
    }

    if (bkSpread !== null || bkTotal !== null) {
      bookLines.push({ book: bk.key, spread: bkSpread, total: bkTotal, favorite: bkFav });
    }
    if (spread === null && bkSpread !== null) { spread = bkSpread; favorite = bkFav; }
    if (total === null && bkTotal !== null) total = bkTotal;
    if (spread !== null && total !== null) break;
  }

  return { spread, total, favorite, bookLines };
}

// ── Public handle signal (juice-variance proxy) ──────────────────────────────
function getHandleSignal(bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string }>): {
  pct: number | null;
  signal: "no_edge" | "fade" | "extreme" | "neutral" | "unavailable";
  label: string;
  color: string;
} {
  // Measure line deviation across books as proxy for public handle
  const spreads = bookLines.map(b => b.spread).filter((s): s is number => s !== null);
  if (spreads.length < 2) {
    return { pct: null, signal: "unavailable", label: "Handle data unavailable", color: "text-muted-foreground" };
  }
  const min = Math.min(...spreads);
  const max = Math.max(...spreads);
  const deviation = max - min;

  // High deviation (>1.5) means books disagree = sharp vs public split = potential fade
  if (deviation >= 2.0) {
    return { pct: 80, signal: "fade", label: "Fade Opportunity — cross-book spread gap ≥2", color: "text-yellow-400" };
  }
  if (deviation >= 1.0) {
    return { pct: 70, signal: "neutral", label: "Neutral — minor cross-book deviation", color: "text-muted-foreground" };
  }
  return { pct: 55, signal: "no_edge", label: "No edge — tight consensus across books", color: "text-muted-foreground" };
}

// ── Probability model ─────────────────────────────────────────────────────────
export interface NCAABPlay {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  status: string;
  clock: string;
  half: number;
  period: number;
  homeScore: number;
  awayScore: number;
  currentMargin: number;

  // Lines
  spread: number | null;
  total: number | null;
  favorite: string;
  bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string }>;

  // Projections
  projectedTotal: number | null;
  projectedMargin: number | null;

  // Probabilities (0–100 %)
  spreadProb: number | null;
  overProb: number | null;
  spreadEdge: number | null;
  totalEdge: number | null;

  // Volatility
  volatilityBonus: number;
  volatility: number | null;

  // Betting window
  bettingWindow: "1H_WINDOW" | "HALFTIME" | "LATE_WINDOW" | "NONE";
  bettingWindowLabel: string;

  // Handle signal
  handleSignal: {
    pct: number | null;
    signal: "no_edge" | "fade" | "extreme" | "neutral" | "unavailable";
    label: string;
    color: string;
  };

  // Coaching tendency flags
  desperation3s: boolean;
  intentionalFouling: boolean;

  // Raw box data (for admin debug)
  scoringByPeriod: Record<string, number[]>;
  teamStats: Record<string, any>;
}

const HALF_SECONDS = 1200; // 20 min × 60

export async function computeNCAABPlays(): Promise<NCAABPlay[]> {
  const [allGames, oddsEvents] = await Promise.all([
    getNCAABScoreboard(),
    getNCAABOddsLines(),
  ]);

  const liveGames = allGames.filter(g => g.isLive);
  if (liveGames.length === 0) {
    console.log("[NCAAB] No live games at the moment.");
    return [];
  }

  const plays: NCAABPlay[] = [];

  for (const game of liveGames) {
    try {
    let box: any = null;
    try { box = await getNCAABBoxScore(game.id); } catch { /* non-fatal */ }

    const oddsEvent = matchOddsEvent(game, oddsEvents);
    const { spread, total, favorite, bookLines } = oddsEvent
      ? extractLines(oddsEvent)
      : { spread: null, total: null, favorite: "", bookLines: [] };

    // ── Box score data ─────────────────────────────────────────────────────
    const half                  = box?.half ?? (game.period <= 1 ? 1 : 2);
    const isHalftime            = game.isHalftime || box?.isHalftime;
    const secondsLeft           = box?.secondsRemainingInHalf ?? (isHalftime ? 1200 : 600);
    const scoringByPeriod       = box?.scoringByPeriod ?? {};
    const teamStats             = box?.teamStats ?? {};

    const homeAbbr = game.homeTeamAbbr;
    const awayAbbr = game.awayTeamAbbr;

    const homeScores: number[] = scoringByPeriod[homeAbbr] ?? [];
    const awayScores: number[] = scoringByPeriod[awayAbbr] ?? [];

    // Fallback: split current total evenly for H1
    const h1Home = homeScores[0] ?? Math.round(game.homeScore / (half === 2 ? 2 : 1) * 0.5);
    const h1Away = awayScores[0] ?? Math.round(game.awayScore / (half === 2 ? 2 : 1) * 0.5);
    const h1Total = h1Home + h1Away;

    const h2Home = homeScores[1] ?? (half === 2 ? game.homeScore - h1Home : 0);
    const h2Away = awayScores[1] ?? (half === 2 ? game.awayScore - h1Away : 0);
    const h2TotalSoFar = h2Home + h2Away;

    // Points per minute in H1 (H1 always 20 min for finished first half)
    const paceH1 = h1Total / 20;

    const currentMargin = game.homeScore - game.awayScore;
    const homeStats = teamStats[homeAbbr] ?? {};
    const awayStats = teamStats[awayAbbr] ?? {};

    // ── Coaching tendency modifiers ────────────────────────────────────────
    let volatilityBonus = 0;
    let projTotalBonus = 0;
    let desperation3s = false;
    let intentionalFouling = false;

    if (half === 2 && !isHalftime) {
      // Trailing team desperation 3s
      const trailingHomeByEight = currentMargin <= -8;
      const trailingAwayByEight = currentMargin >= 8;

      if (trailingHomeByEight) {
        const fga = homeStats.fieldGoalsAttempted ?? 0;
        const fg3a = homeStats.threePointAttempted ?? 0;
        if (fga > 0 && fg3a / fga > 0.40) { volatilityBonus += 4; desperation3s = true; }
      }
      if (trailingAwayByEight) {
        const fga = awayStats.fieldGoalsAttempted ?? 0;
        const fg3a = awayStats.threePointAttempted ?? 0;
        if (fga > 0 && fg3a / fga > 0.40) { volatilityBonus += 4; desperation3s = true; }
      }

      // Leading team draws intentional fouls
      if (currentMargin >= 8) {
        if ((awayStats.fouls ?? 0) >= 4) { projTotalBonus += 6; intentionalFouling = true; }
      } else if (currentMargin <= -8) {
        if ((homeStats.fouls ?? 0) >= 4) { projTotalBonus += 6; intentionalFouling = true; }
      }
    }

    // ── Projections ────────────────────────────────────────────────────────
    let projectedTotal: number | null = null;
    let projectedMargin: number | null = null;

    if (isHalftime) {
      // Halftime: project H2 using H1 pace as baseline
      projectedTotal = h1Total + (paceH1 * 20) + projTotalBonus;
      projectedMargin = currentMargin; // H2 starts fresh from this margin baseline
    } else if (half === 1) {
      // H1 window: project remainder of H1, then add estimated H2 (avg NCAA H2 ≈ same pace as H1)
      const h1MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
      const paceH1Live = h1MinElapsed > 0
        ? (game.homeScore + game.awayScore) / h1MinElapsed
        : paceH1;
      const projH1Full = paceH1Live * 20;
      // Estimate H2 from H1 pace (conservative — no live H2 data yet)
      projectedTotal = projH1Full + (paceH1Live * 20) + projTotalBonus;
      projectedMargin = null; // insufficient data for margin in H1
    } else if (half === 2) {
      // H2: 70/30 weighted pace
      const h2MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
      const paceH2Live = h2MinElapsed > 0 ? h2TotalSoFar / h2MinElapsed : paceH1;
      const paceH2 = paceH2Live * 0.70 + paceH1 * 0.30;
      const remainMin = secondsLeft / 60;
      projectedTotal = h1Total + h2TotalSoFar + (paceH2 * remainMin) + projTotalBonus;

      // Margin trend: how margin has shifted during H2 per minute
      const h2MarginSoFar = h2Home - h2Away;
      const marginPerMin = h2MinElapsed > 0 ? h2MarginSoFar / h2MinElapsed : 0;
      projectedMargin = currentMargin + (marginPerMin * remainMin);
    }

    // ── Volatility + sigmoid ───────────────────────────────────────────────
    let volatility: number | null = null;
    let spreadProb: number | null = null;
    let overProb: number | null = null;
    let spreadEdge: number | null = null;
    let totalEdge: number | null = null;

    if (projectedTotal !== null || projectedMargin !== null) {
      const secsForVol = isHalftime ? 1200 : secondsLeft;
      volatility = Math.max(4, 18 * (secsForVol / 2400)) + volatilityBonus;

      if (projectedMargin !== null && spread !== null) {
        const adjustedSpread = teamsMatch(favorite, game.homeTeam) ? -spread : spread;
        spreadProb = Math.round(sigmoid((projectedMargin - adjustedSpread) / volatility) * 1000) / 10;
        spreadEdge = Math.round((spreadProb - 50) * 10) / 10;
      }
      if (projectedTotal !== null && total !== null) {
        overProb = Math.round(sigmoid((projectedTotal - total) / volatility) * 1000) / 10;
        totalEdge = Math.round((overProb - 50) * 10) / 10;
      }
    }

    // ── Betting window ─────────────────────────────────────────────────────
    let bettingWindow: NCAABPlay["bettingWindow"] = "NONE";
    let bettingWindowLabel = "—";
    if (isHalftime) {
      bettingWindow = "HALFTIME";
      bettingWindowLabel = "Halftime Window";
    } else if (half === 1 && secondsLeft <= 600) {
      bettingWindow = "1H_WINDOW";
      bettingWindowLabel = "1H Window (≤10 min left)";
    } else if (half === 2 && secondsLeft <= 600) {
      bettingWindow = "LATE_WINDOW";
      bettingWindowLabel = "Late 2H Window (≤10 min left)";
    }

    const handleSignal = getHandleSignal(bookLines);

    plays.push({
      gameId: game.id,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeTeamAbbr: homeAbbr,
      awayTeamAbbr: awayAbbr,
      status: game.status,
      clock: game.clock,
      half,
      period: game.period,
      homeScore: game.homeScore,
      awayScore: game.awayScore,
      currentMargin,
      spread,
      total,
      favorite,
      bookLines,
      projectedTotal: projectedTotal !== null ? Math.round(projectedTotal * 10) / 10 : null,
      projectedMargin: projectedMargin !== null ? Math.round(projectedMargin * 10) / 10 : null,
      spreadProb,
      overProb,
      spreadEdge,
      totalEdge,
      volatilityBonus,
      volatility: volatility !== null ? Math.round(volatility * 10) / 10 : null,
      bettingWindow,
      bettingWindowLabel,
      handleSignal,
      desperation3s,
      intentionalFouling,
      scoringByPeriod,
      teamStats,
    });
    } catch (gameErr) {
      console.warn(`[NCAAB] Skipping game ${game.id} (${game.homeTeam} vs ${game.awayTeam}):`, (gameErr as any).message);
    }
  }

  // Sort by highest edge (spread or total)
  plays.sort((a, b) => {
    const ea = Math.max(Math.abs(a.spreadEdge ?? 0), Math.abs(a.totalEdge ?? 0));
    const eb = Math.max(Math.abs(b.spreadEdge ?? 0), Math.abs(b.totalEdge ?? 0));
    return eb - ea;
  });

  console.log(`[NCAAB] Computed ${plays.length} live plays`);
  return plays;
}
