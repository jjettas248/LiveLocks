import { db } from "../db";
import { hrOutcomes, hrHotHitters, hrBallparkFactors } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

type HrOutcome = typeof hrOutcomes.$inferSelect;

interface ParsedHR {
  team: string;
  batterName: string;
  batterMlbId: string | null;
  hrNumber: number;
  runnersOnBase: number;
  inning: number | null;
  outs: number | null;
  launchAngle: number | null;
  exitVelocity: number | null;
  distance: number | null;
  pitchType: string | null;
  pitcherName: string | null;
  ballpark: string | null;
  gameDate: string;
}

interface ParsedHotHitter {
  playerName: string;
  team: string;
  hrCount: number;
  period: string;
}

interface ParsedBallpark {
  ballpark: string;
  hrCount: number;
}

function todayDateStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractMlbIdFromUrl(href: string): string | null {
  const m = href.match(/-(\d{5,7})$/);
  return m ? m[1] : null;
}

function parseHRTable(markdown: string, dateOverride?: string): ParsedHR[] {
  const results: ParsedHR[] = [];
  const lines = markdown.split("\n");

  let currentDate = dateOverride ?? "";
  let inTable = false;
  let headerColumns: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const dateMatch = line.match(/\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
    if (dateMatch && !line.includes("Batter")) {
      currentDate = dateMatch[1];
      inTable = false;
      continue;
    }

    if (line.includes("Batter") && line.startsWith("|")) {
      headerColumns = line.split("|").map(c => c.trim().toLowerCase()).filter(Boolean);
      inTable = true;
      i++;
      continue;
    }

    if (line.startsWith("| ---")) continue;

    if (line.match(/^\d+ Day|Last \d|^##|^#/) && !line.startsWith("|")) {
      inTable = false;
      continue;
    }

    if (!inTable || !line.startsWith("|")) continue;

    const cells = line.split("|").map(c => c.trim()).filter(Boolean);
    if (cells.length < 6) continue;

    const col = (name: string): string | null => {
      const idx = headerColumns.indexOf(name);
      return idx >= 0 && idx < cells.length ? cells[idx] : null;
    };

    const batterCell = col("batter") ?? col("player") ?? cells[0];
    const batterNameMatch = batterCell.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const batterName = batterNameMatch ? batterNameMatch[1] : batterCell;
    const mlbId = batterNameMatch ? extractMlbIdFromUrl(batterNameMatch[2]) : null;

    const team = col("team") ?? "";
    const hrNum = parseInt(col("#") ?? col("total") ?? "1") || 1;
    const rob = parseInt(col("rob") ?? col("runners") ?? "0") || 0;
    const inn = parseInt(col("inn") ?? col("inning") ?? "") || null;
    const outs = parseInt(col("outs") ?? col("out") ?? "") || null;
    const la = parseFloat(col("la") ?? col("launch angle") ?? "") || null;
    const ev = parseFloat(col("ev") ?? col("exit velocity") ?? col("exit velo") ?? "") || null;
    const dist = parseFloat(col("dist") ?? col("distance") ?? "") || null;
    const pitch = col("pitch") ?? col("pitch type") ?? null;
    const pitcher = col("pitcher") ?? col("off") ?? null;
    const ballpark = col("park") ?? col("ballpark") ?? col("venue") ?? null;
    const dateCell = col("date") ?? col("game date") ?? null;

    if (!batterName || batterName === "---") continue;

    results.push({
      team,
      batterName,
      batterMlbId: mlbId,
      hrNumber: hrNum,
      runnersOnBase: rob,
      inning: inn,
      outs,
      launchAngle: la,
      exitVelocity: ev,
      distance: dist,
      pitchType: pitch,
      pitcherName: pitcher,
      ballpark,
      gameDate: dateCell ?? currentDate,
    });
  }

  return results;
}

function parseHotHitters(markdown: string): ParsedHotHitter[] {
  const results: ParsedHotHitter[] = [];
  const lines = markdown.split("\n");

  let currentPeriod = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.includes("Last 7 Days")) { currentPeriod = "7d"; continue; }
    if (trimmed.includes("Last 14 Days")) { currentPeriod = "14d"; continue; }
    if (trimmed.includes("Last 30 Days")) { currentPeriod = "30d"; continue; }

    if (!currentPeriod || !trimmed.startsWith("|") || trimmed.includes("| Team |") || trimmed.startsWith("| ---")) continue;

    const cells = trimmed.split("|").map(c => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    const team = cells[0];
    const playerCell = cells[1];
    const playerName = playerCell.replace(/\[([^\]]+)\]\([^)]+\)/, "$1");
    const hrCount = parseInt(cells[2]) || 0;

    if (playerName && hrCount > 0) {
      results.push({ playerName, team, hrCount, period: currentPeriod });
    }
  }

  return results;
}

function parseBallparks(markdown: string): ParsedBallpark[] {
  const results: ParsedBallpark[] = [];
  const lines = markdown.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || trimmed.includes("| Venue |") || trimmed.startsWith("| ---")) continue;

    const cells = trimmed.split("|").map(c => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    const ballpark = cells[0];
    const hrCount = parseInt(cells[2]) || 0;

    if (ballpark && hrCount > 0) {
      results.push({ ballpark, hrCount });
    }
  }

  return results;
}

async function fetchMarkdown(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "LiveLocks/1.0 (+https://livelocks.app)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`OnlyHomers fetch ${url} → ${res.status}`);
  const html = await res.text();

  const textContent = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return textContent;
}

async function fetchOnlyHomersMarkdown(path: string): Promise<string> {
  const url = `https://www.onlyhomers.com${path}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return htmlToMarkdownTables(html);
  } catch (err: any) {
    console.error(`[OnlyHomers] Failed to fetch ${path}: ${err.message}`);
    throw err;
  }
}

function htmlToMarkdownTables(html: string): string {
  let result = "";

  const headingMatches = html.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi) ?? [];
  for (const h of headingMatches) {
    const text = h.replace(/<[^>]+>/g, "").trim();
    if (text) result += `\n## ${text}\n`;
  }

  const dateRegex = /(\d{4}-\d{2}-\d{2})/g;
  const dateMatches = html.match(dateRegex) ?? [];

  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  let tableIdx = 0;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];

    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    let isFirst = true;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[1];
      const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
      let cellMatch;
      const cells: string[] = [];

      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        let cellContent = cellMatch[1];
        const linkMatch = cellContent.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
        if (linkMatch) {
          const href = linkMatch[1];
          const text = linkMatch[2].replace(/<[^>]+>/g, "").trim();
          cellContent = `[${text}](https://www.onlyhomers.com${href.startsWith("/") ? href : "/" + href})`;
        } else {
          cellContent = cellContent.replace(/<[^>]+>/g, "").trim();
        }
        cells.push(cellContent);
      }

      if (cells.length > 0) {
        result += `| ${cells.join(" | ")} |\n`;
        if (isFirst) {
          result += `| ${cells.map(() => "---").join(" | ")} |\n`;
          isFirst = false;
        }
      }
    }

    result += "\n";
    tableIdx++;
  }

  return result;
}

export async function scrapeOnlyHomersDailyHRs(): Promise<{ inserted: number; skipped: number }> {
  console.log("[OnlyHomers] Scraping daily HR data...");

  let markdown: string;
  try {
    markdown = await fetchOnlyHomersMarkdown("/daily");
  } catch {
    console.error("[OnlyHomers] Could not fetch /daily page");
    return { inserted: 0, skipped: 0 };
  }

  const hrs = parseHRTable(markdown);
  console.log(`[OnlyHomers] Parsed ${hrs.length} HRs from daily page`);

  let inserted = 0;
  let skipped = 0;

  for (const hr of hrs) {
    try {
      await db.insert(hrOutcomes).values({
        season: parseInt(hr.gameDate.substring(0, 4)) || 2026,
        gameDate: hr.gameDate,
        batterName: hr.batterName,
        batterTeam: hr.team,
        batterMlbId: hr.batterMlbId,
        hrNumber: hr.hrNumber,
        runnersOnBase: hr.runnersOnBase,
        inning: hr.inning,
        outs: hr.outs,
        launchAngle: hr.launchAngle != null ? String(hr.launchAngle) : null,
        exitVelocity: hr.exitVelocity != null ? String(hr.exitVelocity) : null,
        distance: hr.distance != null ? String(hr.distance) : null,
        pitchType: hr.pitchType,
        pitcherName: hr.pitcherName,
        ballpark: hr.ballpark,
        source: "onlyhomers",
      }).onConflictDoNothing();
      inserted++;
    } catch (e: any) {
      if (e.message?.includes("duplicate") || e.code === "23505") {
        skipped++;
      } else {
        console.error(`[OnlyHomers] Insert error for ${hr.batterName}: ${e.message}`);
        skipped++;
      }
    }
  }

  console.log(`[OnlyHomers] Daily HRs: inserted=${inserted} skipped=${skipped}`);
  return { inserted, skipped };
}

export async function scrapeOnlyHomersDatabase(season: number = 2026): Promise<{ inserted: number; skipped: number }> {
  const path = season === 2026 ? "/database" : `/database?season=${season}`;
  console.log(`[OnlyHomers] Scraping full database for season ${season}...`);

  let markdown: string;
  try {
    markdown = await fetchOnlyHomersMarkdown(path);
  } catch {
    console.error(`[OnlyHomers] Could not fetch database page for season ${season}`);
    return { inserted: 0, skipped: 0 };
  }

  const hrs = parseHRTable(markdown);
  console.log(`[OnlyHomers] Parsed ${hrs.length} HRs from database (season ${season})`);

  let inserted = 0;
  let skipped = 0;

  for (const hr of hrs) {
    try {
      const gameDate = hr.gameDate || `${season}-01-01`;
      await db.insert(hrOutcomes).values({
        season,
        gameDate,
        batterName: hr.batterName,
        batterTeam: hr.team,
        batterMlbId: hr.batterMlbId,
        hrNumber: hr.hrNumber,
        runnersOnBase: hr.runnersOnBase,
        inning: hr.inning,
        outs: hr.outs,
        launchAngle: hr.launchAngle != null ? String(hr.launchAngle) : null,
        exitVelocity: hr.exitVelocity != null ? String(hr.exitVelocity) : null,
        distance: hr.distance != null ? String(hr.distance) : null,
        pitchType: hr.pitchType,
        pitcherName: hr.pitcherName,
        ballpark: hr.ballpark,
        source: "onlyhomers",
      }).onConflictDoNothing();
      inserted++;
    } catch (e: any) {
      if (e.message?.includes("duplicate") || e.code === "23505") {
        skipped++;
      } else {
        skipped++;
      }
    }
  }

  console.log(`[OnlyHomers] Database (${season}): inserted=${inserted} skipped=${skipped}`);
  return { inserted, skipped };
}

export async function scrapeOnlyHomersHotHitters(): Promise<{ inserted: number }> {
  console.log("[OnlyHomers] Scraping hot hitters...");

  let markdown: string;
  try {
    markdown = await fetchOnlyHomersMarkdown("/fantasy");
  } catch {
    console.error("[OnlyHomers] Could not fetch /fantasy page");
    return { inserted: 0 };
  }

  const hitters = parseHotHitters(markdown);
  console.log(`[OnlyHomers] Parsed ${hitters.length} hot hitter entries`);

  const snapshotDate = todayDateStr();
  let inserted = 0;

  for (const h of hitters) {
    try {
      await db.insert(hrHotHitters).values({
        playerName: h.playerName,
        team: h.team,
        hrCount: h.hrCount,
        period: h.period,
        snapshotDate,
      }).onConflictDoUpdate({
        target: [hrHotHitters.playerName, hrHotHitters.period, hrHotHitters.snapshotDate],
        set: { hrCount: h.hrCount, team: h.team },
      });
      inserted++;
    } catch (e: any) {
      console.error(`[OnlyHomers] Hot hitter insert error: ${e.message}`);
    }
  }

  console.log(`[OnlyHomers] Hot hitters: inserted/updated=${inserted}`);
  return { inserted };
}

export async function scrapeOnlyHomersBallparks(): Promise<{ inserted: number }> {
  console.log("[OnlyHomers] Scraping ballpark HR counts...");

  let markdown: string;
  try {
    markdown = await fetchOnlyHomersMarkdown("/ballparks");
  } catch {
    console.error("[OnlyHomers] Could not fetch /ballparks page");
    return { inserted: 0 };
  }

  const parks = parseBallparks(markdown);
  console.log(`[OnlyHomers] Parsed ${parks.length} ballpark entries`);

  const snapshotDate = todayDateStr();
  let inserted = 0;

  for (const p of parks) {
    try {
      await db.insert(hrBallparkFactors).values({
        season: 2026,
        ballpark: p.ballpark,
        hrCount: p.hrCount,
        snapshotDate,
      }).onConflictDoUpdate({
        target: [hrBallparkFactors.season, hrBallparkFactors.ballpark, hrBallparkFactors.snapshotDate],
        set: { hrCount: p.hrCount },
      });
      inserted++;
    } catch (e: any) {
      console.error(`[OnlyHomers] Ballpark insert error: ${e.message}`);
    }
  }

  console.log(`[OnlyHomers] Ballparks: inserted/updated=${inserted}`);
  return { inserted };
}

export async function runFullOnlyHomersScrape(): Promise<void> {
  console.log("[OnlyHomers] Starting full scrape...");
  const start = Date.now();

  const [daily, hot, parks] = await Promise.all([
    scrapeOnlyHomersDailyHRs().catch(e => { console.error("[OnlyHomers] daily error:", e.message); return { inserted: 0, skipped: 0 }; }),
    scrapeOnlyHomersHotHitters().catch(e => { console.error("[OnlyHomers] hot hitters error:", e.message); return { inserted: 0 }; }),
    scrapeOnlyHomersBallparks().catch(e => { console.error("[OnlyHomers] ballparks error:", e.message); return { inserted: 0 }; }),
  ]);

  console.log(`[OnlyHomers] Full scrape done in ${Date.now() - start}ms — dailyHRs=${daily.inserted} hotHitters=${hot.inserted} ballparks=${parks.inserted}`);
}

export async function runHistoricalScrape(season: number = 2025): Promise<void> {
  console.log(`[OnlyHomers] Starting historical scrape for season ${season}...`);
  const result = await scrapeOnlyHomersDatabase(season);
  console.log(`[OnlyHomers] Historical scrape (${season}): inserted=${result.inserted} skipped=${result.skipped}`);
}

export async function getBatterHrHistory(batterName: string, season?: number): Promise<HrOutcome[]> {
  if (season) {
    return db.select().from(hrOutcomes)
      .where(and(eq(hrOutcomes.batterName, batterName), eq(hrOutcomes.season, season)))
      .orderBy(hrOutcomes.gameDate);
  }
  return db.select().from(hrOutcomes)
    .where(eq(hrOutcomes.batterName, batterName))
    .orderBy(hrOutcomes.gameDate);
}

export async function getBatterVsPitcherHrHistory(batterName: string, pitcherName: string): Promise<HrOutcome[]> {
  return db.select().from(hrOutcomes)
    .where(and(eq(hrOutcomes.batterName, batterName), eq(hrOutcomes.pitcherName, pitcherName)))
    .orderBy(hrOutcomes.gameDate);
}

export async function getBatterAtBallparkHrHistory(batterName: string, ballpark: string): Promise<HrOutcome[]> {
  return db.select().from(hrOutcomes)
    .where(and(eq(hrOutcomes.batterName, batterName), eq(hrOutcomes.ballpark, ballpark)))
    .orderBy(hrOutcomes.gameDate);
}

export async function getHotHitters(period: string = "7d"): Promise<{ playerName: string; team: string; hrCount: number }[]> {
  const today = todayDateStr();
  return db.select({
    playerName: hrHotHitters.playerName,
    team: hrHotHitters.team,
    hrCount: hrHotHitters.hrCount,
  }).from(hrHotHitters)
    .where(and(eq(hrHotHitters.period, period), eq(hrHotHitters.snapshotDate, today)));
}

export async function getLiveBallparkFactors(): Promise<Map<string, number>> {
  const today = todayDateStr();
  const rows = await db.select({
    ballpark: hrBallparkFactors.ballpark,
    hrCount: hrBallparkFactors.hrCount,
  }).from(hrBallparkFactors)
    .where(and(eq(hrBallparkFactors.season, 2026), eq(hrBallparkFactors.snapshotDate, today)));

  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r.ballpark, r.hrCount);
  }
  return map;
}

export async function getHrOutcomeStats(): Promise<{
  totalHrs2026: number;
  totalHrs2025: number;
  uniqueBatters: number;
  topBallpark: { name: string; count: number } | null;
  lastScrapeDate: string | null;
}> {
  const [count2026] = await db.select({ count: sql<number>`count(*)` }).from(hrOutcomes).where(eq(hrOutcomes.season, 2026));
  const [count2025] = await db.select({ count: sql<number>`count(*)` }).from(hrOutcomes).where(eq(hrOutcomes.season, 2025));
  const [batters] = await db.select({ count: sql<number>`count(distinct ${hrOutcomes.batterName})` }).from(hrOutcomes);
  const topPark = await db.select({
    name: hrOutcomes.ballpark,
    count: sql<number>`count(*)`,
  }).from(hrOutcomes)
    .where(eq(hrOutcomes.season, 2026))
    .groupBy(hrOutcomes.ballpark)
    .orderBy(sql`count(*) desc`)
    .limit(1);

  const [lastDate] = await db.select({ d: sql<string>`max(${hrOutcomes.gameDate})` }).from(hrOutcomes);

  return {
    totalHrs2026: Number(count2026?.count ?? 0),
    totalHrs2025: Number(count2025?.count ?? 0),
    uniqueBatters: Number(batters?.count ?? 0),
    topBallpark: topPark.length > 0 ? { name: topPark[0].name ?? "Unknown", count: Number(topPark[0].count) } : null,
    lastScrapeDate: lastDate?.d ?? null,
  };
}
