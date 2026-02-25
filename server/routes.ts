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
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(500).json({ message: "Internal server error", details: (err as any).message });
    }
  });

  // Call seed database function
  await seedDatabase();

  return httpServer;
}

async function seedDatabase() {
  const existingPlayers = await storage.getPlayers();
  if (existingPlayers.length === 0) {
    // Seed Players
    const playersToSeed = [
      { name: "LeBron James", team: "LAL", position: "SF", avgMinutes: "35.3", avgFouls: "2.1" },
      { name: "Stephen Curry", team: "GSW", position: "PG", avgMinutes: "32.7", avgFouls: "1.6" },
      { name: "Nikola Jokic", team: "DEN", position: "C", avgMinutes: "34.6", avgFouls: "2.4" },
      { name: "Giannis Antetokounmpo", team: "MIL", position: "PF", avgMinutes: "35.2", avgFouls: "2.9" },
      { name: "Luka Doncic", team: "DAL", position: "PG", avgMinutes: "37.5", avgFouls: "2.2" },
      { name: "Shai Gilgeous-Alexander", team: "OKC", position: "PG", avgMinutes: "34.0", avgFouls: "2.5" },
      { name: "Jayson Tatum", team: "BOS", position: "SF", avgMinutes: "35.7", avgFouls: "2.0" },
      { name: "Kevin Durant", team: "PHX", position: "PF", avgMinutes: "37.2", avgFouls: "2.2" },
      { name: "Joel Embiid", team: "PHI", position: "C", avgMinutes: "34.0", avgFouls: "2.9" },
      { name: "Anthony Edwards", team: "MIN", position: "SG", avgMinutes: "35.1", avgFouls: "1.8" },
      { name: "Devin Booker", team: "PHX", position: "SG", avgMinutes: "36.0", avgFouls: "2.3" },
      { name: "Tyrese Haliburton", team: "IND", position: "PG", avgMinutes: "32.2", avgFouls: "1.1" },
      { name: "Domantas Sabonis", team: "SAC", position: "C", avgMinutes: "35.7", avgFouls: "3.3" },
      { name: "De'Aaron Fox", team: "SAC", position: "PG", avgMinutes: "35.9", avgFouls: "2.6" },
      { name: "Jalen Brunson", team: "NYK", position: "PG", avgMinutes: "35.4", avgFouls: "1.9" },
      { name: "Bam Adebayo", team: "MIA", position: "C", avgMinutes: "34.0", avgFouls: "2.3" },
      { name: "Donovan Mitchell", team: "CLE", position: "SG", avgMinutes: "35.3", avgFouls: "2.1" },
      { name: "Kawhi Leonard", team: "LAC", position: "SF", avgMinutes: "34.3", avgFouls: "1.6" },
      { name: "Paul George", team: "PHI", position: "SF", avgMinutes: "33.8", avgFouls: "2.7" },
      { name: "Ja Morant", team: "MEM", position: "PG", avgMinutes: "32.5", avgFouls: "1.9" },
      { name: "Victor Wembanyama", team: "SAS", position: "C", avgMinutes: "29.7", avgFouls: "2.2" },
      { name: "Chet Holmgren", team: "OKC", position: "C", avgMinutes: "29.4", avgFouls: "2.4" },
      { name: "Kyrie Irving", team: "DAL", position: "SG", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Jimmy Butler", team: "MIA", position: "SF", avgMinutes: "34.0", avgFouls: "1.1" },
      { name: "Damian Lillard", team: "MIL", position: "PG", avgMinutes: "35.3", avgFouls: "1.9" },
      { name: "Trae Young", team: "ATL", position: "PG", avgMinutes: "36.0", avgFouls: "2.0" },
      { name: "Paolo Banchero", team: "ORL", position: "PF", avgMinutes: "35.0", avgFouls: "1.9" },
      { name: "Lauri Markkanen", team: "UTA", position: "PF", avgMinutes: "33.1", avgFouls: "1.8" },
      { name: "Julius Randle", team: "MIN", position: "PF", avgMinutes: "35.4", avgFouls: "2.7" },
      { name: "Zion Williamson", team: "NOP", position: "PF", avgMinutes: "31.5", avgFouls: "2.3" },
      // Role Players
      { name: "Austin Reaves", team: "LAL", position: "SG", avgMinutes: "32.1", avgFouls: "1.7" },
      { name: "Malik Monk", team: "SAC", position: "SG", avgMinutes: "26.0", avgFouls: "2.1" },
      { name: "Naz Reid", team: "MIN", position: "C", avgMinutes: "24.2", avgFouls: "2.5" },
      { name: "Bobby Portis", team: "MIL", position: "PF", avgMinutes: "24.5", avgFouls: "2.3" },
      { name: "Derrick White", team: "BOS", position: "SG", avgMinutes: "32.6", avgFouls: "2.2" },
      { name: "Alex Caruso", team: "OKC", position: "SG", avgMinutes: "28.7", avgFouls: "2.4" },
      { name: "Josh Hart", team: "NYK", position: "SF", avgMinutes: "33.4", avgFouls: "2.3" },
      { name: "Immanuel Quickley", team: "TOR", position: "PG", avgMinutes: "31.2", avgFouls: "1.9" },
      { name: "Norman Powell", team: "LAC", position: "SG", avgMinutes: "26.2", avgFouls: "1.8" },
      { name: "Grayson Allen", team: "PHX", position: "SG", avgMinutes: "33.5", avgFouls: "2.1" },
      { name: "Bogdan Bogdanovic", team: "ATL", position: "SG", avgMinutes: "30.4", avgFouls: "2.3" },
      { name: "Herbert Jones", team: "NOP", position: "SF", avgMinutes: "30.5", avgFouls: "2.8" },
      { name: "Coby White", team: "CHI", position: "PG", avgMinutes: "36.5", avgFouls: "2.2" },
      { name: "Donte DiVincenzo", team: "MIN", position: "SG", avgMinutes: "29.1", avgFouls: "2.1" },
      { name: "Al Horford", team: "BOS", position: "C", avgMinutes: "26.8", avgFouls: "1.5" },
    ];

    for (const p of playersToSeed) {
      await storage.createPlayer(p);
    }

    // Seed Team Defense
    const teams = [
      "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW",
      "HOU", "IND", "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NOP", "NYK",
      "OKC", "ORL", "PHI", "PHX", "POR", "SAC", "SAS", "TOR", "UTA", "WAS"
    ];
    const positions = ["PG", "SG", "SF", "PF", "C"];
    
    for (const team of teams) {
      for (const pos of positions) {
        // More realistic multipliers: 
        // 0.90 to 0.95 (elite defense), 1.0 (average), 1.05 to 1.10 (poor defense)
        const rating = 0.9 + Math.random() * 0.2;
        await storage.createTeamDefense({
          teamName: team,
          position: pos,
          defRating: rating.toFixed(2),
        });
      }
    }
  }
}
