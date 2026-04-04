import type { NBAValidationRules } from "./types";

export interface NBAValidationCandidate {
  playerName?: string;
  market?: string;
  line?: number | null;
  projection?: number | null;
  probability?: number | null;
  edge?: number | null;
  recommendedSide?: string | null;
  derivedLine?: boolean;
  createdAt?: number | null;
}

export interface NBAValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateNBASignal(
  candidate: NBAValidationCandidate,
  rules: NBAValidationRules
): NBAValidationResult {
  const tag = candidate.playerName ?? "unknown";

  if (candidate.line == null || !Number.isFinite(candidate.line)) {
    return { valid: false, reason: `${tag}: line is ${candidate.line}` };
  }

  if (candidate.projection == null || !Number.isFinite(candidate.projection)) {
    return { valid: false, reason: `${tag}: projection is ${candidate.projection}` };
  }

  if (candidate.probability == null || !Number.isFinite(candidate.probability)) {
    return { valid: false, reason: `${tag}: probability is ${candidate.probability}` };
  }

  if (candidate.probability < 2 || candidate.probability > 98) {
    return { valid: false, reason: `${tag}: probability ${candidate.probability} outside NBA bounds [2, 98]` };
  }

  if (candidate.edge == null || !Number.isFinite(candidate.edge)) {
    return { valid: false, reason: `${tag}: edge is ${candidate.edge}` };
  }

  if (Math.abs(candidate.edge) < rules.minEdge) {
    return { valid: false, reason: `${tag}: edge ${candidate.edge} below NBA minimum ${rules.minEdge}` };
  }

  if (candidate.probability < rules.minProbability) {
    return { valid: false, reason: `${tag}: probability ${candidate.probability} below NBA minimum ${rules.minProbability}` };
  }

  if (rules.requireProjectionAlignment) {
    if (candidate.recommendedSide === "OVER" && (candidate.projection ?? 0) < (candidate.line ?? 0)) {
      return { valid: false, reason: `${tag}: OVER signal but projection < line` };
    }
    if (candidate.recommendedSide === "UNDER" && (candidate.projection ?? 0) > (candidate.line ?? 0)) {
      return { valid: false, reason: `${tag}: UNDER signal but projection > line` };
    }
  }

  if (candidate.recommendedSide != null &&
      candidate.recommendedSide !== "OVER" &&
      candidate.recommendedSide !== "UNDER") {
    return { valid: false, reason: `${tag}: invalid side "${candidate.recommendedSide}"` };
  }

  return { valid: true };
}

export function filterNBASignals<T extends NBAValidationCandidate>(
  signals: T[],
  rules: NBAValidationRules,
  accumulator?: { filtered: number; reasons: string[] }
): T[] {
  const valid: T[] = [];
  for (const sig of signals) {
    const result = validateNBASignal(sig, rules);
    if (result.valid) {
      valid.push(sig);
    } else if (accumulator && result.reason) {
      accumulator.filtered++;
      if (!accumulator.reasons.includes(result.reason)) {
        accumulator.reasons.push(result.reason);
      }
    }
  }
  return valid;
}
