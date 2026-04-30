import { mlbEdgeCache } from "./edgeCache";
import { normalizeMlbMarket } from "../../shared/normalizeMlbMarket";
import {
  CanonicalMlbSignal,
  CanonicalSignalState,
  CanonicalSide,
  ENGINE_SOURCE_LABEL,
} from "../../shared/mlbCanonicalSignal";
import type { MLBQualifiedSignal, MLBPropOutput } from "./types";

const MODE_RANK: Record<string, number> = {
  elite: 5, hr_elite: 5,
  strong: 4, hr_strong: 4,
  lean: 3,
  heating_up: 2, hr_heating_up: 2,
  watch: 1, hr_watch: 1,
};

function mapModeToState(mode: string | null | undefined, score: number): CanonicalSignalState {
  const m = (mode ?? "").toLowerCase();
  if (m === "elite" || m === "strong" || m === "hr_elite" || m === "hr_strong") return "strong";
  if (m === "lean" || m === "heating_up" || m === "hr_heating_up") return "building";
  if (m === "watch" || m === "hr_watch") return "watch";
  if (score > 0) return "monitor";
  return "monitor";
}

const STATE_FLOOR: Record<Exclude<CanonicalSignalState, "none">, number> = {
  strong: 72, building: 58, watch: 42, monitor: 30,
};
const STATE_CEIL: Record<Exclude<CanonicalSignalState, "none">, number> = {
  strong: 95, building: 78, watch: 60, monitor: 50,
};

function computeEngineConfidence(sig: any, state: CanonicalSignalState): number {
  if (state === "none") return 0;
  const base = Number.isFinite(sig.signalStrengthScore as number)
    ? (sig.signalStrengthScore as number)
    : (sig.signalScore ?? 0);
  const opp = Number.isFinite(sig.opportunityScore as number)
    ? Math.max(0, Math.min(100, sig.opportunityScore as number))
    : 0;
  const blended = base * 0.8 + opp * 0.2;
  const floor = STATE_FLOOR[state];
  const ceil = STATE_CEIL[state];
  const clamped = Math.max(floor, Math.min(ceil, blended));
  return Math.round(clamped * 10) / 10;
}

export interface ResolveSignalArgs {
  gameId: string;
  playerId: string;
  market: string;
  line?: number | null;
}

/**
 * Canonical resolver — returns the engine signal for a (gameId, playerId,
 * market[, line]) tuple from the live edge cache, in a shape both the
 * box score badge and the calculator panel render identically. Returns
 * null when no engine signal exists.
 *
 * Invariants enforced:
 *   - over+under sum to ~100 (logged as [MLB_SIGNAL_PROB_MISMATCH] if drift > 1)
 *   - recommendedSide is consistent with whichever probability is larger
 *     when the engine reported one (logged as [MLB_SIGNAL_SIDE_INVERTED] otherwise)
 */
export function resolveMlbPlayerMarketSignal(
  args: ResolveSignalArgs,
): CanonicalMlbSignal | null {
  const entry = mlbEdgeCache.get(args.gameId);
  if (!entry) return null;

  const all = (entry.allSignals ?? []) as MLBQualifiedSignal[];
  if (all.length === 0) return null;

  const wantMarket = normalizeMlbMarket(args.market);
  if (!wantMarket) return null;

  let candidates = all.filter(s =>
    s.playerId === args.playerId && normalizeMlbMarket(s.market) === wantMarket
  );
  if (candidates.length === 0) return null;

  // Line-strict tuple lookup: when a line is provided, only accept candidates
  // whose line matches within tolerance. If none exist, return null so the
  // calculator falls back to its own math instead of mis-attributing a
  // different line's engine probability to this tuple.
  if (args.line != null && Number.isFinite(args.line)) {
    const wantLine = args.line as number;
    const exact = candidates.filter(
      s => s.line != null && Math.abs(s.line - wantLine) < 0.01,
    );
    if (exact.length === 0) {
      console.log(
        `[MLB_CANONICAL_RESOLVE] line-miss player=${args.playerId} market=${wantMarket} requestedLine=${wantLine} availableLines=${candidates.map(c => c.line).join(",")}`,
      );
      return null;
    }
    candidates = exact;
  }

  const sorted = [...candidates].sort((a, b) => {
    const aMode = MODE_RANK[((a as any).mode ?? "").toLowerCase()] ?? 0;
    const bMode = MODE_RANK[((b as any).mode ?? "").toLowerCase()] ?? 0;
    if (aMode !== bMode) return bMode - aMode;
    return (b.signalScore ?? 0) - (a.signalScore ?? 0);
  });

  const sig = sorted[0];
  const sigAny = sig as any;
  const state = mapModeToState(sigAny.mode, sig.signalScore ?? 0);

  // Look up the raw engine output for paired Over/Under probabilities. The
  // qualified signal only carries the recommended-side probability, so we
  // mirror the lookup the edge-feed route does (normalized market key) — but
  // we MUST key by line as well, otherwise multi-line tuples (same player +
  // market at different lines) can attach the wrong paired probabilities.
  const outputs = entry.outputs ?? [];
  let raw: MLBPropOutput | null = null;
  if (sig.line != null) {
    raw = outputs.find(o =>
      o.playerId === sig.playerId
      && normalizeMlbMarket(o.market) === wantMarket
      && o.bookLine != null
      && Math.abs(o.bookLine - (sig.line as number)) < 0.01,
    ) ?? null;
  } else {
    raw = outputs.find(o =>
      o.playerId === sig.playerId && normalizeMlbMarket(o.market) === wantMarket,
    ) ?? null;
  }
  if (raw == null && outputs.length > 0) {
    const fallback = outputs.find(o =>
      o.playerId === sig.playerId && normalizeMlbMarket(o.market) === wantMarket,
    );
    if (fallback) {
      console.log(
        `[MLB_SIGNAL_PROB_MISMATCH] output line-miss player=${sig.playerName} market=${wantMarket} sigLine=${sig.line} outputLines=${outputs.filter(o => o.playerId === sig.playerId && normalizeMlbMarket(o.market) === wantMarket).map(o => o.bookLine).join(",")} — using engineProbability fallback`,
      );
    }
  }

  let overP: number | null = raw?.calibratedProbabilityOver ?? null;
  let underP: number | null = raw?.calibratedProbabilityUnder ?? null;
  if (overP == null && underP == null) {
    const sided = sig.engineProbability ?? 0;
    if (sig.side === "UNDER") {
      underP = sided;
      overP = 100 - sided;
    } else {
      overP = sided;
      underP = 100 - sided;
    }
  } else if (overP == null && underP != null) {
    overP = 100 - underP;
  } else if (underP == null && overP != null) {
    underP = 100 - overP;
  }

  // Invariant: paired probabilities should sum to ~100. Log + snap when off.
  const sum = (overP ?? 0) + (underP ?? 0);
  if (Math.abs(sum - 100) > 1) {
    console.log(
      `[MLB_SIGNAL_PROB_MISMATCH] player=${sig.playerName} market=${wantMarket} line=${sig.line} over=${overP} under=${underP} sum=${sum.toFixed(2)} — snapping`,
    );
    if (overP != null && underP == null) underP = 100 - overP;
    else if (underP != null && overP == null) overP = 100 - underP;
    else if (overP != null && underP != null) {
      // Trust the larger side and snap the other.
      if (overP >= underP) underP = Math.max(0, 100 - overP);
      else overP = Math.max(0, 100 - underP);
    }
  }

  // Side-inversion guard: recommendedSide should align with which probability
  // is larger. Engine recommendations may sometimes follow odds/EV rather
  // than purely the higher prob — log the rare inversion for audit.
  const recSide: CanonicalSide = (sig.side === "OVER" || sig.side === "UNDER")
    ? sig.side
    : "NO_EDGE";
  if (recSide !== "NO_EDGE" && overP != null && underP != null) {
    const recProb = recSide === "OVER" ? overP : underP;
    const otherProb = recSide === "OVER" ? underP : overP;
    if (otherProb - recProb > 5) {
      console.log(
        `[MLB_SIGNAL_SIDE_INVERTED] player=${sig.playerName} market=${wantMarket} line=${sig.line} recSide=${recSide} recProb=${recProb.toFixed(1)} otherProb=${otherProb.toFixed(1)}`,
      );
    }
  }

  const drivers = Array.isArray(sig.reasons) ? sig.reasons.slice(0, 4) : [];
  const engineConfidence = computeEngineConfidence(sig, state);

  return {
    gameId: sig.gameId,
    playerId: sig.playerId,
    playerName: sig.playerName,
    team: sig.team ?? "",
    market: wantMarket,
    line: sig.line ?? null,

    recommendedSide: recSide,
    overProbability: Math.round((overP ?? 0) * 10) / 10,
    underProbability: Math.round((underP ?? 0) * 10) / 10,
    engineConfidence,
    rawProbability: sig.engineProbability ?? null,

    signalState: state,
    drivers,

    source: "engine",
    label: ENGINE_SOURCE_LABEL,
    updatedAt: entry.updatedAt ?? Date.now(),
  };
}
