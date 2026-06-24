/**
 * MLB HR Radar — canonical section / lifecycle / outcome helpers.
 *
 * SAFE ADDITIVE module. Pure functions only. Never mutates DB rows, never
 * replaces existing canonical fields (`gradingStatus`, `currentStage`,
 * `userStage`, `signalState`, `confidenceTier`). Produces the spec's
 * canonical models in parallel so callers can serialize them onto the wire
 * without touching the DB schema.
 *
 * Spec (TASK: MASTER FIX — MLB HR Radar) requires:
 *   - lifecycleState: pregame|watch|build|ready|attack|cashed|missed
 *                    |late_signal|uncalled_hr|inactive
 *   - section:        attack|ready|build|watch|cashed|missed
 *                    |diagnostic|inactive
 *   - outcomeStatus:  active|called_hit|called_miss|uncalled_hr
 *                    |late_signal|unresolved
 *
 * Existing system models (do not rename — these stay authoritative):
 *   - gradingStatus (DB):     active|called_hit|called_miss|uncalled_hr|late_signal
 *   - canonicalStage (engine): attack|building|watch|cooling|closed
 *   - userStage (Goldmaster v1): track|build|ready|fire|resolved
 *   - section (ladder):       attackNow|building|watch|cashed|dead|ready
 *   - status (DB row):        live|hit|miss
 */

import { getHrRadarOutcomeStamp } from "./hrRadarOutcomeStamp";

/**
 * Display/section lifecycle state — the presentation layer's view of an HR
 * Radar card's current state. This is DISTINCT from hrRadarStateMachine.ts's
 * HrRadarLifecycleState (which uses "fire"/"model_review"/"expired" and drives
 * the pure FSM). These two types exist at different layers and must NOT be
 * conflated: the FSM type drives transitions; this type drives section placement.
 */
export type HrRadarSectionState =
  | "pregame"
  | "watch"
  | "build"
  | "ready"
  | "attack"
  | "cashed"
  | "missed"
  | "late_signal"
  | "uncalled_hr"
  | "inactive";

export type HrRadarSection =
  | "attack"
  | "ready"
  | "build"
  | "watch"
  | "cashed"
  | "missed"
  | "diagnostic"
  | "inactive";

export type HrRadarOutcomeStatus =
  | "active"
  | "called_hit"
  // Tiered cashed statuses (Phase 1) — additive. All semantically equivalent
  // to `called_hit` for routing/grading purposes; the suffix preserves the
  // highest pre-HR engine state so the UI can show "Cashed from <Tier>".
  // Existing `called_hit` rows remain valid and are treated as legacy/untiered.
  | "called_hit_attack"
  | "called_hit_ready"
  | "called_hit_build"
  | "called_hit_watch"
  // Near-HR credit (2026-06) — an HR-Max-Window pick whose batter squared up a
  // genuine near-HR (barrel / warning-track / elite EV detected by
  // nearHrContact.ts) but the ball stayed in the yard. Treated as a hit-class
  // outcome (counts as a win, routes to `cashed`) so the radar is graded on
  // "called the danger" rather than the binary coin-flip of HR/no-HR.
  | "called_near_hr"
  | "called_miss"
  | "uncalled_hr"
  | "late_signal"
  // Phase 2 — first-AB / no-live-sample HRs are NOT normal misses. Tracked
  // separately so they don't pollute the user-facing dead/missed buckets.
  | "early_hr_insufficient_sample"
  | "unresolved";

/**
 * Phase 1 helper — set of all "called hit" outcome statuses (legacy + tiered).
 * Use anywhere a check for "this row is cashed" is needed.
 */
export const CALLED_HIT_OUTCOME_STATUSES: ReadonlySet<HrRadarOutcomeStatus> = new Set<HrRadarOutcomeStatus>([
  "called_hit",
  "called_hit_attack",
  "called_hit_ready",
  "called_hit_build",
  "called_hit_watch",
  "called_near_hr",
]);

/**
 * Phase 1 helper — UI label for a cashed row's pre-HR tier. Returns null for
 * the legacy untiered `called_hit` so callers can render plain "Cashed".
 */
export function getCashedFromTierLabel(
  status: HrRadarOutcomeStatus | string | null | undefined,
): "Attack" | "Ready" | "Build" | "Watch" | "Near-HR" | null {
  switch (status) {
    case "called_hit_attack": return "Attack";
    case "called_hit_ready": return "Ready";
    case "called_hit_build": return "Build";
    case "called_hit_watch": return "Watch";
    case "called_near_hr": return "Near-HR";
    default: return null;
  }
}

/**
 * Phase 1 helper — given a matched pre-HR alert's persisted tier fields,
 * return the tiered called_hit status to write to `gradingStatus`. The
 * mapping is monotonic (never "downgrades" the alert's recorded tier):
 *
 *   alertTier === "officialAlert"            → called_hit_attack
 *   alertTier === "prepare" + strong signal  → called_hit_ready
 *   alertTier === "prepare"                  → called_hit_build
 *   alertTier === "watch"                    → called_hit_watch
 *   else (legacy/missing alertTier):
 *     confidenceTier === "strong" / sig "actionable" → called_hit_ready
 *     confidenceTier === "building" / sig "live"     → called_hit_build
 *     default                                        → called_hit_watch
 *
 * Returns plain `called_hit` only if all tier fields are missing — pure
 * safety fallback so legacy data paths don't lose grading.
 */
export function inferCashedFromTierStatus(args: {
  alertTier?: string | null;
  confidenceTier?: string | null;
  signalState?: string | null;
}): "called_hit_attack" | "called_hit_ready" | "called_hit_build" | "called_hit_watch" | "called_hit" {
  const tier = norm(args.alertTier);
  const conf = norm(args.confidenceTier);
  const sig = norm(args.signalState);
  const strongSignal = conf === "strong" || sig === "actionable";

  if (tier === "officialalert") return "called_hit_attack";
  if (tier === "prepare") return strongSignal ? "called_hit_ready" : "called_hit_build";
  if (tier === "watch") return "called_hit_watch";

  // Legacy / missing alertTier — fall back to confidenceTier + signalState.
  if (strongSignal) return "called_hit_ready";
  if (conf === "building" || sig === "live") return "called_hit_build";
  if (conf === "monitor") return "called_hit_watch";

  // Truly nothing usable — keep legacy untiered status so old behavior holds.
  return "called_hit";
}

/**
 * Phase 1 (3-tier ladder) — did this alert ever reach the **HR Max Window**,
 * the single actionable top tier? Per the approved roadmap
 * (docs/HR_RADAR_AUDIT_2026-06.md §2.1) the user-facing ladder collapses to
 * three tiers — Watch → Building → HR Max Window — and **only the HR Max
 * Window tier is graded as a pick.** Watch/Building are ambient context and
 * must never produce a counted `called_miss` (or a counted cash).
 *
 * "HR Max Window" maps onto the engine's existing actionable markers:
 *   - alertTier      === "officialAlert" / "official_alert"
 *   - confidenceTier === "strong" | "elite"
 *   - signalState    === "actionable" | "fire"
 *
 * Everything below that (alertTier prepare/watch, confidenceTier
 * monitor/building, signalState live/watching, presence-only rows) is the
 * Watch/Building band and is NOT graded. Pure — no I/O.
 */
export function reachedHrMaxWindow(args: {
  alertTier?: string | null;
  confidenceTier?: string | null;
  signalState?: string | null;
}): boolean {
  const tier = norm(args.alertTier);
  const sig = norm(args.signalState);
  // Hit-rate tightening (2026-06): the HR Max Window is the **committed fire
  // tier only**. Previously a bare `confidenceTier === "strong" | "elite"`
  // also qualified, so hundreds of merely-"strong" rows that never actually
  // fired were graded as counted picks — inflating the miss wall (269/6).
  // A signal is only a graded pick when the engine actually committed it:
  // `alertTier === officialAlert` OR `signalState ∈ {actionable, fire}`.
  // confidenceTier is intentionally NO LONGER a qualifier on its own.
  return (
    tier === "officialalert" || tier === "official_alert" ||
    sig === "actionable" || sig === "fire"
  );
}

/**
 * Fix A (decay-out-of-window grading) — did this alert **ever peak** into the
 * HR Max Window during the game, even if it has since cooled below it?
 *
 * `reachedHrMaxWindow` above reads the CURRENT (possibly decayed) tier, so an
 * HR that legitimately reached the top tier earlier and then cooled before the
 * ball left the yard would be erased to `uncalled_hr`. This peak-aware
 * companion lets the HR-HIT grading path honor the prior in-window call.
 *
 * Source-of-truth signal is the engine's `peakState` (dynamic state machine):
 * `BET_NOW` is the top-conviction state. We additionally require the peak
 * calibrated conversion probability to clear `HR_CONVERSION_OFFICIAL_MIN`
 * (0.12) as a floor guard, because the dynamic `BET_NOW` state can briefly
 * diverge from the PATH evaluator's `alertTier`; the floor prevents
 * over-counting borderline signals that only grazed the window.
 *
 * IMPORTANT: this is intended ONLY for the HR-HIT (`cashed`/`uncalled_hr`)
 * decision. It must NOT widen `resolveFinalNoHrGrading` — a no-HR alert that
 * merely peaked must still expire, never become a counted `called_miss`. Pure.
 */
const HR_MAX_WINDOW_PEAK_CONV_FLOOR = 0.12;

export function reachedHrMaxWindowPeak(args: {
  peakState?: string | null;
  peakConversionProbability?: number | null;
}): boolean {
  const peak = norm(args.peakState);
  const conv = typeof args.peakConversionProbability === "number"
    ? args.peakConversionProbability
    : 0;
  return peak === "bet_now" && conv >= HR_MAX_WINDOW_PEAK_CONV_FLOOR;
}

// ── FIRE-only official grading (2026-06 false-call reduction) ───────────────
// `reachedHrMaxWindow` marks the gradeable Attack tier, but the alert-path
// engine can surface a row as `officialAlert` (Attack) while the *dynamic*
// conviction track never crossed into BET_NOW — that row is only user-stage
// READY (high-watch), NOT a committed FIRE call. Per the FIRE-only record
// contract, only a row that reached user-stage FIRE may resolve as a counted
// `called_miss`. This predicate is the persisted-data FIRE proxy used at
// game-final reconciliation.
//
// A row reached FIRE commitment when EITHER:
//   1. it took the engine's fast-fire path (alertPath === FAST_PROMOTE_ELITE,
//      the sole PATH_PROMOTES_TO_FIRE), OR
//   2. its peak calibrated HR-conversion probability crossed the BET_NOW band
//      (>= FIRE_BET_NOW_CONV_THRESHOLD). BET_NOW is the dynamic state machine's
//      top conviction and the gate behind user-stage fire; its calibrated
//      entry threshold is ~14%. peakConversionProbability is persisted on the
//      alert's diagnosticsSnapshot.scoreContract, so this is read-only at grade
//      time — no new write path, no schema change.
//
// Pure. Conservative on missing data: an unknown peak conversion (null) scores
// 0 and only the FAST_PROMOTE_ELITE path can still qualify, so a row with no
// FIRE evidence is never counted as an official miss.
export const FIRE_BET_NOW_CONV_THRESHOLD = 0.14;

export function reachedFireCommitment(args: {
  alertPath?: string | null;
  peakConversionProbability?: number | null;
}): boolean {
  if (norm(args.alertPath) === "fast_promote_elite") return true;
  const conv = typeof args.peakConversionProbability === "number"
    ? args.peakConversionProbability
    : 0;
  return conv >= FIRE_BET_NOW_CONV_THRESHOLD;
}

/**
 * Phase 1 — given a still-active alert at game-final with NO home run, decide
 * the honest terminal grade. Only HR-Max-Window alerts become a counted
 * `called_miss`; sub-actionable Watch/Building rows become `expired` (which
 * `deriveHrRadarOutcomeStatus` maps to "unresolved" — excluded from the
 * missed bucket, the W/L ledger, and the user-facing MISSED section). Pure.
 */
export function resolveFinalNoHrGrading(args: {
  alertTier?: string | null;
  confidenceTier?: string | null;
  signalState?: string | null;
}): "called_miss" | "expired" {
  return reachedHrMaxWindow(args) ? "called_miss" : "expired";
}

/**
 * Near-HR credit (2026-06) — peak batted-ball contact a player produced while
 * an HR-Max-Window signal was active. Stored on the alert's `contactSnapshot`
 * jsonb column (no migration) and consulted at game-final reconciliation so a
 * squared-up "almost HR" is credited instead of counted as a hard miss.
 *
 * All fields optional / nullable so absent data is a clean no-op (no credit),
 * never a crash. Mirrors the inputs `nearHrContact.ts` already evaluates.
 */
export interface HrRadarPeakContact {
  peakEv?: number | null;
  peakLaunchAngle?: number | null;
  peakDistance?: number | null;
  isBarrel?: boolean | null;
  /** Best `NearHrTier` the engine assigned across the window ("lean" | "watch"). */
  nearHrTier?: string | null;
  // Committed-window scoping (2026-06) — the inning/half this contact occurred,
  // so near-HR credit can be limited to contact AT OR AFTER the signal was
  // committed. Optional/nullable so absent timing is handled explicitly
  // (see isContactInCommittedWindow).
  inning?: number | null;
  half?: string | null;
}

/** Half ordering within an inning: top precedes bottom; unknown sorts last. */
function halfOrdinal(h: string | null | undefined): number {
  const n = norm(h);
  if (n === "top" || n === "t") return 0;
  if (n === "bottom" || n === "b") return 1;
  return 2;
}

/**
 * Committed-window scoping (2026-06) — is this contact AT OR AFTER the moment
 * the signal was committed (its `signalInning`/`signalHalf`)? Near-HR credit
 * must only count contact from the committed window, otherwise a barrel from an
 * earlier watch/build phase could inflate a later no-HR official pick into a
 * `called_near_hr` (Codex review #25). Pure.
 *
 * Null handling is deliberate:
 *   - signal inning unknown  → cannot scope; return true (preserve prior
 *     behavior rather than silently drop all credit).
 *   - signal inning known but contact inning unknown → return false (we cannot
 *     prove the contact happened in-window, so we do not credit it).
 */
export function isContactInCommittedWindow(
  contact: { inning?: number | null; half?: string | null } | null | undefined,
  signal: { signalInning?: number | null; signalHalf?: string | null },
): boolean {
  const sigInn = typeof signal.signalInning === "number" && Number.isFinite(signal.signalInning)
    ? signal.signalInning
    : null;
  if (sigInn == null) return true; // no committed-window timing — cannot scope
  if (!contact) return false;
  const cInn = typeof contact.inning === "number" && Number.isFinite(contact.inning)
    ? contact.inning
    : null;
  if (cInn == null) return false; // signal time known, contact time unknown → not provable
  if (cInn > sigInn) return true;
  if (cInn < sigInn) return false;
  return halfOrdinal(contact.half) >= halfOrdinal(signal.signalHalf);
}

// Credit thresholds — a near-HR is a genuinely squared-up ball that stayed in
// the yard. Kept deliberately strict so credit reflects real HR-shaped contact,
// not any hard-hit ball. Tunable in one place.
const NEAR_HR_CREDIT_MIN_DISTANCE = 380; // ft — warning-track / wall-scraper
const NEAR_HR_CREDIT_MIN_EV = 104;       // mph — elite exit velocity
const NEAR_HR_CREDIT_LA_LOW = 20;        // ° — HR launch-angle band (lower)
const NEAR_HR_CREDIT_LA_HIGH = 35;       // ° — HR launch-angle band (upper)

/**
 * Does this peak contact qualify a no-HR HR-Max-Window pick for `called_near_hr`
 * credit? Pure. Credit when ANY of:
 *   - Statcast barrel flag, OR
 *   - the engine's near-HR detector already tagged a "lean" (its top tier), OR
 *   - peak distance ≥ 380 ft, OR
 *   - peak EV ≥ 104 mph within the 20–35° HR launch-angle band.
 */
export function qualifiesForNearHrCredit(contact: HrRadarPeakContact | null | undefined): boolean {
  if (!contact) return false;
  if (contact.isBarrel === true) return true;
  if (norm(contact.nearHrTier) === "lean") return true;
  const dist = typeof contact.peakDistance === "number" ? contact.peakDistance : null;
  if (dist != null && dist >= NEAR_HR_CREDIT_MIN_DISTANCE) return true;
  const ev = typeof contact.peakEv === "number" ? contact.peakEv : null;
  const la = typeof contact.peakLaunchAngle === "number" ? contact.peakLaunchAngle : null;
  if (ev != null && ev >= NEAR_HR_CREDIT_MIN_EV && la != null && la >= NEAR_HR_CREDIT_LA_LOW && la <= NEAR_HR_CREDIT_LA_HIGH) {
    return true;
  }
  return false;
}

/**
 * Best-effort coercion of any HR Radar row/entry shape into the canonical
 * lifecycle / section / outcome model. Reads existing fields produced by the
 * ladder builder, board enricher, and legacy serializer — never invents
 * truth, only normalizes labels.
 *
 * Inputs are intentionally permissive (`Record<string, any>` style) so this
 * works on rows from getHrRadarLadder, getTodayHrRadarBoard, /api/mlb/hr-radar,
 * and raw hr_radar_alerts DB rows alike.
 */
export interface CanonicalCardInput {
  // Identity (used for outcome-stamp lookup; optional so legacy callers
  // that only carried outcome/status fields keep working).
  gameId?: string | number | null;
  playerId?: string | number | null;
  // Outcome / status side
  gradingStatus?: string | null;        // DB
  outcome?: string | null;              // wire (pending|called_hit|miss|uncalled_hr|...)
  outcomeStatus?: string | null;        // already-canonical from a prior pass
  status?: string | null;               // DB row.status (live|hit|miss)
  hr?: number | null;                   // box score HR count (if joined)
  hrCount?: number | null;              // alt name some serializers use
  hitInning?: number | null;            // resolved-side timestamps
  resolvedAt?: string | Date | null;
  // Lifecycle / stage side
  lifecycleState?: string | null;       // already-canonical (re-entry safe)
  currentStage?: string | null;         // ladder wire (attack|building|watch|cooling|closed)
  canonicalStage?: string | null;       // engine canonical
  userStage?: string | null;            // Goldmaster v1 (track|build|ready|fire|resolved)
  section?: string | null;              // ladder section if already set (attackNow|building|watch|cashed|dead|ready)
  signalState?: string | null;          // DB (live|watching|actionable)
  confidenceTier?: string | null;       // DB (monitor|building|strong)
  // Live-context side (used only for pregame inference)
  hasLiveABContext?: boolean | null;
  plateAppearancesTracked?: number | null;
  gameStatus?: string | null;           // pregame|live|final|...
  isGameFinal?: boolean | null;         // route-stamped final flag (authoritative)
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/**
 * Derive the canonical outcomeStatus from any shape of input row. Pure.
 *
 * Priority (resolved truth wins):
 *   1) explicit outcomeStatus already canonical
 *   2) gradingStatus (DB authoritative)
 *   3) wire `outcome` field
 *   4) status === "hit" → called_hit ; status === "miss" → called_miss
 *   5) hrCount/hr > 0 with no detection lineage → uncalled_hr
 *   6) default "active" (live row) or "unresolved" if nothing useful
 */
export function deriveHrRadarOutcomeStatus(card: CanonicalCardInput): HrRadarOutcomeStatus {
  const explicit = norm(card.outcomeStatus);
  if (
    explicit === "called_hit" ||
    explicit === "called_hit_attack" ||
    explicit === "called_hit_ready" ||
    explicit === "called_hit_build" ||
    explicit === "called_hit_watch" ||
    explicit === "called_near_hr" ||
    explicit === "called_miss" ||
    explicit === "uncalled_hr" ||
    explicit === "late_signal" ||
    explicit === "early_hr_insufficient_sample" ||
    explicit === "active" ||
    explicit === "unresolved"
  ) return explicit as HrRadarOutcomeStatus;

  const grading = norm(card.gradingStatus);
  if (grading === "called_hit") return "called_hit";
  if (grading === "called_hit_attack") return "called_hit_attack";
  if (grading === "called_hit_ready") return "called_hit_ready";
  if (grading === "called_hit_build") return "called_hit_build";
  if (grading === "called_hit_watch") return "called_hit_watch";
  if (grading === "called_near_hr") return "called_near_hr";
  if (grading === "called_miss") return "called_miss";
  if (grading === "uncalled_hr") return "uncalled_hr";
  if (grading === "late_signal") return "late_signal";
  if (grading === "early_hr_insufficient_sample") return "early_hr_insufficient_sample";
  // Phase 2 — both `early_hr_no_window` (matcher-side first-inning HR with no
  // events) and the legacy `early_window_hr` token now normalize to the
  // user-facing `early_hr_insufficient_sample` bucket so analytics rollups,
  // canonical sections, and outcome labels stay in parity across endpoints.
  if (grading === "early_hr_no_window") return "early_hr_insufficient_sample";
  if (grading === "early_window_hr") return "early_hr_insufficient_sample";
  // `expired` is "signal was active but the AB window ran out without an HR
  // and the play feed never produced a definitive miss" — it is genuinely
  // unresolved, not a called_miss.
  if (grading === "expired") return "unresolved";
  if (grading === "active") return "active";

  const outcomeWire = norm(card.outcome);
  if (outcomeWire === "called_hit") return "called_hit";
  if (outcomeWire === "miss") return "called_miss";
  if (outcomeWire === "uncalled_hr") return "uncalled_hr";
  if (outcomeWire === "late_signal") return "late_signal";
  if (outcomeWire === "early_window_hr") return "early_hr_insufficient_sample"; // first-inning HR with no window

  const statusWire = norm(card.status);
  if (statusWire === "hit") return "called_hit";
  if (statusWire === "miss") return "called_miss";
  if (statusWire === "live") return "active";

  const hrCount = Number(card.hrCount ?? card.hr ?? 0);
  if (hrCount > 0) return "uncalled_hr";

  // ── HR Radar Lifecycle Repair Fix #2 — stamp lookup ──────────────────────
  // The orchestrator stamps `${gameId}_${playerId}` with a tiered called_hit
  // status the moment a HR is observed (closeHrAlertOnHit pathway). Consult
  // that stamp BEFORE returning "unresolved" so the cashed bucket populates
  // even before the DB grading row has been written / boxscore has caught up.
  if (card.gameId != null && card.playerId != null) {
    const stamp = getHrRadarOutcomeStamp(card.gameId, card.playerId);
    if (stamp) return stamp.outcomeStatus;
  }

  return "unresolved";
}

/**
 * Derive the canonical lifecycleState from any shape of input row. Pure.
 *
 * Priority:
 *   1) resolved outcomes win (cashed/missed/late_signal/uncalled_hr)
 *   2) currentStage / canonicalStage (live row)
 *   3) userStage (Goldmaster v1)
 *   4) section if already set
 *   5) confidenceTier/signalState legacy fallback
 *   6) default pregame if no live context, else watch
 */
export function deriveHrRadarLifecycleState(card: CanonicalCardInput): HrRadarSectionState {
  const outcome = deriveHrRadarOutcomeStatus(card);
  if (CALLED_HIT_OUTCOME_STATUSES.has(outcome)) return "cashed";
  if (outcome === "called_miss") return "missed";
  if (outcome === "uncalled_hr") return "uncalled_hr";
  if (outcome === "late_signal") return "late_signal";
  // Phase 2 — early-HR-insufficient-sample cards are terminal-but-not-missed.
  // Map to `inactive` so they're hidden from active sections but don't poison
  // the missed/diagnostic buckets either. UI mappers can re-route as needed.
  if (outcome === "early_hr_insufficient_sample") return "inactive";

  // Box-score fallback safety: any row carrying a positive HR count is
  // resolved even if outcomeStatus was not yet persisted (catches the
  // play-feed-miss → box-score-fallback race).
  const hrCount = Number(card.hrCount ?? card.hr ?? 0);
  if (hrCount > 0) return "cashed";

  const lifecycleExplicit = norm(card.lifecycleState);
  const validLifecycle: ReadonlySet<HrRadarSectionState> = new Set([
    "pregame", "watch", "build", "ready", "attack",
    "cashed", "missed", "late_signal", "uncalled_hr", "inactive",
  ] as const);
  if (validLifecycle.has(lifecycleExplicit as HrRadarSectionState)) {
    return lifecycleExplicit as HrRadarSectionState;
  }

  const stage = norm(card.currentStage) || norm(card.canonicalStage);
  if (stage === "attack") return "attack";
  if (stage === "building") return "build";
  if (stage === "watch") return "watch";
  if (stage === "cooling") return "watch";
  if (stage === "closed") return "inactive";

  const us = norm(card.userStage);
  if (us === "fire") return "attack";
  if (us === "ready") return "ready";
  if (us === "build") return "build";
  if (us === "track") return "watch";
  if (us === "resolved") return "inactive";

  const section = norm(card.section);
  if (section === "attacknow" || section === "attack") return "attack";
  if (section === "ready") return "ready";
  if (section === "building" || section === "build") return "build";
  if (section === "watch") return "watch";

  const tier = norm(card.confidenceTier);
  const sig = norm(card.signalState);
  if (tier === "strong" || sig === "actionable") return "ready";
  if (tier === "building" || sig === "live") return "build";

  // True pregame only when no live AB context AND game has not started.
  const liveCtx = card.hasLiveABContext === true || (Number(card.plateAppearancesTracked ?? 0) > 0);
  const gameLive = norm(card.gameStatus) === "live" || norm(card.gameStatus) === "in_progress";
  if (!liveCtx && !gameLive) return "pregame";
  return "watch";
}

/**
 * Spec Step 1 — canonical section derivation. Pure.
 *
 * Priority order (from TASK Part 1):
 *   1. called_hit / cashed → "cashed"
 *   2. called_miss / missed → "missed"
 *   3. late_signal / uncalled_hr → "diagnostic"
 *   4. attack → "attack"
 *   5. ready → "ready"
 *   6. build → "build"
 *   7. watch → "watch"
 *   8. pregame → "inactive"
 *   9. else → "inactive"
 */
export function deriveHrRadarSection(card: CanonicalCardInput): HrRadarSection {
  const outcome = deriveHrRadarOutcomeStatus(card);
  if (CALLED_HIT_OUTCOME_STATUSES.has(outcome)) return "cashed";
  if (outcome === "called_miss") return "missed";
  if (outcome === "late_signal" || outcome === "uncalled_hr") return "diagnostic";
  // Phase 2 — early-HR-insufficient-sample is admin-only diagnostic. Route
  // to `diagnostic` so it stays out of active sections; the user-facing UI
  // mapper filters it out for non-admin users (Phase 4).
  if (outcome === "early_hr_insufficient_sample") return "diagnostic";

  const lifecycle = deriveHrRadarLifecycleState(card);
  if (lifecycle === "cashed") return "cashed";
  if (lifecycle === "missed") return "missed";
  if (lifecycle === "late_signal" || lifecycle === "uncalled_hr") return "diagnostic";
  if (lifecycle === "attack") return "attack";
  if (lifecycle === "ready") return "ready";
  if (lifecycle === "build") return "build";
  if (lifecycle === "watch") return "watch";
  if (lifecycle === "pregame") return "inactive";
  return "inactive";
}

/**
 * Convenience — does this card represent a resolved (terminal) outcome?
 * Resolved cards must NEVER appear in active sections (Spec Rule 3).
 */
export function isResolvedHrRadarOutcome(card: CanonicalCardInput): boolean {
  const outcome = deriveHrRadarOutcomeStatus(card);
  return CALLED_HIT_OUTCOME_STATUSES.has(outcome) ||
         outcome === "called_miss" ||
         outcome === "uncalled_hr" ||
         outcome === "late_signal" ||
         outcome === "early_hr_insufficient_sample";
}

/**
 * Spec Step 2 — resolved-state fixup. Returns a NEW object with canonical
 * fields applied. Emits `[HR_RADAR_INTEGRITY_FIXUP]` log only when a
 * transition actually occurs (resolved card was in an active section).
 *
 * Pure with respect to the input — never mutates the original card object.
 */
/**
 * Return shape of `applyHrRadarResolvedStateFixup`.
 *
 * IMPORTANT: we intentionally surface the canonical outcome under the
 * `canonicalOutcomeStatus` key rather than `outcomeStatus`, because the
 * legacy DB row already carries `outcomeStatus` and our helper must NEVER
 * overwrite it (strict additive contract). Callers that want the canonical
 * value should read `canonicalOutcomeStatus`; the legacy `outcomeStatus`
 * field on the input row is preserved verbatim.
 */
export type HrRadarFixupOutput<T> = T & {
  lifecycleState: HrRadarSectionState;
  canonicalOutcomeStatus: HrRadarOutcomeStatus;
  section: HrRadarSection;
  active: boolean;
};

// Internal mutable state threaded through the fixup pipeline. Kept tiny so each
// stage (initial derivation → game-final override → resolved-slip fixup) reads
// as a pure transform on the same shape.
type HrRadarFixupState = {
  lifecycle: HrRadarSectionState;
  section: HrRadarSection;
  active: boolean;
};

type HrRadarFixupCtx = { gameId?: string; playerId?: string; logger?: (msg: string) => void; gameStatus?: string | null };

/**
 * Stage 2 — HR Radar Final-Game Reconciliation (Phase 3).
 * Final game state is the ultimate authority: once a game has ended, no card
 * from it may remain active regardless of outcomeStatus/lifecycleState/signalState.
 * Routes the card to the correct resolved bucket and forces `active=false`.
 * Runs BEFORE the resolved-slip fixup so the [HR_RADAR_FINAL_ACTIVE_FIXUP] log
 * captures the original active state. Pure aside from logging.
 */
function applyGameFinalOverride(
  card: Record<string, any>,
  ctx: HrRadarFixupCtx | undefined,
  outcome: HrRadarOutcomeStatus,
  state: HrRadarFixupState,
): HrRadarFixupState {
  const gameStatusNorm = norm(ctx?.gameStatus ?? card.gameStatus);
  const isGameFinal = gameStatusNorm === "final" ||
                      gameStatusNorm === "completed" ||
                      gameStatusNorm === "game_over" ||
                      gameStatusNorm === "gameover" ||
                      card.isGameFinal === true;
  if (!isGameFinal) return state;

  let { lifecycle, section } = state;
  const wasActiveBeforeFinal = state.active;

  if (CALLED_HIT_OUTCOME_STATUSES.has(outcome)) {
    lifecycle = "cashed";
    section = "cashed";
  } else if (outcome === "called_miss") {
    lifecycle = "missed";
    section = "missed";
  } else if (outcome === "uncalled_hr" || outcome === "late_signal" || outcome === "early_hr_insufficient_sample") {
    // Diagnostic-only buckets — preserve the existing lifecycle if it
    // already reflects the diagnostic outcome; otherwise mark inactive.
    if (lifecycle !== "uncalled_hr" && lifecycle !== "late_signal") {
      lifecycle = "inactive";
    }
    section = "diagnostic";
  } else {
    // ── HR Radar Lifecycle Repair Fix #3 — DEAD/MISSED inflation ─────────
    // Forensic finding: the prior branch unconditionally forced `missed`
    // for every still-active card on a final game, including TRACK/WATCH/
    // BUILD rows that never reached actionable territory. Those should be
    // `inactive` (the alert never matured into something the user could
    // act on), reserving `missed` for cards that actually reached READY/
    // FIRE / actionable / strong / attack.
    const wasActionable =
      norm(card.userStage) === "fire" ||
      norm(card.userStage) === "ready" ||
      norm(card.canonicalStage) === "attack" ||
      norm(card.currentStage) === "attack" ||
      norm(card.confidenceTier) === "strong" ||
      norm(card.signalState) === "actionable" ||
      norm(card.lifecycleState) === "attack" ||
      norm(card.lifecycleState) === "ready";
    if (wasActionable) {
      lifecycle = "missed";
      section = "missed";
    } else {
      lifecycle = "inactive";
      section = "inactive";
    }
  }

  if (wasActiveBeforeFinal) {
    const log = ctx?.logger ?? console.log;
    const tag =
      section === "missed" ? "[HR_RADAR_MISSED]"
      : section === "cashed" ? "[HR_RADAR_CASHED]"
      : "[HR_RADAR_INACTIVE]";
    const gid = ctx?.gameId ?? card.gameId ?? "?";
    const pid = ctx?.playerId ?? card.playerId ?? "?";
    log(`[HR_RADAR_FINAL_ACTIVE_FIXUP] gameId=${gid} playerId=${pid} outcomeStatus=${outcome} newSection=${section} newLifecycle=${lifecycle} reason=game_final_overrides_active`);
    log(`${tag} gameId=${gid} playerId=${pid} from=active to=${lifecycle} rule=game_final_overrides_active`);
  }

  return { lifecycle, section, active: false };
}

/**
 * Stage 3 — resolved-state truth (Rule 3: a resolved outcome always wins, even
 * if the card somehow slipped into an active section). Pure aside from logging.
 */
function applyResolvedSlipFixup(
  card: Record<string, any>,
  ctx: HrRadarFixupCtx | undefined,
  outcome: HrRadarOutcomeStatus,
  state: HrRadarFixupState,
): HrRadarFixupState {
  const { lifecycle, section } = state;
  const inActiveSection = section === "attack" || section === "ready" || section === "build" || section === "watch";
  const hrCount = Number(card.hrCount ?? card.hr ?? 0);

  if ((outcome === "called_hit" || lifecycle === "cashed" || hrCount > 0) && inActiveSection) {
    const log = ctx?.logger ?? console.log;
    log(`[HR_RADAR_INTEGRITY_FIXUP] gameId=${ctx?.gameId ?? card.gameId ?? "?"} playerId=${ctx?.playerId ?? card.playerId ?? "?"} oldState=${lifecycle} newState=cashed oldSection=${section} newSection=cashed outcomeStatus=${outcome} reason=resolved_outcome_in_active_section`);
    return { lifecycle: "cashed", section: "cashed", active: false };
  }

  if ((outcome === "uncalled_hr" || outcome === "late_signal") && inActiveSection) {
    const log = ctx?.logger ?? console.log;
    log(`[HR_RADAR_INTEGRITY_FIXUP] gameId=${ctx?.gameId ?? card.gameId ?? "?"} playerId=${ctx?.playerId ?? card.playerId ?? "?"} oldState=${lifecycle} newState=${lifecycle} oldSection=${section} newSection=diagnostic outcomeStatus=${outcome} reason=diagnostic_outcome_in_active_section`);
    return { lifecycle, section: "diagnostic", active: false };
  }

  return state;
}

export function applyHrRadarResolvedStateFixup<T extends CanonicalCardInput & Record<string, any>>(
  card: T,
  ctx?: HrRadarFixupCtx,
): HrRadarFixupOutput<T> {
  const outcome = deriveHrRadarOutcomeStatus(card);
  const initialLifecycle = deriveHrRadarLifecycleState(card);

  let state: HrRadarFixupState = {
    lifecycle: initialLifecycle,
    section: deriveHrRadarSection(card),
    active: !(
      outcome === "called_hit" || outcome === "called_miss" ||
      outcome === "uncalled_hr" || outcome === "late_signal" ||
      initialLifecycle === "cashed" || initialLifecycle === "missed" ||
      initialLifecycle === "uncalled_hr" || initialLifecycle === "late_signal" ||
      initialLifecycle === "inactive"
    ),
  };

  state = applyGameFinalOverride(card, ctx, outcome, state);
  state = applyResolvedSlipFixup(card, ctx, outcome, state);

  const { lifecycle, section, active } = state;

  // Strict additive contract: spread `card` LAST so any incoming fields
  // win over our additions, EXCEPT for the four canonical fields we own.
  // This guarantees the legacy `outcomeStatus`, `section`, `lifecycleState`
  // (if previously set by a stamper) and `active` on the input row are
  // preserved verbatim and only the canonical-prefixed fields are appended.
  return {
    ...card,
    lifecycleState: lifecycle,
    canonicalOutcomeStatus: outcome,
    section: (card.section as any) ?? section,
    active: (typeof card.active === "boolean") ? card.active : active,
    // Also expose the fixup-derived section + active under canonical names so
    // clients that opt-in to canonical grouping never have to disambiguate
    // them from legacy ladder section labels (attackNow/building/dead/...).
    canonicalSection: section,
    canonicalActive: active,
  } as HrRadarFixupOutput<T> & { canonicalSection: HrRadarSection; canonicalActive: boolean };
}

/**
 * Spec Step 3 — canonical event-resolver return shape.
 *
 * Pure. Never reads from DB, never mutates anything. Given any input row
 * shape (DB row, ladder card, board card, wire payload), returns the
 * spec's canonical {lifecycleState, section, outcomeStatus, active}
 * tuple. Used by reconcile / event-detection callsites that need a
 * single typed value instead of three separate derive calls.
 *
 * NOTE: This is a SHAPE-only canonicalization. The actual resolution
 * (writing `gradingStatus=called_hit` to the DB row) happens inside
 * `gradeSingleHRPlay` → `storage.resolveHrRadarAlertAsHit`. This helper
 * is what those callsites can return / log so consumers see one shape.
 */
export interface ResolveHrRadarPlayerOutcomeResult {
  lifecycleState: HrRadarSectionState;
  section: HrRadarSection;
  outcomeStatus: HrRadarOutcomeStatus;
  active: boolean;
}

export function resolveHrRadarPlayerOutcome(
  card: CanonicalCardInput,
): ResolveHrRadarPlayerOutcomeResult {
  const outcomeStatus = deriveHrRadarOutcomeStatus(card);
  const lifecycleState = deriveHrRadarLifecycleState(card);
  const section = deriveHrRadarSection(card);
  const active = !(
    outcomeStatus === "called_hit" || outcomeStatus === "called_miss" ||
    outcomeStatus === "uncalled_hr" || outcomeStatus === "late_signal" ||
    lifecycleState === "cashed" || lifecycleState === "missed" ||
    lifecycleState === "uncalled_hr" || lifecycleState === "late_signal" ||
    lifecycleState === "inactive"
  );
  return { lifecycleState, section, outcomeStatus, active };
}

/**
 * Spec Step 14 — dedupe HR Radar records by (sessionDate, gameId, playerId).
 * Resolved record always wins over active duplicates. Pure.
 *
 * "Resolved" precedence (highest first): called_hit, called_miss,
 * uncalled_hr, late_signal, then any active record. Among same-class
 * duplicates the first one wins (callers should pre-sort by freshness if
 * they care).
 */
export function dedupeHrRadarRecords<T extends CanonicalCardInput & {
  sessionDate?: string | null;
  gameId?: string | null;
  playerId?: string | null;
}>(records: readonly T[]): T[] {
  const rank = (r: T): number => {
    const o = deriveHrRadarOutcomeStatus(r);
    if (CALLED_HIT_OUTCOME_STATUSES.has(o)) return 0;
    if (o === "called_miss") return 1;
    if (o === "uncalled_hr") return 2;
    if (o === "late_signal") return 3;
    return 4; // active / unresolved
  };
  const map = new Map<string, T>();
  for (const r of records) {
    const k = `${r.sessionDate ?? ""}|${r.gameId ?? ""}|${r.playerId ?? ""}`;
    const existing = map.get(k);
    if (!existing || rank(r) < rank(existing)) {
      map.set(k, r);
    }
  }
  const out = Array.from(map.values());
  // Spec Step 14 — emit cache-update diagnostic only when duplicates were
  // actually dropped (no-op silent path keeps logs quiet under normal load).
  // Format chosen so admins can grep `[HR_RADAR_CACHE_UPDATE]` for any
  // resolved-record-wins-over-active collapses across both serializers
  // (/api/mlb/hr-radar and /api/mlb/hr-radar-board).
  const dropped = records.length - out.length;
  if (dropped > 0) {
    const log =
      typeof console !== "undefined" && typeof console.log === "function"
        ? console.log.bind(console)
        : () => {};
    log(`[HR_RADAR_CACHE_UPDATE] inputRecords=${records.length} keptRecords=${out.length} duplicatesDropped=${dropped} reason=resolved_wins_over_active`);
  }
  return out;
}
