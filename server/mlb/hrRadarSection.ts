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

export type HrRadarLifecycleState =
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
  | "called_miss"
  | "uncalled_hr"
  | "late_signal"
  | "unresolved";

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
    explicit === "called_miss" ||
    explicit === "uncalled_hr" ||
    explicit === "late_signal" ||
    explicit === "active" ||
    explicit === "unresolved"
  ) return explicit as HrRadarOutcomeStatus;

  const grading = norm(card.gradingStatus);
  if (grading === "called_hit") return "called_hit";
  if (grading === "called_miss") return "called_miss";
  if (grading === "uncalled_hr") return "uncalled_hr";
  if (grading === "late_signal") return "late_signal";
  // Diagnostic flavours of "HR happened but signal didn't qualify" — must
  // map to uncalled_hr (not called_hit) so dedupe + fixup correctly mark
  // them diagnostic / inactive instead of cashed.
  if (grading === "early_window_hr" || grading === "early_hr_no_window") return "uncalled_hr";
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
  if (outcomeWire === "early_window_hr") return "uncalled_hr"; // first-inning HR with no window

  const statusWire = norm(card.status);
  if (statusWire === "hit") return "called_hit";
  if (statusWire === "miss") return "called_miss";
  if (statusWire === "live") return "active";

  const hrCount = Number(card.hrCount ?? card.hr ?? 0);
  if (hrCount > 0) return "uncalled_hr";

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
export function deriveHrRadarLifecycleState(card: CanonicalCardInput): HrRadarLifecycleState {
  const outcome = deriveHrRadarOutcomeStatus(card);
  if (outcome === "called_hit") return "cashed";
  if (outcome === "called_miss") return "missed";
  if (outcome === "uncalled_hr") return "uncalled_hr";
  if (outcome === "late_signal") return "late_signal";

  // Box-score fallback safety: any row carrying a positive HR count is
  // resolved even if outcomeStatus was not yet persisted (catches the
  // play-feed-miss → box-score-fallback race).
  const hrCount = Number(card.hrCount ?? card.hr ?? 0);
  if (hrCount > 0) return "cashed";

  const lifecycleExplicit = norm(card.lifecycleState);
  const validLifecycle: ReadonlySet<HrRadarLifecycleState> = new Set([
    "pregame", "watch", "build", "ready", "attack",
    "cashed", "missed", "late_signal", "uncalled_hr", "inactive",
  ] as const);
  if (validLifecycle.has(lifecycleExplicit as HrRadarLifecycleState)) {
    return lifecycleExplicit as HrRadarLifecycleState;
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
  if (outcome === "called_hit") return "cashed";
  if (outcome === "called_miss") return "missed";
  if (outcome === "late_signal" || outcome === "uncalled_hr") return "diagnostic";

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
  return outcome === "called_hit" || outcome === "called_miss" ||
         outcome === "uncalled_hr" || outcome === "late_signal";
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
  lifecycleState: HrRadarLifecycleState;
  canonicalOutcomeStatus: HrRadarOutcomeStatus;
  section: HrRadarSection;
  active: boolean;
};

export function applyHrRadarResolvedStateFixup<T extends CanonicalCardInput & Record<string, any>>(
  card: T,
  ctx?: { gameId?: string; playerId?: string; logger?: (msg: string) => void },
): HrRadarFixupOutput<T> {
  const outcome = deriveHrRadarOutcomeStatus(card);
  let lifecycle = deriveHrRadarLifecycleState(card);
  let section = deriveHrRadarSection(card);
  let active = !(
    outcome === "called_hit" || outcome === "called_miss" ||
    outcome === "uncalled_hr" || outcome === "late_signal" ||
    lifecycle === "cashed" || lifecycle === "missed" ||
    lifecycle === "uncalled_hr" || lifecycle === "late_signal" ||
    lifecycle === "inactive"
  );

  // Force resolved-state truth (Rule 3 — resolved always wins).
  const hrCount = Number(card.hrCount ?? card.hr ?? 0);
  const wasResolvedSlippedActive =
    (outcome === "called_hit" || lifecycle === "cashed" || hrCount > 0) &&
    (section === "attack" || section === "ready" || section === "build" || section === "watch");

  if (wasResolvedSlippedActive) {
    const oldSection = section;
    const oldLifecycle = lifecycle;
    lifecycle = "cashed";
    section = "cashed";
    active = false;
    const log = ctx?.logger ?? console.log;
    log(`[HR_RADAR_INTEGRITY_FIXUP] gameId=${ctx?.gameId ?? card.gameId ?? "?"} playerId=${ctx?.playerId ?? card.playerId ?? "?"} oldState=${oldLifecycle} newState=cashed oldSection=${oldSection} newSection=cashed outcomeStatus=${outcome} reason=resolved_outcome_in_active_section`);
  } else if (
    (outcome === "uncalled_hr" || outcome === "late_signal") &&
    (section === "attack" || section === "ready" || section === "build" || section === "watch")
  ) {
    const oldSection = section;
    const oldLifecycle = lifecycle;
    section = "diagnostic";
    active = false;
    const log = ctx?.logger ?? console.log;
    log(`[HR_RADAR_INTEGRITY_FIXUP] gameId=${ctx?.gameId ?? card.gameId ?? "?"} playerId=${ctx?.playerId ?? card.playerId ?? "?"} oldState=${oldLifecycle} newState=${lifecycle} oldSection=${oldSection} newSection=diagnostic outcomeStatus=${outcome} reason=diagnostic_outcome_in_active_section`);
  }

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
  lifecycleState: HrRadarLifecycleState;
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
    if (o === "called_hit") return 0;
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
