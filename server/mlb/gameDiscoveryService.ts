// ── MLB Game Discovery Service ────────────────────────────────────────────────
// Discovers today's MLB games from the ESPN scoreboard endpoint.
// Includes ALL games regardless of status (pregame + live).
// Maps ESPN event IDs to MLB Stats API gamePk for downstream data pulls.

export interface MLBGame {
  gameId: string;
  gamePk?: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  homePitcher?: string;
  awayPitcher?: string;
}

function todayDateStrEspn(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function todayDateStrMlb(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveTeamName(team: {
  displayName?: string;
  shortDisplayName?: string;
  name?: string;
  abbreviation?: string;
} | undefined): string {
  if (!team) return "";
  return (
    (team.displayName?.trim() || "") ||
    (team.shortDisplayName?.trim() || "") ||
    (team.name?.trim() || "") ||
    ""
  );
}

// ── Fetch MLB Stats gamePk map for today ──────────────────────────────────────
// Returns a map keyed by "awayAbbr|homeAbbr" → MlbScheduleEntry[]
// Array value supports doubleheaders (same teams, same day, different times)
// MLB Stats schedule game entry with start time and doubleheader number for disambiguation
interface MlbScheduleEntry {
  gamePk: string;
  gameTime: string; // ISO datetime
  gameNumber: number; // 1 or 2 for doubleheaders
}

async function fetchMlbGamePkMap(dateStr: string): Promise<Map<string, MlbScheduleEntry[]>> {
  const pkMap = new Map<string, MlbScheduleEntry[]>();
  try {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[MLB DISCOVERY] MLB Stats schedule HTTP ${res.status} — gamePk mapping unavailable`);
      return pkMap;
    }
    const data = (await res.json()) as any;
    for (const date of data.dates ?? []) {
      for (const game of date.games ?? []) {
        const awayAbbr: string = game.teams?.away?.team?.abbreviation ?? "";
        const homeAbbr: string = game.teams?.home?.team?.abbreviation ?? "";
        const gamePk: string = String(game.gamePk ?? "");
        const gameTime: string = game.gameDate ?? "";
        const gameNumber: number = game.gameNumber ?? 1;
        if (awayAbbr && homeAbbr && gamePk && gamePk !== "0") {
          const key = `${awayAbbr}|${homeAbbr}`;
          const existing = pkMap.get(key) ?? [];
          existing.push({ gamePk, gameTime, gameNumber });
          pkMap.set(key, existing);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[MLB DISCOVERY] fetchMlbGamePkMap error: ${err.message}`);
  }
  return pkMap;
}

export async function discoverTodaysGames(): Promise<MLBGame[]> {
  const espnDateStr = todayDateStrEspn();
  const mlbDateStr = todayDateStrMlb();
  const url = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${espnDateStr}`;

  try {
    const [espnRes, pkMap] = await Promise.all([
      fetch(url, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      }),
      fetchMlbGamePkMap(mlbDateStr),
    ]);

    if (!espnRes.ok) {
      console.error(`[MLB DISCOVERY] HTTP ${espnRes.status} from ESPN scoreboard API`);
      return [];
    }

    const data = (await espnRes.json()) as {
      events?: Array<{
        id: string;
        date?: string;
        competitions?: Array<{
          competitors?: Array<{
            homeAway: "home" | "away";
            team: {
              displayName?: string;
              shortDisplayName?: string;
              name?: string;
              abbreviation?: string;
            };
          }>;
          situation?: {
            probable?: {
              home?: { athlete?: { fullName?: string } };
              away?: { athlete?: { fullName?: string } };
            };
          };
        }>;
      }>;
    };

    const rawEvents = data.events?.length ?? 0;
    const games: MLBGame[] = [];

    for (const event of data.events ?? []) {
      const competition = event.competitions?.[0];
      if (!competition) continue;

      const homeCompetitor = competition.competitors?.find((c) => c.homeAway === "home");
      const awayCompetitor = competition.competitors?.find((c) => c.homeAway === "away");

      const homeTeam = resolveTeamName(homeCompetitor?.team);
      const awayTeam = resolveTeamName(awayCompetitor?.team);

      if (!homeTeam && !awayTeam) {
        console.warn(`[MLB DISCOVERY] Dropping event ${event.id} — both home and away team names empty after fallback`);
        continue;
      }

      const homePitcher =
        competition.situation?.probable?.home?.athlete?.fullName ?? undefined;
      const awayPitcher =
        competition.situation?.probable?.away?.athlete?.fullName ?? undefined;

      // Map ESPN event ID to MLB Stats gamePk via team abbreviation key
      // Doubleheader-safe: if multiple entries for same matchup, pick closest start time
      const awayAbbr: string = awayCompetitor?.team?.abbreviation ?? "";
      const homeAbbr: string = homeCompetitor?.team?.abbreviation ?? "";
      const candidates = pkMap.get(`${awayAbbr}|${homeAbbr}`) ?? [];
      let gamePk: string | undefined;
      if (candidates.length === 1) {
        gamePk = candidates[0].gamePk;
      } else if (candidates.length > 1) {
        // For doubleheaders: pick the candidate whose start time is closest to ESPN event start time
        const espnTime = event.date ? new Date(event.date).getTime() : 0;
        if (espnTime > 0) {
          const best = candidates.reduce((a, b) => {
            const aDiff = Math.abs(new Date(a.gameTime).getTime() - espnTime);
            const bDiff = Math.abs(new Date(b.gameTime).getTime() - espnTime);
            return aDiff <= bDiff ? a : b;
          });
          gamePk = best.gamePk;
          console.log(`[MLB DISCOVERY] Doubleheader resolution for ${awayAbbr}|${homeAbbr} (espnId=${event.id}): picked gamePk=${gamePk} (${candidates.length} candidates)`);
        } else {
          gamePk = candidates[0].gamePk;
        }
      }
      if (!gamePk) {
        console.warn(`[MLB DISCOVERY] No gamePk found for ${awayAbbr}|${homeAbbr} (espnId=${event.id}) — Stats API calls will use ESPN ID as fallback`);
      }

      games.push({
        gameId: event.id,
        gamePk,
        homeTeam,
        awayTeam,
        startTime: event.date ?? "",
        homePitcher,
        awayPitcher,
      });
    }

    const builtGames = games.length;
    console.log(`[MLB DISCOVERY] rawEvents=${rawEvents} builtGames=${builtGames}`);
    if (builtGames === 0) {
      console.warn(`[MLB DISCOVERY] WARNING: builtGames=0 for date=${espnDateStr} — no games returned from ESPN scoreboard`);
    }

    return games;
  } catch (err: any) {
    console.error("[MLB DISCOVERY] discoverTodaysGames error:", err.message);
    return [];
  }
}
