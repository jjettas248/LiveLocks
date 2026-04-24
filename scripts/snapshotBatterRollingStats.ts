/**
 * Task #129 — Snapshot batter rolling stats nightly so HR backtests reflect
 * history.
 *
 * Strategy
 * --------
 *   For a given session date (default = today ET), enumerate every batter who
 *   appeared in `game_player_stats` on that date. For each, compute the
 *   point-in-time rolling stats using the same on-platform definitions the
 *   presence-floor backtest uses:
 *
 *     - seasonHRRate    cumulative HR / PA from `game_player_stats` for the
 *                       player with game_date <  sessionDate AND in the same
 *                       season. (PA ≈ ab + bb; gated PA ≥ 50.)
 *     - hrRateLast30    same numerator/denominator over a trailing 30-day
 *                       window. (PA ≥ 10.)
 *     - barrelRate      barrels / batted-ball events from `contact_events`
 *                       in the trailing 30-day window. (BBE ≥ 10.)
 *     - isHotHitter     OnlyHomers cache enrichment by player name at the
 *                       moment the snapshot runs.
 *
 *   HR counts come from `hr_outcomes` (canonical) joined on
 *   batter_mlb_id = player_id. We intentionally compute from on-platform
 *   tables rather than calling the live MLB Stats API per batter so the
 *   snapshot is reproducible, deterministic, and matches the backtest's own
 *   definitions. The backtest can then look up snapshots by
 *   (playerId, sessionDate) and skip its own per-event compute when present.
 *
 * Usage
 * -----
 *   tsx scripts/snapshotBatterRollingStats.ts                  # today ET
 *   tsx scripts/snapshotBatterRollingStats.ts --date 2026-04-23
 *   tsx scripts/snapshotBatterRollingStats.ts --season 2026
 *   tsx scripts/snapshotBatterRollingStats.ts --backfill --from 2026-04-04 --to 2026-04-23
 */

import { db } from "../server/db";
import { sql, and, eq, gte, lt, inArray } from "drizzle-orm";
import { gamePlayerStats, hrOutcomes, contactEvents } from "@shared/schema";
import { storage } from "../server/storage";
import { todayET } from "../server/utils/dateUtils";
import {
  refreshOnlyHomersCache,
  getOnlyHomersEnrichment,
} from "../server/mlb/liveGameOrchestrator";

interface CliArgs {
  dates: string[];
  season: number;
}

function parseArgs(argv: string[]): CliArgs {
  let date: string | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let backfill = false;
  let explicitSeason: number | null = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") date = argv[++i];
    else if (a === "--from") from = argv[++i];
    else if (a === "--to") to = argv[++i];
    else if (a === "--backfill") backfill = true;
    else if (a === "--season") explicitSeason = parseInt(argv[++i], 10);
  }
  let dates: string[] = [];
  if (backfill && from && to) {
    const start = new Date(from);
    const end = new Date(to);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
  } else {
    dates = [date ?? todayET()];
  }
  const season = explicitSeason ?? parseInt(dates[0].slice(0, 4), 10);
  return { dates, season };
}

interface ComputedSnapshot {
  playerId: string;
  playerName: string;
  seasonHRRate: number | null;
  hrRateLast30: number | null;
  barrelRate: number | null;
}

async function computeSnapshotsForDate(sessionDate: string, season: number): Promise<ComputedSnapshot[]> {
  const seasonStart = `${season}-01-01`;
  const seasonEnd   = `${season}-12-31`;

  // 1. Today's batters (the snapshot universe).
  const todayRows = await db
    .select({ playerId: gamePlayerStats.playerId, playerName: gamePlayerStats.playerName })
    .from(gamePlayerStats)
    .where(eq(gamePlayerStats.gameDate, sessionDate));
  const seenPid = new Set<string>();
  const todaysBatters: { playerId: string; playerName: string }[] = [];
  for (const r of todayRows) {
    if (!r.playerId || seenPid.has(r.playerId)) continue;
    seenPid.add(r.playerId);
    todaysBatters.push({ playerId: r.playerId, playerName: r.playerName ?? "" });
  }

  if (todaysBatters.length === 0) return [];

  const playerIds = Array.from(seenPid);

  // 2. All in-season prior appearances for these players.
  const apRows = await db
    .select({ playerId: gamePlayerStats.playerId, ab: gamePlayerStats.ab, bb: gamePlayerStats.bb, gameDate: gamePlayerStats.gameDate })
    .from(gamePlayerStats)
    .where(and(
      inArray(gamePlayerStats.playerId, playerIds),
      gte(gamePlayerStats.gameDate, seasonStart),
      lt(gamePlayerStats.gameDate, sessionDate),
    ));
  const apByPlayer = new Map<string, { ab: number; bb: number; gameDate: string }[]>();
  for (const r of apRows) {
    if (!r.playerId || !r.gameDate) continue;
    if (!apByPlayer.has(r.playerId)) apByPlayer.set(r.playerId, []);
    apByPlayer.get(r.playerId)!.push({
      ab: r.ab ?? 0,
      bb: r.bb ?? 0,
      gameDate: r.gameDate,
    });
  }

  // 3. HRs from hr_outcomes (canonical) for these players prior to sessionDate.
  const hrRows = await db
    .select({ playerId: hrOutcomes.batterMlbId, gameDate: hrOutcomes.gameDate })
    .from(hrOutcomes)
    .where(and(
      inArray(hrOutcomes.batterMlbId, playerIds),
      eq(hrOutcomes.season, season),
      lt(hrOutcomes.gameDate, sessionDate),
    ));
  const hrByPlayer = new Map<string, string[]>();
  for (const r of hrRows) {
    if (!r.playerId) continue;
    if (!hrByPlayer.has(r.playerId)) hrByPlayer.set(r.playerId, []);
    hrByPlayer.get(r.playerId)!.push(r.gameDate);
  }
  hrByPlayer.forEach(arr => arr.sort());

  // 4. Contact events (last 30d window subset; we filter further per-player below).
  const contactRows = await db
    .select({ playerId: contactEvents.playerId, ts: contactEvents.timestamp, isBarrel: contactEvents.isBarrel })
    .from(contactEvents)
    .where(and(
      inArray(contactEvents.playerId, playerIds),
      gte(contactEvents.timestamp, new Date(seasonStart)),
      lt(contactEvents.timestamp, new Date(`${season + 1}-01-01`)),
    ));
  const contactByPlayer = new Map<string, { ts: number; isBarrel: boolean }[]>();
  for (const r of contactRows) {
    if (!r.playerId || !r.ts) continue;
    if (!contactByPlayer.has(r.playerId)) contactByPlayer.set(r.playerId, []);
    contactByPlayer.get(r.playerId)!.push({
      ts: r.ts.getTime(),
      isBarrel: Boolean(r.isBarrel),
    });
  }
  contactByPlayer.forEach(arr => arr.sort((a: { ts: number }, b: { ts: number }) => a.ts - b.ts));

  // 5. Compute per player.
  const sessionTs = new Date(sessionDate).getTime();
  const seasonStartTs = new Date(seasonStart).getTime();
  const cutoff30Date = (() => {
    const d = new Date(sessionDate);
    d.setDate(d.getDate() - 30);
    const iso = d.toISOString().slice(0, 10);
    return iso < seasonStart ? seasonStart : iso;
  })();
  const cutoff30Ts = Math.max(seasonStartTs, sessionTs - 30 * 86_400_000);

  const out: ComputedSnapshot[] = [];
  for (const b of todaysBatters) {
    const aps = apByPlayer.get(b.playerId) ?? [];
    let cumPA = 0;
    let pa30 = 0;
    for (const a of aps) {
      cumPA += a.ab + a.bb;
      if (a.gameDate >= cutoff30Date) pa30 += a.ab + a.bb;
    }
    const hrDates = hrByPlayer.get(b.playerId) ?? [];
    let cumHR = hrDates.length;
    let hr30 = 0;
    for (const d of hrDates) if (d >= cutoff30Date) hr30++;

    const seasonHRRate = cumPA >= 50 ? cumHR / cumPA : null;
    const hrRateLast30 = pa30 >= 10 ? hr30 / pa30 : null;

    const contacts = contactByPlayer.get(b.playerId) ?? [];
    let bbe = 0;
    let barrels = 0;
    for (const c of contacts) {
      if (c.ts >= sessionTs) break;
      if (c.ts < cutoff30Ts) continue;
      bbe++;
      if (c.isBarrel) barrels++;
    }
    const barrelRate = bbe >= 10 ? barrels / bbe : null;

    out.push({
      playerId: b.playerId,
      playerName: b.playerName,
      seasonHRRate,
      hrRateLast30,
      barrelRate,
    });
  }
  return out;
}

export async function snapshotBatterRollingStatsForDate(sessionDate: string, season?: number): Promise<{ written: number; sessionDate: string }> {
  const seasonY = season ?? parseInt(sessionDate.slice(0, 4), 10);
  const computed = await computeSnapshotsForDate(sessionDate, seasonY);
  if (computed.length === 0) {
    return { written: 0, sessionDate };
  }
  try {
    await refreshOnlyHomersCache();
  } catch (err: any) {
    console.warn(`[snapshot-rolling] OnlyHomers refresh failed: ${err.message}`);
  }
  let written = 0;
  for (const c of computed) {
    const enrichment = getOnlyHomersEnrichment(c.playerName);
    try {
      await storage.upsertBatterRollingSnapshot({
        playerId: c.playerId,
        playerName: c.playerName || null,
        sessionDate,
        seasonHRRate: c.seasonHRRate != null ? String(c.seasonHRRate.toFixed(4)) : null,
        hrRateLast30: c.hrRateLast30 != null ? String(c.hrRateLast30.toFixed(4)) : null,
        barrelRate:   c.barrelRate   != null ? String(c.barrelRate.toFixed(4))   : null,
        isHotHitter: enrichment.isHotHitter,
        season: seasonY,
        source: "nightly_cron",
      });
      written++;
    } catch (err: any) {
      console.error(`[snapshot-rolling] upsert failed playerId=${c.playerId} sessionDate=${sessionDate}: ${err.message}`);
    }
  }
  return { written, sessionDate };
}

async function main() {
  const args = parseArgs(process.argv);
  console.error(`[snapshot-rolling] dates=${args.dates.join(",")} season=${args.season}`);
  let total = 0;
  for (const d of args.dates) {
    const r = await snapshotBatterRollingStatsForDate(d, args.season);
    console.log(`[snapshot-rolling] sessionDate=${d} written=${r.written}`);
    total += r.written;
  }
  console.log(`[snapshot-rolling] done — total rows written: ${total}`);
  process.exit(0);
}

const isDirect = process.argv[1] && process.argv[1].endsWith("snapshotBatterRollingStats.ts");
if (isDirect) {
  main().catch(err => {
    console.error("[snapshot-rolling] fatal:", err);
    process.exit(1);
  });
}
