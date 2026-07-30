// Mound Radar V2 (shadow) — durable evaluation-job enqueue (Final Pre-Push
// Integrity Pass). Storage-touching. This is the ENTIRE synchronous
// obligation buildMlbMoundRadar.ts's per-pitcher build loop has toward V2:
// one bounded, idempotent INSERT. No evaluation (computeMoundV2Distribution,
// checkMoundV1Parity, decision-policy application) happens here or in the
// caller — that all happens later, in moundV2ShadowWorker.ts, on a fully
// independent tick.
//
// EvaluateMoundV2ShadowArgs (the frozen-input args + V1's captured scores)
// is JSON-serialized as-is into the job payload — Date fields become ISO
// strings. Deserializing and re-hydrating those Dates is the worker's job
// (see moundV2ShadowJobQueue.ts's sibling deserializeMoundV2ShadowJobPayload,
// exported from here too since both enqueue and claim/replay need the exact
// same (de)serialization contract).

import { storage } from "../../../../storage";
import type { EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";
import type { MoundV2ShadowJobRow } from "@shared/schema";

export interface MoundV2ShadowJobPayload {
  signalId: string;
  evaluateArgs: {
    snapshotId: string;
    now: string; // ISO
    frozenInputArgs: EvaluateMoundV2ShadowArgs["frozenInputArgs"];
    productionComponentScores: EvaluateMoundV2ShadowArgs["productionComponentScores"];
    v1Score10: number | null;
    v1Tier: string | null;
    v1RecommendedSide: "OVER" | "UNDER" | null;
    v1QualificationStatus: EvaluateMoundV2ShadowArgs["v1QualificationStatus"];
    strikeoutsLine?: number | null;
    outsLine?: number | null;
  };
}

export function serializeMoundV2ShadowJobPayload(args: {
  signalId: string;
  evaluateArgs: EvaluateMoundV2ShadowArgs;
}): MoundV2ShadowJobPayload {
  return {
    signalId: args.signalId,
    evaluateArgs: {
      snapshotId: args.evaluateArgs.snapshotId,
      now: args.evaluateArgs.now.toISOString(),
      frozenInputArgs: args.evaluateArgs.frozenInputArgs,
      productionComponentScores: args.evaluateArgs.productionComponentScores,
      v1Score10: args.evaluateArgs.v1Score10,
      v1Tier: args.evaluateArgs.v1Tier,
      v1RecommendedSide: args.evaluateArgs.v1RecommendedSide,
      v1QualificationStatus: args.evaluateArgs.v1QualificationStatus,
      strikeoutsLine: args.evaluateArgs.strikeoutsLine,
      outsLine: args.evaluateArgs.outsLine,
    },
  };
}

/** Inverse of serializeMoundV2ShadowJobPayload — rehydrates the `now`/`scheduledGameTime` ISO strings back into real Date objects so evaluateMoundV2Shadow (which expects `now: Date`) runs identically to how it would have at enqueue time. */
export function deserializeMoundV2ShadowJobPayload(payload: MoundV2ShadowJobPayload): {
  signalId: string;
  evaluateArgs: EvaluateMoundV2ShadowArgs;
} {
  return {
    signalId: payload.signalId,
    evaluateArgs: {
      snapshotId: payload.evaluateArgs.snapshotId,
      now: new Date(payload.evaluateArgs.now),
      frozenInputArgs: payload.evaluateArgs.frozenInputArgs,
      productionComponentScores: payload.evaluateArgs.productionComponentScores,
      v1Score10: payload.evaluateArgs.v1Score10,
      v1Tier: payload.evaluateArgs.v1Tier,
      v1RecommendedSide: payload.evaluateArgs.v1RecommendedSide,
      v1QualificationStatus: payload.evaluateArgs.v1QualificationStatus,
      strikeoutsLine: payload.evaluateArgs.strikeoutsLine,
      outsLine: payload.evaluateArgs.outsLine,
    },
  };
}

export interface MoundV2ShadowEnqueueResult {
  enqueued: boolean;
  /** true when a job for this exact snapshotId already existed — idempotent no-op, never an error. */
  alreadyEnqueued: boolean;
  jobId: string;
}

/**
 * The durable handoff. A single idempotent INSERT — never evaluates V2,
 * never blocks on anything beyond one bounded database round trip. Never
 * throws (defense in depth; the caller in buildMlbMoundRadar.ts also wraps
 * this in its own try/catch, exactly like the former runMoundV2ShadowForPitcher).
 */
export async function enqueueMoundV2ShadowJob(args: {
  signalId: string;
  evaluateArgs: EvaluateMoundV2ShadowArgs;
}): Promise<MoundV2ShadowEnqueueResult> {
  const jobId = `${args.evaluateArgs.snapshotId}:job`;
  try {
    const payload = serializeMoundV2ShadowJobPayload(args);
    const inserted = await storage.enqueueMoundV2ShadowJob({
      jobId,
      snapshotId: args.evaluateArgs.snapshotId,
      gameId: args.evaluateArgs.frozenInputArgs.gameId,
      pitcherId: args.evaluateArgs.frozenInputArgs.pitcherId,
      signalId: args.signalId,
      payload: payload as unknown as Record<string, unknown>,
      status: "pending",
    });
    if (inserted) {
      return { enqueued: true, alreadyEnqueued: false, jobId };
    }
    // ON CONFLICT DO NOTHING fired -- a job for this snapshotId already exists.
    return { enqueued: false, alreadyEnqueued: true, jobId };
  } catch (err: unknown) {
    console.warn(
      `[MOUND_V2_SHADOW_ENQUEUE_FAILED] ${args.signalId} snapshotId=${args.evaluateArgs.snapshotId}:`,
      err instanceof Error ? err.message : err,
    );
    return { enqueued: false, alreadyEnqueued: false, jobId };
  }
}

export type { MoundV2ShadowJobRow };
