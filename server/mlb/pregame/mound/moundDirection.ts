// Mound Radar — Fade/Follow direction (pure, server-stamped once at build time).
//
// Byte-for-byte port of the client's former moundDirection() presentational
// re-label. Direction must be decided ONCE, server-side, at build time and
// then carried forward untouched — never recomputed at grading time (the
// diagnostics a rebuild would compute later can drift from what the user was
// actually shown) and never derived client-side. Mirrors the "no UI-side
// lifecycle derivation" discipline HR Radar's canonical state machine already
// enforces (CLAUDE.md §3.2a) and everPubliclyFlagged's carry-forward-only
// discipline elsewhere in this module.
//
// Fade = "track" tier with real pitcher-skill data behind it (rules out a
// data-missing artifact masquerading as a genuine weak matchup). Follow =
// strong/elite/nuclear tiers that also clear the same data-quality bar the
// old curated Targets feed's wasPubliclyFlaggedMound gate required:
// confirmed opposing lineup, real data coverage, AND real season stats
// behind the pitcher's skill score.

import type { MoundMarket, MoundTier } from "./types";

export type MoundDirection = "fade" | "follow" | null;

export interface MoundDirectionInputs {
  tier: MoundTier;
  pitcherSkillScore: number | null;
  dataCoverageScore: number;
  opposingLineupConfirmed: boolean;
  pitcherSeasonStatsAvailable: boolean;
  /** Which market this card's settlement baseline is for — determines which of the two fields below must be non-null for a Fade to be gradeable. */
  primaryMarket: MoundMarket;
  /** Same value moundOutcomeAttribution.ts's seasonBaseline() uses for the pitcher_strikeouts market. */
  seasonKPer9: number | null;
  /** Same value moundOutcomeAttribution.ts's seasonBaseline() uses for the pitcher_outs market. */
  seasonAvgInningsPerStart: number | null;
}

export function computeMoundDirection(inputs: MoundDirectionInputs): MoundDirection {
  // pitcherSkillScore can be "available" from Savant stuff metrics
  // (SwStr%/CSW%) alone, with no season K/9 or gamesStarted/inningsPitched
  // on file (pitcherSkill.ts). moundOutcomeAttribution.ts's settlement
  // baseline has no fallback for that case — it always grades a
  // calibration_miss — so without this check a "Fade Candidate" could be
  // shown for a pitcher whose fade can never be graded as a cash (Codex
  // review, PR #105).
  const hasSettlementBaseline =
    inputs.primaryMarket === "pitcher_strikeouts"
      ? inputs.seasonKPer9 != null
      : inputs.seasonAvgInningsPerStart != null;

  if (inputs.tier === "track" && inputs.pitcherSkillScore != null && hasSettlementBaseline) return "fade";
  if (
    (inputs.tier === "strong" || inputs.tier === "elite" || inputs.tier === "nuclear") &&
    inputs.dataCoverageScore >= 0.6 &&
    inputs.opposingLineupConfirmed &&
    inputs.pitcherSeasonStatsAvailable === true
  ) {
    return "follow";
  }
  return null;
}
