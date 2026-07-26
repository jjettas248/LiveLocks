// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — label reconciliation orchestrator (PR 2).
//
// Thin: pull locked snapshots pending a label -> resolve each game's outcome
// once (memoized per gameId within this run) -> derive a label per snapshot
// -> write append-only. All the real decisions live in plateHrV2LabelRules.ts
// (pure) and plateHrV2OutcomeSource.ts (I/O) — this file only wires them.
//
// The real `storage` singleton is imported LAZILY (dynamic import, inside the
// function body, only when deps.storage isn't supplied) rather than at module
// scope. server/storage.ts imports server/db.ts, which throws at import time
// when DATABASE_URL is unset — a real constraint in DB-less test/sandbox
// environments (mirrors exactly why PR1 split plateHrV2CaptureRowMapper.ts
// out of installPlateHrV2Capture.ts). A plain `import type { IStorage }` is
// always fully erased by TypeScript regardless, so it costs nothing here.
// ─────────────────────────────────────────────────────────────────────────────

import type { IStorage } from "../../../storage";
import type { InsertPlateHrV2Label } from "@shared/schema";
import { PLATE_HR_V2_LABEL_V1, type PlateHrV2EvaluationLabelContract } from "./plateHrV2LabelContract";
import { derivePlateHrV2Label } from "./plateHrV2LabelRules";
import { resolvePlateHrV2GameOutcome, fetchMlbGameStatus } from "./plateHrV2OutcomeSource";

export interface PlateHrV2LabelReconcileArgs {
  labelVersion?: string;
  sessionDateFrom?: string;
  sessionDateTo?: string;
  limit?: number;
  nowIso?: string;
}

export interface PlateHrV2LabelReconcileSummary {
  scanned: number;
  resolved: number;
  censored: number;
  excluded: number;
  manualReview: number;
  skippedGameNotOverYet: number;
  inserted: number;
  alreadyLabeled: number;
}

type ReconcilerStorage = Pick<
  IStorage,
  "getPlateHrV2LockedSnapshotsPendingLabel" | "getGamePlayerStats" | "insertPlateHrV2LabelIfAbsent"
>;

function toInsertPlateHrV2Label(label: PlateHrV2EvaluationLabelContract): InsertPlateHrV2Label {
  return {
    snapshotId: label.snapshotId,
    labelVersion: label.labelVersion,
    labelDisposition: label.labelDisposition,
    resolvedAt: label.resolvedAt ? new Date(label.resolvedAt) : null,
    resolutionReason: label.resolutionReason,
    hitHrToday: label.hitHrToday,
    paCountObserved: label.paCountObserved,
    hrCountToday: label.hrCountToday,
    hrEventId: label.hrEventId,
    hrInning: label.hrInning,
    hrHalf: label.hrHalf,
    hrPlateAppearanceNumber: label.hrPlateAppearanceNumber,
    hrFirstAb: label.hrFirstAb,
    labelSource: label.labelSource,
    dataQuality: label.dataQuality,
  };
}

export async function reconcilePlateHrV2Labels(
  args: PlateHrV2LabelReconcileArgs,
  deps?: { storage?: ReconcilerStorage; fetchGameStatus?: typeof fetchMlbGameStatus },
): Promise<PlateHrV2LabelReconcileSummary> {
  const storageImpl: ReconcilerStorage = deps?.storage ?? (await import("../../../storage")).storage;
  const labelVersion = args.labelVersion ?? PLATE_HR_V2_LABEL_V1;
  const nowIso = args.nowIso ?? new Date().toISOString();

  const pending = await storageImpl.getPlateHrV2LockedSnapshotsPendingLabel(labelVersion, {
    sessionDateFrom: args.sessionDateFrom,
    sessionDateTo: args.sessionDateTo,
    limit: args.limit,
  });

  const summary: PlateHrV2LabelReconcileSummary = {
    scanned: pending.length,
    resolved: 0,
    censored: 0,
    excluded: 0,
    manualReview: 0,
    skippedGameNotOverYet: 0,
    inserted: 0,
    alreadyLabeled: 0,
  };

  const byGame = new Map<string, typeof pending>();
  for (const snapshot of pending) {
    const list = byGame.get(snapshot.gameId) ?? [];
    list.push(snapshot);
    byGame.set(snapshot.gameId, list);
  }

  for (const [gameId, snapshots] of Array.from(byGame.entries())) {
    const bundle = await resolvePlateHrV2GameOutcome(gameId, {
      getGamePlayerStats: (gid) => storageImpl.getGamePlayerStats(gid),
      fetchGameStatus: deps?.fetchGameStatus,
    });

    // A game that hasn't reached a stable terminal state yet is never
    // labeled by this run — it's simply left pending for a future
    // reconciliation. This deliberately includes "suspended", not just
    // "in_progress"/"unknown": labels are append-only (insertPlateHrV2LabelIfAbsent
    // is onConflictDoNothing, and getPlateHrV2LockedSnapshotsPendingLabel
    // excludes any snapshot that already has ANY label row for this
    // labelVersion, regardless of disposition). A suspended game resumes
    // under the SAME gamePk and will typically reach a real "final" later —
    // writing a premature censored/game_suspended_unresolved label now would
    // permanently foreclose ever learning the real outcome once it resumes,
    // since no mechanism here ever revisits an already-labeled snapshot.
    // "postponed" is different and safe to label immediately: a postponed
    // game's makeup (if any) is a separate gameId/gamePk with its own
    // independent capture cycle, not a resumption of this same game.
    if (
      bundle.game.gameStatus === "in_progress" ||
      bundle.game.gameStatus === "unknown" ||
      bundle.game.gameStatus === "suspended"
    ) {
      summary.skippedGameNotOverYet += snapshots.length;
      continue;
    }

    for (const snapshot of snapshots) {
      const batterFact = bundle.batters.get(snapshot.batterId) ?? null;
      const label = derivePlateHrV2Label({
        snapshotId: snapshot.snapshotId,
        labelVersion,
        gameId: snapshot.gameId,
        batterId: snapshot.batterId,
        nowIso,
        game: bundle.game,
        batter: batterFact,
        anyBoxScoreRowsForGame: bundle.anyBoxScoreRowsForGame,
      });

      if (label.labelDisposition === "resolved") summary.resolved++;
      else if (label.labelDisposition === "censored") summary.censored++;
      else if (label.labelDisposition === "excluded") summary.excluded++;
      else summary.manualReview++;

      const inserted = await storageImpl.insertPlateHrV2LabelIfAbsent(toInsertPlateHrV2Label(label));
      if (inserted) summary.inserted++;
      else summary.alreadyLabeled++;
    }
  }

  return summary;
}
