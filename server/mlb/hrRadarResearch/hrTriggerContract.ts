// ─────────────────────────────────────────────────────────────────────────────
// HR Radar Research — evaluation-epoch trigger contract (PR 1).
//
// Every batter evaluated from the same game-state event must share one
// `evaluationEpochId` (see shared/schema.ts hr_radar_evaluation_snapshots),
// since ranking cannot reliably group rows by evaluation_at alone (writes
// for the same epoch may land milliseconds apart). This contract defines the
// controlled vocabulary of what may cause a new evaluation epoch, and the
// minimal envelope describing "what caused this evaluation to fire" that a
// later PR's epoch detector (hrEvaluationEpoch.ts) will build against.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

export const HR_EVALUATION_TRIGGER_TYPES = [
  "live_state_entry_with_lineup",
  "pa_complete",
  "pitching_change",
  "lineup_substitution",
  "lineup_removal",
  "inning_half_transition",
  "weather_roof_change",
  "pitcher_state_change",
] as const;

export const hrTriggerTypeSchema = z.enum(HR_EVALUATION_TRIGGER_TYPES);
export type HrTriggerType = z.infer<typeof hrTriggerTypeSchema>;

export const hrEvaluationEpochContractSchema = z.object({
  evaluationEpochId: z.string().min(1),
  sourceRevision: z.number().int().min(0),
  triggerType: hrTriggerTypeSchema,
  sourceEventAt: z.string().nullable(),
  sourceEventId: z.string().nullable(),
  gameId: z.string().min(1),
  playSequence: z.number().int().nullable(),
});

export type HrEvaluationEpochContract = z.infer<typeof hrEvaluationEpochContractSchema>;
