// ── MLB Roster Service ─────────────────────────────────────────────────────────
// In-memory roster store. Phase A: manual sync via POST /api/mlb/sync-rosters.
// Phase B: automated background sync.

const MLB_SEASON = 2026;

// ── Types ────────────────────────────────────────────────────────────────────

export interface MLBPlayer {
  playerId: string;
  playerName: string;
  team: string;
  position: string;
  bats: "L" | "R" | "S";
  throws: "L" | "R";
  isActive: boolean;
  savantId?: string;
}

export interface MLBStartingLineup {
  gameId: string;
  team: string;
  battingOrderSlot: number;
  playerId: string;
  position: string;
}

export interface MLBPitcher {
  pitcherId: string;
  pitcherName: string;
  team: string;
  throws: "L" | "R";
  pitchCount: number;
  starterOrReliever: "starter" | "reliever";
  bullpenRole?: string;
}

// ── In-memory stores ──────────────────────────────────────────────────────────

let playerPool: MLBPlayer[] = [];
let teamRosters: Record<string, MLBPlayer[]> = {};
let startingLineups: Record<string, MLBStartingLineup[]> = {};
let startingPitchers: Record<string, MLBPitcher> = {};

// ── Read functions ────────────────────────────────────────────────────────────

export function getPlayer(playerId: string): MLBPlayer | undefined {
  return playerPool.find((p) => p.playerId === playerId);
}

export function getPlayerByName(playerName: string): MLBPlayer | undefined {
  const normalized = playerName.toLowerCase().trim();
  return playerPool.find((p) => p.playerName.toLowerCase().trim() === normalized);
}

export function getTeamRoster(team: string): MLBPlayer[] {
  return teamRosters[team.toUpperCase()] ?? [];
}

export function getStartingLineup(gameId: string): MLBStartingLineup[] {
  return startingLineups[gameId] ?? [];
}

export function getStartingPitcher(gameId: string): MLBPitcher | undefined {
  return startingPitchers[gameId];
}

export function getPlayerPoolCount(): number {
  return playerPool.length;
}

export function getTeamCount(): number {
  return Object.keys(teamRosters).length;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapBatSide(code: string | undefined): "L" | "R" | "S" {
  if (code === "L") return "L";
  if (code === "S") return "S";
  return "R";
}

function mapPitchHand(code: string | undefined): "L" | "R" {
  if (code === "L") return "L";
  return "R";
}

// ── Sync: Player Pool ─────────────────────────────────────────────────────────

export async function updatePlayerPool(): Promise<void> {
  const url = `https://statsapi.mlb.com/api/v1/sports/1/players?season=${MLB_SEASON}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[MLB roster] updatePlayerPool HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { people?: any[] };
    const people = data.people ?? [];

    playerPool = people.map((person: any): MLBPlayer => ({
      playerId: String(person.id),
      playerName: person.fullName ?? "",
      team: person.currentTeam?.abbreviation ?? "",
      position: person.primaryPosition?.abbreviation ?? "",
      bats: mapBatSide(person.batSide?.code),
      throws: mapPitchHand(person.pitchHand?.code),
      isActive: person.active ?? true,
    }));

    console.log(`[MLB roster] updatePlayerPool: loaded ${playerPool.length} players for season ${MLB_SEASON}`);
  } catch (err: any) {
    console.error("[MLB roster] updatePlayerPool error:", err.message);
  }
}

// ── Sync: Team Rosters ────────────────────────────────────────────────────────

export async function updateTeamRosters(): Promise<void> {
  // MLB Stats API rejects multi-value leagueId in current schema (HTTP 400
   // "Invalid Request with value: 103,104"). Use sportId+season which returns
   // all 30 active MLB clubs in one call.
  const teamsUrl = `https://statsapi.mlb.com/api/v1/teams?sportId=1&season=${MLB_SEASON}`;
  let teams: Array<{ id: number; abbreviation: string }> = [];

  try {
    const res = await fetch(teamsUrl, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[MLB roster] updateTeamRosters teams fetch HTTP ${res.status}`);
      return;
    }
    const data = (await res.json()) as { teams?: any[] };
    teams = (data.teams ?? []).map((t: any) => ({ id: t.id, abbreviation: t.abbreviation ?? "" }));
  } catch (err: any) {
    console.error("[MLB roster] updateTeamRosters teams fetch error:", err.message);
    return;
  }

  // Build a player ID → player map for O(1) lookup
  const playerById = new Map<string, MLBPlayer>(playerPool.map((p) => [p.playerId, p]));

  // Batch in groups of 5 to avoid hammering the API
  const BATCH_SIZE = 5;
  const newTeamRosters: Record<string, MLBPlayer[]> = {};

  for (let i = 0; i < teams.length; i += BATCH_SIZE) {
    const batch = teams.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (team) => {
        const rosterUrl = `https://statsapi.mlb.com/api/v1/teams/${team.id}/roster?season=${MLB_SEASON}`;
        const res = await fetch(rosterUrl, {
          headers: { "User-Agent": "LiveLocks/1.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { roster?: any[] };
        const roster = data.roster ?? [];
        const members: MLBPlayer[] = roster
          .map((entry: any) => playerById.get(String(entry.person?.id)))
          .filter((p): p is MLBPlayer => p !== undefined);
        return { abbrev: team.abbreviation.toUpperCase(), members };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        newTeamRosters[result.value.abbrev] = result.value.members;
      } else {
        console.warn("[MLB roster] updateTeamRosters batch error:", result.reason?.message);
      }
    }
  }

  teamRosters = newTeamRosters;

  // Active pool filter: keep only players on at least one current roster
  const activeIds = new Set<string>();
  for (const members of Object.values(teamRosters)) {
    for (const p of members) activeIds.add(p.playerId);
  }
  playerPool = playerPool.filter((p) => activeIds.has(p.playerId));

  console.log(
    `[MLB roster] updateTeamRosters: ${Object.keys(teamRosters).length} teams, ${playerPool.length} active players`
  );
}

// ── Sync: Starting Lineups ────────────────────────────────────────────────────

export async function updateStartingLineups(gameId: string): Promise<void> {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[MLB roster] updateStartingLineups HTTP ${res.status} for game ${gameId}`);
      return;
    }
    const data = (await res.json()) as any;
    const boxTeams = data.liveData?.boxscore?.teams ?? {};
    const lineups: MLBStartingLineup[] = [];

    for (const side of ["home", "away"] as const) {
      const team = boxTeams[side];
      if (!team) continue;
      const abbrev: string = data.gameData?.teams?.[side]?.abbreviation ?? side;
      const battingOrder: number[] = team.battingOrder ?? [];
      battingOrder.forEach((playerId: number, index: number) => {
        const playerInfo = team.players?.[`ID${playerId}`];
        lineups.push({
          gameId,
          team: abbrev,
          battingOrderSlot: index + 1,
          playerId: String(playerId),
          position: playerInfo?.position?.abbreviation ?? "",
        });
      });
    }

    startingLineups[gameId] = lineups;
    console.log(`[MLB roster] updateStartingLineups: ${lineups.length} entries for game ${gameId}`);
  } catch (err: any) {
    console.error("[MLB roster] updateStartingLineups error:", err.message);
  }
}

// ── Sync: Starting Pitchers ───────────────────────────────────────────────────

export async function updateStartingPitchers(gameId: string): Promise<void> {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[MLB roster] updateStartingPitchers HTTP ${res.status} for game ${gameId}`);
      return;
    }
    const data = (await res.json()) as any;
    const gameData = data.gameData ?? {};
    const liveData = data.liveData ?? {};

    for (const side of ["home", "away"] as const) {
      const abbrev: string = gameData.teams?.[side]?.abbreviation ?? side;

      // Prefer probable pitcher; fall back to first listed pitcher in boxscore
      const probable = gameData.probablePitchers?.[side];
      const boxPitchers: number[] = liveData.boxscore?.teams?.[side]?.pitchers ?? [];
      const pitcherId = probable
        ? String(probable.id)
        : boxPitchers.length > 0
        ? String(boxPitchers[0])
        : null;

      if (!pitcherId) continue;

      const pitcherName: string = probable?.fullName ?? getPlayer(pitcherId)?.playerName ?? "";
      const throwsHand = getPlayer(pitcherId)?.throws ?? "R";
      const pitchCount =
        liveData.boxscore?.teams?.[side]?.players?.[`ID${pitcherId}`]?.stats?.pitching
          ?.numberOfPitches ?? 0;

      const pitcher: MLBPitcher = {
        pitcherId,
        pitcherName,
        team: abbrev,
        throws: throwsHand,
        pitchCount,
        starterOrReliever: "starter",
      };

      startingPitchers[`${gameId}:${side}`] = pitcher;
    }

    console.log(`[MLB roster] updateStartingPitchers: done for game ${gameId}`);
  } catch (err: any) {
    console.error("[MLB roster] updateStartingPitchers error:", err.message);
  }
}
