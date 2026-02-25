import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { type Player, type ParlayPickInput } from "@shared/schema";
import { getPlayerOdds, resolveOddsEventId } from "./oddsService";
import { calculateParlay } from "./parlayService";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/odds", async (req, res) => {
    try {
      const { homeTeam, awayTeam, playerName, statType } = req.query;

      if (!playerName || !statType) {
        return res.status(400).json({ message: "Missing required parameters: playerName, statType" });
      }

      if (!process.env.ODDS_API_KEY) {
        return res.status(503).json({ message: "ODDS_API_KEY not configured" });
      }

      // Resolve Odds API event ID from team names (ESPN uses different IDs)
      const oddsEventId = homeTeam && awayTeam
        ? await resolveOddsEventId(homeTeam as string, awayTeam as string)
        : null;

      if (!oddsEventId) {
        return res.json({}); // No matching event found — graceful empty response
      }

      const formattedOdds = await getPlayerOdds(oddsEventId, playerName as string, statType as string);
      res.json(formattedOdds);
    } catch (err: any) {
      console.error("Odds API Error:", err);
      res.status(500).json({ message: err.message || "Failed to fetch odds" });
    }
  });

  app.get(api.players.list.path, async (req, res) => {
    try {
      const players = await storage.getPlayers();
      res.json(players);
    } catch (e) {
      res.status(500).json({ message: "Failed to fetch players" });
    }
  });

  app.get(api.teams.list.path, async (req, res) => {
    try {
      const teams = await storage.getTeams();
      res.json(teams);
    } catch (e) {
      res.status(500).json({ message: "Failed to fetch teams" });
    }
  });

  app.post(api.calculator.calculate.path, async (req, res) => {
    try {
      const input = api.calculator.calculate.input.parse(req.body);
      const result = await storage.calculateProbability(input);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      res.status(500).json({ message: "Internal server error", details: (err as any).message });
    }
  });

  // Proxy ESPN live NBA scoreboard to avoid CORS
  app.get("/api/live-games", async (req, res) => {
    try {
      const response = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!response.ok) throw new Error("ESPN API unavailable");
      const data = await response.json() as any;
      const games = (data.events || []).map((event: any) => {
        const comp = event.competitions?.[0];
        const home = comp?.competitors?.find((c: any) => c.homeAway === "home");
        const away = comp?.competitors?.find((c: any) => c.homeAway === "away");
        const status = comp?.status;
        return {
          id: event.id,
          homeTeam: home?.team?.displayName ?? "",
          homeTeamAbbr: home?.team?.abbreviation ?? "",
          homeScore: parseInt(home?.score ?? "0", 10),
          awayTeam: away?.team?.displayName ?? "",
          awayTeamAbbr: away?.team?.abbreviation ?? "",
          awayScore: parseInt(away?.score ?? "0", 10),
          status: status?.type?.description ?? "Scheduled",
          period: status?.period ?? 0,
          clock: status?.displayClock ?? "",
        };
      });
      res.json(games);
    } catch (e) {
      res.status(502).json({ message: "Live data unavailable", games: [] });
    }
  });

  app.get("/api/live-stats/:gameId", async (req, res) => {
    try {
      const { gameId } = req.params;
      const response = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gameId}`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!response.ok) throw new Error("ESPN Boxscore API unavailable");
      const data = await response.json() as any;
      
      const boxscore = data.boxscore;
      if (!boxscore) throw new Error("Boxscore data not found");

      const players: any[] = [];
      const teams = boxscore.players || [];

      teams.forEach((teamData: any) => {
        const teamAbbr = teamData.team?.abbreviation;
        const athletes = teamData.statistics?.[0]?.athletes || [];
        const labels = teamData.statistics?.[0]?.labels || [];

        athletes.forEach((athlete: any) => {
          if (!athlete.athlete) return;
          
          const stats = athlete.stats || [];
          const statMap: Record<string, any> = {};
          
          labels.forEach((label: string, idx: number) => {
            statMap[label.toLowerCase()] = stats[idx];
          });

          // ESPN stats often come as strings like "24", or for rebounds "2-4-6" (off-def-tot)
          // We need to parse them carefully
          const parseStat = (val: string) => {
            if (!val) return 0;
            if (val.includes("-")) {
              const parts = val.split("-");
              return parseInt(parts[parts.length - 1], 10) || 0;
            }
            return parseInt(val, 10) || 0;
          };

          players.push({
            playerId: parseInt(athlete.athlete.id, 10),
            playerName: athlete.athlete.displayName,
            teamAbbr: teamAbbr,
            minutes: statMap["min"] || "0",
            points: parseStat(statMap["pts"]),
            rebounds: parseStat(statMap["reb"]),
            assists: parseStat(statMap["ast"]),
            steals: parseStat(statMap["stl"]),
            blocks: parseStat(statMap["blk"]),
            fouls: parseStat(statMap["pf"]),
          });
        });
      });

      res.json(players);
    } catch (e) {
      res.status(502).json({ message: "Live stats unavailable", details: (e as any).message });
    }
  });

  app.post("/api/parlay/calculate", async (req, res) => {
    try {
      const picks = req.body.picks as ParlayPickInput[];
      if (!picks || !Array.isArray(picks)) {
        return res.status(400).json({ message: "Invalid picks provided" });
      }
      const result = calculateParlay(picks);
      res.json(result);
    } catch (err) {
      res.status(500).json({ message: "Internal server error", details: (err as any).message });
    }
  });

  // Roster sync from ESPN API — updates player team assignments from live rosters
  app.post("/api/sync-rosters", async (req, res) => {
    try {
      const ESPN_TO_DB: Record<string, string> = {
        GS: "GSW", SA: "SAS", NO: "NOP", NY: "NYK",
        PHO: "PHX", UTH: "UTA", WSH: "WAS", CHO: "CHA",
      };
      const normalize = (s: string) => s.toLowerCase().replace(/['.'\-\s]+/g, "").replace(/jr$|sr$|ii$|iii$|iv$/,"");

      // 1. Get all NBA teams from ESPN
      const teamsRes = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=32",
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (!teamsRes.ok) throw new Error("ESPN teams API unavailable");
      const teamsData = await teamsRes.json() as any;
      const espnTeams: any[] = teamsData.sports?.[0]?.leagues?.[0]?.teams ?? [];

      // 2. Get current DB players
      const dbPlayers = await storage.getPlayers();

      let updated = 0, added = 0, skipped = 0, teamErrors = 0;
      const processedPlayerIds = new Set<number>();

      for (const teamWrapper of espnTeams) {
        const espnTeam = teamWrapper.team;
        const espnAbbr: string = espnTeam.abbreviation ?? "";
        const dbTeam = ESPN_TO_DB[espnAbbr] ?? espnAbbr;

        try {
          const rosterRes = await fetch(
            `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeam.id}/roster`,
            { headers: { "User-Agent": "Mozilla/5.0" } }
          );
          if (!rosterRes.ok) { teamErrors++; continue; }
          const rosterData = await rosterRes.json() as any;

          // ESPN returns athletes as flat array or grouped array
          let athletes: any[] = [];
          if (Array.isArray(rosterData.athletes)) {
            if (rosterData.athletes.length > 0 && Array.isArray(rosterData.athletes[0])) {
              athletes = rosterData.athletes.flat();
            } else {
              athletes = rosterData.athletes;
            }
          }

          for (const athlete of athletes) {
            const name: string = athlete.displayName ?? athlete.fullName ?? "";
            if (!name) continue;
            const pos: string = athlete.position?.abbreviation ?? "SF";
            const normName = normalize(name);

            const match = dbPlayers.find(p => normalize(p.name) === normName);
            if (match) {
              if (!processedPlayerIds.has(match.id)) {
                processedPlayerIds.add(match.id);
                if (match.team !== dbTeam) {
                  await storage.updatePlayerStats(match.id, { team: dbTeam } as any);
                  match.team = dbTeam;
                  updated++;
                } else {
                  skipped++;
                }
              }
            } else {
              // Only add if it looks like a real NBA player (ESPN roster = active player)
              const validPos = ["PG","SG","SF","PF","C"].includes(pos) ? pos : "SF";
              await storage.createPlayer({
                name,
                team: dbTeam,
                position: validPos,
                avgMinutes: "20.0",
                avgFouls: "2.0",
              });
              dbPlayers.push({ id: -1, name, team: dbTeam, position: validPos, avgMinutes: "20.0", avgFouls: "2.0", ppg: null, rpg: null, apg: null, spg: null, bpg: null, usageRate: null, statsUpdatedAt: null });
              added++;
            }
          }
        } catch (teamErr) {
          console.error(`Error syncing ${dbTeam}:`, teamErr);
          teamErrors++;
        }
        await new Promise(r => setTimeout(r, 150));
      }

      res.json({
        message: `Roster sync complete`,
        updated,
        added,
        skipped,
        teamErrors,
        totalPlayers: dbPlayers.length,
      });
    } catch (e) {
      res.status(500).json({ message: "Roster sync failed", error: (e as any).message });
    }
  });

  app.get("/api/sync-stats", async (req, res) => {
    try {
      const players = await storage.getPlayers();
      const BDL_API_KEY = process.env.BDL_API_KEY;
      
      if (!BDL_API_KEY) {
        return res.status(500).json({ message: "BallDontLie API key not configured" });
      }

      // 1. Get BallDontLie player IDs for our players
      // We'll search by name. BDL search can be finicky so we do it one by one or in small batches.
      // For a sync, we can afford some time.
      let syncCount = 0;
      for (const player of players) {
        try {
          // Search player to get BDL ID
          const searchRes = await fetch(`https://api.balldontlie.io/v1/players?search=${encodeURIComponent(player.name)}`, {
            headers: { "Authorization": BDL_API_KEY }
          });
          if (!searchRes.ok) continue;
          const searchData = await searchRes.json() as any;
          const bdlPlayer = searchData.data?.[0];
          
          if (bdlPlayer) {
            // Get season averages for 2024 (2025-26 season might not be available or 2024 is the latest complete/active)
            const statsRes = await fetch(`https://api.balldontlie.io/v1/season_averages?season=2024&player_ids[]=${bdlPlayer.id}`, {
              headers: { "Authorization": BDL_API_KEY }
            });
            if (!statsRes.ok) continue;
            const statsData = await statsRes.json() as any;
            const avg = statsData.data?.[0];
            
            if (avg) {
              await storage.updatePlayerStats(player.id, {
                ppg: avg.pts?.toString(),
                rpg: avg.reb?.toString(),
                apg: avg.ast?.toString(),
                spg: avg.stl?.toString(),
                bpg: avg.blk?.toString(),
                avgMinutes: avg.min || player.avgMinutes,
              });
              syncCount++;
            }
          }
          // Rate limiting sleep for free tier if needed
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (err) {
          console.error(`Failed to sync ${player.name}:`, err);
        }
      }

      res.json({ message: `Synced ${syncCount} players` });
    } catch (e) {
      res.status(500).json({ message: "Sync failed", error: (e as any).message });
    }
  });

  await seedDatabase();
  return httpServer;
}

async function seedDatabase() {
  const existingPlayers = await storage.getPlayers();
  if (existingPlayers.length === 0) {
    // ── 2025-26 NBA ROSTERS (accurate as of Feb 25, 2026) ────────────────────
    // All Feb 5, 2026 trade deadline moves reflected (28 trades, 73 players moved).
    // Key offseason moves (summer 2025):
    //  • Luka Doncic → LAL; Anthony Davis → DAL (then →WAS at deadline)
    //  • De'Aaron Fox → SAS; Jimmy Butler → GSW (ACL, out for season – omitted)
    //  • Jayson Tatum – Achilles rupture May 2025, out for season – omitted
    //  • Domantas Sabonis → MIL; Cooper Flagg #1 pick → NOP
    //  • Al Horford signed with GSW (FA); Jrue Holiday → POR (Simons deal)
    //  • Anfernee Simons: POR → BOS → CHI; Kristaps Porzingis: BOS → ATL → GSW
    // Key Feb 5 deadline moves:
    //  • Anthony Davis → WAS (from DAL); Trae Young → WAS (from ATL, Jan 9)
    //  • James Harden → CLE; Darius Garland → LAC
    //  • Jaren Jackson Jr. → UTA; Lonzo Ball → UTA
    //  • Kristaps Porzingis → GSW (from ATL); Jonathan Kuminga, Buddy Hield → ATL
    //  • Ivica Zubac → IND; Bennedict Mathurin → LAC
    //  • Nikola Vucevic → BOS; Anfernee Simons → CHI
    //  • Jaden Ivey → CHI (from DET); Rob Dillingham, Leonard Miller → CHI (from MIN)
    //  • Coby White → CHA; Collin Sexton → CHI (from UTA via CHA)
    //  • Ayo Dosunmu, Julian Phillips → MIN; Guerschon Yabusele → CHI (from NYK)
    //  • Jose Alvarado → NYK (from NOP); Dalen Terry → NOP (from CHI via NYK)
    //  • Luke Kennard → LAL; Gabe Vincent → ATL (from LAL)
    //  • Jared McCain → OKC (from PHI)
    //  • De'Andre Hunter → SAC (from CLE, via ATL)
    //  • Dennis Schroder, Keon Ellis → CLE (from SAC)
    //  • Eric Gordon → MEM (from PHI); Taylor Hendricks, Kyle Anderson, etc. → MEM
    //  • Ty Jerome → MEM (confirmed via live odds data)
    //  • Chris Paul → TOR (from LAC, buyout expected); Trayce Jackson-Davis → TOR
    //  • Ochai Agbaji → BKN (from TOR); Josh Minott → BKN (from BOS)
    //  • Ousmane Dieng → MIL (from CHI, via OKC → CHA → CHI)
    //  • Cole Anthony → PHX (from ORL via MIL); Amir Coffey → PHX
    //  • Khris Middleton → DAL; Tyus Jones → DAL (from ORL via CHA)
    const playersToSeed = [
      // ATL Hawks — rebuilt at deadline; Kuminga/Hield/CJ McCollum added
      { name: "Jalen Johnson", team: "ATL", position: "PF", avgMinutes: "34.5", avgFouls: "2.1" },
      { name: "Dyson Daniels", team: "ATL", position: "SG", avgMinutes: "33.5", avgFouls: "2.0" },
      { name: "AJ Griffin", team: "ATL", position: "SF", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Garrison Mathews", team: "ATL", position: "SG", avgMinutes: "17.0", avgFouls: "1.1" },
      { name: "Larry Nance Jr.", team: "ATL", position: "PF", avgMinutes: "20.0", avgFouls: "2.1" },
      { name: "CJ McCollum", team: "ATL", position: "SG", avgMinutes: "29.0", avgFouls: "1.5" },
      { name: "Corey Kispert", team: "ATL", position: "SF", avgMinutes: "27.0", avgFouls: "1.6" },
      { name: "Jonathan Kuminga", team: "ATL", position: "SF", avgMinutes: "27.0", avgFouls: "2.4" },
      { name: "Buddy Hield", team: "ATL", position: "SG", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Gabe Vincent", team: "ATL", position: "SG", avgMinutes: "20.0", avgFouls: "1.5" },
      { name: "Jock Landale", team: "ATL", position: "C", avgMinutes: "16.0", avgFouls: "2.0" },
      { name: "Duop Reath", team: "ATL", position: "C", avgMinutes: "18.0", avgFouls: "2.1" },
      // BKN Nets — added Agbaji, Minott, Hunter Tyson at deadline
      { name: "Cameron Johnson", team: "BKN", position: "SF", avgMinutes: "31.0", avgFouls: "1.6" },
      { name: "Nic Claxton", team: "BKN", position: "C", avgMinutes: "27.0", avgFouls: "3.0" },
      { name: "Ben Simmons", team: "BKN", position: "PG", avgMinutes: "22.0", avgFouls: "1.9" },
      { name: "Ziaire Williams", team: "BKN", position: "SF", avgMinutes: "24.0", avgFouls: "1.7" },
      { name: "Ochai Agbaji", team: "BKN", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Josh Minott", team: "BKN", position: "SF", avgMinutes: "18.0", avgFouls: "1.6" },
      { name: "Hunter Tyson", team: "BKN", position: "SF", avgMinutes: "20.0", avgFouls: "1.5" },
      // BOS Celtics — Tatum (Achilles, out) not listed; Vucevic added; Horford/Porzingis/Holiday gone
      { name: "Jaylen Brown", team: "BOS", position: "SG", avgMinutes: "35.5", avgFouls: "2.4" },
      { name: "Derrick White", team: "BOS", position: "SG", avgMinutes: "33.0", avgFouls: "2.2" },
      { name: "Payton Pritchard", team: "BOS", position: "PG", avgMinutes: "27.0", avgFouls: "1.3" },
      { name: "Sam Hauser", team: "BOS", position: "SF", avgMinutes: "25.5", avgFouls: "1.1" },
      { name: "Nikola Vucevic", team: "BOS", position: "C", avgMinutes: "31.5", avgFouls: "2.5" },
      // CHA Hornets — major pickup of Coby White, Malaki Branham, Dieng, Tillman, Conley
      { name: "LaMelo Ball", team: "CHA", position: "PG", avgMinutes: "33.5", avgFouls: "2.0" },
      { name: "Miles Bridges", team: "CHA", position: "SF", avgMinutes: "34.5", avgFouls: "2.2" },
      { name: "Brandon Miller", team: "CHA", position: "SF", avgMinutes: "33.0", avgFouls: "2.1" },
      { name: "Mark Williams", team: "CHA", position: "C", avgMinutes: "27.5", avgFouls: "2.7" },
      { name: "Tre Mann", team: "CHA", position: "SG", avgMinutes: "27.0", avgFouls: "1.6" },
      { name: "Coby White", team: "CHA", position: "PG", avgMinutes: "36.0", avgFouls: "2.2" },
      { name: "Malaki Branham", team: "CHA", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Xavier Tillman Sr.", team: "CHA", position: "C", avgMinutes: "18.0", avgFouls: "2.1" },
      // CHI Bulls — massive rebuild; Simons, Ivey, Dillingham, Miller, Sexton, Richards, Yabusele added
      { name: "Josh Giddey", team: "CHI", position: "PG", avgMinutes: "35.0", avgFouls: "1.8" },
      { name: "Zach LaVine", team: "CHI", position: "SG", avgMinutes: "33.5", avgFouls: "1.8" },
      { name: "Patrick Williams", team: "CHI", position: "PF", avgMinutes: "29.5", avgFouls: "2.0" },
      { name: "Anfernee Simons", team: "CHI", position: "SG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Jaden Ivey", team: "CHI", position: "SG", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Rob Dillingham", team: "CHI", position: "PG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Leonard Miller", team: "CHI", position: "SF", avgMinutes: "20.0", avgFouls: "1.8" },
      { name: "Collin Sexton", team: "CHI", position: "PG", avgMinutes: "29.0", avgFouls: "2.0" },
      { name: "Nick Richards", team: "CHI", position: "C", avgMinutes: "21.0", avgFouls: "2.3" },
      { name: "Guerschon Yabusele", team: "CHI", position: "PF", avgMinutes: "22.0", avgFouls: "2.0" },
      // CLE Cavaliers — Harden in, Garland out; Ellis/Schroder/E.Miller added
      { name: "Donovan Mitchell", team: "CLE", position: "SG", avgMinutes: "35.5", avgFouls: "2.1" },
      { name: "Evan Mobley", team: "CLE", position: "PF", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Jarrett Allen", team: "CLE", position: "C", avgMinutes: "29.0", avgFouls: "2.2" },
      { name: "Sam Merrill", team: "CLE", position: "SG", avgMinutes: "17.0", avgFouls: "1.0" },
      { name: "James Harden", team: "CLE", position: "PG", avgMinutes: "33.0", avgFouls: "2.1" },
      { name: "Keon Ellis", team: "CLE", position: "SG", avgMinutes: "25.0", avgFouls: "1.6" },
      { name: "Dennis Schroder", team: "CLE", position: "PG", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Emanuel Miller", team: "CLE", position: "SF", avgMinutes: "20.0", avgFouls: "1.8" },
      // DAL Mavericks — Davis/Russell out; Middleton/Jones/Bagley/AJ Johnson added
      { name: "Kyrie Irving", team: "DAL", position: "SG", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Klay Thompson", team: "DAL", position: "SG", avgMinutes: "30.0", avgFouls: "1.7" },
      { name: "PJ Washington", team: "DAL", position: "PF", avgMinutes: "29.0", avgFouls: "2.1" },
      { name: "Daniel Gafford", team: "DAL", position: "C", avgMinutes: "22.0", avgFouls: "2.6" },
      { name: "Dereck Lively II", team: "DAL", position: "C", avgMinutes: "24.0", avgFouls: "2.4" },
      { name: "Spencer Dinwiddie", team: "DAL", position: "PG", avgMinutes: "20.0", avgFouls: "1.8" },
      { name: "Khris Middleton", team: "DAL", position: "SF", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Tyus Jones", team: "DAL", position: "PG", avgMinutes: "22.0", avgFouls: "1.4" },
      { name: "Marvin Bagley III", team: "DAL", position: "C", avgMinutes: "18.0", avgFouls: "2.3" },
      { name: "AJ Johnson", team: "DAL", position: "SF", avgMinutes: "20.0", avgFouls: "1.7" },
      // DEN Nuggets — Jokic-centric; Hunter Tyson traded
      { name: "Nikola Jokic", team: "DEN", position: "C", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Jamal Murray", team: "DEN", position: "PG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Michael Porter Jr.", team: "DEN", position: "SF", avgMinutes: "32.5", avgFouls: "1.5" },
      { name: "Aaron Gordon", team: "DEN", position: "PF", avgMinutes: "32.5", avgFouls: "2.3" },
      { name: "Christian Braun", team: "DEN", position: "SG", avgMinutes: "29.0", avgFouls: "1.8" },
      { name: "Julian Strawther", team: "DEN", position: "SG", avgMinutes: "21.0", avgFouls: "1.5" },
      { name: "Reggie Jackson", team: "DEN", position: "PG", avgMinutes: "18.0", avgFouls: "1.6" },
      // DET Pistons — Ivey gone to CHI; Huerter and Saric added
      { name: "Cade Cunningham", team: "DET", position: "PG", avgMinutes: "35.0", avgFouls: "2.1" },
      { name: "Jalen Duren", team: "DET", position: "C", avgMinutes: "28.5", avgFouls: "2.9" },
      { name: "Ausar Thompson", team: "DET", position: "SF", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Isaiah Stewart", team: "DET", position: "C", avgMinutes: "29.0", avgFouls: "2.6" },
      { name: "Ron Holland", team: "DET", position: "SF", avgMinutes: "22.0", avgFouls: "1.9" },
      { name: "Tim Hardaway Jr.", team: "DET", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "Kevin Huerter", team: "DET", position: "SG", avgMinutes: "26.0", avgFouls: "1.5" },
      { name: "Dario Saric", team: "DET", position: "C", avgMinutes: "22.0", avgFouls: "2.2" },
      // GSW Warriors — Porzingis + Horford added; Kuminga/Hield/TJD gone; Butler (ACL) omitted; Curry injured
      { name: "Stephen Curry", team: "GSW", position: "PG", avgMinutes: "33.0", avgFouls: "1.6" },
      { name: "Draymond Green", team: "GSW", position: "PF", avgMinutes: "26.5", avgFouls: "2.9" },
      { name: "Andrew Wiggins", team: "GSW", position: "SF", avgMinutes: "28.5", avgFouls: "1.9" },
      { name: "Moses Moody", team: "GSW", position: "SG", avgMinutes: "26.0", avgFouls: "1.6" },
      { name: "Brandin Podziemski", team: "GSW", position: "SG", avgMinutes: "29.5", avgFouls: "1.6" },
      { name: "De'Anthony Melton", team: "GSW", position: "SG", avgMinutes: "28.0", avgFouls: "1.8" },
      { name: "Al Horford", team: "GSW", position: "C", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Kristaps Porzingis", team: "GSW", position: "C", avgMinutes: "27.0", avgFouls: "2.7" },
      // HOU Rockets — no significant deadline moves
      { name: "Jalen Green", team: "HOU", position: "SG", avgMinutes: "34.0", avgFouls: "2.1" },
      { name: "Alperen Sengun", team: "HOU", position: "C", avgMinutes: "31.0", avgFouls: "3.0" },
      { name: "Amen Thompson", team: "HOU", position: "SF", avgMinutes: "30.0", avgFouls: "2.2" },
      { name: "Fred VanVleet", team: "HOU", position: "PG", avgMinutes: "31.0", avgFouls: "1.8" },
      { name: "Jabari Smith Jr.", team: "HOU", position: "PF", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Tari Eason", team: "HOU", position: "PF", avgMinutes: "23.0", avgFouls: "2.4" },
      { name: "Dillon Brooks", team: "HOU", position: "SF", avgMinutes: "29.0", avgFouls: "2.8" },
      // IND Pacers — Zubac + Kobe Brown added; Mathurin/I.Jackson gone
      { name: "Tyrese Haliburton", team: "IND", position: "PG", avgMinutes: "33.0", avgFouls: "1.1" },
      { name: "Pascal Siakam", team: "IND", position: "PF", avgMinutes: "36.0", avgFouls: "2.1" },
      { name: "Myles Turner", team: "IND", position: "C", avgMinutes: "31.0", avgFouls: "2.5" },
      { name: "Andrew Nembhard", team: "IND", position: "PG", avgMinutes: "29.0", avgFouls: "1.7" },
      { name: "Aaron Nesmith", team: "IND", position: "SF", avgMinutes: "28.0", avgFouls: "2.3" },
      { name: "TJ McConnell", team: "IND", position: "PG", avgMinutes: "21.0", avgFouls: "1.5" },
      { name: "Ivica Zubac", team: "IND", position: "C", avgMinutes: "27.5", avgFouls: "2.8" },
      { name: "Kobe Brown", team: "IND", position: "SF", avgMinutes: "22.0", avgFouls: "1.9" },
      // LAC Clippers — Harden/Zubac gone; Garland/Mathurin/I.Jackson added
      { name: "Kawhi Leonard", team: "LAC", position: "SF", avgMinutes: "33.0", avgFouls: "1.6" },
      { name: "Norman Powell", team: "LAC", position: "SG", avgMinutes: "27.0", avgFouls: "1.7" },
      { name: "Bones Hyland", team: "LAC", position: "PG", avgMinutes: "21.0", avgFouls: "1.8" },
      { name: "Terance Mann", team: "LAC", position: "SF", avgMinutes: "24.0", avgFouls: "1.9" },
      { name: "Darius Garland", team: "LAC", position: "PG", avgMinutes: "34.0", avgFouls: "1.9" },
      { name: "Bennedict Mathurin", team: "LAC", position: "SG", avgMinutes: "30.0", avgFouls: "2.2" },
      { name: "Isaiah Jackson", team: "LAC", position: "C", avgMinutes: "24.0", avgFouls: "2.7" },
      // LAL Lakers — Luka/LeBron; D'Angelo Russell/Gabe Vincent gone; Kennard added
      { name: "Luka Doncic", team: "LAL", position: "PG", avgMinutes: "37.0", avgFouls: "2.2" },
      { name: "LeBron James", team: "LAL", position: "SF", avgMinutes: "35.0", avgFouls: "2.0" },
      { name: "Austin Reaves", team: "LAL", position: "SG", avgMinutes: "33.0", avgFouls: "1.7" },
      { name: "Rui Hachimura", team: "LAL", position: "PF", avgMinutes: "25.0", avgFouls: "1.7" },
      { name: "Jarred Vanderbilt", team: "LAL", position: "PF", avgMinutes: "22.0", avgFouls: "2.3" },
      { name: "Luke Kennard", team: "LAL", position: "SG", avgMinutes: "24.0", avgFouls: "1.3" },
      // MEM Grizzlies — JJJ traded to UTA; many new pieces arrived; Ty Jerome here per live odds
      { name: "Ja Morant", team: "MEM", position: "PG", avgMinutes: "33.5", avgFouls: "1.9" },
      { name: "Desmond Bane", team: "MEM", position: "SG", avgMinutes: "33.0", avgFouls: "1.8" },
      { name: "Jaylen Wells", team: "MEM", position: "SG", avgMinutes: "24.0", avgFouls: "1.5" },
      { name: "Santi Aldama", team: "MEM", position: "PF", avgMinutes: "25.0", avgFouls: "1.8" },
      { name: "Scotty Pippen Jr.", team: "MEM", position: "PG", avgMinutes: "21.0", avgFouls: "1.3" },
      { name: "Zach Edey", team: "MEM", position: "C", avgMinutes: "24.0", avgFouls: "2.8" },
      { name: "GG Jackson", team: "MEM", position: "SF", avgMinutes: "22.0", avgFouls: "1.7" },
      { name: "Walter Clayton Jr.", team: "MEM", position: "PG", avgMinutes: "22.0", avgFouls: "1.4" },
      { name: "Kyle Anderson", team: "MEM", position: "SF", avgMinutes: "20.0", avgFouls: "1.9" },
      { name: "Taylor Hendricks", team: "MEM", position: "PF", avgMinutes: "20.0", avgFouls: "1.8" },
      { name: "Eric Gordon", team: "MEM", position: "SG", avgMinutes: "19.0", avgFouls: "1.3" },
      { name: "Georges Niang", team: "MEM", position: "PF", avgMinutes: "18.0", avgFouls: "1.4" },
      { name: "Ty Jerome", team: "MEM", position: "PG", avgMinutes: "22.0", avgFouls: "1.2" },
      // MIA Heat — Butler gone (GSW); Herro/Adebayo anchor
      { name: "Bam Adebayo", team: "MIA", position: "C", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Tyler Herro", team: "MIA", position: "SG", avgMinutes: "34.5", avgFouls: "2.1" },
      { name: "Terry Rozier", team: "MIA", position: "PG", avgMinutes: "29.0", avgFouls: "1.9" },
      { name: "Haywood Highsmith", team: "MIA", position: "SF", avgMinutes: "25.0", avgFouls: "2.0" },
      { name: "Nikola Jovic", team: "MIA", position: "PF", avgMinutes: "26.0", avgFouls: "1.8" },
      // MIL Bucks — Middleton gone to DAL; Ousmane Dieng added; Giannis/Lillard/Sabonis core
      { name: "Giannis Antetokounmpo", team: "MIL", position: "PF", avgMinutes: "35.5", avgFouls: "2.9" },
      { name: "Damian Lillard", team: "MIL", position: "PG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Domantas Sabonis", team: "MIL", position: "C", avgMinutes: "33.0", avgFouls: "3.1" },
      { name: "Brook Lopez", team: "MIL", position: "C", avgMinutes: "27.0", avgFouls: "2.1" },
      { name: "Bobby Portis", team: "MIL", position: "PF", avgMinutes: "22.0", avgFouls: "2.2" },
      { name: "Ousmane Dieng", team: "MIL", position: "SF", avgMinutes: "22.0", avgFouls: "1.7" },
      // MIN Timberwolves — Conley/Dillingham/Miller gone; Dosunmu + Phillips added
      { name: "Anthony Edwards", team: "MIN", position: "SG", avgMinutes: "35.5", avgFouls: "1.8" },
      { name: "Julius Randle", team: "MIN", position: "PF", avgMinutes: "35.0", avgFouls: "2.6" },
      { name: "Rudy Gobert", team: "MIN", position: "C", avgMinutes: "32.5", avgFouls: "2.5" },
      { name: "Naz Reid", team: "MIN", position: "C", avgMinutes: "24.5", avgFouls: "2.4" },
      { name: "Nickeil Alexander-Walker", team: "MIN", position: "SG", avgMinutes: "21.0", avgFouls: "1.7" },
      { name: "Donte DiVincenzo", team: "MIN", position: "SG", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Ayo Dosunmu", team: "MIN", position: "SG", avgMinutes: "30.0", avgFouls: "1.7" },
      { name: "Julian Phillips", team: "MIN", position: "SF", avgMinutes: "22.0", avgFouls: "1.7" },
      // NOP Pelicans — CJ McCollum gone to WAS/ATL; Dalen Terry added
      { name: "Cooper Flagg", team: "NOP", position: "PF", avgMinutes: "30.0", avgFouls: "2.0" },
      { name: "Zion Williamson", team: "NOP", position: "PF", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "Brandon Ingram", team: "NOP", position: "SF", avgMinutes: "33.0", avgFouls: "1.8" },
      { name: "Dejounte Murray", team: "NOP", position: "PG", avgMinutes: "33.5", avgFouls: "2.3" },
      { name: "Herbert Jones", team: "NOP", position: "SF", avgMinutes: "28.0", avgFouls: "2.6" },
      { name: "Jordan Hawkins", team: "NOP", position: "SG", avgMinutes: "23.0", avgFouls: "1.4" },
      { name: "Dalen Terry", team: "NOP", position: "SG", avgMinutes: "18.0", avgFouls: "1.5" },
      // NYK Knicks — Yabusele gone; Jose Alvarado added
      { name: "Jalen Brunson", team: "NYK", position: "PG", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Karl-Anthony Towns", team: "NYK", position: "C", avgMinutes: "35.0", avgFouls: "2.8" },
      { name: "OG Anunoby", team: "NYK", position: "SF", avgMinutes: "33.5", avgFouls: "2.1" },
      { name: "Josh Hart", team: "NYK", position: "SF", avgMinutes: "33.5", avgFouls: "2.3" },
      { name: "Mikal Bridges", team: "NYK", position: "SG", avgMinutes: "35.5", avgFouls: "1.4" },
      { name: "Miles McBride", team: "NYK", position: "PG", avgMinutes: "23.0", avgFouls: "1.6" },
      { name: "Jose Alvarado", team: "NYK", position: "PG", avgMinutes: "18.0", avgFouls: "1.7" },
      // OKC Thunder — Jared McCain added from PHI
      { name: "Shai Gilgeous-Alexander", team: "OKC", position: "PG", avgMinutes: "34.5", avgFouls: "2.5" },
      { name: "Chet Holmgren", team: "OKC", position: "C", avgMinutes: "30.0", avgFouls: "2.3" },
      { name: "Jalen Williams", team: "OKC", position: "SG", avgMinutes: "34.0", avgFouls: "2.0" },
      { name: "Alex Caruso", team: "OKC", position: "SG", avgMinutes: "29.0", avgFouls: "2.3" },
      { name: "Luguentz Dort", team: "OKC", position: "SG", avgMinutes: "29.5", avgFouls: "2.3" },
      { name: "Isaiah Hartenstein", team: "OKC", position: "C", avgMinutes: "26.5", avgFouls: "2.7" },
      { name: "Aaron Wiggins", team: "OKC", position: "SG", avgMinutes: "20.0", avgFouls: "1.5" },
      { name: "Jared McCain", team: "OKC", position: "SG", avgMinutes: "24.0", avgFouls: "1.6" },
      // ORL Magic — Cole Anthony and Tyus Jones gone
      { name: "Franz Wagner", team: "ORL", position: "SF", avgMinutes: "35.0", avgFouls: "2.1" },
      { name: "Paolo Banchero", team: "ORL", position: "PF", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Jalen Suggs", team: "ORL", position: "PG", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "Jonathan Isaac", team: "ORL", position: "PF", avgMinutes: "26.0", avgFouls: "2.1" },
      { name: "Wendell Carter Jr.", team: "ORL", position: "C", avgMinutes: "27.0", avgFouls: "2.5" },
      // PHI 76ers — McCain/Gordon gone; core remains
      { name: "Joel Embiid", team: "PHI", position: "C", avgMinutes: "33.5", avgFouls: "2.9" },
      { name: "Tyrese Maxey", team: "PHI", position: "PG", avgMinutes: "36.0", avgFouls: "1.8" },
      { name: "Paul George", team: "PHI", position: "SF", avgMinutes: "34.0", avgFouls: "2.7" },
      { name: "Kelly Oubre Jr.", team: "PHI", position: "SF", avgMinutes: "27.0", avgFouls: "2.1" },
      { name: "KJ Martin", team: "PHI", position: "PF", avgMinutes: "22.5", avgFouls: "2.0" },
      { name: "Andre Drummond", team: "PHI", position: "C", avgMinutes: "21.0", avgFouls: "2.7" },
      // PHX Suns — Cole Anthony + Amir Coffey added; Eric Gordon gone
      { name: "Devin Booker", team: "PHX", position: "SG", avgMinutes: "36.5", avgFouls: "2.3" },
      { name: "Kevin Durant", team: "PHX", position: "PF", avgMinutes: "36.5", avgFouls: "2.1" },
      { name: "Bradley Beal", team: "PHX", position: "SG", avgMinutes: "30.5", avgFouls: "1.8" },
      { name: "Grayson Allen", team: "PHX", position: "SG", avgMinutes: "32.0", avgFouls: "2.0" },
      { name: "Jusuf Nurkic", team: "PHX", position: "C", avgMinutes: "26.0", avgFouls: "2.7" },
      { name: "Cole Anthony", team: "PHX", position: "PG", avgMinutes: "21.0", avgFouls: "1.9" },
      { name: "Amir Coffey", team: "PHX", position: "SF", avgMinutes: "20.0", avgFouls: "1.6" },
      // POR Trail Blazers — Simons gone; Jrue Holiday added; Krejci gone (to ATL)
      { name: "Scoot Henderson", team: "POR", position: "PG", avgMinutes: "30.0", avgFouls: "2.5" },
      { name: "Shaedon Sharpe", team: "POR", position: "SG", avgMinutes: "27.5", avgFouls: "1.8" },
      { name: "Jerami Grant", team: "POR", position: "PF", avgMinutes: "31.0", avgFouls: "2.1" },
      { name: "Toumani Camara", team: "POR", position: "SF", avgMinutes: "23.0", avgFouls: "2.0" },
      { name: "Deandre Ayton", team: "POR", position: "C", avgMinutes: "28.0", avgFouls: "2.3" },
      { name: "Jrue Holiday", team: "POR", position: "PG", avgMinutes: "31.5", avgFouls: "2.5" },
      // SAC Kings — De'Andre Hunter added; Huerter/Ellis/Schroder gone
      { name: "Keegan Murray", team: "SAC", position: "SF", avgMinutes: "32.0", avgFouls: "1.6" },
      { name: "Malik Monk", team: "SAC", position: "SG", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Harrison Barnes", team: "SAC", position: "SF", avgMinutes: "27.0", avgFouls: "1.7" },
      { name: "Davion Mitchell", team: "SAC", position: "PG", avgMinutes: "24.0", avgFouls: "1.6" },
      { name: "Trey Lyles", team: "SAC", position: "C", avgMinutes: "24.0", avgFouls: "2.4" },
      { name: "De'Andre Hunter", team: "SAC", position: "SF", avgMinutes: "30.5", avgFouls: "1.9" },
      // SAS Spurs — Wemby + Fox elite duo; no significant deadline moves
      { name: "Victor Wembanyama", team: "SAS", position: "C", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "De'Aaron Fox", team: "SAS", position: "PG", avgMinutes: "35.5", avgFouls: "2.5" },
      { name: "Devin Vassell", team: "SAS", position: "SG", avgMinutes: "29.5", avgFouls: "1.9" },
      { name: "Jeremy Sochan", team: "SAS", position: "PF", avgMinutes: "28.5", avgFouls: "2.2" },
      { name: "Stephon Castle", team: "SAS", position: "PG", avgMinutes: "26.0", avgFouls: "1.8" },
      { name: "Keldon Johnson", team: "SAS", position: "SF", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Julian Champagnie", team: "SAS", position: "SF", avgMinutes: "22.0", avgFouls: "1.6" },
      // TOR Raptors — Agbaji gone to BKN; Trayce Jackson-Davis added; Chris Paul (buyout)
      { name: "Scottie Barnes", team: "TOR", position: "PF", avgMinutes: "35.0", avgFouls: "2.3" },
      { name: "RJ Barrett", team: "TOR", position: "SF", avgMinutes: "34.5", avgFouls: "2.0" },
      { name: "Immanuel Quickley", team: "TOR", position: "PG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Jakob Poeltl", team: "TOR", position: "C", avgMinutes: "30.5", avgFouls: "2.6" },
      { name: "Gradey Dick", team: "TOR", position: "SG", avgMinutes: "26.0", avgFouls: "1.6" },
      { name: "Trayce Jackson-Davis", team: "TOR", position: "C", avgMinutes: "22.0", avgFouls: "2.1" },
      // UTA Jazz — massive deadline haul: JJJ + Lonzo Ball added; Sexton/Konchar/etc. gone
      { name: "Lauri Markkanen", team: "UTA", position: "PF", avgMinutes: "33.5", avgFouls: "1.8" },
      { name: "Walker Kessler", team: "UTA", position: "C", avgMinutes: "29.0", avgFouls: "2.4" },
      { name: "Keyonte George", team: "UTA", position: "PG", avgMinutes: "30.0", avgFouls: "1.9" },
      { name: "Jordan Clarkson", team: "UTA", position: "SG", avgMinutes: "25.5", avgFouls: "1.8" },
      { name: "John Collins", team: "UTA", position: "PF", avgMinutes: "27.5", avgFouls: "2.2" },
      { name: "Jaren Jackson Jr.", team: "UTA", position: "PF", avgMinutes: "31.0", avgFouls: "3.0" },
      { name: "Lonzo Ball", team: "UTA", position: "PG", avgMinutes: "26.0", avgFouls: "1.6" },
      // WAS Wizards — Trae Young + Anthony Davis here; Davis/Russell/Hardy/Exum added at deadline
      { name: "Trae Young", team: "WAS", position: "PG", avgMinutes: "35.5", avgFouls: "2.0" },
      { name: "Anthony Davis", team: "WAS", position: "C", avgMinutes: "34.5", avgFouls: "2.5" },
      { name: "Alexandre Sarr", team: "WAS", position: "C", avgMinutes: "27.0", avgFouls: "2.5" },
      { name: "Kyshawn George", team: "WAS", position: "SF", avgMinutes: "25.0", avgFouls: "1.8" },
      { name: "Bilal Coulibaly", team: "WAS", position: "SF", avgMinutes: "29.0", avgFouls: "2.1" },
      { name: "D'Angelo Russell", team: "WAS", position: "PG", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Jaden Hardy", team: "WAS", position: "SG", avgMinutes: "20.0", avgFouls: "1.5" },
      { name: "Dante Exum", team: "WAS", position: "PG", avgMinutes: "18.0", avgFouls: "1.6" },
      { name: "Jordan Poole", team: "WAS", position: "SG", avgMinutes: "32.0", avgFouls: "2.0" },
      { name: "Kyle Kuzma", team: "WAS", position: "PF", avgMinutes: "29.5", avgFouls: "1.8" },
    ];

    for (const p of playersToSeed) {
      await storage.createPlayer(p);
    }

    // ── 2025-26 DEFENSIVE RATINGS by team & position ─────────────────────────
    // Scale: 0.88 (elite) to 1.12 (poor). 1.00 = league average.
    // Updated post-Feb 5, 2026 deadline to reflect new team compositions.
    const teamDefenseSeeds: Record<string, Record<string, number>> = {
      ATL: { PG: 1.05, SG: 1.04, SF: 1.03, PF: 1.03, C: 1.02 }, // Kuminga/Daniels add athleticism but still weak
      BKN: { PG: 1.08, SG: 1.07, SF: 1.06, PF: 1.05, C: 1.04 }, // rebuilding, poor D
      BOS: { PG: 0.90, SG: 0.89, SF: 0.90, PF: 0.89, C: 0.90 }, // Tatum out hurts D, Vucevic replaces Porzingis
      CHA: { PG: 1.05, SG: 1.05, SF: 1.04, PF: 1.04, C: 1.04 }, // influx of new players, still weak
      CHI: { PG: 1.03, SG: 1.03, SF: 1.03, PF: 1.02, C: 1.01 }, // rebuilding but young/athletic
      CLE: { PG: 0.93, SG: 0.92, SF: 0.92, PF: 0.90, C: 0.89 }, // Harden hurts PG D; Mobley/Allen elite
      DAL: { PG: 0.98, SG: 0.97, SF: 0.97, PF: 0.97, C: 0.96 }, // lost Davis anchor; still solid Kyrie/Klay
      DEN: { PG: 1.01, SG: 1.01, SF: 1.00, PF: 0.99, C: 0.98 }, // Jokic-anchored, average
      DET: { PG: 1.04, SG: 1.03, SF: 1.04, PF: 1.03, C: 1.02 }, // young core, still improving
      GSW: { PG: 0.96, SG: 0.95, SF: 0.95, PF: 0.96, C: 0.95 }, // Draymond + Porzingis rim protection; Butler out
      HOU: { PG: 0.97, SG: 0.97, SF: 0.97, PF: 0.98, C: 0.96 }, // Brooks/Amen defensive
      IND: { PG: 1.04, SG: 1.03, SF: 1.03, PF: 1.04, C: 1.00 }, // Zubac major upgrade at C
      LAC: { PG: 0.98, SG: 0.97, SF: 0.96, PF: 0.97, C: 1.00 }, // lost Zubac interior; Kawhi/Powell solid
      LAL: { PG: 0.98, SG: 0.98, SF: 0.97, PF: 0.96, C: 0.97 }, // LeBron/Luka; AD gone hurts interior
      MEM: { PG: 1.02, SG: 1.01, SF: 1.01, PF: 1.02, C: 1.00 }, // lost JJJ (DPOY); influx of new parts
      MIA: { PG: 0.95, SG: 0.94, SF: 0.95, PF: 0.96, C: 0.95 }, // Spoelstra defensive system
      MIL: { PG: 0.94, SG: 0.94, SF: 0.95, PF: 0.93, C: 0.92 }, // Giannis + Sabonis elite D
      MIN: { PG: 0.89, SG: 0.89, SF: 0.90, PF: 0.89, C: 0.88 }, // Gobert/Edwards, best D in NBA
      NOP: { PG: 1.02, SG: 1.01, SF: 1.01, PF: 1.00, C: 1.01 }, // Flagg developing; Murray defensive
      NYK: { PG: 0.94, SG: 0.93, SF: 0.93, PF: 0.94, C: 0.92 }, // OG/Bridges/Hart elite D
      OKC: { PG: 0.90, SG: 0.89, SF: 0.90, PF: 0.91, C: 0.89 }, // Holmgren/Hartenstein; top D in league
      ORL: { PG: 0.93, SG: 0.92, SF: 0.92, PF: 0.93, C: 0.90 }, // Isaac/Suggs elite D
      PHI: { PG: 1.00, SG: 0.99, SF: 1.00, PF: 1.01, C: 0.98 }, // Embiid interior D
      PHX: { PG: 1.05, SG: 1.04, SF: 1.04, PF: 1.05, C: 1.04 }, // poor defensive team
      POR: { PG: 1.07, SG: 1.07, SF: 1.06, PF: 1.07, C: 1.05 }, // rebuilding, weak D
      SAC: { PG: 1.05, SG: 1.05, SF: 1.04, PF: 1.05, C: 1.03 }, // Hunter adds wing D; still below avg
      SAS: { PG: 1.02, SG: 1.02, SF: 1.03, PF: 1.03, C: 0.97 }, // Wemby elite C D; Fox improves guards
      TOR: { PG: 1.03, SG: 1.02, SF: 1.02, PF: 1.02, C: 1.01 }, // Barnes defensive anchor
      UTA: { PG: 1.04, SG: 1.04, SF: 1.03, PF: 0.97, C: 0.95 }, // JJJ transforms PF/C defense; elite rim protection
      WAS: { PG: 1.04, SG: 1.05, SF: 1.05, PF: 0.95, C: 0.92 }, // Anthony Davis elite C D; Young/Poole hurt PG/SG D
    };

    const positions = ["PG", "SG", "SF", "PF", "C"];
    for (const [team, posMap] of Object.entries(teamDefenseSeeds)) {
      for (const pos of positions) {
        await storage.createTeamDefense({
          teamName: team,
          position: pos,
          defRating: (posMap[pos] ?? 1.0).toFixed(2),
        });
      }
    }
  }
}
