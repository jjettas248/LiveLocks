// ─────────────────────────────────────────────────────────────────────────────
// Plate HR Probability V2 — the frozen per-candidate input DTO (PR 1).
//
// Owns the one immutable, hashed snapshot of a (batter, game) candidate's
// math/-shaped inputs. Mirrors frozenPlateInput.ts's deepFreeze/
// stableStringify/hash idiom exactly (the champion/challenger's own frozen
// input contract) — but wraps math/mathTypes.ts's `PregameMathInputs` ten
// groups, not the champion's differently-shaped batter/pitcher/matchup/
// parkWeather/lineup groups, since V2 is built to hand off directly into
// math/'s existing, tested `buildPregameHrPerPa` rather than the champion's
// scoring pipeline.
//
// The deepFreeze/stableStringify/hash utilities below are a deliberate
// duplicate of frozenPlateInput.ts's implementation, not an import —
// extracting a shared helper would touch a file adjacent to the frozen
// champion path for a pure refactor with zero behavior change. Keep in sync
// by convention if frozenPlateInput.ts's implementation ever changes.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import type {
  BatterTruePowerInputs,
  BatTrackingInputs,
  PitcherVulnerabilityInputs,
  PitchTypeInteractionInputs,
  ZoneLocationInputs,
  ParkWeatherSprayInputs,
  LineupOpportunityInputs,
  StarterBullpenPathInputs,
  MarketConfirmationInputs,
  AvailabilitySuppressorInputs,
  Handedness,
  PregameMathInputs,
} from "../math/mathTypes";
import type { RecentContactFormInputs } from "./recentContactForm";

/**
 * PR1 contract slot only — no math/ scorer reads this yet (PR3 wires one).
 * Always all-null in PR1's forward capture.
 */
export interface ContactOpportunityInputs {
  kRatePct: number | null;
  bbRatePct: number | null;
  whiffRatePct: number | null;
  contactRatePct: number | null;
  zoneContactRatePct: number | null;
  chaseRatePct: number | null;
}

/** Exactly PregameMathInputs's 10 groups, field-for-field, plus the PR1 extension. */
export interface FrozenPlateHrV2Body {
  batterPower: BatterTruePowerInputs;
  batTracking: BatTrackingInputs;
  pitcherVulnerability: PitcherVulnerabilityInputs;
  pitchType: PitchTypeInteractionInputs;
  zoneLocation: ZoneLocationInputs;
  parkWeatherSpray: ParkWeatherSprayInputs;
  lineupOpportunity: LineupOpportunityInputs;
  starterBullpen: StarterBullpenPathInputs;
  market: MarketConfirmationInputs;
  availability: AvailabilitySuppressorInputs;
  contactOpportunity: ContactOpportunityInputs;
  // PR5 additive shadow slot — no math/ scorer reads this yet (PR6 wires one).
  // Optional so existing construction sites are unaffected; omitted → the feature
  // builder emits a neutral all-null group. Never entered into toPregameMathInputs.
  recentContactForm?: RecentContactFormInputs;
  slateBaselineGameHrProbability: number | null;
}

export interface FrozenPlateHrV2DataQuality {
  savantQuality: "full" | "fallback" | "missing";
  venueResolved: boolean;
  pitcherHandResolved: boolean;
  batterPowerFullyAvailable: boolean;
}

export interface FrozenPlateHrV2Input {
  sessionDate: string;
  gameId: string;
  batterId: string;
  pitcherId: string | null;
  batterHand: Handedness;
  body: FrozenPlateHrV2Body;
  dataQuality: FrozenPlateHrV2DataQuality;
}

/** Recursively freeze so no downstream consumer can mutate what was captured. */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Stable serialization: keys sorted at every level, so an object-literal
 * reordering can never change the hash and produce a spurious "different
 * inputs" reading.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashFrozenPlateHrV2Input(input: FrozenPlateHrV2Input): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 16);
}

export function freezePlateHrV2Input(input: FrozenPlateHrV2Input): Readonly<FrozenPlateHrV2Input> {
  return deepFreeze(input);
}

/**
 * Proves this contract is math/-compatible TODAY: drops the PR1-only
 * contactOpportunity extension and the envelope fields not part of
 * PregameMathInputs, and re-wraps at PregameMathInputs' top level. PR2 calls
 * `toPregameMathInputs(frozen)` then `buildPregameHrPerPa(...)` directly — no
 * new adapter code needed then.
 */
export function toPregameMathInputs(frozen: FrozenPlateHrV2Input): PregameMathInputs {
  return {
    playerId: frozen.batterId,
    gameId: frozen.gameId,
    batterHand: frozen.batterHand,
    batterPower: frozen.body.batterPower,
    batTracking: frozen.body.batTracking,
    pitcherVulnerability: frozen.body.pitcherVulnerability,
    pitchType: frozen.body.pitchType,
    zoneLocation: frozen.body.zoneLocation,
    parkWeatherSpray: frozen.body.parkWeatherSpray,
    lineupOpportunity: frozen.body.lineupOpportunity,
    starterBullpen: frozen.body.starterBullpen,
    market: frozen.body.market,
    availability: frozen.body.availability,
    slateBaselineGameHrProbability: frozen.body.slateBaselineGameHrProbability,
  };
}
