// ─────────────────────────────────────────────────────────────────────────────
// Pre-Game Power Radar — v2 SHADOW math contracts
//
// This module defines the data contracts for the v2 pregame HR math core. It is
// SHADOW-ONLY: nothing here is wired into the production build/scoring path.
//
// Design rules (mirror CLAUDE.md §3.1/§7 + module intent):
//   • Pure types only — no I/O, no imports from sport engines, no hrConversionModel.
//   • Pre-first-pitch information only. No live-only fields (see leakageGuard.ts).
//   • Every feature input is nullable and additive: absent → no-op contribution.
//   • All probabilities are MODELLED, not CALIBRATED. Coefficients are documented,
//     literature-informed DEFAULT PRIORS — they are NOT fitted to historical
//     outcomes. Empirical calibration remains a promotion prerequisite.
// ─────────────────────────────────────────────────────────────────────────────

/** v2 shadow tier. Distinct from the production `PregamePowerTier`. */
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

/**
 * B. Bat-tracking / swing-quality skill (season aggregates only).
 *
 * Statcast definitions used by this contract:
 * - fast swing: bat speed >= 75 mph
 * - ideal attack angle: 5–20 degrees
 * - squared-up/blasts are official Statcast metrics only; NEVER derive them from
 *   bat speed or attack angle when the source does not provide them.
 *
 * Newer fields are optional so historical fixtures and frozen v2 inputs remain
 * readable without backfilling fabricated nulls.
 */
export interface BatTrackingInputs {
  avgBatSpeed: number | null;
  fastSwingRatePct: number | null;
  avgSwingLength: number | null;
  /** Mean attack angle at contact, degrees. */
  avgAttackAngle?: number | null;
  /** Share of tracked contact swings with attack angle inside Statcast's 5–20° ideal band. */
  idealAttackAngleRatePct?: number | null;
  /** Standard deviation of attack angle; context/consistency feature, not required. */
  attackAngleStdDev?: number | null;
  /** Mean swing-path tilt over the 40 ms before contact. Kept diagnostic until fitted. */
  avgSwingPathTilt?: number | null;
  squaredUpPerSwingPct: number | null;
  blastPerSwingPct: number | null;
  swingSample: number | null;
}

/**
 * B2. Stabilized recent-contact form (PR5 shadow features) → a batter-INTRINSIC
 * log-odds term. Every field is a stabilized, reliability-blended aggregate over
 * the most-recent BBE window (see hrProbabilityV2/recentContactForm.ts) — NOT a
 * raw streak. It carries NO home-run count or HR/FB (that can never contribute;
 * mirrors the PR5 leakage boundary), so recent power form enters only through
 * measured contact quality (EV / EV90 / air% / barrel%).
 *
 * This term applies to EVERY PA segment (starter AND bullpen) because it is a
 * property of the hitter, not the opponent. All fields are nullable and additive:
 * absent → no-op (0 contribution). It is intentionally NOT populated by
 * `toPregameMathInputs` (the shadow feature stays out of the production frozen
 * math path per the isolation guarantee); it is exercised through the segmented
 * builder + its property tests, and any future explicit wiring is later work.
 */
export interface RecentContactFormTermInputs {
  /** Stabilized recent barrel% on contact (0–100). */
  recentFormBarrelPct: number | null;
  /** Stabilized recent average exit velocity (mph). */
  recentFormAvgEv: number | null;
  /** Stabilized recent 90th-percentile exit velocity (mph). */
  recentFormEv90: number | null;
  /** Stabilized recent air-ball% (LA ≥ 10°), 0–100. */
  recentFormAirPct: number | null;
  /** Effective BBE backing the window (reliability weight; shrinks a thin window toward no-op). */
  effectiveBbe: number | null;
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
  /** BBE sample backing the DAMAGE (xSLG) split — the denominator to shrink
   * batterXslg by. Grain: balls-in-play with a measurable xSLG. */
  batterSample: number | null;
  /** Swing sample backing the WHIFF% split — the denominator to shrink
   * batterWhiffPct by. Grain: swings. Kept SEPARATE from batterSample (BBE) so
   * a BBE denominator is never used as a swing denominator (PR4.1 #2). */
  batterWhiffSample?: number | null;
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

/** I/J. Park + weather + spray + physical fence geometry (pre-game only). */
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
  /** Pull-side wall geometry resolved from the 2026 Statcast dimensions table. */
  pullFenceDistanceFt?: number | null;
  pullFenceHeightFt?: number | null;
  /** Whole-park references from Statcast, used so geometry is relative to the park itself. */
  avgFenceDistanceFt?: number | null;
  avgFenceHeightFt?: number | null;
  /** Statcast's average distance required for a HR after fence height is included. */
  avgHrDistanceFt?: number | null;
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
  /**
   * Opener/bulk-pitcher signal (PR6, optional). When true, the starter is
   * expected to face the batter very few times (short leash) so PA mass shifts
   * to the bullpen path. Widens the starter-faced-PA spread when the split is
   * uncertain. Absent → no effect (the projected-PA split alone drives the path).
   */
  isOpenerLikely?: boolean | null;
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
  /**
   * B2. Stabilized recent-contact form (PR6, optional). Additive batter-intrinsic
   * term consumed by the segmented builder. Optional so existing fixtures and the
   * production frozen path (`toPregameMathInputs`, which deliberately omits it)
   * compile unchanged; absent → no-op.
   */
  recentContactForm?: RecentContactFormTermInputs | null;
  /** Slate-wide baseline HR/game probability for lift comparison (slate prior, no leakage). */
  slateBaselineGameHrProbability: number | null;
}

// ── PR6: starter/bullpen joint PA-path contracts ─────────────────────────────

/**
 * Per-segment HR-per-PA rates. `starterHrPerPa` (p_s) folds in the starter
 * opponent terms (pitcher vulnerability, starter pitch-mix, starter zone);
 * `bullpenHrPerPa` (p_b) folds in ONLY the expected-bullpen vulnerability.
 * BOTH share the hitter / recent-form / park terms. This is the §10
 * per-segment decomposition — starter-only terms never enter p_b, and
 * hitter/form/park always enter p_b.
 */
export interface SegmentedHrPerPaResult {
  /** p_s — per-PA HR probability vs the starter (post shrink + suppressor). */
  starterHrPerPa: number;
  /** p_b — per-PA HR probability vs the bullpen (post shrink + suppressor). */
  bullpenHrPerPa: number;

  /** β0 + Hitter + RecentForm + ParkWeather (pre-suppressor, shared by both segments). */
  sharedLogit: number;
  /** Starter opponent log-odds (pitcher + starter pitch-mix + starter zone). */
  starterOpponentLogOdds: number;
  /** Bullpen opponent log-odds (expected-bullpen vulnerability only). */
  bullpenOpponentLogOdds: number;
  /** Recent-contact-form log-odds contribution (batter-intrinsic; enters both). */
  recentFormLogOdds: number;

  /** True iff real bullpen-vulnerability data was present (else p_b uses a neutral opponent). */
  bullpenVulnerabilityAvailable: boolean;

  terms: LogOddsTerm[];
  suppressors: string[];
  suppressorPenalty: number;
  confidenceFactor: number;
  /** [0,1] coverage of the starter-segment core families (batter + starter). */
  starterCoreCoverage: number;
  /** [0,1] coverage of the bullpen-segment core families (batter + bullpen). */
  bullpenCoreCoverage: number;
  effectiveSample: number;
}

/**
 * Joint distribution over (PA vs starter = n_s, PA vs bullpen = n_b). Keys are
 * `"${n_s}:${n_b}"` and the values sum to 1. The batter's PA are sequential, so
 * for a given total N the starter is faced first (n_s) then the bullpen (n_b).
 */
export interface PaPathJointDistribution {
  joint: Record<string, number>;
  /** E[N_s] — expected PA vs the starter. */
  starterMean: number;
  /** E[N_b] — expected PA vs the bullpen. */
  bullpenMean: number;
  /** E[N_s + N_b] — expected total PA. */
  totalMean: number;
  /** True when the whole game routes to the starter path (no bullpen exposure modeled). */
  allStarter: boolean;
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

/** Canonical v2 SHADOW output. */
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

  // ── PR6: corrected starter/bullpen joint PA-path (additive) ────────────────
  /** p_s — per-PA HR probability vs the starter (null when unmodeled). */
  starterHrPerPa: number | null;
  /** p_b — per-PA HR probability vs the bullpen (null when unmodeled). */
  bullpenHrPerPa: number | null;
  /** E[PA vs starter] under the joint path. */
  projectedStarterPA: number | null;
  /** E[PA vs bullpen] under the joint path. */
  projectedBullpenPA: number | null;
  /**
   * Corrected game HR probability from the JOINT (n_s, n_b) expectation:
   * 1 − Σ P(n_s,n_b)·(1−p_s)^{n_s}·(1−p_b)^{n_b}. This is the PR6 authority; the
   * legacy single-path `calibratedGameHrProbability` is retained as a diagnostic.
   */
  jointGameHrProbability: number | null;
  /** Calibrated joint game HR probability (identity passthrough until PR8). */
  calibratedJointGameHrProbability: number | null;

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
