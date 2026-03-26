// ── MLB Live Game Registry ────────────────────────────────────────────────────
// In-memory store of currently active games for the orchestrator.

import type { MLBGame } from "./gameDiscoveryService";

const activeGames = new Map<string, MLBGame>();

export function registerGame(game: MLBGame): void {
  const existing = activeGames.get(game.gameId);
  if (!existing) {
    console.log(`[MLB registry] Registered game ${game.gameId}: ${game.awayTeam} @ ${game.homeTeam}${game.gamePk ? ` (gamePk=${game.gamePk})` : " (gamePk=PENDING)"}`);
  } else if (!existing.gamePk && game.gamePk) {
    console.log(`[MLB registry] gamePk resolved for game ${game.gameId}: ${game.awayTeam} @ ${game.homeTeam} → gamePk=${game.gamePk}`);
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
