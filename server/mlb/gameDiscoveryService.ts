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

// ── Abbreviation normalization ─────────────────────────────────────────────────
// Normalize ESPN abbreviations to their MLB Stats API equivalents before lookup.
// Verified by calling both ESPN scoreboard + statsapi.mlb.com/api/v1/teams/{id} for each.
const ESPN_TO_MLB_ABBR: Record<string, string> = {
  CHW: "CWS",  // White Sox: ESPN=CHW, Stats API=CWS  (confirmed 2026-03-26)
  ARI: "AZ",   // Diamondbacks: ESPN=ARI, Stats API=AZ (confirmed 2026-03-26)
  // SF, WSH, TB: Stats API uses same abbreviation as ESPN — no mapping needed
};

function normalizeAbbr(abbr: string): string {
  return ESPN_TO_MLB_ABBR[abbr] ?? abbr;
}

// ── Fetch MLB Stats gamePk map for today ──────────────────────────────────────
// Returns a map keyed by "awayAbbr|homeAbbr" (normalized) → MlbScheduleEntry[]
// Array value supports doubleheaders (same teams, same day, different times)
interface MlbScheduleEntry {
  gamePk: string;
  gameTime: string;   // ISO datetime
  gameNumber: number; // 1 or 2 for doubleheaders
  awayName: string;   // team name for fallback matching
  homeName: string;
}

async function fetchMlbGamePkMap(dateStr: string): Promise<Map<string, MlbScheduleEntry[]>> {
  const pkMap = new Map<string, MlbScheduleEntry[]>();
  try {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=team`;
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
        const awayName: string = game.teams?.away?.team?.name ?? "";
        const homeName: string = game.teams?.home?.team?.name ?? "";
        const gamePk: string = String(game.gamePk ?? "");
        const gameTime: string = game.gameDate ?? "";
        const gameNumber: number = game.gameNumber ?? 1;
        if (awayAbbr && homeAbbr && gamePk && gamePk !== "0") {
          const key = `${awayAbbr}|${homeAbbr}`;
          const existing = pkMap.get(key) ?? [];
          existing.push({ gamePk, gameTime, gameNumber, awayName, homeName });
          pkMap.set(key, existing);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[MLB DISCOVERY] fetchMlbGamePkMap error: ${err.message}`);
  }
  return pkMap;
}

// ── gamePk resolution with multi-layer fallback ────────────────────────────────
// Layer 1: Exact key (normalized abbreviations)
// Layer 2: All entries — match by team name substring
// Layer 3: All entries — closest start time within ±2 hours
function resolveGamePk(
  awayAbbrRaw: string,
  homeAbbrRaw: string,
  awayTeamName: string,
  homeTeamName: string,
  espnTime: number,
  pkMap: Map<string, MlbScheduleEntry[]>,
  espnId: string,
): string | undefined {
  const awayAbbr = normalizeAbbr(awayAbbrRaw);
  const homeAbbr = normalizeAbbr(homeAbbrRaw);

  // Layer 1: normalized exact key
  const exact = pkMap.get(`${awayAbbr}|${homeAbbr}`) ?? [];
  if (exact.length === 1) return exact[0].gamePk;
  if (exact.length > 1) {
    // Doubleheader: pick closest start time
    if (espnTime > 0) {
      const best = exact.reduce((a, b) =>
        Math.abs(new Date(a.gameTime).getTime() - espnTime) <=
        Math.abs(new Date(b.gameTime).getTime() - espnTime) ? a : b
      );
      console.log(`[MLB DISCOVERY] Doubleheader resolution for ${awayAbbr}|${homeAbbr} (espnId=${espnId}): picked gamePk=${best.gamePk} (${exact.length} candidates)`);
      return best.gamePk;
    }
    return exact[0].gamePk;
  }

  // Layer 2: team name substring match across ALL pkMap entries
  const awayLower = awayTeamName.toLowerCase();
  const homeLower = homeTeamName.toLowerCase();
  const nameMatches: MlbScheduleEntry[] = [];
  for (const entries of pkMap.values()) {
    for (const e of entries) {
      const eAway = e.awayName.toLowerCase();
      const eHome = e.homeName.toLowerCase();
      const awayMatch = awayLower && (eAway.includes(awayLower) || awayLower.includes(eAway));
      const homeMatch = homeLower && (eHome.includes(homeLower) || homeLower.includes(eHome));
      if (awayMatch && homeMatch) nameMatches.push(e);
    }
  }
  if (nameMatches.length === 1) {
    console.log(`[MLB DISCOVERY] Name-fallback match for ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${espnId}): gamePk=${nameMatches[0].gamePk} via team names`);
    return nameMatches[0].gamePk;
  }
  if (nameMatches.length > 1 && espnTime > 0) {
    const best = nameMatches.reduce((a, b) =>
      Math.abs(new Date(a.gameTime).getTime() - espnTime) <=
      Math.abs(new Date(b.gameTime).getTime() - espnTime) ? a : b
    );
    console.log(`[MLB DISCOVERY] Name-fallback multi-match for ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${espnId}): picked gamePk=${best.gamePk}`);
    return best.gamePk;
  }

  // Layer 3: time-proximity across ALL pkMap entries (±2 hours)
  if (espnTime > 0) {
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const timeMatches: MlbScheduleEntry[] = [];
    for (const entries of pkMap.values()) {
      for (const e of entries) {
        const diff = Math.abs(new Date(e.gameTime).getTime() - espnTime);
        if (diff <= TWO_HOURS) timeMatches.push(e);
      }
    }
    if (timeMatches.length === 1) {
      console.log(`[MLB DISCOVERY] Time-proximity fallback for ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${espnId}): gamePk=${timeMatches[0].gamePk}`);
      return timeMatches[0].gamePk;
    }
  }

  console.warn(`[MLB MAPPING FAILED] ${awayAbbrRaw} ${homeAbbrRaw} espnId=${espnId} — all fallback layers exhausted`);
  return undefined;
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

      const awayAbbrRaw: string = awayCompetitor?.team?.abbreviation ?? "";
      const homeAbbrRaw: string = homeCompetitor?.team?.abbreviation ?? "";
      const espnTime = event.date ? new Date(event.date).getTime() : 0;

      const gamePk = resolveGamePk(
        awayAbbrRaw,
        homeAbbrRaw,
        awayTeam,
        homeTeam,
        espnTime,
        pkMap,
        event.id,
      );

      if (gamePk) {
        console.log(`[MLB DISCOVERY] Mapped ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${event.id}) → gamePk=${gamePk}`);
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
    const mappedCount = games.filter((g) => !!g.gamePk).length;
    console.log(`[MLB DISCOVERY] rawEvents=${rawEvents} builtGames=${builtGames} mapped=${mappedCount} unmapped=${builtGames - mappedCount}`);
    if (builtGames === 0) {
      console.warn(`[MLB DISCOVERY] WARNING: builtGames=0 for date=${espnDateStr} — no games returned from ESPN scoreboard`);
    }

    return games;
  } catch (err: any) {
    console.error("[MLB DISCOVERY] discoverTodaysGames error:", err.message);
    return [];
  }
}
