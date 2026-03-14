const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function estimatePADistribution(
  inning: number,
  battingOrderSlot: number,
  currentRuns: number,
  leagueAvgRuns: number
): { 1: number; 2: number; 3: number } {
  const paceFactor = clamp(currentRuns / leagueAvgRuns, 0.85, 1.15);

  let slotAdj = -0.15;
  if (battingOrderSlot <= 2) {
    slotAdj = 0.20;
  } else if (battingOrderSlot <= 5) {
    slotAdj = 0.10;
  } else if (battingOrderSlot <= 7) {
    slotAdj = -0.05;
  }

  let pa1 = clamp(0.35 + slotAdj + (inning * -0.02), 0, 1);
  let pa2 = clamp(0.45 + paceFactor * 0.05, 0, 1);
  let pa3 = clamp(0.20 + (9 - inning) * 0.02, 0, 1);

  const sum = pa1 + pa2 + pa3;

  if (sum === 0) {
    return { 1: 0.34, 2: 0.33, 3: 0.33 };
  }

  pa1 /= sum;
  pa2 /= sum;
  pa3 /= sum;

  return { 1: pa1, 2: pa2, 3: pa3 };
}
