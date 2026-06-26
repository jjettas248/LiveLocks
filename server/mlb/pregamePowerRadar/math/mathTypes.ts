// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW math contracts
//
// This module defines the data contracts for the v2 pregame HR math core. It is
// SHADOW-ONLY: nothing here is wired into the production build/scoring path. The
// production engine (scoring.ts / buildPregamePowerRadar.ts) is unchanged.
//
// Design rules (mirror CLAUDE.md §3.1/§7 + module intent):
//   • Pure types only — no I/O, no imports from sport engines, no hrConversionModel.
//   • Pre-first-pitch information only. No live-only fields (see leakageGuard.ts).
//   • Every feature input is nullable and additive: absent → no-op contribution.
//   • All probabilities are MODELLED, not CALIBRATED. Coefficients are documented,
//     literature-informed DEFAULT PRIORS — they are NOT fitted to historical
//     outcomes. Empirical calibration is an explicitly deferred future phase
//     (see docs/audits/pregame-power-v2-math-framework.md → "Future phases").
// ─────────────────────────────────────────────────────────────────────────────

/** v2 shadow tier. Distinct from the production `PregamePowerTier` — returned in
 *  diagnostics/report artifacts only, never stamped onto a production signal. */
export type PregameMathTier = "elite" | "strong" | "watch" | "neutral" | "suppressed";

export type Handedness = "L" | "R" | "S" | null;

// ── Feature input groups (all fields nullable; absent → no-op) ────────────────

/** A. Batter true-power skill (season / pre-first-pitch only). */
export interface BatterTruePowerInputs {
  xISO: number | null;
  xSLG: number | null;
  xwOBAcon: number | null;
  barrelRatePct: number | null;
  hardHitRatePct: number | null;
  exitVelocity: number | null;
  maxEV: number | null;
  flyBallPct: number | null;
  hrFBRatioPct: number | null;
  pullRatePct: number | null;
  sweetSpotPct: number | null;
  /** Season HR per PA (heavily shrunk anchor). */
  hrPerPaSeason: number | null;
  /** Plate-appearance sample backing the season rates (for shrinkage). */
  paSample: number | null;
}

/** B. Bat-tracking / swing-quality skill (season aggregates only). */
export interface BatTrackingInputs {
  avgBatSpeed: number | null;
  fastSwingRatePct: number | null;
  avgSwingLength: number | null;
  squaredUpPerSwingPct: number | null;
  blastPerSwingPct: number | null;
  swingSample: number | null;
}

/** E. Pitcher HR vulnerability (season + handedness split; pre-game only). */
export interface PitcherVulnerabilityInputs {
  pitcherKnown: boolean;
  batterHand: Handedness;
  pitcherThrows: "L" | "R" | null;
  hrPer9VsHand: number | null;
  hrPer9Overall: number | null;
  barrelAllowedPct: number | null;
  hardHitAllowedPct: number | null;
  flyBallAllowedPct: number | null;
  /** Batters-faced sample backing the splits (for shrinkage). */
  bfSample: number | null;
}

/** C/F. Pitch-type interaction — batter damage × pitcher usage by family. */
export interface PitchFamilyDatum {
  family: "fastball" | "breaking" | "offspeed";
  /** Pitcher usage share [0,1] of this family. */
  usageShare: number | null;
  /** Batter xSLG vs this family. */
  batterXslg: number | null;
  /** Batter whiff% vs this family (informational suppressor). */
  batterWhiffPct: number | null;
  /** Sample (BBE or pitches) backing the batter split — for shrinkage. */
  batterSample: number | null;
}
export interface PitchTypeInteractionInputs {
  families: PitchFamilyDatum[];
}

/** D. Zone / location interaction — batter hot-zone × pitcher mistake-zone overlap. */
export interface ZoneLocationInputs {
  /** Batter damage (xSLG-like, 0–1) by zone bucket; null when unavailable. */
  batterHeartXslg: number | null;
  batterElevatedFbXslg: number | null;
  batterLowBreakingXslg: number | null;
  /** Pitcher mistake exposure [0,1] by zone bucket. */
  pitcherHeartRate: number | null;
  pitcherMiddleMiddleRate: number | null;
  pitcherHangerRate: number | null;
}

/** I/J. Park + weather + spray fit (pre-game forecast only). */
export interface ParkWeatherSprayInputs {
  parkHrFactor: number | null;
  parkHrFactorHand: number | null;
  isIndoors: boolean;
  weatherAvailable: boolean;
  temperatureF: number | null;
  windSpeedMph: number | null;
  windDirection: "in" | "out" | "cross" | "calm" | null;
  /** Batter pull-air share [0,1] — used to gate wind/park pull benefit. */
  batterPullAirShare: number | null;
}

/** K. Lineup / opportunity / volume (confirmed lineup + market totals). */
export interface LineupOpportunityInputs {
  battingOrderSlot: number | null;
  teamImpliedRuns: number | null;
  obpAhead: number | null;
  lineupConfirmed: boolean;
}

/** L/M. Starter exposure + bullpen path (pre-game projections only). */
export interface StarterBullpenPathInputs {
  starterConfirmed: boolean;
  /** Projected PA the batter sees vs the starter. */
  projectedPaVsStarter: number | null;
  /** Projected PA vs the bullpen. */
  projectedPaVsBullpen: number | null;
  bullpenHrPer9: number | null;
  bullpenBarrelAllowedPct: number | null;
}

/** O. Market confirmation — confirm/rank only, never creates a candidate. */
export interface MarketConfirmationInputs {
  hrOddsAvailable: boolean;
  impliedHrProbability: number | null;
  noVigImpliedHrProbability: number | null;
}

/** P. Availability suppressors (news/rest/scratch). Confidence/suppressor only. */
export interface AvailabilitySuppressorInputs {
  confirmedActive: boolean | null;
  lateScratchRisk: boolean | null;
  restDayRisk: boolean | null;
  platoonSubRisk: boolean | null;
}

/** Bundle of all v2 feature inputs for one (player, game). */
export interface PregameMathInputs {
  playerId: string;
  gameId: string;
  batterHand: Handedness;
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
  /** Slate-wide baseline HR/game probability for lift comparison (slate prior, no leakage). */
  slateBaselineGameHrProbability: number | null;
}

/** A single additive log-odds term contributed by one component. */
export interface LogOddsTerm {
  key: string;
  /** Log-odds delta added to the per-PA HR logit (0 when feature absent). */
  logOdds: number;
  /** Whether the component had usable data. */
  available: boolean;
  /** Optional shrinkage weight [0,1] applied (1 = full strength). */
  shrinkWeight?: number;
  /** Human-readable note for diagnostics. */
  note?: string;
}

/** Canonical v2 SHADOW output (superset alignment with the task spec). */
export interface PregameMathModelResult {
  playerId: string;
  gameId: string;

  baselineHrPerPa: number | null;
  batterTruePowerHrPerPa: number | null;
  batterBatTrackingPowerScore100: number | null;
  pitcherAdjustedHrPerPa: number | null;
  pitchTypeAdjustedHrPerPa: number | null;
  zoneLocationAdjustedHrPerPa: number | null;
  parkWeatherAdjustedHrPerPa: number | null;
  matchupAdjustedHrPerPa: number | null;
  calibratedHrPerPa: number | null;

  projectedPA: number | null;
  paDistribution: Record<string, number>;

  rawGameHrProbability: number | null;
  calibratedGameHrProbability: number | null;

  playerBaselineGameHrProbability: number | null;
  slateBaselineGameHrProbability: number | null;
  marketImpliedHrProbability: number | null;

  hrLiftVsPlayerBaseline: number | null;
  hrLiftVsSlateBaseline: number | null;
  hrLiftVsMarket: number | null;

  rawSetupScore100: number;
  probabilityScore100: number;
  confidenceScore100: number;
  candidateRankScore100: number;

  recommendedTier: PregameMathTier;

  drivers: string[];
  suppressors: string[];

  statCoverage: Record<string, "used" | "missing" | "fallback" | "not_available">;
  shrinkageDiagnostics: Record<string, unknown>;
  interactionDiagnostics: Record<string, unknown>;
  calibrationDiagnostics: Record<string, unknown>;
  missingDataWarnings: string[];
  leakageWarnings: string[];
}

// ── Leakage / provenance contract (consumed by leakageGuard.ts) ──────────────

/** When, in the game timeline, a feature value was produced. */
export type FeaturePhase = "season" | "pregame" | "live" | "unknown";

/** Provenance descriptor for one feature value. */
export interface FeatureProvenance {
  /** Canonical feature name (snake/camel — matched case-insensitively). */
  name: string;
  /** When the value was produced, if known (ISO 8601). */
  valueTimestamp?: string | null;
  /** Declared phase of the value, if known. */
  phase?: FeaturePhase;
}
