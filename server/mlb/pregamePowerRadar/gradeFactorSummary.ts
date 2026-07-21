// Pre-Game Power Radar — compact-card "Grade Factors" summary (display only).
//
// Server-owned, frozen at build time alongside score10/tier — the client renders
// this array verbatim and must never recompute impact/selection itself (see
// PregamePowerRadar.tsx). Always includes Pitcher Vulnerability (when its own
// data is available); the other two entries are whichever components/score
// adjustments had the largest REALIZED effect on the final grade.
//
// "Realized" impact is computed from composePregameScore's own already-clamped
// return values (finalScoreBeforeCaps / finalScoreCap / score10), not from raw
// input magnitudes (bvpModifier, matchupPenalty) — the engine's own 0–10
// clamping/rounding can absorb part of a raw adjustment (e.g. a BvP modifier
// pushing 9.8 toward the 10.0 ceiling), so only the realized delta reflects what
// actually moved the grade. By construction:
//   coverageCapImpact + matchupImpact === score10 - finalScoreBeforeCaps
// `finalScoreCap` being defined does NOT mean the cap bound — only a nonzero
// `coverageCapImpact` does (bvpAdjustedScore may already have been beneath it).
//
// This module never mutates score10/tier/rank/qualification/drivers/
// primaryMarket — it only summarizes terms `composePregameScore` already
// computed.

import { COMPONENT_WEIGHTS } from "./scoring";

export type GradeFactorDirection = "positive" | "negative" | "neutral";

export interface GradeFactorEntry {
  key: string;
  label: string;
  /** Display value: the component's own 0–10 score, or the adjustment's realized point impact. */
  value: number;
  /** Ranking metric used for selection only — not necessarily rendered. */
  impact: number;
  direction: GradeFactorDirection;
}

export interface GradeFactorComponentInput {
  key: "batterPower" | "pitcherVulnerability" | "matchupFit" | "parkWeather" | "lineupOpportunity" | "nearHrRecentForm";
  label: string;
  score: number;
  available: boolean;
}

export interface GradeFactorSummaryInput {
  components: GradeFactorComponentInput[]; // all 6, including pitcherVulnerability
  bvpModifier: number;
  bvpAvailable: boolean;
  baseScore: number;
  finalScoreBeforeCaps: number;
  finalScoreCap?: number;
  matchupPenalty: number;
  score10: number;
}

const EPSILON = 0.1;

function directionOf(impact: number): GradeFactorDirection {
  if (impact > EPSILON) return "positive";
  if (impact < -EPSILON) return "negative";
  return "neutral";
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export interface RealizedImpacts {
  bvpImpact: number;
  coverageCapImpact: number;
  matchupImpact: number;
}

/**
 * Exported separately so tests can exercise the realized-impact math directly
 * (see gradeFactorSummary.test.ts's double-counting regression test) without
 * depending on whether these entries happen to be selected into the top-2.
 * By construction: coverageCapImpact + matchupImpact === score10 - finalScoreBeforeCaps.
 */
export function computeRealizedImpacts(input: Pick<GradeFactorSummaryInput, "baseScore" | "finalScoreBeforeCaps" | "finalScoreCap" | "score10">): RealizedImpacts {
  const bvpImpact = input.finalScoreBeforeCaps - input.baseScore;
  const cappedBeforePenalty = Math.min(input.finalScoreBeforeCaps, input.finalScoreCap ?? 10);
  const coverageCapImpact = cappedBeforePenalty - input.finalScoreBeforeCaps;
  const matchupImpact = input.score10 - cappedBeforePenalty;
  return { bvpImpact, coverageCapImpact, matchupImpact };
}

/**
 * Returns null when Pitcher Vulnerability's own data is unavailable — this
 * summary never fabricates its anchor factor from a neutral placeholder score.
 * Otherwise returns 1–3 entries: Pitcher Vulnerability's own entry first,
 * followed by up to two more entries (components or score adjustments) chosen
 * by largest absolute realized impact.
 */
export function buildGradeFactorSummary(input: GradeFactorSummaryInput): GradeFactorEntry[] | null {
  const pv = input.components.find((c) => c.key === "pitcherVulnerability");
  if (!pv || !pv.available) return null;

  const weightOf = (key: GradeFactorComponentInput["key"]): number => COMPONENT_WEIGHTS[key];

  const pvImpact = weightOf("pitcherVulnerability") * (pv.score - 5);
  const pvEntry: GradeFactorEntry = {
    key: pv.key,
    label: pv.label,
    value: round1(pv.score),
    impact: pvImpact,
    direction: directionOf(pvImpact),
  };

  // ── Candidate pool: the other 5 components (when available) + 3 realized
  //    score adjustments (BvP / coverage cap / matchup penalty). Built in a
  //    fixed order so a stable sort gives deterministic tie-breaks. ──────────
  const pool: GradeFactorEntry[] = [];

  for (const c of input.components) {
    if (c.key === "pitcherVulnerability" || !c.available) continue;
    const impact = weightOf(c.key) * (c.score - 5);
    pool.push({ key: c.key, label: c.label, value: round1(c.score), impact, direction: directionOf(impact) });
  }

  const { bvpImpact, coverageCapImpact, matchupImpact } = computeRealizedImpacts(input);

  if (input.bvpAvailable) {
    pool.push({ key: "bvpHistory", label: "BvP History", value: round1(bvpImpact), impact: bvpImpact, direction: directionOf(bvpImpact) });
  }

  pool.push({ key: "coverageCap", label: "Data Coverage Cap", value: round1(coverageCapImpact), impact: coverageCapImpact, direction: directionOf(coverageCapImpact) });
  pool.push({ key: "matchupPenalty", label: "Matchup Penalty", value: round1(matchupImpact), impact: matchupImpact, direction: directionOf(matchupImpact) });

  const top2 = pool
    .slice()
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 2);

  return [pvEntry, ...top2];
}
