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
import type { InsertMlbCalibrationArtifact, MlbCalibrationArtifactRow, InsertMlbActiveCalibrator } from "@shared/schema";
import type { MlbCalibrationArtifact } from "@shared/mlbCalibration";
import { fitCalibratorsFromLedger } from "./fitCalibrator";
import { evaluateCalibratorPromotionReadiness } from "./calibratorPromotionGate";
import { evaluateWalkForwardFromLedger, type WalkForwardResult } from "./walkForwardEvaluation";
import {
  planCalibratorPromotions,
  type CalibratorActivation,
  type CalibratorPromotionPlan,
} from "./calibratorPromotion";
import { isMlbCalibrationPromotionEnabled } from "../productionPolicy";

export interface CalibrationRunnerDeps {
  listLedgerRows(opts: { capturedAfterMs: number; limit: number }): Promise<MlbLanePrediction[]>;
  saveArtifacts(rows: InsertMlbCalibrationArtifact[]): Promise<number>;
  // ── Stage C PR3 — promotion application (all no-ops while the flag is off) ──
  // The set of segments with a currently-active calibrator (registry state).
  listActiveSegments(): Promise<string[]>;
  // Activate/re-activate a segment's calibrator (upsert by segment).
  activateCalibrator(row: InsertMlbActiveCalibrator): Promise<unknown>;
  // Deactivate a segment's calibrator (flip active=false + reason).
  deactivateCalibrator(segment: string, reason: string, at: Date): Promise<unknown>;
  // Reload the in-memory hot-path registry after applying the plan.
  refreshRegistry(nowMs: number): Promise<unknown>;
  // The master switch (read once at boot). Injected so the runner is testable.
  promotionEnabled: () => boolean;
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
  // ── Stage C PR3 — promotion outcome (0/0 whenever the flag is off) ──────────
  promotionEnabled: boolean;
  segmentsReady: number;    // cleared the gate on OOS evidence this run
  activated: number;        // written to the registry this run
  deactivated: number;      // pulled from the registry this run
  // True when the read hit the maxRows cap — the effective window was shorter
  // than windowDays; logged (not silent) so it can be tuned.
  truncated: boolean;
  error: boolean;
}

/** Builds the registry insert row for one activation. Pure. */
export function activationToInsertRow(
  activation: CalibratorActivation,
  builtAtMs: number,
  nowMs: number,
): InsertMlbActiveCalibrator {
  const { artifact } = activation;
  return {
    segment: activation.segment,
    artifactId: `${artifact.segment}:${artifact.builtAtMs}`,
    artifact: artifact as unknown as InsertMlbActiveCalibrator["artifact"],
    active: true,
    activatedAt: new Date(nowMs),
    activatedBy: "auto_promotion_runner",
    promotionEvidence: activation.snapshot as unknown as InsertMlbActiveCalibrator["promotionEvidence"],
    ledgerContractVersion: artifact.ledgerContractVersion,
    artifactVersion: artifact.artifactVersion,
  };
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

    // ── Stage C PR3 — auto-promotion on OUT-OF-SAMPLE walk-forward evidence ────
    // Fit metrics above are in-sample and can never promote. The real gate runs
    // against the forward-chaining walk-forward evaluation over the SAME rows.
    // planCalibratorPromotions returns an EMPTY plan while the flag is off, so
    // nothing is written and production stays calibratedProbability = null.
    const enabled = deps.promotionEnabled();
    const walkForward: Record<string, WalkForwardResult> = evaluateWalkForwardFromLedger(rows, segmentKey, {
      builtAtMs: now,
      bins: policy.bins,
      pseudoCount: policy.pseudoCount,
      minEdgePctPoints: undefined, // walk-forward defaults; edge floor mirrors production
    });
    const activeSegments = new Set(await deps.listActiveSegments());
    const plan: CalibratorPromotionPlan = planCalibratorPromotions({
      artifacts,
      walkForward,
      activeSegments,
      enabled,
    });
    const segmentsReady = plan.decisions.filter((d) => d.ready).length;

    let activated = 0;
    let deactivated = 0;
    for (const act of plan.activate) {
      await deps.activateCalibrator(activationToInsertRow(act, now, now));
      activated++;
    }
    for (const deact of plan.deactivate) {
      await deps.deactivateCalibrator(deact.segment, deact.reason, new Date(now));
      deactivated++;
    }
    // Refresh the hot-path registry only when live state actually changed.
    if (enabled && (activated > 0 || deactivated > 0)) {
      await deps.refreshRegistry(now);
    }

    console.log(
      `[MLB_STAGE_C_CALIBRATION] window=${policy.windowDays}d scanned=${rows.length} truncated=${truncated} ` +
      `segments=${insertRows.length} saved=${saved} promotionEnabled=${enabled} ready=${segmentsReady} ` +
      `activated=${activated} deactivated=${deactivated}`,
    );
    return {
      observationsScanned: rows.length,
      segments: insertRows.length,
      artifactsSaved: saved,
      promotionEnabled: enabled,
      segmentsReady,
      activated,
      deactivated,
      truncated,
      error: false,
    };
  } catch (err) {
    console.warn(`[MLB_STAGE_C_CALIBRATION_ERROR] ${(err as Error)?.message ?? err}`);
    return {
      observationsScanned: 0, segments: 0, artifactsSaved: 0,
      promotionEnabled: false, segmentsReady: 0, activated: 0, deactivated: 0,
      truncated: false, error: true,
    };
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
  const { refreshActiveCalibratorRegistry } = await import("./activeCalibratorRegistry");
  return {
    // Settled decided (cashed/missed) rows only — the exact fit input, far
    // smaller than all captures, so the maxRows cap rarely truncates the window.
    listLedgerRows: (opts) => storage.listSettledMlbLanePredictionsForCalibration(opts),
    saveArtifacts: (rows) => storage.saveMlbCalibrationArtifacts(rows),
    listActiveSegments: async () => (await storage.listActiveMlbCalibrators()).map((c) => c.segment),
    activateCalibrator: (row) => storage.upsertMlbActiveCalibrator(row),
    deactivateCalibrator: (segment, reason, at) => storage.deactivateMlbActiveCalibrator(segment, reason, at),
    refreshRegistry: (nowMs) => refreshActiveCalibratorRegistry(nowMs),
    promotionEnabled: () => isMlbCalibrationPromotionEnabled(),
    now: () => Date.now(),
  };
}

/** Convenience entry for the scheduler: build real deps + run one fit. */
export async function runCalibrationFitWithDefaults(): Promise<CalibrationRunSummary> {
  const deps = await defaultCalibrationRunnerDeps();
  return runCalibrationFit(deps);
}
