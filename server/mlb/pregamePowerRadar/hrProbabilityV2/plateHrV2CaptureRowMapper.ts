// Plate HR Probability V2 — pure row-shape mappers (PR 1).
//
// Deliberately separate from installPlateHrV2Capture.ts: these are pure data
// transformations with no I/O and no dependency on the storage/DB layer, so
// they stay independently unit-testable without importing server/storage.ts
// (which in turn imports server/db.ts, which throws at module load if
// DATABASE_URL is unset — a real constraint in DB-less environments, not
// something a pure mapper should be forced to inherit).

import type { InsertPlateHrV2FeatureSnapshot, InsertPlateHrV2SufficientStats } from "@shared/schema";
import type { PlateHrV2CaptureRow, PlateHrV2SufficientStatsCaptureRow } from "./plateHrV2ForwardCapture";

export function toInsertFeatureSnapshot(row: PlateHrV2CaptureRow): InsertPlateHrV2FeatureSnapshot {
  return {
    snapshotId: row.snapshotId,
    sessionDate: row.sessionDate,
    gameId: row.gameId,
    batterId: row.batterId,
    batterName: row.batterName,
    team: row.team,
    opponent: row.opponent,
    pitcherId: row.pitcherId,
    pitcherName: row.pitcherName,
    battingOrderSlot: row.battingOrderSlot,
    buildId: row.buildId,
    firstCapturedAt: new Date(row.firstCapturedAtIso),
    lastCapturedAt: new Date(row.lastCapturedAtIso),
    firstPitchTime: row.firstPitchTimeIso ? new Date(row.firstPitchTimeIso) : null,
    firstPitchLockEligible: row.firstPitchLockEligible,
    gameStatus: row.gameStatus,
    predictionAsOf: new Date(row.predictionAsOfIso),
    secondsToFirstPitch: row.secondsToFirstPitch,
    lineupConfirmedAt: row.lineupConfirmedAtIso ? new Date(row.lineupConfirmedAtIso) : null,
    starterConfirmed: row.starterConfirmed,
    // Correction 3: locked the instant the row is no longer pregame — the
    // storage-layer WHERE guard (lockedAt IS NULL) is the real enforcement;
    // this just stamps the marker on first write of a non-pregame status.
    lockedAt: row.gameStatus !== "scheduled" && row.gameStatus !== "pre" && row.gameStatus !== "unknown"
      ? new Date(row.lastCapturedAtIso)
      : null,
    inputContractVersion: row.inputContractVersion,
    rawInputs: row.rawInputs,
    featureVersion: row.featureVersion,
    featureHash: row.inputHash,
    derivedFeatures: row.derivedFeatures,
    availability: row.availability,
    featureFreshness: row.featureFreshness,
    leakageWarnings: row.leakageWarnings,
    sufficientStatsRef: row.sufficientStatsRef,
    championModelVersion: row.championModelVersion,
    championScore10: String(row.championScore10),
    championTier: row.championTier,
    championSuppressed: row.championSuppressed,
  };
}

export function toInsertSufficientStats(row: PlateHrV2SufficientStatsCaptureRow): InsertPlateHrV2SufficientStats {
  return {
    statsId: row.statsId,
    entityType: row.entityType,
    entityId: row.entityId,
    asOfDate: row.asOfDate,
    pitchesSeen: row.raw.pitchesSeen,
    swings: row.raw.swings,
    whiffs: row.raw.whiffs,
    calledStrikes: row.raw.calledStrikes,
    balls: row.raw.balls,
    zoneSwings: row.raw.zoneSwings,
    zoneTakes: row.raw.zoneTakes,
    chaseSwings: row.raw.chaseSwings,
    chaseTakes: row.raw.chaseTakes,
    zoneDataAvailable: row.raw.zoneDataAvailable,
    paCount: row.raw.paCount,
    strikeouts: row.raw.strikeouts,
    walks: row.raw.walks,
    battedBallEvents: row.raw.battedBallEvents,
    pitchFamilyStats: row.raw.pitchFamilyStats,
    pitchTypeStats: row.raw.pitchTypeExactStats,
    evPercentiles: row.raw.evPercentiles,
    laPercentiles: row.raw.laPercentiles,
    pulledBip: row.raw.pulledBip,
    sprayClassifiedBip: row.raw.sprayClassifiedBip,
    sourceRowCount: row.raw.sourceRowCount,
  };
}
