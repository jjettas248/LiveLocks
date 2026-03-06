const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SGO_API_KEY  = process.env.SGO_API_KEY;
const ESPN_NCAAB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball";

// Markets to request from Odds API bulk endpoint (h1_spreads/h1_totals cause 422 — covered by SGO instead)
const NCAAB_BULK_MARKETS = "spreads,totals,team_totals";
// Markets for per-event 2H line fetch (halftime only)
const NCAAB_2H_MARKETS   = "h2_totals,h2_spreads";

interface CacheEntry { data: any; timestamp: number; }
const cache = new Map<string, CacheEntry>();
const GAMES_TTL   = 90 * 1000;
const BOX_TTL     = 60 * 1000;
const LINES_TTL   = 5 * 60 * 1000;
const H1_LINES_TTL = 5 * 60 * 1000;

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

// ── Dynamic multiplier: scales certainty with game progress ──────────────────
function getDynamicMultiplier(secsRemaining: number, totalSecs: number, period: number, maxPeriods: number): number {
  if (period > maxPeriods) return 12.0; // overtime — max certainty
  const progress = Math.min(Math.max(1 - secsRemaining / totalSecs, 0), 1);
  if (progress < 0.10) return 3.0;
  if (progress < 0.25) return 4.0;
  if (progress < 0.50) return 5.0;
  if (progress < 0.65) return 6.0;
  if (progress < 0.75) return 7.0;
  if (progress < 0.85) return 8.0;
  if (progress < 0.92) return 10.0;
  return 12.0;
}

function getH1Multiplier(h1Progress: number): number {
  if (h1Progress < 0.10) return 3.0;
  if (h1Progress < 0.25) return 4.0;
  if (h1Progress < 0.50) return 5.0;
  if (h1Progress < 0.65) return 6.0;
  if (h1Progress < 0.75) return 7.0;
  if (h1Progress < 0.85) return 8.0;
  if (h1Progress < 0.92) return 10.0;
  return 12.0;
}

// ── sanitizeProb: early-game guard + 1-99 clamp ──────────────────────────────
function sanitizeProb(prob: number | null, secsElapsed: number, allowExtreme = false): number | null {
  if (prob === null) return null;
  if (secsElapsed < 60 && !allowExtreme) return 50; // < 1 min data: neutral
  return Math.min(Math.max(prob, 1), 99);
}

// ── ESPN NCAAB Scoreboard ────────────────────────────────────────────────────
export async function getNCAABScoreboard(): Promise<any[]> {
  const key = "ncaab_scoreboard";
  const cached = cache.get(key);
  if (isFresh(cached, GAMES_TTL)) return cached!.data;

  let res: Response;
  try {
    res = await fetch(`${ESPN_NCAAB}/scoreboard?limit=300&groups=50`, {
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
      startTime: (event.date as string) ?? "",
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

// ── ESPN NCAAB Head-to-Head history ──────────────────────────────────────────
export async function getNCAABH2H(gameId: string): Promise<any[]> {
  const key = `ncaab_h2h_${gameId}`;
  const cached = cache.get(key);
  if (cached) return cached.data; // H2H data doesn't change once fetched

  try {
    // Step 1: get team IDs from the event summary
    const summaryRes = await fetch(`${ESPN_NCAAB}/summary?event=${gameId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!summaryRes.ok) return [];
    const summary = await summaryRes.json() as any;

    const comps: any[] = summary.header?.competitions?.[0]?.competitors ?? [];
    const homeComp = comps.find((c: any) => c.homeAway === "home");
    const awayComp = comps.find((c: any) => c.homeAway === "away");
    if (!homeComp || !awayComp) return [];

    const awayTeamId = String(awayComp.id ?? awayComp.team?.id ?? "");
    const homeTeamId = String(homeComp.id ?? homeComp.team?.id ?? "");
    const homeAbbr: string = homeComp.team?.abbreviation ?? homeComp.abbreviation ?? "";
    const awayAbbr: string = awayComp.team?.abbreviation ?? awayComp.abbreviation ?? "";
    const homeName: string = homeComp.team?.displayName ?? homeComp.displayName ?? "";
    const awayName: string = awayComp.team?.displayName ?? awayComp.displayName ?? "";

    if (!awayTeamId || !homeTeamId) return [];

    // Dynamic season year: August onwards = upcoming season year (e.g. Aug 2025 → 2026)
    const now = new Date();
    const seasonYear = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();

    // Helper: fetch and filter completed H2H events for a given season
    const fetchAndFilterH2H = async (teamId: string, season: number, vsTeamId: string): Promise<any[]> => {
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/schedule?season=${season}`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return [];
      const sched = await res.json() as any;
      return (sched.events ?? []).filter((ev: any) => {
        const comp = ev.competitions?.[0];
        const statusDesc = comp?.status?.type?.description ?? "";
        if (statusDesc !== "Final" && statusDesc !== "Final/OT") return false;
        return comp?.competitors?.some(
          (c: any) => String(c.id ?? c.team?.id ?? "") === vsTeamId
        );
      });
    };

    // Map a raw ESPN event to our H2HGame shape + isCurrent flag
    const mapEvent = (ev: any, isCurrent: boolean) => {
      const comp = ev.competitions?.[0];
      const awayEntry = comp?.competitors?.find(
        (c: any) => String(c.id ?? c.team?.id ?? "") === awayTeamId
      );
      const homeEntry = comp?.competitors?.find(
        (c: any) => String(c.id ?? c.team?.id ?? "") === homeTeamId
      );
      const awayScore = parseInt(awayEntry?.score ?? "0", 10);
      const homeScore = parseInt(homeEntry?.score ?? "0", 10);
      const homeIsHost = homeEntry?.homeAway === "home" && !(comp?.neutralSite ?? false);
      const location = homeIsHost ? `@ ${homeAbbr}` : `vs ${homeAbbr}`;
      const evDate = new Date(ev.date ?? "");
      const dateStr = isNaN(evDate.getTime()) ? "" : evDate.toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
      return {
        date: dateStr,
        awayTeam: awayName, homeTeam: homeName,
        awayAbbr, homeAbbr,
        awayScore, homeScore,
        location,
        total: null as number | null,
        spread: null as number | null,
        spreadTeam: null as "HOME" | "AWAY" | null,
        isCurrent,
        _eventId: String(ev.id ?? ev.uid ?? ""),
        _date: ev.date ?? "",
      };
    }

    // Fetch current season first
    const currentRaw = await fetchAndFilterH2H(awayTeamId, seasonYear, homeTeamId);

    let combined: ReturnType<typeof mapEvent>[];
    if (currentRaw.length >= 2) {
      combined = currentRaw.map(ev => mapEvent(ev, true));
    } else {
      // Extend to prior season when current season has < 2 matchups
      const priorRaw = await fetchAndFilterH2H(awayTeamId, seasonYear - 1, homeTeamId);
      const merged = [
        ...currentRaw.map(ev => mapEvent(ev, true)),
        ...priorRaw.map(ev => mapEvent(ev, false)),
      ];
      // Deduplicate by event ID
      const seen = new Set<string>();
      combined = merged.filter(g => {
        if (seen.has(g._eventId)) return false;
        seen.add(g._eventId);
        return true;
      });
    }

    // Sort descending by date and take top 3
    combined.sort((a, b) => new Date(b._date).getTime() - new Date(a._date).getTime());

    // Strip internal tracking fields before caching
    const h2h = combined.slice(0, 3).map(({ _eventId: _e, _date: _d, ...rest }) => rest);

    cache.set(key, { data: h2h, timestamp: Date.now() });
    return h2h;
  } catch (err: any) {
    console.warn("[NCAAB H2H]", err.message);
    return [];
  }
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

  const tryFetch = async (markets: string): Promise<any[] | null> => {
    const url = `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets}&oddsFormat=american`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.status === 422) {
      const body = await res.text().catch(() => "");
      console.warn(`[NCAAB Odds] 422 for markets=${markets}: ${body}`);
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[NCAAB Odds] ${res.status}: ${body}`);
      return null;
    }
    return res.json() as Promise<any[]>;
  };

  try {
    let data = await tryFetch(NCAAB_BULK_MARKETS);
    if (!data) {
      // team_totals may not be on current plan tier — fallback to safe markets
      console.warn("[NCAAB Odds] Falling back to spreads,totals only");
      data = await tryFetch("spreads,totals");
    }
    if (!data) return cached?.data ?? [];
    // Log which markets came back
    const returned = new Set<string>();
    data.forEach((ev: any) => ev.bookmakers?.forEach((b: any) => b.markets?.forEach((m: any) => returned.add(m.key))));
    console.log(`[NCAAB] Odds API: ${data.length} events, markets: ${[...returned].join(",")}`);
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  } catch (err) {
    console.warn("[NCAAB Odds] error:", err);
    return cached?.data ?? [];
  }
}

// ── Sports Game Odds — NCAAB 1H + 2H lines (spread + total) ─────────────────
interface SGO1HLines {
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;
  h1FavoriteName: string;
  // 2nd half lines (available during halftime window)
  h2TotalLine: number | null;
  h2SpreadLine: number | null;
  h2Favorite: string;
  h2FavoriteName: string;
  // Team total lines (aligned to ESPN home/away, not SGO home/away)
  homeGameTotalLine: number | null;
  awayGameTotalLine: number | null;
  home1HTotalLine: number | null;
  away1HTotalLine: number | null;
}

interface SGOEvent {
  teams: { home: { names: { long: string; medium?: string; short?: string } }; away: { names: { long: string; medium?: string; short?: string } } };
  odds: Record<string, any>;
}

export async function getNCAABSGOLines(): Promise<SGOEvent[]> {
  const key = "ncaab_sgo_lines";
  const cached = cache.get(key);
  if (isFresh(cached, H1_LINES_TTL)) return cached!.data;

  if (!SGO_API_KEY) {
    console.warn("[NCAAB SGO] SGO_API_KEY not set — skipping 1H lines");
    return [];
  }

  try {
    const url = "https://api.sportsgameodds.com/v2/events?leagueID=NCAAB&oddsAvailable=true&limit=100";
    const res = await fetch(url, {
      headers: { "X-Api-Key": SGO_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[NCAAB SGO] ${res.status}: ${body}`);
      return [];
    }
    const data = await res.json() as any;
    const events: SGOEvent[] = data.data ?? [];
    cache.set(key, { data: events, timestamp: Date.now() });
    console.log(`[NCAAB SGO] ${events.length} events fetched`);
    return events;
  } catch (err) {
    console.warn("[NCAAB SGO] error:", err);
    return [];
  }
}

function matchSGOEvent(game: any, sgoEvents: SGOEvent[]): SGOEvent | null {
  for (const ev of sgoEvents) {
    const evHome = ev.teams?.home?.names?.long ?? "";
    const evAway = ev.teams?.away?.names?.long ?? "";
    if (
      (teamsMatch(game.homeTeam, evHome) && teamsMatch(game.awayTeam, evAway)) ||
      (teamsMatch(game.homeTeam, evAway) && teamsMatch(game.awayTeam, evHome))
    ) return ev;
  }
  return null;
}

function extractSGO1HLines(sgoEvent: SGOEvent, game: any): SGO1HLines {
  const odds = sgoEvent.odds ?? {};
  const evHome = sgoEvent.teams?.home?.names?.long ?? "";
  // true if SGO's "home" team maps to the ESPN game's homeTeam
  const homeIsGameHome = teamsMatch(game.homeTeam, evHome);

  // 1H total
  const ouOver = odds["points-all-1h-ou-over"];
  const h1TotalLine: number | null = ouOver?.bookOverUnder != null
    ? parseFloat(ouOver.bookOverUnder)
    : null;

  // 1H spread (negative bookSpread on home side = SGO home is favourite)
  const spHome = odds["points-home-1h-sp-home"];
  const spAway = odds["points-away-1h-sp-away"];

  let h1SpreadLine: number | null = null;
  let h1Favorite = "";
  let h1FavoriteName = "";

  if (spHome?.bookSpread != null) {
    const val = parseFloat(spHome.bookSpread);
    h1SpreadLine = Math.abs(val);
    if (val < 0) {
      h1Favorite = homeIsGameHome ? "home" : "away";
      h1FavoriteName = homeIsGameHome ? game.homeTeam : game.awayTeam;
    } else if (val > 0) {
      h1Favorite = homeIsGameHome ? "away" : "home";
      h1FavoriteName = homeIsGameHome ? game.awayTeam : game.homeTeam;
    } else if (spAway?.bookSpread != null) {
      const aval = parseFloat(spAway.bookSpread);
      if (aval < 0) {
        h1Favorite = homeIsGameHome ? "away" : "home";
        h1FavoriteName = homeIsGameHome ? game.awayTeam : game.homeTeam;
      }
    }
  }

  // 2H total
  const ouOver2H = odds["points-all-2h-ou-over"];
  const h2TotalLine: number | null = ouOver2H?.bookOverUnder != null
    ? parseFloat(ouOver2H.bookOverUnder) : null;

  // 2H spread
  const sp2HHome = odds["points-home-2h-sp-home"];
  const sp2HAway = odds["points-away-2h-sp-away"];
  let h2SpreadLine: number | null = null;
  let h2Favorite = "";
  let h2FavoriteName = "";
  if (sp2HHome?.bookSpread != null) {
    const val = parseFloat(sp2HHome.bookSpread);
    h2SpreadLine = Math.abs(val);
    if (val < 0) {
      h2Favorite = homeIsGameHome ? "home" : "away";
      h2FavoriteName = homeIsGameHome ? game.homeTeam : game.awayTeam;
    } else {
      h2Favorite = homeIsGameHome ? "away" : "home";
      h2FavoriteName = homeIsGameHome ? game.awayTeam : game.homeTeam;
    }
  } else if (sp2HAway?.bookSpread != null) {
    const aval = parseFloat(sp2HAway.bookSpread);
    h2SpreadLine = Math.abs(aval);
    if (aval < 0) {
      h2Favorite = homeIsGameHome ? "away" : "home";
      h2FavoriteName = homeIsGameHome ? game.awayTeam : game.homeTeam;
    }
  }

  // Team totals — aligned to ESPN home/away
  function parseOU(key: string): number | null {
    const v = odds[key]?.bookOverUnder;
    return v != null ? parseFloat(v) : null;
  }
  const sgoHomeFG  = parseOU("points-home-game-ou-over");
  const sgoAwayFG  = parseOU("points-away-game-ou-over");
  const sgoHome1H  = parseOU("points-home-1h-ou-over");
  const sgoAway1H  = parseOU("points-away-1h-ou-over");

  const homeGameTotalLine = homeIsGameHome ? sgoHomeFG : sgoAwayFG;
  const awayGameTotalLine = homeIsGameHome ? sgoAwayFG : sgoHomeFG;
  const home1HTotalLine   = homeIsGameHome ? sgoHome1H : sgoAway1H;
  const away1HTotalLine   = homeIsGameHome ? sgoAway1H : sgoHome1H;

  return { h1TotalLine, h1SpreadLine, h1Favorite, h1FavoriteName, h2TotalLine, h2SpreadLine, h2Favorite, h2FavoriteName, homeGameTotalLine, awayGameTotalLine, home1HTotalLine, away1HTotalLine };
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
function extractLines(oddsEvent: any, homeTeamName?: string): {
  spread: number | null;
  total: number | null;
  favorite: string;
  bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string; h1Total: number | null; h1Spread: number | null; h1Favorite: string }>;
  h1TotalLine: number | null;
  h1SpreadLine: number | null;
  h1Favorite: string;
  h2TotalLine: number | null;
  h2SpreadLine: number | null;
  h2Favorite: string;
  overOddsAmerican: number | null;
  homeTTBookLine: number | null;
  awayTTBookLine: number | null;
} {
  let spread: number | null = null;
  let total: number | null = null;
  let favorite = "";
  let h1TotalLine: number | null = null;
  let h1SpreadLine: number | null = null;
  let h1Favorite = "";
  let h2TotalLine: number | null = null;
  let h2SpreadLine: number | null = null;
  let h2Favorite = "";
  let overOddsAmerican: number | null = null;
  let homeTTBookLine: number | null = null;
  let awayTTBookLine: number | null = null;
  const homeLastWord = homeTeamName ? homeTeamName.toLowerCase().split(" ").pop() ?? "" : "";
  const bookLines: Array<{ book: string; spread: number | null; total: number | null; favorite: string; h1Total: number | null; h1Spread: number | null; h1Favorite: string }> = [];

  for (const bk of (oddsEvent.bookmakers ?? [])) {
    const spreadsMarket   = (bk.markets ?? []).find((m: any) => m.key === "spreads");
    const totalsMarket    = (bk.markets ?? []).find((m: any) => m.key === "totals");
    const h1TotalsMarket  = (bk.markets ?? []).find((m: any) => m.key === "h1_totals");
    const h1SpreadsMarket = (bk.markets ?? []).find((m: any) => m.key === "h1_spreads");
    const h2TotalsMarket  = (bk.markets ?? []).find((m: any) => m.key === "h2_totals");
    const h2SpreadsMarket = (bk.markets ?? []).find((m: any) => m.key === "h2_spreads");

    let bkSpread: number | null = null;
    let bkTotal: number | null = null;
    let bkFav = "";
    let bkH1Total: number | null = null;
    let bkH1Spread: number | null = null;
    let bkH1Fav = "";
    let bkH2Total: number | null = null;
    let bkH2Spread: number | null = null;
    let bkH2Fav = "";

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
      if (over) {
        bkTotal = over.point as number;
        // Extract American odds price for Over (e.g. -110) to compute bookImplied
        if (overOddsAmerican === null && over.price != null) {
          overOddsAmerican = over.price as number;
        }
      }
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
    if (h2TotalsMarket?.outcomes?.length >= 1) {
      const over = h2TotalsMarket.outcomes.find((o: any) => o.name === "Over");
      if (over) bkH2Total = over.point as number;
    }
    if (h2SpreadsMarket?.outcomes?.length >= 2) {
      const favOutcome = h2SpreadsMarket.outcomes.find((o: any) => o.point < 0);
      if (favOutcome) {
        bkH2Spread = Math.abs(favOutcome.point);
        bkH2Fav = favOutcome.name;
      } else {
        const sorted = [...h2SpreadsMarket.outcomes].sort((a: any, b: any) => Math.abs(a.point) - Math.abs(b.point));
        bkH2Spread = Math.abs(sorted[0].point);
        bkH2Fav = sorted[0].name;
      }
    }

    // team_totals market (home/away team scoring totals)
    const ttMarket = (bk.markets ?? []).find((m: any) => m.key === "team_totals");
    if (ttMarket?.outcomes?.length >= 2 && homeLastWord) {
      (ttMarket.outcomes as any[]).forEach((o: any) => {
        const desc = (o.description ?? "").toLowerCase();
        const isHome = homeLastWord && desc.includes(homeLastWord);
        if (o.name === "Over" && o.point) {
          if (isHome && homeTTBookLine === null) homeTTBookLine = o.point as number;
          if (!isHome && awayTTBookLine === null) awayTTBookLine = o.point as number;
        }
      });
    }

    if (bkSpread !== null || bkTotal !== null || bkH1Total !== null || bkH2Total !== null) {
      bookLines.push({ book: bk.key, spread: bkSpread, total: bkTotal, favorite: bkFav, h1Total: bkH1Total, h1Spread: bkH1Spread, h1Favorite: bkH1Fav });
    }
    if (spread === null && bkSpread !== null) { spread = bkSpread; favorite = bkFav; }
    if (total === null && bkTotal !== null) total = bkTotal;
    if (h1TotalLine === null && bkH1Total !== null) h1TotalLine = bkH1Total;
    if (h1SpreadLine === null && bkH1Spread !== null) { h1SpreadLine = bkH1Spread; h1Favorite = bkH1Fav; }
    if (h2TotalLine === null && bkH2Total !== null) h2TotalLine = bkH2Total;
    if (h2SpreadLine === null && bkH2Spread !== null) { h2SpreadLine = bkH2Spread; h2Favorite = bkH2Fav; }
    if (spread !== null && total !== null && h1TotalLine !== null && overOddsAmerican !== null) break;
  }

  if (homeTTBookLine !== null || awayTTBookLine !== null) {
    console.log(`[NCAAB TT Odds API] home=${homeTTBookLine} away=${awayTTBookLine}`);
  }

  return { spread, total, favorite, bookLines, h1TotalLine, h1SpreadLine, h1Favorite, h2TotalLine, h2SpreadLine, h2Favorite, overOddsAmerican, homeTTBookLine, awayTTBookLine };
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
  h2TotalLine: number | null;
  h2SpreadLine: number | null;
  h2Favorite: string;

  // Team total market lines from SGO / ESPN (with estimated flag)
  homeGameTotalLine: number | null;
  awayGameTotalLine: number | null;
  homeGameTotalIsEstimated: boolean;
  awayGameTotalIsEstimated: boolean;
  home1HTotalLine: number | null;
  away1HTotalLine: number | null;

  // ESPN pre-game model data (sharp money signal)
  espnHomeWinPct: number | null;
  espnSpreadDetails: string | null;

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
  over2HProb: number | null;
  effectiveH2Line: number | null;

  // Book odds for implied probability
  overOddsAmerican: number | null;

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

// ── ESPN summary data (team totals + win% + spread) ─────────────────────────
// Unified ESPN summary fetch — replaces tryGetESPNTeamTotals.
// Cached per gameId (5 min TTL) to avoid redundant calls during live refresh cycles.
interface ESPNSummaryData {
  teamTotals: { home: number | null; away: number | null };
  homeWinPct: number | null;
  spreadDetails: string | null;
  overUnder: number | null;
}
async function fetchESPNSummaryData(gameId: string): Promise<ESPNSummaryData> {
  const key = `ncaab_espn_summary_${gameId}`;
  const cached = cache.get(key);
  if (isFresh(cached, 5 * 60 * 1000)) return cached!.data;
  const empty: ESPNSummaryData = { teamTotals: { home: null, away: null }, homeWinPct: null, spreadDetails: null, overUnder: null };
  try {
    const r = await fetch(`${ESPN_NCAAB}/summary?event=${gameId}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { cache.set(key, { data: empty, timestamp: Date.now() }); return empty; }
    const s = await r.json() as any;
    const comp = s.header?.competitions?.[0];
    const homeComp = comp?.competitors?.find((c: any) => c.homeAway === "home");
    const awayComp = comp?.competitors?.find((c: any) => c.homeAway === "away");
    // Team totals — check all 3 known ESPN locations
    const tt = s.teamTotals ?? s.pickcenter?.[0]?.teamTotals ?? comp?.odds?.[0]?.teamTotals;
    const homeId = String(homeComp?.id ?? homeComp?.team?.id ?? "");
    const awayId = String(awayComp?.id ?? awayComp?.team?.id ?? "");
    const homeVal = tt ? (tt[homeId]?.total ?? tt?.home ?? null) : null;
    const awayVal = tt ? (tt[awayId]?.total ?? tt?.away ?? null) : null;
    // Pickcenter data
    const pc = s.pickcenter?.[0];
    const homeWinPct = pc?.homeTeamOdds?.winPercentage ?? null;
    const spreadDetails = typeof pc?.spreadDetails === "string" ? pc.spreadDetails : null;
    const overUnder = pc?.overUnder ?? null;
    const result: ESPNSummaryData = {
      teamTotals: {
        home: homeVal != null ? parseFloat(String(homeVal)) : null,
        away: awayVal != null ? parseFloat(String(awayVal)) : null,
      },
      homeWinPct: homeWinPct != null ? parseFloat(String(homeWinPct)) : null,
      spreadDetails,
      overUnder: overUnder != null ? parseFloat(String(overUnder)) : null,
    };
    cache.set(key, { data: result, timestamp: Date.now() });
    return result;
  } catch {
    cache.set(key, { data: empty, timestamp: Date.now() });
    return empty;
  }
}

// Public API for chip-odds route
export async function getNCAABChipOdds(gameId: string): Promise<{
  overUnder: number | null;
  homeWinPct: number | null;
  spreadDetails: string | null;
}> {
  const data = await fetchESPNSummaryData(gameId);
  return { overUnder: data.overUnder, homeWinPct: data.homeWinPct, spreadDetails: data.spreadDetails };
}

export async function computeNCAABPlays(): Promise<NCAABPlay[]> {
  const [allGames, oddsEvents, sgoEvents] = await Promise.all([
    getNCAABScoreboard(),
    getNCAABOddsLines(),
    getNCAABSGOLines(),
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
      const { spread, total, favorite, bookLines, h1SpreadLine: oddsH1Spread, h1Favorite: oddsH1Fav, h2TotalLine: oddsH2Total, h2SpreadLine: oddsH2Spread, h2Favorite: oddsH2Fav, overOddsAmerican, homeTTBookLine, awayTTBookLine } = oddsEvent
        ? extractLines(oddsEvent, game.homeTeam)
        : { spread: null, total: null, favorite: "", bookLines: [], h1SpreadLine: null, h1Favorite: "", h2TotalLine: null, h2SpreadLine: null, h2Favorite: "", overOddsAmerican: null, homeTTBookLine: null, awayTTBookLine: null };

      // SGO 1H + 2H lines (real book lines)
      const sgoEvent = matchSGOEvent(game, sgoEvents);
      const sgo1H = sgoEvent ? extractSGO1HLines(sgoEvent, game) : null;
      const rawH1TotalLine  = sgo1H?.h1TotalLine ?? null;
      const h1SpreadLine    = sgo1H?.h1SpreadLine ?? oddsH1Spread ?? null;
      const h1Favorite      = sgo1H?.h1FavoriteName ?? oddsH1Fav ?? "";
      const h2TotalLine     = sgo1H?.h2TotalLine ?? oddsH2Total ?? null;
      const h2SpreadLine    = sgo1H?.h2SpreadLine ?? oddsH2Spread ?? null;
      const h2Favorite      = sgo1H?.h2FavoriteName ?? oddsH2Fav ?? "";
      if (h2TotalLine != null) {
        console.log(`[NCAAB 2H] ${game.awayTeam} @ ${game.homeTeam}: 2H total=${h2TotalLine}, spread=${h2SpreadLine} ${h2Favorite}`);
      }
      let finalHomeGameTotalLine: number | null = sgo1H?.homeGameTotalLine ?? null;
      let finalAwayGameTotalLine: number | null = sgo1H?.awayGameTotalLine ?? null;
      const home1HTotalLine   = sgo1H?.home1HTotalLine ?? null;
      const away1HTotalLine   = sgo1H?.away1HTotalLine ?? null;

      // Odds API team_totals market as secondary source
      if (finalHomeGameTotalLine === null && homeTTBookLine !== null) finalHomeGameTotalLine = homeTTBookLine;
      if (finalAwayGameTotalLine === null && awayTTBookLine !== null) finalAwayGameTotalLine = awayTTBookLine;

      // Fetch ESPN summary once per game — provides team totals fallback + win% for sharp signal
      const espnSummary = await fetchESPNSummaryData(game.id);
      if (finalHomeGameTotalLine === null && finalAwayGameTotalLine === null) {
        if (espnSummary.teamTotals.home !== null) finalHomeGameTotalLine = espnSummary.teamTotals.home;
        if (espnSummary.teamTotals.away !== null) finalAwayGameTotalLine = espnSummary.teamTotals.away;
        if (espnSummary.teamTotals.home !== null || espnSummary.teamTotals.away !== null) {
          console.log(`[NCAAB ESPN TT] ${game.awayTeam} @ ${game.homeTeam}: homeTotal=${espnSummary.teamTotals.home}, awayTotal=${espnSummary.teamTotals.away}`);
        }
      }
      const espnHomeWinPct = espnSummary.homeWinPct;
      const espnSpreadDetails = espnSummary.spreadDetails;

      // isEstimated = true only when both SGO and ESPN returned null (line will be derived from proj in frontend)
      const homeGameTotalIsEstimated = finalHomeGameTotalLine === null;
      const awayGameTotalIsEstimated = finalAwayGameTotalLine === null;
      const homeGameTotalLine = finalHomeGameTotalLine;
      const awayGameTotalLine = finalAwayGameTotalLine;

      if (sgo1H?.h1TotalLine != null) {
        console.log(`[NCAAB SGO] ${game.awayTeam} @ ${game.homeTeam}: 1H total=${sgo1H.h1TotalLine}, spread=${sgo1H.h1SpreadLine} ${sgo1H.h1FavoriteName}, homeTeamTotal=${homeGameTotalLine}, awayTeamTotal=${awayGameTotalLine}`);
      }

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

      // At halftime, H1 is complete — current score IS the H1 score
      // During H1/H2, fall back to an estimate
      const h1Home = homeScores[0] ?? (isHalftime ? game.homeScore : Math.round(game.homeScore / (half === 2 ? 2 : 1) * 0.5));
      const h1Away = awayScores[0] ?? (isHalftime ? game.awayScore : Math.round(game.awayScore / (half === 2 ? 2 : 1) * 0.5));
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

        // H1 per-team projection to compute projected margin
        const homeShareH1 = currentTotal > 0
          ? (game.homeScore / currentTotal) * 0.6 + 0.5 * 0.4
          : 0.5;
        const remainingH1Scoring = blendedPace * remainH1Min;
        const proj1HHomeScore = game.homeScore + remainingH1Scoring * homeShareH1;
        const proj1HAwayScore = game.awayScore + remainingH1Scoring * (1 - homeShareH1);
        projectedMargin = Math.round((proj1HHomeScore - proj1HAwayScore) * 10) / 10;

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

      // ENGINE BUG AUDIT
      // Score fields: game.homeScore (number), game.awayScore (number) — derived from ESPN home?.score / away?.score
      // h1Home/h1Away: scoringByPeriod[abbr][0] ?? estimated from current score
      // proj1HTotal: currentTotal + blendedPace * remainH1Min (H1 window only, half === 1)
      // projectedTotal: projected H1 + H2 pace * 20 (full game)
      // Cause A mitigated: h1Home/h1Away fallback uses current score estimate
      // Cause D mitigated: separate proj1HTotal path for H1 vs full game
      // Post-halftime H1 result: over1HProb not set post-H1 — fixed below with 99/1 exception

      // ── Dynamic multiplier probability ───────────────────────────────────
      let volatility: number | null = null;
      let spreadProb: number | null = null;
      let overProb: number | null = null;
      let spreadEdge: number | null = null;
      let totalEdge: number | null = null;
      let over1HProb: number | null = null;
      let total1HEdge: number | null = null;

      // Total NCAAB game = 2 halves × 1200s = 2400s
      // secsRemaining = seconds left in entire game
      const secsRemaining = isHalftime ? 1200 : (half === 2 ? secondsLeft : secondsLeft + 1200);
      const secsElapsed   = Math.max(0, 2400 - secsRemaining);
      const tooEarlyForData = secsElapsed < 60;

      // Retain volatility for backward-compat (spread calc still uses sigmoid)
      const secsForVol = isHalftime ? 1200 : secondsLeft;
      volatility = Math.max(4, 18 * (secsForVol / 2400)) + volatilityBonus;

      if (projectedTotal !== null || projectedMargin !== null) {
        const dynamicMult = getDynamicMultiplier(secsRemaining, 2400, game.period, 2);

        // Effective lines — use API line if available, otherwise fall back to
        // projected total rounded to nearest 0.5 so we always produce a probability
        const effectiveFGLine = total ?? (projectedTotal !== null ? Math.round(projectedTotal * 2) / 2 : null);
        const effective1HLine = h1TotalLine ?? (proj1HTotal !== null ? Math.round(proj1HTotal * 2) / 2 : null);

        if (projectedMargin !== null && spread !== null) {
          if (tooEarlyForData) {
            spreadProb = 50;
          } else {
            const adjustedSpread = teamsMatch(favorite, game.homeTeam) ? -spread : spread;
            // Use sigmoid for spread (margin diff is smaller in scale)
            spreadProb = Math.round(sigmoid((projectedMargin - adjustedSpread) / volatility) * 1000) / 10;
          }
          spreadEdge = Math.round((spreadProb - 50) * 10) / 10;
        }

        if (projectedTotal !== null && effectiveFGLine !== null) {
          if (tooEarlyForData) {
            overProb = 50;
          } else {
            const diff = projectedTotal - effectiveFGLine;
            const raw = 50 + diff * dynamicMult * 0.3;
            overProb = parseFloat(Math.min(Math.max(raw, 1), 99).toFixed(1));
          }
          totalEdge = Math.round((overProb - 50) * 10) / 10;
        }

        // 1H probability — computed during H1 using effective line
        if (half === 1 && proj1HTotal !== null && effective1HLine !== null) {
          if (tooEarlyForData) {
            over1HProb = 50;
          } else {
            const h1MinElapsed = (HALF_SECONDS - secondsLeft) / 60;
            const h1Progress = Math.min(Math.max(h1MinElapsed / 20, 0), 1);
            const h1Mult = getH1Multiplier(h1Progress);
            const diff1H = proj1HTotal - effective1HLine;
            const raw1H = 50 + diff1H * h1Mult * 0.3;
            over1HProb = parseFloat(Math.min(Math.max(raw1H, 1), 99).toFixed(1));
          }
          total1HEdge = Math.round((over1HProb - 50) * 10) / 10;
        }
      }

      // Post-halftime H1: result is settled — show definitive 99/1
      if ((isHalftime || half === 2) && h1TotalLine !== null && h1Total > 0) {
        over1HProb = h1Total > h1TotalLine ? 99 : h1Total < h1TotalLine ? 1 : 50;
        total1HEdge = Math.round((over1HProb - 50) * 10) / 10;
      }

      // ── 2H probability — at halftime or during H2 live play ──────────────
      let over2HProb: number | null = null;
      let effectiveH2Line: number | null = null;
      if (projectedTotal !== null && (isHalftime || half === 2)) {
        // proj2H = the expected second half total
        const proj2H = projectedTotal - h1Total;
        // Use book 2H total if available; otherwise derive from H1 pace × 0.95 × 20 min
        // (same formula as fetch2HLines Source 3) so we compare against an implied market
        // baseline rather than against ourselves (which would always produce ~50%)
        const derivedH2Line = Math.round((paceH1 * 0.95 * 20) * 2) / 2;
        effectiveH2Line = h2TotalLine ?? derivedH2Line;
        const diff2H = proj2H - effectiveH2Line;
        const raw2H = 50 + diff2H * 2.5 * 0.3;
        over2HProb = parseFloat(Math.min(Math.max(raw2H, 1), 99).toFixed(1));
      }

      // Apply sanitizeProb — clamp to 1-99 and enforce early-game neutral
      // (post-halftime H1 99/1 is exempt: allowExtreme = true)
      const postH1Settled = (isHalftime || half === 2) && h1TotalLine !== null && h1Total > 0;
      overProb   = sanitizeProb(overProb,   secsElapsed);
      spreadProb = sanitizeProb(spreadProb, secsElapsed);
      over1HProb = sanitizeProb(over1HProb, secsElapsed, postH1Settled);

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
        h2TotalLine,
        h2SpreadLine,
        h2Favorite,
        over2HProb,
        effectiveH2Line,
        homeGameTotalLine,
        awayGameTotalLine,
        homeGameTotalIsEstimated,
        awayGameTotalIsEstimated,
        home1HTotalLine,
        away1HTotalLine,
        espnHomeWinPct,
        espnSpreadDetails,
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
        overOddsAmerican,
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

// ── 2H live line fetch (3-source waterfall) ───────────────────────────────────
export interface Live2HLines {
  h2Total: number | null;
  h2OverPrice: number | null;
  h2UnderPrice: number | null;
  h2Spread: number | null;
  h2OverPct: number | null;
  h2UnderPct: number | null;
  source: "odds_api" | "action_network" | "derived_h1_pace" | null;
}

export async function fetch2HLines(
  gameId: string,
  homeTeam: string,
  h1HomeScore: number,
  h1AwayScore: number,
  fullLine: number | null,
): Promise<Live2HLines> {
  const result: Live2HLines = { h2Total: null, h2OverPrice: null, h2UnderPrice: null, h2Spread: null, h2OverPct: null, h2UnderPct: null, source: null };

  // Source 1: Odds API per-event 2H markets (only available at halftime)
  if (ODDS_API_KEY) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/basketball_ncaab/events/${gameId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${NCAAB_2H_MARKETS}&oddsFormat=american`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = await res.json() as any;
        for (const bk of (data.bookmakers ?? [])) {
          for (const mkt of (bk.markets ?? [])) {
            if ((mkt.key === "h2_totals" || mkt.key === "2h_totals") && result.h2Total === null) {
              const over  = (mkt.outcomes ?? []).find((o: any) => o.name === "Over");
              const under = (mkt.outcomes ?? []).find((o: any) => o.name === "Under");
              if (over?.point) {
                result.h2Total      = over.point as number;
                result.h2OverPrice  = over.price ?? null;
                result.h2UnderPrice = under?.price ?? null;
                result.source       = "odds_api";
                console.log(`[2H ODDS API] h2Total=${result.h2Total} from ${bk.key}`);
              }
            }
            if ((mkt.key === "h2_spreads" || mkt.key === "2h_spreads") && result.h2Spread === null) {
              const outcomes: any[] = mkt.outcomes ?? [];
              if (outcomes.length >= 2) result.h2Spread = outcomes[0].point ?? null;
            }
          }
          if (result.h2Total !== null) break;
        }
      }
    } catch (err) {
      console.warn("[2H ODDS] fetch error:", (err as any).message);
    }
  }

  // Source 2: ActionNetwork 2H lines (period=2)
  if (!result.h2Total) {
    try {
      const homeWord = homeTeam.toLowerCase().split(" ").pop() ?? "";
      const anRes = await fetch(
        `https://api.actionnetwork.com/web/v1/scoreboard/ncaab?period=2&bookIds=15,30,76,123,69,68`,
        { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.actionnetwork.com" }, signal: AbortSignal.timeout(6000) }
      );
      if (anRes.ok) {
        const anData = await anRes.json() as any;
        const match = (anData.games ?? []).find((g: any) =>
          (g.teams ?? []).some((t: any) => (t.display_name ?? "").toLowerCase().includes(homeWord))
        );
        if (match) {
          const odds = match.odds?.[0];
          if (odds?.total) {
            result.h2Total      = odds.total;
            result.h2OverPrice  = odds.ml_over ?? null;
            result.h2UnderPrice = odds.ml_under ?? null;
            result.h2Spread     = odds.spread ?? null;
            result.h2OverPct    = odds.over_bets_pct ?? null;
            result.h2UnderPct   = odds.under_bets_pct ?? null;
            result.source       = "action_network";
            console.log(`[2H AN] h2Total=${result.h2Total} for ${homeTeam}`);
          }
        }
      }
    } catch (err) {
      console.warn("[2H AN] fetch error:", (err as any).message);
    }
  }

  // Source 3: Derive from H1 pace
  if (!result.h2Total) {
    const h1Total = h1HomeScore + h1AwayScore;
    if (h1Total > 0) {
      const h1PerMin = h1Total / 20;
      const h2Projected = h1PerMin * 0.95 * 20; // slight H2 regression
      result.h2Total = parseFloat((Math.round(h2Projected * 2) / 2).toFixed(1));
      result.source  = "derived_h1_pace";
      console.log(`[2H DERIVED] h1Total=${h1Total} → h2Total=${result.h2Total}`);
    } else if (fullLine) {
      // No H1 score — use fullLine * 0.53 (H2 is slightly faster)
      result.h2Total = parseFloat((Math.round(fullLine * 0.53 * 2) / 2).toFixed(1));
      result.source  = "derived_h1_pace";
    }
  }

  return result;
}

// ── 2H engine probability vs book implied probability ─────────────────────────
export function calc2HEngineProb(
  h2Lines: Live2HLines,
  h1HomeScore: number,
  h1AwayScore: number,
  engineProjTotal: number | null,
): {
  overProb: number;
  underProb: number;
  h2Proj: number | null;
  overEdge: number | null;
  underEdge: number | null;
  bookOverImplied: number | null;
  bookUnderImplied: number | null;
  hasEdge: boolean;
  edgeSide: "OVER" | "UNDER" | null;
  source: string;
} | null {
  if (!h2Lines.h2Total) return null;

  const mlToProb = (ml: number | null): number | null => {
    if (ml == null) return null;
    return parseFloat(
      ml < 0
        ? (Math.abs(ml) / (Math.abs(ml) + 100) * 100).toFixed(1)
        : (100 / (ml + 100) * 100).toFixed(1)
    );
  };

  const h1Total = h1HomeScore + h1AwayScore;
  const h2Proj = engineProjTotal != null ? engineProjTotal - h1Total : null;

  let overProb: number;
  let source: string;

  if (h2Proj !== null) {
    const diff = h2Proj - h2Lines.h2Total;
    const rawProb = 50 + diff * 4.5;
    overProb = parseFloat(Math.min(Math.max(rawProb, 20), 80).toFixed(1));
    source = "composite_2h";
  } else {
    // H1 pace fallback
    const h1PerMin = h1Total > 0 ? h1Total / 20 : 3.2;
    const h2ProjFallback = h1PerMin * 0.95 * 20;
    const diff = h2ProjFallback - h2Lines.h2Total;
    const rawProb = 50 + diff * 4.0;
    overProb = parseFloat(Math.min(Math.max(rawProb, 25), 75).toFixed(1));
    source = "h1_pace_model";
  }

  const underProb = parseFloat((100 - overProb).toFixed(1));
  const bookOverImplied  = mlToProb(h2Lines.h2OverPrice);
  const bookUnderImplied = mlToProb(h2Lines.h2UnderPrice);
  const overEdge  = bookOverImplied  != null ? parseFloat((overProb  - bookOverImplied).toFixed(1))  : null;
  const underEdge = bookUnderImplied != null ? parseFloat((underProb - bookUnderImplied).toFixed(1)) : null;
  const hasEdge   = (overEdge ?? 0) >= 5 || (underEdge ?? 0) >= 5;
  const edgeSide  = (overEdge ?? 0) >= 5 ? "OVER" : (underEdge ?? 0) >= 5 ? "UNDER" : null;

  return { overProb, underProb, h2Proj: h2Proj !== null ? parseFloat(h2Proj.toFixed(1)) : null, overEdge, underEdge, bookOverImplied, bookUnderImplied, hasEdge, edgeSide, source };
}
