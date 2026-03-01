const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ESPN_NCAAB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball";

interface CacheEntry { data: any; timestamp: number; }
const cache = new Map<string, CacheEntry>();
const GAMES_TTL   = 90 * 1000;
const BOX_TTL     = 60 * 1000;
const LINES_TTL   = 5 * 60 * 1000;

// Historical NCAAB pace constants
const NCAAB_AVG_PACE    = 3.45;  // pts/min ≈ 138 pt avg game / 40 min
const NCAAB_H1_FRACTION = 0.47;  // H1 ≈ 47% of game total (NCAAB H1 pace is slower)
const NCAAB_PACE_CAP    = 1.35;  // max multiplier of avg pace to cap outliers

function isFresh(e: CacheEntry | undefined, ttl: number) {
  return !!e && Date.now() - e.timestamp < ttl;
}

function normTeam(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}
function teamsMatch(a: string, b: string): boolean {
  const na = normTeam(a); const nb = normTeam(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

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
    if (cached) return cached.data;
    return [];
  }
  if (!res.ok) {
    console.warn(`[NCAAB] Scoreboard HTTP ${res.status}`);
    if (cached) return cached.data;
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

  const [minStr, secStr] = clock.split(":");
  const mins = parseInt(minStr ?? "0", 10);
  const secs = parseInt(secStr ?? "0", 10);
  const clockSeconds = (isNaN(mins) || isNaN(secs)) ? 0 : mins * 60 + secs;
  const secondsRemainingInHalf = isHalftime ? 1200 : clockSeconds;

  const half = period <= 1 ? 1 : 2;

  const scoringByPeriod: Record<string, number[]> = {};
  for (const teamObj of (boxscore?.teams ?? [])) {
    const abbr: string = teamObj.team?.abbreviation ?? "";
    const lineScores: number[] = (teamObj.lineScores ?? []).map((ls: any) =>
      parseInt(ls.value ?? "0", 10)
    );
    if (abbr) scoringByPeriod[abbr] = lineScores;
  }

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
    gameId, period, half, clock, clockSeconds, isHalftime,
    secondsRemainingInHalf, scoringByPeriod, teamStats, statusDesc,
  };

  cache.set(key, { data: result, timestamp: Date.now() });
  return result;
}

// ── The Odds API — NCAAB game lines (spreads + totals + 1H markets) ───────────
export async function getNCAABOddsLines(): Promise<any[]> {
  const key = "ncaab_odds_lines";
  const cached = cache.get(key);
  if (isFresh(cached, LINES_TTL)) return cached!.data;

  if (!ODDS_API_KEY) {
    console.warn("[NCAAB] ODDS_API_KEY not set — skipping Odds API");
    return [];
  }

  try {
    const url = `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=spreads,totals,h1_totals,h1_spreads&bookmakers=fanduel,draftkings,betmgm,betrivers&oddsFormat=american`;
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

// ── Extract consensus spread / total + 1H lines ───────────────────────────────
function extractLines(oddsEvent: any): {
  spread: number | null;
  total: number | null;
  favorite: string;
  bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string; h1Total: number | null; h1Spread: number | null; h1Favorite: string }>;
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;
} {
  let spread: number | null = null;
  let total: number | null = null;
  let favorite = "";
  let h1TotalLine: number | null = null;
  let h1SpreadLine: number | null = null;
  let h1Favorite = "";
  const bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string; h1Total: number | null; h1Spread: number | null; h1Favorite: string }> = [];

  for (const bk of (oddsEvent.bookmakers ?? [])) {
    const spreadsMarket   = (bk.markets ?? []).find((m: any) => m.key === "spreads");
    const totalsMarket    = (bk.markets ?? []).find((m: any) => m.key === "totals");
    const h1TotalsMarket  = (bk.markets ?? []).find((m: any) => m.key === "h1_totals");
    const h1SpreadsMarket = (bk.markets ?? []).find((m: any) => m.key === "h1_spreads");

    let bkSpread: number | null = null;
    let bkTotal: number | null = null;
    let bkFav = "";
    let bkH1Total: number | null = null;
    let bkH1Spread: number | null = null;
    let bkH1Fav = "";

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
    if (h1TotalsMarket?.outcomes?.length >= 1) {
      const over = h1TotalsMarket.outcomes.find((o: any) => o.name === "Over");
      if (over) bkH1Total = over.point as number;
    }
    if (h1SpreadsMarket?.outcomes?.length >= 2) {
      const favOutcome = h1SpreadsMarket.outcomes.find((o: any) => o.point < 0);
      if (favOutcome) {
        bkH1Spread = Math.abs(favOutcome.point);
        bkH1Fav = favOutcome.name;
      } else {
        const sorted = [...h1SpreadsMarket.outcomes].sort((a: any, b: any) => Math.abs(a.point) - Math.abs(b.point));
        bkH1Spread = Math.abs(sorted[0].point);
        bkH1Fav = sorted[0].name;
      }
    }

    if (bkSpread !== null || bkTotal !== null || bkH1Total !== null) {
      bookLines.push({ book: bk.key, spread: bkSpread, total: bkTotal, favorite: bkFav, h1Total: bkH1Total, h1Spread: bkH1Spread, h1Favorite: bkH1Fav });
    }
    if (spread === null && bkSpread !== null) { spread = bkSpread; favorite = bkFav; }
    if (total === null && bkTotal !== null) total = bkTotal;
    if (h1TotalLine === null && bkH1Total !== null) h1TotalLine = bkH1Total;
    if (h1SpreadLine === null && bkH1Spread !== null) { h1SpreadLine = bkH1Spread; h1Favorite = bkH1Fav; }
    if (spread !== null && total !== null && h1TotalLine !== null) break;
  }

  return { spread, total, favorite, bookLines, h1TotalLine, h1SpreadLine, h1Favorite };
}

// ── Public handle signal ──────────────────────────────────────────────────────
function getHandleSignal(bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string; h1Total?: number | null; h1Spread?: number | null; h1Favorite?: string }>): {
  pct: number | null;
  signal: "no_edge" | "fade" | "extreme" | "neutral" | "unavailable";
  label: string;
  color: string;
} {
  const spreads = bookLines.map(b => b.spread).filter((s): s is number => s !== null);
  if (spreads.length < 2) {
    return { pct: null, signal: "unavailable", label: "Handle data unavailable", color: "text-muted-foreground" };
  }
  const min = Math.min(...spreads);
  const max = Math.max(...spreads);
  const deviation = max - min;
  if (deviation >= 2.0) {
    return { pct: 80, signal: "fade", label: "Fade Opportunity — cross-book spread gap ≥2", color: "text-yellow-400" };
  }
  if (deviation >= 1.0) {
    return { pct: 70, signal: "neutral", label: "Neutral — minor cross-book deviation", color: "text-muted-foreground" };
  }
  return { pct: 55, signal: "no_edge", label: "No edge — tight consensus across books", color: "text-muted-foreground" };
}

// ── NCAABPlay interface ────────────────────────────────────────────────────────
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
  bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string; h1Total: number | null; h1Spread: number | null; h1Favorite: string }>;
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;

  // Projections
  projectedTotal: number | null;
  projectedMargin: number | null;
  proj1HTotal: number | null;
  homeProjected: number | null;
  awayProjected: number | null;

  // Probabilities (0–100%)
  spreadProb: number | null;
  overProb: number | null;
  spreadEdge: number | null;
  totalEdge: number | null;
  over1HProb: number | null;
  total1HEdge: number | null;

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

  // Raw box data
  scoringByPeriod: Record<string, number[]>;
  teamStats: Record<string, any>;
}

const HALF_SECONDS = 1200;

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
      const { spread, total, favorite, bookLines, h1TotalLine: rawH1TotalLine, h1SpreadLine, h1Favorite } = oddsEvent
        ? extractLines(oddsEvent)
        : { spread: null, total: null, favorite: "", bookLines: [], h1TotalLine: null, h1SpreadLine: null, h1Favorite: "" };

      // ── Box score data ───────────────────────────────────────────────────
      const half        = box?.half ?? (game.period <= 1 ? 1 : 2);
      const isHalftime  = game.isHalftime || box?.isHalftime;
      const secondsLeft = box?.secondsRemainingInHalf ?? (isHalftime ? 1200 : 600);
      const scoringByPeriod = box?.scoringByPeriod ?? {};
      const teamStats       = box?.teamStats ?? {};

      const homeAbbr = game.homeTeamAbbr;
      const awayAbbr = game.awayTeamAbbr;

      const homeScores: number[] = scoringByPeriod[homeAbbr] ?? [];
      const awayScores: number[] = scoringByPeriod[awayAbbr] ?? [];

      const h1Home = homeScores[0] ?? Math.round(game.homeScore / (half === 2 ? 2 : 1) * 0.5);
      const h1Away = awayScores[0] ?? Math.round(game.awayScore / (half === 2 ? 2 : 1) * 0.5);
      const h1Total = h1Home + h1Away;

      const h2Home = homeScores[1] ?? (half === 2 ? game.homeScore - h1Home : 0);
      const h2Away = awayScores[1] ?? (half === 2 ? game.awayScore - h1Away : 0);
      const h2TotalSoFar = h2Home + h2Away;

      // Cap H1 pace to prevent outlier H1 from inflating H2 projection
      const rawPaceH1 = h1Total > 0 ? h1Total / 20 : NCAAB_AVG_PACE;
      const paceH1 = Math.min(rawPaceH1, NCAAB_AVG_PACE * NCAAB_PACE_CAP);

      const currentTotal = game.homeScore + game.awayScore;
      const currentMargin = game.homeScore - game.awayScore;
      const homeStats = teamStats[homeAbbr] ?? {};
      const awayStats = teamStats[awayAbbr] ?? {};

      // ── Coaching tendency modifiers ──────────────────────────────────────
      let volatilityBonus = 0;
      let projTotalBonus = 0;
      let desperation3s = false;
      let intentionalFouling = false;

      if (half === 2 && !isHalftime) {
        if (currentMargin <= -8) {
          const fga = homeStats.fieldGoalsAttempted ?? 0;
          const fg3a = homeStats.threePointAttempted ?? 0;
          if (fga > 0 && fg3a / fga > 0.40) { volatilityBonus += 4; desperation3s = true; }
        }
        if (currentMargin >= 8) {
          const fga = awayStats.fieldGoalsAttempted ?? 0;
          const fg3a = awayStats.threePointAttempted ?? 0;
          if (fga > 0 && fg3a / fga > 0.40) { volatilityBonus += 4; desperation3s = true; }
        }
        if (currentMargin >= 8) {
          if ((awayStats.fouls ?? 0) >= 4) { projTotalBonus += 6; intentionalFouling = true; }
        } else if (currentMargin <= -8) {
          if ((homeStats.fouls ?? 0) >= 4) { projTotalBonus += 6; intentionalFouling = true; }
        }
      }

      // ── Projections ──────────────────────────────────────────────────────
      let projectedTotal: number | null = null;
      let projectedMargin: number | null = null;
      let proj1HTotal: number | null = null;

      if (isHalftime) {
        // Halftime: paceH1 is already capped, project H2
        projectedTotal = h1Total + (paceH1 * 20) + projTotalBonus;
        projectedMargin = currentMargin;

      } else if (half === 1) {
        // H1 window: blend live pace with historical NCAAB average
        // Weight shifts from historical (0 elapsed) to live (12+ min elapsed)
        const h1MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
        const rawPaceH1Live = h1MinElapsed > 0.5
          ? currentTotal / h1MinElapsed
          : NCAAB_AVG_PACE;

        // blend = 0 at tip-off → 1.0 after 12 min elapsed
        const blend = Math.min(1.0, h1MinElapsed / 12);
        const blendedPace = rawPaceH1Live * blend + NCAAB_AVG_PACE * (1 - blend);

        const remainH1Min = secondsLeft / 60;

        // 1H projection: current score + remaining H1 at blended pace
        proj1HTotal = Math.round((currentTotal + blendedPace * remainH1Min) * 10) / 10;

        // Full game projection: projected H1 + estimated H2 at same blended pace
        const projH1Full = currentTotal + blendedPace * remainH1Min;
        projectedTotal = projH1Full + (blendedPace * 20) + projTotalBonus;
        projectedMargin = null;

      } else if (half === 2) {
        // H2: 70/30 blend (live H2 pace × 0.7 + H1 pace × 0.3), cap live H2 pace
        const h2MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
        const rawPaceH2Live = h2MinElapsed > 0 ? h2TotalSoFar / h2MinElapsed : paceH1;
        const paceH2Live = Math.min(rawPaceH2Live, NCAAB_AVG_PACE * 1.5);
        const paceH2 = paceH2Live * 0.70 + paceH1 * 0.30;
        const remainMin = secondsLeft / 60;
        projectedTotal = h1Total + h2TotalSoFar + (paceH2 * remainMin) + projTotalBonus;

        const h2MarginSoFar = h2Home - h2Away;
        const marginPerMin = h2MinElapsed > 0 ? h2MarginSoFar / h2MinElapsed : 0;
        projectedMargin = currentMargin + (marginPerMin * remainMin);
      }

      // ── Team total split ─────────────────────────────────────────────────
      let homeProjected: number | null = null;
      let awayProjected: number | null = null;

      if (projectedTotal !== null) {
        // 60% live score share + 40% even split to dampen early-game swings
        const homeShare = currentTotal > 0
          ? (game.homeScore / currentTotal) * 0.6 + 0.5 * 0.4
          : 0.5;
        homeProjected = Math.round(projectedTotal * homeShare * 10) / 10;
        awayProjected = Math.round(projectedTotal * (1 - homeShare) * 10) / 10;
      }

      // ── 1H total line (API or fallback estimate) ──────────────────────────
      const h1TotalLine = rawH1TotalLine !== null
        ? rawH1TotalLine
        : total !== null ? Math.round(total * NCAAB_H1_FRACTION * 2) / 2 : null;

      // ── Volatility + sigmoid ─────────────────────────────────────────────
      let volatility: number | null = null;
      let spreadProb: number | null = null;
      let overProb: number | null = null;
      let spreadEdge: number | null = null;
      let totalEdge: number | null = null;
      let over1HProb: number | null = null;
      let total1HEdge: number | null = null;

      if (projectedTotal !== null || projectedMargin !== null) {
        const secsForVol = isHalftime ? 1200 : secondsLeft;
        volatility = Math.max(4, 18 * (secsForVol / 2400)) + volatilityBonus;

        // Effective lines — use API line if available, otherwise fall back to
        // projected total rounded to nearest 0.5 so we always produce a probability
        const effectiveFGLine = total ?? (projectedTotal !== null ? Math.round(projectedTotal * 2) / 2 : null);
        const effective1HLine = h1TotalLine ?? (proj1HTotal !== null ? Math.round(proj1HTotal * 2) / 2 : null);

        if (projectedMargin !== null && spread !== null) {
          const adjustedSpread = teamsMatch(favorite, game.homeTeam) ? -spread : spread;
          spreadProb = Math.round(sigmoid((projectedMargin - adjustedSpread) / volatility) * 1000) / 10;
          spreadEdge = Math.round((spreadProb - 50) * 10) / 10;
        }
        if (projectedTotal !== null && effectiveFGLine !== null) {
          overProb = Math.round(sigmoid((projectedTotal - effectiveFGLine) / volatility) * 1000) / 10;
          totalEdge = Math.round((overProb - 50) * 10) / 10;
        }
        // 1H probability — computed during H1 using effective line
        if (half === 1 && proj1HTotal !== null && effective1HLine !== null) {
          const h1Vol = Math.max(3, volatility * 0.6);
          over1HProb = Math.round(sigmoid((proj1HTotal - effective1HLine) / h1Vol) * 1000) / 10;
          total1HEdge = Math.round((over1HProb - 50) * 10) / 10;
        }
      }

      // ── Betting window ───────────────────────────────────────────────────
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
        h1TotalLine,
        h1SpreadLine,
        h1Favorite,
        projectedTotal: projectedTotal !== null ? Math.round(projectedTotal * 10) / 10 : null,
        projectedMargin: projectedMargin !== null ? Math.round(projectedMargin * 10) / 10 : null,
        proj1HTotal,
        homeProjected,
        awayProjected,
        spreadProb,
        overProb,
        spreadEdge,
        totalEdge,
        over1HProb,
        total1HEdge,
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

  plays.sort((a, b) => {
    const ea = Math.max(Math.abs(a.spreadEdge ?? 0), Math.abs(a.totalEdge ?? 0));
    const eb = Math.max(Math.abs(b.spreadEdge ?? 0), Math.abs(b.totalEdge ?? 0));
    return eb - ea;
  });

  console.log(`[NCAAB] Computed ${plays.length} live plays`);
  return plays;
}
