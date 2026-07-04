// Pre-Game Power Radar — historical regrade runner (I/O adapter).
//
// Extracted from server/scripts/regradePregameRadarHistory.ts so the same
// logic is reachable both from the CLI script and from the admin-triggered
// HTTP route — the route is what actually runs this in production, since
// this repo's dev sandbox has no network path to the live DB or the MLB
// Stats API. See that script's header comment for the full bug history this
// recovers from.

import { storage } from "../../storage";
import { syncGameBoxScore } from "../dataPullService";
import { resolveOutcome } from "./shadowOutcomes";
import { rowToSignal, signalToRow } from "./pregamePersistence";
import { fetchMlbGamePkMap, normalizeAbbr, type MlbScheduleEntry } from "../gameDiscoveryService";
import type { PregamePowerRadarSignalRow } from "@shared/schema";

/** Resolve one game's MLB gamePk from its two ESPN team abbreviations + start time. */
function resolveGamePkForRow(
  row: PregamePowerRadarSignalRow,
  pkMap: Map<string, MlbScheduleEntry[]>,
): string | null {
  const a = normalizeAbbr(row.team);
  const b = normalizeAbbr(row.opponent);
  const candidates = [...(pkMap.get(`${a}|${b}`) ?? []), ...(pkMap.get(`${b}|${a}`) ?? [])];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].gamePk;

  // Doubleheader: pick the schedule entry whose start time is closest to the
  // row's own recorded startsAt, rather than guessing.
  if (!row.startsAt) return null;
  const target = Date.parse(row.startsAt);
  if (!Number.isFinite(target)) return null;
  return candidates.reduce((best, c) =>
    Math.abs(Date.parse(c.gameTime) - target) < Math.abs(Date.parse(best.gameTime) - target) ? c : best,
  ).gamePk;
}

export interface HistoricalRegradeRowResult {
  signalId: string;
  sessionDate: string;
  batterName: string;
  hitHr: boolean | undefined;
  outcome: string | undefined;
  userVisible: boolean | undefined;
}

export interface HistoricalRegradeRunResult {
  mode: "dry-run" | "apply";
  dates: string[];
  scanned: number;
  candidates: number;
  unresolvedGames: string[];
  regraded: number;
  failed: number;
  rows: HistoricalRegradeRowResult[];
}

/** Re-derives graded outcomes for final games whose result was wiped by the pre-fix clobbering bug. */
export async function runHistoricalRegrade(dates: string[], apply: boolean): Promise<HistoricalRegradeRunResult> {
  let scanned = 0;
  let candidateCount = 0;
  let regraded = 0;
  let failed = 0;
  const unresolvedGames: string[] = [];
  const rowResults: HistoricalRegradeRowResult[] = [];

  for (const sessionDate of dates) {
    const rows = await storage.getPregamePowerRadarSignalsByDate(sessionDate);
    scanned += rows.length;

    const needsRegrade = rows.filter((r) => r.gameStatus === "final" && (r.status !== "graded" || !r.outcomes));
    if (needsRegrade.length === 0) continue;
    candidateCount += needsRegrade.length;

    const pkMap = await fetchMlbGamePkMap(sessionDate);
    const gamePkByGameId = new Map<string, string | null>();
    for (const row of needsRegrade) {
      if (!gamePkByGameId.has(row.gameId)) {
        gamePkByGameId.set(row.gameId, resolveGamePkForRow(row, pkMap));
      }
    }

    for (const [gameId, gamePk] of Array.from(gamePkByGameId.entries())) {
      if (!gamePk) {
        unresolvedGames.push(`${sessionDate}:${gameId}`);
        continue;
      }
      try {
        await syncGameBoxScore(gamePk, gameId);
      } catch (err: any) {
        console.warn(`[PREGAME_REGRADE] box score fetch failed gameId=${gameId} gamePk=${gamePk}:`, err?.message ?? err);
      }
    }

    for (const row of needsRegrade) {
      const gamePk = gamePkByGameId.get(row.gameId);
      if (!gamePk) continue;

      const signal = rowToSignal(row);
      const outcome = resolveOutcome(signal);
      if (!outcome) continue;

      rowResults.push({
        signalId: row.signalId,
        sessionDate,
        batterName: row.batterName,
        hitHr: outcome.hitHr,
        outcome: outcome.outcome,
        userVisible: outcome.userVisible,
      });
      if (!apply) continue;

      signal.outcomes = outcome;
      signal.status = "graded";
      try {
        await storage.upsertPregamePowerRadarSignal({ ...signalToRow(signal), gradedAt: new Date() });
        regraded++;
      } catch (err: any) {
        failed++;
        console.error(`[PREGAME_REGRADE] persist failed ${row.signalId}:`, err?.message ?? err);
      }
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    dates,
    scanned,
    candidates: candidateCount,
    unresolvedGames,
    regraded,
    failed,
    rows: rowResults,
  };
}
