// PR4 — NBA Pregame Targets: fresh-line decision boundary.
//
// The single seam where a fresh market line is joined to the frozen, line-blind
// PR3 projection — and ONLY after projection generation. The PR3 projection object
// (its frozen input, feature hash, and projection hash) is read but never mutated,
// so those hashes stay independent of line/book/odds/price/edge/payout/EV.
//
// Fail-closed, typed status — never throws:
//   • identity_mismatch — canonical player/game/market/model-version/projection-hash
//     do not all match the frozen projection (verified BEFORE any line evaluation)
//   • market_unavailable — the market has no usable PR3 distribution
//   • line_missing / line_malformed / line_stale — the fresh line is absent,
//     non-finite / future / unparseable, or older than the freshness window
//   • not_resolvable — the line falls at/above the PMF's folded tail bucket
//   • engine_error — an unexpected internal fault (defensive catch)
//   • ok — coherent line probabilities produced (optionally calibrated)
//
// Calibration (optional) is applied to the no-push OVER win probability only; the
// UNDER side is its complement (1 − over), so opposite sides can never contradict.
// No EV, odds, price, edge, payout, staking, recommendation, or sportsbook
// selection — strictly the line→probability decision.

import { isoInstantMs } from "../../../../shared/pregameTargets/canonicalEntities";
import type { NbaMarketKey } from "../markets";
import { marketProjection, type NbaProjectionResult } from "../nbaProjectionEngine";
import { computeLineProbabilities, type LineProbabilities } from "./lineProbabilities";
import {
  calibrateProbability,
  type CalibrationObservation,
  type CalibrationConfig,
  type CalibratedProbability,
} from "../calibration/walkForwardCalibration";

export interface FreshLine {
  /** The posted line value (e.g. 24.5). */
  line: number;
  /** ISO-8601 instant (with offset) the line was captured. */
  capturedAt: string;
  /** Book label — provenance only; never used for selection or pricing. */
  sportsbook?: string;
}

export interface DecisionIdentity {
  playerCanonicalId: string;
  gameCanonicalId: string;
  market: NbaMarketKey;
  modelVersion: string;
  /** The frozen PR3 projection hash the caller believes it is deciding against. */
  projectionHash: string;
}

export type DecisionStatus =
  | "ok"
  | "line_missing"
  | "line_malformed"
  | "line_stale"
  | "market_unavailable"
  | "identity_mismatch"
  | "not_resolvable"
  | "engine_error";

export interface FreshLineDecision {
  status: DecisionStatus;
  market: NbaMarketKey;
  line: number | null;
  probabilities: LineProbabilities | null;
  /** Calibrated no-push OVER win probability (null when no calibrator supplied). */
  calibratedNoPushWinOver: number | null;
  /** Complement of the calibrated OVER (never independently calibrated). */
  calibratedNoPushWinUnder: number | null;
  calibration: CalibratedProbability | null;
  provenance: {
    playerCanonicalId: string;
    gameCanonicalId: string;
    market: NbaMarketKey;
    modelVersion: string;
    /** Carried through from the frozen projection, unchanged by the line. */
    projectionHash: string;
    featureHash: string;
    lineCapturedAt: string | null;
    sportsbook: string | null;
    asOf: string;
  };
}

/** Default line-freshness window: 15 minutes. */
export const DEFAULT_MAX_LINE_AGE_MS = 15 * 60 * 1000;

export interface EvaluateFreshLineArgs {
  projection: NbaProjectionResult;
  identity: DecisionIdentity;
  line: FreshLine | null;
  asOf: string;
  maxLineAgeMs?: number;
  calibration?: { observations: readonly CalibrationObservation[]; config?: CalibrationConfig } | null;
}

function fail(args: EvaluateFreshLineArgs, status: DecisionStatus, line: number | null = null): FreshLineDecision {
  return {
    status,
    market: args.identity.market,
    line,
    probabilities: null,
    calibratedNoPushWinOver: null,
    calibratedNoPushWinUnder: null,
    calibration: null,
    provenance: {
      playerCanonicalId: args.identity.playerCanonicalId,
      gameCanonicalId: args.identity.gameCanonicalId,
      market: args.identity.market,
      modelVersion: args.identity.modelVersion,
      projectionHash: args.projection?.projectionHash ?? "",
      featureHash: args.projection?.featureHash ?? "",
      lineCapturedAt: args.line?.capturedAt ?? null,
      sportsbook: args.line?.sportsbook ?? null,
      asOf: args.asOf,
    },
  };
}

/**
 * Join a fresh line to a frozen PR3 projection and produce a coherent, optionally
 * calibrated line decision. Fail-closed and total (never throws). The projection
 * is read-only here — the line never flows back into its frozen input or hashes.
 */
export function evaluateFreshLine(args: EvaluateFreshLineArgs): FreshLineDecision {
  try {
    const { projection, identity } = args;
    const asOfMs = isoInstantMs(args.asOf);
    if (!projection || !Number.isFinite(asOfMs)) return fail(args, "engine_error");

    // 1. Verify canonical identity BEFORE evaluating any line.
    if (
      projection.playerCanonicalId !== identity.playerCanonicalId ||
      projection.gameCanonicalId !== identity.gameCanonicalId ||
      projection.modelVersion !== identity.modelVersion ||
      projection.projectionHash !== identity.projectionHash
    ) {
      return fail(args, "identity_mismatch");
    }
    const mp = marketProjection(projection, identity.market);
    if (mp === null) return fail(args, "identity_mismatch"); // market not part of this projection
    if (!mp.available || mp.pmf === null) return fail(args, "market_unavailable");

    // 2. Validate the fresh line (missing / malformed / stale) — fail closed.
    if (args.line == null) return fail(args, "line_missing");
    const { line, capturedAt } = args.line;
    if (!Number.isFinite(line)) return fail(args, "line_malformed", null);
    const capturedMs = isoInstantMs(capturedAt);
    if (!Number.isFinite(capturedMs)) return fail(args, "line_malformed", line);
    if (capturedMs > asOfMs) return fail(args, "line_malformed", line); // a line from the future
    const maxAge = args.maxLineAgeMs ?? DEFAULT_MAX_LINE_AGE_MS;
    if (asOfMs - capturedMs > maxAge) return fail(args, "line_stale", line);

    // 3. Join line to the frozen PMF (only now, post-projection).
    const probabilities = computeLineProbabilities(mp.pmf, line);
    if (!probabilities.resolvable) return fail(args, "not_resolvable", line);

    // 4. Optional calibration of the no-push OVER win probability; UNDER = complement.
    let calibration: CalibratedProbability | null = null;
    let calibratedNoPushWinOver: number | null = null;
    let calibratedNoPushWinUnder: number | null = null;
    if (args.calibration) {
      calibration = calibrateProbability(
        args.calibration.observations,
        identity.market,
        identity.modelVersion,
        probabilities.pNoPushWinOver,
        args.asOf,
        args.calibration.config,
      );
      calibratedNoPushWinOver = calibration.calibratedProbability;
      calibratedNoPushWinUnder = 1 - calibration.calibratedProbability;
    }

    return {
      status: "ok",
      market: identity.market,
      line,
      probabilities,
      calibratedNoPushWinOver,
      calibratedNoPushWinUnder,
      calibration,
      provenance: {
        playerCanonicalId: identity.playerCanonicalId,
        gameCanonicalId: identity.gameCanonicalId,
        market: identity.market,
        modelVersion: identity.modelVersion,
        projectionHash: projection.projectionHash,
        featureHash: projection.featureHash,
        lineCapturedAt: capturedAt,
        sportsbook: args.line.sportsbook ?? null,
        asOf: args.asOf,
      },
    };
  } catch {
    return fail(args, "engine_error");
  }
}

export function isDecisionOk(d: FreshLineDecision): boolean {
  return d.status === "ok";
}
