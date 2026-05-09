// NBA Probability Finalizer (calibration-v2)
//
// Purpose: post-engine NBA-only finalizer that addresses the 80–100% bucket
// overconfidence (28.6% actual vs 60.1% overall). Applies dampened modifier
// stacking (weights 1.0 / 0.5 / 0.25 / 0.1), market-risk caps, an elite gate
// for the 77–82% band, a hard 82% ceiling, fragility subtraction, and a
// conflict survivor cap when both OVER and UNDER fire on the same family.
//
// HARD CONTRACTS:
//   • NBA-only — never imported from MLB/NCAAB code paths.
//   • Pure function. No I/O, no clock, no side effects.
//   • Operates on a calibrated probability already produced by the engine.
//   • Stamps `calibrationVersion = "nba-calibration-v2"` so analytics can
//     bucket plays before/after the change.

import {
  isVolatileArchetype,
  isImpactedArchetype,
  type NBAArchetype,
} from "./archetypes";
import { isComboMarket } from "./marketTaxonomy";

export const NBA_CALIBRATION_VERSION = "nba-calibration-v2";

// Odds older than this are considered stale; the elite gate requires
// explicitly fresh odds and treats unknown freshness as NOT fresh.
export const NBA_FRESH_ODDS_MAX_AGE_SEC = 600;

/**
 * Production-side freshness derivation. Centralized so engine, storage,
 * and the audit script all derive freshOdds from the same rule:
 * undefined / NaN / non-numeric → FALSE (fail-closed).
 */
export function deriveFreshOdds(oddsAgeSec: number | null | undefined): boolean {
  return typeof oddsAgeSec === "number" && Number.isFinite(oddsAgeSec)
    ? oddsAgeSec < NBA_FRESH_ODDS_MAX_AGE_SEC
    : false;
}

const LOW_VOLUME_MARKETS = new Set([
  "steals",
  "blocks",
  "threes",
  "three_pointers_made",
  "fg3m",
  "stl_blk",
  "blocks_steals",
  "steals_blocks",
]);

export type MarketRiskTier = "low_volume" | "combo" | "volatile" | "normal";

export interface FinalizerContext {
  rawSide: "OVER" | "UNDER";
  market: string;
  archetype: NBAArchetype;
  isCombo?: boolean;            // optional override; defaults to isComboMarket(market)
  fragilityScore: number;       // 0..1
  isPlayoffs: boolean;
  // Soft signals used by the elite-gate. Missing values fail closed.
  minutesCertainty?: number;    // 0..1 — 1 = highly certain rotation
  projectionDeltaPct?: number;  // |proj - line| / max(|line|,1)
  edgeFromGapOnly?: boolean;    // true = edge driven primarily by book/model gap
  freshOdds?: boolean;          // false → fail elite gate
  // External: set by the route layer when both sides of a market fire.
  conflictingSideSuppressed?: boolean;
}

export interface FinalizerModifier {
  name: string;
  rawDeltaPp: number;     // pp it would have removed at full weight (>=0)
  weight: number;         // 1.0 / 0.5 / 0.25 / 0.1
  appliedDeltaPp: number; // rawDeltaPp * weight
}

export interface FinalizerResult {
  pSideFinal: number;            // 0..1
  finalProbabilityPct: number;   // 0..100 (rawSide-perspective)
  initialProbabilityPct: number; // 0..100 (rawSide-perspective, pre-finalizer)
  capApplied: boolean;
  capReason: string | null;
  marketRiskTier: MarketRiskTier;
  modifierStack: FinalizerModifier[];
  fragilityDeltaPp: number;
  highBucketCapped: boolean;     // true if hard 82 ceiling clipped the value
  conflictSuppressionApplied: boolean;
  eliteGateApplied: boolean;
  calibrationVersion: typeof NBA_CALIBRATION_VERSION;
}

const STACK_WEIGHTS = [1.0, 0.5, 0.25, 0.1];
const HARD_CEILING_PP = 82;
const CONFLICT_SURVIVOR_CAP_PP = 68;
// Elite gate now applies to ANY post-stack value above 76. The previous
// [77,82] band was bypassable: a 90% non-elite play would reach the hard
// 82 ceiling without ever consulting the elite gate. Now any working pp >76
// without elite eligibility is forced to 74. Hard 82 ceiling still applies
// to elite-passing plays as the absolute upper bound.
const ELITE_GATE_FLOOR_PP = 76;
const ELITE_FAIL_CAP_PP = 74;
const LOW_VOLUME_CAP_PP = 72;
const COMBO_CAP_PP = 76;

function classifyMarketRisk(market: string, isCombo: boolean, archetype: NBAArchetype): MarketRiskTier {
  const m = market.toLowerCase();
  if (LOW_VOLUME_MARKETS.has(m)) return "low_volume";
  if (isCombo) return "combo";
  if (isVolatileArchetype(archetype) || isImpactedArchetype(archetype)) return "volatile";
  return "normal";
}

function archetypeCapPp(archetype: NBAArchetype): number | null {
  // Per-archetype hard caps. Only volatile / impacted / role_uncertain
  // archetypes carry a cap — stable archetypes return null and contribute
  // nothing to the cap composition.
  switch (archetype) {
    case "bench_microwave":
    case "low_minute_big":
    case "role_uncertain":
      return 70;
    case "volatile_starter":
    case "lineup_impacted":
      return 72;
    default:
      return null;
  }
}

function eliteFailureReason(ctx: FinalizerContext): string | null {
  const minCertainty = ctx.minutesCertainty ?? 0;
  const projDelta = ctx.projectionDeltaPct ?? 0;
  const fresh = ctx.freshOdds === true;
  if (ctx.conflictingSideSuppressed) return "conflicting_side";
  if (!fresh) return "stale_or_unknown_odds";
  if (ctx.fragilityScore >= 0.30) return "fragility_too_high";
  if (minCertainty < 0.65) return "minutes_certainty_too_low";
  if (projDelta < 0.06) return "projection_separation_too_thin";
  if (ctx.edgeFromGapOnly === true) return "edge_from_gap_only";
  const tier = classifyMarketRisk(ctx.market, ctx.isCombo ?? isComboMarket(ctx.market), ctx.archetype);
  if (tier === "low_volume") return "low_volume_market";
  return null;
}

function eliteEligible(ctx: FinalizerContext): boolean {
  return eliteFailureReason(ctx) === null;
}

/**
 * Apply NBA-only post-engine finalizer.
 *
 * Always returns a probability in [0.02, 0.98] (rawSide perspective).
 * NEVER raises probability — finalizer can only equal-or-reduce.
 */
export function finalizeNbaProbability(
  pSideCalibrated: number,
  ctx: FinalizerContext,
): FinalizerResult {
  const initialPp = Math.max(2, Math.min(98, pSideCalibrated * 100));
  const isCombo = ctx.isCombo ?? isComboMarket(ctx.market);
  const tier = classifyMarketRisk(ctx.market, isCombo, ctx.archetype);

  // ── Build candidate soft modifiers (downward only) ───────────────────────
  const candidates: Array<Omit<FinalizerModifier, "weight" | "appliedDeltaPp">> = [];

  // Market-risk caps. Each applicable cap composes as an independent
  // candidate — they are NOT mutually exclusive. A volatile combo player
  // on a low-volume market must satisfy ALL three caps. classifyMarketRisk
  // is retained for diagnostics/admin telemetry only; it no longer gates
  // which cap fires.
  const archetypeCap = archetypeCapPp(ctx.archetype);
  if (LOW_VOLUME_MARKETS.has(ctx.market.toLowerCase()) && initialPp > LOW_VOLUME_CAP_PP) {
    candidates.push({ name: "low_volume_cap_72", rawDeltaPp: initialPp - LOW_VOLUME_CAP_PP });
  }
  // Combo cap exception: a combo market may exceed 76 ONLY when minutes
  // certainty is high AND projected volatility is low. Operationally we
  // approximate "low volatility" with: non-volatile/non-impacted archetype,
  // fragilityScore < 0.30, and projection separation ≥ 6pp. When ANY of
  // those fail, the 76 hard cap applies. This keeps combos honest while
  // still letting truly stable, well-separated combos breathe.
  const _comboHighCertainty = (ctx.minutesCertainty ?? 0) >= 0.80;
  const _comboLowVolatility =
    !isVolatileArchetype(ctx.archetype) &&
    !isImpactedArchetype(ctx.archetype) &&
    ctx.fragilityScore < 0.30 &&
    (ctx.projectionDeltaPct ?? 0) >= 0.06;
  const _comboCapExempt = _comboHighCertainty && _comboLowVolatility;
  if (isCombo && !_comboCapExempt && initialPp > COMBO_CAP_PP) {
    candidates.push({ name: "combo_cap_76", rawDeltaPp: initialPp - COMBO_CAP_PP });
  }
  if (archetypeCap !== null && initialPp > archetypeCap) {
    candidates.push({ name: `volatile_cap_${archetypeCap}`, rawDeltaPp: initialPp - archetypeCap });
  }

  // Fragility subtraction — 4–8 pp, only above the 0.40 fragility threshold.
  let fragilityDeltaPp = 0;
  if (ctx.fragilityScore >= 0.40) {
    fragilityDeltaPp = 4 + 4 * Math.min(1, ctx.fragilityScore);
    candidates.push({ name: "fragility_subtraction", rawDeltaPp: fragilityDeltaPp });
  }

  // ── Dampened stacking (1.0 / 0.5 / 0.25 / 0.1) ───────────────────────────
  candidates.sort((a, b) => b.rawDeltaPp - a.rawDeltaPp);
  const stack: FinalizerModifier[] = [];
  let totalDeltaPp = 0;
  for (let i = 0; i < candidates.length; i++) {
    const w = STACK_WEIGHTS[Math.min(i, STACK_WEIGHTS.length - 1)];
    if (candidates[i].rawDeltaPp <= 0) continue;
    const applied = candidates[i].rawDeltaPp * w;
    totalDeltaPp += applied;
    stack.push({ ...candidates[i], weight: w, appliedDeltaPp: applied });
  }

  let workingPp = initialPp - totalDeltaPp;

  // ── Elite gate (POST-stack) ──────────────────────────────────────────────
  // Any value still above 76 after the dampened stack must EARN its
  // conviction. If the play is not elite-eligible, force the 74 cap. This
  // closes the prior bypass where a 90% non-elite play would reach the
  // hard 82 ceiling without consulting the gate.
  let eliteGateApplied = false;
  let eliteGateFailureReason: string | null = null;
  if (workingPp > ELITE_GATE_FLOOR_PP) {
    const failure = eliteFailureReason(ctx);
    if (failure !== null) {
      eliteGateApplied = true;
      eliteGateFailureReason = failure;
      const eliteDeltaPp = workingPp - ELITE_FAIL_CAP_PP;
      workingPp = ELITE_FAIL_CAP_PP;
      stack.push({
        name: `elite_gate_cap_74:${failure}`,
        rawDeltaPp: eliteDeltaPp,
        weight: 1.0,
        appliedDeltaPp: eliteDeltaPp,
      });
    }
  }

  // ── Hard absolute caps (post-stack, never bypassable by dampening) ───────
  // Cap composition: take the minimum of every applicable cap so the
  // strictest rule always wins. Dampened stacking only adjusts soft
  // deltas; the absolute floor below is what actually enforces the
  // contract that a volatile combo can never exceed 72, a bench combo
  // can never exceed 70, etc.
  const comboCap = isCombo && !_comboCapExempt ? COMBO_CAP_PP : null;
  const lowVolCap = LOW_VOLUME_MARKETS.has(ctx.market.toLowerCase()) ? LOW_VOLUME_CAP_PP : null;
  // High-fragility hard cap — soft fragility subtraction can be dampened
  // to <50% of its raw delta when stacked behind another modifier, so we
  // also enforce an absolute 72 cap whenever fragility crosses the
  // 0.40 threshold.
  const fragilityHardCap = ctx.fragilityScore >= 0.40 ? 72 : null;
  // Unknown / non-fresh odds: never elite. The post-stack elite gate
  // already pushes >76 to 74, but we additionally enforce a hard 76
  // cap here to make the rule explicit at the cap-composition layer.
  const oddsCap = ctx.freshOdds === true ? null : 76;
  const applicableCaps = [archetypeCap, comboCap, lowVolCap, fragilityHardCap, oddsCap].filter(
    (v): v is number => typeof v === "number",
  );
  if (applicableCaps.length > 0) {
    const strictest = Math.min(...applicableCaps);
    if (workingPp > strictest) {
      workingPp = strictest;
    }
  }

  let highBucketCapped = false;
  if (workingPp > HARD_CEILING_PP) {
    workingPp = HARD_CEILING_PP;
    highBucketCapped = true;
  }
  let conflictSuppressionApplied = false;
  if (ctx.conflictingSideSuppressed && workingPp > CONFLICT_SURVIVOR_CAP_PP) {
    workingPp = CONFLICT_SURVIVOR_CAP_PP;
    conflictSuppressionApplied = true;
  }

  const finalPp = Math.max(2, Math.min(98, workingPp));

  // capReason picks the strongest *named* reason in priority order so admin
  // diagnostics surface a single deterministic string per play.
  let capReason: string | null = null;
  if (conflictSuppressionApplied) capReason = "conflict_survivor_cap_68";
  else if (eliteGateApplied) capReason = `elite_gate_cap_74:${eliteGateFailureReason ?? "unknown"}`;
  else if (highBucketCapped) capReason = "hard_ceiling_82";
  else if (stack.length > 0) capReason = stack[0].name;

  return {
    pSideFinal: finalPp / 100,
    finalProbabilityPct: finalPp,
    initialProbabilityPct: initialPp,
    capApplied: capReason !== null,
    capReason,
    marketRiskTier: tier,
    modifierStack: stack,
    fragilityDeltaPp,
    highBucketCapped,
    conflictSuppressionApplied,
    eliteGateApplied,
    calibrationVersion: NBA_CALIBRATION_VERSION,
  };
}
