// ── MLB Market Signal View Model (LiveLocks Phase 1 — surfacing) ──────
// Pure transform: MLBSignal (+ optional CanonicalSignal) → view model
// the UI renders directly. Encodes the signal-first grouping rules
// (urgent / actionable / forming / monitor / resolved) and
// inning-aware sort priority.
//
// HARD CONTRACT:
//   - This module performs ZERO engine math. It only reads fields the
//     engine + canonical mapper already produced.
//   - It does NOT mutate CanonicalSignal or MLBSignal — outputs a new
//     object only.
//   - Probability / edge / EV are NEVER primary sort keys.
//   - Lifecycle vs tier: when they disagree, the *stronger* of the two
//     wins (max-of). Approved by user.

import type { MLBSignal } from "../../shared/mlbSignal";
import type { CanonicalSignal, LifecycleState } from "../../shared/canonicalSignal";
import {
  getMlbInningWindow,
  getMlbInningWindowPriority,
  type MlbInningWindow,
} from "../../shared/mlbInningWindow";
import type { SignalDriver } from "../../shared/signalDrivers";

// ── Types ─────────────────────────────────────────────────────────────

export type MarketActionability =
  | "urgent"
  | "actionable"
  | "forming"
  | "monitor"
  | "resolved";

export type MarketDisplayGroup =
  | "ACTION_NOW"
  | "BUILDING"
  | "MONITOR"
  | "RESOLVED";

export type InningSource =
  | "game_state"
  | "signal"
  | "hr_radar"
  | "fallback"
  | "unknown";

export interface MarketSignalViewModel {
  // Identity
  signalId: string;
  sport: "mlb";
  gameId: string;
  playerId: string;
  playerName: string;
  team: string | null;
  opponent: string | null;

  // Market
  market: string;
  marketLabel: string;
  side: "OVER" | "UNDER";
  line: number | null;
  odds: number | null;

  // Engine (read-only mirrors)
  probability: number;
  projection: number | null;
  edge: number | null;

  // Tiering / lifecycle
  signalTier: "watch" | "lean" | "strong" | "elite";
  lifecycleState: LifecycleState;

  // Inning context (UX-only, additive — does NOT live on CanonicalSignal)
  inning: number | null;
  inningWindow: MlbInningWindow;
  inningSource: InningSource;

  // Surfacing decision
  marketActionability: MarketActionability;
  primarySignalLabel: string;
  secondarySignalLabel: string | null;
  drivers: SignalDriver[];
  triggerSummary: string | null;

  // Sort + grouping
  sortPriority: number;
  urgencyScore: number;
  displayGroup: MarketDisplayGroup;
}

// ── Internal mappers ──────────────────────────────────────────────────

const TIER_RANK: Record<MarketSignalViewModel["signalTier"], number> = {
  watch: 0,
  lean: 1,
  strong: 2,
  elite: 3,
};

const LIFECYCLE_RANK: Record<LifecycleState, number> = {
  watch: 0,
  build: 1,
  strong: 2,
  elite: 3,
  cashed: 99,
  missed: 99,
  expired: 99,
};

function isTerminal(s: LifecycleState): boolean {
  return s === "cashed" || s === "missed" || s === "expired";
}

/**
 * Per user-approved rule (max-of): when lifecycleState and signalTier
 * disagree, the STRONGER wins. Terminal lifecycles always force
 * "resolved" — they are evidence of a graded outcome and outrank tier.
 */
export function deriveMarketActionability(
  signalTier: MarketSignalViewModel["signalTier"],
  lifecycleState: LifecycleState,
): MarketActionability {
  if (isTerminal(lifecycleState)) return "resolved";
  const tierRank = TIER_RANK[signalTier] ?? 0;
  const lifeRank = LIFECYCLE_RANK[lifecycleState] ?? 0;
  const stronger = Math.max(tierRank, lifeRank);
  if (stronger >= 3) return "urgent";      // elite (either axis)
  if (stronger >= 2) return "actionable";  // strong
  if (stronger >= 1) return "forming";     // lean / build
  return "monitor";                        // watch
}

export function actionabilityToDisplayGroup(a: MarketActionability): MarketDisplayGroup {
  if (a === "resolved") return "RESOLVED";
  if (a === "urgent" || a === "actionable") return "ACTION_NOW";
  if (a === "forming") return "BUILDING";
  return "MONITOR";
}

const ACTIONABILITY_RANK: Record<MarketActionability, number> = {
  resolved: 0,   // intentionally lowest — resolved sinks to bottom
  monitor: 1,
  forming: 2,
  actionable: 3,
  urgent: 4,
};

function tierRankSafe(t: MarketSignalViewModel["signalTier"] | undefined): number {
  return TIER_RANK[t ?? "watch"] ?? 0;
}

// ── Inning resolution ────────────────────────────────────────────────

function resolveInning(sig: MLBSignal): { inning: number | null; source: InningSource; reason?: string } {
  // 1) Direct signal field — engine populated, primary truth.
  if (typeof sig.inning === "number" && Number.isFinite(sig.inning) && sig.inning >= 1) {
    return { inning: Math.floor(sig.inning), source: "signal" };
  }
  // 2) HR Radar carries its own inning context for HR markets.
  const hr = sig.hrAlert;
  if (hr) {
    if (typeof hr.currentInning === "number" && Number.isFinite(hr.currentInning) && hr.currentInning >= 1) {
      return { inning: Math.floor(hr.currentInning), source: "hr_radar" };
    }
    if (typeof hr.detectedInning === "number" && Number.isFinite(hr.detectedInning) && hr.detectedInning >= 1) {
      return { inning: Math.floor(hr.detectedInning), source: "hr_radar" };
    }
  }
  // 3) Pregame / no game state yet.
  if (sig.gameStatus === "pregame") {
    return { inning: null, source: "unknown", reason: "pregame_signal" };
  }
  // 4) Fallback / unresolved.
  return { inning: null, source: "unknown", reason: "missing_game_state" };
}

// ── Labels ───────────────────────────────────────────────────────────

function makePrimaryLabel(action: MarketActionability, window: MlbInningWindow): string {
  if (action === "resolved") return "Resolved";
  if (action === "urgent")   return window === "late" ? "LATE · ACTION" : "URGENT";
  if (action === "actionable") return window === "late" ? "LATE · STRONG" : "ACTIONABLE";
  if (action === "forming")  return window === "early" ? "EARLY · BUILD" : "BUILDING";
  return "MONITOR";
}

function makeSecondaryLabel(window: MlbInningWindow): string | null {
  switch (window) {
    case "late":    return "Late attack window";
    case "early":   return "Early setup";
    case "mid":     return "Mid-game watch";
    case "unknown": return "Unknown inning";
    case "all":     return null;
  }
}

// ── Public transform ────────────────────────────────────────────────

export interface ViewModelOptions {
  /**
   * Optional canonical signal already produced by the canonical mapper.
   * When present we read lifecycleState / signalTier from it (it's the
   * canonical truth). When absent we fall back to the MLBSignal's own
   * confidenceTier-derived fields.
   */
  canonical?: CanonicalSignal | null;
  /** Source endpoint label for [MLB_MARKET_VIEWMODEL] diagnostics. */
  sourceEndpoint?: string;
  /** Suppress diagnostic logs (e.g. when bulk-mapping in a tight loop). */
  silent?: boolean;
}

export function toMarketSignalViewModel(
  sig: MLBSignal,
  opts: ViewModelOptions = {},
): MarketSignalViewModel {
  const canonical = opts.canonical ?? null;

  const signalTier =
    (canonical?.signalTier ??
      sig.signalTier ??
      mapConfidenceTierToSignalTier(sig.confidenceTier)) as MarketSignalViewModel["signalTier"];

  const lifecycleState: LifecycleState = canonical?.lifecycleState ?? "watch";

  const { inning, source: inningSource, reason: inningReason } = resolveInning(sig);
  const inningWindow = getMlbInningWindow(inning);

  if (inningWindow === "unknown" && !opts.silent) {
    console.log(
      `[MLB_UNKNOWN_INNING_DATA] signalId=${canonical?.signalId ?? sig.playerId + ":" + sig.market} ` +
        `gameId=${sig.gameId} reason=${inningReason ?? "unspecified"} status=${sig.gameStatus ?? "?"}`,
    );
  }

  const marketActionability = deriveMarketActionability(signalTier, lifecycleState);
  const displayGroup = actionabilityToDisplayGroup(marketActionability);

  const inningPri = getMlbInningWindowPriority(inningWindow);
  const actionPri = ACTIONABILITY_RANK[marketActionability];
  const tierPri = tierRankSafe(signalTier);
  const driverCount = (canonical?.drivers?.length ?? sig.canonicalDrivers?.length ?? 0);

  // Sort priority is a pure deterministic composition. Probability and
  // edge are tie-breakers ONLY (lowest weight), never primary keys.
  // Layout (high → low):
  //   actionability * 1e9 + inningWindow * 1e7 + tier * 1e5 +
  //   driverCount * 1e3 + lifecycleFreshness + prob/edge tiebreakers
  const lifecycleFreshness = canonical?.surfacedAt
    ? Math.min(999, Math.floor((Date.now() - canonical.surfacedAt) / 60_000))
    : 0;
  // Newer surfaced = lower freshnessMinutes = higher priority → invert.
  const freshnessTerm = Math.max(0, 999 - lifecycleFreshness);

  const sortPriority =
    actionPri * 1_000_000_000 +
    inningPri * 10_000_000 +
    tierPri * 100_000 +
    driverCount * 1_000 +
    freshnessTerm;

  const urgencyScore = actionPri * 100 + inningPri * 10 + tierPri;

  const probability = canonical?.displayProbability ?? sig.displayProbability ?? sig.enginePct ?? 0;
  const projection = canonical?.projection ?? sig.projection ?? null;
  const edge = canonical?.edge ?? sig.edge ?? null;
  const odds = sig.recommendedSide === "UNDER" ? sig.underOdds : sig.overOdds;

  const drivers: SignalDriver[] =
    canonical?.drivers ?? sig.canonicalDrivers ?? [];

  const vm: MarketSignalViewModel = {
    signalId: canonical?.signalId ?? `mlb:${sig.gameId}:${sig.playerId}:${sig.market}:${sig.recommendedSide ?? "OVER"}`,
    sport: "mlb",
    gameId: sig.gameId,
    playerId: sig.playerId,
    playerName: sig.playerName,
    team: sig.isTopInning ? sig.awayAbbr ?? null : sig.homeAbbr ?? null,
    opponent: sig.isTopInning ? sig.homeAbbr ?? null : sig.awayAbbr ?? null,

    market: sig.market,
    marketLabel: sig.market,
    side: ((canonical?.side ?? sig.displaySide ?? sig.recommendedSide ?? "OVER") as "OVER" | "UNDER"),
    line: canonical?.bookLine ?? sig.bookLine ?? null,
    odds: typeof odds === "number" ? odds : null,

    probability,
    projection,
    edge,

    signalTier,
    lifecycleState,

    inning,
    inningWindow,
    inningSource,

    marketActionability,
    primarySignalLabel: makePrimaryLabel(marketActionability, inningWindow),
    secondarySignalLabel: makeSecondaryLabel(inningWindow),
    drivers,
    triggerSummary: canonical?.triggerSummary ?? sig.triggerSummary ?? null,

    sortPriority,
    urgencyScore,
    displayGroup,
  };

  if (!opts.silent) {
    console.log(
      `[MLB_MARKET_VIEWMODEL] src=${opts.sourceEndpoint ?? "?"} signalId=${vm.signalId} ` +
        `tier=${vm.signalTier} lifecycle=${vm.lifecycleState} action=${vm.marketActionability} ` +
        `group=${vm.displayGroup} window=${vm.inningWindow} inning=${vm.inning ?? "?"} ` +
        `inningSource=${vm.inningSource}`,
    );
    console.log(
      `[MLB_MARKET_ACTIONABILITY] signalId=${vm.signalId} action=${vm.marketActionability} ` +
        `tier=${vm.signalTier} lifecycle=${vm.lifecycleState}`,
    );
    console.log(
      `[MLB_INNING_WINDOW] signalId=${vm.signalId} window=${vm.inningWindow} ` +
        `inning=${vm.inning ?? "?"} source=${vm.inningSource}`,
    );
  }

  return vm;
}

// ── Sorting + grouping helpers ──────────────────────────────────────

export function sortMarketSignals(rows: MarketSignalViewModel[]): MarketSignalViewModel[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.sortPriority !== b.sortPriority) return b.sortPriority - a.sortPriority;
    // True tie-breakers: probability THEN edge. Both intentionally last
    // so they can never out-rank actionability/inning/tier.
    const aProb = a.probability ?? 0;
    const bProb = b.probability ?? 0;
    if (aProb !== bProb) return bProb - aProb;
    const aEdge = a.edge ?? 0;
    const bEdge = b.edge ?? 0;
    if (aEdge !== bEdge) return bEdge - aEdge;
    return a.signalId.localeCompare(b.signalId);
  });
  if (sorted.length > 0) {
    console.log(
      `[MLB_MARKET_SORT] count=${sorted.length} top=${sorted[0].signalId} ` +
        `topAction=${sorted[0].marketActionability} topWindow=${sorted[0].inningWindow}`,
    );
  }
  return sorted;
}

export interface GroupedMarketSignals {
  ACTION_NOW: MarketSignalViewModel[];
  BUILDING: MarketSignalViewModel[];
  MONITOR: MarketSignalViewModel[];
  RESOLVED: MarketSignalViewModel[];
}

export function groupByDisplayGroup(rows: MarketSignalViewModel[]): GroupedMarketSignals {
  const out: GroupedMarketSignals = {
    ACTION_NOW: [],
    BUILDING: [],
    MONITOR: [],
    RESOLVED: [],
  };
  for (const r of rows) out[r.displayGroup].push(r);
  return out;
}

/**
 * Counts unknown-inning rows + tallies the most likely cause for the
 * admin diagnostics endpoint. Pure read.
 */
export function summarizeUnknownInning(rows: MarketSignalViewModel[]): {
  unknownInningCount: number;
  unknownInningReasons: Record<string, number>;
} {
  let unknownInningCount = 0;
  const unknownInningReasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.inningWindow !== "unknown") continue;
    unknownInningCount++;
    const key = r.inningSource ?? "unknown";
    unknownInningReasons[key] = (unknownInningReasons[key] ?? 0) + 1;
  }
  return { unknownInningCount, unknownInningReasons };
}

// ── Local fallback: confidenceTier → signalTier ─────────────────────
// Mirrors deriveSignalTier in the orchestrator. Only used when neither
// canonical.signalTier nor sig.signalTier is present (cache rollover).
function mapConfidenceTierToSignalTier(
  confidenceTier: string | undefined,
): MarketSignalViewModel["signalTier"] {
  const t = (confidenceTier ?? "").toUpperCase();
  if (t === "ELITE") return "elite";
  if (t === "STRONG") return "strong";
  if (t === "LEAN" || t === "MODERATE") return "lean";
  return "watch";
}
