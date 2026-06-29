// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW: starter + bullpen path → log-odds term
//
// Pure. Secondary signal: the bullpen the batter is likely to face. Weighted by
// the share of projected PA expected vs the bullpen, so a deep starter mutes it.
// Bullpen must NOT dominate candidate creation (task §M) — hence the small cap.
// No-op when no bullpen vulnerability data is present.
// ─────────────────────────────────────────────────────────────────────────────

import type { StarterBullpenPathInputs, LogOddsTerm } from "./mathTypes";
import { signed, clamp, clamp01 } from "./normalizeStats";

export const STARTER_BULLPEN_CAP = 0.20;

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
