import { todayET } from "./dateUtils";

const sessionDateByGameId = new Map<string, string>();

export function setMlbGameSessionDate(gameId: string, sessionDate: string | null | undefined): void {
  if (!gameId || !sessionDate) return;
  const trimmed = String(sessionDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return;
  const prev = sessionDateByGameId.get(gameId);
  if (prev !== trimmed) {
    sessionDateByGameId.set(gameId, trimmed);
    console.log(`[HR_LEDGER_SESSION_DATE_SET] gameId=${gameId} sessionDate=${trimmed} prev=${prev ?? "n/a"}`);
  }
}

export function resolveMlbGameSessionDate(gameId: string | null | undefined): string {
  if (gameId) {
    const cached = sessionDateByGameId.get(gameId);
    if (cached) return cached;
  }
  const fallback = todayET();
  if (gameId) {
    console.log(`[HR_LEDGER_SESSION_DATE_FALLBACK] gameId=${gameId} sessionDate=${fallback} reason=no canonical officialDate cached`);
  }
  return fallback;
}

export function getCachedMlbGameSessionDate(gameId: string): string | undefined {
  return sessionDateByGameId.get(gameId);
}

export function clearMlbGameSessionDate(gameId: string): void {
  sessionDateByGameId.delete(gameId);
}
