import type { MLBPropInput } from "./types";

export interface LiveEventInterpretation {
  contactScore: number;
  nearHrScore: number;
  momentumScore: number;
  pitcherFatigueScore: number;
  veloDropScore: number;
  confidenceBoost: number;
  tags: string[];
}

const EV_HARD = 95;
const EV_POWER = 98;
const LA_SWEET_LOW = 20;
const LA_SWEET_HIGH = 40;
const NEAR_HR_DIST = 300;

function safeNum(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function computeContactScore(input: MLBPropInput): { score: number; tags: string[] } {
  const abs = input.contactQuality.priorABResults ?? [];
  if (abs.length === 0) return { score: 0, tags: [] };

  const tags: string[] = [];

  const recent = abs.slice(-3);
  const evs = recent.map(ab => safeNum(ab.exitVelocity)).filter(v => v > 0);
  const las = recent.map(ab => safeNum(ab.launchAngle));

  if (evs.length === 0) return { score: 0, tags: [] };

  const avgEV = evs.reduce((s, v) => s + v, 0) / evs.length;
  const hardHits = evs.filter(v => v >= EV_HARD).length;
  const optimalLACount = las.filter(la => la >= LA_SWEET_LOW && la <= LA_SWEET_HIGH).length;

  let score = 0;

  if (avgEV >= 100) score += 0.08;
  else if (avgEV >= 95) score += 0.05;
  else if (avgEV >= 90) score += 0.02;

  const hardHitDensity = hardHits / recent.length;
  score += hardHitDensity * 0.06;

  const optimalLADensity = optimalLACount / recent.length;
  score += optimalLADensity * 0.04;

  const allEvs = abs.map(ab => safeNum(ab.exitVelocity)).filter(v => v > 0);
  if (allEvs.length >= 2) {
    const qualifiedHardHits = allEvs.filter(v => v >= EV_HARD).length;
    const qualifiedDensity = qualifiedHardHits / allEvs.length;
    if (qualifiedDensity >= 0.6) {
      score += 0.04;
      tags.push("Strong Contact Trend");
    } else if (qualifiedDensity >= 0.4) {
      score += 0.02;
    }
  }

  return { score: Math.min(0.20, Math.max(-0.05, score)), tags };
}

function computeNearHrScore(input: MLBPropInput): { score: number; tags: string[] } {
  const abs = input.contactQuality.priorABResults ?? [];
  if (abs.length === 0) return { score: 0, tags: [] };

  const tags: string[] = [];

  let nearHrEvents = 0;
  let hrShapedStreak = 0;
  let maxConsecutiveHrShaped = 0;

  for (const ab of abs) {
    const ev = safeNum(ab.exitVelocity);
    const la = safeNum(ab.launchAngle);
    const dist = safeNum(ab.distance);

    const isNearHr = ev > 92 && la >= LA_SWEET_LOW && la <= LA_SWEET_HIGH && dist > NEAR_HR_DIST;
    if (isNearHr) {
      nearHrEvents++;
      hrShapedStreak++;
      maxConsecutiveHrShaped = Math.max(maxConsecutiveHrShaped, hrShapedStreak);
    } else {
      hrShapedStreak = 0;
    }
  }

  let score = 0;
  if (nearHrEvents >= 3) score = 0.12;
  else if (nearHrEvents >= 2) score = 0.08;
  else if (nearHrEvents >= 1) score = 0.04;

  if (maxConsecutiveHrShaped >= 2) {
    score += 0.04;
  }

  if (nearHrEvents >= 2) {
    tags.push("Near HR Contact Detected");
  }

  return { score: Math.min(0.15, score), tags };
}

function computeMomentumScore(input: MLBPropInput): { score: number; tags: string[] } {
  const abs = input.contactQuality.priorABResults ?? [];
  if (abs.length < 2) return { score: 0, tags: [] };

  const tags: string[] = [];

  const recent = abs.slice(-3);
  const qualities = recent.map(ab => {
    const ev = safeNum(ab.exitVelocity);
    const la = safeNum(ab.launchAngle);
    const dist = safeNum(ab.distance);

    let q = 0;
    if (ev >= EV_POWER) q += 0.4;
    else if (ev >= EV_HARD) q += 0.25;
    else if (ev >= 90) q += 0.1;

    if (la >= LA_SWEET_LOW && la <= LA_SWEET_HIGH) q += 0.2;
    if (dist >= 350) q += 0.2;
    else if (dist >= 300) q += 0.1;

    return q;
  });

  const weights = [0.2, 0.3, 0.5];
  let weightedSum = 0;
  for (let i = 0; i < qualities.length; i++) {
    const w = weights[weights.length - qualities.length + i] ?? 0.33;
    weightedSum += qualities[i] * w;
  }

  const isTrendingUp = qualities.length >= 2 &&
    qualities[qualities.length - 1] > qualities[qualities.length - 2];

  let score = weightedSum * 0.15;

  if (isTrendingUp && weightedSum > 0.3) {
    score += 0.02;
  }

  return { score: Math.min(0.10, Math.max(0, score)), tags };
}

function computePitcherFatigueScore(input: MLBPropInput): { score: number; tags: string[] } {
  const { pitchCount, timesThrough, isPitcherCollapsing, managerLeashShort } = input.pitcher;
  const tags: string[] = [];

  let score = 0;

  if (pitchCount >= 100) score += 0.10;
  else if (pitchCount >= 90) score += 0.07;
  else if (pitchCount >= 80) score += 0.04;
  else if (pitchCount >= 70) score += 0.02;

  if (timesThrough >= 3) score += 0.06;
  else if (timesThrough >= 2) score += 0.03;

  if (isPitcherCollapsing) {
    score += 0.08;
    tags.push("Pitcher Fatigue Rising");
  }

  if (managerLeashShort) {
    score += 0.03;
  }

  if (pitchCount >= 85 && timesThrough >= 3) {
    score += 0.03;
    if (!tags.includes("Pitcher Fatigue Rising")) {
      tags.push("Pitcher Fatigue Rising");
    }
  }

  return { score: Math.min(0.15, score), tags };
}

function computeVeloDropScore(input: MLBPropInput): { score: number; tags: string[] } {
  const tags: string[] = [];
  let score = 0;

  const pitchMix = input.pitcher.pitchMix ?? [];
  if (pitchMix.length === 0) return { score: 0, tags: [] };

  const fastballs = pitchMix.filter(p => {
    const pt = (p.pitchType ?? "").toUpperCase();
    return pt === "FF" || pt === "SI" || pt === "FC" ||
      pt.includes("FASTBALL") || pt.includes("SINKER");
  });

  if (fastballs.length === 0) return { score: 0, tags: [] };

  const currentVelos = fastballs
    .map(p => safeNum(p.avgVelocity))
    .filter(v => v > 0);

  if (currentVelos.length === 0) return { score: 0, tags: [] };

  const currentAvgVelo = currentVelos.reduce((s, v) => s + v, 0) / currentVelos.length;

  const seasonAvgVelo = safeNum(input.pitcher.seasonAvgVelocity);
  if (seasonAvgVelo > 0) {
    const drop = seasonAvgVelo - currentAvgVelo;
    if (drop >= 3.0) {
      score = 0.10;
      tags.push("Velocity Drop Detected");
    } else if (drop >= 2.0) {
      score = 0.06;
      tags.push("Velocity Drop Detected");
    } else if (drop >= 1.0) {
      score = 0.03;
    }
  }

  return { score: Math.min(0.10, score), tags };
}

export function buildLiveEventInterpretation(input: MLBPropInput): LiveEventInterpretation {
  const contact = computeContactScore(input);
  const nearHr = computeNearHrScore(input);
  const momentum = computeMomentumScore(input);
  const fatigue = computePitcherFatigueScore(input);
  const veloDrop = computeVeloDropScore(input);

  const allTags = [
    ...contact.tags,
    ...nearHr.tags,
    ...momentum.tags,
    ...fatigue.tags,
    ...veloDrop.tags,
  ];

  const confidenceBoost =
    (contact.score > 0.05 ? 0.02 : 0) +
    (nearHr.score > 0.04 ? 0.03 : 0) +
    (momentum.score > 0.03 ? 0.01 : 0) +
    (fatigue.score > 0.05 ? 0.02 : 0) +
    (veloDrop.score > 0.03 ? 0.02 : 0);

  return {
    contactScore: Math.round(contact.score * 10000) / 10000,
    nearHrScore: Math.round(nearHr.score * 10000) / 10000,
    momentumScore: Math.round(momentum.score * 10000) / 10000,
    pitcherFatigueScore: Math.round(fatigue.score * 10000) / 10000,
    veloDropScore: Math.round(veloDrop.score * 10000) / 10000,
    confidenceBoost: Math.round(confidenceBoost * 10000) / 10000,
    tags: Array.from(new Set(allTags)),
  };
}
