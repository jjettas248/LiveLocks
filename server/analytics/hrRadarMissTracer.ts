// LiveLocks — HR Radar missed-HR root-cause tracer (READ-ONLY).
//
// When an HR grades as a miss (`uncalled_hr` / `late_signal` /
// `early_hr_no_window`), this reconstructs the engine's last-known state for
// that batter so the root cause is visible: what conversion probability we
// had, which dynamic state we were in, what drivers/suppressors were present,
// and a DERIVED `blockedGate` explaining why no fire happened.
//
// HARD RULE (section 3.6 / Hard Rule 8): read-only. Consumes only exported
// read-only getters, writes only to the analytics ring buffer, and is fully
// try/catch wrapped so it can NEVER break the grader.

import { getHrAlertState } from "../mlb/hrAlertEngine";
import { getHrRadarOutcomeStamp } from "../mlb/hrRadarOutcomeStamp";
import { emitHrRadarMissTrace } from "./eventEmitters";

// Mirror of hrAlertEngine thresholds — DISPLAY/DIAGNOSTIC ONLY. Kept as local
// literals so the tracer never reaches into engine internals. If the engine
// thresholds change, update these in lockstep (they only affect the derived
// `blockedGate` label, never any runtime decision).
const MIRROR_WATCH_THRESHOLD = 0.05;
const MIRROR_PREPARE_THRESHOLD = 0.06;
const MIRROR_BET_NOW_THRESHOLD = 0.10;

// Keywords that indicate the engine had genuinely strong (barrel / high-xBA /
// elite-EV) contact evidence yet still missed — the highest-value recall bucket.
const STRONG_CONTACT_MARKERS = ["barrel", "xba", "elite", "hard-hit", "hard hit", "deep", "off the wall"];

export interface TraceMissedHrInput {
  gameId: string | number;
  playerId: string | number;
  player?: string | null;
  hrInning?: number | null;
  hrHalf?: string | null;
  gradingStatus: string;
  gradingReason?: string | null;
  alertPath?: string | null;
  alertSignalState?: string | null;
  signalId?: string | null;
}

function deriveStrongContact(drivers: string[]): boolean {
  for (const d of drivers) {
    const s = String(d).toLowerCase();
    for (const m of STRONG_CONTACT_MARKERS) {
      if (s.includes(m)) return true;
    }
  }
  return false;
}

/**
 * Emit a structured miss-trace for a graded-miss HR. Never throws.
 */
export function traceMissedHr(input: TraceMissedHrInput): void {
  try {
    const gameId = String(input.gameId);
    const playerId = String(input.playerId);

    const snap = getHrAlertState(gameId, playerId);
    const stamp = getHrRadarOutcomeStamp(gameId, playerId);

    const calibrated = snap?.hrConversionProbabilityCalibrated ?? 0;
    const peak = snap?.peakConversionProbability ?? (stamp?.rawConversionProbability ?? 0);
    const dynamicState = snap?.currentState ?? "INACTIVE";
    const canonicalStage = snap?.canonicalStage ?? null;
    const decayFactor = snap?.decayFactor ?? 1;
    const positiveDrivers = snap?.positiveDrivers ?? [];
    const negativeSuppressors = snap?.negativeSuppressors ?? [];
    const alertPath = input.alertPath ?? snap?.alertResult?.diagnostics?.alertPath ?? null;

    // Derive WHY no fire happened. Order matters: probability floor first, then
    // suppressors, then decay. `no_alert` covers the engine never engaging.
    let blockedGate: string;
    if (input.gradingStatus === "early_hr_no_window") {
      blockedGate = "early_hr_no_window";
    } else if (!snap || !snap.isInitialized) {
      blockedGate = "no_alert";
    } else if (calibrated < MIRROR_WATCH_THRESHOLD) {
      blockedGate = "conv_low";
    } else if (calibrated < MIRROR_PREPARE_THRESHOLD) {
      blockedGate = "below_prepare";
    } else if (calibrated < MIRROR_BET_NOW_THRESHOLD) {
      blockedGate = "below_bet_now";
    } else if (negativeSuppressors.length > 0) {
      blockedGate = `suppressed:${negativeSuppressors.slice(0, 3).join("|")}`;
    } else if (decayFactor < 1) {
      blockedGate = "decayed";
    } else {
      blockedGate = "late_signal";
    }

    const strongContact = deriveStrongContact(positiveDrivers);

    const traceLine = {
      gameId,
      playerId,
      player: input.player ?? null,
      hrInning: input.hrInning ?? null,
      hrHalf: input.hrHalf ?? null,
      gradingStatus: input.gradingStatus,
      blockedGate,
      strongContact,
      peakConvProb: Math.round(peak * 10000) / 10000,
      lastCalibratedConvProb: Math.round(calibrated * 10000) / 10000,
      lastDynamicState: dynamicState,
      lastCanonicalStage: canonicalStage,
      lastAlertPath: alertPath,
      decayFactor: Math.round(decayFactor * 1000) / 1000,
      positiveDrivers,
      negativeSuppressors,
      gradingReason: input.gradingReason ?? null,
    };
    console.log(`[HR_RADAR_MISS_TRACE] ${JSON.stringify(traceLine)}`);

    emitHrRadarMissTrace({
      signalId: input.signalId ?? `mlb:${gameId}:${playerId}:home_runs:OVER`,
      gameId,
      playerId,
      gradingStatus: input.gradingStatus,
      blockedGate,
      strongContact,
      drivers: positiveDrivers,
      probability: calibrated,
    });
  } catch (err: any) {
    // Never break the grader.
    console.warn(`[HR_RADAR_MISS_TRACE] trace failed err=${err?.message ?? err}`);
  }
}
