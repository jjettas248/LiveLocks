import { db } from "../db";
import { players } from "@shared/schema";
import { eq, sql } from "drizzle-orm";

export interface MinutesProjection {
  playerName: string;
  projectedMinutes: number;
  source: string;
}

const FETCH_TIMEOUT_MS = 8000;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z ]/g, "");
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function fetchRotoWireApi(): Promise<MinutesProjection[]> {
  const key = process.env.ROTOWIRE_API_KEY;
  if (!key) return [];
  try {
    const res = await fetchWithTimeout(
      `https://api.rotowire.com/nba/projections.php?key=${key}&format=json`
    );
    if (!res.ok) return [];
    const data = await res.json() as Array<Record<string, unknown>>;
    return data
      .filter(p => p.player_name && p.proj_minutes != null)
      .map(p => ({
        playerName: String(p.player_name),
        projectedMinutes: Number(p.proj_minutes),
        source: "rotowire_api",
      }))
      .filter(p => p.projectedMinutes > 0);
  } catch {
    return [];
  }
}

async function fetchSleeperProjections(): Promise<MinutesProjection[]> {
  try {
    const res = await fetchWithTimeout("https://api.sleeper.app/projections/nba");
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((p: Record<string, unknown>) => p.player_name && p.minutes != null)
      .map((p: Record<string, unknown>) => ({
        playerName: String(p.player_name),
        projectedMinutes: Number(p.minutes),
        source: "sleeper",
      }))
      .filter(p => p.projectedMinutes > 0);
  } catch {
    return [];
  }
}

async function fetchRotoWireScrape(): Promise<MinutesProjection[]> {
  try {
    const res = await fetchWithTimeout("https://www.rotowire.com/basketball/projections.php", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; LiveLocks/1.0)",
        "Accept": "text/html",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const results: MinutesProjection[] = [];

    // Parse table rows — look for player name and minutes columns
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const nameRegex = />([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+)+)</;

    const rows = html.match(rowRegex) ?? [];
    for (const row of rows) {
      const cells: string[] = [];
      let m: RegExpExecArray | null;
      cellRegex.lastIndex = 0;
      while ((m = cellRegex.exec(row)) !== null) {
        cells.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      if (cells.length < 5) continue;

      // First cell typically has a link with the player name
      const nameMatch = nameRegex.exec(cells[0]);
      const playerName = nameMatch ? nameMatch[1] : cells[0].replace(/<[^>]+>/g, "").trim();
      if (!playerName || playerName.length < 4) continue;

      // Minutes column is typically index 4 or 5 depending on layout
      const minutesCandidates = cells.slice(3, 8).map(Number).filter(n => n > 0 && n <= 48);
      if (minutesCandidates.length === 0) continue;

      results.push({
        playerName,
        projectedMinutes: minutesCandidates[0],
        source: "rotowire_scrape",
      });
    }

    return results;
  } catch {
    return [];
  }
}

async function updatePlayerProjections(projections: MinutesProjection[]): Promise<number> {
  if (projections.length === 0) return 0;

  const allPlayers = await db.select({ id: players.id, name: players.name }).from(players);
  const playerMap = new Map(allPlayers.map(p => [normalizeName(p.name), p.id]));

  let updated = 0;
  const now = new Date();

  for (const proj of projections) {
    const playerId = playerMap.get(normalizeName(proj.playerName));
    if (!playerId) continue;

    await db
      .update(players)
      .set({
        projectedMinutes: String(proj.projectedMinutes),
        projectionSource: proj.source,
        projectionUpdatedAt: now,
      })
      .where(eq(players.id, playerId));

    updated++;
  }

  return updated;
}

export async function syncMinutesProjections(): Promise<{ updated: number; source: string }> {
  // Priority 1: RotoWire official API
  let projections = await fetchRotoWireApi();
  if (projections.length > 0) {
    const updated = await updatePlayerProjections(projections);
    console.log(`[projections] RotoWire API — updated ${updated} players`);
    return { updated, source: "rotowire_api" };
  }

  // Priority 2: Sleeper (free)
  projections = await fetchSleeperProjections();
  if (projections.length > 0) {
    const updated = await updatePlayerProjections(projections);
    console.log(`[projections] Sleeper — updated ${updated} players`);
    return { updated, source: "sleeper" };
  }

  // Priority 3: RotoWire web scrape (free)
  projections = await fetchRotoWireScrape();
  if (projections.length > 0) {
    const updated = await updatePlayerProjections(projections);
    console.log(`[projections] RotoWire scrape — updated ${updated} players`);
    return { updated, source: "rotowire_scrape" };
  }

  console.log("[projections] All sources returned no data — no update performed");
  return { updated: 0, source: "none" };
}
