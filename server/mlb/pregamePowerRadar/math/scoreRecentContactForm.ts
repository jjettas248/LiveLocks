// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: stabilized recent-contact form → log-odds term
//
// Pure. Converts the PR5 stabilized recent-contact-form features (a
// reliability-blended aggregate over the most-recent BBE window — NOT a raw
// streak) into a single capped, batter-INTRINSIC log-odds delta. Because it is a
// property of the hitter and not the opponent, this term applies to EVERY PA
// segment (starter AND bullpen) in the segmented builder.
//
// Recent power form enters ONLY through measured contact quality (EV / EV90 /
// air% / barrel%). There is deliberately NO home-run-count or HR/FB input — recent
// HRs can never lift this term (mirrors the PR5 leakage boundary). Absent features
// are ignored (no-op); the term is scaled by the effective BBE backing the window
// so a thin/uncertain window degrades toward no-op instead of swinging the model.
//
// League reference midpoints below are documented DEFAULT PRIORS (approx. recent
// MLB averages), NOT fitted parameters (fitting is deferred to PR8).
// ─────────────────────────────────────────────────────────────────────────────

import type { RecentContactFormTermInputs, LogOddsTerm } from "./mathTypes";
import { signed, weightedMean } from "./normalizeStats";
import { shrinkWeight } from "./shrinkRates";

/** Max absolute log-odds this component may contribute. */
export const RECENT_CONTACT_FORM_CAP = 0.25;

/** Effective-BBE stabilization point for the recent-form window reliability weight. */
export const RECENT_FORM_STABILIZATION_BBE = 30;

export function scoreRecentContactForm(
  inp: RecentContactFormTermInputs | null | undefined,
): LogOddsTerm {
  if (!inp) return { key: "recentContactForm", logOdds: 0, available: false, shrinkWeight: 0 };

  // Signed [-1,1] features centered on league-average reference (lo, mid, hi).
  const parts: Array<{ value: number | null; weight: number }> = [
    { value: feat(inp.recentFormBarrelPct, 2, 8, 16), weight: 3 },
    { value: feat(inp.recentFormEv90, 98, 104, 110), weight: 2 },
    { value: feat(inp.recentFormAvgEv, 85, 89, 94), weight: 2 },
    { value: feat(inp.recentFormAirPct, 25, 40, 55), weight: 1 },
  ];

  const { value: composite, coverage } = weightedMean(parts);
  if (composite == null || coverage === 0) {
    return { key: "recentContactForm", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  // Reliability weight from the effective BBE backing the window. A thin window
  // (few BBE) is untrustworthy and shrinks the contribution toward no-op. When
  // the effective count is unknown, use a conservative mid-trust default.
  const w =
    inp.effectiveBbe != null
      ? shrinkWeight(inp.effectiveBbe, RECENT_FORM_STABILIZATION_BBE)
      : 0.5;

  // Scale by feature coverage so a row with only one populated stat degrades
  // toward no-op instead of letting that lone signal claim the full cap.
  const logOdds = RECENT_CONTACT_FORM_CAP * composite * w * coverage;

  return {
    key: "recentContactForm",
    logOdds,
    available: true,
    shrinkWeight: w,
    note: `composite=${composite.toFixed(2)} cov=${coverage.toFixed(2)} w=${w.toFixed(2)}`,
  };
}

function feat(v: number | null, lo: number, mid: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return signed(v, lo, mid, hi);
}
