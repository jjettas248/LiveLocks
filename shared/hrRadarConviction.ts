/**
 * HR Radar — Conviction-aware display caps.
 *
 * SAFE ADDITIVE display layer. Never mutates the engine, never affects
 * grading, never changes section placement, never persists to storage.
 *
 * Background — dual-engine disagreement
 * --------------------------------------
 * The HR Radar produces two parallel scoring signals per row:
 *
 *   System A — `evaluateHRAlert` decides the alert level
 *     (`WATCH | PREPARE | BET_NOW`) and emits an `alertPath`. Some paths
 *     are explicitly locked to WATCH and confidence-capped — most notably
 *     `PATH_F_BLOCKED_BRIDGE`, which surfaces a moderate-conviction
 *     batter but caps `confidenceScore` at 6/10.
 *
 *   System B — the dynamic state machine in `hrAlertEngine.ts`
 *     accumulates `hrReadinessScore` (0-100) over ticks with decay. It
 *     can reach 70-90 transiently for a power-formation player even when
 *     System A keeps the row at WATCH.
 *
 * The user-facing card had been rendering System B's number divided by
 * 10 as the headline ("7.6/10") while sitting in the Track section,
 * which is decided by System A. The disagreement reads to users as
 * "the radar is broken." The engine isn't wrong — it's two engines
 * speaking at once.
 *
 * The cap below makes the headline number reflect System A's actual
 * conviction ceiling for the alert path the engine chose. The raw
 * `currentReadinessScore` / `peakReadinessScore` (0-100) are still
 * available on every row for the admin/debug sub-row and harness
 * invariants — only the prominent /10 number is capped.
 *
 * If a future alert path needs a similar cap, add it to the table and
 * both server enrichment + client renderers pick it up automatically.
 */

/**
 * Pregame seed cap (0–100 readiness scale) for presence-floor HR Radar rows.
 * A presence-only row is a pre-/early-contact power threat seeded from the
 * season power profile so the card reflects the batter instead of showing 0.0.
 * The cap sits BELOW the in-game "ready" floor (75) and the "attack" band so a
 * pure pregame seed can never masquerade as a fired/qualified signal — grading
 * detection stays gated on real in-game contact. Shared so the engine
 * (orchestrator), the persistence layer (storage), and any display clamp all
 * agree on the same ceiling.
 */
export const PREGAME_SEED_CAP = 55;

/**
 * Display-only tier label "lift" for a pregame-seeded presence row, derived
 * purely from the seeded /10 score. This is presentational ONLY: it never
 * touches `canonicalStage`, `confidenceTier`, section placement, or grading —
 * a presence row stays in the watch section and grades as before. Returns null
 * for a weak/absent seed so callers fall back to the canonical tier label.
 * Deterministic formatting of a server-stamped value (safe to call on either
 * side; not an invented display-contract field).
 */
export function pregameSeedTierLabel(seedScore10: number | null | undefined): string | null {
  if (seedScore10 == null || !Number.isFinite(seedScore10)) return null;
  if (seedScore10 >= 4.5) return "LEAN";
  if (seedScore10 >= 3.0) return "WATCH";
  return null;
}

export interface ConvictionDisplayBadge {
  /** Short pill label (≤ 22 chars). */
  label: string;
  /** One-sentence description for the detail modal / tooltip. */
  description: string;
}

interface ConvictionPathRule {
  /** Display ceiling in /10 units (engine's actual conviction cap). */
  ceiling10: number;
  /** Optional pill metadata to render when this path applies. */
  badge: ConvictionDisplayBadge | null;
}

/**
 * Per-`alertPath` cap table. Keep this list short and engine-faithful —
 * each entry must mirror an actual cap or hard-locked level inside
 * `evaluateHRAlert`. If the engine changes a path's cap, update here.
 */
const CONVICTION_PATH_RULES: Record<string, ConvictionPathRule> = {
  // PATH_F_BLOCKED_BRIDGE: caps confidenceScore at 6 and forces level=WATCH
  // (server/mlb/evaluateHRAlert.ts L963-1010). Power profile present, build
  // score below qualifying threshold.
  PATH_F_BLOCKED_BRIDGE: {
    ceiling10: 6.0,
    badge: {
      label: "Power profile · capped",
      description:
        "Engine sees a power profile but has not qualified this as a fire signal. The headline score is capped at the engine's actual conviction ceiling (6.0/10) instead of raw dynamic readiness, which can climb higher transiently.",
    },
  },
};

/**
 * Returns the /10 ceiling the engine's conviction supports for the given
 * alert path. Returns `null` for paths with no cap (the common case).
 */
export function convictionDisplayCeiling10(
  alertPath: string | null | undefined,
): number | null {
  if (!alertPath) return null;
  const rule = CONVICTION_PATH_RULES[alertPath];
  return rule ? rule.ceiling10 : null;
}

/**
 * Applies the conviction cap to a /10 score. Pure — no rounding changes,
 * just `min(score, ceiling)`. Pass-through when no cap applies.
 */
export function applyConvictionCap10(
  score10: number | null | undefined,
  alertPath: string | null | undefined,
): number | null {
  if (score10 == null || !Number.isFinite(score10)) return score10 ?? null;
  const ceil = convictionDisplayCeiling10(alertPath);
  if (ceil == null) return score10;
  return Math.min(score10, ceil);
}

/**
 * Pill metadata for capped rows so the UI can communicate WHY the
 * displayed number is lower than the raw readiness number a power user
 * might inspect in the admin sub-row.
 */
export function convictionDisplayBadge(
  alertPath: string | null | undefined,
): ConvictionDisplayBadge | null {
  if (!alertPath) return null;
  const rule = CONVICTION_PATH_RULES[alertPath];
  return rule?.badge ?? null;
}

/**
 * Convenience — returns true when the row's display score is being
 * capped below its raw readiness value. Useful for conditional pill
 * rendering on the client without re-running the cap math.
 */
export function isConvictionCapped(
  rawScore10: number | null | undefined,
  alertPath: string | null | undefined,
): boolean {
  if (rawScore10 == null || !Number.isFinite(rawScore10)) return false;
  const ceil = convictionDisplayCeiling10(alertPath);
  if (ceil == null) return false;
  return rawScore10 > ceil + 1e-6;
}
