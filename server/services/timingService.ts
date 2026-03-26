// ── Timing Engine (Phase 6) ────────────────────────────────────────────────────
// Signal generation is only triggered at optimal game timing windows.
// Each sport has distinct triggers aligned with high-value betting moments.

// ── NBA Timing ────────────────────────────────────────────────────────────────

export interface NBATiming {
  period: number;        // 1=Q1, 2=Q2, 3=Q3, 4=Q4, 5=OT
  clockSeconds: number;  // seconds remaining in current period
  scoreDiff: number;     // absolute score difference (always >= 0)
  isHalftime?: boolean;  // true when between Q2 and Q3
}

export type NBATimingTrigger = "halftime" | "q4_late" | "blowout" | null;

export function getNBATimingTrigger(timing: NBATiming): NBATimingTrigger {
  if (timing.isHalftime) return "halftime";
  if (timing.period === 4 && timing.clockSeconds < 360) return "q4_late";
  if (timing.scoreDiff > 18) return "blowout";
  return null;
}

export function isNBAOptimalWindow(timing: NBATiming): boolean {
  return getNBATimingTrigger(timing) !== null;
}

// ── MLB Timing ────────────────────────────────────────────────────────────────

export interface MLBTiming {
  inning: number;       // current inning number (1-indexed)
  isTopOfInning: boolean;
  pitchCount: number;   // current pitcher pitch count
  timesThrough: number; // how many times through the batting order
  outs?: number;        // outs in current half-inning (0-2)
}

export type MLBTimingTrigger = "after_inning_1" | "high_pitch_count" | "third_time_through" | null;

export function getMLBTimingTrigger(timing: MLBTiming): MLBTimingTrigger {
  // After inning 1 completes (bottom of 1st finishes → inning 2 starts)
  if (timing.inning >= 2) return "after_inning_1";
  if (timing.pitchCount > 75) return "high_pitch_count";
  if (timing.timesThrough >= 3) return "third_time_through";
  return null;
}

export function isMLBOptimalWindow(timing: MLBTiming): boolean {
  return getMLBTimingTrigger(timing) !== null;
}

// ── NCAAB Timing ──────────────────────────────────────────────────────────────

export interface NCAABTiming {
  half: number;                    // 1=first half, 2=second half
  isHalftime: boolean;
  secondsRemainingInHalf: number;  // seconds left in current half
}

export type NCAABTimingTrigger = "halftime" | "under_5_min" | null;

export function getNCAABTimingTrigger(timing: NCAABTiming): NCAABTimingTrigger {
  if (timing.isHalftime) return "halftime";
  if (timing.secondsRemainingInHalf < 300) return "under_5_min"; // < 5 min
  return null;
}

export function isNCAABOptimalWindow(timing: NCAABTiming): boolean {
  return getNCAABTimingTrigger(timing) !== null;
}

// ── Generic timing check ──────────────────────────────────────────────────────

export type AnyTimingTrigger = NBATimingTrigger | MLBTimingTrigger | NCAABTimingTrigger;

export function formatTimingTrigger(trigger: AnyTimingTrigger): string {
  if (!trigger) return "none";
  const labels: Record<string, string> = {
    halftime: "Halftime",
    q4_late: "Q4 < 6 min",
    blowout: "Blowout (spread > 18)",
    after_inning_1: "After inning 1",
    high_pitch_count: "Pitcher >75 pitches",
    third_time_through: "3rd time through order",
    under_5_min: "Under 5 min",
  };
  return labels[trigger] ?? trigger;
}

// ── Phase 13: Unified timing gate ─────────────────────────────────────────────
// All engines MUST call isValidTimingWindow before generating a signal.
// Returns false (suppress) for garbage time / out-of-window states.

export interface TimingWindowInput {
  sport: "nba" | "mlb" | "ncaab";
  nba?: NBATiming;
  mlb?: MLBTiming;
  ncaab?: NCAABTiming;
}

export function isValidTimingWindow(input: TimingWindowInput): boolean {
  switch (input.sport) {
    case "nba": {
      if (!input.nba) return false;
      // Suppress garbage time: blowout (spread > 18) is a "blowout" trigger meaning suppress
      const trigger = getNBATimingTrigger(input.nba);
      if (trigger === "blowout") {
        console.log(`[TIMING GATE][NBA] Garbage time suppressed — spread=${input.nba.scoreDiff}`);
        return false;
      }
      // Allow signals at halftime or Q4 < 6:00
      const valid = trigger !== null;
      if (!valid) console.log(`[TIMING GATE][NBA] Suppressed — no valid trigger (period=${input.nba.period} clock=${input.nba.clockSeconds}s)`);
      return valid;
    }
    case "mlb": {
      if (!input.mlb) return false;
      const valid = isMLBOptimalWindow(input.mlb);
      const trigger = getMLBTimingTrigger(input.mlb);
      if (!valid) console.log(`[TIMING GATE][MLB] Suppressed — no valid trigger (inning=${input.mlb.inning} pitches=${input.mlb.pitchCount} timesThrough=${input.mlb.timesThrough})`);
      else console.log(`[TIMING GATE][MLB] Gate open — trigger=${trigger}`);
      return valid;
    }
    case "ncaab": {
      if (!input.ncaab) return false;
      const valid = isNCAABOptimalWindow(input.ncaab);
      if (!valid) console.log(`[TIMING GATE][NCAAB] Suppressed — half=${input.ncaab.half} secsRemaining=${input.ncaab.secondsRemainingInHalf}`);
      return valid;
    }
    default:
      return true;
  }
}
