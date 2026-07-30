// Mound Radar V2 (shadow) — never-throws enqueue wrapper (Final Pre-Push
// Integrity Pass). Called from buildMlbMoundRadar.ts's per-pitcher loop.
// Replaces the former moundV2ShadowRunner.ts, which wrapped a SYNCHRONOUS
// evaluate+record call — now that evaluation happens entirely in
// moundV2ShadowWorker.ts on its own tick, the only thing left to wrap here
// is the durable enqueue itself (one bounded, idempotent INSERT).
//
// Awaited by the caller (unlike the old runner) — the enqueue IS the
// "bounded durable handoff" the required architecture explicitly allows to
// stay in the publication-critical path, precisely because it is fast and
// simple (a single INSERT), never the actual V2 computation. Still never
// throws: a database hiccup during enqueue must never propagate into V1's
// build loop, so this has its own top-level try/catch in addition to
// enqueueMoundV2ShadowJob's own internal one (defense in depth for the
// construction that happens here, e.g. the args object itself).

import { enqueueMoundV2ShadowJob, type MoundV2ShadowEnqueueResult } from "./moundV2ShadowJobQueue";
import type { EvaluateMoundV2ShadowArgs } from "./moundV2ShadowEvaluation";

export interface MoundV2ShadowEnqueueDeps {
  enqueue?: (args: { signalId: string; evaluateArgs: EvaluateMoundV2ShadowArgs }) => Promise<MoundV2ShadowEnqueueResult>;
}

/**
 * Never throws. Returns the enqueue outcome for observability/logging only —
 * the caller (buildMlbMoundRadar.ts) never branches its own behavior on the
 * return value; V1's signal is already fully assembled before this runs and
 * is published regardless of what this returns.
 */
export async function enqueueMoundV2ShadowForPitcher(
  args: { signalId: string; evaluateArgs: EvaluateMoundV2ShadowArgs },
  deps: MoundV2ShadowEnqueueDeps = {},
): Promise<MoundV2ShadowEnqueueResult | null> {
  const enqueue = deps.enqueue ?? enqueueMoundV2ShadowJob;
  try {
    const result = await enqueue(args);
    if (!result.enqueued && !result.alreadyEnqueued) {
      console.warn(`[MOUND_V2_SHADOW_ENQUEUE_FAILURE] ${args.signalId} jobId=${result.jobId}`);
    }
    return result;
  } catch (err: unknown) {
    console.warn(`[MOUND_V2_SHADOW_ENQUEUE_UNEXPECTED_ERROR] ${args.signalId}`, err instanceof Error ? err.message : err);
    return null;
  }
}
