// ── MLB Live Edge safety-core — Stage B: All-Lane Prediction Capture ─────────
// Pure builder that maps a FULLY-FINALIZED MLBQualifiedSignal (any lane) into a
// frozen MlbLanePrediction ledger row (shared/mlbPredictionLedger.ts). This is a
// DOWNSTREAM, MEASUREMENT-ONLY transform:
//   * It runs AFTER stampMlbSignalFinalization — every input it reads (lane,
//     no-vig edge, calibration semantics, finalized tier, odds provenance) is
//     already final. It can never change what the engine emitted.
//   * It captures ALL lanes (official/watch/shadow) — deliberately NOT gated on
//     officialEligibility/lane==="official" the way autoPersistMLBSignals is —
//     because Stage B's whole purpose is to compare calibration across lanes.
//   * home_runs is excluded: HR Radar owns its own lifecycle (CLAUDE.md §3.2c);
//     it is never absorbed into the Live Edge production matrix, and it is not
//     absorbed into this ledger either.
//   * Capture is fail-closed: a signal missing the minimal fields needed to make
//     a gradable prediction (finite line, finite candidate probability, a
//     finalized lane) is SKIPPED, never recorded as a garbage row.
//
// No I/O. `capturedAtMs` is injected so this stays deterministic/testable — the
// one clock lives at the (future) wiring call site, not here.

import type { MLBQualifiedSignal } from "../types";
import { MLB_PREDICTION_CAPTURE_ENABLED_DEFAULT } from "../productionPolicy";
import {
  MLB_PREDICTION_LANES,
  MLB_PREDICTION_LEDGER_CONTRACT_VERSION,
  type MlbLanePrediction,
  type MlbPredictionLane,
  type MlbLedgerSide,
  type MlbLedgerProbabilitySemantics,
} from "@shared/mlbPredictionLedger";

export interface StageBCaptureContext {
  // The game whose tick produced these signals (autoPersistMLBSignals receives
  // gameId the same way). Falls back to the signal's own gameId if omitted.
  gameId?: string;
  // The single clock for this capture batch (ms epoch).
  capturedAtMs: number;
  // Version provenance, stamped by the (future) wiring site from the real
  // constants (MLB_FINALIZATION_VERSION / MLB_GOLDMASTER_VERSION /
  // MLB_PRODUCTION_LANE_VERSION). Optional so the pure builder needs no heavy
  // imports; null when unknown.
  finalizerVersion?: string | null;
  goldmasterVersion?: string | null;
  laneVersion?: string | null;
  // Master switch. Defaults to the policy-owned MLB_PREDICTION_CAPTURE_ENABLED_
  // DEFAULT so all rollout state stays in productionPolicy.ts. When false, the
  // builder captures nothing (private measurement fully off).
  captureEnabled?: boolean;
}

const LANE_SET: ReadonlySet<string> = new Set(MLB_PREDICTION_LANES);

function toIsoOrNull(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeSide(side: unknown): MlbLedgerSide | null {
  if (side === "OVER") return "OVER";
  if (side === "UNDER") return "UNDER";
  return null;
}

/**
 * Builds one frozen ledger row from a finalized signal, or returns null when the
 * signal must be skipped (capture disabled, home_runs, unfinalized lane, or
 * missing the minimal gradable fields). Pure.
 */
export function buildLanePredictionFromSignal(
  sig: MLBQualifiedSignal,
  ctx: StageBCaptureContext,
): MlbLanePrediction | null {
  const captureEnabled = ctx.captureEnabled ?? MLB_PREDICTION_CAPTURE_ENABLED_DEFAULT;
  if (!captureEnabled) return null;

  // HR Radar owns its own lifecycle — never captured here.
  if (sig.market === "home_runs") return null;

  // Lane must be a real finalized lane (fail-closed: unstamped ⇒ skip).
  const lane = sig.lane;
  if (lane == null || !LANE_SET.has(lane)) return null;

  const side = normalizeSide(sig.side);
  if (side == null) return null;

  // Minimal gradable fields.
  if (!Number.isFinite(sig.line)) return null;
  if (!Number.isFinite(sig.engineProbability)) return null;

  const gameId = ctx.gameId ?? sig.gameId;
  const capturedAt = new Date(ctx.capturedAtMs).toISOString();
  const sideOdds = side === "OVER" ? (sig.overOdds ?? null) : (sig.underOdds ?? null);
  const statKnown = sig.currentStatKnown === true;

  const semantics: MlbLedgerProbabilitySemantics =
    sig.outcomeProbabilitySemantics === "outcome_calibrated" ? "outcome_calibrated" : "raw_provisional";

  return {
    // Identity — frozen
    predictionId: `${sig.id}:${ctx.capturedAtMs}`,
    signalId: sig.id,
    sport: "MLB",
    gameId,
    playerId: sig.playerId,
    playerName: sig.playerName,
    market: sig.market,
    side,
    lane: lane as MlbPredictionLane,

    // Captured market state — frozen
    line: sig.line,
    overOdds: sig.overOdds ?? null,
    underOdds: sig.underOdds ?? null,
    sideOdds,
    sportsbook: sig.sportsbook ?? null,
    oddsFetchedAt: toIsoOrNull(sig.oddsTimestamp),
    oddsAgeMs: sig.oddsAgeMs ?? null,
    capturedAt,
    inning: Number.isFinite(sig.inning) ? sig.inning : null,
    gamePhase: null,
    statAtCapture: statKnown && Number.isFinite(sig.currentStat) ? sig.currentStat : null,

    // Model output — frozen
    candidateProbabilityPct: sig.engineProbability,
    calibratedProbabilityPct: sig.calibratedCandidateProbability ?? null,
    probabilitySemantics: semantics,
    modelEdgePctPoints: sig.modelEdgePctPoints ?? null,
    noVigBookProbability: sig.noVigBookProbability ?? null,
    edgeVersion: sig.edgeVersion ?? null,
    finalizedTier: sig.finalizedTier ?? null,
    modelMethod: sig.modelMethod ?? null,
    dataQuality: sig.dataQuality ?? null,
    baseEligible: sig.officialEligibility?.eligible ?? null,
    signalScore: Number.isFinite(sig.signalScore) ? sig.signalScore : null,
    laneReasons: Array.isArray(sig.laneReasons) ? [...sig.laneReasons] : [],

    // Provenance / versions — frozen
    finalizerVersion: ctx.finalizerVersion ?? null,
    laneVersion: ctx.laneVersion ?? null,
    goldmasterVersion: ctx.goldmasterVersion ?? null,
    contractVersion: MLB_PREDICTION_LEDGER_CONTRACT_VERSION,

    // Settlement — mutable (starts unsettled)
    status: "captured",
    settlementResult: null,
    finalStat: null,
    settledAt: null,
    voidReason: null,
  };
}

/**
 * Builds the full capture batch for a game tick: every finalized signal that
 * survives the per-signal gate. Order is preserved; skipped signals are dropped.
 * Pure.
 */
export function buildStageBCapturePredictions(
  signals: readonly MLBQualifiedSignal[],
  ctx: StageBCaptureContext,
): MlbLanePrediction[] {
  const out: MlbLanePrediction[] = [];
  for (const sig of signals) {
    const row = buildLanePredictionFromSignal(sig, ctx);
    if (row) out.push(row);
  }
  return out;
}
