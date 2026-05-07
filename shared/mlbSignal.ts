export interface MLBSignal {
  playerId: string;
  playerName: string;
  gameId: string;
  market: string;
  sportsbook: string | null;

  bookLine: number | null;
  projection: number | null;
  enginePct: number;
  // Paired calibrated probabilities from the engine raw output. Sum ≈ 100.
  // Used by the canonical resolver so both surfaces (box score badge +
  // calculator panel) render the SAME numbers for the same player+market+line.
  calibratedProbabilityOver?: number | null;
  calibratedProbabilityUnder?: number | null;
  edge: number | null;
  evPct: number | null;
  recommendedSide: string;
  signalScore: number;
  confidenceTier: string;
  // [MLB Canonical Signal Tier — Phase 2]
  // Server-authoritative lowercase 4-state tier ("watch" | "lean" | "strong" |
  // "elite"). Derived from confidenceTier via deriveSignalTier() in the
  // orchestrator so every consumer (LiveBoard buckets, MlbSignalCard badge,
  // mlb-live filters, topPlaysService, analytics) renders the SAME tier.
  // Optional during the rollout window; clients fall back to a local mapper
  // and emit [MLB_TIER_FALLBACK] when missing.
  signalTier?: "watch" | "lean" | "strong" | "elite";

  // ── MLB Canonical Display Contract ─────────────────────────────────────
  // Server-owned display fields. Every MLB UI surface (Top Opportunities,
  // SignalCard, LiveBoard, calculator) MUST render these verbatim and is
  // PROHIBITED from re-deriving them from signalScore/enginePct/probability.
  //
  //   displaySide          = recommended side (mirror of recommendedSide,
  //                          but typed and never NO_EDGE — falls back to
  //                          OVER when engine returns NO_EDGE)
  //   displayProbability   = post-cap, post-calibration probability for
  //                          displaySide (= overProbability when
  //                          displaySide=OVER, else underProbability)
  //   overProbability      = final OVER probability after all Phase 1.5 caps
  //   underProbability     = final UNDER probability after all Phase 1.5 caps
  //   displayGrade         = "A+"|"A"|"B+"|"B"|"B-"|"Watch" derived from
  //                          (signalTier × signalScore) per the contract
  //                          spec. NEVER from liveScore or raw probability.
  //   isBettable           = displayProbability >= 50 AND signalTier != "watch"
  //   isWatchOnly          = !isBettable OR signalTier == "watch"
  //   displayDrivers       = up to 3 short driver labels for the badge row
  displaySide?: "OVER" | "UNDER";
  displayProbability?: number;
  overProbability?: number;
  underProbability?: number;
  displayGrade?: "A+" | "A" | "B+" | "B" | "B-" | "Watch";
  isBettable?: boolean;
  isWatchOnly?: boolean;
  displayDrivers?: string[];

  // ── Phase 5 — Signal Explainability Engine ────────────────────────────
  // Server-built canonical driver envelope. Optional during rollout —
  // clients should prefer `canonicalDrivers` + `triggerSummary` over
  // legacy `displayDrivers` / `reasons` when present, but never fabricate.
  canonicalDrivers?: import("./signalDrivers").SignalDriver[];
  triggerSummary?: string | null;

  awayAbbr: string | null;
  homeAbbr: string | null;
  gameStatus: string | null;
  inning: number;
  isTopInning: boolean;
  homeScore: number;
  awayScore: number;

  alreadyHit: boolean;
  actionable: boolean;
  stale: boolean;
  watchlist: boolean;
  isEarlySignal: boolean;
  isDegraded: boolean;
  fallbackUsed: boolean;

  // MLB Signals audit P2/P3 — non-HR engine state machine + decay rail.
  // Engine-as-truth: UI strictly renders these fields. HR markets continue
  // to use the dedicated `hrAlert` snapshot below.
  engineState?: "BUILDING" | "ACTIVE" | "COOLING" | "CLOSED";
  engineStateChangedAt?: number; // ms epoch of last state transition
  engineStatePeakScore?: number;
  decayFactor?: number;          // 0..1 multiplier of the displayed signalScore

  overOdds: number | null;
  underOdds: number | null;
  bookImplied: number | null;
  oddsTimestamp: number | null;

  signalTags: string[];
  feedTags: string[];
  badges: string[];
  riskFlags: string[];
  playerGlowEligible: boolean;
  formIndicator: string | null;

  reasons: string[];
  explanationBullets: string[];
  drivers: Record<string, number>;

  currentStats: {
    ab?: number;
    h?: number;
    hr?: number;
    tb?: number;
    bb?: number;
    rbi?: number;
    k?: number;
    sb?: number;
    r?: number;
  } | null;
  currentStat: number;
  completedAB: number;
  lastABContact: {
    exitVelo: number | null;
    launchAngle: number | null;
    outcome: string | null;
  } | null;
  priorABResults: Array<{
    outcome: string;
    exitVelocity: number | null;
    launchAngle: number | null;
    pitchType: string | null;
    pitchSpeed: number | null;
  }>;

  pitcherName: string | null;
  pitcherHand: string | null;
  pitcherPitchCount: number | null;
  pitcherTimesThrough: number | null;
  pitchMix: Array<{
    pitchType: string;
    pitchName?: string;
    percentage: number;
    avgVelocity: number | null;
  }> | null;

  batterArchetype: string | null;
  pitcherArchetype: string | null;
  thesis: string | null;
  matchupTag: string | null;
  bvp: {
    atBats: number;
    hits: number;
    avg: number | null;
    homeRuns: number;
    strikeouts: number;
  } | null;

  isFlagship: boolean;
  familyPenaltyFactor: number | null;
  safetyCeilingApplied: boolean;
  dataQuality: string | null;
  signalTimestamp: number;
  mode: "watch" | "heating_up" | "lean" | "strong" | "elite" | "hr_watch" | "hr_heating_up" | "hr_strong" | "hr_elite" | null;
  hrFactors: Record<string, any> | null;
  hrBuildScore: number | null;
  hrIntensity: "weak" | "watch" | "strong" | "imminent" | null;
  rollingForm: Record<string, any> | null;

  hrAlert?: {
    currentState: "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED";
    hrReadinessScore: number;
    hrConversionProbabilityRaw: number;
    hrConversionProbabilityCalibrated: number;
    remainingPAExpectation: number;
    positiveDrivers: string[];
    negativeSuppressors: string[];
    cooldownReason: string | null;
    lastStateChangeAt: number;
    dataFreshnessMs: number;
    peakScore: number;
    peakState: "WATCH" | "PREPARE" | "BET_NOW" | "COOLED_OFF" | "CLOSED";
    peakAt: number;
    detectedInning: number | null;
    currentInning: number;
    pitcherHrVulnerability: number;
    decayFactor: number;
    tickCount: number;
    lastRecomputeAt: number;
  } | null;

  pitcherAnalysis?: {
    stuff: number;
    command: number;
    swingMiss: number;
    fatigue: number;
    contactSuppression: number;
    matchup: number;
    context: number;
  } | null;
  pitcherSignals?: string[] | null;

  opportunityScore: number;
  liveScore: number;
  eventBoost: number;

  smartTags: string[];
  primaryReason: string;
  pitchMatchupRatings: Record<string, PitchMatchupRating> | null;

  // Phase C: Diagnostics envelope — optional because legacy cached signals
  // pre-date this field. Surfaces existing engine internals (featureScores,
  // scoreBreakdown subscores, BvP/WeatherPark/Handedness snapshots) and
  // the readable driver lines without any recomputation. UI consumers should
  // prefer `diagnostics.readableDrivers` over `reasons` when present.
  diagnostics?: import("./mlbCanonicalSignal").MlbSignalDiagnostics;
}

export interface PitchMatchupRating {
  rating: "strong" | "neutral" | "weak";
  favor: "batter" | "pitcher" | "neutral";
  score: number;
}
