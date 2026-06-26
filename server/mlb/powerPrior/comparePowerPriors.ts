// ─────────────────────────────────────────────────────────────────────────────
// comparePowerPriors — pure diagnostic comparing the canonical standalone prior
// against the current live inline prior. Computes NO scoring and mutates nothing.
//
// NOTE: the two priors measure related-but-different things — the standalone
// `score10` is a 0–10 composite power score; the inline `formScore` is a 0–100
// HR-shape form score. We normalize both onto the 0–10 scale and report the
// delta as a *divergence heuristic* for shadow observability, not as a claim
// that the two are the same metric.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  InlinePriorSnapshot,
  PowerPrior,
  PowerPriorComparison,
  PowerPriorComparisonSeverity,
} from "./types";

// Divergence thresholds on the 0–10 scale.
export const POWER_PRIOR_DELTA_LOW_MAX = 1.5; // [0, 1.5)   → low
export const POWER_PRIOR_DELTA_MEDIUM_MAX = 3.0; // [1.5, 3.0) → medium, ≥3.0 → high

/** Approximate a tier label from the inline 0–100 form score (debug-only). */
export function inlineFormScoreToApproxTier(formScore: number | null): string | null {
  if (formScore == null) return null;
  if (formScore >= 70) return "strong";
  if (formScore >= 58) return "watch";
  if (formScore >= 42) return "neutral";
  return "suppressed";
}

function severityForDelta(delta: number | null): PowerPriorComparisonSeverity {
  if (delta == null) return "none";
  if (delta < POWER_PRIOR_DELTA_LOW_MAX) return "low";
  if (delta < POWER_PRIOR_DELTA_MEDIUM_MAX) return "medium";
  return "high";
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Compare a canonical standalone `PowerPrior` against the inline prior snapshot.
 * Pure: neither argument is mutated. Severity is "none" when a delta cannot be
 * computed (e.g. no standalone signal, or the inline score is unavailable).
 */
export function comparePowerPriors(
  standalone: PowerPrior,
  inline: InlinePriorSnapshot,
): PowerPriorComparison {
  const notes: string[] = [];

  const standaloneScore10 = standalone.preGamePowerScore10;
  const inlineScore10 = inline.formScore != null ? round1(inline.formScore / 10) : null;

  if (standalone.source === "none") {
    notes.push("no_standalone_pregame_signal");
  }
  if (inline.formScore == null) {
    notes.push("inline_form_score_unavailable");
  }

  const absoluteDelta =
    standaloneScore10 != null && inlineScore10 != null
      ? round1(Math.abs(standaloneScore10 - inlineScore10))
      : null;

  const standaloneTier = standalone.preGameTier;
  const inlineTierApprox = inlineFormScoreToApproxTier(inline.formScore);

  const severity = severityForDelta(absoluteDelta);

  if (absoluteDelta != null && severity === "high") {
    notes.push("high_divergence");
  }
  if (
    standaloneTier != null &&
    inlineTierApprox != null &&
    standaloneTier !== inlineTierApprox
  ) {
    notes.push(`tier_mismatch:${standaloneTier}_vs_${inlineTierApprox}`);
  }
  notes.push("heuristic_cross_scale_comparison");

  return {
    playerId: standalone.playerId,
    gameId: standalone.gameId,
    standaloneScore10,
    inlineScore10,
    absoluteDelta,
    standaloneTier,
    inlineTierApprox,
    severity,
    notes,
  };
}
