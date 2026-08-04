// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: starter + bullpen path → log-odds term
//
// Pure. Secondary signal: the bullpen the batter is likely to face.
//
// TWO consumers, TWO shapes:
//   • `scoreStarterBullpenPath` (LEGACY single-path model) folds the bullpen
//     vulnerability × exposure share into ONE log-odds delta on a single per-PA
//     rate. Retained for backward compatibility (legacy diagnostics).
//   • `scoreBullpenVulnerability` (PR6 corrected joint model) returns the bullpen
//     vulnerability as a PURE opponent log-odds term with NO exposure multiplier.
//     Exposure is no longer baked into the log-odds — it lives in the joint
//     (n_s, n_b) PA-path (estimatePregamePaPath.ts), so a deep starter mutes the
//     bullpen by giving the bullpen segment little PA mass, not by shrinking p_b.
//     This is the §11 double-count fix: exposure is applied exactly once, in the
//     PA-path, and never also inside the per-PA rate.
//
// No-op when no bullpen vulnerability data is present.
// ─────────────────────────────────────────────────────────────────────────────

import type { StarterBullpenPathInputs, LogOddsTerm } from "./mathTypes";
import { signed, clamp, clamp01 } from "./normalizeStats";

export const STARTER_BULLPEN_CAP = 0.20;

/** Max absolute log-odds the pure bullpen-vulnerability opponent term may contribute. */
export const BULLPEN_VULNERABILITY_CAP = 0.20;

/**
 * PR6 — pure expected-bullpen vulnerability opponent term (NO exposure weighting).
 * Consumed ONLY by the bullpen segment (p_b) of the segmented builder; exposure is
 * handled by the joint PA-path. Composite is the same HR/9 + barrel-allowed blend
 * as the legacy path, minus the exposure multiplier. No-op when data absent.
 */
export function scoreBullpenVulnerability(
  inp: StarterBullpenPathInputs | null | undefined,
): LogOddsTerm {
  const composite = bullpenVulnerabilityComposite(inp);
  if (composite == null) {
    return { key: "bullpenVulnerability", logOdds: 0, available: false, shrinkWeight: 0 };
  }
  const logOdds = BULLPEN_VULNERABILITY_CAP * composite;
  return {
    key: "bullpenVulnerability",
    logOdds,
    available: true,
    shrinkWeight: 1,
    note: `composite=${composite.toFixed(2)}`,
  };
}

/**
 * Shared bullpen-vulnerability composite in [-1,1] (HR/9 weighted 2, barrel
 * allowed weighted 1). Returns null when no bullpen data is present.
 */
function bullpenVulnerabilityComposite(
  inp: StarterBullpenPathInputs | null | undefined,
): number | null {
  if (!inp) return null;
  const parts: Array<{ value: number; weight: number }> = [];
  if (inp.bullpenHrPer9 != null && Number.isFinite(inp.bullpenHrPer9)) {
    parts.push({ value: signed(inp.bullpenHrPer9, 0.7, 1.25, 2.0), weight: 2 });
  }
  if (inp.bullpenBarrelAllowedPct != null && Number.isFinite(inp.bullpenBarrelAllowedPct)) {
    parts.push({ value: signed(inp.bullpenBarrelAllowedPct, 4, 8, 12), weight: 1 });
  }
  if (parts.length === 0) return null;
  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  return clamp(sum / wsum, -1, 1);
}

export function scoreStarterBullpenPath(
  inp: StarterBullpenPathInputs | null | undefined,
): LogOddsTerm {
  if (!inp) return { key: "starterBullpenPath", logOdds: 0, available: false, shrinkWeight: 0 };

  // Bullpen vulnerability composite (HR/9 + barrel allowed).
  const parts: Array<{ value: number; weight: number }> = [];
  if (inp.bullpenHrPer9 != null && Number.isFinite(inp.bullpenHrPer9)) {
    parts.push({ value: signed(inp.bullpenHrPer9, 0.7, 1.25, 2.0), weight: 2 });
  }
  if (inp.bullpenBarrelAllowedPct != null && Number.isFinite(inp.bullpenBarrelAllowedPct)) {
    parts.push({ value: signed(inp.bullpenBarrelAllowedPct, 4, 8, 12), weight: 1 });
  }
  if (parts.length === 0) {
    return { key: "starterBullpenPath", logOdds: 0, available: false, shrinkWeight: 0 };
  }

  let sum = 0;
  let wsum = 0;
  for (const p of parts) {
    sum += p.value * p.weight;
    wsum += p.weight;
  }
  const composite = clamp(sum / wsum, -1, 1);

  // Exposure weight: fraction of projected PA expected vs the bullpen.
  const vsPen = inp.projectedPaVsBullpen ?? null;
  const vsStarter = inp.projectedPaVsStarter ?? null;
  let exposure = 0.35; // default prior: ~1 of ~4 PA vs the pen
  if (vsPen != null && vsStarter != null && vsPen + vsStarter > 0) {
    exposure = clamp01(vsPen / (vsPen + vsStarter));
  }

  const logOdds = STARTER_BULLPEN_CAP * composite * exposure;

  return {
    key: "starterBullpenPath",
    logOdds,
    available: true,
    shrinkWeight: exposure,
    note: `composite=${composite.toFixed(2)} exposure=${exposure.toFixed(2)}`,
  };
}
