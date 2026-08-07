// ── MLB Live Edge Stage C — offline calibration runner (research-only) ───────
// Periodically reads a window of the Stage B ledger READ-ONLY, fits a
// calibration artifact per segment, evaluates (in-sample) promotion readiness,
// and persists the artifacts. It writes ONLY to mlb_calibration_artifacts and
// NEVER promotes anything — nothing in the live engine reads these rows. This is
// the "offline" in "offline calibrator": it does not run in any request/tick
// path; it is a scheduled background job (server/index.ts).
//
// Deps are injected so the runner is behaviorally testable without a DB;
// defaultCalibrationRunnerDeps() wires the real storage.

import type { MlbLanePrediction } from "@shared/mlbPredictionLedger";
import type { InsertMlbCalibrationArtifact, MlbCalibrationArtifactRow } from "@shared/schema";
import type { MlbCalibrationArtifact } from "@shared/mlbCalibration";
import { fitCalibratorsFromLedger } from "./fitCalibrator";
import { evaluateCalibratorPromotionReadiness } from "./calibratorPromotionGate";

export interface CalibrationRunnerDeps {
  listLedgerRows(opts: { capturedAfterMs: number; limit: number }): Promise<MlbLanePrediction[]>;
  saveArtifacts(rows: InsertMlbCalibrationArtifact[]): Promise<number>;
  now: () => number;
}

export interface CalibrationRunnerPolicy {
  windowDays: number;
  maxRows: number;
  bins: number;
  pseudoCount: number;
  // false ⇒ calibrate per market; true ⇒ per (market, lane).
  segmentByLane: boolean;
}

export const DEFAULT_CALIBRATION_RUNNER_POLICY: CalibrationRunnerPolicy = {
  windowDays: 120,
  maxRows: 20000,
  bins: 10,
  pseudoCount: 20,
  segmentByLane: false,
};

export interface CalibrationRunSummary {
  observationsScanned: number;
  segments: number;
  artifactsSaved: number;
  // True when the read hit the maxRows cap — the effective window was shorter
  // than windowDays; logged (not silent) so it can be tuned.
  truncated: boolean;
  error: boolean;
}

function num(x: number | null | undefined): string | null {
  return x != null && Number.isFinite(x) ? String(x) : null;
}

/** Builds the append-only insert row for one fitted artifact + its (in-sample)
 *  readiness evaluation. Pure. */
export function artifactToInsertRow(
  artifact: MlbCalibrationArtifact,
  readiness: { ready: boolean; reasons: string[] },
): InsertMlbCalibrationArtifact {
  return {
    artifactId: `${artifact.segment}:${artifact.builtAtMs}`,
    segment: artifact.segment,
    method: artifact.method,
    builtAt: new Date(artifact.builtAtMs),
    sampleSize: artifact.fitStats.sampleSize,
    distinctSlateDates: artifact.fitStats.distinctSlateDates,
    rawBrier: num(artifact.fitStats.rawBrier),
    calibratedBrier: num(artifact.fitStats.calibratedBrier),
    rawEcePct: num(artifact.fitStats.rawEcePct),
    calibratedEcePct: num(artifact.fitStats.calibratedEcePct),
    basePositiveRate: num(artifact.fitStats.basePositiveRate),
    promotionReady: readiness.ready,
    promotionReasons: readiness.reasons,
    artifact: artifact as unknown as InsertMlbCalibrationArtifact["artifact"],
    ledgerContractVersion: artifact.ledgerContractVersion,
    artifactVersion: artifact.artifactVersion,
  };
}

/**
 * Runs one offline calibration fit + persist. NEVER throws — returns a summary
 * always. Read-only over the ledger; writes only calibration artifacts; never
 * promotes.
 */
export async function runCalibrationFit(
  deps: CalibrationRunnerDeps,
  policy: CalibrationRunnerPolicy = DEFAULT_CALIBRATION_RUNNER_POLICY,
): Promise<CalibrationRunSummary> {
  try {
    const now = deps.now();
    const capturedAfterMs = now - policy.windowDays * 24 * 60 * 60 * 1000;
    const rows = await deps.listLedgerRows({ capturedAfterMs, limit: policy.maxRows });
    const truncated = rows.length >= policy.maxRows;
    if (truncated) {
      console.warn(
        `[MLB_STAGE_C_CALIBRATION] window truncated at maxRows=${policy.maxRows} (windowDays=${policy.windowDays}) — effective window is shorter than configured; raise maxRows or narrow windowDays`,
      );
    }

    const segmentKey = policy.segmentByLane
      ? (p: MlbLanePrediction) => `${p.market}:${p.lane}`
      : (p: MlbLanePrediction) => p.market;

    const artifacts = fitCalibratorsFromLedger(rows, {
      builtAtMs: now,
      bins: policy.bins,
      pseudoCount: policy.pseudoCount,
      segmentKey,
    });

    const insertRows: InsertMlbCalibrationArtifact[] = [];
    for (const segment of Object.keys(artifacts)) {
      const artifact = artifacts[segment];
      // In-sample readiness (always blocks on in_sample_only here) — stored for
      // admin visibility; NEVER used to promote.
      const readiness = evaluateCalibratorPromotionReadiness({ artifact });
      insertRows.push(artifactToInsertRow(artifact, readiness));
    }

    const saved = insertRows.length > 0 ? await deps.saveArtifacts(insertRows) : 0;
    console.log(
      `[MLB_STAGE_C_CALIBRATION] window=${policy.windowDays}d scanned=${rows.length} truncated=${truncated} segments=${insertRows.length} saved=${saved}`,
    );
    return { observationsScanned: rows.length, segments: insertRows.length, artifactsSaved: saved, truncated, error: false };
  } catch (err) {
    console.warn(`[MLB_STAGE_C_CALIBRATION_ERROR] ${(err as Error)?.message ?? err}`);
    return { observationsScanned: 0, segments: 0, artifactsSaved: 0, truncated: false, error: true };
  }
}

/** Latest artifact row per segment. Input newest-first (as storage returns);
 *  the first row seen per segment wins. Pure. */
export function latestArtifactPerSegment(rows: readonly MlbCalibrationArtifactRow[]): MlbCalibrationArtifactRow[] {
  const seen = new Set<string>();
  const out: MlbCalibrationArtifactRow[] = [];
  for (const r of rows) {
    if (seen.has(r.segment)) continue;
    seen.add(r.segment);
    out.push(r);
  }
  return out;
}

export async function defaultCalibrationRunnerDeps(): Promise<CalibrationRunnerDeps> {
  const { storage } = await import("../../storage");
  return {
    // Settled decided (cashed/missed) rows only — the exact fit input, far
    // smaller than all captures, so the maxRows cap rarely truncates the window.
    listLedgerRows: (opts) => storage.listSettledMlbLanePredictionsForCalibration(opts),
    saveArtifacts: (rows) => storage.saveMlbCalibrationArtifacts(rows),
    now: () => Date.now(),
  };
}

/** Convenience entry for the scheduler: build real deps + run one fit. */
export async function runCalibrationFitWithDefaults(): Promise<CalibrationRunSummary> {
  const deps = await defaultCalibrationRunnerDeps();
  return runCalibrationFit(deps);
}
