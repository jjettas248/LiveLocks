// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — deterministic evaluation-epoch id (PR 2).
//
// Every batter evaluated from the same game-state event must share one
// evaluationEpochId (see hrTriggerContract.ts). Deterministic and stateless —
// no monotonic counter, no DB round-trip — so two independent detections of
// the same real-world event (a duplicate poll tick, a retried request)
// always produce the identical id. Combined with the DB's existing unique
// index (evaluation_epoch_id, player_id, feature_version, source_revision),
// duplicate detections collapse via ON CONFLICT DO NOTHING at the write
// layer instead of needing application-level dedup bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import type { HrTriggerType } from "./hrTriggerContract";

export function deriveEvaluationEpochId(
  gameId: string,
  triggerType: HrTriggerType,
  sourceEventId: string,
  sourceRevision: number,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${gameId}|${triggerType}|${sourceEventId}|${sourceRevision}`)
    .digest("hex");
  return `eph_${digest.slice(0, 40)}`;
}
