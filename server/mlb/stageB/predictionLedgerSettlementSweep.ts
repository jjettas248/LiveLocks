// ── MLB Live Edge Stage B — settlement sweep (research-only) ─────────────────
// Periodically grades captured all-lane predictions against the REAL final
// outcome and writes the result back to the Stage B ledger ONLY. It reuses the
// exact official outcome source read-only (fetchMlbBoxScore/buildMlbPlayerStats/
// getMlbStatValue from server/services/gradePersistedPlays.ts) and the pure
// decision function (predictionLedgerSettlement.ts). It NEVER touches
// storage.settlePlay, persisted_plays, ROI, or W/L.
//
// Safety posture (mirrors the mound-V2 reconciliation sweep):
//   * whole-sweep single-flight guard (no overlapping runs)
//   * one box-score fetch per game per sweep (grouped), bounded games/sweep
//   * NEVER throws — per-game and per-row failures are counted, not propagated
//   * a not-final / unfetchable game holds (never voided on a transient); only
//     a game still unresolvable past a hard abandon age is retired (void)
//
// Deps are injected so the sweep is behaviorally testable without a DB/network;
// defaultStageBSweepDeps() wires the real storage + outcome source.

import type { MlbLanePrediction, MlbLedgerVoidReason } from "@shared/mlbPredictionLedger";
import {
  decideLanePredictionSettlement,
  type MlbLedgerOutcomeGameState,
} from "./predictionLedgerSettlement";

export interface StageBSweepDeps {
  listPending(opts: { limit: number; capturedBeforeMs?: number }): Promise<MlbLanePrediction[]>;
  settle(predictionId: string, finalStat: number, settledAt: Date): Promise<unknown>;
  voidPrediction(predictionId: string, reason: MlbLedgerVoidReason, settledAt: Date): Promise<unknown>;
  // Returns a final box score object, or null when the game is not final /
  // unavailable (fetchMlbBoxScore already returns null unless the game is final).
  fetchBox(gameId: string): Promise<unknown | null>;
  buildPlayerStats(box: unknown): Map<string, unknown>;
  getStatValue(entry: unknown, market: string): number | null;
  // True when the found box entry has ANY batting or pitching participation.
  // false distinguishes a TRUE did-not-appear from a player who played but whose
  // specific market field is not (yet) present — the decision voids only the
  // former as DNP.
  playerHasAnyStats(entry: unknown): boolean;
  normalizeMarket(market: string): string;
  now: () => number;
}

export interface StageBSweepPolicy {
  pendingLimit: number;
  maxGamesPerSweep: number;
  // Skip rows captured within the last N minutes — their game cannot be final
  // yet, so a box fetch would just be a wasted round-trip. The row is picked up
  // on a later sweep once it ages past this floor.
  minSettleAgeMinutes: number;
}

export const DEFAULT_STAGE_B_SWEEP_POLICY: StageBSweepPolicy = {
  pendingLimit: 2000,
  maxGamesPerSweep: 25,
  minSettleAgeMinutes: 10,
};

export interface StageBSweepSummary {
  scanned: number;
  games: number;
  settled: number;
  voided: number;
  held: number;
  fetchFailures: number;
  errors: number;
  skipped: boolean;
}

function emptySummary(): StageBSweepSummary {
  return { scanned: 0, games: 0, settled: 0, voided: 0, held: 0, fetchFailures: 0, errors: 0, skipped: false };
}

// Whole-sweep single-flight guard (module-level) so overlapping intervals never
// double-process the same pending rows.
let sweeping = false;

/** Test-only: clear the single-flight guard between behavioral cases. */
export function __resetStageBSweepGuardForTest(): void {
  sweeping = false;
}

/**
 * Runs one settlement sweep. NEVER throws — returns a summary always. When a
 * prior sweep is still running, returns immediately with `skipped: true`.
 */
export async function runStageBSettlementSweep(
  deps: StageBSweepDeps,
  policy: StageBSweepPolicy = DEFAULT_STAGE_B_SWEEP_POLICY,
): Promise<StageBSweepSummary> {
  const summary = emptySummary();
  if (sweeping) {
    summary.skipped = true;
    return summary;
  }
  sweeping = true;
  try {
    const now = deps.now();
    // Skip rows too fresh to have a final box yet (wasted fetch otherwise).
    const capturedBeforeMs = now - policy.minSettleAgeMinutes * 60 * 1000;
    const pending = await deps.listPending({ limit: policy.pendingLimit, capturedBeforeMs });
    summary.scanned = pending.length;
    if (pending.length === 0) return summary;

    const byGame = new Map<string, MlbLanePrediction[]>();
    for (const p of pending) {
      const arr = byGame.get(p.gameId) ?? [];
      arr.push(p);
      byGame.set(p.gameId, arr);
    }
    const games = Array.from(byGame.keys()).slice(0, policy.maxGamesPerSweep);
    summary.games = games.length;

    for (const gameId of games) {
      // One box fetch per game per sweep (dedup).
      let box: unknown | null = null;
      try {
        box = await deps.fetchBox(gameId);
      } catch {
        summary.fetchFailures++;
        box = null;
      }
      let playerMap: Map<string, unknown> | null = null;
      if (box) {
        try { playerMap = deps.buildPlayerStats(box); } catch { playerMap = null; }
      }

      for (const pred of byGame.get(gameId)!) {
        try {
          const ageHours = Math.max(0, (now - Date.parse(pred.capturedAt)) / 3_600_000);
          const gameState = resolveGameState(box);

          let finalStat: number | null = null;
          let playerFoundInFinalBox = false;
          let playerHasAnyStats = false;
          if (gameState === "final" && playerMap) {
            const entry = playerMap.get(pred.playerId);
            if (entry !== undefined) {
              playerFoundInFinalBox = true;
              playerHasAnyStats = deps.playerHasAnyStats(entry);
              const v = deps.getStatValue(entry, deps.normalizeMarket(pred.market));
              if (v != null && Number.isFinite(v)) finalStat = v;
              // else: field not present. If the player has NO participation at all
              // ⇒ true DNP (voided by the decision); otherwise ⇒ held/unresolvable.
            }
            // entry undefined ⇒ player absent from final box ⇒ unresolvable;
            // the decision holds young / terminal-voids old.
          }

          const decision = decideLanePredictionSettlement(pred, {
            gameState,
            finalStat,
            playerFoundInFinalBox,
            playerHasAnyStats,
            ageHours,
          });

          if (decision.action === "settle") {
            await deps.settle(pred.predictionId, decision.finalStat!, new Date(now));
            summary.settled++;
          } else if (decision.action === "void") {
            await deps.voidPrediction(pred.predictionId, decision.voidReason!, new Date(now));
            summary.voided++;
          } else {
            summary.held++;
          }
        } catch {
          summary.errors++;
        }
      }
    }

    console.log(
      `[MLB_STAGE_B_SETTLE] scanned=${summary.scanned} games=${summary.games} settled=${summary.settled} ` +
      `voided=${summary.voided} held=${summary.held} fetchFail=${summary.fetchFailures} errors=${summary.errors}`,
    );
    return summary;
  } catch (err) {
    console.warn(`[MLB_STAGE_B_SETTLE_ERROR] ${(err as Error)?.message ?? err}`);
    return summary;
  } finally {
    sweeping = false;
  }
}

/**
 * Maps a fetched box (or its absence) into the decision function's game state. A
 * present box means final (fetchMlbBoxScore only returns final games). An absent
 * box is "unknown" (not-final or unfetchable) — the decision holds young and,
 * once terminal-old, retires it via a NEUTRAL `line_unresolvable` void (never a
 * synthesized "postponed", which would mislabel a genuinely-final game whose box
 * was merely unavailable).
 */
function resolveGameState(box: unknown | null): MlbLedgerOutcomeGameState {
  return box ? "final" : "unknown";
}

/**
 * Wires the real storage + read-only outcome source. Imported lazily inside so
 * the pure sweep above stays dependency-free for tests.
 */
export async function defaultStageBSweepDeps(): Promise<StageBSweepDeps> {
  const { storage } = await import("../../storage");
  const { fetchMlbBoxScore, buildMlbPlayerStats, getMlbStatValue } = await import("../../services/gradePersistedPlays");
  const { normalizeMlbMarketKey } = await import("../normalizeMarketKey");
  return {
    listPending: (opts) => storage.listPendingMlbLanePredictions(opts),
    settle: (id, finalStat, settledAt) => storage.settleMlbLanePrediction(id, finalStat, settledAt),
    voidPrediction: (id, reason, settledAt) => storage.voidMlbLanePrediction(id, reason, settledAt),
    fetchBox: (gameId) => fetchMlbBoxScore(gameId) as Promise<unknown | null>,
    buildPlayerStats: (box) => buildMlbPlayerStats(box as any) as unknown as Map<string, unknown>,
    getStatValue: (entry, market) => getMlbStatValue(entry as any, market),
    // A true DNP has empty batting AND empty pitching (matches gradePersistedPlays'
    // isDnp gate). Any populated stat object ⇒ the player appeared.
    playerHasAnyStats: (entry) => {
      const e = entry as { batting?: Record<string, unknown>; pitching?: Record<string, unknown> } | null | undefined;
      const battingCount = e?.batting ? Object.keys(e.batting).length : 0;
      const pitchingCount = e?.pitching ? Object.keys(e.pitching).length : 0;
      return battingCount > 0 || pitchingCount > 0;
    },
    normalizeMarket: (market) => normalizeMlbMarketKey(market),
    now: () => Date.now(),
  };
}

/** Convenience entry for the scheduler: build real deps + run one sweep. */
export async function runStageBSettlementSweepWithDefaults(): Promise<StageBSweepSummary> {
  const deps = await defaultStageBSweepDeps();
  return runStageBSettlementSweep(deps);
}
