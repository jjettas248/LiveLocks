// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — durable outcome source (PR 2).
//
// The one file in the labeler pipeline with real I/O. Combines two
// independently-durable sources, never the in-memory mlbGameCache
// (server/mlb/dataPullService.ts): AB/HR facts from game_player_stats
// (Postgres, already durable) and game finality from a fresh, injectable MLB
// Stats API status fetch keyed by gamePk — mirroring the exact endpoint,
// headers, and field path server/services/gradePersistedPlays.ts's
// fetchMlbBoxScore already uses successfully in this codebase
// (`gameData.status.{abstractGameState,codedGameState}` off
// `.../api/v1.1/game/${gamePk}/feed/live`). mlbGameCache is in-memory, empty
// on every restart, and doesn't exist in a standalone script process —
// structurally incompatible with "reconciliation may run long after the
// game ends."
//
// HONESTY FLAG: only the "Final" case (`abstractGameState.toLowerCase() ===
// "final" || codedGameState === "F"`) is confirmed against a real,
// already-working caller in this codebase. The postponed/suspended mapping
// below is a defensive best-effort substring match against `detailedState`
// (mirroring buildPregamePowerRadar.ts's own mapGameStatus substring-match
// resilience for a *different* status vocabulary — ESPN, not MLB Stats API)
// — this sandbox has no network access to statsapi.mlb.com to verify it
// live (confirmed: outbound proxy policy-denies that host here). Any
// unrecognized shape degrades to "unknown", never a guessed final state.
// Verify against one real response early in a deployment that can reach it.
// ─────────────────────────────────────────────────────────────────────────────

import type { PlayerAbResult } from "../winAttribution";
import { locateHrInPlayerABs } from "../winAttribution";

export type PlateHrV2GameStatusFact = "final" | "postponed" | "suspended" | "in_progress" | "unknown";

export interface PlateHrV2GameOutcomeFact {
  gameStatus: PlateHrV2GameStatusFact;
  gamePk: string | null;
}

export interface PlateHrV2BatterOutcomeFact {
  hasBoxScoreRow: boolean;
  ab: number;
  bb: number;
  /** ab + bb — same approximation scripts/backtestPresenceFloor.ts already uses; undercounts HBP/SF/SH (no dedicated column). */
  paCountObserved: number;
  hrCountToday: number;
  firstHr: { inning: number | null; half: "top" | "bottom" | null; plateAppearanceNumber: number; firstAb: boolean } | null;
}

export interface PlateHrV2GameOutcomeBundle {
  game: PlateHrV2GameOutcomeFact;
  batters: Map<string, PlateHrV2BatterOutcomeFact>;
  anyBoxScoreRowsForGame: boolean;
}

interface MlbScheduleStatusRaw {
  abstractGameState?: string;
  detailedState?: string;
  codedGameState?: string;
}

/** Pure. Never guesses a terminal state from an unrecognized shape — degrades to "unknown". */
export function mapMlbScheduleStatus(raw: MlbScheduleStatusRaw | null | undefined): PlateHrV2GameStatusFact {
  if (!raw) return "unknown";
  const abstractState = (raw.abstractGameState ?? "").toLowerCase();
  const codedState = raw.codedGameState ?? "";
  const detailedState = (raw.detailedState ?? "").toLowerCase();

  if (abstractState === "final" || codedState === "F") return "final";
  if (detailedState.includes("postponed")) return "postponed";
  if (detailedState.includes("suspended")) return "suspended";
  if (abstractState === "live" || abstractState === "in progress" || detailedState.includes("in progress")) return "in_progress";
  // "preview" (not yet started) is architecturally unexpected input for a
  // labeler — reconciliation should never run this soon — but if it ever
  // does, "unknown" is the honest reading (we have no positive evidence the
  // game is over or in progress), not a guessed in_progress state. The
  // reconciler skips both "unknown" and "in_progress" identically either way.
  return "unknown";
}

/** Pure. Reduces raw game_player_stats rows into per-batter outcome facts, keyed by playerId. Never throws on malformed abResults JSON. */
export function reduceBatterOutcomeFacts(
  rows: Array<{ playerId: string; ab: number | null; bb: number | null; abResults: string | null }>,
): Map<string, PlateHrV2BatterOutcomeFact> {
  const out = new Map<string, PlateHrV2BatterOutcomeFact>();
  for (const row of rows) {
    let abs: PlayerAbResult[] = [];
    if (row.abResults) {
      try {
        const parsed = JSON.parse(row.abResults);
        if (Array.isArray(parsed)) abs = parsed as PlayerAbResult[];
      } catch {
        abs = []; // malformed JSON degrades to "no AB detail," never thrown
      }
    }
    const ab = row.ab ?? 0;
    const bb = row.bb ?? 0;
    const hrCountToday = abs.filter((a) => a?.hitType === "home_run").length;
    out.set(row.playerId, {
      hasBoxScoreRow: true,
      ab,
      bb,
      paCountObserved: ab + bb,
      hrCountToday,
      firstHr: locateHrInPlayerABs(abs),
    });
  }
  return out;
}

/** Thin I/O, injectable for tests. Mirrors gradePersistedPlays.ts's fetchMlbBoxScore call shape exactly. */
export async function fetchMlbGameStatus(gamePk: string, fetchImpl: typeof fetch = fetch): Promise<PlateHrV2GameStatusFact> {
  try {
    const res = await fetchImpl(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`, {
      headers: { "User-Agent": "LiveLocks/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "unknown";
    const data = (await res.json()) as { gameData?: { status?: MlbScheduleStatusRaw } };
    return mapMlbScheduleStatus(data.gameData?.status);
  } catch {
    return "unknown"; // network/parse failure degrades honestly — never fabricates a status
  }
}

/**
 * Orchestrator: resolves one game's outcome bundle from durable Postgres rows
 * + a single memoized status fetch (one call per gamePk, shared across every
 * batter in that game, even across many batters/games in the same
 * reconciliation run — deps.getGamePlayerStats is per-game, so memoization
 * is naturally free here; callers that batch multiple games should call this
 * once per distinct gameId).
 */
export async function resolvePlateHrV2GameOutcome(
  gameId: string,
  deps: {
    getGamePlayerStats: (gameId: string) => Promise<Array<{ playerId: string; gamePk: string | null; ab: number | null; bb: number | null; abResults: string | null }>>;
    fetchGameStatus?: typeof fetchMlbGameStatus;
  },
): Promise<PlateHrV2GameOutcomeBundle> {
  const rows = await deps.getGamePlayerStats(gameId);
  const batters = reduceBatterOutcomeFacts(rows);
  const anyBoxScoreRowsForGame = rows.length > 0;
  const gamePk = rows.find((r) => r.gamePk != null)?.gamePk ?? null;

  const fetchStatus = deps.fetchGameStatus ?? fetchMlbGameStatus;
  const gameStatus = gamePk ? await fetchStatus(gamePk) : "unknown";

  return {
    game: { gameStatus, gamePk },
    batters,
    anyBoxScoreRowsForGame,
  };
}
