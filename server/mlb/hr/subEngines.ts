// HR overlay sub-engines (Ψ, Γ, Λ, Θ, Δ) and the soft gate (K).
//
// Every sub-engine is a pure function and returns a neutral score of 0 with
// coverage "MISSING" when its inputs are absent — so partial data never
// destabilizes the model and the overlay multiplier degrades gracefully to 1.0.

import { getPitchFamily } from "../pitchTypeNormalizer";
import {
  LEAGUE_BASELINES,
  GATE_THRESHOLDS,
  GATE_DAMPENERS,
  GATE_SOFT_FLOOR,
  ARSENAL_THETA_DAMAGE,
  ARSENAL_THETA_WHIFF,
  ORDER_SPLIT_SHRINKAGE,
  LINEUP_SLOT_BASE_PA,
  BASELINE_PA,
  WINSOR_RATIO_MIN,
  WINSOR_RATIO_MAX,
} from "./hrOverlayConstants";
import { clamp, isPresent, ratioVsBaseline, ratioToScore } from "./normalization";
import { applySeasonTriadWeighting } from "./temporalFilter";
import type {
  HROverlayInput,
  SubEngineResult,
  Coverage,
  PitchFamilyKey,
} from "./hrOverlayTypes";

interface WeightedRatio {
  ratio: number | null;
  weight: number;
}

/**
 * Combine weighted ratio parts into a signed score. Coverage reflects how much
 * of the intended weight was backed by real data.
 *
 * normalizeBy "present" (default): renormalize over the parts actually present
 * so a dominant-but-lone signal (e.g. Barrel/PA in Ψ) still counts at full
 * strength. normalizeBy "total": divide by the full intended weight so missing
 * sub-parts dampen the result — used for the recency confirmation layer so a
 * single low-priority signal (e.g. OPS) cannot originate a strong push.
 */
function aggregate(
  parts: WeightedRatio[],
  opts: { normalizeBy?: "present" | "total" } = {},
): SubEngineResult {
  const normalizeBy = opts.normalizeBy ?? "present";
  let acc = 0;
  let presentWeight = 0;
  let totalWeight = 0;
  for (const p of parts) {
    totalWeight += p.weight;
    if (p.ratio != null) {
      acc += p.weight * ratioToScore(p.ratio);
      presentWeight += p.weight;
    }
  }
  const denom = normalizeBy === "total" ? totalWeight : presentWeight;
  const score = denom > 0 ? clamp(acc / denom, -1, 1) : 0;
  return { score, coverage: coverageOf(presentWeight, totalWeight) };
}

function coverageOf(presentWeight: number, totalWeight: number): Coverage {
  if (presentWeight <= 0) return "MISSING";
  if (presentWeight >= totalWeight - 1e-9) return "FULL";
  return "PARTIAL";
}

// ── Ψ power: pure raw-power profile ─────────────────────────────────────────
export function computePowerProfile(input: HROverlayInput): SubEngineResult {
  // Prefer triad-blended Barrel/PA; fall back to single-season Barrel/PA, then
  // to Barrel% of BBE (its own baseline) so today's data still scores.
  const triadBarrel = input.barrelPerPABySeason
    ? applySeasonTriadWeighting(input.barrelPerPABySeason).value
    : null;
  const barrelPA = triadBarrel ?? input.barrelPerPA;
  let barrelRatio: number | null = null;
  if (isPresent(barrelPA)) {
    barrelRatio = ratioVsBaseline(barrelPA, LEAGUE_BASELINES.barrelPerPA);
  } else if (isPresent(input.barrelRate)) {
    barrelRatio = ratioVsBaseline(input.barrelRate, LEAGUE_BASELINES.barrelRateBBE);
  }

  // xwOBAcon preferred; fall back to overall xwOBA with its own anchor.
  let xwobaRatio: number | null = null;
  if (isPresent(input.xwOBAcon)) {
    xwobaRatio = ratioVsBaseline(input.xwOBAcon, LEAGUE_BASELINES.xwOBAcon);
  } else if (isPresent(input.xwOBA)) {
    xwobaRatio = ratioVsBaseline(input.xwOBA, LEAGUE_BASELINES.xwOBA);
  }

  return aggregate([
    { ratio: barrelRatio, weight: 0.40 },
    { ratio: ratioVsBaseline(input.exitVelocity, LEAGUE_BASELINES.exitVelocity), weight: 0.20 },
    { ratio: ratioVsBaseline(input.sweetSpotPct, LEAGUE_BASELINES.sweetSpotPct), weight: 0.15 },
    { ratio: xwobaRatio, weight: 0.25 },
  ]);
}

// ── Λ launch: air × pull topology ───────────────────────────────────────────
// ln((FB%·PullAIR%)/(μFB·μPull)) expressed via the shared log-symmetric score.
export function computeLaunchTopology(input: HROverlayInput): SubEngineResult {
  const fbRatio = ratioVsBaseline(input.flyBallPct, LEAGUE_BASELINES.flyBallPct);
  const pullRatio = ratioVsBaseline(input.pullAirPct, LEAGUE_BASELINES.pullAirPct);

  if (fbRatio == null && pullRatio == null) {
    return { score: 0, coverage: "MISSING" };
  }
  // Product of available ratios (winsorized) → log-symmetric score.
  const product = (fbRatio ?? 1) * (pullRatio ?? 1);
  const boundedProduct = clamp(product, WINSOR_RATIO_MIN, WINSOR_RATIO_MAX);
  const coverage: Coverage = fbRatio != null && pullRatio != null ? "FULL" : "PARTIAL";
  return { score: ratioToScore(boundedProduct), coverage };
}

// ── Θ lineup: expected-PA volume × shrunk power-by-slot split ────────────────
export function computeLineupVolume(input: HROverlayInput): SubEngineResult {
  const slot = input.battingOrderSlot;
  let volumeRatio: number | null = null;
  if (isPresent(slot) && LINEUP_SLOT_BASE_PA[slot] != null) {
    volumeRatio = ratioVsBaseline(LINEUP_SLOT_BASE_PA[slot], BASELINE_PA);
  }

  // Power-by-slot split (NEW DATA). Shrink hard toward the overall line; no-op
  // when the split is absent — coverage then degrades to PARTIAL.
  let powerRatio: number | null = null;
  const split = isPresent(slot)
    ? input.orderSplits?.find((s) => s.slot === slot)
    : undefined;
  if (split && isPresent(split.slg) && isPresent(input.overallSlg) && input.overallSlg > 0) {
    const pa = split.pa ?? 0;
    const shrunk =
      (pa / (pa + ORDER_SPLIT_SHRINKAGE)) * split.slg +
      (ORDER_SPLIT_SHRINKAGE / (pa + ORDER_SPLIT_SHRINKAGE)) * input.overallSlg;
    powerRatio = ratioVsBaseline(shrunk, input.overallSlg);
  }

  return aggregate([
    { ratio: volumeRatio, weight: 0.60 },
    { ratio: powerRatio, weight: 0.40 },
  ]);
}

// ── Δ recency: short-term power/HR momentum vs the triad average ─────────────
// SLG highest priority, recent HR-rate streak next, OPS lowest (a confirmation
// signal — never an originator).
export function computeRecencyDelta(input: HROverlayInput): SubEngineResult {
  let slgRatio: number | null = null;
  if (isPresent(input.recentSlg) && isPresent(input.seasonSlg) && input.seasonSlg > 0) {
    slgRatio = clamp(input.recentSlg / input.seasonSlg, WINSOR_RATIO_MIN, WINSOR_RATIO_MAX);
  }

  let streakRatio: number | null = null;
  const season = input.seasonHRRate;
  if (isPresent(season) && season > 0) {
    const l7 = input.hrRateLast7;
    const l15 = input.hrRateLast15;
    let recent: number | null = null;
    if (isPresent(l7) && isPresent(l15)) recent = 0.4 * l7 + 0.6 * l15;
    else if (isPresent(l15)) recent = l15;
    else if (isPresent(l7)) recent = l7;
    if (recent != null) {
      streakRatio = clamp(recent / season, WINSOR_RATIO_MIN, WINSOR_RATIO_MAX);
    }
  }

  let opsRatio: number | null = null;
  if (isPresent(input.recentOps) && isPresent(input.seasonOps) && input.seasonOps > 0) {
    opsRatio = clamp(input.recentOps / input.seasonOps, WINSOR_RATIO_MIN, WINSOR_RATIO_MAX);
  }

  if (slgRatio == null && streakRatio == null && opsRatio == null) {
    return { score: 0, coverage: "MISSING" };
  }

  // Normalize over the full intended weight so a lone low-priority signal
  // (OPS) cannot originate a strong push — recency only confirms.
  return aggregate(
    [
      { ratio: slgRatio, weight: 0.50 },   // SLG highest priority
      { ratio: streakRatio, weight: 0.30 }, // recent HR-rate streak
      { ratio: opsRatio, weight: 0.20 },   // OPS lowest priority
    ],
    { normalizeBy: "total" },
  );
}

// ── Γ arsenal matchup: pitcher usage · batter pitch-family damage ────────────
export function computeArsenalMatchupFit(input: HROverlayInput): SubEngineResult {
  const splits = input.batterPitchSplits;
  const mix = input.pitchMix;
  if (!splits || splits.length === 0 || !mix || mix.length === 0) {
    return { score: 0, coverage: "MISSING" };
  }

  const usageByFamily: Record<PitchFamilyKey, number> = {
    fastball: 0,
    breaking: 0,
    offspeed: 0,
  };
  let totalUsage = 0;
  for (const p of mix) {
    const fam = getPitchFamily(p.pitchType);
    if (fam === "other") continue;
    const pct = isPresent(p.percentage) ? p.percentage : 0;
    usageByFamily[fam] += pct;
    totalUsage += pct;
  }
  if (totalUsage <= 0) return { score: 0, coverage: "MISSING" };

  let acc = 0;
  let coveredUsage = 0;
  for (const s of splits) {
    const usage = (usageByFamily[s.family] ?? 0) / totalUsage;
    if (usage <= 0) continue;
    const xslgRatio = ratioVsBaseline(s.xSlg, LEAGUE_BASELINES.xSlgByFamily[s.family]);
    const whiffRatio = ratioVsBaseline(s.whiffPct, LEAGUE_BASELINES.whiffPctByFamily[s.family]);
    if (xslgRatio == null && whiffRatio == null) continue;
    const damage = ratioToScore(xslgRatio);
    const whiffPenalty = ratioToScore(whiffRatio);
    acc += usage * (ARSENAL_THETA_DAMAGE * damage - ARSENAL_THETA_WHIFF * whiffPenalty);
    coveredUsage += usage;
  }

  if (coveredUsage <= 0) return { score: 0, coverage: "MISSING" };
  return {
    score: clamp(acc, -1, 1),
    coverage: coveredUsage >= 0.75 ? "FULL" : "PARTIAL",
  };
}

// ── K soft gate: contact-floor suppression (dampens, never zeroes) ───────────
export interface SoftGateResult {
  factor: number;
  confidencePenalty: boolean;
  risks: string[];
}

export function computeSoftGate(input: HROverlayInput): SoftGateResult {
  let factor = 1.0;
  let penalty = false;
  const risks: string[] = [];

  // Barrel floor — prefer Barrel/PA, fall back to Barrel% of BBE.
  if (isPresent(input.barrelPerPA)) {
    if (input.barrelPerPA < GATE_THRESHOLDS.barrelPerPAFloor) {
      factor *= GATE_DAMPENERS.lowBarrel;
      penalty = true;
      risks.push("LOW_BARREL_FLOOR");
    }
  } else if (isPresent(input.barrelRate)) {
    if (input.barrelRate < GATE_THRESHOLDS.barrelRateBBEFloor) {
      factor *= GATE_DAMPENERS.lowBarrel;
      penalty = true;
      risks.push("LOW_BARREL_FLOOR");
    }
  }

  if (isPresent(input.maxEV) && input.maxEV < GATE_THRESHOLDS.maxEvFloor) {
    factor *= GATE_DAMPENERS.lowMaxEv;
    penalty = true;
    risks.push("LOW_MAX_EV");
  }

  // Topped% ceiling — skipped entirely when absent (Phase 2 data).
  if (isPresent(input.toppedPct) && input.toppedPct > GATE_THRESHOLDS.toppedPctCeiling) {
    factor *= GATE_DAMPENERS.highTopped;
    penalty = true;
    risks.push("GROUND_BALL_SUPPRESSION");
  }

  return {
    factor: Math.max(GATE_SOFT_FLOOR, factor),
    confidencePenalty: penalty,
    risks,
  };
}
