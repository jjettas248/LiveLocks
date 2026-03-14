import { binomialOverProbability } from "./hitProbabilityModel";

function logGamma(z: number): number {
  if (z <= 0) return Infinity;
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.001208650973866179, -0.000005395239384953,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += c[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function negativeBinomialPMF(x: number, k: number, p: number): number {
  const logCoeff = logGamma(x + k) - logGamma(x + 1) - logGamma(k);
  const logProb = x * Math.log(1 - p) + k * Math.log(p);
  const result = Math.exp(logCoeff + logProb);
  return result;
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
