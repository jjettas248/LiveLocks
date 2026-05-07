// ── LiveLocks Batch B — Canonical Mapper ──────────────────────────────
// Pure transforms from sport-specific signal shapes into CanonicalSignal.
// Adding a new sport = add a new function here. Consumers MUST NOT read
// sport-specific shapes after this boundary.

import type { MLBSignal } from "../../shared/mlbSignal";
import type {
  CanonicalSignal,
  LifecycleState,
  Sport,
} from "../../shared/canonicalSignal";

// Stable signalId — same player+market+side across cycles maps to the
// same lifecycle record. NEVER include cycle-specific data (timestamps,
// rolling scores, etc) here.
export function mlbSignalId(sig: Pick<MLBSignal, "gameId" | "playerId" | "market" | "displaySide" | "recommendedSide">): string {
  const side = (sig.displaySide ?? sig.recommendedSide ?? "OVER").toUpperCase();
  return `mlb:${sig.gameId}:${sig.playerId}:${sig.market}:${side}`;
}

// HR-Radar / engine-evidence → lifecycle. ORTHOGONAL to signalTier;
// the lifecycle reflects the signal's resolution journey, the tier
// reflects the engine's confidence ladder. Both are recorded
// independently on CanonicalSignal.
export function deriveMlbLifecycleState(sig: MLBSignal): LifecycleState {
  // Terminal evidence first.
  if (sig.alreadyHit === true) return "cashed";

  // HR Radar bridge — promote watch→build→strong→elite cleanly so the
  // lifecycle store can transition without duplicate entries.
  const hrTier = (sig as any).hrAlert?.tier as string | undefined;
  if (hrTier === "fire" || hrTier === "elite") return "elite";
  if (hrTier === "ready" || hrTier === "strong") return "strong";
  if (hrTier === "live"  || hrTier === "build")  return "build";
  if (hrTier === "monitor" || hrTier === "watch") return "watch";

  // Non-HR markets: bettable + strong/elite tier → strong; bettable + lean → build;
  // watch tier OR not bettable → watch. NOTE: this is the lifecycle's
  // INITIAL placement based on engine evidence; downstream lifecycle
  // engine controls all subsequent transitions and the signalTier
  // field itself is preserved unchanged on the CanonicalSignal.
  const tier = sig.signalTier ?? "watch";
  const bettable = sig.isBettable === true;
  if (tier === "elite" && bettable) return "elite";
  if (tier === "strong" && bettable) return "strong";
  if (tier === "lean" && bettable) return "build";
  return "watch";
}

export function toCanonicalFromMlb(sig: MLBSignal, now: number = Date.now()): CanonicalSignal {
  const sport: Sport = "mlb";
  const side = (sig.displaySide ?? (sig.recommendedSide === "UNDER" ? "UNDER" : "OVER")) as "OVER" | "UNDER";
  const signalId = mlbSignalId(sig);
  const lifecycleState = deriveMlbLifecycleState(sig);

  return {
    signalId,
    sport,
    gameId: sig.gameId,
    actorId: sig.playerId,
    actorName: sig.playerName ?? sig.playerId,
    market: sig.market,
    side,

    displayProbability: sig.displayProbability ?? sig.enginePct ?? 0,
    overProbability: sig.overProbability ?? sig.calibratedProbabilityOver ?? null,
    underProbability: sig.underProbability ?? sig.calibratedProbabilityUnder ?? null,
    edge: sig.edge,
    projection: sig.projection,
    bookLine: sig.bookLine,

    signalTier: sig.signalTier ?? "watch",
    signalScore: sig.signalScore ?? 0,

    drivers: sig.canonicalDrivers ?? [],
    triggerSummary: sig.triggerSummary ?? null,

    lifecycleState,
    lifecycleHistory: [], // store fills in on first record
    engineGeneratedAt: now, // SignalBus may overwrite with orchestrator cycle ts
    surfacedAt: now,
    updatedAt: now,
    expiresAt: null,
    suppressionReason: null,
    expirationReason: null,

    sourceRef: { kind: "mlbSignal", pointer: signalId },
  };
}
