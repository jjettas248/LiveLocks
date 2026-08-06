// Pregame composition layer — Cross-Radar: suggest Plate ("the Plate" /
// Pregame Power Radar) HR targets on Mound cards for pitchers already
// flagged HR-susceptible.
//
// PURE, side-effect-free. This module inspects the existing cr_high driver
// and joins/ranks/dedupes/caps already-computed Mound + Plate signals — it
// does not fetch data, write data, calculate new HR probability, recompute
// either radar, mutate either input, or decide Plate eligibility (that is
// the caller's job — see enrichMoundResponse.ts, which must only pass
// signals that already cleared Plate's own canonical publication predicate,
// isPublicPregameSignal). Neither engine imports this module or the other
// engine; this module imports the finished output types of both.

import { hasHighContactRisk } from "../mound/contactRisk";
import type { MoundSignal } from "../mound/types";
import type { PregamePowerSignal, PregamePowerTier } from "../../pregamePowerRadar/types";

export interface MoundPlateTargetSuggestion {
  batterId: string;
  batterName: string;
  team: string;
  battingOrderSlot: number | null;
  plateTier: PregamePowerTier;
  plateScore10: number;
  /** The batter's HR-specific market score (marketScores.home_runs), when finite. Null when unavailable — see rankingBasis. */
  hrScore: number | null;
  /** "home_runs" when hrScore drove this suggestion's rank; "overall_fallback" when hrScore was unavailable and plateScore10 was used instead. The client must render this distinction, never present a fallback score as an HR score. */
  rankingBasis: "home_runs" | "overall_fallback";
}

const MAX_SUGGESTIONS = 3;

function isValidNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The batter's HR-specific market score, only when it's a real finite number — never a fabricated/approximated value. */
function getFiniteHrScore(signal: PregamePowerSignal): number | null {
  const value = signal.marketScores?.home_runs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isQualifyingCandidate(
  plateSignal: PregamePowerSignal,
  moundSignal: Readonly<MoundSignal>,
): boolean {
  return (
    plateSignal.pitcherId != null &&
    plateSignal.gameId === moundSignal.gameId &&
    plateSignal.pitcherId === moundSignal.pitcherId &&
    isValidNonEmptyString(plateSignal.batterId) &&
    isValidNonEmptyString(plateSignal.batterName) &&
    Number.isFinite(plateSignal.score10)
  );
}

/**
 * Deterministic ranking: candidates with a finite HR-specific market score
 * always rank ahead of those without one (ranked among themselves by that
 * score, descending); candidates without one fall back to overall Plate
 * score10 descending. Ties break on confirmed batting-order slot ascending
 * (unconfirmed sorts last), then batterId ascending as the final stable
 * tie-break. Never mutates the input array (sorts a copy).
 */
function rankCandidates(candidates: readonly PregamePowerSignal[]): PregamePowerSignal[] {
  return candidates.slice().sort((a, b) => {
    const aHr = getFiniteHrScore(a);
    const bHr = getFiniteHrScore(b);
    if (aHr !== null && bHr === null) return -1;
    if (aHr === null && bHr !== null) return 1;
    if (aHr !== null && bHr !== null && bHr !== aHr) return bHr - aHr;

    if (b.score10 !== a.score10) return b.score10 - a.score10;

    const aSlot = a.battingOrderSlot ?? 99;
    const bSlot = b.battingOrderSlot ?? 99;
    if (aSlot !== bSlot) return aSlot - bSlot;

    return String(a.batterId).localeCompare(String(b.batterId));
  });
}

function toSuggestion(p: PregamePowerSignal): MoundPlateTargetSuggestion {
  const hrScore = getFiniteHrScore(p);
  return {
    batterId: p.batterId,
    batterName: p.batterName,
    team: p.team,
    battingOrderSlot: p.battingOrderSlot,
    plateTier: p.tier,
    plateScore10: p.score10,
    hrScore,
    rankingBasis: hrScore !== null ? "home_runs" : "overall_fallback",
  };
}

/**
 * Up to 3 Plate batters facing this exact pitcher today, deduplicated by
 * batterId and deterministically ranked. [] whenever the pitcher isn't
 * already flagged cr_high (hasHighContactRisk), or no qualifying candidates
 * exist for this game/pitcher — never throws, never mutates either input.
 *
 * `eligiblePlateSignals` MUST already be filtered to Plate's own canonical
 * publication predicate by the caller (isPublicPregameSignal in
 * pregamePowerRadar/diagnostics.ts) — this function does not re-derive or
 * approximate that decision; it only joins on gameId+pitcherId, ranks,
 * dedupes, and caps.
 */
export function buildMoundPlateTargetSuggestions(
  moundSignal: Readonly<MoundSignal>,
  eligiblePlateSignals: readonly PregamePowerSignal[],
): MoundPlateTargetSuggestion[] {
  if (!hasHighContactRisk(moundSignal)) return [];

  const candidates = eligiblePlateSignals.filter((p) => isQualifyingCandidate(p, moundSignal));
  const ranked = rankCandidates(candidates);

  const deduped: PregamePowerSignal[] = [];
  const seenBatterIds = new Set<string>();
  for (const p of ranked) {
    const batterId = String(p.batterId);
    if (seenBatterIds.has(batterId)) continue;
    seenBatterIds.add(batterId);
    deduped.push(p);
    if (deduped.length >= MAX_SUGGESTIONS) break;
  }

  return deduped.map(toSuggestion);
}
