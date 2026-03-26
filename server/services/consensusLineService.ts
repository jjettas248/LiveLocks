// ── Consensus Line Engine (Phase 2) ──────────────────────────────────────────
// Computes canonical (median) line, best odds, and line variance from
// an array of normalized book lines. Rejects invalid consensus.

import type { NormalizedOddsLine } from "./sportsbookService";

export interface ConsensusResult {
  canonicalLine: number;
  bestLine: number;
  bestOdds: {
    overOdds: number | null;
    underOdds: number | null;
    sportsbook: string | null;
  };
  availableBooks: string[];
  lineVariance: number;
  isConsensusValid: boolean;
  rejectionReason?: string;
}

const DEFAULT_MIN_BOOKS = 2;
const DEFAULT_MAX_VARIANCE = 1.5; // reject if spread across books exceeds 1.5 points

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Returns the book with the best over odds (highest number, e.g., -105 > -110)
function bestOverBook(lines: NormalizedOddsLine[]): NormalizedOddsLine | null {
  if (lines.length === 0) return null;
  return lines.reduce((best, line) =>
    line.overOdds > best.overOdds ? line : best
  );
}

// Returns the book with the best under odds
function bestUnderBook(lines: NormalizedOddsLine[]): NormalizedOddsLine | null {
  if (lines.length === 0) return null;
  return lines.reduce((best, line) =>
    line.underOdds > best.underOdds ? line : best
  );
}

export function computeConsensus(
  lines: NormalizedOddsLine[],
  opts?: { minBooks?: number; maxVariance?: number }
): ConsensusResult | null {
  const minBooks = opts?.minBooks ?? DEFAULT_MIN_BOOKS;
  const maxVariance = opts?.maxVariance ?? DEFAULT_MAX_VARIANCE;

  if (lines.length === 0) return null;

  const allLines = lines.map((l) => l.line);
  const availableBooks = [...new Set(lines.map((l) => l.sportsbook))];
  const canonicalLine = median(allLines);
  const lineMin = Math.min(...allLines);
  const lineMax = Math.max(...allLines);
  const lineVariance = parseFloat((lineMax - lineMin).toFixed(2));

  // Identify best canonical line (closest to consensus)
  const bestLine = allLines.reduce((closest, line) =>
    Math.abs(line - canonicalLine) < Math.abs(closest - canonicalLine) ? line : closest
  );

  // Best odds across all books
  const bestOver = bestOverBook(lines);
  const bestUnder = bestUnderBook(lines);
  const bestOdds = {
    overOdds: bestOver?.overOdds ?? null,
    underOdds: bestUnder?.underOdds ?? null,
    sportsbook: bestOver?.sportsbook ?? null,
  };

  // Validation
  let isConsensusValid = true;
  let rejectionReason: string | undefined;

  if (availableBooks.length < minBooks) {
    isConsensusValid = false;
    rejectionReason = `Too few books (${availableBooks.length} < ${minBooks})`;
  } else if (lineVariance > maxVariance) {
    isConsensusValid = false;
    rejectionReason = `Line variance too high (${lineVariance} > ${maxVariance})`;
  }

  if (rejectionReason) {
    console.log(`[CONSENSUS REJECT] ${rejectionReason} — books: ${availableBooks.join(", ")}, lines: ${allLines.join(", ")}`);
  }

  return {
    canonicalLine,
    bestLine,
    bestOdds,
    availableBooks,
    lineVariance,
    isConsensusValid,
    rejectionReason,
  };
}

// Convenience: extract just the canonical line or null if consensus is invalid
export function getCanonicalLine(lines: NormalizedOddsLine[], opts?: { minBooks?: number; maxVariance?: number }): number | null {
  const result = computeConsensus(lines, opts);
  if (!result || !result.isConsensusValid) return null;
  return result.canonicalLine;
}
