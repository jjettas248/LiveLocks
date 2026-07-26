// The Plate HR Probability V2 — labeler + walk-forward backtest runner.
//
// Reconciles pending labels, pulls resolved training pairs, fits a shadow
// term model + calibrator, and prints a report. Mirrors
// scripts/backtestHrRadar.ts / comparePlateModels.ts's conventions: bare
// npx tsx invocation, explicit DATABASE_URL check, fetch-via-storage ->
// pure-function compute -> console report, honest-limits early exit when
// there's no data to report on. Zero production/publication authority —
// label reconciliation is append-only and low-risk (runs by default);
// persisting a model artifact is the one real DB-write side effect in this
// script family, so it's opt-in behind --write, and every artifact this
// script writes is status:"candidate", never anything else.
//
//   DATABASE_URL=postgres://... npx tsx server/mlb/pregamePowerRadar/scripts/backtestPlateHrV2.ts \
//     --from=2026-07-01 --to=2026-07-26 [--label-version=plate_hr_v2_label_v1] \
//     [--skip-reconcile] [--min-train-rows=300] [--test-rows=100] [--l2=0.1] \
//     [--model-version=...] [--write]

import { storage } from "../../../storage";
import { slateDateET, daysAgoET } from "../../../utils/dateUtils";
import { reconcilePlateHrV2Labels } from "../hrProbabilityV2/plateHrV2LabelReconciler";
import { PLATE_HR_V2_LABEL_V1 } from "../hrProbabilityV2/plateHrV2LabelContract";
import { plateHrV2DerivedFeatureVectorV1Schema } from "../hrProbabilityV2/plateHrV2FeatureContract";
import { buildShadowHrTrainingRow } from "../hrProbabilityV2/plateHrV2ShadowTrainingRow";
import { fitPlateHrV2ShadowModel } from "../hrProbabilityV2/plateHrV2ShadowFitting";
import { buildPlateHrV2ModelArtifact, defaultPlateHrV2ModelVersion, toInsertPlateHrV2ModelRegistryRow } from "../hrProbabilityV2/plateHrV2ModelArtifactWriter";
import type { ShadowHrTrainingRow } from "../math/fitShadowTermWeights";

function parseArgs() {
  const a = process.argv.slice(2);
  const flag = (name: string) => a.find((x) => x.startsWith(`--${name}=`))?.split("=")[1];
  const has = (name: string) => a.includes(`--${name}`);
  const today = slateDateET();
  return {
    from: flag("from") ?? daysAgoET(30),
    to: flag("to") ?? today,
    labelVersion: flag("label-version") ?? PLATE_HR_V2_LABEL_V1,
    skipReconcile: has("skip-reconcile"),
    minTrainRows: flag("min-train-rows") ? Number(flag("min-train-rows")) : undefined,
    testRows: flag("test-rows") ? Number(flag("test-rows")) : undefined,
    l2: flag("l2") ? Number(flag("l2")) : undefined,
    modelVersion: flag("model-version"),
    write: has("write"),
  };
}

function fmt(v: number | null | undefined, dp = 4): string {
  return v == null || !Number.isFinite(v) ? "n/a" : v.toFixed(dp);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set. This script reads and (optionally) writes plate_hr_v2_* tables — it needs a DB.");
    process.exit(1);
  }

  const args = parseArgs();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.from) || !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    console.error("[PLATE_HR_V2_BACKTEST] --from/--to must be YYYY-MM-DD");
    process.exit(1);
  }
  console.log(`[PLATE_HR_V2_BACKTEST] range=${args.from}..${args.to} labelVersion=${args.labelVersion} write=${args.write}`);

  if (!args.skipReconcile) {
    console.log("\n── LABEL RECONCILIATION ────────────────────────────────────");
    const summary = await reconcilePlateHrV2Labels(
      { labelVersion: args.labelVersion, sessionDateFrom: args.from, sessionDateTo: args.to },
      { storage },
    );
    console.log(`  scanned=${summary.scanned} resolved=${summary.resolved} censored=${summary.censored} excluded=${summary.excluded} manualReview=${summary.manualReview}`);
    console.log(`  skippedGameNotOverYet=${summary.skippedGameNotOverYet} inserted=${summary.inserted} alreadyLabeled=${summary.alreadyLabeled}`);
  } else {
    console.log("\n── LABEL RECONCILIATION SKIPPED (--skip-reconcile) ─────────");
  }

  const pairs = await storage.getPlateHrV2ResolvedTrainingPairs(args.labelVersion, {
    sessionDateFrom: args.from,
    sessionDateTo: args.to,
  });

  if (pairs.length === 0) {
    console.log("\n── NO TRAINING DATA YET ─────────────────────────────────────");
    console.log("  Zero resolved (snapshot, label) pairs exist for this range.");
    console.log("  This is expected today: forward capture (PLATE_HR_V2_FORWARD_CAPTURE_ENABLED)");
    console.log("  has never been enabled in a live deployment, so plate_hr_v2_feature_snapshots");
    console.log("  is empty. This is not an error — nothing here is fabricated.");
    console.log("\n  Next step: enable forward capture in a live deployment, let it accumulate");
    console.log("  locked snapshots across real slates, then re-run this script.");
    console.log("\n[PLATE_HR_V2_BACKTEST] DONE — no data to fit.");
    process.exit(0);
  }

  console.log(`\n── TRAINING SET ─────────────────────────────────────────────`);
  console.log(`  resolved (snapshot, label) pairs: ${pairs.length}`);

  const rows: ShadowHrTrainingRow[] = [];
  let skippedInvalid = 0;
  for (const pair of pairs) {
    if (pair.label.hitHrToday == null) { skippedInvalid++; continue; } // defensive — should be unreachable given the resolved-only WHERE clause
    const parsedFeatures = plateHrV2DerivedFeatureVectorV1Schema.safeParse(pair.snapshot.derivedFeatures);
    if (!parsedFeatures.success) { skippedInvalid++; continue; } // never fabricate a row from a malformed derived_features value
    rows.push(
      buildShadowHrTrainingRow({
        derivedFeatures: parsedFeatures.data,
        playerId: pair.snapshot.batterId,
        gameId: pair.snapshot.gameId,
        frozenAt: pair.snapshot.predictionAsOf.toISOString(),
        hitHrToday: pair.label.hitHrToday,
      }),
    );
  }
  if (skippedInvalid > 0) console.log(`  skipped (malformed/invalid) : ${skippedInvalid}`);
  console.log(`  usable training rows        : ${rows.length}`);

  const result = fitPlateHrV2ShadowModel(rows, {
    minTrainRows: args.minTrainRows,
    testRows: args.testRows,
    l2: args.l2,
  });

  console.log(`\n── WALK-FORWARD FOLDS ───────────────────────────────────────`);
  if (result.walkForwardFolds.length === 0) {
    console.log("  (none — not enough rows to clear minTrainRows for even one fold)");
  } else {
    for (const fold of result.walkForwardFolds) {
      console.log(
        `  train ${fold.trainStart.slice(0, 10)}..${fold.trainEnd.slice(0, 10)} (n=${fold.model.trainedRows}) ` +
          `test ${fold.testStart.slice(0, 10)}..${fold.testEnd.slice(0, 10)} (n=${fold.metrics.rows}) ` +
          `brier=${fmt(fold.metrics.brier)} logLoss=${fmt(fold.metrics.logLoss)} observedRate=${fmt(fold.metrics.observedRate)} meanPred=${fmt(fold.metrics.meanPrediction)}`,
      );
    }
  }

  console.log(`\n── FINAL TERM MODEL ─────────────────────────────────────────`);
  console.log(`  trainedRows=${result.finalTermModel.trainedRows} intercept=${fmt(result.finalTermModel.intercept)} l2=${result.finalTermModel.l2}`);
  for (const key of result.featureKeys) {
    console.log(`    ${key.padEnd(24)} ${fmt(result.finalTermModel.coefficients[key])}`);
  }

  console.log(`\n── CALIBRATOR ────────────────────────────────────────────────`);
  console.log(`  sufficientData=${result.calibrator.sufficientData} a=${fmt(result.calibrator.a)} b=${fmt(result.calibrator.b)} trainedRows=${result.calibrator.trainedRows}`);

  if (result.holdoutMetrics) {
    console.log(`\n── HELD-OUT METRICS (${result.holdoutMetrics.rows} rows, ${result.holdoutMetrics.window.start?.slice(0, 10)}..${result.holdoutMetrics.window.end?.slice(0, 10)}) ──`);
    console.log(`  raw        brier=${fmt(result.holdoutMetrics.raw.brier)} logLoss=${fmt(result.holdoutMetrics.raw.logLoss)}`);
    console.log(`  calibrated brier=${fmt(result.holdoutMetrics.calibrated.brier)} logLoss=${fmt(result.holdoutMetrics.calibrated.logLoss)}`);
  } else {
    console.log(`\n── HELD-OUT METRICS ─────────────────────────────────────────`);
    console.log(`  UNAVAILABLE — ${rows.length} rows is not enough for a real three-way chronological split.`);
    console.log(`  The reported term model and calibrator are fit on all available data (in-sample),`);
    console.log(`  not out-of-sample validated. Not fabricated as if they were held out.`);
  }

  if (args.write) {
    const trainedAtIso = new Date().toISOString();
    const modelVersion = args.modelVersion ?? defaultPlateHrV2ModelVersion(trainedAtIso);
    const metrics: Record<string, number> = {};
    if (result.holdoutMetrics) {
      metrics.holdoutBrierRaw = result.holdoutMetrics.raw.brier;
      metrics.holdoutLogLossRaw = result.holdoutMetrics.raw.logLoss;
      metrics.holdoutBrierCalibrated = result.holdoutMetrics.calibrated.brier;
      metrics.holdoutLogLossCalibrated = result.holdoutMetrics.calibrated.logLoss;
    }
    const lastFold = result.walkForwardFolds[result.walkForwardFolds.length - 1];
    if (lastFold) {
      metrics.lastFoldBrier = lastFold.metrics.brier;
      metrics.lastFoldLogLoss = lastFold.metrics.logLoss;
    }

    const artifact = buildPlateHrV2ModelArtifact({
      modelVersion,
      featureKeys: result.featureKeys,
      termModel: result.finalTermModel,
      calibrator: result.calibrator,
      trainingWindowStart: result.finalTermModelSampleWindow.start,
      trainingWindowEnd: result.finalTermModelSampleWindow.end,
      holdoutWindowStart: result.holdoutMetrics?.window.start ?? null,
      holdoutWindowEnd: result.holdoutMetrics?.window.end ?? null,
      sampleSize: result.totalRows,
      metrics,
      trainedAtIso,
    });

    const inserted = await storage.insertPlateHrV2ModelArtifact(toInsertPlateHrV2ModelRegistryRow(artifact));
    console.log(`\n── MODEL ARTIFACT ───────────────────────────────────────────`);
    console.log(`  modelVersion=${artifact.modelVersion} status=${artifact.status} checksum=${artifact.checksum}`);
    console.log(inserted ? "  written to plate_hr_v2_model_registry" : "  NOT written — a row for this modelVersion already exists (immutable identity)");
  } else {
    console.log("\n── MODEL ARTIFACT ───────────────────────────────────────────");
    console.log("  not written (pass --write to persist a status:\"candidate\" row to plate_hr_v2_model_registry)");
  }

  console.log("\n[PLATE_HR_V2_BACKTEST] DONE");
  process.exit(0);
}

main().catch((err) => {
  console.error("[PLATE_HR_V2_BACKTEST] FATAL:", err);
  process.exit(1);
});
