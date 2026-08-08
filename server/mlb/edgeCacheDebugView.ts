// Pure, testable view builder shared by the two MLB edge-cache debug admin
// routes (GET /api/admin/mlb-live-debug and GET /api/admin/live-debug).
// Takes cache entries as an explicit argument rather than reaching into
// mlbEdgeCache module state, so it can be unit-tested with plain fixtures.
// See server/mlb/edgeCacheDebugView.test.ts for the characterization test
// pinning the exact shapes both routes depend on.

export interface MlbEdgeDebugCacheEntryInput {
  updatedAt: number;
  createdAt: number;
  outputs?: unknown[];
  qualifiedSignals?: unknown[];
  allSignals?: unknown[];
  isDegraded?: boolean;
  signalLocked?: boolean;
  preservedAt?: number;
  gameCardTags?: string[];
}

export interface MlbEdgeDebugEntry {
  sport: "mlb";
  gameId: string;
  updatedAt: number;
  ageSec: number | null;
  createdAt: number;
  outputs: number;
  qualifiedSignals: number;
  allSignals: number;
  isDegraded: boolean;
  signalLocked: boolean;
  preservedAt: number | null;
  tags: string[];
}

export function buildMlbEdgeEntriesDebugView(
  entries: Iterable<[string, MlbEdgeDebugCacheEntryInput]>,
  now: number,
): MlbEdgeDebugEntry[] {
  return Array.from(entries).map(([gameId, entry]) => ({
    sport: "mlb" as const,
    gameId,
    updatedAt: entry.updatedAt,
    ageSec: entry.updatedAt ? Math.round((now - entry.updatedAt) / 1000) : null,
    createdAt: entry.createdAt,
    outputs: entry.outputs?.length ?? 0,
    qualifiedSignals: entry.qualifiedSignals?.length ?? 0,
    allSignals: entry.allSignals?.length ?? 0,
    isDegraded: entry.isDegraded ?? false,
    signalLocked: entry.signalLocked ?? false,
    preservedAt: entry.preservedAt ?? null,
    tags: entry.gameCardTags ?? [],
  }));
}
