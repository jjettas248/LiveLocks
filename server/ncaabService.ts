const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ESPN_NCAAB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball";

interface CacheEntry { data: any; timestamp: number; }
const cache = new Map<string, CacheEntry>();
const GAMES_TTL        = 90 * 1000;
const BOX_TTL          = 60 * 1000;
const LINES_TTL        = 5 * 60 * 1000;
const SEASON_STATS_TTL = 6 * 60 * 60 * 1000;
const ROSTER_TTL       = 15 * 60 * 1000;

// Historical NCAAB constants
const NCAAB_AVG_PACE   = 3.45;   // pts/min ≈ 138 pt avg game / 40 min
const NCAAB_H1_FRACTION = 0.47;  // H1 ≈ 47% of game total
const NCAAB_PACE_CAP   = 1.35;   // max pace multiplier
const NCAAB_AVG_OE     = 108;    // avg offensive efficiency per 100 possessions
const NCAAB_AVG_STEALS = 6.5;    // avg steals per game
const NCAAB_AVG_BLOCKS = 3.0;    // avg blocks per game
const HOME_COURT_ADV   = 3.5;    // home court advantage in pts

// ── Team season stats with full KenPom-style metrics ─────────────────────────
interface TeamSeasonStats {
  ppg: number;
  oppPpg: number;
  fgaPerGame: number;
  orebPerGame: number;
  toPerGame: number;
  ftaPerGame: number;
  threePAPerGame: number;
  threePARate: number;      // 3PA / FGA
  avgSteals: number;
  avgBlocks: number;
  avgFouls: number;
  poss: number;             // possessions per game
  oe: number;               // offensive efficiency per 100 poss
}

function defaultTeamStats(): TeamSeasonStats {
  return {
    ppg: 69, oppPpg: 69,
    fgaPerGame: 60, orebPerGame: 11, toPerGame: 13, ftaPerGame: 19,
    threePAPerGame: 22, threePARate: 0.37,
    avgSteals: 6.5, avgBlocks: 3.0, avgFouls: 15.7,
    poss: 68, oe: 101,
  };
}

async function getNCAABTeamSeasonStats(teamId: string): Promise<TeamSeasonStats> {
  if (!teamId) return defaultTeamStats();
  const key = `ncaab_team_stats_v2_${teamId}`;
  const cached = cache.get(key);
  if (isFresh(cached, SEASON_STATS_TTL)) return cached!.data;

  try {
    const res = await fetch(
      `${ESPN_NCAAB}/teams/${teamId}/statistics`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return defaultTeamStats();
    const data = await res.json() as any;

    const categories = data.results?.stats?.categories ?? data.statistics?.categories ?? [];
    const statMap: Record<string, number> = {};

    for (const cat of categories) {
      for (const s of (cat.stats ?? [])) {
        const val = parseFloat(s.displayValue ?? s.value ?? "");
        if (!isNaN(val)) statMap[s.name] = val;
      }
    }

    const ppg      = statMap["avgPoints"] ?? statMap["ppg"] ?? 69;
    const fga      = statMap["avgFieldGoalsAttempted"] ?? 60;
    const oreb     = statMap["avgOffensiveRebounds"] ?? 11;
    const to_      = statMap["avgTurnovers"] ?? 13;
    const fta      = statMap["avgFreeThrowsAttempted"] ?? 19;
    const threePA  = statMap["avgThreePointFieldGoalsAttempted"] ?? 22;
    const steals   = statMap["avgSteals"] ?? 6.5;
    const blocks   = statMap["avgBlocks"] ?? 3.0;
    const fouls    = statMap["avgFouls"] ?? 15.7;

    const poss     = Math.max(55, fga - oreb + to_ + 0.44 * fta);
    const oe       = poss > 0 ? Math.round((ppg * 100 / poss) * 10) / 10 : NCAAB_AVG_OE;

    const result: TeamSeasonStats = {
      ppg,
      oppPpg: statMap["oppg"] ?? statMap["avgOpponentPoints"] ?? 69,
      fgaPerGame: fga,
      orebPerGame: oreb,
      toPerGame: to_,
      ftaPerGame: fta,
      threePAPerGame: threePA,
      threePARate: fga > 0 ? threePA / fga : 0.37,
      avgSteals: steals,
      avgBlocks: blocks,
      avgFouls: fouls,
      poss,
      oe,
    };
    cache.set(key, { data: result, timestamp: Date.now() });
    return result;
  } catch {
    return defaultTeamStats();
  }
}

// ── Team roster — injury detection ───────────────────────────────────────────
interface TeamRosterInfo {
  injuredNames: string[];
  injuryCount: number;
  injuryPenalty: number;
}

async function getNCAABTeamRoster(teamId: string): Promise<TeamRosterInfo> {
  if (!teamId) return { injuredNames: [], injuryCount: 0, injuryPenalty: 0 };
  const key = `ncaab_roster_${teamId}`;
  const cached = cache.get(key);
  if (isFresh(cached, ROSTER_TTL)) return cached!.data;

  try {
    const res = await fetch(
      `${ESPN_NCAAB}/teams/${teamId}/roster`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { injuredNames: [], injuryCount: 0, injuryPenalty: 0 };
    const data = await res.json() as any;

    const injuredNames: string[] = [];
    for (const athlete of (data.athletes ?? [])) {
      const injArr: any[] = athlete.injuries ?? [];
      if (injArr.length > 0) {
        injuredNames.push(athlete.displayName ?? athlete.fullName ?? "Unknown");
      }
    }

    const injuryCount = injuredNames.length;
    const injuryPenalty = Math.min(injuryCount * 2, 4);
    const result: TeamRosterInfo = { injuredNames, injuryCount, injuryPenalty };
    cache.set(key, { data: result, timestamp: Date.now() });
    return result;
  } catch {
    return { injuredNames: [], injuryCount: 0, injuryPenalty: 0 };
  }
}

// ── ESPN NCAAB Predictor (live win probability) ───────────────────────────────
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball";

async function getNCAABPredictor(gameId: string): Promise<{ homeWinPct: number; awayWinPct: number } | null> {
  const key = `ncaab_predictor_${gameId}`;
  const cached = cache.get(key);
  if (isFresh(cached, 60 * 1000)) return cached!.data;

  try {
    const res = await fetch(
      `${ESPN_CORE}/events/${gameId}/competitions/${gameId}/predictor`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as any;

    const homeWinPct = parseFloat(data.homeTeam?.gameProjection ?? "") || null;
    const awayWinPct = parseFloat(data.awayTeam?.gameProjection ?? "") || null;

    if (homeWinPct === null || awayWinPct === null) return null;
    const result = { homeWinPct, awayWinPct };
    cache.set(key, { data: result, timestamp: Date.now() });
    return result;
  } catch {
    return null;
  }
}

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

function teamSimilarity(outcome: string, home: string): number {
  const na = normTeam(outcome), nb = normTeam(home);
  if (na === nb) return 999;
  const ta = na.split(" "), tb = nb.split(" ");
  return ta.filter(w => tb.includes(w)).length;
}

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }

// ── ESPN NCAAB Scoreboard ────────────────────────────────────────────────────
export async function getNCAABScoreboard(): Promise<any[]> {
  const key = "ncaab_scoreboard";
  const cached = cache.get(key);
  if (isFresh(cached, GAMES_TTL)) return cached!.data;

  let res: Response;
  try {
    const _now = new Date();
    const _today = _now.getFullYear().toString()
      + String(_now.getMonth() + 1).padStart(2, "0")
      + String(_now.getDate()).padStart(2, "0");
    res = await fetch(`${ESPN_NCAAB}/scoreboard?limit=300&groups=50&dates=${_today}`, {
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
    const startTime: string | null = event.date ?? null;
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
      startTime,
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
    const url = `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=spreads,totals&oddsFormat=american`;
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

// Sportsbook display names
const BOOK_DISPLAY: Record<string, string> = {
  fanduel:      "FanDuel",
  draftkings:   "DraftKings",
  betmgm:       "BetMGM",
  betrivers:    "BetRivers",
  hardrockbet:  "Hard Rock",
  bet365:       "Bet365",
  caesars:      "Caesars",
  pointsbet:    "PointsBet",
  espnbet:      "ESPN Bet",
  betus:        "BetUS",
  mybookieag:   "MyBookie",
  lowvig:       "LowVig",
  betonlineag:  "BetOnline",
};

// ── Extract per-book spread / total lines (both sides) ───────────────────────
function extractLines(oddsEvent: any): {
  homeSpreadLine: number | null;
  awaySpreadLine: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  bookLines: Array<{
    book: string;
    name: string;
    homePoint: number | null;
    awayPoint: number | null;
    homeSpreadPrice: number | null;
    awaySpreadPrice: number | null;
    homeFavorite: boolean;
    total: number | null;
    overPrice: number | null;
    underPrice: number | null;
  }>;
} {
  let homeSpreadLine: number | null = null;
  let awaySpreadLine: number | null = null;
  let total: number | null = null;
  let overPrice: number | null = null;
  let underPrice: number | null = null;

  const eventHome = (oddsEvent.home_team ?? "").toLowerCase();

  const bookLines: Array<{
    book: string;
    name: string;
    homePoint: number | null;
    awayPoint: number | null;
    homeSpreadPrice: number | null;
    awaySpreadPrice: number | null;
    homeFavorite: boolean;
    total: number | null;
    overPrice: number | null;
    underPrice: number | null;
  }> = [];

  for (const bk of (oddsEvent.bookmakers ?? [])) {
    const spreadsMarket = (bk.markets ?? []).find((m: any) => m.key === "spreads");
    const totalsMarket  = (bk.markets ?? []).find((m: any) => m.key === "totals");

    let bkHomePoint: number | null = null;
    let bkAwayPoint: number | null = null;
    let bkHomePrice: number | null = null;
    let bkAwayPrice: number | null = null;
    let bkHomeFav = false;
    let bkTotal: number | null = null;
    let bkOverPrice: number | null = null;
    let bkUnderPrice: number | null = null;

    if (spreadsMarket?.outcomes?.length >= 2) {
      const outcomes = spreadsMarket.outcomes as Array<{ name: string; point: number; price: number }>;
      const scores = outcomes.map(o => teamSimilarity(o.name, oddsEvent.home_team));
      const maxScore = Math.max(...scores);
      let homeIdx = scores.indexOf(maxScore);
      if (scores[0] === scores[1]) {
        homeIdx = teamsMatch(outcomes[0].name, oddsEvent.home_team) ? 0 : 1;
      }
      const homeOutcome = outcomes[homeIdx];
      const awayOutcome = outcomes[homeIdx === 0 ? 1 : 0];
      bkHomePoint = isNaN(homeOutcome.point) ? null : homeOutcome.point;
      bkHomePrice = homeOutcome.price;
      bkAwayPoint = isNaN(awayOutcome.point) ? null : awayOutcome.point;
      bkAwayPrice = awayOutcome.price;
      bkHomeFav = (bkHomePoint ?? 0) < 0;
    }

    if (totalsMarket?.outcomes?.length >= 1) {
      for (const o of totalsMarket.outcomes) {
        if (o.name === "Over") { bkTotal = o.point as number; bkOverPrice = o.price as number; }
        else if (o.name === "Under") { bkUnderPrice = o.price as number; }
      }
    }

    if (bkHomePoint !== null || bkAwayPoint !== null || bkTotal !== null) {
      bookLines.push({
        book: bk.key,
        name: BOOK_DISPLAY[bk.key] ?? bk.title ?? bk.key,
        homePoint: bkHomePoint,
        awayPoint: bkAwayPoint,
        homeSpreadPrice: bkHomePrice,
        awaySpreadPrice: bkAwayPrice,
        homeFavorite: bkHomeFav,
        total: bkTotal,
        overPrice: bkOverPrice,
        underPrice: bkUnderPrice,
      });
    }

    if (homeSpreadLine === null && bkHomePoint !== null) homeSpreadLine = bkHomePoint;
    if (awaySpreadLine === null && bkAwayPoint !== null) awaySpreadLine = bkAwayPoint;
    if (total === null && bkTotal !== null) { total = bkTotal; overPrice = bkOverPrice; underPrice = bkUnderPrice; }
  }

  return { homeSpreadLine, awaySpreadLine, total, overPrice, underPrice, bookLines };
}

// ── Public handle signal ──────────────────────────────────────────────────────
function getHandleSignal(bookLines: Array<{ homePoint: number | null }>): {
  pct: number | null;
  signal: "no_edge" | "fade" | "extreme" | "neutral" | "unavailable";
  label: string;
  color: string;
} {
  const spreads = bookLines.map(b => b.homePoint !== null ? Math.abs(b.homePoint) : null).filter((s): s is number => s !== null);
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

  // Lines (from Odds API)
  homeSpreadLine: number | null;
  awaySpreadLine: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  bookLines: Array<{
    book: string;
    name: string;
    homePoint: number | null;
    awayPoint: number | null;
    homeSpreadPrice: number | null;
    awaySpreadPrice: number | null;
    homeFavorite: boolean;
    total: number | null;
    overPrice: number | null;
    underPrice: number | null;
  }>;

  // 1H model-derived lines
  h1TotalLineModel: number | null;
  h1SpreadLine: number | null;
  h1SpreadProb: number | null;
  proj1HHome: number | null;
  proj1HAway: number | null;
  h1HomeOverProb: number | null;
  h1AwayOverProb: number | null;

  // Projections
  projectedTotal: number | null;
  projectedMargin: number | null;
  proj1HTotal: number | null;
  homeProjected: number | null;
  awayProjected: number | null;

  // Season stats baseline (KenPom-style)
  seasonExpectedTotal: number;
  seasonExpectedMargin: number;
  homePPG: number;
  awayPPG: number;
  homeTempo: number;
  awayTempo: number;
  homeOE: number;
  awayOE: number;
  homeDE: number;
  awayDE: number;
  expectedPoss: number;

  // Style flags
  homeThreePARate: number;
  awayThreePARate: number;

  // Injury info
  homeInjuries: string[];
  awayInjuries: string[];

  // Probabilities (0–100%)
  spreadProb: number | null;
  overProb: number | null;
  spreadEdge: number | null;
  totalEdge: number | null;
  over1HProb: number | null;
  total1HEdge: number | null;
  homeOverProb: number | null;
  awayOverProb: number | null;

  // ESPN Predictor
  espnHomeWinPct: number | null;
  espnAwayWinPct: number | null;

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
      // Fetch box score, season stats, rosters, predictor — all in parallel
      const [box, homeSeasonStats, awaySeasonStats, homeRosterInfo, awayRosterInfo, predictorData] =
        await Promise.all([
          getNCAABBoxScore(game.id).catch(() => null),
          getNCAABTeamSeasonStats(game.homeTeamId),
          getNCAABTeamSeasonStats(game.awayTeamId),
          getNCAABTeamRoster(game.homeTeamId),
          getNCAABTeamRoster(game.awayTeamId),
          getNCAABPredictor(game.id).catch(() => null),
        ]);

      const oddsEvent = matchOddsEvent(game, oddsEvents);
      const { homeSpreadLine, awaySpreadLine, total, overPrice, underPrice, bookLines } = oddsEvent
        ? extractLines(oddsEvent)
        : { homeSpreadLine: null, awaySpreadLine: null, total: null, overPrice: null, underPrice: null, bookLines: [] };

      // ── KenPom-style possession-based model ──────────────────────────────
      // DE (defensive efficiency): penalize for above-average steals and blocks
      const homeDE = Math.max(95, NCAAB_AVG_OE
        - (homeSeasonStats.avgSteals - NCAAB_AVG_STEALS) * 2.0
        - (homeSeasonStats.avgBlocks - NCAAB_AVG_BLOCKS) * 1.5);
      const awayDE = Math.max(95, NCAAB_AVG_OE
        - (awaySeasonStats.avgSteals - NCAAB_AVG_STEALS) * 2.0
        - (awaySeasonStats.avgBlocks - NCAAB_AVG_BLOCKS) * 1.5);

      // Expected possessions: blend both teams' tempos
      const expectedPoss = (homeSeasonStats.poss + awaySeasonStats.poss) / 2;

      // Cross-product OE × DE model
      const homeExpectedRaw = (homeSeasonStats.oe * awayDE / 10000) * expectedPoss;
      const awayExpectedRaw = (awaySeasonStats.oe * homeDE / 10000) * expectedPoss;

      // Injury penalty — reduce projected scores for teams with injured players
      const homeExpected = homeExpectedRaw - homeRosterInfo.injuryPenalty;
      const awayExpected = awayExpectedRaw - awayRosterInfo.injuryPenalty;

      const seasonExpectedTotal  = homeExpected + awayExpected;
      const seasonExpectedMargin = homeExpected - awayExpected + HOME_COURT_ADV;

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
      const homeBoxStats = teamStats[homeAbbr] ?? {};
      const awayBoxStats = teamStats[awayAbbr] ?? {};

      // ── Volatility modifiers: coaching style + 3PT reliance ─────────────
      let volatilityBonus = 0;
      let projTotalBonus = 0;
      let desperation3s = false;
      let intentionalFouling = false;

      // Season-level style: 3PT-heavy teams increase variance
      if (homeSeasonStats.threePARate > 0.42) volatilityBonus += 3;
      if (awaySeasonStats.threePARate > 0.42) volatilityBonus += 3;
      // Foul-prone teams increase variance (more FTs = more uncertainty)
      if (homeSeasonStats.avgFouls > 18 || awaySeasonStats.avgFouls > 18) volatilityBonus += 2;

      // In-game coaching tendency modifiers (H2 only)
      if (half === 2 && !isHalftime) {
        if (currentMargin <= -8) {
          const fga = homeBoxStats.fieldGoalsAttempted ?? 0;
          const fg3a = homeBoxStats.threePointAttempted ?? 0;
          if (fga > 0 && fg3a / fga > 0.40) { volatilityBonus += 4; desperation3s = true; }
        }
        if (currentMargin >= 8) {
          const fga = awayBoxStats.fieldGoalsAttempted ?? 0;
          const fg3a = awayBoxStats.threePointAttempted ?? 0;
          if (fga > 0 && fg3a / fga > 0.40) { volatilityBonus += 4; desperation3s = true; }
        }
        if (currentMargin >= 8) {
          if ((awayBoxStats.fouls ?? 0) >= 4) { projTotalBonus += 6; intentionalFouling = true; }
        } else if (currentMargin <= -8) {
          if ((homeBoxStats.fouls ?? 0) >= 4) { projTotalBonus += 6; intentionalFouling = true; }
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
        const h1MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
        const rawPaceH1Live = h1MinElapsed > 0.5
          ? currentTotal / h1MinElapsed
          : NCAAB_AVG_PACE;
        const blend = Math.min(1.0, h1MinElapsed / 12);
        const blendedPace = rawPaceH1Live * blend + NCAAB_AVG_PACE * (1 - blend);
        const remainH1Min = secondsLeft / 60;

        proj1HTotal = Math.round((currentTotal + blendedPace * remainH1Min) * 10) / 10;

        const projH1Full = currentTotal + blendedPace * remainH1Min;
        projectedTotal = projH1Full + (blendedPace * 20) + projTotalBonus;

        const homeShareH1 = currentTotal > 0
          ? (game.homeScore / currentTotal) * 0.6 + 0.5 * 0.4
          : 0.5;
        const remainingH1Scoring = blendedPace * remainH1Min;
        const proj1HHomeScore = game.homeScore + remainingH1Scoring * homeShareH1;
        const proj1HAwayScore = game.awayScore + remainingH1Scoring * (1 - homeShareH1);
        projectedMargin = Math.max(-30, Math.min(30, Math.round((proj1HHomeScore - proj1HAwayScore) * 10) / 10));

      } else if (half === 2) {
        const h2MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
        const rawPaceH2Live = h2MinElapsed > 0 ? h2TotalSoFar / h2MinElapsed : paceH1;
        const paceH2Live = Math.min(rawPaceH2Live, NCAAB_AVG_PACE * 1.5);
        const paceH2 = paceH2Live * 0.70 + paceH1 * 0.30;
        const remainMin = secondsLeft / 60;
        projectedTotal = h1Total + h2TotalSoFar + (paceH2 * remainMin) + projTotalBonus;

        // ── Fix: cap margin extrapolation when < 2 min elapsed in H2 ──────
        if (h2MinElapsed < 2) {
          projectedMargin = currentMargin;
        } else {
          const rawPerMin = (h2Home - h2Away) / h2MinElapsed;
          const cappedPerMin = Math.max(-3, Math.min(3, rawPerMin));
          projectedMargin = currentMargin + cappedPerMin * remainMin;
        }
      }

      // Clamp projected margin to realistic range
      if (projectedMargin !== null) {
        projectedMargin = Math.max(-45, Math.min(45, projectedMargin));
      }

      // ── Team total split ─────────────────────────────────────────────────
      let homeProjected: number | null = null;
      let awayProjected: number | null = null;

      if (projectedTotal !== null) {
        const homeShare = currentTotal > 0
          ? (game.homeScore / currentTotal) * 0.6 + 0.5 * 0.4
          : 0.5;
        homeProjected = Math.round(projectedTotal * homeShare * 10) / 10;
        awayProjected = Math.round(projectedTotal * (1 - homeShare) * 10) / 10;
      }

      // ── 1H model total line (no Odds API support for NCAAB 1H markets) ───
      const h1TotalLineModel = proj1HTotal !== null
        ? Math.round(proj1HTotal * 2) / 2
        : total !== null ? Math.round(total * NCAAB_H1_FRACTION * 2) / 2 : null;

      // ── Volatility + sigmoid probabilities ───────────────────────────────
      let volatility: number | null = null;
      let spreadProb: number | null = null;
      let overProb: number | null = null;
      let spreadEdge: number | null = null;
      let totalEdge: number | null = null;
      let over1HProb: number | null = null;
      let total1HEdge: number | null = null;
      let homeOverProb: number | null = null;
      let awayOverProb: number | null = null;

      // 1H team total model fields
      let proj1HHome: number | null = null;
      let proj1HAway: number | null = null;
      let h1ModelSpreadLine: number | null = null;
      let h1SpreadProb: number | null = null;
      let h1HomeOverProb: number | null = null;
      let h1AwayOverProb: number | null = null;

      if (projectedTotal !== null || projectedMargin !== null) {
        const secsForVol = isHalftime ? 1200 : secondsLeft;
        volatility = Math.max(4, 18 * (secsForVol / 2400)) + volatilityBonus;

        // Effective total line: use book line, or fall back to season-expected (KenPom model baseline)
        const effectiveFGLine = total ?? seasonExpectedTotal;
        const effective1HLine = h1TotalLineModel;

        // Spread probability — homeSpreadLine is signed from home perspective (negative = home fav)
        if (projectedMargin !== null && homeSpreadLine !== null) {
          spreadProb = Math.round(sigmoid((projectedMargin - homeSpreadLine) / volatility) * 1000) / 10;
          spreadEdge = Math.round((spreadProb - 50) * 10) / 10;
        } else if (projectedMargin !== null && homeSpreadLine === null) {
          spreadProb = Math.round(sigmoid((projectedMargin - seasonExpectedMargin) / volatility) * 1000) / 10;
          spreadEdge = Math.round((spreadProb - 50) * 10) / 10;
        }

        // Full game total probability
        if (projectedTotal !== null) {
          overProb = Math.round(sigmoid((projectedTotal - effectiveFGLine) / volatility) * 1000) / 10;
          totalEdge = Math.round((overProb - 50) * 10) / 10;
        }

        // 1H probability
        if (half === 1 && proj1HTotal !== null && effective1HLine !== null) {
          const h1Vol = Math.max(3, volatility * 0.6);
          over1HProb = Math.round(sigmoid((proj1HTotal - effective1HLine) / h1Vol) * 1000) / 10;
          total1HEdge = Math.round((over1HProb - 50) * 10) / 10;

          // 1H team totals (model-derived)
          const homeShare1H = (game.homeScore + game.awayScore) > 0
            ? (game.homeScore / (game.homeScore + game.awayScore)) * 0.6 + 0.5 * 0.4
            : 0.5;
          proj1HHome = Math.round(proj1HTotal * homeShare1H * 10) / 10;
          proj1HAway = Math.round(proj1HTotal * (1 - homeShare1H) * 10) / 10;

          // 1H model spread line (signed from home perspective)
          h1ModelSpreadLine = projectedMargin !== null ? Math.round(projectedMargin * 2) / 2 : null;
          if (h1ModelSpreadLine !== null) {
            h1SpreadProb = Math.round(sigmoid(projectedMargin! / h1Vol) * 1000) / 10;
          }

          // 1H team over probabilities
          const h1TeamVol = h1Vol * 0.7;
          h1HomeOverProb = Math.round(sigmoid((proj1HHome - homeExpected * 0.47) / h1TeamVol) * 1000) / 10;
          h1AwayOverProb = Math.round(sigmoid((proj1HAway - awayExpected * 0.47) / h1TeamVol) * 1000) / 10;
        }

        // Team total probabilities — compare projected per-team pts to season-expected baseline
        if (homeProjected !== null) {
          homeOverProb = Math.round(sigmoid((homeProjected - homeExpected) / (volatility * 0.7)) * 1000) / 10;
        }
        if (awayProjected !== null) {
          awayOverProb = Math.round(sigmoid((awayProjected - awayExpected) / (volatility * 0.7)) * 1000) / 10;
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
        homeSpreadLine,
        awaySpreadLine,
        total,
        overPrice,
        underPrice,
        bookLines,
        h1TotalLineModel,
        h1SpreadLine: h1ModelSpreadLine,
        h1SpreadProb,
        proj1HHome,
        proj1HAway,
        h1HomeOverProb,
        h1AwayOverProb,
        projectedTotal: projectedTotal !== null ? Math.round(projectedTotal * 10) / 10 : null,
        projectedMargin: projectedMargin !== null ? Math.round(projectedMargin * 10) / 10 : null,
        proj1HTotal,
        homeProjected,
        awayProjected,
        seasonExpectedTotal: Math.round(seasonExpectedTotal * 10) / 10,
        seasonExpectedMargin: Math.round(seasonExpectedMargin * 10) / 10,
        homePPG: homeSeasonStats.ppg,
        awayPPG: awaySeasonStats.ppg,
        homeTempo: Math.round(homeSeasonStats.poss * 10) / 10,
        awayTempo: Math.round(awaySeasonStats.poss * 10) / 10,
        homeOE: homeSeasonStats.oe,
        awayOE: awaySeasonStats.oe,
        homeDE: Math.round(homeDE * 10) / 10,
        awayDE: Math.round(awayDE * 10) / 10,
        expectedPoss: Math.round(expectedPoss * 10) / 10,
        homeThreePARate: Math.round(homeSeasonStats.threePARate * 1000) / 10,
        awayThreePARate: Math.round(awaySeasonStats.threePARate * 1000) / 10,
        homeInjuries: homeRosterInfo.injuredNames,
        awayInjuries: awayRosterInfo.injuredNames,
        spreadProb,
        overProb,
        spreadEdge,
        totalEdge,
        over1HProb,
        total1HEdge,
        homeOverProb,
        awayOverProb,
        espnHomeWinPct: predictorData?.homeWinPct ?? null,
        espnAwayWinPct: predictorData?.awayWinPct ?? null,
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

// ── getNCAABGamesWithLines: scoreboard enriched with odds lines ───────────────
export async function getNCAABGamesWithLines(): Promise<any[]> {
  const [games, oddsEvents] = await Promise.all([
    getNCAABScoreboard(),
    getNCAABOddsLines(),
  ]);

  return games.map((game: any) => {
    const oddsEvent = matchOddsEvent(game, oddsEvents);
    if (!oddsEvent) return { ...game, homeSpreadLine: null, awaySpreadLine: null, total: null };
    const { homeSpreadLine, awaySpreadLine, total } = extractLines(oddsEvent);
    return { ...game, homeSpreadLine, awaySpreadLine, total };
  });
}

// ── getNCAABGamePreview: pre-game KenPom model for a scheduled game ──────────
export async function getNCAABGamePreview(gameId: string): Promise<NCAABPlay | null> {
  const [allGames, oddsEvents] = await Promise.all([
    getNCAABScoreboard(),
    getNCAABOddsLines(),
  ]);

  const game = allGames.find((g: any) => g.id === gameId);
  if (!game) return null;

  const [homeSeasonStats, awaySeasonStats, homeRosterInfo, awayRosterInfo] = await Promise.all([
    getNCAABTeamSeasonStats(game.homeTeamId),
    getNCAABTeamSeasonStats(game.awayTeamId),
    getNCAABTeamRoster(game.homeTeamId),
    getNCAABTeamRoster(game.awayTeamId),
  ]);

  const oddsEvent = matchOddsEvent(game, oddsEvents);
  const { homeSpreadLine, awaySpreadLine, total, overPrice, underPrice, bookLines } = oddsEvent
    ? extractLines(oddsEvent)
    : { homeSpreadLine: null, awaySpreadLine: null, total: null, overPrice: null, underPrice: null, bookLines: [] };

  const homeDE = Math.max(95, NCAAB_AVG_OE
    - (homeSeasonStats.avgSteals - NCAAB_AVG_STEALS) * 2.0
    - (homeSeasonStats.avgBlocks - NCAAB_AVG_BLOCKS) * 1.5);
  const awayDE = Math.max(95, NCAAB_AVG_OE
    - (awaySeasonStats.avgSteals - NCAAB_AVG_STEALS) * 2.0
    - (awaySeasonStats.avgBlocks - NCAAB_AVG_BLOCKS) * 1.5);
  const expectedPoss = (homeSeasonStats.poss + awaySeasonStats.poss) / 2;
  const homeExpected = (homeSeasonStats.oe * awayDE / 10000) * expectedPoss - homeRosterInfo.injuryPenalty;
  const awayExpected = (awaySeasonStats.oe * homeDE / 10000) * expectedPoss - awayRosterInfo.injuryPenalty;
  const seasonExpectedTotal = homeExpected + awayExpected;
  const seasonExpectedMargin = homeExpected - awayExpected + HOME_COURT_ADV;

  const volatility = 14;
  const effectiveFGLine = total ?? seasonExpectedTotal;

  const spreadProb = Math.round(sigmoid((seasonExpectedMargin - (homeSpreadLine ?? seasonExpectedMargin)) / volatility) * 1000) / 10;
  const overProb = Math.round(sigmoid((seasonExpectedTotal - effectiveFGLine) / volatility) * 1000) / 10;
  const spreadEdge = Math.round((spreadProb - 50) * 10) / 10;
  const totalEdge = Math.round((overProb - 50) * 10) / 10;

  const handleSignal = getHandleSignal(bookLines);

  return {
    gameId: game.id,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeTeamAbbr: game.homeTeamAbbr,
    awayTeamAbbr: game.awayTeamAbbr,
    status: game.status,
    clock: "",
    half: 1,
    period: 0,
    homeScore: 0,
    awayScore: 0,
    currentMargin: 0,
    homeSpreadLine,
    awaySpreadLine,
    total,
    overPrice,
    underPrice,
    bookLines,
    h1TotalLineModel: total !== null ? Math.round(total * NCAAB_H1_FRACTION * 2) / 2 : null,
    h1SpreadLine: null,
    h1SpreadProb: null,
    proj1HHome: null,
    proj1HAway: null,
    h1HomeOverProb: null,
    h1AwayOverProb: null,
    projectedTotal: Math.round(seasonExpectedTotal * 10) / 10,
    projectedMargin: Math.round(seasonExpectedMargin * 10) / 10,
    proj1HTotal: null,
    homeProjected: Math.round(homeExpected * 10) / 10,
    awayProjected: Math.round(awayExpected * 10) / 10,
    seasonExpectedTotal: Math.round(seasonExpectedTotal * 10) / 10,
    seasonExpectedMargin: Math.round(seasonExpectedMargin * 10) / 10,
    homePPG: homeSeasonStats.ppg,
    awayPPG: awaySeasonStats.ppg,
    homeTempo: Math.round(homeSeasonStats.poss * 10) / 10,
    awayTempo: Math.round(awaySeasonStats.poss * 10) / 10,
    homeOE: homeSeasonStats.oe,
    awayOE: awaySeasonStats.oe,
    homeDE: Math.round(homeDE * 10) / 10,
    awayDE: Math.round(awayDE * 10) / 10,
    expectedPoss: Math.round(expectedPoss * 10) / 10,
    homeThreePARate: Math.round(homeSeasonStats.threePARate * 1000) / 10,
    awayThreePARate: Math.round(awaySeasonStats.threePARate * 1000) / 10,
    homeInjuries: homeRosterInfo.injuredNames,
    awayInjuries: awayRosterInfo.injuredNames,
    spreadProb,
    overProb,
    spreadEdge,
    totalEdge,
    over1HProb: null,
    total1HEdge: null,
    homeOverProb: null,
    awayOverProb: null,
    espnHomeWinPct: null,
    espnAwayWinPct: null,
    volatilityBonus: 0,
    volatility,
    bettingWindow: "NONE" as const,
    bettingWindowLabel: "",
    handleSignal,
    desperation3s: false,
    intentionalFouling: false,
    scoringByPeriod: {},
    teamStats: {},
  };
}
