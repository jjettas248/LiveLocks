// ── MLB Game Discovery Service ────────────────────────────────────────────────
// Discovers today's live and upcoming MLB games from the MLB Stats API.

export interface MLBGame {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  homePitcher?: string;
  awayPitcher?: string;
}

const SCHEDULE_URL = "https://statsapi.mlb.com/api/v1/schedule?sportId=1";

function todayDateStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export async function discoverTodaysGames(): Promise<MLBGame[]> {
  const url = `${SCHEDULE_URL}&date=${todayDateStr()}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error(`[MLB discovery] HTTP ${res.status} from schedule API`);
      return [];
    }

    const data = (await res.json()) as {
      dates?: Array<{
        games?: Array<{
          gamePk: number;
          gameDate: string;
          status: { abstractGameState: string };
          teams: {
            home: { team: { abbreviation: string } };
            away: { team: { abbreviation: string } };
          };
          probablePitchers?: {
            home?: { fullName: string };
            away?: { fullName: string };
          };
        }>;
      }>;
    };

    const games: MLBGame[] = [];

    // Canonical status normalization: MLB API returns "Live", "In Progress",
    // "in_progress", "Preview", "Pre-Game", or "Final".
    // Allow any live-equivalent state; only exclude finished/future games.
    function isLiveOrPreview(state: string | undefined): boolean {
      if (!state) return false;
      const s = state.toLowerCase().replace(/[\s_-]/g, "");
      return s === "live" || s === "inprogress" || s === "preview" || s === "pregame";
    }

    for (const date of data.dates ?? []) {
      for (const game of date.games ?? []) {
        const state = game.status?.abstractGameState;
        if (!isLiveOrPreview(state)) continue;

        games.push({
          gameId: String(game.gamePk),
          homeTeam: game.teams?.home?.team?.abbreviation ?? "",
          awayTeam: game.teams?.away?.team?.abbreviation ?? "",
          startTime: game.gameDate ?? "",
          homePitcher: game.probablePitchers?.home?.fullName,
          awayPitcher: game.probablePitchers?.away?.fullName,
        });
      }
    }

    console.log(`[MLB discovery] Found ${games.length} active/preview games for ${todayDateStr()}`);
    return games;
  } catch (err: any) {
    console.error("[MLB discovery] discoverTodaysGames error:", err.message);
    return [];
  }
}
