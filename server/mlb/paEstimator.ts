// ── MLB Remaining PA Estimator ────────────────────────────────────────────────
// Estimates remaining plate appearances given game state and batting order slot.

const SLOT_MULTIPLIER: Record<number, number> = {
  1: 1.10,
  2: 1.08,
  3: 1.05,
  4: 1.02,
  5: 1.00,
  6: 0.97,
  7: 0.94,
  8: 0.92,
  9: 0.90,
};

const BASELINE_PA_PER_GAME = 4;
const WALK_ADJUSTED_AB_RATIO = 0.87;

export function estimateRemainingPA(
  inning: number,
  isTopInning: boolean,
  battingOrderSlot: number
): { remainingPA: number; remainingAB: number } {
  const clampedInning = Math.max(1, Math.min(9, inning));
  const clampedSlot = Math.max(1, Math.min(9, battingOrderSlot));

  // Innings already completed (from the batter's team perspective)
  // If top inning: batter's team has had (inning - 1) full innings + current partial
  // If bottom inning: batter's team has had (inning - 1) full innings + 1 (they just batted top)
  const completedInnings = isTopInning ? clampedInning - 1 : clampedInning - 0.5;
  const remainingInnings = Math.max(0, 9 - completedInnings);

  // Fraction of game remaining
  const gameFraction = remainingInnings / 9;

  // Apply slot multiplier
  const multiplier = SLOT_MULTIPLIER[clampedSlot] ?? 1.0;
  const remainingPA = Math.max(0, BASELINE_PA_PER_GAME * gameFraction * multiplier);
  const remainingAB = Math.max(0, Math.floor(remainingPA * WALK_ADJUSTED_AB_RATIO));

  return { remainingPA: parseFloat(remainingPA.toFixed(2)), remainingAB };
}
