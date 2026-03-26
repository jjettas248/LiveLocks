// ── Normalization Service ──────────────────────────────────────────────────────
// Auto-detects and normalizes percentage-based inputs across all engines.
// Rule: value > 1 → assumed to be on 0–100 scale → divide by 100
//       value ≤ 1 → assumed already on 0–1 scale → pass through

export function normalizePercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 1 ? value / 100 : value;
}

// Clamp a normalized (0–1) percentage to [0, 1]
export function clampPercentage(value: number): number {
  const norm = normalizePercentage(value);
  return Math.min(1, Math.max(0, norm));
}

export interface OddsMarket {
  overOdds?: number | null;
  underOdds?: number | null;
  line?: number | null;
  sportsbook?: string | null;
}

export interface OddsValidationResult {
  valid: boolean;
  reason?: string;
}

// Validates that an odds market has both sides present, finite, and a real sportsbook source.
// Returns { valid: true } if all checks pass, or { valid: false, reason } otherwise.
export function validateOdds(market: OddsMarket): OddsValidationResult {
  if (market.line == null || !Number.isFinite(market.line)) {
    return { valid: false, reason: "line is null or non-finite" };
  }
  if (market.overOdds == null || !Number.isFinite(market.overOdds)) {
    return { valid: false, reason: "overOdds is null or non-finite" };
  }
  if (market.underOdds == null || !Number.isFinite(market.underOdds)) {
    return { valid: false, reason: "underOdds is null or non-finite" };
  }
  if (!market.sportsbook || market.sportsbook.trim() === "") {
    return { valid: false, reason: "sportsbook source is missing" };
  }
  return { valid: true };
}
