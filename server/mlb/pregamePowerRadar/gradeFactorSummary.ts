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
export type GradeFactorTone = "standout" | "supporting" | "context" | "attack" | "risk" | "neutral";

export interface GradeFactorEntry {
  key: string;
  label: string;
  /** Plain-language compact-card value; raw numeric `value` remains available in expanded details. */
  displayLabel: string;
  /** Semantic compact-card color, stamped server-side so the client never interprets the factor. */
  tone: GradeFactorTone;
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

type GradeFactorKey = GradeFactorComponentInput["key"] | "bvpHistory" | "coverageCap" | "matchupPenalty";

function componentDisplayLabel(key: GradeFactorComponentInput["key"], score: number): string {
  switch (key) {
    case "pitcherVulnerability":
      if (score >= 8) return "High";
      if (score >= 6) return "Elevated";
      if (score < 3) return "Very Low";
      if (score < 4.5) return "Low";
      return "Neutral";
    case "batterPower":
      if (score >= 8.5) return "Elite";
      if (score >= 7.5) return "Strong";
      if (score >= 6) return "Solid";
      if (score < 4.5) return "Weak";
      return "Neutral";
    case "matchupFit":
      if (score >= 7) return "Favorable";
      if (score >= 6) return "Supportive";
      if (score < 4) return "Difficult";
      return "Neutral";
    case "parkWeather":
      if (score >= 7) return "Hitter-Friendly";
      if (score >= 6) return "Favorable";
      if (score < 4) return "Suppressive";
      return "Neutral";
    case "lineupOpportunity":
      if (score >= 8) return "Excellent";
      if (score >= 7) return "Strong";
      if (score >= 6) return "Favorable";
      if (score < 4) return "Poor";
      return "Neutral";
    case "nearHrRecentForm":
      if (score >= 8) return "Hot";
      if (score >= 6.5) return "Strong";
      if (score >= 5.5) return "Encouraging";
      if (score < 4) return "Cold";
      return "Neutral";
  }
}

function adjustmentDisplayLabel(key: Exclude<GradeFactorKey, GradeFactorComponentInput["key"]>, direction: GradeFactorDirection): string {
  if (key === "bvpHistory") {
    if (direction === "positive") return "Helpful";
    if (direction === "negative") return "Unfavorable";
    return "Neutral";
  }
  if (key === "coverageCap") return direction === "negative" ? "Score Capped" : "No Effect";
  return direction === "negative" ? "Downgrade" : "No Penalty";
}

function toneOf(key: GradeFactorKey, direction: GradeFactorDirection): GradeFactorTone {
  if (direction === "negative") return "risk";
  if (direction === "neutral") return "neutral";

  switch (key) {
    case "pitcherVulnerability": return "attack";
    case "batterPower":
    case "nearHrRecentForm": return "standout";
    case "lineupOpportunity":
    case "bvpHistory": return "supporting";
    case "matchupFit":
    case "parkWeather":
    case "coverageCap":
    case "matchupPenalty": return "context";
  }
}

function componentEntry(component: GradeFactorComponentInput, impact: number): GradeFactorEntry {
  const direction = directionOf(impact);
  const value = round1(component.score);
  const displayLabel = componentDisplayLabel(component.key, value);
  return {
    key: component.key,
    label: component.label,
    displayLabel,
    // A qualitative "Neutral" label must also look neutral. Small mathematical
    // impacts can exceed EPSILON for higher-weight components without being a
    // meaningful user-facing advantage; do not pair neutral wording with a
    // green/orange/rose chip.
    tone: displayLabel === "Neutral" ? "neutral" : toneOf(component.key, direction),
    value,
    impact,
    direction,
  };
}

function adjustmentEntry(
  key: "bvpHistory" | "coverageCap" | "matchupPenalty",
  label: string,
  impact: number,
): GradeFactorEntry {
  const direction = directionOf(impact);
  return {
    key,
    label,
    displayLabel: adjustmentDisplayLabel(key, direction),
    tone: toneOf(key, direction),
    value: round1(impact),
    impact,
    direction,
  };
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
  const pvEntry = componentEntry(pv, pvImpact);

  // ── Candidate pool: the other 5 components (when available) + 3 realized
  //    score adjustments (BvP / coverage cap / matchup penalty). Built in a
  //    fixed order so a stable sort gives deterministic tie-breaks. ──────────
  const pool: GradeFactorEntry[] = [];

  for (const c of input.components) {
    if (c.key === "pitcherVulnerability" || !c.available) continue;
    const impact = weightOf(c.key) * (c.score - 5);
    pool.push(componentEntry(c, impact));
  }

  const { bvpImpact, coverageCapImpact, matchupImpact } = computeRealizedImpacts(input);

  if (input.bvpAvailable) {
    pool.push(adjustmentEntry("bvpHistory", "BvP History", bvpImpact));
  }

  pool.push(adjustmentEntry("coverageCap", "Data Coverage Cap", coverageCapImpact));
  pool.push(adjustmentEntry("matchupPenalty", "Matchup Penalty", matchupImpact));

  const top2 = pool
    .slice()
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 2);

  return [pvEntry, ...top2];
}
