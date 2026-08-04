// ── MLB Live Edge safety-core (Stage A A6) — canonical edge segregation ─────
// Analytics that report MLB "edge" must use the canonical no-vig model edge,
// which is stored in `model_edge` and tagged `edge_version = "novig_v1"`. The
// legacy `edge_gap` column carried the invalid `evPct = probability - 50` for
// old MLB rows and is intentionally left NULL for new MLB rows — those legacy
// rows must be SEGREGATED out of any canonical-edge aggregate, never averaged in
// as if they were book-relative edge.
//
// Pure, no I/O.

export const MLB_CANONICAL_EDGE_VERSION = "novig_v1" as const;

interface EdgeRow {
  sport?: string | null;
  edgeVersion?: string | null;
  modelEdge?: string | number | null;
  edgeGap?: string | number | null;
}

function toFiniteNumber(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** True for an MLB row that carries the canonical no-vig edge version. */
export function isCanonicalMlbEdgeRow(play: EdgeRow): boolean {
  return play.edgeVersion === MLB_CANONICAL_EDGE_VERSION;
}

/**
 * Canonical no-vig MLB model edge (percentage points) for a play, or null when
 * the row is not a canonical novig_v1 row. Legacy/invalid MLB edge rows
 * (edge_version null, edge_gap = prob-50) return null so they are excluded from
 * canonical-edge aggregates rather than contaminating them.
 */
export function canonicalMlbEdgePp(play: EdgeRow): number | null {
  if (!isCanonicalMlbEdgeRow(play)) return null;
  return toFiniteNumber(play.modelEdge);
}

/**
 * The edge value analytics should use for a play, sport-aware:
 *   - MLB  → canonical no-vig model edge, gated on edge_version="novig_v1"
 *            (legacy rows return null and are segregated out).
 *   - other → the legacy edge_gap (NBA/NCAAB semantics unchanged).
 */
export function analyticsEdgePp(play: EdgeRow): number | null {
  if (play.sport === "mlb") return canonicalMlbEdgePp(play);
  return toFiniteNumber(play.edgeGap);
}
