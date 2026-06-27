// HR Radar Live — v2 Shadow Model: pure scoring + normalization helpers.
// ─────────────────────────────────────────────────────────────────────────
// SHADOW MODE ONLY. Pure functions — no I/O, no mutation, no wall-clock.
// Every helper returns `Score01 | null`; `null` means "no real
// endpoint-accessible data" and the caller EXCLUDES it (never imputes a
// neutral 0.5, never renormalizes). No proxy approximations are computed for
// missing feeds — strict-null scorers below always return null today.
//
// IMPORTANT: no helper may call `new Date()` to fabricate "now". Freshness
// takes an injected reference time. `Date.parse(iso)` (parsing an existing
// timestamp) is allowed; constructing the current wall-clock time is not.

import type { Score01 } from "./hrRadarV2Types";
import type { V2ContactEvidence } from "./hrRadarV2Types";

// ── Normalization primitives (exact signatures from the task spec) ──────────

export function sigmoidScore(value: number, midpoint: number, scale: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(midpoint) || !Number.isFinite(scale) || scale === 0) {
    return 0;
  }
  return 1 / (1 + Math.exp(-(value - midpoint) / scale));
}

export function gaussianPeakScore(value: number, peak: number, width: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(peak) || !Number.isFinite(width) || width === 0) {
    return 0;
  }
  const z = (value - peak) / width;
  return Math.exp(-0.5 * z * z);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function clampScore100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── Real-data scorers (compute ONLY from endpoint-accessible real fields) ───
// All return Score01 | null. Null when the required real input is absent.

/** Exit velocity → 0..1. Ramps through the HR-relevant band (~95→107 mph). */
export function scoreExitVelocity(ev: number | null | undefined): Score01 | null {
  if (!isNum(ev)) return null;
  // midpoint 100 mph, scale 4 → ~96 mph ≈ 0.27, 104 mph ≈ 0.73, 108 ≈ 0.88.
  return clamp01(sigmoidScore(ev, 100, 4));
}

/** Launch angle → 0..1, peaked on the HR-optimal window (~25–30°). */
export function scoreLaunchAngle(la: number | null | undefined): Score01 | null {
  if (!isNum(la)) return null;
  return clamp01(gaussianPeakScore(la, 27, 9));
}

/** Batted-ball distance → 0..1 (warning-track → over-the-wall). */
export function scoreDistance(distance: number | null | undefined): Score01 | null {
  if (!isNum(distance)) return null;
  // midpoint 375 ft, scale 18 → 350 ≈ 0.20, 375 ≈ 0.50, 400 ≈ 0.80.
  return clamp01(sigmoidScore(distance, 375, 18));
}

/**
 * Barrel quality → 0..1. Needs at least the barrel flag OR (ev & la). A
 * Statcast barrel is itself an EV/LA derivative, so it floors high.
 */
export function scoreBarrelQuality(
  isBarrel: boolean | null | undefined,
  ev: number | null | undefined,
  la: number | null | undefined,
): Score01 | null {
  const hasEvLa = isNum(ev) && isNum(la);
  if (isBarrel !== true && !hasEvLa) return null;
  let s = 0;
  if (isBarrel === true) s = Math.max(s, 0.85);
  if (hasEvLa) {
    const evS = scoreExitVelocity(ev) ?? 0;
    const laS = scoreLaunchAngle(la) ?? 0;
    s = Math.max(s, 0.6 * evS + 0.4 * laS);
  }
  return clamp01(s);
}

/**
 * Live contact geometry over the contact-evidence window → 0..1. Uses the
 * single strongest real batted ball (max blended EV/LA/distance/barrel).
 * Null when there is no real batted-ball data at all.
 */
export function scoreContactGeometry(evidence: V2ContactEvidence[] | null | undefined): Score01 | null {
  if (!evidence || evidence.length === 0) return null;
  let best: number | null = null;
  for (const e of evidence) {
    const parts: number[] = [];
    const evS = scoreExitVelocity(e.ev);
    const laS = scoreLaunchAngle(e.la);
    const distS = scoreDistance(e.distance);
    const barrelS = scoreBarrelQuality(e.isBarrel, e.ev, e.la);
    if (evS != null) parts.push(evS);
    if (laS != null) parts.push(laS);
    if (distS != null) parts.push(distS);
    if (barrelS != null) parts.push(barrelS);
    if (parts.length === 0) continue;
    // Weight toward the strongest dimension but reward convergence.
    const max = Math.max(...parts);
    const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
    const blended = 0.6 * max + 0.4 * avg;
    best = best == null ? blended : Math.max(best, blended);
  }
  return best == null ? null : clamp01(best);
}

/**
 * Near-HR signal strength from the engine's near-HR tier → 0..1.
 * lean ⇒ 0.85, watch ⇒ 0.6, repeatedDanger boosts watch toward lean.
 * Null when no tier was detected.
 */
export function scoreNearHrGeometry(
  tier: "watch" | "lean" | null | undefined,
  repeatedDanger?: boolean,
): Score01 | null {
  if (tier === "lean") return 0.85;
  if (tier === "watch") return clamp01(repeatedDanger ? 0.72 : 0.6);
  return null;
}

/**
 * Live swing/contact trend from real EV values across the window → 0..1.
 * Directly derivable: compares the recent EV average to the prior EV
 * average. Rising EV ⇒ >0.5, falling ⇒ <0.5. Null with <2 real EVs.
 */
export function scoreLiveSwingTrend(evidence: V2ContactEvidence[] | null | undefined): Score01 | null {
  if (!evidence || evidence.length < 2) return null;
  const evs = evidence.map((e) => (isNum(e.ev) ? e.ev : null)).filter((v): v is number => v != null);
  if (evs.length < 2) return null;
  const half = Math.max(1, Math.floor(evs.length / 2));
  const prior = evs.slice(0, evs.length - half);
  const recent = evs.slice(evs.length - half);
  if (prior.length === 0) return null;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = avg(recent) - avg(prior); // mph
  // ±6 mph maps roughly to the 0..1 extremes around a 0.5 neutral.
  return clamp01(0.5 + delta / 12);
}

/**
 * Freshness of the latest live evidence → 0..1 (1 = fresh, →0 = stale).
 * Time-based when both timestamps exist (8-min half-life after a 2-min
 * grace). Falls back to inning proximity. NEVER calls new Date().
 */
export function scoreFreshnessDecay(args: {
  latestEvidenceAtIso?: string | null;
  referenceTimeIso?: string | null;
  latestEvidenceInning?: number | null;
  currentInning?: number | null;
}): Score01 | null {
  const { latestEvidenceAtIso, referenceTimeIso, latestEvidenceInning, currentInning } = args;
  if (latestEvidenceAtIso && referenceTimeIso) {
    const evMs = Date.parse(latestEvidenceAtIso);
    const refMs = Date.parse(referenceTimeIso);
    if (Number.isFinite(evMs) && Number.isFinite(refMs)) {
      const minutes = Math.max(0, (refMs - evMs) / 60000);
      const graced = Math.max(0, minutes - 2);
      return clamp01(Math.pow(0.5, graced / 8));
    }
  }
  if (isNum(latestEvidenceInning) && isNum(currentInning)) {
    const gap = Math.max(0, currentInning - latestEvidenceInning);
    return clamp01(Math.pow(0.5, gap / 2));
  }
  return null;
}

/**
 * Data quality / completeness over the contact window → 0..1. Fraction of
 * the core batted-ball fields actually populated. Null when there is no
 * evidence at all.
 */
export function scoreDataQuality(evidence: V2ContactEvidence[] | null | undefined): Score01 | null {
  if (!evidence || evidence.length === 0) return null;
  let filled = 0;
  let total = 0;
  for (const e of evidence) {
    total += 4;
    if (isNum(e.ev)) filled += 1;
    if (isNum(e.la)) filled += 1;
    if (isNum(e.distance)) filled += 1;
    if (isNum(e.xba)) filled += 1;
  }
  if (total === 0) return null;
  return clamp01(filled / total);
}

// ── Strict-null scorers (NO proxies — return null today) ────────────────────
// These require feeds the canonical HR Radar state / admin endpoint cannot
// reach today. They each accept an optional real-data object and return null
// when it is absent (which is always, today). NEVER fabricate a value from
// adjacent data (no spray-from-wind, no meatball-from-pitchmix, etc.).

/** Pitcher deterioration — only from endpoint-accessible pitcher fields. */
export function scorePitcherDeterioration(
  data?: {
    pitchCount?: number | null;
    timesThroughOrder?: number | null;
    velocityDrop?: number | null;
    hardContactAllowedToday?: number | null;
    isCollapsing?: boolean | null;
  } | null,
): Score01 | null {
  if (!data) return null;
  const parts: number[] = [];
  if (isNum(data.pitchCount)) parts.push(clamp01(sigmoidScore(data.pitchCount, 85, 18)));
  if (isNum(data.timesThroughOrder)) parts.push(clamp01((data.timesThroughOrder - 1) / 2));
  if (isNum(data.velocityDrop)) parts.push(clamp01(sigmoidScore(data.velocityDrop, 2, 1)));
  if (isNum(data.hardContactAllowedToday)) parts.push(clamp01(data.hardContactAllowedToday / 4));
  if (data.isCollapsing === true) parts.push(0.85);
  if (parts.length === 0) return null;
  return clamp01(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** Count leverage — requires real ball/strike count (absent today). */
export function scoreCountLeverage(
  data?: { balls?: number | null; strikes?: number | null } | null,
): Score01 | null {
  if (!data || !isNum(data.balls) || !isNum(data.strikes)) return null;
  const b = data.balls;
  const s = data.strikes;
  // Hitter's counts (3-0, 3-1, 2-0) score high; pitcher's counts low.
  const edge = b - s; // +3 hitter extreme, -2 pitcher extreme
  return clamp01(0.5 + edge / 6);
}

/** Game-state attack — requires real outs/runners/score (absent today). */
export function scoreGameStateAttack(
  data?: {
    outs?: number | null;
    runnersOnBase?: string[] | null;
    scoreDifferential?: number | null;
    firstBaseOpen?: boolean | null;
  } | null,
): Score01 | null {
  if (!data) return null;
  const hasAny =
    isNum(data.outs) ||
    Array.isArray(data.runnersOnBase) ||
    isNum(data.scoreDifferential) ||
    typeof data.firstBaseOpen === "boolean";
  if (!hasAny) return null;
  let s = 0.5;
  // Pitch-around risk (base open + close/late) suppresses.
  if (data.firstBaseOpen === true && isNum(data.scoreDifferential) && Math.abs(data.scoreDifferential) <= 2) {
    s -= 0.25;
  }
  return clamp01(s);
}

/** Swing-decision form — requires real chase/whiff/zone-contact (absent). */
export function scoreSwingDecisionForm(
  data?: { chaseRateToday?: number | null; whiffRateToday?: number | null; zoneContactToday?: number | null } | null,
): Score01 | null {
  if (!data) return null;
  const parts: number[] = [];
  if (isNum(data.chaseRateToday)) parts.push(clamp01(1 - data.chaseRateToday));
  if (isNum(data.whiffRateToday)) parts.push(clamp01(1 - data.whiffRateToday));
  if (isNum(data.zoneContactToday)) parts.push(clamp01(data.zoneContactToday));
  if (parts.length === 0) return null;
  return clamp01(parts.reduce((a, b) => a + b, 0) / parts.length);
}

// The following all require feeds with NO endpoint-accessible source today.
// They unconditionally return null — no proxy is permitted. Each accepts an
// optional `data` so a future PR can populate them without changing callers.

export function scorePitchTypeDamage(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real batter pitch-type damage splits (future feed)
}

export function scorePitcherPitchTypeVulnerability(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real pitcher pitch-type HR/barrel splits (future feed)
}

export function scoreZoneMistakeRisk(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real pitch-location / zone-mistake data (future feed)
}

export function scorePullAirIntent(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real spray-direction / pulled-air data (future feed)
}

export function scoreParkGeometryFit(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real park-sector geometry (future feed)
}

export function scoreWindSprayFit(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real spray direction + wind vector (future feed)
}

export function scoreCommandDeterioration(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real zone/location/command data (future feed)
}

export function scoreMarketConfirmation(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real live HR-prop odds movement (future feed)
}

export function scoreDriverCalibration(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires replay/backtest calibration buckets (future feed)
}

export function scoreUmpCatcherContext(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real ump zone / catcher framing data (future feed)
}

export function scoreSimilarityMatchup(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real similarity-archetype data (future feed)
}

export function scoreBatterFatigue(data?: unknown): Score01 | null {
  if (data == null) return null;
  return null; // requires real rest/travel/usage data (future feed)
}
