import type { MLBValidationRules } from "./types";

export interface MLBValidationCandidate {
  playerName?: string;
  market?: string;
  line?: number | null;
  projection?: number | null;
  probability?: number | null;
  edge?: number | null;
  recommendedSide?: string | null;
  signalScore?: number | null;
  confidenceTier?: string | null;
  derivedLine?: boolean;
  createdAt?: number | null;
}

export interface MLBValidationResult {
  valid: boolean;
  reason?: string;
}

const TIER_RANK: Record<string, number> = {
  elite: 3,
  ELITE: 3,
  strong: 2,
  STRONG: 2,
  SOLID: 2,
  developing: 1,
  WATCHLIST: 1,
  NO_SIGNAL: 0,
};

function tierMeetsMinimum(tier: string | null | undefined, minTier: string): boolean {
  const tierValue = TIER_RANK[tier ?? ""] ?? 0;
  const minValue = TIER_RANK[minTier] ?? 0;
  return tierValue >= minValue;
}

export function validateMLBSignal(
  candidate: MLBValidationCandidate,
  rules: MLBValidationRules
): MLBValidationResult {
  const tag = candidate.playerName ?? "unknown";

  if (candidate.line == null || !Number.isFinite(candidate.line)) {
    return { valid: false, reason: `${tag}: line is ${candidate.line}` };
  }

  if (candidate.probability == null || !Number.isFinite(candidate.probability)) {
    return { valid: false, reason: `${tag}: probability is ${candidate.probability}` };
  }

  const tierRank = TIER_RANK[candidate.confidenceTier ?? ""] ?? 0;
  if (tierRank === 0) {
    return { valid: false, reason: `${tag}: tier ${candidate.confidenceTier} is NO_SIGNAL/unknown — always rejected` };
  }

  if (!tierMeetsMinimum(candidate.confidenceTier, rules.minConfidenceTier)) {
    if (!rules.allowDevelopingSignals) {
      return { valid: false, reason: `${tag}: tier ${candidate.confidenceTier} below MLB minimum ${rules.minConfidenceTier}` };
    }
  }

  if (candidate.recommendedSide != null &&
      candidate.recommendedSide !== "OVER" &&
      candidate.recommendedSide !== "UNDER") {
    return { valid: false, reason: `${tag}: invalid side "${candidate.recommendedSide}"` };
  }

  return { valid: true };
}

export function filterMLBSignals<T extends MLBValidationCandidate>(
  signals: T[],
  rules: MLBValidationRules,
  accumulator?: { filtered: number; reasons: string[] }
): T[] {
  const valid: T[] = [];
  for (const sig of signals) {
    const result = validateMLBSignal(sig, rules);
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
