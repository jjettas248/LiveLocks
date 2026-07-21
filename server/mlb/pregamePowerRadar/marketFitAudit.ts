// Pre-Game Power Radar — primary-market fit audit (pure, no I/O, observability only).
//
// Flags when the server-stamped primaryMarket's OWN qualitative fit rank is
// STRICTLY LOWER than the best non-primary market's fit rank — e.g. HR selected
// primary at "Solid" while TB sits at "Strong". This is reachable, not
// hypothetical: marketTagger.ts's primaryMarket selection can pick HR whenever
// `hrScore >= 6 && (eliteHrShape || hrScore >= tbScore)` — the `eliteHrShape`
// branch is an independent raw-shape check, so HR can win primary on shape
// alone even when its own blended fit score trails TB's.
//
// This is an audit/observability signal ONLY — it never changes primaryMarket,
// marketSetups, score10, tier, or any rendered output. The client must not
// derive or override primaryMarket from this result.

import type { PregameMarketSetup, PregamePowerMarket } from "./types";

const FIT_RANK: Record<string, number> = { Elite: 3, Strong: 2, Solid: 1, Watch: 0 };

export interface MarketFitAuditResult {
  flagged: boolean;
  primaryMarket?: PregamePowerMarket;
  betterFitMarket?: PregamePowerMarket;
  reason?: string;
}

export function auditPrimaryMarketFit(marketSetups: PregameMarketSetup[]): MarketFitAuditResult {
  const primary = marketSetups.find((m) => m.isPrimary);
  if (!primary) return { flagged: false };
  const primaryRank = FIT_RANK[primary.setupLabel] ?? 0;

  let bestNonPrimary: PregameMarketSetup | null = null;
  for (const m of marketSetups) {
    if (m.isPrimary) continue;
    const rank = FIT_RANK[m.setupLabel] ?? 0;
    if (!bestNonPrimary || rank > (FIT_RANK[bestNonPrimary.setupLabel] ?? 0)) bestNonPrimary = m;
  }
  if (!bestNonPrimary) return { flagged: false };

  const bestNonPrimaryRank = FIT_RANK[bestNonPrimary.setupLabel] ?? 0;
  if (bestNonPrimaryRank <= primaryRank) return { flagged: false };

  return {
    flagged: true,
    primaryMarket: primary.market,
    betterFitMarket: bestNonPrimary.market,
    reason: `primaryMarket=${primary.market} (${primary.setupLabel}) has a lower fit than ${bestNonPrimary.market} (${bestNonPrimary.setupLabel})`,
  };
}
