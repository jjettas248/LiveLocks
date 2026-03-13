// ── MLB Edge Output Cache ─────────────────────────────────────────────────────
// Written by triggerEngine after each orchestrator run.
// Read by /api/mlb/live-signals/:gameId — no recomputation on request.

import type { MLBPropOutput } from "./types";

export interface EdgeCacheEntry {
  outputs: MLBPropOutput[];
  updatedAt: number;
}

export const mlbEdgeCache = new Map<string, EdgeCacheEntry>();
