// ── Normalization Service ──────────────────────────────────────────────────────
// Auto-detects and normalizes percentage-based inputs across all engines.
// Rule: value > 1 → assumed to be on 0–100 scale → divide by 100
//       value ≤ 1 → assumed already on 0–1 scale → pass through

export function normalizePercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value > 1 ? value / 100 : value;
}
