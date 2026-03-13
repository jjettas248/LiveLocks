// ── MLB Live Game Registry ────────────────────────────────────────────────────
// In-memory store of currently active games for the orchestrator.

import type { MLBGame } from "./gameDiscoveryService";

const activeGames = new Map<string, MLBGame>();

export function registerGame(game: MLBGame): void {
  if (!activeGames.has(game.gameId)) {
    console.log(`[MLB registry] Registered game ${game.gameId}: ${game.awayTeam} @ ${game.homeTeam}`);
  }
  activeGames.set(game.gameId, game);
}

export function removeGame(gameId: string): void {
  if (activeGames.delete(gameId)) {
    console.log(`[MLB registry] Removed game ${gameId}`);
  }
}

export function getActiveGames(): MLBGame[] {
  return Array.from(activeGames.values());
}

export function getGame(gameId: string): MLBGame | undefined {
  return activeGames.get(gameId);
}

export function clearRegistry(): void {
  activeGames.clear();
  console.log("[MLB registry] Cleared all active games");
}
