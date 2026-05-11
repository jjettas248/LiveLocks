import { poissonPMF } from "./math/distributions";

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function estimatePADistribution(
  inning: number,
  battingOrderSlot: number,
  currentRuns: number,
  leagueAvgRuns: number
): { 1: number; 2: number; 3: number } {
  const rich = estimateRichPADistribution(inning, battingOrderSlot, currentRuns, leagueAvgRuns, true);
  const p1 = rich[1] ?? 0;
  const p2 = rich[2] ?? 0;
  let p3 = 0;
  for (const [k, v] of Object.entries(rich)) {
    if (Number(k) >= 3) p3 += v;
  }
  const sum = p1 + p2 + p3;
  if (sum === 0) return { 1: 0.34, 2: 0.33, 3: 0.33 };
  return { 1: p1 / sum, 2: p2 / sum, 3: p3 / sum };
}

export function estimateRichPADistribution(
  inning: number,
  battingOrderSlot: number,
  currentRuns: number,
  leagueAvgRuns: number,
  isTopInning: boolean
): Record<number, number> {
  const clampedInning = Math.max(1, Math.min(9, inning));
  const clampedSlot = Math.max(1, Math.min(9, battingOrderSlot));
  const remainingHalfInnings = (9 - clampedInning) * 2 + (isTopInning ? 1 : 0);

  const basePA = remainingHalfInnings * 0.22;

  let slotAdj = 0;
  if (clampedSlot <= 2) slotAdj = 0.35;
  else if (clampedSlot <= 4) slotAdj = 0.20;
  else if (clampedSlot <= 6) slotAdj = 0.05;
  else if (clampedSlot <= 7) slotAdj = -0.05;
  else slotAdj = -0.15;

  let paceFactor = 1.0;
  if (leagueAvgRuns > 0) {
    paceFactor = clamp(currentRuns / leagueAvgRuns, 0.85, 1.20);
  }

  const meanPA = clamp(basePA + slotAdj, 0, 7) * paceFactor;

  const maxPA = adaptiveSupport(meanPA, 8);
  const dist: Record<number, number> = {};
  for (let k = 0; k <= maxPA; k++) {
    dist[k] = poissonPMF(meanPA, k);
  }

  const sum = Object.values(dist).reduce((s, v) => s + v, 0);
  if (sum === 0) {
    return { 0: 0.05, 1: 0.25, 2: 0.40, 3: 0.20, 4: 0.08, 5: 0.02 };
  }
  for (const k of Object.keys(dist)) {
    dist[Number(k)] /= sum;
  }
  return dist;
}

export function estimateRichBFDistribution(
  inning: number,
  pitchCount: number,
  kPer9: number,
  timesThrough: number,
  managerLeashShort: boolean
): Record<number, number> {
  const clampedInning = Math.max(1, Math.min(9, inning));
  const BF_PER_INNING = 4.3;

  let expectedRemainingIP = Math.max(0.5, 6.0 - (clampedInning - 1));

  if (pitchCount > 100) expectedRemainingIP *= 0.40;
  else if (pitchCount > 90) expectedRemainingIP *= 0.55;
  else if (pitchCount > 80) expectedRemainingIP *= 0.70;
  else if (pitchCount > 70) expectedRemainingIP *= 0.85;

  if (timesThrough >= 3) expectedRemainingIP *= 0.75;
  if (managerLeashShort) expectedRemainingIP *= 0.70;

  const meanBF = clamp(expectedRemainingIP * BF_PER_INNING, 1, 30);

  const maxBF = adaptiveSupport(meanBF, 40);
  const dist: Record<number, number> = {};
  for (let k = 0; k <= maxBF; k++) {
    dist[k] = poissonPMF(meanBF, k);
  }

  const sum = Object.values(dist).reduce((s, v) => s + v, 0);
  for (const k of Object.keys(dist)) {
    dist[Number(k)] /= sum;
  }
  return dist;
}

function adaptiveSupport(mean: number, hardCap: number): number {
  let k = Math.ceil(mean) + 1;
  while (k < hardCap) {
    const pmf = poissonPMF(mean, k);
    if (pmf < 1e-6) break;
    k++;
  }
  return Math.min(k, hardCap);
}

