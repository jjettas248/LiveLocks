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
    await storage.createPlayer({
      name: "LeBron James",
      team: "LAL",
      position: "SF",
      avgMinutes: "35.5",
      avgFouls: "1.8",
    });
    await storage.createPlayer({
      name: "Stephen Curry",
      team: "GSW",
      position: "PG",
      avgMinutes: "33.2",
      avgFouls: "2.1",
    });
    await storage.createPlayer({
      name: "Nikola Jokic",
      team: "DEN",
      position: "C",
      avgMinutes: "34.0",
      avgFouls: "2.5",
    });
    await storage.createPlayer({
      name: "Giannis Antetokounmpo",
      team: "MIL",
      position: "PF",
      avgMinutes: "35.0",
      avgFouls: "3.0",
    });

    // Seed Team Defense
    // Defense against positions
    const teams = ["LAL", "GSW", "DEN", "MIL", "BOS", "PHX"];
    const positions = ["PG", "SG", "SF", "PF", "C"];
    
    for (const team of teams) {
      for (const pos of positions) {
        // Randomize defense rating between 0.85 (good) and 1.15 (bad)
        const rating = 0.85 + Math.random() * 0.3;
        await storage.createTeamDefense({
          teamName: team,
          position: pos,
          defRating: rating.toFixed(2),
        });
      }
    }
  }
}
