// ── Official MLB Recommendation Firewall ──────────────────────────────────
// Centralized gate: a recommendation may become `isOfficial: true` (and
// therefore a FIRE signal / Top Play / public performance row) ONLY if it
// clears every check here. See CLAUDE.md "No synthetic official plays".
//
// This module has no I/O and no side effects — callers supply `now` and the
// CURRENT game status explicitly so freshness is always reader-driven, never
// baked into a stored value (see classifyMlbOddsFreshness).

import {
  MLB_APPROVED_SPORTSBOOKS,
  MLB_EPISODE_DATA_QUALITY,
  type MlbRecommendationEpisode,
} from "@shared/mlbRecommendationEpisode";
import { classifyMlbOddsFreshness } from "../../odds/mlbOddsProvenanceContract";
import type { MlbGameStatus } from "../../oddsService";

export const MLB_FIREWALL_VIOLATIONS = [
  "MISSING_SPORTSBOOK",
  "UNAPPROVED_SPORTSBOOK",
  "INVALID_LINE",
  "INVALID_ODDS",
  "MISSING_FETCH_TIMESTAMP",
  "INVALID_FETCH_TIMESTAMP",
  "ODDS_STALE",
  "INVALID_PROJECTION",
  "INVALID_PROBABILITY",
  "SIDE_PROJECTION_MISMATCH",
  "PROBABILITY_DOES_NOT_FAVOR_SIDE",
  "MISSING_MODEL_VERSION",
  "MISSING_CONTRACT_VERSION",
  "INVALID_EXPIRATION",
  "SYNTHETIC_SOURCE",
  "INVALID_DATA_QUALITY",
] as const;
export type MlbFirewallViolation = (typeof MLB_FIREWALL_VIOLATIONS)[number];

export interface MlbFirewallContext {
  now: Date;
  currentGameStatus: MlbGameStatus;
}

export interface MlbFirewallResult {
  eligible: boolean;
  violations: MlbFirewallViolation[];
}

const APPROVED_BOOK_SET: ReadonlySet<string> = new Set(MLB_APPROVED_SPORTSBOOKS);
const DATA_QUALITY_SET: ReadonlySet<string> = new Set(MLB_EPISODE_DATA_QUALITY);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string" || v.trim() === "") return false;
  return Number.isFinite(new Date(v).getTime());
}

/**
 * Candidate shape the firewall evaluates — a structural subset of
 * MlbRecommendationEpisode (not the full type), so a caller can validate a
 * build BEFORE minting an episodeId/status, and so this module never needs
 * to know about record-bookkeeping fields (status, settlementResult, ...).
 */
export type MlbOfficialRecommendationCandidate = Pick<
  MlbRecommendationEpisode,
  | "sourceType" | "sportsbook" | "line" | "americanOdds" | "oddsFetchedAt"
  | "projection" | "modelProbability" | "recommendedSide" | "modelVersion"
  | "contractVersion" | "expiresAt" | "dataQuality"
>;

export function evaluateOfficialRecommendationEligibility(
  candidate: MlbOfficialRecommendationCandidate,
  context: MlbFirewallContext,
): MlbFirewallResult {
  const violations: MlbFirewallViolation[] = [];

  if (candidate.sourceType !== "sportsbook") {
    violations.push("SYNTHETIC_SOURCE");
  }

  if (!candidate.sportsbook || typeof candidate.sportsbook !== "string" || candidate.sportsbook.trim() === "") {
    violations.push("MISSING_SPORTSBOOK");
  } else if (!APPROVED_BOOK_SET.has(candidate.sportsbook)) {
    // Catches "odds_api" and any other non-book placeholder label.
    violations.push("UNAPPROVED_SPORTSBOOK");
  }

  if (!isFiniteNumber(candidate.line)) {
    violations.push("INVALID_LINE");
  }

  if (!isFiniteNumber(candidate.americanOdds) || Math.abs(candidate.americanOdds) < 100) {
    violations.push("INVALID_ODDS");
  }

  if (!isValidIsoTimestamp(candidate.oddsFetchedAt)) {
    violations.push("MISSING_FETCH_TIMESTAMP");
  } else {
    const ageMs = context.now.getTime() - new Date(candidate.oddsFetchedAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) {
      violations.push("INVALID_FETCH_TIMESTAMP");
    } else {
      const freshness = classifyMlbOddsFreshness(context.currentGameStatus, ageMs);
      if (freshness === "stale" || freshness === "unknown") {
        violations.push("ODDS_STALE");
      }
    }
  }

  if (!isFiniteNumber(candidate.projection)) {
    violations.push("INVALID_PROJECTION");
  }

  if (!isFiniteNumber(candidate.modelProbability) || candidate.modelProbability <= 0 || candidate.modelProbability >= 1) {
    violations.push("INVALID_PROBABILITY");
  } else if (candidate.modelProbability <= 0.5) {
    // A side is only ever "recommended" when the model favors it outright —
    // a coinflip-or-worse probability is not a mathematically consistent
    // reason to display a side.
    violations.push("PROBABILITY_DOES_NOT_FAVOR_SIDE");
  }

  if (isFiniteNumber(candidate.projection) && isFiniteNumber(candidate.line)) {
    const sideMatchesProjection =
      candidate.recommendedSide === "OVER" ? candidate.projection > candidate.line
      : candidate.projection < candidate.line;
    if (!sideMatchesProjection) {
      violations.push("SIDE_PROJECTION_MISMATCH");
    }
  }

  if (!candidate.modelVersion || candidate.modelVersion.trim() === "") {
    violations.push("MISSING_MODEL_VERSION");
  }
  if (!candidate.contractVersion || candidate.contractVersion.trim() === "") {
    violations.push("MISSING_CONTRACT_VERSION");
  }

  if (candidate.expiresAt !== null && !isValidIsoTimestamp(candidate.expiresAt)) {
    violations.push("INVALID_EXPIRATION");
  }

  if (!DATA_QUALITY_SET.has(candidate.dataQuality)) {
    violations.push("INVALID_DATA_QUALITY");
  }

  return { eligible: violations.length === 0, violations };
}

export class MlbOfficialRecommendationRejectedError extends Error {
  constructor(public readonly violations: MlbFirewallViolation[]) {
    super(`Recommendation is not eligible to become an official MLB episode: ${violations.join(", ")}`);
    this.name = "MlbOfficialRecommendationRejectedError";
  }
}

export function assertOfficialRecommendationEligible(
  candidate: MlbOfficialRecommendationCandidate,
  context: MlbFirewallContext,
): void {
  const result = evaluateOfficialRecommendationEligibility(candidate, context);
  if (!result.eligible) {
    throw new MlbOfficialRecommendationRejectedError(result.violations);
  }
}
