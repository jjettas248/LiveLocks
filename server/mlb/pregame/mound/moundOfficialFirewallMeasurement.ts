// Mound Radar — Phase 1 official-recommendation-firewall measurement
// (Flagship Program Phase 2, Part 8). AUDIT + MEASUREMENT ONLY: this module
// evaluates what evaluateOfficialRecommendationEligibility (Phase 1's
// firewall, server/mlb/episodes/mlbOfficialRecommendationFirewall.ts) WOULD
// say about a real V1 Mound signal — it never suppresses, blocks, or
// changes what Mound actually publishes. Nothing in server/mlb/pregame/
// mound/buildMlbMoundRadar.ts, moundDirection.ts, or
// moundOutcomeAttribution.ts calls this. See moundOfficialFirewallGate.ts
// for the flag-gated, read-only diagnostic surface built on top of it.
//
// Finding (see MOUND_STRUCTURAL_FIREWALL_GAPS below): enforcing this
// firewall for real against Mound's current publication path would
// suppress essentially all of it, for two UNIVERSAL, STRUCTURAL reasons —
// not a per-signal data-quality issue that better inputs would fix:
//   1. V1 never captures a sportsbook PRICE anywhere in its schema
//      (MoundOutcome only stores sportsbookLine, the LINE, never odds).
//   2. V1's score10 is a matchup-quality composite (0-10), never a
//      calibrated probability (CLAUDE.md §3.9) — there is no
//      modelProbability to supply, structurally, today.
// Wiring real enforcement in would therefore require a deliberate,
// separate schema change (capturing real price at freeze time, and
// deciding whether/how to produce a genuine probability) — exactly the
// "later-phase work" CLAUDE.md §3.8 already scopes out for wiring each
// product to emit real episodes. This module makes that gap provable and
// re-checkable in code rather than a claim that can go stale, instead of
// either fabricating the missing fields or silently skipping the audit.

import {
  evaluateOfficialRecommendationEligibility,
  type MlbOfficialRecommendationCandidate,
  type MlbFirewallContext,
  type MlbFirewallResult,
} from "../../episodes/mlbOfficialRecommendationFirewall";
import type { MlbGameStatus } from "../../../oddsService";
import type { MoundSignal } from "./types";

export const MOUND_STRUCTURAL_FIREWALL_GAPS: readonly string[] = [
  "americanOdds: V1 Mound never captures a sportsbook price anywhere in its schema (MoundOutcome only stores sportsbookLine, the LINE — never odds) — every real signal fails INVALID_ODDS unconditionally, for every game, regardless of data quality.",
  "modelProbability: V1's score10 is a matchup-quality composite (0-10), never a calibrated probability (CLAUDE.md §3.9) — every real signal fails INVALID_PROBABILITY unconditionally, for the same reason.",
];

function mapMoundGameStatusToFirewallStatus(status: string): MlbGameStatus {
  if (status === "final") return "final";
  if (status === "live") return "live";
  if (status === "scheduled" || status === "pre") return "pregame";
  return "unknown";
}

/**
 * Approximate bucketing of Mound's own 0..1 dataCoverageScore into the
 * episode contract's categorical dataQuality enum — a unit/shape
 * conversion of an already-real measured signal, not an invention. The
 * thresholds are a documented judgment call, not a value Mound itself
 * asserts.
 */
function bucketDataQuality(dataCoverageScore: number | null | undefined): "complete" | "partial" | "degraded" {
  if (dataCoverageScore == null || !Number.isFinite(dataCoverageScore)) return "degraded";
  if (dataCoverageScore >= 0.85) return "complete";
  if (dataCoverageScore >= 0.5) return "partial";
  return "degraded";
}

/**
 * Builds the firewall's candidate shape from a real MoundSignal as
 * faithfully as V1's actual data allows. Every field is either a genuine
 * real value (line, sportsbook, fetch timestamp, projection, side,
 * data-quality bucket) or an honestly-unavailable NaN/empty-string for the
 * two structural gaps above — never a fabricated stand-in.
 */
export function buildMoundOfficialFirewallCandidate(
  signal: MoundSignal,
  recommendedSide: "OVER" | "UNDER",
): MlbOfficialRecommendationCandidate {
  const champion = signal.diagnostics?.evaluation?.finalPregameSnapshot?.champion ?? null;
  const postedStrikeouts = champion?.postedLine?.strikeouts ?? null;
  const dataCoverageScore = champion?.dataCoverageScore ?? signal.diagnostics?.dataCoverageScore ?? null;
  // Prefer the frozen, DB-durable nested projection fields (survive a
  // storage round-trip via the wholesale-persisted diagnostics jsonb
  // column) over the top-level MoundSignal fields, which have no
  // dedicated column and only exist on a live in-memory object.
  const projection =
    champion?.predictionTimeProjections?.matchupAdjustedStrikeouts ??
    champion?.frozenProductionBaseline?.strikeouts?.value ??
    signal.matchupAdjustedStrikeouts ??
    signal.projectedStrikeouts ??
    Number.NaN;

  return {
    // V1's posted line is a genuinely captured real-book snapshot pregame,
    // never synthetic/projected — this check is honestly earned, not the
    // structural gap (see the two americanOdds/modelProbability fields below).
    sourceType: "sportsbook",
    // The firewall's candidate type requires the literal approved-book
    // union (real episodes are always fully populated); a real V1 candidate
    // can be missing this, so an absent/unrecognized value is cast through
    // as an intentionally-invalid placeholder — the runtime
    // MISSING_SPORTSBOOK/UNAPPROVED_SPORTSBOOK checks (which compare the
    // actual string value, not the compile-time type) still catch it
    // honestly; this cast never changes what gets evaluated.
    sportsbook: (postedStrikeouts?.sportsbook ?? "") as MlbOfficialRecommendationCandidate["sportsbook"],
    line: postedStrikeouts?.line ?? Number.NaN,
    americanOdds: Number.NaN, // structural gap #1 — see MOUND_STRUCTURAL_FIREWALL_GAPS
    oddsFetchedAt: postedStrikeouts?.sourceTimestamp ?? "",
    projection,
    modelProbability: Number.NaN, // structural gap #2 — see MOUND_STRUCTURAL_FIREWALL_GAPS
    recommendedSide,
    modelVersion: "", // V1 has no tracked, incrementing model-version string today — honestly empty, never invented for this measurement.
    contractVersion: "", // Same — no contract-versioning discipline exists for V1's signal shape today.
    expiresAt: null, // Explicitly valid per the firewall (null never trips INVALID_EXPIRATION) — V1 has no episode-style TTL concept.
    dataQuality: bucketDataQuality(dataCoverageScore),
  };
}

export type MoundOfficialFirewallMeasurement =
  | { signalId: string; applicable: false; reason: "no_recommended_direction" }
  | { signalId: string; applicable: true; result: MlbFirewallResult };

/**
 * Evaluates one real signal against the real Phase 1 firewall. A signal
 * with no resolved moundDirection isn't a recommendation at all (nothing
 * to green-light or reject) and is honestly reported as not applicable —
 * never force-evaluated with a fabricated side.
 */
export function measureMoundSignalAgainstOfficialFirewall(
  signal: MoundSignal,
  now: Date,
): MoundOfficialFirewallMeasurement {
  const recommendedSide: "OVER" | "UNDER" | null =
    signal.moundDirection === "follow" ? "OVER" : signal.moundDirection === "fade" ? "UNDER" : null;

  if (recommendedSide == null) {
    return { signalId: signal.signalId, applicable: false, reason: "no_recommended_direction" };
  }

  const candidate = buildMoundOfficialFirewallCandidate(signal, recommendedSide);
  const context: MlbFirewallContext = { now, currentGameStatus: mapMoundGameStatusToFirewallStatus(signal.gameStatus) };
  return { signalId: signal.signalId, applicable: true, result: evaluateOfficialRecommendationEligibility(candidate, context) };
}

export interface MoundOfficialFirewallMeasurementSummary {
  totalSignals: number;
  applicableSignals: number;
  notApplicableSignals: number;
  eligibleCount: number;
  ineligibleCount: number;
  violationCounts: Record<string, number>;
  structuralGaps: readonly string[];
}

/** Aggregates measureMoundSignalAgainstOfficialFirewall over many signals — still measurement-only, no side effects. */
export function summarizeMoundOfficialFirewallMeasurement(
  signals: readonly MoundSignal[],
  now: Date,
): MoundOfficialFirewallMeasurementSummary {
  const violationCounts: Record<string, number> = {};
  let applicableSignals = 0;
  let eligibleCount = 0;

  for (const signal of signals) {
    const measurement = measureMoundSignalAgainstOfficialFirewall(signal, now);
    if (!measurement.applicable) continue;
    applicableSignals++;
    if (measurement.result.eligible) eligibleCount++;
    for (const v of measurement.result.violations) {
      violationCounts[v] = (violationCounts[v] ?? 0) + 1;
    }
  }

  return {
    totalSignals: signals.length,
    applicableSignals,
    notApplicableSignals: signals.length - applicableSignals,
    eligibleCount,
    ineligibleCount: applicableSignals - eligibleCount,
    violationCounts,
    structuralGaps: MOUND_STRUCTURAL_FIREWALL_GAPS,
  };
}
