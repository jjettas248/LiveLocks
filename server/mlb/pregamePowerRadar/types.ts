// ─────────────────────────────────────────────────────────────────────────────
// MLB Pre-Game Power Radar — canonical types
//
// Additive, MLB-only module that identifies *pre-game* hitter targets from
// today's confirmed lineups. It is a watchlist/target system — NOT a guaranteed
// pick engine and NOT an official-ROI play engine.
//
// Hard isolation rules (see CLAUDE.md §7 + module README intent):
//   • Does not mutate the live HR engine, probability math, bus, lifecycle, ROI.
//   • Never imports sport engine logic from NBA/NCAAB.
//   • Does NOT import hrConversionModel.ts — computePregameSeed /
//     computePregameHrFormBreakdown / PREGAME_SEED_CAP are reference-only.
//   • Reads upstream data from shared MLB data services/caches directly.
//   • Missing data degrades to capped/suppressed with a diagnostic — never
//     fabricated.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-game tiers. `fire` is intentionally absent — it is reserved for the live radar.
 * `power_watch` ("Batter Power Only") is a hitter with elite raw power but a weak/negative
 * pitcher matchup — surfaced as a watch candidate, never as an elite *setup*.
 */
export type PregamePowerTier =
  | "track"
  | "watch"
  | "power_watch"
  | "strong"
  | "elite"
  | "nuclear";

/** Markets the radar can tag. Phase 1 surfaces only home_runs + total_bases. */
export type PregamePowerMarket = "home_runs" | "total_bases" | "hits" | "rbi" | "hrr";

export type PregameLineupStatus = "posted" | "unposted";
export type PregameWeatherStatus = "confirmed" | "estimated" | "roof" | "unknown";
export type PregameGameStatus =
  | "scheduled"
  | "pre"
  | "live"
  | "final"
  | "postponed"
  | "delayed"
  | "suspended"
  | "unknown";
export type PregameSignalStatus = "active" | "locked" | "expired" | "graded";

/**
 * Local driver type. The shared `SignalDriver` (shared/signalDrivers.ts) is
 * intentionally NOT reused here because it has no `direction` field — the
 * pre-game public predicate needs to count positive drivers. We do not modify
 * the shared type; we adapt to it later if/when surfaced through the bus.
 */
export interface PowerDriver {
  key: string;
  label: string;
  direction: "positive" | "negative" | "neutral";
  /** Optional server-built evidence string. */
  evidence?: string;
  /** Optional 0-100 contribution weight for analytics/sorting. */
  weight?: number;
}

/**
 * Server-owned park / weather display contract. The UI renders these fields
 * verbatim — it must NOT infer carry direction from raw wind, nor expose raw
 * weather-modifier values on the compact card. All fields are nullable so a
 * card stays stable when data is missing.
 */
export interface PregameParkContext {
  venueName: string | null;
  temperatureF: number | null;
  windMph: number | null;
  /** Plain-English wind direction ("Out" / "In" / "Crosswind" / "Calm"). */
  windDirectionLabel: string | null;
  carryLabel:
    | "HR Carry"
    | "Carry Boost"
    | "Carry Suppressed"
    | "Neutral Air"
    | "Neutral Conditions"
    // Only when weather is genuinely unavailable — NOT a claim of neutral.
    | "Conditions Unavailable";
  carryType: "boost" | "suppress" | "neutral" | "unknown";
  /** Optional concise evidence string for the dominant park/weather effect. */
  driverText?: string | null;
}

/**
 * Player-specific park/wind fit display contract (PR2). DISPLAY ONLY — emitted by
 * the shared `parkWindFit` module via the pregame hydrator. Carries no numeric
 * model value (no fitMultiplier, no component scores): the card shows the wind
 * direction/speed, the shared emoji + qualitative label, and a short explanation,
 * and renders them verbatim. `score10` remains the only headline number.
 */
export interface PregamePlayerParkWindFit {
  /** Leading glyph from the shared helper (🌬️ / 🏟️ / ↔️ / ⚠️ / ❔). */
  emoji: string;
  /** Qualitative line, e.g. "Out to LF · favors RHH pull power". */
  label: string;
  /** Short human explanation / driver text. */
  explanation: string;
  /** Sector-aware wind direction for display ("Out to LF" / "Crosswind" / …). */
  windDirectionLabel: string | null;
  windSpeedMph: number | null;
  /** For styling/emoji selection only — never a numeric score. */
  classification: "boost" | "suppress" | "neutral" | "unknown";
  confidence: "high" | "medium" | "low" | "none";
}

/** Qualitative per-market setup for the compact card (numeric score is debug-only). */
export interface PregameMarketSetup {
  market: PregamePowerMarket;
  /** 0–10 setup score — shown only in expanded/detail/debug views. */
  setupScore: number;
  setupLabel: "Elite" | "Strong" | "Solid" | "Watch";
  isPrimary: boolean;
}

/** Future market-edge context — kept separate so sportsbook edge never blends into score10. */
export interface PregameMarketEdgeContext {
  line?: number;
  odds?: number;
  impliedProbability?: number;
  sportsbook?: string;
  oddsUpdatedAt?: string;
}

export interface PregamePowerDiagnostics {
  // Component sub-scores (all 0–10, null when not computed).
  batterPowerScore: number | null;
  /** Combined pitcher matchup (handedness + pitcher-allowed-by-slot when available). */
  pitcherVulnerabilityScore: number | null;
  /** Handedness sub-score (HR/9 + ERA vs the batter's hand). */
  pitcherHandednessScore: number | null;
  matchupFitScore: number | null;
  parkWeatherScore: number | null;
  lineupOpportunityScore: number | null;
  marketFitScore: number | null;
  /** Component 6 — retroactive near-HR contact form over the last 3 ET days. */
  nearHrRecentFormScore?: number | null;

  // ── Layer 1: pitcher vs the batter's lineup slot (allowed-by-slot) ───────────
  pitcherOrderSplitAvailable: boolean;
  pitcherOrderSplitScore: number | null;
  pitcherOrderSplitDirection: "vulnerable" | "neutral" | "suppressive" | "unavailable";

  // ── Batter's own production from today's lineup slot ─────────────────────────
  batterCurrentOrderSlot: number | null;
  batterOrderSplitAvailable: boolean;
  batterOrderSplitScore: number | null;
  batterOrderSplitDirection: "strong" | "neutral" | "weak" | "unavailable";

  // ── Layer 2: batter-vs-pitcher (BvP) — low/medium confidence, never the model ─
  bvpAvailable: boolean;
  /** Directional 0–10 BvP score (null when no usable sample). */
  bvpScore: number | null;
  /** BvP sample size (AB or PA, whichever is present). */
  bvpSampleSize: number | null;
  /**
   * BvP hits (numerator) — additive, read-only. Optional because durable
   * persistence/boot hydration can surface diagnostics snapshots written
   * before this field existed; readers must tolerate its absence.
   */
  bvpHits?: number | null;
  bvpDirection: "positive" | "neutral" | "negative";
  /** Key BvP production fields at .000 (AVG/SLG/OPS). */
  zeroProductionBvpFlags: string[];

  /** 0–1 coverage of critical inputs (fixed formula in scoring.ts). */
  dataCoverageScore: number;
  /** When a coverage cap was applied, the cap value. */
  finalScoreCap?: number;
  /** Weighted composite + BvP modifier, BEFORE coverage caps and matchup penalty. */
  finalScoreBeforeCaps: number;
  /** Final published score, AFTER coverage caps and the matchup penalty. */
  finalScoreAfterCaps: number;
  /** Visible matchup penalty applied for weak/negative pitcher matchup or BvP. */
  matchupPenalty: number;
  /** The gated public tier (mirrors signal.tier). */
  publicTier: PregamePowerTier;
  /** Human-readable downgrade tags ("Matchup Downgrade", "Poor BvP History", …). */
  warningTags: string[];
  /** Machine-readable downgrade reasons (one per applied penalty source). */
  downgradeReasons: string[];

  suppressed: boolean;
  suppressedReasons: string[];

  sourceFreshness: {
    lineupUpdatedAt?: string | null;
    weatherUpdatedAt?: string | null;
    batterStatsUpdatedAt?: string | null;
    pitcherStatsUpdatedAt?: string | null;
  };

  rawInputsAvailable: {
    lineup: boolean;
    batterPower: boolean;
    pitcherProfile: boolean;
    park: boolean;
    weather: boolean;
    bvp: boolean;
    nearHrRecentForm?: boolean;
  };
}

export interface PregamePowerSignal {
  signalId: string; // `mlb-pregame:${sessionDate}:${gameId}:${batterId}` — stable across rebuilds
  sport: "mlb";
  engine: "pregame_power_radar";

  sessionDate: string; // slateDateET() — slate day (6am-ET rollover), matches build stamping
  gameId: string;
  gameDate: string;
  startsAt: string | null;
  generatedAt: string;
  buildId: string;

  batterId: string;
  batterName: string;
  team: string;
  opponent: string;

  pitcherId: string | null;
  pitcherName: string | null;

  battingOrderSlot: number | null;
  handednessMatchup: string | null; // e.g. "L vs R"

  primaryMarket: PregamePowerMarket;
  marketTags: PregamePowerMarket[];
  marketScores: Partial<Record<PregamePowerMarket, number>>;
  /** Qualitative per-market setup labels (Elite/Strong/Solid/Watch) for the card. */
  marketSetups: PregameMarketSetup[];
  /**
   * Server-owned park/weather display contract (UI renders verbatim). `null`
   * means the context is genuinely unknown (e.g. the DB-fallback path, where
   * park/weather is not persisted) — the UI shows "Park context unavailable"
   * rather than fabricating neutral conditions.
   */
  parkContext: PregameParkContext | null;

  /**
   * Player-specific park/wind fit — DISPLAY/EXPLAINABILITY ONLY. Hydrated at
   * build/API time from the shared `parkWindFit` module using the batter's hand +
   * pull profile + the game's wind sector. It NEVER feeds `score10` or any scoring
   * component; the UI renders these fields verbatim and must not recompute the
   * fit. Optional: the DB-fallback (rehydrated) path omits it → the card falls
   * back to a safe "park/wind unavailable" line rather than fabricating context.
   */
  playerParkWindFit?: PregamePlayerParkWindFit | null;

  score10: number;
  tier: PregamePowerTier;

  drivers: PowerDriver[];
  warnings: string[];
  tags: string[];

  lineupStatus: PregameLineupStatus;
  weatherStatus: PregameWeatherStatus;
  gameStatus: PregameGameStatus;
  firstPitchLockEligible: boolean;
  lockedAt: string | null;

  hasMarketLine: boolean;
  isOfficialPlay: false;
  isPregameTarget: true;
  marketEdgeContext?: PregameMarketEdgeContext;

  status: PregameSignalStatus;
  suppressed: boolean;
  suppressedReasons: string[];

  // Outcome / live-bridge fields — wired now, populated in Phase 4/5.
  outcomes?: PregameOutcome | null;
  /**
   * Frozen once true, OR'd forward across same-slate rebuilds by
   * `carryForwardGradedState`. True the instant `wasPubliclyFlaggedPregame`
   * ever evaluates true for this signalId within the current slate. Grading
   * and the public/admin stat builders read THIS field instead of
   * re-deriving the live (mutable-field) predicate, so a later dip in
   * dataCoverageScore/tier/etc. can never erase an earlier "was publicly
   * flagged" status.
   */
  everPubliclyFlagged: boolean;
  becameLiveReady: boolean;
  becameLiveFire: boolean;
  convertedLiveAt: string | null;

  diagnostics: PregamePowerDiagnostics;
}

export interface PregameOutcome {
  hitHr?: boolean;
  totalBases?: number | null;
  hitRecorded?: boolean;
  rbiRecorded?: number | null;
  resolvedAt?: string;
  // ── Win Attribution (Pregame Radar Win Attribution) ────────────────────────
  // A target who homers is a `pregame_win`; one who does not is a
  // `calibration_miss` (stored internally only, never a public loss).
  outcome?: import("../../../shared/pregameRadarWin").PregameOutcomeType;
  // True only for a publicly-flagged win — gates the public daily cashed log.
  userVisible?: boolean;
  // HR event detail (best-effort; null when the source feed lacked it).
  hrInning?: number | null;
  hrHalf?: "top" | "bottom" | null;
  // 1-based plate-appearance number of the HR within the player's game ABs.
  plateAppearanceNumber?: number | null;
  // True when the HR came in the player's first plate appearance, false when
  // it's confirmed NOT the first (AB-sequencing data was present either way),
  // "unknown" when AB-sequencing data was unavailable — never silently
  // defaulted to false when the answer isn't actually known.
  firstAbPregameWin?: true | false | "unknown";
}

/** Per-component scorer result. All scores are on a 0–10 scale. */
export interface ComponentScore {
  score10: number;
  available: boolean;
  drivers: PowerDriver[];
  warnings: string[];
}

/** Build response contract returned by the public + admin endpoints. */
export interface PregamePowerRadarResponse {
  date: string;
  buildId: string;
  generatedAt: string;
  source: "memory" | "rebuilt" | "db_fallback";
  gamesScanned: number;
  signals: PregamePowerSignal[];
  diagnostics: {
    lineupCoverage: number;
    weatherCoverage: number;
    batterCoverage: number;
    pitcherCoverage: number;
    totalBattersEvaluated: number;
    publicSignals: number;
    suppressedSignals: number;
    topSuppressionReasons: Array<{ reason: string; count: number }>;
  };
}
