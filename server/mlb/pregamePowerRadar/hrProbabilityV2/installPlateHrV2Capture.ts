// Plate HR Probability V2 — wires the forward-capture sinks to durable
// storage. Mirrors server/mlb/pregamePowerRadar/pregamePersistence.ts's
// installPregamePersistence() pattern, but as its own file rather than an
// edit to that one, so the champion's persistence wiring stays untouched.
//
// Called once from server/index.ts, alongside ensurePlateHrV2PersistenceSchema.
// Registering the sinks does not itself write anything — capture only ever
// produces rows when PLATE_HR_V2_FORWARD_CAPTURE_ENABLED is set (see
// plateHrV2CaptureFlags.ts), so an idle deployment with this installed but
// the flag unset writes zero rows, exactly like before this file existed.
//
// The actual row-shape mapping is pure and lives in
// plateHrV2CaptureRowMapper.ts (no storage/DB import) — this file is only
// the I/O wiring on top of it.

import { storage } from "../../../storage";
import {
  setPlateHrV2CaptureSink,
  setPlateHrV2SufficientStatsSink,
} from "./plateHrV2ForwardCapture";
import { toInsertFeatureSnapshot, toInsertSufficientStats } from "./plateHrV2CaptureRowMapper";
import { persistPlateHrV2SnapshotWrites } from "./plateHrV2SnapshotCapture";

/** Registers both capture sinks. Idempotent — safe to call once at boot. */
export function installPlateHrV2CapturePersistence(): void {
  setPlateHrV2CaptureSink(async (rows) => {
    for (const row of rows) {
      await storage.upsertPlateHrV2FeatureSnapshot(toInsertFeatureSnapshot(row));
    }
    // PR3: also append the two-layer point-in-time snapshot (source evidence +
    // prediction). persistPlateHrV2SnapshotWrites NEVER throws — a snapshot
    // failure can never break the feature-snapshot capture above or the build.
    await persistPlateHrV2SnapshotWrites(rows, {
      insertSources: (s) => storage.insertPlateHrV2SourceEvidence(s),
      insertPrediction: (p) => storage.insertPlateHrV2PredictionSnapshot(p),
    });
  });
  setPlateHrV2SufficientStatsSink(async (rows) => {
    for (const row of rows) {
      await storage.upsertPlateHrV2SufficientStats(toInsertSufficientStats(row));
    }
  });
}
