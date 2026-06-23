/**
 * SAFE ADDITIVE MODULE — pre-HR contact event resolver.
 *
 * Pure assembly/ordering helper for the HR review classifier. Centralizes the
 * "what batted-ball events happened strictly BEFORE this HR" question so the
 * classifier never has to guess about event ordering.
 *
 * Hard rules:
 *   - Never include the HR event itself.
 *   - Never include contact after the HR.
 *   - Return `ambiguous` when ordering cannot be trusted (do NOT guess) — the
 *     classifier routes `ambiguous` to `insufficient_review_data`.
 *   - Return `missing` when no source exists.
 *
 * No DB / no network: the caller passes already-fetched live-cache AB results
 * and/or a persisted contact snapshot.
 */

import type { HrContactEvent } from "./hrReviewClassifier";

export type PreHrResolverStatus = "complete" | "partial" | "missing" | "ambiguous";
export type PreHrResolverSource = "live_cache" | "persisted_snapshot" | "mixed" | "none";

export interface PreHrResolverResult {
  events: HrContactEvent[];
  status: PreHrResolverStatus;
  source: PreHrResolverSource;
  reasons: string[];
}

/** Raw AB shape as stored on `PlayerContactData.priorABResults` (all optional/nullable). */
interface RawAb {
  exitVelocity?: number | null;
  launchAngle?: number | null;
  distance?: number | null;
  perABxBA?: number | null;
  xba?: number | null;
  isBarrel?: boolean | null;
  contactGrade?: string | null;
  outcome?: string | null;
  hitType?: string | null;
  inning?: number | null;
  half?: string | null;
}

const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** top precedes bottom; unknown sorts last. */
function halfOrdinal(h: string | null | undefined): number {
  const n = norm(h);
  if (n === "top" || n === "t") return 0;
  if (n === "bottom" || n === "b") return 1;
  return 2;
}

/** Is event (inning,half) strictly before the HR's (inning,half)? */
function isStrictlyBeforeHr(
  evInning: number | null,
  evHalf: string | null | undefined,
  hrInning: number | null,
  hrHalf: string | null | undefined,
): boolean {
  if (evInning == null || hrInning == null) return false; // cannot prove ordering
  if (evInning < hrInning) return true;
  if (evInning > hrInning) return false;
  return halfOrdinal(evHalf) < halfOrdinal(hrHalf);
}

function toContactEvent(ab: RawAb, abIndex: number): HrContactEvent {
  return {
    abIndex,
    eventTimeMs: null,
    inning: ab.inning ?? null,
    half: ab.half ?? null,
    exitVelocity: ab.exitVelocity ?? null,
    launchAngle: ab.launchAngle ?? null,
    distance: ab.distance ?? null,
    xba: ab.xba ?? ab.perABxBA ?? null,
    isBarrel: ab.isBarrel ?? null,
    contactQuality: ab.contactGrade ?? null,
    outcome: ab.outcome ?? null,
    hitType: ab.hitType ?? null,
  };
}

function coerceRawAbs(input: unknown): RawAb[] | null {
  if (Array.isArray(input)) return input as RawAb[];
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return Array.isArray(parsed) ? (parsed as RawAb[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function getPreHrContactEvents(input: {
  gameId: string;
  playerId: string | number;
  hrEvent: {
    hrEndTimeMs?: number | null;
    hrAtBatIndex?: number | null;
    inning?: number | null;
    half?: "top" | "bottom" | string | null;
    playId?: string | null;
    sequenceIndex?: number | null;
  };
  liveCacheContactEvents?: unknown;
  persistedContactSnapshot?: unknown;
}): PreHrResolverResult {
  const reasons: string[] = [];

  // Prefer live cache; fall back to persisted snapshot.
  let source: PreHrResolverSource = "none";
  let raw = coerceRawAbs(input.liveCacheContactEvents);
  if (raw && raw.length > 0) {
    source = "live_cache";
  } else {
    const persisted = coerceRawAbs(input.persistedContactSnapshot);
    if (persisted && persisted.length > 0) {
      raw = persisted;
      source = "persisted_snapshot";
    }
  }

  if (!raw || raw.length === 0) {
    reasons.push("no_pre_hr_event_source");
    return { events: [], status: "missing", source: "none", reasons };
  }

  const hrInning = input.hrEvent.inning ?? null;
  const hrHalf = input.hrEvent.half ?? null;

  // Build chronological events (array order is the only reliable sequence the
  // live feed gives us). Drop the HR's own AB and anything that is not provably
  // before the HR.
  const all = raw.map(toContactEvent);

  // Count how many ABs carry usable inning data — if too few, ordering is
  // ambiguous and we must not guess.
  const withInning = all.filter((e) => e.inning != null);
  const inningCoverage = all.length === 0 ? 1 : withInning.length / all.length;

  const kept: HrContactEvent[] = [];
  let droppedHrOrAfter = 0;
  for (const ev of all) {
    // Never count the HR swing itself: a home_run in the HR's inning/half is the
    // HR event (or a same-inning HR we cannot disambiguate) — drop it and stop.
    const isHomeRun = norm(ev.hitType) === "home_run";
    if (isHomeRun && hrInning != null && ev.inning === hrInning) {
      droppedHrOrAfter++;
      continue;
    }
    if (hrInning != null && ev.inning != null) {
      if (isStrictlyBeforeHr(ev.inning, ev.half, hrInning, hrHalf)) {
        kept.push(ev);
      } else {
        droppedHrOrAfter++;
      }
    } else {
      // No inning on this event — keep it only if we otherwise have good
      // coverage; it contributes to ambiguity below.
      kept.push(ev);
    }
  }

  // Re-index kept events positionally; clear abIndex so the classifier's
  // index-based guard (which compares to a GAME-level hrAtBatIndex) never
  // misfires — this resolver is the authority on "before HR".
  const events = kept.map((e) => ({ ...e, abIndex: null as number | null }));

  let status: PreHrResolverStatus;
  if (hrInning == null) {
    reasons.push("missing_hr_inning");
    status = "ambiguous";
  } else if (inningCoverage < 0.5) {
    reasons.push("low_inning_coverage_on_pre_hr_events");
    status = "ambiguous";
  } else if (inningCoverage < 1) {
    reasons.push("partial_inning_coverage_on_pre_hr_events");
    status = "partial";
  } else {
    status = "complete";
  }

  if (droppedHrOrAfter > 0) reasons.push(`dropped_hr_or_after=${droppedHrOrAfter}`);

  return { events, status, source, reasons };
}
