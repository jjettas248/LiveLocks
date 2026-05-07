// ── LiveLocks Phase 1, Batch D — Canonical Signal View Model Bridge ──
// Adapter that joins a CanonicalSignal (transport currency) with the
// rich sport-specific payload still living in mlbEdgeCache. Returns a
// view model that surfaced routes hand to the UI today (MLBSignal shape)
// PLUS the canonical fields the UI now needs to render directly:
//
//   - lifecycleState        (canonical, never inferred from probability)
//   - lifecycleHistory      (for admin debug surfaces)
//   - canonicalSignalId     (stable id for dedupe / alert linkage)
//   - canonicalSurfacedAt   (timestamp of first observation)
//   - canonicalUpdatedAt    (timestamp of latest engine cycle)
//   - canonicalExpiresAt    (when bus will sweep stale)
//
// Wire shape stays MLBSignal-compatible so non-migrated UI continues to
// render. Migrated UI reads these new canonical fields directly without
// inferring tier or lifecycle from probability/score.
//
// HARD RULES (Batch D constraints):
//   1. Adapter NEVER mutates probability / signalTier / drivers /
//      bookLine — engine math is sealed post-bus.
//   2. Adapter NEVER infers lifecycleState — reads it straight from the
//      CanonicalSignal returned by the bus.
//   3. Adapter is the single boundary between canonical world and the
//      legacy MLBSignal wire shape. Routes call it; nothing else.

import type { CanonicalSignal } from "../../shared/canonicalSignal";
import type { MLBSignal } from "../../shared/mlbSignal";
import { getRegistered, getRegisteredById } from "./liveSignalBus";
import { mlbEdgeCache } from "../mlb/edgeCache";

// ── Bridge metrics (constraint 14) ───────────────────────────────────
interface BridgeMetrics {
  routeCanonicalReads: Record<string, number>; // route → count of canonical reads
  viewModelBridges: number;                    // count of CanonicalSignal → view model conversions
  bridgeMisses: number;                        // canonical present but mlbEdgeCache missing the rich payload
  hrRadarCanonicalReads: number;
  topPlaysCanonicalReads: number;
}

const _bridgeMetrics: BridgeMetrics = {
  routeCanonicalReads: {},
  viewModelBridges: 0,
  bridgeMisses: 0,
  hrRadarCanonicalReads: 0,
  topPlaysCanonicalReads: 0,
};

const BRIDGE_LOG_INTERVAL_MS = 60 * 1000;
const _lastBridgeLog: Map<string, number> = new Map();

function logRouteCanonicalRead(route: string, count: number): void {
  _bridgeMetrics.routeCanonicalReads[route] =
    (_bridgeMetrics.routeCanonicalReads[route] ?? 0) + 1;
  const now = Date.now();
  const last = _lastBridgeLog.get(route) ?? 0;
  if (now - last >= BRIDGE_LOG_INTERVAL_MS) {
    _lastBridgeLog.set(route, now);
    console.log(
      `[LL_ROUTE_CANONICAL_READ] route=${route} canonicalCount=${count} totalReads=${_bridgeMetrics.routeCanonicalReads[route]}`
    );
  }
}

function logBridge(label: string, hits: number, misses: number): void {
  _bridgeMetrics.viewModelBridges += hits;
  _bridgeMetrics.bridgeMisses += misses;
  const now = Date.now();
  const key = `bridge:${label}`;
  const last = _lastBridgeLog.get(key) ?? 0;
  if (now - last >= BRIDGE_LOG_INTERVAL_MS) {
    _lastBridgeLog.set(key, now);
    console.log(
      `[LL_CANONICAL_VIEWMODEL_BRIDGE] label=${label} hits=${hits} misses=${misses} totalBridges=${_bridgeMetrics.viewModelBridges}`
    );
  }
}

export function getBridgeMetrics() {
  return {
    routeCanonicalReads: { ..._bridgeMetrics.routeCanonicalReads },
    viewModelBridges: _bridgeMetrics.viewModelBridges,
    bridgeMisses: _bridgeMetrics.bridgeMisses,
    hrRadarCanonicalReads: _bridgeMetrics.hrRadarCanonicalReads,
    topPlaysCanonicalReads: _bridgeMetrics.topPlaysCanonicalReads,
  };
}

// ── View model shape ─────────────────────────────────────────────────
// Existing MLBSignal fields + canonical fields the UI consumes directly.
// Wire-compatible: a non-migrated UI ignoring the canonical* fields
// continues to render exactly as before.
export interface MlbSignalViewModel extends MLBSignal {
  // All canonical-* fields are nullable: per Batch D constraint #5 a bus
  // miss MUST surface as null (so the client renders "unknown") rather
  // than synthesizing values.
  canonicalSignalId: string | null;
  canonicalLifecycleState: CanonicalSignal["lifecycleState"] | null;
  canonicalSurfacedAt: number | null;
  canonicalUpdatedAt: number | null;
  canonicalExpiresAt: number | null;
  canonicalEngineGeneratedAt: number | null;
}

// Source ref pointer format: `${gameId}:${qualifiedSignalIndex}` written
// by canonicalMapper.toCanonicalFromMlb. We don't need to parse — we
// look up by playerId + market + side which are in the canonical itself.
function findMlbSignalForCanonical(c: CanonicalSignal): MLBSignal | null {
  // The canonical was minted from a normalized MLBSignal; the rich
  // payload is the result of normalizeMLBSignal which we cannot
  // re-run here without orchestrator context. Instead we look in the
  // route's just-built `signalsByGame[gameId]` map. The route passes
  // the map in via `attachCanonicalToMlbSignals` below — this fallback
  // path is only used when we don't have that map (e.g. metrics-only
  // inspection of bus state).
  return null;
}

/**
 * Stamp canonical fields onto an existing MLBSignal-shape array so the
 * route can return MLBSignal-compatible payloads with canonical fields
 * available for the UI to read directly. NEVER mutates engine math —
 * only the canonical* freshness/lifecycle fields are added.
 *
 * Matching rule: stable signalId is `${sport}:${gameId}:${actorId}:${market}:${side}`.
 * The MLBSignal carries playerId/market/recommendedSide/gameId — we
 * recompute the signalId here and look up via getRegisteredById.
 */
export function attachCanonicalToMlbSignals(
  signals: MLBSignal[],
  route: string
): MlbSignalViewModel[] {
  let hits = 0;
  let misses = 0;
  const out: MlbSignalViewModel[] = [];

  for (const s of signals) {
    const sport = "mlb";
    const actor = String(s.playerId ?? "unknown");
    const market = String(s.market ?? "unknown");
    const side = (s.recommendedSide ?? s.displaySide ?? "OVER") as "OVER" | "UNDER";
    const signalId = `${sport}:${s.gameId}:${actor}:${market}:${side}`;

    const canonical = getRegisteredById(signalId);

    if (canonical) {
      hits++;
      out.push({
        ...s,
        canonicalSignalId: signalId,
        canonicalLifecycleState: canonical.lifecycleState,
        canonicalSurfacedAt: canonical.surfacedAt,
        canonicalUpdatedAt: canonical.updatedAt,
        canonicalExpiresAt: canonical.expiresAt,
        canonicalEngineGeneratedAt: canonical.engineGeneratedAt,
      });
    } else {
      // Bus miss — the signal exists in mlbEdgeCache but never made it
      // through the canonical mirror. Per Batch D constraint #5, NEVER
      // fabricate canonical fields. Surface NULL so the client renders
      // "unknown" and the upstream gap is visible. The bridge miss is
      // logged via logBridge() below for diagnostics.
      misses++;
      out.push({
        ...s,
        canonicalSignalId: null,
        canonicalLifecycleState: null,
        canonicalSurfacedAt: null,
        canonicalUpdatedAt: null,
        canonicalExpiresAt: null,
        canonicalEngineGeneratedAt: null,
      });
    }
  }

  logRouteCanonicalRead(route, signals.length);
  logBridge(route, hits, misses);
  return out;
}

/**
 * Bus-driven inventory read. Returns the CanonicalSignal[] currently
 * registered for MLB — plus the matching MLBSignal payload pulled from
 * mlbEdgeCache.qualifiedSignals when available.
 *
 * Used by /api/top-plays and /api/mlb/hr-radar/ladder which previously
 * iterated mlbEdgeCache directly.
 */
export interface BusInventoryItem {
  canonical: CanonicalSignal;
  mlbSignal: MLBSignal | null;
}

export function readBusInventory(opts: {
  route: string;
  excludeTerminal?: boolean;
  freshOnlyWithinMs?: number;
}): BusInventoryItem[] {
  const canonicals = getRegistered({
    sport: "mlb",
    excludeTerminal: opts.excludeTerminal ?? true,
    freshOnlyWithinMs: opts.freshOnlyWithinMs,
  });

  if (opts.route.includes("hr-radar")) _bridgeMetrics.hrRadarCanonicalReads++;
  if (opts.route.includes("top-plays")) _bridgeMetrics.topPlaysCanonicalReads++;

  const out: BusInventoryItem[] = [];
  let hits = 0;
  let misses = 0;

  for (const c of canonicals) {
    // Look up the rich MLBSignal payload from mlbEdgeCache for the same
    // game + player + market. The cache stores qualifiedSignals[] keyed
    // by gameId; we walk the array to find the matching qualified row.
    const cached = mlbEdgeCache.get(c.gameId);
    let match: MLBSignal | null = null;
    if (cached?.qualifiedSignals) {
      for (const qs of cached.qualifiedSignals as any[]) {
        if (
          String(qs.playerId) === c.actorId &&
          String(qs.market) === c.market &&
          String(qs.side ?? qs.recommendedSide ?? "OVER").toUpperCase() === c.side
        ) {
          match = qs as MLBSignal;
          break;
        }
      }
    }
    if (match) hits++;
    else misses++;
    out.push({ canonical: c, mlbSignal: match });
  }

  logRouteCanonicalRead(opts.route, canonicals.length);
  logBridge(opts.route, hits, misses);
  return out;
}
