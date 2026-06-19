import type { MLBPropInput } from "./types";
import { computeBatSpeedEngine } from "./featureEngineering";
import { isBarrel as isCanonicalBarrel } from "./statcastXBA";

export type HRIntensity = "weak" | "watch" | "strong" | "imminent";

export type HRContactClass =
  | "noiseContact"
  | "deadPopup"
  | "airBallWarning"
  | "batSpeedWarning"
  | "powerContact"
  | "solidContact"
  | "hrShapedContact"
  | "missedHrContact"
  | "eliteHrContact";

export interface ClassifiedContact {
  contactClass: HRContactClass;
  exitVelocity: number;
  launchAngle: number;
  distance: number;
  outcome: string;
  isBarrel: boolean;
}

export interface HitterPowerProfile {
  score: number; // 0-1
  flags: string[];
}

export interface HRBuildResult {
  score: number;
  intensity: HRIntensity;
  boost: number;
  preHrDangerScore: number;
  dangerFlags: string[];
  factors: {
    avgEV: number | null;
    maxEV: number | null;
    avgLA: number | null;
    barrels: number;
    hardHits: number;
    deepFlyouts: number;
    // ── EV-only "minimum threshold" bucket per user spec (2026-04-30):
    // Any BIP with EV ≥ 95 that didn't qualify for a higher damage class
    // (eliteHr / missedHr / hrShaped). Surfaced so the alert evaluator
    // can recognize a scorched ball that missed the LA/distance gate.
    solidContactCount: number;
    batSpeedScore: number;
    pitcherFatigueBoost: number;
    parkWindBoost: number;
    platoonBoost: number;
    hrShapedCount: number;
    missedHrCount: number;
    eliteHrCount: number;
    qualifiedEVMean: number | null;
    maxDistance: number | null;
    contactClasses: ClassifiedContact[];
    // ── Pre-HR diagnostics ──
    batSpeedPowerScore: number;
    batSpeedZ: number;
    airDangerScore: number;
    hitterPowerProfileScore: number;
    hitterPowerProfileFlags: string[];
    warningContactCount: number;
    deadPopupCount: number;
    airBallWarningCount: number;
    batSpeedWarningCount: number;
    // ── In-game xBA exposure (per-AB Statcast xBA aggregates) ──
    // Surfaced so the alert evaluator can fast-promote on barrel + xBA
    // evidence per the user spec ("xBA in the .400 or so +").
    maxXBA: number | null;
    avgXBA: number | null;
    // ── Real bat-speed mph (not just z-score) ──
    // Surfaced so the alert evaluator can recognize the user-spec floor
    // ("bat speed anything over 70 is good") even when the z-score
    // (vs league avg 72) lands negative.
    batSpeedMph: number | null;
  };
}

const EV_HARD_HIT_THRESHOLD = 95;
const LA_SWEET_SPOT_LOW = 18;
const LA_SWEET_SPOT_HIGH = 38;
const DEEP_FLY_DISTANCE = 330;

// ── Hitter power profile ─────────────────────────────────────────────────────
// Combines seasonal damage traits + measured/derived bat-speed truth into a
// single 0..1 score with explanatory flags. Used as a synergy signal: strong
// power profiles need less perfect live EV to surface as pre-HR danger.
export function computeHitterPowerProfile(input: MLBPropInput): HitterPowerProfile {
  const flags: string[] = [];
  const xSLG = (input.contactQuality as any).xSLG as number | null | undefined;
  const hhr = input.contactQuality.hardHitRateSeason ?? null;
  const barrel = input.contactQuality.barrelRateProxySeason ?? null;
  const bs = computeBatSpeedEngine(input);

  let score = 0;
  let weight = 0;

  if (xSLG != null && Number.isFinite(xSLG)) {
    if (xSLG >= 0.560) { score += 1.0; flags.push("Elite xSLG"); }
    else if (xSLG >= 0.480) { score += 0.75; flags.push("High xSLG"); }
    else if (xSLG >= 0.420) { score += 0.45; }
    weight += 1;
  }
  if (hhr != null && Number.isFinite(hhr)) {
    if (hhr >= 0.48) { score += 1.0; flags.push("Elite Hard-Hit%"); }
    else if (hhr >= 0.42) { score += 0.75; flags.push("High Hard-Hit%"); }
    else if (hhr >= 0.36) { score += 0.45; }
    weight += 1;
  }
  if (barrel != null && Number.isFinite(barrel)) {
    if (barrel >= 0.14) { score += 1.0; flags.push("Elite Barrel%"); }
    else if (barrel >= 0.10) { score += 0.75; flags.push("High Barrel%"); }
    else if (barrel >= 0.075) { score += 0.45; }
    weight += 1;
  }
  // Bat-speed arm of the profile
  if (bs.batSpeedZ >= 1.88) { score += 1.0; flags.push("Elite Bat Speed"); }
  else if (bs.batSpeedZ >= 1.28) { score += 0.75; flags.push("High Bat Speed"); }
  else if (bs.batSpeedZ >= 0.7) { score += 0.45; }
  weight += 1;

  const normalized = weight > 0 ? score / weight : 0;
  if (normalized >= 0.65) flags.push("Power Hitter Profile");
  return { score: Math.max(0, Math.min(1, normalized)), flags };
}

// ── Air-ball intent score for a single contact ───────────────────────────────
// Rewards lifted contacts in the HR-viable LA range when EV is "almost there".
// Penalizes dead popups (high LA + low EV + low distance + no power profile).
function scoreAirBallIntent(
  c: { exitVelocity: number; launchAngle: number; distance: number },
  hitterProfileScore: number,
): number {
  const ev = c.exitVelocity;
  const la = c.launchAngle;
  const dist = c.distance;
  if (la < 18 || la > 50) return 0;

  // Dead popup signature
  if (la >= 45 && ev < 90 && (dist === 0 || dist < 280)) return 0;

  // Useful air-ball warning band
  let s = 0;
  if (la >= 20 && la <= 40) s += 0.4;
  else if (la >= 18 && la <= 45) s += 0.25;

  if (ev >= 84 && ev < 92) s += 0.25;
  else if (ev >= 92 && ev < 96) s += 0.45;

  if (dist >= 320 && dist < 360) s += 0.25;
  else if (dist >= 360) s += 0.4;

  // Profile synergy: power hitters get more credit for the same air-ball
  s += hitterProfileScore * 0.25;

  return Math.max(0, Math.min(1, s));
}

export function classifyContactEvent(
  ab: {
    exitVelocity: number | null;
    launchAngle: number | null;
    distance: number | null;
    outcome: string;
  },
  context?: { batSpeedZ?: number; hitterPowerProfileScore?: number },
): ClassifiedContact {
  const ev = ab.exitVelocity ?? 0;
  const la = ab.launchAngle ?? 0;
  const dist = ab.distance ?? 0;
  // Canonical EV-scaled Statcast barrel — single source of truth shared with
  // the display BRL tag, so engine barrel counts and the UI never disagree.
  const isBarrel = isCanonicalBarrel(ev, la);

  let contactClass: HRContactClass = "noiseContact";

  // Strong-damage classes — further relaxed per user spec (2026-04-30):
  // "anything over 95 EV is good", "what forms a good HR attempt = our
  // minimum thresholds". Brady House (106/25°/385ft), Spencer Horwitz
  // (100.9/36°/397ft), and Juan Soto (100.4/28°/332ft + 101.1/33°/375ft)
  // all had clearly elite contact yet went unsignaled. Loosened distance
  // floors on missedHrContact (340→320) and powerContact entry (92→90)
  // so borderline-distance elite EV still classifies as HR-shaped damage.
  if (ev >= 98 && la >= 22 && la <= 36 && dist >= 360) {
    contactClass = "eliteHrContact";
  } else if (ev >= 95 && la >= 20 && la <= 38 && dist >= 320) {
    contactClass = "missedHrContact";
  } else if (ev >= 93 && la >= 16 && la <= 42 && dist >= 300) {
    contactClass = "hrShapedContact";
  } else if (ev >= 95) {
    // ── EV-only "minimum threshold" bucket per user spec (2026-04-30):
    // a 95+ mph ball that missed barrel by launch angle alone (e.g. a
    // 96 mph line drive at 12°, or a 100 mph air ball at 42°) is still
    // a meaningful pre-HR signal even without barrel-class LA/distance.
    contactClass = "solidContact";
  } else if (ev >= 90) {
    contactClass = "powerContact";
  } else {
    // ── New sub-95 EV pre-HR classes ──
    const bsZ = context?.batSpeedZ ?? 0;
    const profile = context?.hitterPowerProfileScore ?? 0;

    // Dead popup: high LA, low EV, no distance, no power profile
    const isDeadPopup =
      la >= 45 && ev < 90 && (dist === 0 || dist < 250) && profile < 0.4;

    if (isDeadPopup) {
      contactClass = "deadPopup";
    } else if (bsZ >= 1.28 && la >= 12 && la <= 45 && ev >= 80) {
      // Bat-speed warning: elite swing speed + lifted-or-near-lifted contact
      // even if EV not yet hard-hit. Caminero precursor.
      contactClass = "batSpeedWarning";
    } else if (la >= 18 && la <= 45 && ev >= 84 && (profile >= 0.45 || dist >= 320)) {
      // Air-ball warning: useful loft + modest EV when supported by profile/distance
      contactClass = "airBallWarning";
    }
  }

  return {
    contactClass,
    exitVelocity: ev,
    launchAngle: la,
    distance: dist,
    outcome: ab.outcome ?? "out",
    isBarrel,
  };
}

function classifyIntensity(score: number): HRIntensity {
  if (score >= 7.5) return "imminent";
  if (score >= 5.0) return "strong";
  if (score >= 2.5) return "watch";
  return "weak";
}

function computeEdgeBoost(score: number): number {
  if (score >= 7.5) return 4.0;
  if (score >= 5.0) return 2.5;
  if (score >= 2.5) return 1.0;
  return 0;
}

export function buildHRSignal(input: MLBPropInput): HRBuildResult {
  let score = 0;
  const priorABs = input.contactQuality.priorABResults ?? [];

  // ── Real bat-speed engine + hitter profile (replaces fake batSpeed proxy) ──
  const batSpeedData = computeBatSpeedEngine(input);
  const hitterProfile = computeHitterPowerProfile(input);

  const classified = priorABs.map(ab =>
    classifyContactEvent(ab, {
      batSpeedZ: batSpeedData.batSpeedZ,
      hitterPowerProfileScore: hitterProfile.score,
    }),
  );

  const hrShapedEvents = classified.filter(c =>
    c.contactClass === "hrShapedContact" ||
    c.contactClass === "missedHrContact" ||
    c.contactClass === "eliteHrContact"
  );
  const missedHrEvents = classified.filter(c => c.contactClass === "missedHrContact");
  const eliteHrEvents = classified.filter(c => c.contactClass === "eliteHrContact");
  const powerEvents = classified.filter(c => c.contactClass === "powerContact");

  // ── New pre-HR contact buckets ──
  const airBallWarningEvents = classified.filter(c => c.contactClass === "airBallWarning");
  const batSpeedWarningEvents = classified.filter(c => c.contactClass === "batSpeedWarning");
  const deadPopupEvents = classified.filter(c => c.contactClass === "deadPopup");
  const solidContactEvents = classified.filter(c => c.contactClass === "solidContact");
  const solidContactCount = solidContactEvents.length;

  const hrShapedCount = hrShapedEvents.length;
  const missedHrCount = missedHrEvents.length;
  const eliteHrCount = eliteHrEvents.length;
  const airBallWarningCount = airBallWarningEvents.length;
  const batSpeedWarningCount = batSpeedWarningEvents.length;
  const deadPopupCount = deadPopupEvents.length;
  const warningContactCount = airBallWarningCount + batSpeedWarningCount;

  const evValues = classified
    .filter(c => c.exitVelocity > 0)
    .map(c => c.exitVelocity);
  const laValues = classified
    .filter(c => c.launchAngle !== 0 || c.exitVelocity > 0)
    .map(c => c.launchAngle);

  const avgEV = evValues.length > 0 ? evValues.reduce((s, v) => s + v, 0) / evValues.length : null;
  const maxEV = evValues.length > 0 ? Math.max(...evValues) : null;
  const avgLA = laValues.length > 0 ? laValues.reduce((s, v) => s + v, 0) / laValues.length : null;

  const qualifiedEVs = hrShapedEvents.map(e => e.exitVelocity);
  const qualifiedEVMean = qualifiedEVs.length > 0
    ? qualifiedEVs.reduce((s, v) => s + v, 0) / qualifiedEVs.length
    : null;

  const allDistances = classified.filter(c => c.distance > 0).map(c => c.distance);
  const maxDistance = allDistances.length > 0 ? Math.max(...allDistances) : null;

  const barrels = classified.filter(c => c.isBarrel).length;
  const hardHits = classified.filter(c => c.exitVelocity >= EV_HARD_HIT_THRESHOLD).length;

  const deepFlyouts = classified.filter(c =>
    (c.outcome === "out" || c.outcome === "other") &&
    ((c.distance >= DEEP_FLY_DISTANCE && c.launchAngle >= 20) ||
     (c.distance === 0 && c.launchAngle >= 20 && c.exitVelocity >= 95))
  ).length;

  // ── Existing damage-shape scoring (unchanged) ──
  score += eliteHrCount * 3.0;
  score += missedHrCount * 2.5;
  score += (hrShapedCount - missedHrCount - eliteHrCount) * 1.8;

  score += powerEvents.length * 0.5;
  // ── Solid (95+ EV, off-shape) gets its own weight per user spec ──
  // 95 EV is the user's stated minimum threshold for "good HR attempt",
  // so a 95+ ball that missed barrel by LA alone deserves slightly more
  // credit than a 90-94 powerContact event but less than a hr-shaped event.
  score += solidContactCount * 0.6;

  const perABxBAs = priorABs
    .map((ab: any) => ab.perABxBA as number | null | undefined)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  let maxXBA: number | null = null;
  let avgXBA: number | null = null;
  if (perABxBAs.length > 0) {
    maxXBA = Math.max(...perABxBAs);
    avgXBA = perABxBAs.reduce((a, b) => a + b, 0) / perABxBAs.length;
    // Per user spec (2026-04-30): xBA in the .400+ range qualifies as a
    // "good HR attempt". Lower-tier scoring + new factor exposure so the
    // alert evaluator can fast-promote on barrel + meaningful xBA.
    // ── xBA scoring ladder (2026-04-30) ──
    // User spec: "xBA in the .400 or so +" is good. Treat .400 as the
    // upper-mid threshold and add a low-tier .300 bump so above-average
    // contact quality registers even before the .400 line. Drop the
    // avgXBA floor to .200 so a player with consistently solid contact
    // quality across PAs still scores some credit.
    if (maxXBA >= 0.800) score += 1.5;
    else if (maxXBA >= 0.600) score += 0.8;
    else if (maxXBA >= 0.400) score += 0.5;
    else if (maxXBA >= 0.300) score += 0.3;
    if (avgXBA >= 0.500) score += 1.0;
    else if (avgXBA >= 0.350) score += 0.4;
    else if (avgXBA >= 0.250) score += 0.2;
    else if (avgXBA >= 0.200) score += 0.1;
  }

  if (qualifiedEVMean !== null && qualifiedEVMean >= 99) {
    score += 1.0;
  } else if (avgEV !== null && avgEV >= 100) {
    score += 0.8;
  } else if (avgEV !== null && avgEV >= 95) {
    score += 0.3;
  }

  if (maxEV !== null) {
    if (maxEV >= 110) score += 1.0;
    else if (maxEV >= 105) score += 0.5;
  }

  if (maxDistance !== null) {
    if (maxDistance >= 400) score += 1.0;
    else if (maxDistance >= 380) score += 0.5;
    else if (maxDistance >= 360) score += 0.2;
  }

  if (avgLA !== null && avgLA >= LA_SWEET_SPOT_LOW && avgLA <= LA_SWEET_SPOT_HIGH) {
    score += 0.5;
  }

  // ── Bat-speed score: REAL engine instead of fake season-barrel proxy ──
  // Maps batSpeedPowerScore (0..1) into the existing 0..~1.0 score slot.
  const batSpeedScore = Math.max(0, batSpeedData.batSpeedPowerScore - 0.45) * (1 / 0.55);
  if (batSpeedScore > 0) score += batSpeedScore;

  let pitcherFatigueBoost = 0;
  if (input.pitcher.pitchCount >= 90) {
    pitcherFatigueBoost = 0.8;
  } else if (input.pitcher.pitchCount >= 75) {
    pitcherFatigueBoost = 0.4;
  }
  if (input.pitcher.timesThrough >= 3) {
    pitcherFatigueBoost += 0.4;
  }
  if (input.pitcher.isPitcherCollapsing) {
    pitcherFatigueBoost += 0.6;
  }
  score += pitcherFatigueBoost;

  let parkWindBoost = 0;
  if (input.weatherPark.parkFactor >= 1.10) {
    parkWindBoost += 0.4;
  }
  if (!input.weatherPark.isIndoors &&
      input.weatherPark.windDirection === "out" &&
      (input.weatherPark.windSpeed ?? 0) >= 8) {
    parkWindBoost += 0.4;
  }
  const temp = input.weatherPark.temperature ?? 70;
  if (temp >= 85) parkWindBoost += 0.2;

  if (!input.weatherPark.isIndoors &&
      input.weatherPark.windDirection === "in" &&
      (input.weatherPark.windSpeed ?? 0) >= 10) {
    parkWindBoost -= 0.3;
  }
  if (temp <= 45) parkWindBoost -= 0.2;
  score += parkWindBoost;

  let platoonBoost = 0;
  if (input.batterHand && input.pitcher.throws && input.batterHand !== input.pitcher.throws) {
    platoonBoost = 0.25;
    score += platoonBoost;
  }

  const era = input.pitcher.era;
  if (era !== null && era >= 5.0) {
    score += 0.4;
  }

  const lei = input.liveInterpretation;
  if (lei) {
    if (lei.nearHrScore > 0.04) score += lei.nearHrScore * 8;
    if (lei.momentumScore > 0.03) score += lei.momentumScore * 4;
    if (lei.veloDropScore > 0.03) score += lei.veloDropScore * 3;
  }

  const hotHitterBoost = input.hotHitterBoost ?? 0;
  score += hotHitterBoost;

  const bvpHrBoost = input.bvpHrBoost ?? 0;
  score += bvpHrBoost;

  const hrTrend = input.hrTrend;
  if (hrTrend) {
    const abSince = hrTrend.abSinceLastHR;
    const seasonRate = hrTrend.seasonTotalAB > 0 ? hrTrend.seasonTotalHR / hrTrend.seasonTotalAB : 0;
    if (abSince != null && seasonRate > 0) {
      const expectedABperHR = 1 / seasonRate;
      if (abSince >= expectedABperHR * 2.0) {
        score += 0.6;
      } else if (abSince >= expectedABperHR * 1.5) {
        score += 0.3;
      }
    }
    const hrL7 = hrTrend.hrRateLast7;
    const hrL30 = hrTrend.hrRateLast30;
    if (hrL7 != null && hrL30 != null && hrL30 > 0 && hrL7 > hrL30 * 1.5) {
      score += 0.3;
    }
  }

  // ── Pre-HR danger layer (NEW, additive) ─────────────────────────────────────
  // This is the missing bridge for "high bat speed + lifted contact + strong
  // power profile" patterns that precede a HR before classic damage shape lands.
  const dangerFlags: string[] = [...hitterProfile.flags];

  // Air-ball danger: average air-ball intent over warning + power air contacts
  const airIntentSamples = classified
    .filter(c => c.launchAngle >= 18 && c.launchAngle <= 50 && c.exitVelocity >= 80)
    .map(c => scoreAirBallIntent(c, hitterProfile.score));
  const airDangerScore = airIntentSamples.length > 0
    ? airIntentSamples.reduce((s, v) => s + v, 0) / airIntentSamples.length
    : 0;

  // Repeat warning pattern: 2+ warnings, or 1 warning + 1 power contact
  const repeatWarningBoost =
    (warningContactCount >= 2 ? 0.6 : 0) +
    (warningContactCount >= 1 && powerEvents.length >= 1 ? 0.4 : 0);
  if (warningContactCount >= 2) dangerFlags.push("Repeat Warning Contacts");
  else if (warningContactCount >= 1 && powerEvents.length >= 1) dangerFlags.push("Warning + Power Contact");

  // Bat-speed contributions
  let batSpeedDangerBoost = 0;
  if (batSpeedData.batSpeedZ >= 1.88) batSpeedDangerBoost += 1.0;
  else if (batSpeedData.batSpeedZ >= 1.28) batSpeedDangerBoost += 0.6;
  else if (batSpeedData.batSpeedPowerScore >= 0.76) batSpeedDangerBoost += 0.4;
  if (batSpeedDangerBoost > 0) dangerFlags.push("Bat-Speed Danger");

  // Air + bat-speed synergy: dangerous swing AND lifted contact even if EV soft
  const hasAirBallNow = airBallWarningCount > 0 || batSpeedWarningCount > 0;
  const synergyBoost = hasAirBallNow && batSpeedData.batSpeedZ >= 1.0 ? 0.6 : 0;
  if (synergyBoost > 0) dangerFlags.push("Air-Ball × Bat-Speed Synergy");

  // Hitter power profile synergy
  const profileBoost = hitterProfile.score * 1.2;

  // Context (gentler than damage scoring — pre-HR signal only)
  const contextBoost =
    (pitcherFatigueBoost > 0 ? Math.min(0.6, pitcherFatigueBoost * 0.5) : 0) +
    (parkWindBoost > 0 ? Math.min(0.4, parkWindBoost * 0.6) : 0);

  // Penalty: dead popups suppress pre-HR danger noise
  const popupPenalty = deadPopupCount * 0.4;

  let preHrDangerScore =
    airDangerScore * 2.5 +
    profileBoost +
    batSpeedDangerBoost +
    synergyBoost +
    repeatWarningBoost +
    contextBoost -
    popupPenalty;
  preHrDangerScore = Math.max(0, Math.min(8, preHrDangerScore));

  // Feed the pre-HR danger into main score modestly so it nudges intensity
  // for power hitters with warnings WITHOUT flooding the radar with noise.
  // Half-weight, capped to avoid over-counting against existing damage paths.
  const preHrFeed = Math.min(1.5, preHrDangerScore * 0.35);
  score += preHrFeed;

  const finalScore = Math.min(10, Math.max(0, score));

  return {
    score: Math.round(finalScore * 100) / 100,
    intensity: classifyIntensity(finalScore),
    boost: computeEdgeBoost(finalScore),
    preHrDangerScore: Math.round(preHrDangerScore * 100) / 100,
    dangerFlags,
    factors: {
      avgEV: avgEV !== null ? Math.round(avgEV * 10) / 10 : null,
      maxEV: maxEV !== null ? Math.round(maxEV * 10) / 10 : null,
      avgLA: avgLA !== null ? Math.round(avgLA * 10) / 10 : null,
      barrels,
      hardHits,
      deepFlyouts,
      solidContactCount,
      batSpeedScore: Math.round(Math.max(0, batSpeedScore) * 100) / 100,
      pitcherFatigueBoost: Math.round(pitcherFatigueBoost * 100) / 100,
      parkWindBoost: Math.round(parkWindBoost * 100) / 100,
      platoonBoost: Math.round(platoonBoost * 100) / 100,
      hrShapedCount,
      missedHrCount,
      eliteHrCount,
      qualifiedEVMean: qualifiedEVMean !== null ? Math.round(qualifiedEVMean * 10) / 10 : null,
      maxDistance: maxDistance !== null ? Math.round(maxDistance) : null,
      contactClasses: classified,
      batSpeedPowerScore: Math.round(batSpeedData.batSpeedPowerScore * 1000) / 1000,
      batSpeedZ: Math.round(batSpeedData.batSpeedZ * 100) / 100,
      airDangerScore: Math.round(airDangerScore * 1000) / 1000,
      hitterPowerProfileScore: Math.round(hitterProfile.score * 1000) / 1000,
      hitterPowerProfileFlags: hitterProfile.flags,
      warningContactCount,
      deadPopupCount,
      airBallWarningCount,
      batSpeedWarningCount,
      maxXBA: maxXBA !== null ? Math.round(maxXBA * 1000) / 1000 : null,
      avgXBA: avgXBA !== null ? Math.round(avgXBA * 1000) / 1000 : null,
      batSpeedMph: Math.round(batSpeedData.batSpeedMph * 10) / 10,
    },
  };
}
