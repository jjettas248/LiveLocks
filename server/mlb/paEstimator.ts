const SLOT_ADJUSTMENT: Record<number, number> = {
  1: 0.45,
  2: 0.45,
  3: 0.30,
  4: 0.30,
  5: 0.30,
  6: 0.10,
  7: 0.10,
  8: -0.10,
  9: -0.10,
};

export function estimateRemainingPA(
  inning: number,
  isTopInning: boolean,
  battingOrderSlot: number,
  currentRuns?: number,
  leagueAvgRuns?: number
): { remainingPA: number; remainingAB: number } {
  const clampedInning = Math.max(1, Math.min(9, inning));
  const clampedSlot = Math.max(1, Math.min(9, battingOrderSlot));

  const basePA = (9 - clampedInning) * 0.44;
  const slotAdj = SLOT_ADJUSTMENT[clampedSlot] ?? 0;
  let rawPA = basePA + slotAdj;

  if (currentRuns != null && leagueAvgRuns != null && leagueAvgRuns > 0) {
    const paceFactor = Math.max(0.85, Math.min(1.15, currentRuns / leagueAvgRuns));
    rawPA *= paceFactor;
  }

  const remainingPA = Math.max(1.0, Math.min(3.5, rawPA));
  const remainingAB = Math.max(0, Math.floor(remainingPA * 0.87));

  return { remainingPA: parseFloat(remainingPA.toFixed(2)), remainingAB };
}
