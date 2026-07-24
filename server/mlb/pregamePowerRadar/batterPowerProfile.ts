// Component 1 — Batter Power Profile (weight 0.28).
//
// Pure scorer over season Statcast power inputs (2024–2026 only). Returns a
// 0–10 score, positive/negative drivers, and warnings. Neutral + `available:false`
// when no meaningful power data is present (the build layer then suppresses).

import type { ComponentScore, PowerDriver } from "./types";
import { lin, weightedAvg, round1, clamp10 } from "./scoreUtils";

/** Minimal power inputs (mapped from BaseballSavantData by the build layer). */
export interface BatterPowerInputs {
  xISO: number | null; // xSLG − xBA
  xSLG: number | null;
  barrelRatePct: number | null; // barrel% proxy
  hardHitRatePct: number | null;
  exitVelocity: number | null; // avg EV (mph)
  maxEV: number | null;
  flyBallPct: number | null;
  hrFBRatioPct: number | null;
  pullRatePct: number | null;
  sweetSpotPct: number | null;
  xwOBA: number | null;
  // Season batted-ball-event count backing most of the rate fields above.
  // Null when genuinely unknown (e.g. the degraded xBA/xSLG-only fallback,
  // which isn't BIP-rate-based at all) — treated as thin, not full-sample.
  battedBallEvents: number | null;
}

export function computeBatterPowerProfile(inputs: BatterPowerInputs): ComponentScore {
  const drivers: PowerDriver[] = [];
  const warnings: string[] = [];

  const sIso = inputs.xISO != null ? lin(inputs.xISO, 0.09, 0.26) : null;
  const sSlg = inputs.xSLG != null ? lin(inputs.xSLG, 0.34, 0.56) : null;
  const sBarrel = inputs.barrelRatePct != null ? lin(inputs.barrelRatePct, 3, 16) : null;
  const sHard = inputs.hardHitRatePct != null ? lin(inputs.hardHitRatePct, 30, 52) : null;
  const sEv = inputs.exitVelocity != null ? lin(inputs.exitVelocity, 86, 94) : null;
  const sMaxEv = inputs.maxEV != null ? lin(inputs.maxEV, 104, 116) : null;
  const sFb = inputs.flyBallPct != null ? lin(inputs.flyBallPct, 22, 48) : null;
  const sHrFb = inputs.hrFBRatioPct != null ? lin(inputs.hrFBRatioPct, 5, 25) : null;
  const sPull = inputs.pullRatePct != null ? lin(inputs.pullRatePct, 30, 55) : null;
  const sSweet = inputs.sweetSpotPct != null ? lin(inputs.sweetSpotPct, 28, 42) : null;
  const sXwoba = inputs.xwOBA != null ? lin(inputs.xwOBA, 0.3, 0.42) : null;

  const { score: rawScore, coverage } = weightedAvg([
    { value: sIso, weight: 3 },
    { value: sBarrel, weight: 3 },
    { value: sHard, weight: 2 },
    { value: sSlg, weight: 2 },
    { value: sMaxEv, weight: 2 },
    { value: sHrFb, weight: 2 },
    { value: sEv, weight: 1 },
    { value: sFb, weight: 1 },
    { value: sPull, weight: 1 },
    { value: sSweet, weight: 1 },
    { value: sXwoba, weight: 1 },
  ]);

  // Sample-size shrinkage toward neutral (5) — mirrors the discipline already
  // applied in pitcherOrderSplit.ts/batterOrderSplit.ts, previously missing
  // here despite this being the single most heavily-weighted component
  // (0.28): without it, a handful of batted-ball events (a September call-up,
  // a part-time platoon bat) could swing this component to an extreme off
  // noise. Bounds are provisional (BIP-rate stats generally need a larger
  // sample than PA-based rates to stabilize), not a literature-derived
  // stabilization point.
  //
  // Unknown sample size (battedBallEvents null) is a no-op (shrink 1.0), NOT
  // an assume-thin penalty: in practice it only co-occurs with the degraded
  // xBA/xSLG-only Savant fallback, where every barrel/hard-hit/etc. sub-score
  // is already null too — rawScore is already thin from weightedAvg's own
  // coverage math in that case, and separately capped by batterPowerAvailable
  // upstream (see buildPregamePowerRadar.ts). Double-shrinking that scenario
  // here would just re-punish something already handled elsewhere, while
  // wrongly discounting any caller that simply hasn't supplied a count yet.
  const bbe = inputs.battedBallEvents;
  const shrink = bbe == null ? 1.0 : bbe < 15 ? 0.25 : bbe < 35 ? 0.55 : bbe < 70 ? 0.8 : 1.0;
  const score = clamp10(5 + (rawScore - 5) * shrink);

  // Drivers from the strongest present components.
  if (sIso != null && sIso >= 6.5) {
    drivers.push({ key: "power_iso", label: "Elite Isolated Power", direction: "positive", weight: Math.round(sIso * 10), evidence: `xISO ${inputs.xISO?.toFixed(3)}` });
  }
  if (sBarrel != null && sBarrel >= 6.5) {
    drivers.push({ key: "power_barrel", label: "High Barrel Rate", direction: "positive", weight: Math.round(sBarrel * 10), evidence: `barrel% ${round1(inputs.barrelRatePct ?? 0)}` });
  }
  if (sHard != null && sHard >= 6.5) {
    drivers.push({ key: "power_hardhit", label: "Strong Hard-Hit Rate", direction: "positive", weight: Math.round(sHard * 10), evidence: `hard-hit% ${round1(inputs.hardHitRatePct ?? 0)}` });
  }
  if (sMaxEv != null && sMaxEv >= 7) {
    drivers.push({ key: "power_maxev", label: "Top-End Exit Velocity", direction: "positive", weight: Math.round(sMaxEv * 10), evidence: `max EV ${round1(inputs.maxEV ?? 0)} mph` });
  }
  if (sHrFb != null && sHrFb >= 7) {
    drivers.push({ key: "power_hrfb", label: "High HR/FB", direction: "positive", weight: Math.round(sHrFb * 10), evidence: `HR/FB ${round1(inputs.hrFBRatioPct ?? 0)}%` });
  }
  if (sPull != null && sPull >= 7) {
    drivers.push({ key: "power_pullair", label: "Pull-Side Power", direction: "positive", weight: Math.round(sPull * 10), evidence: `pull% ${round1(inputs.pullRatePct ?? 0)}` });
  }
  // A clearly weak power profile is a negative driver.
  if (coverage >= 0.4 && score <= 3) {
    drivers.push({ key: "power_low", label: "Limited Raw Power", direction: "negative", weight: 30 });
  }

  // Critical inputs missing → not available (build layer suppresses).
  const hasCore = inputs.xISO != null || inputs.barrelRatePct != null || inputs.xSLG != null || inputs.exitVelocity != null;
  if (!hasCore) {
    warnings.push("No batter power data (xISO/barrel/xSLG/EV all missing)");
    // Neutral, not the worst-possible score — matches every sibling
    // component's unavailable-data fallback (pitcherVulnerability.ts,
    // matchupFit.ts, parkWeatherScore.ts, lineupOpportunity.ts,
    // batterOrderSplit.ts all return 5, not 0, when unavailable).
    return { score10: 5, available: false, drivers: [], warnings };
  }
  if (coverage < 0.35) {
    warnings.push("Sparse batter power data");
  }

  return { score10: round1(score), available: true, drivers, warnings };
}
