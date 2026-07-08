// HR Radar Canonical State — In-memory store
// ─────────────────────────────────────────────────────────────────────────
// Mirrors the lifecycleStore.ts pattern. Single source of truth for HR
// Radar canonical lifecycle state, keyed by `${gameId}_${playerId}`.
//
// In-memory only for this iteration (per user constraint). When we move
// to DB persistence the public API stays the same — only the underlying
// Map gets swapped for storage.upsertCanonicalHrRadarState calls.

import {
  applyHrRadarLifecycleEvent,
  deriveStateView,
  isTerminal,
  type HrRadarApplyContext,
  type HrRadarApplyResult,
  type HrRadarLifecycleEvent,
  type HrRadarLifecycleState,
  type HrRadarSection,
  type HrRadarUserStage,
} from "./hrRadarStateMachine";

export interface CanonicalHrRadarState {
  gameId: string;
  playerId: string;
  playerName: string;
  team: string | null;
  sessionDate: string | null;

  lifecycleState: HrRadarLifecycleState;
  section: HrRadarSection;
  userStage: HrRadarUserStage;

  displayScore10: number | null;
  peakScore10: number | null;

  detectedAt: string;
  detectedInning: number | null;
  latestEvidenceAt: string;
  latestEvidenceInning: number | null;

  triggerAbIndex: number | null;
  triggerReasons: string[];
  triggerTags: string[];
  contactEvidence: Array<Record<string, unknown>>;

  active: boolean;
  terminal: boolean;
  updatedAt: string;
}

export interface UpsertInput {
  gameId: string | number;
  playerId: string | number;
  playerName: string;
  team?: string | null;
  sessionDate?: string | null;
  event: HrRadarLifecycleEvent;
  context?: HrRadarApplyContext;
  triggerAbIndex?: number | null;
  triggerReasons?: string[];
  triggerTags?: string[];
  contactEvidence?: Array<Record<string, unknown>>;
}

export interface UpsertResult {
  state: CanonicalHrRadarState;
  apply: HrRadarApplyResult;
  created: boolean;
}

const _store: Map<string, CanonicalHrRadarState> = new Map();

// ── Promotion hook ───────────────────────────────────────────────────────
// Optional external subscriber, fired when a player genuinely transitions
// into "ready" or "fire" (never on idempotent same-state re-observations).
// Mirrors the setDispatchHook / installPregamePersistence pattern used
// elsewhere in the codebase so this module stays free of storage/push
// imports — the real implementation is wired in from server/index.ts.
export type HrRadarPromotionHook = (
  state: CanonicalHrRadarState,
  apply: HrRadarApplyResult,
) => void | Promise<void>;

let _promotionHook: HrRadarPromotionHook | null = null;
export function setHrRadarPromotionHook(hook: HrRadarPromotionHook | null): void {
  _promotionHook = hook;
}

function keyOf(gameId: string | number, playerId: string | number): string {
  return `${gameId}_${playerId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function getCanonicalHrRadarState(
  gameId: string | number,
  playerId: string | number,
): CanonicalHrRadarState | null {
  return _store.get(keyOf(gameId, playerId)) ?? null;
}

export function getActiveCanonicalHrRadarStates(
  gameId?: string | number,
): CanonicalHrRadarState[] {
  const out: CanonicalHrRadarState[] = [];
  _store.forEach((s) => {
    if (!s.active) return;
    if (gameId != null && s.gameId !== String(gameId)) return;
    out.push(s);
  });
  return out;
}

export function getAllCanonicalHrRadarStates(
  gameId?: string | number,
): CanonicalHrRadarState[] {
  const out: CanonicalHrRadarState[] = [];
  _store.forEach((s) => {
    if (gameId != null && s.gameId !== String(gameId)) return;
    out.push(s);
  });
  return out;
}

/**
 * Apply an event and persist the resulting canonical state. Idempotent —
 * a same-state event still bumps latestEvidenceAt + updatedAt without
 * emitting a transition log.
 *
 * Returns the (now-persisted) state plus the raw apply result so the
 * caller can decide what to log.
 */
export function upsertCanonicalHrRadarState(input: UpsertInput): UpsertResult {
  const k = keyOf(input.gameId, input.playerId);
  const existing = _store.get(k) ?? null;
  const currentState: HrRadarLifecycleState = existing?.lifecycleState ?? "inactive";

  const apply = applyHrRadarLifecycleEvent(currentState, input.event, input.context);

  // Rejected → log + keep existing state untouched (still bump updatedAt
  // so we can see the most recent reject attempt). Don't bump
  // latestEvidenceAt because the evidence wasn't accepted.
  if (!apply.ok) {
    console.log(
      "[HR_RADAR_STATE_REJECTED]",
      JSON.stringify({
        gameId: String(input.gameId),
        playerId: String(input.playerId),
        playerName: input.playerName,
        previousState: currentState,
        eventType: input.event,
        reason: input.context?.reason ?? null,
        rejectedReason: apply.rejectedReason ?? null,
        inning: input.context?.inning ?? null,
        active: existing?.active ?? false,
        terminal: existing?.terminal ?? isTerminal(currentState),
      }),
    );
    if (existing) {
      existing.updatedAt = nowIso();
    }
    return {
      state: existing ?? buildState(input, currentState, apply, /*isFirstObservation=*/false),
      apply,
      created: false,
    };
  }

  const next = apply.nextState;
  const view = deriveStateView(next);

  // Compute peak — peakScore10 is the max display score we've ever seen
  // for this player/game.
  const incomingScore = apply.displayScore10;
  const prevPeak = existing?.peakScore10 ?? null;
  const peak = (() => {
    if (incomingScore == null) return prevPeak;
    if (prevPeak == null) return incomingScore;
    return Math.max(prevPeak, incomingScore);
  })();

  const now = nowIso();
  const isCreated = !existing;

  const merged: CanonicalHrRadarState = {
    gameId: String(input.gameId),
    playerId: String(input.playerId),
    playerName: input.playerName,
    team: input.team ?? existing?.team ?? null,
    sessionDate: input.sessionDate ?? existing?.sessionDate ?? null,

    lifecycleState: next,
    section: view.section,
    userStage: view.userStage,

    displayScore10: incomingScore,
    peakScore10: peak,

    detectedAt: existing?.detectedAt ?? now,
    detectedInning: existing?.detectedInning ?? input.context?.inning ?? null,
    latestEvidenceAt: now,
    latestEvidenceInning: input.context?.inning ?? existing?.latestEvidenceInning ?? null,

    triggerAbIndex:
      input.triggerAbIndex !== undefined ? input.triggerAbIndex : existing?.triggerAbIndex ?? null,
    triggerReasons: dedupeAppend(existing?.triggerReasons ?? [], input.triggerReasons ?? []),
    triggerTags: dedupeAppend(existing?.triggerTags ?? [], input.triggerTags ?? []),
    contactEvidence: appendEvidence(existing?.contactEvidence ?? [], input.contactEvidence ?? []),

    active: !isTerminal(next) && next !== "inactive",
    terminal: isTerminal(next),
    updatedAt: now,
  };

  _store.set(k, merged);

  // Diagnostics — one event log every time, plus a transition log only
  // when the state actually changed. Callers don't need to log; this
  // module owns the canonical diagnostic surface.
  const eventPayload = {
    gameId: merged.gameId,
    playerId: merged.playerId,
    playerName: merged.playerName,
    previousState: currentState,
    nextState: next,
    reason: apply.reason,
    inning: input.context?.inning ?? null,
    eventType: input.event,
    active: merged.active,
    terminal: merged.terminal,
  };
  // On a real state change the TRANSITION line carries the identical payload,
  // so emit EVENT only when nothing transitioned — avoids a redundant third
  // log line per state change during live games.
  if (currentState !== next) {
    console.log("[HR_RADAR_STATE_TRANSITION]", JSON.stringify(eventPayload));
  } else {
    console.log("[HR_RADAR_STATE_EVENT]", JSON.stringify(eventPayload));
  }
  console.log(
    "[HR_RADAR_CANONICAL_UPSERT]",
    JSON.stringify({
      ...eventPayload,
      section: merged.section,
      userStage: merged.userStage,
      displayScore10: merged.displayScore10,
      peakScore10: merged.peakScore10,
      created: isCreated,
    }),
  );

  // Fire the promotion hook on a genuine upgrade into ready/fire — never on
  // idempotent same-state re-observations (currentState !== next guards
  // that) and never on downgrades (DECAY moves state the other direction,
  // so this only trips going up the ladder).
  if (_promotionHook && currentState !== next && (next === "ready" || next === "fire")) {
    try {
      const result = _promotionHook(merged, apply);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((e: Error) =>
          console.warn("[LL_HR_RADAR_ALERT_HOOK_FAILED]", e.message),
        );
      }
    } catch (e) {
      console.warn("[LL_HR_RADAR_ALERT_HOOK_FAILED]", (e as Error).message);
    }
  }

  return { state: merged, apply, created: isCreated };
}

function dedupeAppend(prev: string[], add: string[]): string[] {
  if (!add.length) return prev;
  const set = new Set(prev);
  for (const a of add) if (a) set.add(a);
  return Array.from(set);
}

function appendEvidence(
  prev: Array<Record<string, unknown>>,
  add: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (!add.length) return prev;
  // Cap at 25 entries to bound memory.
  const merged = [...prev, ...add];
  return merged.length > 25 ? merged.slice(merged.length - 25) : merged;
}

function buildState(
  input: UpsertInput,
  currentState: HrRadarLifecycleState,
  apply: HrRadarApplyResult,
  _isFirstObservation: boolean,
): CanonicalHrRadarState {
  const view = deriveStateView(currentState);
  const now = nowIso();
  return {
    gameId: String(input.gameId),
    playerId: String(input.playerId),
    playerName: input.playerName,
    team: input.team ?? null,
    sessionDate: input.sessionDate ?? null,
    lifecycleState: currentState,
    section: view.section,
    userStage: view.userStage,
    displayScore10: apply.displayScore10,
    peakScore10: apply.displayScore10,
    detectedAt: now,
    detectedInning: input.context?.inning ?? null,
    latestEvidenceAt: now,
    latestEvidenceInning: input.context?.inning ?? null,
    triggerAbIndex: input.triggerAbIndex ?? null,
    triggerReasons: input.triggerReasons ?? [],
    triggerTags: input.triggerTags ?? [],
    contactEvidence: input.contactEvidence ?? [],
    active: false,
    terminal: isTerminal(currentState),
    updatedAt: now,
  };
}

/** Test-only: clear the store between unit tests. */
export function _resetCanonicalHrRadarStoreForTests(): void {
  _store.clear();
}
