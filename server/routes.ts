import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

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

  await seedDatabase();
  return httpServer;
}

async function seedDatabase() {
  const existingPlayers = await storage.getPlayers();
  if (existingPlayers.length === 0) {
    // ── 2025-26 NBA ROSTERS ──────────────────────────────────────────────────
    // Key offseason moves reflected:
    //  • Luka Doncic traded to LAL; Anthony Davis traded to DAL
    //  • De'Aaron Fox traded to SAS
    //  • Jimmy Butler traded to GSW
    //  • Domantas Sabonis traded to MIL
    //  • Cooper Flagg (2025 #1 pick) to WAS
    //  • Various FA signings & role changes across rosters
    const playersToSeed = [
      // ATL Hawks — core intact, DJ Carton/young additions
      { name: "AJ Griffin", team: "ATL", position: "SF", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Bogdan Bogdanovic", team: "ATL", position: "SG", avgMinutes: "28.0", avgFouls: "2.2" },
      { name: "Clint Capela", team: "ATL", position: "C", avgMinutes: "26.0", avgFouls: "2.6" },
      { name: "De'Andre Hunter", team: "ATL", position: "SF", avgMinutes: "30.5", avgFouls: "1.9" },
      { name: "Dyson Daniels", team: "ATL", position: "SG", avgMinutes: "33.5", avgFouls: "2.0" },
      { name: "Garrison Mathews", team: "ATL", position: "SG", avgMinutes: "17.0", avgFouls: "1.1" },
      { name: "Jalen Johnson", team: "ATL", position: "PF", avgMinutes: "34.5", avgFouls: "2.1" },
      { name: "Larry Nance Jr.", team: "ATL", position: "PF", avgMinutes: "20.0", avgFouls: "2.1" },
      { name: "Trae Young", team: "ATL", position: "PG", avgMinutes: "35.5", avgFouls: "2.0" },
      // BKN Nets
      { name: "Ben Simmons", team: "BKN", position: "PG", avgMinutes: "22.0", avgFouls: "1.9" },
      { name: "Cam Thomas", team: "BKN", position: "SG", avgMinutes: "33.5", avgFouls: "1.9" },
      { name: "Cameron Johnson", team: "BKN", position: "SF", avgMinutes: "31.0", avgFouls: "1.6" },
      { name: "Dennis Schroder", team: "BKN", position: "PG", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Nic Claxton", team: "BKN", position: "C", avgMinutes: "27.0", avgFouls: "3.0" },
      { name: "Ziaire Williams", team: "BKN", position: "SF", avgMinutes: "24.0", avgFouls: "1.7" },
      // BOS Celtics — back-to-back contenders, core intact
      { name: "Al Horford", team: "BOS", position: "C", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Derrick White", team: "BOS", position: "SG", avgMinutes: "33.0", avgFouls: "2.2" },
      { name: "Jaylen Brown", team: "BOS", position: "SG", avgMinutes: "35.5", avgFouls: "2.4" },
      { name: "Jayson Tatum", team: "BOS", position: "SF", avgMinutes: "36.0", avgFouls: "2.0" },
      { name: "Jrue Holiday", team: "BOS", position: "PG", avgMinutes: "31.5", avgFouls: "2.5" },
      { name: "Kristaps Porzingis", team: "BOS", position: "C", avgMinutes: "27.0", avgFouls: "2.7" },
      { name: "Payton Pritchard", team: "BOS", position: "PG", avgMinutes: "27.0", avgFouls: "1.3" },
      { name: "Sam Hauser", team: "BOS", position: "SF", avgMinutes: "25.5", avgFouls: "1.1" },
      // CHA Hornets — LaMelo leading, Brandon Miller growing
      { name: "Brandon Miller", team: "CHA", position: "SF", avgMinutes: "33.0", avgFouls: "2.1" },
      { name: "Grant Williams", team: "CHA", position: "PF", avgMinutes: "22.0", avgFouls: "2.2" },
      { name: "LaMelo Ball", team: "CHA", position: "PG", avgMinutes: "33.5", avgFouls: "2.0" },
      { name: "Mark Williams", team: "CHA", position: "C", avgMinutes: "27.5", avgFouls: "2.7" },
      { name: "Miles Bridges", team: "CHA", position: "SF", avgMinutes: "34.5", avgFouls: "2.2" },
      { name: "Tre Mann", team: "CHA", position: "SG", avgMinutes: "27.0", avgFouls: "1.6" },
      // CHI Bulls
      { name: "Coby White", team: "CHI", position: "PG", avgMinutes: "36.0", avgFouls: "2.2" },
      { name: "Josh Giddey", team: "CHI", position: "PG", avgMinutes: "35.0", avgFouls: "1.8" },
      { name: "Nikola Vucevic", team: "CHI", position: "C", avgMinutes: "31.5", avgFouls: "2.5" },
      { name: "Patrick Williams", team: "CHI", position: "PF", avgMinutes: "29.5", avgFouls: "2.0" },
      { name: "Zach LaVine", team: "CHI", position: "SG", avgMinutes: "33.5", avgFouls: "1.8" },
      // CLE Cavaliers — elite defense, Mobley/Allen anchor
      { name: "Darius Garland", team: "CLE", position: "PG", avgMinutes: "34.0", avgFouls: "1.9" },
      { name: "Donovan Mitchell", team: "CLE", position: "SG", avgMinutes: "35.5", avgFouls: "2.1" },
      { name: "Evan Mobley", team: "CLE", position: "PF", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Jarrett Allen", team: "CLE", position: "C", avgMinutes: "29.0", avgFouls: "2.2" },
      { name: "Max Strus", team: "CLE", position: "SG", avgMinutes: "26.0", avgFouls: "1.4" },
      { name: "Sam Merrill", team: "CLE", position: "SG", avgMinutes: "17.0", avgFouls: "1.0" },
      { name: "Ty Jerome", team: "CLE", position: "PG", avgMinutes: "22.0", avgFouls: "1.2" },
      // DAL Mavericks — Anthony Davis arrives, Kyrie leads
      { name: "Anthony Davis", team: "DAL", position: "C", avgMinutes: "34.5", avgFouls: "2.5" },
      { name: "Daniel Gafford", team: "DAL", position: "C", avgMinutes: "22.0", avgFouls: "2.6" },
      { name: "Dereck Lively II", team: "DAL", position: "C", avgMinutes: "24.0", avgFouls: "2.4" },
      { name: "Klay Thompson", team: "DAL", position: "SG", avgMinutes: "30.0", avgFouls: "1.7" },
      { name: "Kyrie Irving", team: "DAL", position: "SG", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "PJ Washington", team: "DAL", position: "PF", avgMinutes: "29.0", avgFouls: "2.1" },
      { name: "Spencer Dinwiddie", team: "DAL", position: "PG", avgMinutes: "20.0", avgFouls: "1.8" },
      // DEN Nuggets — Jokic-centric, health permitting
      { name: "Aaron Gordon", team: "DEN", position: "PF", avgMinutes: "32.5", avgFouls: "2.3" },
      { name: "Christian Braun", team: "DEN", position: "SG", avgMinutes: "29.0", avgFouls: "1.8" },
      { name: "Jamal Murray", team: "DEN", position: "PG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Julian Strawther", team: "DEN", position: "SG", avgMinutes: "21.0", avgFouls: "1.5" },
      { name: "Michael Porter Jr.", team: "DEN", position: "SF", avgMinutes: "32.5", avgFouls: "1.5" },
      { name: "Nikola Jokic", team: "DEN", position: "C", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Reggie Jackson", team: "DEN", position: "PG", avgMinutes: "18.0", avgFouls: "1.6" },
      // DET Pistons — young core ascending
      { name: "Ausar Thompson", team: "DET", position: "SF", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Cade Cunningham", team: "DET", position: "PG", avgMinutes: "35.0", avgFouls: "2.1" },
      { name: "Isaiah Stewart", team: "DET", position: "C", avgMinutes: "29.0", avgFouls: "2.6" },
      { name: "Jaden Ivey", team: "DET", position: "SG", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Jalen Duren", team: "DET", position: "C", avgMinutes: "28.5", avgFouls: "2.9" },
      { name: "Ron Holland", team: "DET", position: "SF", avgMinutes: "22.0", avgFouls: "1.9" },
      { name: "Tim Hardaway Jr.", team: "DET", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      // GSW Warriors — Curry + Butler, contender
      { name: "Andrew Wiggins", team: "GSW", position: "SF", avgMinutes: "28.5", avgFouls: "1.9" },
      { name: "Brandin Podziemski", team: "GSW", position: "SG", avgMinutes: "29.5", avgFouls: "1.6" },
      { name: "Buddy Hield", team: "GSW", position: "SG", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Draymond Green", team: "GSW", position: "PF", avgMinutes: "26.5", avgFouls: "2.9" },
      { name: "Jimmy Butler", team: "GSW", position: "SF", avgMinutes: "34.5", avgFouls: "1.1" },
      { name: "Jonathan Kuminga", team: "GSW", position: "SF", avgMinutes: "27.0", avgFouls: "2.4" },
      { name: "Stephen Curry", team: "GSW", position: "PG", avgMinutes: "33.0", avgFouls: "1.6" },
      // HOU Rockets — young core breakout
      { name: "Alperen Sengun", team: "HOU", position: "C", avgMinutes: "31.0", avgFouls: "3.0" },
      { name: "Amen Thompson", team: "HOU", position: "SF", avgMinutes: "30.0", avgFouls: "2.2" },
      { name: "Dillon Brooks", team: "HOU", position: "SF", avgMinutes: "29.0", avgFouls: "2.8" },
      { name: "Fred VanVleet", team: "HOU", position: "PG", avgMinutes: "31.0", avgFouls: "1.8" },
      { name: "Jabari Smith Jr.", team: "HOU", position: "PF", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Jalen Green", team: "HOU", position: "SG", avgMinutes: "34.0", avgFouls: "2.1" },
      { name: "Tari Eason", team: "HOU", position: "PF", avgMinutes: "23.0", avgFouls: "2.4" },
      // IND Pacers — fastest team in the NBA
      { name: "Aaron Nesmith", team: "IND", position: "SF", avgMinutes: "28.0", avgFouls: "2.3" },
      { name: "Andrew Nembhard", team: "IND", position: "PG", avgMinutes: "29.0", avgFouls: "1.7" },
      { name: "Bennedict Mathurin", team: "IND", position: "SG", avgMinutes: "30.0", avgFouls: "2.2" },
      { name: "Myles Turner", team: "IND", position: "C", avgMinutes: "31.0", avgFouls: "2.5" },
      { name: "Pascal Siakam", team: "IND", position: "PF", avgMinutes: "36.0", avgFouls: "2.1" },
      { name: "TJ McConnell", team: "IND", position: "PG", avgMinutes: "21.0", avgFouls: "1.5" },
      { name: "Tyrese Haliburton", team: "IND", position: "PG", avgMinutes: "33.0", avgFouls: "1.1" },
      // LAC Clippers — rebuilding around Harden/Leonard
      { name: "Bones Hyland", team: "LAC", position: "PG", avgMinutes: "21.0", avgFouls: "1.8" },
      { name: "Ivica Zubac", team: "LAC", position: "C", avgMinutes: "27.5", avgFouls: "2.8" },
      { name: "James Harden", team: "LAC", position: "PG", avgMinutes: "33.0", avgFouls: "2.1" },
      { name: "Kawhi Leonard", team: "LAC", position: "SF", avgMinutes: "33.0", avgFouls: "1.6" },
      { name: "Norman Powell", team: "LAC", position: "SG", avgMinutes: "27.0", avgFouls: "1.7" },
      { name: "Terance Mann", team: "LAC", position: "SF", avgMinutes: "24.0", avgFouls: "1.9" },
      // LAL Lakers — Luka joins LeBron; mega duo
      { name: "Austin Reaves", team: "LAL", position: "SG", avgMinutes: "33.0", avgFouls: "1.7" },
      { name: "D'Angelo Russell", team: "LAL", position: "PG", avgMinutes: "24.0", avgFouls: "1.8" },
      { name: "Gabe Vincent", team: "LAL", position: "PG", avgMinutes: "18.0", avgFouls: "1.5" },
      { name: "LeBron James", team: "LAL", position: "SF", avgMinutes: "35.0", avgFouls: "2.0" },
      { name: "Luka Doncic", team: "LAL", position: "PG", avgMinutes: "37.0", avgFouls: "2.2" },
      { name: "Rui Hachimura", team: "LAL", position: "PF", avgMinutes: "25.0", avgFouls: "1.7" },
      { name: "Jarred Vanderbilt", team: "LAL", position: "PF", avgMinutes: "22.0", avgFouls: "2.3" },
      // MEM Grizzlies — Ja healthy again
      { name: "Desmond Bane", team: "MEM", position: "SG", avgMinutes: "33.0", avgFouls: "1.8" },
      { name: "Ja Morant", team: "MEM", position: "PG", avgMinutes: "33.5", avgFouls: "1.9" },
      { name: "Jaren Jackson Jr.", team: "MEM", position: "PF", avgMinutes: "31.0", avgFouls: "3.0" },
      { name: "Jaylen Wells", team: "MEM", position: "SG", avgMinutes: "24.0", avgFouls: "1.5" },
      { name: "Santi Aldama", team: "MEM", position: "PF", avgMinutes: "25.0", avgFouls: "1.8" },
      { name: "Scotty Pippen Jr.", team: "MEM", position: "PG", avgMinutes: "21.0", avgFouls: "1.3" },
      { name: "Zach Edey", team: "MEM", position: "C", avgMinutes: "24.0", avgFouls: "2.8" },
      // MIA Heat — retooling post-Butler
      { name: "Bam Adebayo", team: "MIA", position: "C", avgMinutes: "34.5", avgFouls: "2.3" },
      { name: "Haywood Highsmith", team: "MIA", position: "SF", avgMinutes: "25.0", avgFouls: "2.0" },
      { name: "Nikola Jovic", team: "MIA", position: "PF", avgMinutes: "26.0", avgFouls: "1.8" },
      { name: "Terry Rozier", team: "MIA", position: "PG", avgMinutes: "29.0", avgFouls: "1.9" },
      { name: "Tyler Herro", team: "MIA", position: "SG", avgMinutes: "34.5", avgFouls: "2.1" },
      // MIL Bucks — Sabonis adds frontcourt depth
      { name: "Bobby Portis", team: "MIL", position: "PF", avgMinutes: "22.0", avgFouls: "2.2" },
      { name: "Brook Lopez", team: "MIL", position: "C", avgMinutes: "27.0", avgFouls: "2.1" },
      { name: "Damian Lillard", team: "MIL", position: "PG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Domantas Sabonis", team: "MIL", position: "C", avgMinutes: "33.0", avgFouls: "3.1" },
      { name: "Giannis Antetokounmpo", team: "MIL", position: "PF", avgMinutes: "35.5", avgFouls: "2.9" },
      { name: "Khris Middleton", team: "MIL", position: "SF", avgMinutes: "25.0", avgFouls: "1.9" },
      // MIN Timberwolves — contenders, Gobert/Edwards/Randle
      { name: "Anthony Edwards", team: "MIN", position: "SG", avgMinutes: "35.5", avgFouls: "1.8" },
      { name: "Donte DiVincenzo", team: "MIN", position: "SG", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Julius Randle", team: "MIN", position: "PF", avgMinutes: "35.0", avgFouls: "2.6" },
      { name: "Mike Conley", team: "MIN", position: "PG", avgMinutes: "24.0", avgFouls: "1.4" },
      { name: "Naz Reid", team: "MIN", position: "C", avgMinutes: "24.5", avgFouls: "2.4" },
      { name: "Nickeil Alexander-Walker", team: "MIN", position: "SG", avgMinutes: "21.0", avgFouls: "1.7" },
      { name: "Rudy Gobert", team: "MIN", position: "C", avgMinutes: "32.5", avgFouls: "2.5" },
      // NOP Pelicans — Cooper Flagg #1 pick (2025 draft)
      { name: "Brandon Ingram", team: "NOP", position: "SF", avgMinutes: "33.0", avgFouls: "1.8" },
      { name: "CJ McCollum", team: "NOP", position: "SG", avgMinutes: "29.0", avgFouls: "1.5" },
      { name: "Cooper Flagg", team: "NOP", position: "PF", avgMinutes: "30.0", avgFouls: "2.0" },
      { name: "Dejounte Murray", team: "NOP", position: "PG", avgMinutes: "33.5", avgFouls: "2.3" },
      { name: "Herbert Jones", team: "NOP", position: "SF", avgMinutes: "28.0", avgFouls: "2.6" },
      { name: "Jordan Hawkins", team: "NOP", position: "SG", avgMinutes: "23.0", avgFouls: "1.4" },
      { name: "Zion Williamson", team: "NOP", position: "PF", avgMinutes: "31.0", avgFouls: "2.2" },
      // NYK Knicks — KAT/OG/Brunson remain together
      { name: "Jalen Brunson", team: "NYK", position: "PG", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Josh Hart", team: "NYK", position: "SF", avgMinutes: "33.5", avgFouls: "2.3" },
      { name: "Karl-Anthony Towns", team: "NYK", position: "C", avgMinutes: "35.0", avgFouls: "2.8" },
      { name: "Miles McBride", team: "NYK", position: "PG", avgMinutes: "23.0", avgFouls: "1.6" },
      { name: "Mikal Bridges", team: "NYK", position: "SG", avgMinutes: "35.5", avgFouls: "1.4" },
      { name: "OG Anunoby", team: "NYK", position: "SF", avgMinutes: "33.5", avgFouls: "2.1" },
      // OKC Thunder — reigning contenders
      { name: "Aaron Wiggins", team: "OKC", position: "SG", avgMinutes: "20.0", avgFouls: "1.5" },
      { name: "Alex Caruso", team: "OKC", position: "SG", avgMinutes: "29.0", avgFouls: "2.3" },
      { name: "Chet Holmgren", team: "OKC", position: "C", avgMinutes: "30.0", avgFouls: "2.3" },
      { name: "Isaiah Hartenstein", team: "OKC", position: "C", avgMinutes: "26.5", avgFouls: "2.7" },
      { name: "Jalen Williams", team: "OKC", position: "SG", avgMinutes: "34.0", avgFouls: "2.0" },
      { name: "Luguentz Dort", team: "OKC", position: "SG", avgMinutes: "29.5", avgFouls: "2.3" },
      { name: "Shai Gilgeous-Alexander", team: "OKC", position: "PG", avgMinutes: "34.5", avgFouls: "2.5" },
      // ORL Magic — Franz/Banchero leading
      { name: "Cole Anthony", team: "ORL", position: "PG", avgMinutes: "21.0", avgFouls: "1.9" },
      { name: "Franz Wagner", team: "ORL", position: "SF", avgMinutes: "35.0", avgFouls: "2.1" },
      { name: "Jalen Suggs", team: "ORL", position: "PG", avgMinutes: "31.0", avgFouls: "2.2" },
      { name: "Jonathan Isaac", team: "ORL", position: "PF", avgMinutes: "26.0", avgFouls: "2.1" },
      { name: "Paolo Banchero", team: "ORL", position: "PF", avgMinutes: "35.5", avgFouls: "1.9" },
      { name: "Wendell Carter Jr.", team: "ORL", position: "C", avgMinutes: "27.0", avgFouls: "2.5" },
      // PHI 76ers — Maxey/George carrying load
      { name: "Andre Drummond", team: "PHI", position: "C", avgMinutes: "21.0", avgFouls: "2.7" },
      { name: "Joel Embiid", team: "PHI", position: "C", avgMinutes: "33.5", avgFouls: "2.9" },
      { name: "Kelly Oubre Jr.", team: "PHI", position: "SF", avgMinutes: "27.0", avgFouls: "2.1" },
      { name: "KJ Martin", team: "PHI", position: "PF", avgMinutes: "22.5", avgFouls: "2.0" },
      { name: "Paul George", team: "PHI", position: "SF", avgMinutes: "34.0", avgFouls: "2.7" },
      { name: "Tyrese Maxey", team: "PHI", position: "PG", avgMinutes: "36.0", avgFouls: "1.8" },
      // PHX Suns — Durant/Booker/Beal core
      { name: "Bradley Beal", team: "PHX", position: "SG", avgMinutes: "30.5", avgFouls: "1.8" },
      { name: "Devin Booker", team: "PHX", position: "SG", avgMinutes: "36.5", avgFouls: "2.3" },
      { name: "Eric Gordon", team: "PHX", position: "SG", avgMinutes: "19.0", avgFouls: "1.3" },
      { name: "Grayson Allen", team: "PHX", position: "SG", avgMinutes: "32.0", avgFouls: "2.0" },
      { name: "Jusuf Nurkic", team: "PHX", position: "C", avgMinutes: "26.0", avgFouls: "2.7" },
      { name: "Kevin Durant", team: "PHX", position: "PF", avgMinutes: "36.5", avgFouls: "2.1" },
      // POR Trail Blazers — Scoot + Simons building
      { name: "Anfernee Simons", team: "POR", position: "SG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Deandre Ayton", team: "POR", position: "C", avgMinutes: "28.0", avgFouls: "2.3" },
      { name: "Jerami Grant", team: "POR", position: "PF", avgMinutes: "31.0", avgFouls: "2.1" },
      { name: "Scoot Henderson", team: "POR", position: "PG", avgMinutes: "30.0", avgFouls: "2.5" },
      { name: "Shaedon Sharpe", team: "POR", position: "SG", avgMinutes: "27.5", avgFouls: "1.8" },
      { name: "Toumani Camara", team: "POR", position: "SF", avgMinutes: "23.0", avgFouls: "2.0" },
      // SAC Kings — without Fox; Keegan/Monk/Murray carry
      { name: "Davion Mitchell", team: "SAC", position: "PG", avgMinutes: "24.0", avgFouls: "1.6" },
      { name: "Harrison Barnes", team: "SAC", position: "SF", avgMinutes: "27.0", avgFouls: "1.7" },
      { name: "Keegan Murray", team: "SAC", position: "SF", avgMinutes: "32.0", avgFouls: "1.6" },
      { name: "Kevin Huerter", team: "SAC", position: "SG", avgMinutes: "26.0", avgFouls: "1.5" },
      { name: "Malik Monk", team: "SAC", position: "SG", avgMinutes: "28.0", avgFouls: "2.0" },
      { name: "Trey Lyles", team: "SAC", position: "C", avgMinutes: "24.0", avgFouls: "2.4" },
      // SAS Spurs — Wemby + Fox = elite duo
      { name: "De'Aaron Fox", team: "SAS", position: "PG", avgMinutes: "35.5", avgFouls: "2.5" },
      { name: "Devin Vassell", team: "SAS", position: "SG", avgMinutes: "29.5", avgFouls: "1.9" },
      { name: "Jeremy Sochan", team: "SAS", position: "PF", avgMinutes: "28.5", avgFouls: "2.2" },
      { name: "Julian Champagnie", team: "SAS", position: "SF", avgMinutes: "22.0", avgFouls: "1.6" },
      { name: "Keldon Johnson", team: "SAS", position: "SF", avgMinutes: "25.0", avgFouls: "1.9" },
      { name: "Stephon Castle", team: "SAS", position: "PG", avgMinutes: "26.0", avgFouls: "1.8" },
      { name: "Victor Wembanyama", team: "SAS", position: "C", avgMinutes: "31.0", avgFouls: "2.2" },
      // TOR Raptors — Barnes/Quickley/Barrett growing
      { name: "Gradey Dick", team: "TOR", position: "SG", avgMinutes: "26.0", avgFouls: "1.6" },
      { name: "Immanuel Quickley", team: "TOR", position: "PG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Jakob Poeltl", team: "TOR", position: "C", avgMinutes: "30.5", avgFouls: "2.6" },
      { name: "Ochai Agbaji", team: "TOR", position: "SG", avgMinutes: "22.0", avgFouls: "1.5" },
      { name: "RJ Barrett", team: "TOR", position: "SF", avgMinutes: "34.5", avgFouls: "2.0" },
      { name: "Scottie Barnes", team: "TOR", position: "PF", avgMinutes: "35.0", avgFouls: "2.3" },
      // UTA Jazz — Markkanen/Kessler/Sexton
      { name: "Collin Sexton", team: "UTA", position: "PG", avgMinutes: "29.0", avgFouls: "2.0" },
      { name: "John Collins", team: "UTA", position: "PF", avgMinutes: "27.5", avgFouls: "2.2" },
      { name: "Jordan Clarkson", team: "UTA", position: "SG", avgMinutes: "25.5", avgFouls: "1.8" },
      { name: "Keyonte George", team: "UTA", position: "PG", avgMinutes: "30.0", avgFouls: "1.9" },
      { name: "Lauri Markkanen", team: "UTA", position: "PF", avgMinutes: "33.5", avgFouls: "1.8" },
      { name: "Walker Kessler", team: "UTA", position: "C", avgMinutes: "29.0", avgFouls: "2.4" },
      // WAS Wizards — Cooper Flagg + Poole rebuilding
      { name: "Alexandre Sarr", team: "WAS", position: "C", avgMinutes: "27.0", avgFouls: "2.5" },
      { name: "Bilal Coulibaly", team: "WAS", position: "SF", avgMinutes: "29.0", avgFouls: "2.1" },
      { name: "Jordan Poole", team: "WAS", position: "SG", avgMinutes: "32.0", avgFouls: "2.0" },
      { name: "Kyle Kuzma", team: "WAS", position: "PF", avgMinutes: "29.5", avgFouls: "1.8" },
      { name: "Malcolm Brogdon", team: "WAS", position: "PG", avgMinutes: "24.0", avgFouls: "1.6" },
      { name: "Tyus Jones", team: "WAS", position: "PG", avgMinutes: "22.0", avgFouls: "1.4" },
    ];

    for (const p of playersToSeed) {
      await storage.createPlayer(p);
    }

    // ── 2025-26 DEFENSIVE RATINGS by team & position ─────────────────────────
    // Scale: 0.88 (elite) to 1.12 (poor). 1.00 = league average.
    // Updated to reflect coaching changes, roster overhauls, and 2025-26 pace/identity shifts.
    const teamDefenseSeeds: Record<string, Record<string, number>> = {
      ATL: { PG: 1.07, SG: 1.06, SF: 1.04, PF: 1.03, C: 1.01 },
      BKN: { PG: 1.08, SG: 1.07, SF: 1.06, PF: 1.05, C: 1.04 },
      BOS: { PG: 0.90, SG: 0.89, SF: 0.90, PF: 0.89, C: 0.88 },
      CHA: { PG: 1.06, SG: 1.05, SF: 1.04, PF: 1.04, C: 1.05 },
      CHI: { PG: 1.04, SG: 1.03, SF: 1.03, PF: 1.02, C: 1.01 },
      CLE: { PG: 0.91, SG: 0.91, SF: 0.92, PF: 0.90, C: 0.89 },
      DAL: { PG: 0.96, SG: 0.95, SF: 0.96, PF: 0.95, C: 0.94 }, // Davis raises floor
      DEN: { PG: 1.01, SG: 1.01, SF: 1.00, PF: 0.99, C: 0.98 },
      DET: { PG: 1.04, SG: 1.03, SF: 1.04, PF: 1.04, C: 1.02 }, // improved but still young
      GSW: { PG: 0.95, SG: 0.95, SF: 0.94, PF: 0.96, C: 0.97 }, // Butler + Draymond elite D
      HOU: { PG: 0.97, SG: 0.97, SF: 0.97, PF: 0.98, C: 0.96 },
      IND: { PG: 1.05, SG: 1.04, SF: 1.04, PF: 1.05, C: 1.03 },
      LAC: { PG: 0.97, SG: 0.97, SF: 0.96, PF: 0.97, C: 0.96 },
      LAL: { PG: 0.98, SG: 0.98, SF: 0.97, PF: 0.96, C: 0.97 },
      MEM: { PG: 1.01, SG: 1.00, SF: 1.00, PF: 1.01, C: 0.99 },
      MIA: { PG: 0.95, SG: 0.94, SF: 0.95, PF: 0.96, C: 0.95 }, // still a defensive system
      MIL: { PG: 0.94, SG: 0.94, SF: 0.95, PF: 0.93, C: 0.92 }, // Sabonis + Giannis
      MIN: { PG: 0.89, SG: 0.89, SF: 0.90, PF: 0.89, C: 0.88 }, // Gobert/Randle, top D
      NOP: { PG: 1.02, SG: 1.01, SF: 1.01, PF: 1.00, C: 1.01 }, // Flagg helps long-term
      NYK: { PG: 0.94, SG: 0.93, SF: 0.93, PF: 0.94, C: 0.92 },
      OKC: { PG: 0.90, SG: 0.89, SF: 0.90, PF: 0.91, C: 0.89 }, // best D in league
      ORL: { PG: 0.93, SG: 0.92, SF: 0.92, PF: 0.93, C: 0.90 },
      PHI: { PG: 1.00, SG: 0.99, SF: 1.00, PF: 1.01, C: 0.98 },
      PHX: { PG: 1.05, SG: 1.04, SF: 1.04, PF: 1.05, C: 1.04 },
      POR: { PG: 1.07, SG: 1.07, SF: 1.06, PF: 1.07, C: 1.05 },
      SAC: { PG: 1.06, SG: 1.06, SF: 1.05, PF: 1.06, C: 1.04 }, // worse D without Fox
      SAS: { PG: 1.03, SG: 1.03, SF: 1.03, PF: 1.04, C: 1.02 }, // improving but young
      TOR: { PG: 1.03, SG: 1.02, SF: 1.02, PF: 1.02, C: 1.01 },
      UTA: { PG: 1.06, SG: 1.05, SF: 1.05, PF: 1.06, C: 1.04 },
      WAS: { PG: 1.08, SG: 1.08, SF: 1.07, PF: 1.07, C: 1.06 },
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
