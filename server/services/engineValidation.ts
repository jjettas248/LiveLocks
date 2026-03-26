// ── Engine Output Validation ───────────────────────────────────────────────────
// validateEngineOutput: strict gate applied to every computed signal BEFORE it
// leaves the engine computation path. Signals that fail are logged and dropped.
//
// Phase 3 — Engine Validation Firewall
// Phase 8 — Consistency Check (recommendedSide vs projection vs line)
// Phase 9 — Hard Rejection Rules:
//   - No sportsbook data AND not explicitly derivedLine → reject
//   - Stale timestamp (>15s for live signals) → reject
//   - Invalid consensus → reject

export interface EngineOutputCandidate {
  id?: string | null;
  playerName?: string | null;
  market?: string | null;
  gameId?: string | null;
  line?: number | null;
  projection?: number | null;
  probability?: number | null;
  edge?: number | null;
  recommendedSide?: string | null;
  sportsbook?: string | null;
  derivedLine?: boolean | null;
  // Phase 9 additions
  createdAt?: number | null;
  isConsensusValid?: boolean | null;
  isLiveSignal?: boolean | null;  // if true, staleness check uses 15s window
  // Phase 17 additions
  timingValid?: boolean | null;   // if false, timing gate has suppressed this signal
  isStale?: boolean | null;       // if true, odds freshness guard fired
}

export interface EngineOutputValidationResult {
  valid: boolean;
  reason?: string;
}

// Stale signal threshold for live signals (15 seconds)
const LIVE_SIGNAL_STALE_MS = 15_000;

// Validates a computed engine output candidate before it is promoted to a signal.
// Returns { valid: true } if all invariants hold, or { valid: false, reason } otherwise.
export function validateEngineOutput(output: EngineOutputCandidate): EngineOutputValidationResult {
  const tag = output.playerName ?? output.id ?? output.gameId ?? "unknown";

  // Line must be present and finite
  if (output.line == null || !Number.isFinite(output.line)) {
    const reason = `line is ${output.line}`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Projection must be present and finite
  if (output.projection == null || !Number.isFinite(output.projection)) {
    const reason = `projection is ${output.projection}`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Probability must be present, finite, and within [0, 100]
  if (output.probability == null || !Number.isFinite(output.probability)) {
    const reason = `probability is ${output.probability}`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }
  if (output.probability < 0 || output.probability > 100) {
    const reason = `probability ${output.probability} outside [0, 100]`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Edge must be present and finite
  if (output.edge == null || !Number.isFinite(output.edge)) {
    const reason = `edge is ${output.edge}`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Consistency check (Phase 8): direction must be aligned with projection vs line
  if (output.recommendedSide === "OVER" && output.projection < output.line) {
    const reason = `OVER signal but projection ${output.projection} < line ${output.line}`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }
  if (output.recommendedSide === "UNDER" && output.projection > output.line) {
    const reason = `UNDER signal but projection ${output.projection} > line ${output.line}`;
    console.log(`[ENGINE INVALID OUTPUT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Phase 9 — Hard Rejection: no sportsbook data AND not explicitly derived
  if (!output.sportsbook && !output.derivedLine) {
    const reason = `no sportsbook data and not marked derivedLine`;
    console.log(`[ENGINE HARD REJECT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Phase 9 — Hard Rejection: invalid consensus
  if (output.isConsensusValid === false) {
    const reason = `consensus invalid (too few books or high line variance)`;
    console.log(`[ENGINE HARD REJECT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Phase 9 — Hard Rejection: stale timestamp for live signals
  if (output.isLiveSignal && output.createdAt != null) {
    const age = Date.now() - output.createdAt;
    if (age > LIVE_SIGNAL_STALE_MS) {
      const reason = `stale live signal (age=${age}ms > ${LIVE_SIGNAL_STALE_MS}ms)`;
      console.log(`[ENGINE HARD REJECT] ${tag}/${output.market ?? "?"} — ${reason}`);
      return { valid: false, reason };
    }
  }

  // Phase 17 — Hard Rejection: odds freshness guard explicitly fired
  if (output.isStale === true) {
    const reason = `odds are stale (freshness guard)`;
    console.log(`[ENGINE HARD REJECT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  // Phase 17 — Hard Rejection: timing gate explicitly closed
  if (output.timingValid === false) {
    const reason = `timing gate closed for this game state`;
    console.log(`[ENGINE HARD REJECT] ${tag}/${output.market ?? "?"} — ${reason}`);
    return { valid: false, reason };
  }

  return { valid: true };
}

// Batch-validates an array of output candidates.
// Returns only valid candidates and populates the accumulator with rejection stats.
export function filterValidEngineOutputs<T extends EngineOutputCandidate>(
  outputs: T[],
  accumulator?: { rejected: number; rejectionReasons: string[] }
): T[] {
  const valid: T[] = [];
  for (const output of outputs) {
    const result = validateEngineOutput(output);
    if (result.valid) {
      valid.push(output);
    } else {
      if (accumulator) {
        accumulator.rejected++;
        if (result.reason && !accumulator.rejectionReasons.includes(result.reason)) {
          accumulator.rejectionReasons.push(result.reason);
        }
      }
    }
  }
  return valid;
}
