// Canonical Signal Driver — cross-sport runtime contract.
//
// Every surfaced signal carries a `canonicalDrivers[]` array describing
// WHY the signal exists. Drivers are engine-built (server-side) and
// rendered verbatim by the UI. The UI is PROHIBITED from inventing,
// fabricating, or transforming drivers beyond display formatting.
//
// This is a transport contract, not sport math. NBA / NCAAB / MLB engines
// each build their own drivers from their own scoring breakdowns.

export type DriverCategory =
  | "form"        // recent player form: hot streak, rolling EV, contact trend
  | "matchup"    // opponent / pitcher / defender exposure
  | "live"        // in-game live event modifiers (pitch count, fatigue, momentum)
  | "market"      // book line vs projection, edge math, calibration
  | "context";    // weather, park, lineup turn, situational

export interface SignalDriver {
  /** Short human-readable label, e.g. "Strong Contact Trend". */
  label: string;
  /** Engine-relative weight 0-100 of this driver's contribution. */
  weight: number;
  /** Bucket category for analytics + UI grouping. */
  category: DriverCategory;
  /** Optional one-line elaboration, server-built. */
  detail?: string;
}

/** A single readable summary line, server-built, for "Why this signal?" */
export type TriggerSummary = string;

/**
 * Canonical explainability envelope. Optional during rollout — every
 * surfaced signal SHOULD carry it after Batch A is fully deployed.
 */
export interface SignalExplainability {
  drivers: SignalDriver[];
  triggerSummary: TriggerSummary | null;
  /** When suppressed, the engine reason for suppression. */
  suppressionReason?: string | null;
}
