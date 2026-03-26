// ── Engine Signal Output Contract ─────────────────────────────────────────────
// Shared TypeScript type for all engine signals with required fields.
// A validation wrapper drops any signal missing a required field before
// it reaches the route layer.
// Phase 7: Confidence tier helper — ELITE/STRONG/LEAN based on probability.

export interface EngineSignal {
  id: string;
  sport: "nba" | "ncaab" | "mlb";
  market: string;
  player?: string;
  team?: string;
  line: number;
  projection: number;
  probability: number;
  edge: number;
  recommendedSide: "OVER" | "UNDER" | "COVER" | "FADE" | "NO_EDGE";
  confidence: "ELITE" | "STRONG" | "VALUE" | "LEAN" | "NO_EDGE" | "HIGH" | "MEDIUM" | "LOW";
  sportsbook: string;
  derivedLine: boolean;
  // Phase 4/7 additions — optional for backward compat but populated by all new signals
  lineSource?: "sportsbook" | "inferred" | "derived";
  availableBooks?: string[];
  bestOdds?: {
    overOdds: number | null;
    underOdds: number | null;
    sportsbook: string | null;
  } | null;
  lineVariance?: number | null;
  signalTimestamp?: number;
  timingTrigger?: string | null;
  createdAt: number;
}

const REQUIRED_FIELDS: (keyof EngineSignal)[] = [
  "id",
  "sport",
  "market",
  "line",
  "projection",
  "probability",
  "edge",
  "recommendedSide",
  "confidence",
  "sportsbook",
  "derivedLine",
  "createdAt",
];

export function validateEngineSignal(signal: PartialEngineSignal): signal is EngineSignal {
  for (const field of REQUIRED_FIELDS) {
    const val = signal[field];
    if (val === undefined || val === null) return false;
    if (typeof val === "number" && !Number.isFinite(val)) return false;
  }
  return true;
}

export type PartialEngineSignal = { [K in keyof EngineSignal]?: EngineSignal[K] | null };

export function filterValidSignals<T extends PartialEngineSignal>(
  signals: T[],
  accumulator?: { skipped: number; failureReasons: string[] }
): EngineSignal[] {
  const valid: EngineSignal[] = [];
  for (const signal of signals) {
    if (validateEngineSignal(signal)) {
      valid.push(signal);
    } else {
      const missing = REQUIRED_FIELDS.filter((f) => {
        const val = signal[f];
        return val === undefined || val === null || (typeof val === "number" && !Number.isFinite(val));
      });
      const reason = `Signal dropped — missing/invalid fields: ${missing.join(", ")}`;
      if (accumulator) {
        accumulator.skipped++;
        if (!accumulator.failureReasons.includes(reason)) {
          accumulator.failureReasons.push(reason);
        }
      }
      console.warn(`[ENGINE SIGNAL] ${reason}`, { signal });
    }
  }
  return valid;
}

// ── Phase 7: Confidence Tier Helper ──────────────────────────────────────────
// Maps raw probability to a confidence tier.
// Derived lines (not from a real sportsbook) are capped at STRONG.
//
// ELITE:  probability >= 75%
// STRONG: probability >= 65% (or >= 75% but derivedLine → capped)
// LEAN:   probability >= 55%
// NO_EDGE: < 55%

export type ProbabilityConfidenceTier = "ELITE" | "STRONG" | "LEAN" | "NO_EDGE";

export function computeConfidenceTier(
  probability: number,
  isDerivedLine: boolean = false
): ProbabilityConfidenceTier {
  if (!Number.isFinite(probability)) return "NO_EDGE";

  let tier: ProbabilityConfidenceTier;
  if (probability >= 75) tier = "ELITE";
  else if (probability >= 65) tier = "STRONG";
  else if (probability >= 55) tier = "LEAN";
  else tier = "NO_EDGE";

  // Derived lines are capped at STRONG — they cannot achieve ELITE
  if (isDerivedLine && tier === "ELITE") {
    console.log(`[CONFIDENCE CAP] Derived line — capping ELITE → STRONG (prob=${probability.toFixed(1)}%)`);
    return "STRONG";
  }

  return tier;
}

// Maps the probability-based tier to the legacy EngineSignal confidence values
export function tierToLegacyConfidence(
  tier: ProbabilityConfidenceTier
): EngineSignal["confidence"] {
  switch (tier) {
    case "ELITE":   return "ELITE";
    case "STRONG":  return "STRONG";
    case "LEAN":    return "LEAN";
    case "NO_EDGE": return "NO_EDGE";
  }
}
