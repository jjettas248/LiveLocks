// ── MLB Game Discovery Service ────────────────────────────────────────────────
// Discovers today's MLB games from the ESPN scoreboard endpoint.
// Includes ALL games regardless of status (pregame + live).
// Maps ESPN event IDs to MLB Stats API gamePk for downstream data pulls.

import { slateDateET } from "../utils/dateUtils";

export interface MLBGame {
  gameId: string;
  gamePk?: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  homePitcher?: string;
  awayPitcher?: string;
  espnStatus?: string;
}

function getESTSlateDate(): Date {
  // Delegates to the shared slate-day cutoff (6am ET) so game discovery and
  // the Pre-Game Power Radar's sessionDate stamping never disagree.
  const [y, m, d] = slateDateET().split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayDateStrEspn(): string {
  const d = getESTSlateDate();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function todayDateStrMlb(): string {
  const d = getESTSlateDate();
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
  awayProbablePitcher?: string;
  homeProbablePitcher?: string;
}

function yesterdayDateStrMlb(): string {
  const d = new Date(Date.now() - 86_400_000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function fetchMlbGamePkMap(dateStr: string): Promise<Map<string, MlbScheduleEntry[]>> {
  const pkMap = new Map<string, MlbScheduleEntry[]>();

  function ingestSchedule(data: any): void {
    for (const date of data.dates ?? []) {
      for (const game of date.games ?? []) {
        const awayAbbr: string = game.teams?.away?.team?.abbreviation ?? "";
        const homeAbbr: string = game.teams?.home?.team?.abbreviation ?? "";
        const awayName: string = game.teams?.away?.team?.name ?? "";
        const homeName: string = game.teams?.home?.team?.name ?? "";
        const gamePk: string = String(game.gamePk ?? "");
        const gameTime: string = game.gameDate ?? "";
        const gameNumber: number = game.gameNumber ?? 1;
        const awayProbablePitcher: string | undefined = game.teams?.away?.probablePitcher?.fullName ?? undefined;
        const homeProbablePitcher: string | undefined = game.teams?.home?.probablePitcher?.fullName ?? undefined;
        if (awayAbbr && homeAbbr && gamePk && gamePk !== "0") {
          const key = `${awayAbbr}|${homeAbbr}`;
          const existing = pkMap.get(key) ?? [];
          if (!existing.some(e => e.gamePk === gamePk)) {
            existing.push({ gamePk, gameTime, gameNumber, awayName, homeName, awayProbablePitcher, homeProbablePitcher });
            pkMap.set(key, existing);
          }
        }
      }
    }
  }

  try {
    const yesterdayStr = yesterdayDateStrMlb();
    const [todayRes, yesterdayRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=team,probablePitcher`, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      }),
      fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${yesterdayStr}&hydrate=team,probablePitcher`, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null),
    ]);

    if (!todayRes.ok) {
      console.warn(`[MLB DISCOVERY] MLB Stats schedule HTTP ${todayRes.status} — gamePk mapping unavailable`);
    } else {
      ingestSchedule(await todayRes.json());
    }

    if (yesterdayRes?.ok) {
      ingestSchedule(await yesterdayRes.json());
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
interface GamePkResult {
  gamePk: string;
  awayProbablePitcher?: string;
  homeProbablePitcher?: string;
}

function resolveGamePkFull(
  awayAbbrRaw: string,
  homeAbbrRaw: string,
  awayTeamName: string,
  homeTeamName: string,
  espnTime: number,
  pkMap: Map<string, MlbScheduleEntry[]>,
  espnId: string,
): GamePkResult | undefined {
  const awayAbbr = normalizeAbbr(awayAbbrRaw);
  const homeAbbr = normalizeAbbr(homeAbbrRaw);

  function entryToResult(entry: MlbScheduleEntry): GamePkResult {
    return { gamePk: entry.gamePk, awayProbablePitcher: entry.awayProbablePitcher, homeProbablePitcher: entry.homeProbablePitcher };
  }

  // Layer 1: normalized exact key
  const exact = pkMap.get(`${awayAbbr}|${homeAbbr}`) ?? [];
  if (exact.length === 1) return entryToResult(exact[0]);
  if (exact.length > 1) {
    if (espnTime > 0) {
      const best = exact.reduce((a, b) =>
        Math.abs(new Date(a.gameTime).getTime() - espnTime) <=
        Math.abs(new Date(b.gameTime).getTime() - espnTime) ? a : b
      );
      console.log(`[MLB DISCOVERY] Doubleheader resolution for ${awayAbbr}|${homeAbbr} (espnId=${espnId}): picked gamePk=${best.gamePk} (${exact.length} candidates)`);
      return entryToResult(best);
    }
    return entryToResult(exact[0]);
  }

  // Layer 2: team name substring match across ALL pkMap entries
  const awayLower = awayTeamName.toLowerCase();
  const homeLower = homeTeamName.toLowerCase();
  const nameMatches: MlbScheduleEntry[] = [];
  for (const entries of Array.from(pkMap.values())) {
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
    return entryToResult(nameMatches[0]);
  }
  if (nameMatches.length > 1 && espnTime > 0) {
    const best = nameMatches.reduce((a, b) =>
      Math.abs(new Date(a.gameTime).getTime() - espnTime) <=
      Math.abs(new Date(b.gameTime).getTime() - espnTime) ? a : b
    );
    console.log(`[MLB DISCOVERY] Name-fallback multi-match for ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${espnId}): picked gamePk=${best.gamePk}`);
    return entryToResult(best);
  }

  // Layer 3: time-proximity across ALL pkMap entries (±2 hours)
  if (espnTime > 0) {
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const timeMatches: MlbScheduleEntry[] = [];
    for (const entries of Array.from(pkMap.values())) {
      for (const e of entries) {
        const diff = Math.abs(new Date(e.gameTime).getTime() - espnTime);
        if (diff <= TWO_HOURS) timeMatches.push(e);
      }
    }
    if (timeMatches.length === 1) {
      console.log(`[MLB DISCOVERY] Time-proximity fallback for ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${espnId}): gamePk=${timeMatches[0].gamePk}`);
      return entryToResult(timeMatches[0]);
    }
  }

  console.warn(`[MLB MAPPING FAILED] ${awayAbbrRaw} ${homeAbbrRaw} espnId=${espnId} — all fallback layers exhausted`);
  return undefined;
}

export async function discoverTodaysGames(): Promise<MLBGame[]> {
  const espnDateStr = todayDateStrEspn();
  const mlbDateStr = todayDateStrMlb();
  const espnTodayUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${espnDateStr}`;
  const espnActiveUrl = `https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard`;

  try {
    const [espnRes, activeRes, pkMap] = await Promise.all([
      fetch(espnTodayUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      }),
      fetch(espnActiveUrl, {
        headers: { "User-Agent": "LiveLocks/1.0" },
        signal: AbortSignal.timeout(8000),
      }).catch(() => null),
      fetchMlbGamePkMap(mlbDateStr),
    ]);

    if (!espnRes.ok) {
      // Do NOT return [] here — see the catch block below for why: an empty
      // array is indistinguishable from a real off-day and silently wipes
      // downstream state (pollGames' registry, Pregame/Mound Radar's
      // in-memory board). Throw so callers' own try/catch can log it and
      // leave their state untouched, exactly like the network-exception path.
      throw new Error(`[MLB DISCOVERY] HTTP ${espnRes.status} from ESPN scoreboard API`);
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

    const activeData = activeRes?.ok ? ((await activeRes.json()) as any) : { events: [] };

    const eventMap = new Map<string, any>();
    for (const event of data.events ?? []) {
      eventMap.set(String(event.id), event);
    }
    // Active-feed merge: only include events that are GENUINELY in-progress.
    // ESPN's no-date active feed also returns recently-completed games for
    // hours after they end, which would otherwise leak yesterday's finals
    // into today's slate (the duplicate-matchup display bug).
    let activeMergedIn = 0;
    let activeStatusOverrides = 0;
    let activeRejectedNonLive = 0;
    for (const event of activeData.events ?? []) {
      const eid = String(event.id);
      const activeStatusName: string =
        (event as any).competitions?.[0]?.status?.type?.name ??
        (event as any).status?.type?.name ??
        "";
      const isActiveLive = activeStatusName === "STATUS_IN_PROGRESS" || activeStatusName === "STATUS_DELAYED";
      if (!eventMap.has(eid)) {
        if (isActiveLive) {
          eventMap.set(eid, event);
          activeMergedIn++;
          console.log(`[MLB DISCOVERY] Active-feed live game ${eid} not in today's date feed — merged in (status=${activeStatusName})`);
        } else {
          activeRejectedNonLive++;
          // Don't pollute today's slate with completed games from other dates.
        }
      } else {
        const existing = eventMap.get(eid)!;
        const activeStatus = (event as any).competitions?.[0]?.status ?? (event as any).status;
        if (activeStatus) {
          if (existing.competitions?.[0]) existing.competitions[0].status = activeStatus;
          activeStatusOverrides++;
        }
      }
    }
    const mergedEvents = Array.from(eventMap.values());

    const rawEvents = mergedEvents.length;
    console.log(`[MLB DISCOVERY] rawEvents=${rawEvents} (today=${data.events?.length ?? 0} active=${activeData.events?.length ?? 0} mergedInLive=${activeMergedIn} statusOverrides=${activeStatusOverrides} rejectedNonLive=${activeRejectedNonLive})`);
    const games: MLBGame[] = [];

    for (const event of mergedEvents) {
      const competition = event.competitions?.[0];
      if (!competition) continue;

      const homeCompetitor = competition.competitors?.find((c: any) => c.homeAway === "home");
      const awayCompetitor = competition.competitors?.find((c: any) => c.homeAway === "away");

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

      const pkResult = resolveGamePkFull(
        awayAbbrRaw,
        homeAbbrRaw,
        awayTeam,
        homeTeam,
        espnTime,
        pkMap,
        event.id,
      );

      const gamePk = pkResult?.gamePk;
      if (gamePk) {
        console.log(`[MLB DISCOVERY] Mapped ${awayAbbrRaw}|${homeAbbrRaw} (espnId=${event.id}) → gamePk=${gamePk}`);
      }

      const resolvedHomePitcher = homePitcher || pkResult?.homeProbablePitcher || undefined;
      const resolvedAwayPitcher = awayPitcher || pkResult?.awayProbablePitcher || undefined;
      if (!homePitcher && pkResult?.homeProbablePitcher) {
        console.log(`[MLB DISCOVERY] Pitcher fallback from Stats API: home=${pkResult.homeProbablePitcher} for ${event.id}`);
      }
      if (!awayPitcher && pkResult?.awayProbablePitcher) {
        console.log(`[MLB DISCOVERY] Pitcher fallback from Stats API: away=${pkResult.awayProbablePitcher} for ${event.id}`);
      }

      const espnStatusName: string = event.status?.type?.name
        ?? competition.status?.type?.name
        ?? "";

      games.push({
        gameId: event.id,
        gamePk,
        homeTeam,
        awayTeam,
        startTime: event.date ?? "",
        homePitcher: resolvedHomePitcher,
        awayPitcher: resolvedAwayPitcher,
        espnStatus: espnStatusName,
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
    // CRITICAL: do NOT return [] here. An empty array is indistinguishable
    // from a real off-day, and the orchestrator's pollGames() loop interprets
    // an empty discovery as "no games today → prune every registered game".
    // That wipe is what causes the daily HR Radar stall: ESPN's scoreboard API
    // intermittently times out a few hours into the slate, the catch silently
    // returned [], every active game got evicted from the registry, and the
    // 10-second state poll had nothing to iterate until the next 5-min
    // discovery cycle re-registered everything from scratch (often losing
    // gameState/contact/odds caches mid-game). Re-throw so pollGames'
    // try/catch can log it and leave the registry untouched.
    console.error("[MLB DISCOVERY] discoverTodaysGames error:", err.message);
    throw err;
  }
}
