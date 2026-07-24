// Pre-Game Power Radar — batter damage vs opposing starter arsenal.
//
// Pure adapter over BaseballSavantData already fetched by the build. It closes
// the conceptual gap between `batterPitchSplits` (xSLG/whiff by family) and the
// pitcher's `pitchMixPct`, without inventing a new feed.

import type { BaseballSavantData } from "../dataSources";
import type { PitchTypeInteractionInputs } from "./math/mathTypes";

type Family = "fastball" | "breaking" | "offspeed";
const FAMILIES: Family[] = ["fastball", "breaking", "offspeed"];

function usageFraction(pitcher: BaseballSavantData, family: Family): number | null {
  const raw = pitcher.pitchMixPct?.[family] ?? null;
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  // dataSources stores pitchMixPct as percentage points; tolerate a future 0–1
  // producer without multiplying it twice.
  return raw > 1 ? raw / 100 : raw;
}

export function buildPitchTypeInteractionInputsFromSavant(
  batter: BaseballSavantData | null | undefined,
  pitcher: BaseballSavantData | null | undefined,
): PitchTypeInteractionInputs {
  if (!batter?.batterPitchSplits || !pitcher) return { families: [] };
  return {
    families: FAMILIES.map((family) => {
      const split = batter.batterPitchSplits?.find((s) => s.pitchType === family);
      return {
        family,
        usageShare: usageFraction(pitcher, family),
        batterXslg: split?.xSLG ?? null,
        batterWhiffPct: split?.whiffPct ?? null,
        // Current BatterPitchSplit does not preserve its own denominator. Keep
        // this null rather than fabricating sample size; scorePitchTypeInteraction
        // will apply its missing-sample shrinkage path.
        batterSample: null,
      };
    }).filter((f) => f.usageShare != null && (f.batterXslg != null || f.batterWhiffPct != null)),
  };
}

/**
 * Production component hook: xSLG against the family the starter throws most.
 * Returns null on any missing evidence; never falls back to the batter's best
 * family because that would manufacture a matchup advantage.
 */
export function batterXslgVsPitcherDominantFamily(
  batter: BaseballSavantData | null | undefined,
  pitcher: BaseballSavantData | null | undefined,
): number | null {
  if (!batter?.batterPitchSplits || !pitcher) return null;
  let dominant: Family | null = null;
  let bestUsage = -1;
  for (const family of FAMILIES) {
    const usage = usageFraction(pitcher, family);
    if (usage != null && usage > bestUsage) {
      dominant = family;
      bestUsage = usage;
    }
  }
  if (!dominant) return null;
  return batter.batterPitchSplits.find((s) => s.pitchType === dominant)?.xSLG ?? null;
}
