// HR Radar — HR Max Window policy (Phase 1, 3-tier ladder).
// ─────────────────────────────────────────────────────────────────────────
// Pure functions only. Defines the bounded plate-appearance window for an
// HR Max Window signal so "window closed" means a real window, not just
// game-over.
//
// An HR Max Window signal is a bet that the batter homers within a bounded
// horizon of upcoming plate appearances. When that horizon lapses:
//   • If the batter actually had the window's worth of opportunity (enough
//     game remained after the signal) and did not homer → it's a genuine
//     `called_miss` (the actionable pick lost).
//   • If the signal fired so late that the batter never realistically got the
//     window's PAs before the game ended → `expired` (the window was cut
//     short; not a clean miss, not counted in the W/L ledger).
//
// No I/O, no DB, no engine math.

/**
 * Plate appearances an HR Max Window signal covers: the batter's current plus
 * next PA. Conservative so most mid-game signals still grade as real picks.
 */
export const HR_MAX_WINDOW_PA_BUDGET = 2;

/**
 * Approximate innings between a single batter's plate appearances over a full
 * lineup turn (~one PA every ~2 innings). Used only as a coarse proxy at
 * game-final reconcile, where exact post-signal PA counts are not available.
 */
export const APPROX_INNINGS_PER_PA = 2;

/**
 * Minimum innings of game that must have elapsed AFTER an HR Max Window signal
 * for its PA window to be considered fairly played out. Below this, the batter
 * demonstrably did not get a realistic chance at the window's PAs.
 *
 * Kept deliberately small (1 inning) so the `expired` carve-out only catches
 * signals that fired effectively in the game's final frame — every earlier
 * signal grades as a real `called_miss`. This minimizes under-counting of
 * genuine misses while still making "window closed" honest for last-ditch
 * late-game signals.
 */
export const HR_MAX_WINDOW_MIN_ELAPSED_INNINGS = 1;

/**
 * At game-final with no HR, classify how an HR Max Window signal resolves.
 * Pure. `signalInning` / `finalInning` are 1-based; nulls fail safe to
 * `called_miss` (treat an un-timestamped actionable pick as a real miss so we
 * never silently drop a loss from the ledger).
 */
export function classifyHrMaxWindowAtFinal(args: {
  signalInning: number | null | undefined;
  finalInning: number | null | undefined;
}): "called_miss" | "expired" {
  const sig = args.signalInning;
  const fin = args.finalInning;
  if (sig == null || fin == null) return "called_miss";
  const elapsed = fin - sig;
  // Signal fired in (or after) the final inning, or with too little game left
  // for the batter to realistically get the window's PAs → window was cut
  // short, not a clean miss.
  if (elapsed < HR_MAX_WINDOW_MIN_ELAPSED_INNINGS) return "expired";
  return "called_miss";
}

/**
 * Human-readable window descriptor for the UI. Pure. Given the inning the
 * signal fired, returns the inning by which the HR Max Window closes (the
 * signal inning plus the approximate innings the PA budget spans).
 */
export function hrMaxWindowClosesByInning(signalInning: number | null | undefined): number | null {
  if (signalInning == null) return null;
  return signalInning + HR_MAX_WINDOW_PA_BUDGET * APPROX_INNINGS_PER_PA;
}
