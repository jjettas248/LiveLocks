import {
  binomialOverProbability,
  negativeBinomialPMFSafe as negativeBinomialPMF,
  poissonPMF,
} from "./math/distributions";

function binomialPMF(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  let logCoeff = 0;
  for (let i = 0; i < k; i++) {
    logCoeff += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.exp(logCoeff + k * Math.log(Math.max(1e-15, p)) + (n - k) * Math.log(Math.max(1e-15, 1 - p)));
}

export function computeHitOutcomeProbability(
  remainingPA: number,
  adjustedHitRate: number,
  neededHits: number
): number {
  const meanHits = remainingPA * adjustedHitRate;

  if (meanHits <= 0 || !isFinite(meanHits)) {
    return binomialOverProbability(remainingPA, adjustedHitRate, neededHits);
  }

  const variance = meanHits * 1.35;
  const diff = variance - meanHits;

  if (diff <= 0 || !isFinite(diff)) {
    return binomialOverProbability(remainingPA, adjustedHitRate, neededHits);
  }

  let k = (meanHits * meanHits) / diff;
  if (k < 1) k = 1;

  const p = k / (k + meanHits);

  if (!isFinite(k) || !isFinite(p) || isNaN(k) || isNaN(p)) {
    return binomialOverProbability(remainingPA, adjustedHitRate, neededHits);
  }

  const cap = 10;
  let probOver = 0;
  for (let x = neededHits; x <= cap; x++) {
    const pmf = negativeBinomialPMF(x, k, p);
    if (isNaN(pmf) || !isFinite(pmf)) {
      return binomialOverProbability(remainingPA, adjustedHitRate, neededHits);
    }
    probOver += pmf;
  }

  if (isNaN(probOver) || !isFinite(probOver)) {
    return binomialOverProbability(remainingPA, adjustedHitRate, neededHits);
  }

  return probOver * 100;
}

export interface HitCountDistributionResult {
  expectedHits: number;
  overProbability: number;
  underProbability: number;
  variance: number;
  distribution: number[];
}

export function computeHitCountDistribution(
  paDist: Record<number, number>,
  hitRate: number,
  currentHits: number,
  bookLine: number
): HitCountDistributionResult {
  const neededHits = Math.max(0, Math.ceil(bookLine) - currentHits);
  const maxHits = 8;
  const hitDist = new Array(maxHits + 1).fill(0);

  let expectedNewHits = 0;

  for (const [paStr, paProb] of Object.entries(paDist)) {
    const pa = Number(paStr);
    if (pa <= 0 || paProb <= 0) continue;

    for (let h = 0; h <= Math.min(pa, maxHits); h++) {
      const pmf = binomialPMF(pa, h, hitRate);
      hitDist[h] += paProb * pmf;
      expectedNewHits += paProb * pmf * h;
    }
  }

  let overProb = 0;
  for (let h = neededHits; h <= maxHits; h++) {
    overProb += hitDist[h];
  }

  let varianceSum = 0;
  for (let h = 0; h <= maxHits; h++) {
    varianceSum += hitDist[h] * (h - expectedNewHits) ** 2;
  }

  return {
    expectedHits: currentHits + expectedNewHits,
    overProbability: Math.max(0, Math.min(100, overProb * 100)),
    underProbability: Math.max(0, Math.min(100, (1 - overProb) * 100)),
    variance: varianceSum,
    distribution: hitDist,
  };
}

export interface TBDistributionResult {
  expectedTB: number;
  overProbability: number;
  underProbability: number;
  variance: number;
}

export function computeTBDistribution(
  paDist: Record<number, number>,
  hitRate: number,
  hitTypeSplits: { pSingle: number; pDouble: number; pTriple: number; pHR: number },
  currentTB: number,
  bookLine: number
): TBDistributionResult {
  const neededTB = Math.max(0, Math.ceil(bookLine) - currentTB);
  const maxTB = 20;
  const tbDist = new Array(maxTB + 1).fill(0);

  const singleHitTBDist = [0, hitTypeSplits.pSingle, hitTypeSplits.pDouble, hitTypeSplits.pTriple, hitTypeSplits.pHR];

  let expectedNewTB = 0;

  for (const [paStr, paProb] of Object.entries(paDist)) {
    const pa = Number(paStr);
    if (pa <= 0 || paProb <= 0) continue;

    for (let h = 0; h <= Math.min(pa, 7); h++) {
      const hitPmf = binomialPMF(pa, h, hitRate);
      if (hitPmf < 1e-10) continue;

      const tbForHits = convolveTBForHits(h, singleHitTBDist, maxTB);

      for (let tb = 0; tb <= maxTB; tb++) {
        const tbProb = tbForHits[tb] ?? 0;
        tbDist[tb] += paProb * hitPmf * tbProb;
        expectedNewTB += paProb * hitPmf * tbProb * tb;
      }
    }
  }

  let overProb = 0;
  for (let tb = neededTB; tb <= maxTB; tb++) {
    overProb += tbDist[tb];
  }

  let varianceSum = 0;
  for (let tb = 0; tb <= maxTB; tb++) {
    varianceSum += tbDist[tb] * (tb - expectedNewTB) ** 2;
  }

  return {
    expectedTB: currentTB + expectedNewTB,
    overProbability: Math.max(0, Math.min(100, overProb * 100)),
    underProbability: Math.max(0, Math.min(100, (1 - overProb) * 100)),
    variance: varianceSum,
  };
}

function convolveTBForHits(hitCount: number, singleHitDist: number[], maxTB: number): number[] {
  if (hitCount === 0) {
    const result = new Array(maxTB + 1).fill(0);
    result[0] = 1;
    return result;
  }

  let current = new Array(maxTB + 1).fill(0);
  for (let tb = 0; tb < singleHitDist.length && tb <= maxTB; tb++) {
    current[tb] = singleHitDist[tb];
  }

  for (let i = 1; i < hitCount; i++) {
    const next = new Array(maxTB + 1).fill(0);
    for (let prevTB = 0; prevTB <= maxTB; prevTB++) {
      if (current[prevTB] < 1e-12) continue;
      for (let addTB = 1; addTB < singleHitDist.length && addTB <= maxTB; addTB++) {
        const newTB = prevTB + addTB;
        if (newTB > maxTB) break;
        next[newTB] += current[prevTB] * singleHitDist[addTB];
      }
    }
    current = next;
  }

  return current;
}

export interface KCountDistributionResult {
  expectedK: number;
  overProbability: number;
  underProbability: number;
  variance: number;
}

export function computeKCountDistribution(
  bfDist: Record<number, number>,
  kRatePerBF: number,
  currentK: number,
  bookLine: number
): KCountDistributionResult {
  const neededK = Math.max(0, Math.ceil(bookLine) - currentK);
  const maxK = 20;
  const kDist = new Array(maxK + 1).fill(0);

  let expectedNewK = 0;

  for (const [bfStr, bfProb] of Object.entries(bfDist)) {
    const bf = Number(bfStr);
    if (bf <= 0 || bfProb <= 0) continue;

    for (let k = 0; k <= Math.min(bf, maxK); k++) {
      const pmf = binomialPMF(bf, k, kRatePerBF);
      kDist[k] += bfProb * pmf;
      expectedNewK += bfProb * pmf * k;
    }
  }

  let overProb = 0;
  for (let k = neededK; k <= maxK; k++) {
    overProb += kDist[k];
  }

  let varianceSum = 0;
  for (let k = 0; k <= maxK; k++) {
    varianceSum += kDist[k] * (k - expectedNewK) ** 2;
  }

  return {
    expectedK: currentK + expectedNewK,
    overProbability: Math.max(0, Math.min(100, overProb * 100)),
    underProbability: Math.max(0, Math.min(100, (1 - overProb) * 100)),
    variance: varianceSum,
  };
}

export interface HRDistributionResult {
  expectedHR: number;
  overProbability: number;
  underProbability: number;
  variance: number;
  premiumConfidence: number;
}

export function computeHRDistribution(
  paDist: Record<number, number>,
  hrRatePerPA: number,
  currentHR: number,
  bookLine: number
): HRDistributionResult {
  const neededHR = Math.max(0, Math.ceil(bookLine) - currentHR);
  const maxHR = 5;
  const hrDist = new Array(maxHR + 1).fill(0);

  let expectedNewHR = 0;

  for (const [paStr, paProb] of Object.entries(paDist)) {
    const pa = Number(paStr);
    if (pa <= 0 || paProb <= 0) continue;

    for (let h = 0; h <= Math.min(pa, maxHR); h++) {
      const pmf = binomialPMF(pa, h, hrRatePerPA);
      hrDist[h] += paProb * pmf;
      expectedNewHR += paProb * pmf * h;
    }
  }

  let overProb = 0;
  for (let h = neededHR; h <= maxHR; h++) {
    overProb += hrDist[h];
  }

  let varianceSum = 0;
  for (let h = 0; h <= maxHR; h++) {
    varianceSum += hrDist[h] * (h - expectedNewHR) ** 2;
  }

  const premiumConfidence = overProb > 0.20 ? Math.min(1.0, overProb * 2) : overProb;

  return {
    expectedHR: currentHR + expectedNewHR,
    overProbability: Math.max(0, Math.min(100, overProb * 100)),
    underProbability: Math.max(0, Math.min(100, (1 - overProb) * 100)),
    variance: varianceSum,
    premiumConfidence,
  };
}

