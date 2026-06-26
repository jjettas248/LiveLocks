// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: pre-game PA distribution
//
// Pure. Estimates P(plate appearances = n) for a hitter given their batting-order
// slot (and, optionally, the team's implied run total which nudges turnover).
// Returns a discrete distribution over n ∈ {2..6} that SUMS TO 1.
//
// Slot→expected-PA anchors are documented DEFAULT PRIORS (top of order sees more
// PA). The distribution is a normalized Gaussian kernel around the expected mean
// so mass shifts upward monotonically as expected PA rises.
// ─────────────────────────────────────────────────────────────────────────────

import { clamp } from "./normalizeStats";

const PA_BINS = [2, 3, 4, 5, 6] as const;
const KERNEL_SIGMA = 0.85;

/** Expected PA for a batting-order slot (1–9). Documented prior. */
export function expectedPaForSlot(slot: number | null | undefined): number {
  if (slot == null || !Number.isFinite(slot)) return 4.1; // unknown slot → league-ish mean
  const s = clamp(Math.round(slot), 1, 9);
  // Leadoff ~4.65 PA, #9 ~3.85 PA — roughly linear.
  return 4.65 - (s - 1) * 0.1;
}

/**
 * Distribution over PA bins {2..6} for a hitter. `teamImpliedRuns` optionally
 * shifts the mean up slightly (more offense → more turnover → more PA).
 * Always returns a normalized distribution (keys are stringified bin counts).
 */
export function estimatePregamePaDistribution(args: {
  battingOrderSlot: number | null | undefined;
  teamImpliedRuns?: number | null;
}): { distribution: Record<string, number>; expectedPA: number } {
  let mean = expectedPaForSlot(args.battingOrderSlot);

  // Run-environment nudge: ±0.25 PA across a 3.2→6.0 implied-run span.
  if (args.teamImpliedRuns != null && Number.isFinite(args.teamImpliedRuns)) {
    const t = clamp((args.teamImpliedRuns - 4.4) / (6.0 - 3.2), -1, 1);
    mean += t * 0.25;
  }
  mean = clamp(mean, 3.4, 5.0);

  // Gaussian kernel over discrete bins, then normalize.
  const raw = PA_BINS.map((n) => Math.exp(-((n - mean) ** 2) / (2 * KERNEL_SIGMA ** 2)));
  const total = raw.reduce((a, b) => a + b, 0);

  const distribution: Record<string, number> = {};
  let expectedPA = 0;
  PA_BINS.forEach((n, i) => {
    const p = raw[i] / total;
    distribution[String(n)] = p;
    expectedPA += n * p;
  });

  return { distribution, expectedPA };
}
