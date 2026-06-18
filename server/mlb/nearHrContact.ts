// [MLB Phase 2.5] Engine-owned near-HR contact detector.
//
// Surfaces high-quality contact events as HR Watch signals regardless of
// outcome (flyout, lineout, double, etc.). Pure function — no probability
// math, no I/O, no side effects. Caller decides what to do with the result
// AND owns all logging (per-AB diagnostics are returned for the caller to
// log under [MLB_HR_NEAR_CONTACT_EVAL] / [MLB_HR_NEAR_CONTACT_MISSED_PATTERN]).
//
// This is the SOLE source of truth for the spec's HR Watch thresholds.
// Do not duplicate these thresholds in liveEventInterpretation.ts (which
// uses looser EV>92 / dist>300 thresholds for its `nearHrScore` boost into
// the generic confidence stack — different purpose, kept intentionally).

export type NearHrTier = "watch" | "lean";

export type NearHrMatchedPath =
  | "WATCH"
  | "LEAN"
  | "HIGH_XBA_DANGER"
  | "HIGH_XBA_DANGER_BARREL"
  | "BARREL_OVERRIDE"
  | "BARREL_OVERRIDE_LEAN"
  | "REPEATED_DANGER"
  // "Almost HR" outcome-aware paths (composition only — Phase 2.5). These
  // key off the ACTUAL batted-ball OUTCOME (deep flyout, double/triple off
  // the wall, high-xBA hard out), which is among the strongest evidence a
  // batter homers in a later AB. They never touch engine probability.
  | "DEEP_FLYOUT_LEAN"
  | "DEEP_FLYOUT_WATCH"
  | "POWER_DOUBLE"
  | "POWER_TRIPLE"
  | "XBA_MISMATCH_DANGER";

export interface NearHrContactEvent {
  ev: number | null | undefined;
  la: number | null | undefined;
  distance: number | null | undefined;
  xba?: number | null | undefined;
  // Phase 2 STEP 5 — barrel override input. Statcast barrel flag from the
  // play feed (dataPullService writes `isBarrel` on each AB). Tags is a
  // free-form bag in case a future caller plumbs Savant batted-ball tags.
  isBarrel?: boolean | null | undefined;
  tags?: string[] | null | undefined;
  // "Almost HR" outcome inputs (optional — absent ⇒ outcome-aware paths are
  // skipped, so behavior is unchanged for callers that don't plumb these).
  // `outcome` is the AB result ("out" | "hit" | "home_run" | ...) and
  // `hitType` is the hit class ("single" | "double" | "triple" | "home_run").
  outcome?: string | null | undefined;
  hitType?: string | null | undefined;
}

export interface NearHrContactResult {
  tier: NearHrTier | null;
  drivers: string[];
  suppressionReason?: string;
  matchedPath?: NearHrMatchedPath | null;
}

export interface NearHrAbDiagnostic {
  abIndex: number;
  ev: number | null;
  la: number | null;
  distance: number | null;
  xba: number | null;
  isBarrel: boolean;
  detectedTier: NearHrTier | null;
  matchedPath: NearHrMatchedPath | null;
  rejectedReason: string | null;
  // True when the AB had HR-danger properties (ev>=97 with LA in [16,34]
  // and xba>=.6, OR isBarrel===true, OR dist>=365 with LA in [20,35]) but
  // the detector returned tier=null. Caller should log this under
  // [MLB_HR_NEAR_CONTACT_MISSED_PATTERN] for forensic audit.
  missedPattern: boolean;
}

export interface NearHrPeakResult extends NearHrContactResult {
  sourceAbIndex: number | null;
  // Phase 2 STEP 6 — repeated-danger across the window.
  repeatedDanger: boolean;
  // Phase 1 STEP 1 — per-AB diagnostics for the caller to log. Pure data;
  // ordered oldest→newest.
  diagnostics: NearHrAbDiagnostic[];
}

const DRIVERS_BASE = [
  "Near-HR contact",
  "Elite exit velocity",
  "Optimal launch angle",
  "Deep fly-ball distance",
];

const DRIVERS_HIGH_XBA = [
  "High-xBA HR danger contact",
  "Optimal launch angle",
  "Elite exit velocity",
];

const DRIVERS_HIGH_XBA_BARREL = [
  "Barrel + high-xBA danger",
  "Elite exit velocity",
  "Optimal launch angle",
];

const DRIVERS_BARREL = [
  "Statcast barrel",
  "Elite exit velocity",
];

const DRIVERS_REPEATED = [
  "Repeated HR-danger contact",
  "Elite exit velocity",
  "Pre-HR pattern",
];

// "Almost HR" driver labels — real evidence surfaced verbatim to the UI.
const DRIVERS_DEEP_FLYOUT = [
  "Deep warning-track flyout",
  "Elite exit velocity",
  "Optimal launch angle",
];

const DRIVERS_POWER_DOUBLE = [
  "Power double off the wall",
  "Elite exit velocity",
];

const DRIVERS_POWER_TRIPLE = [
  "Power triple off the wall",
  "Elite exit velocity",
];

const DRIVERS_XBA_MISMATCH = [
  "High-xBA hard out (robbed contact)",
  "Quality contact suppressed by outcome",
];

// Deep-fly distance floor — mirrors DEEP_FLY_DISTANCE in HRSignalBuilder.ts so
// the "almost HR" deep-flyout watch threshold stays consistent across layers.
const DEEP_FLY_DISTANCE = 330;

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function tagSaysBarrel(tags: string[] | null | undefined): boolean {
  if (!tags || !tags.length) return false;
  for (const t of tags) {
    const s = String(t).toLowerCase();
    if (s === "barrel" || s === "brl" || s === "barrel true" || s.includes("barrel")) return true;
  }
  return false;
}

function isBarrelEvent(ev: NearHrContactEvent): boolean {
  if (ev.isBarrel === true) return true;
  return tagSaysBarrel(ev.tags);
}

function normStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s.length ? s : null;
}

function isOutOutcome(ev: NearHrContactEvent): boolean {
  const o = normStr(ev.outcome);
  // Treat plain outs and uncategorized batted balls as "out" for almost-HR
  // purposes; never treat an actual HR or a categorized hit as an out.
  if (o === null) return false;
  if (o.includes("home") || o === "hr" || o === "homerun" || o === "home_run") return false;
  return o === "out" || o === "other";
}

function normHitType(ev: NearHrContactEvent): "single" | "double" | "triple" | "home_run" | null {
  const h = normStr(ev.hitType);
  if (h === "double" || h === "triple" || h === "single") return h;
  if (h === "home_run" || h === "homerun" || h === "home run" || h === "hr") return "home_run";
  return null;
}

/**
 * "Almost HR" outcome-aware detection (Phase 2.5, composition only). Runs AFTER
 * the contact-quality ladder so a true LEAN/WATCH always wins; only adds NEW
 * catches the outcome reveals: deep warning-track flyouts, doubles/triples off
 * the wall, and high-xBA hard outs ("robbed"). Returns null when no outcome
 * data is plumbed or none of the patterns match. Never consults probability.
 */
function detectAlmostHr(
  event: NearHrContactEvent,
  ev: number,
  la: number,
  distance: number,
  xba: number | null,
): NearHrContactResult | null {
  const hitType = normHitType(event);
  const isOut = isOutOutcome(event);

  // Deep warning-track flyout — a ball that died at the track is a near-miss HR.
  if (isOut) {
    if (distance >= 360 && la >= 20 && la <= 35 && ev >= 95) {
      return { tier: "lean", drivers: [...DRIVERS_DEEP_FLYOUT], matchedPath: "DEEP_FLYOUT_LEAN" };
    }
    if (distance >= DEEP_FLY_DISTANCE && la >= 18 && la <= 40 && ev >= 92) {
      return { tier: "watch", drivers: [...DRIVERS_DEEP_FLYOUT], matchedPath: "DEEP_FLYOUT_WATCH" };
    }
  }

  // Double / triple off the wall — extra-base power that just missed clearing.
  if ((hitType === "double" || hitType === "triple") && ev >= 94 && distance >= 350) {
    return hitType === "triple"
      ? { tier: "watch", drivers: [...DRIVERS_POWER_TRIPLE], matchedPath: "POWER_TRIPLE" }
      : { tier: "watch", drivers: [...DRIVERS_POWER_DOUBLE], matchedPath: "POWER_DOUBLE" };
  }

  // High-xBA hard out — quality contact the box score buried as an out.
  if (isOut && xba !== null && xba >= 0.65 && ev >= 95) {
    return { tier: "watch", drivers: [...DRIVERS_XBA_MISMATCH], matchedPath: "XBA_MISMATCH_DANGER" };
  }

  return null;
}

/**
 * Detect whether a single contact event qualifies as HR Watch.
 *
 * Detection ladder (first match wins, strongest tier):
 *   1. LEAN          — EV>=102, LA in [20,32], dist>=375 (xBA>=.5 if provided)
 *   2. WATCH         — EV>=98,  LA in [20,35], dist>=350
 *   3. HIGH_XBA_DANGER (Phase 2 STEP 4) — xBA>=.650, EV>=96, LA in [16,34]
 *      → tier=watch (or lean if isBarrel)
 *   4. BARREL_OVERRIDE (Phase 2 STEP 5) — isBarrel===true (or barrel tag)
 *      → tier=watch (or lean if EV>=100 + LA in [20,35])
 *
 * Result outcome (hit/out/flyout) is intentionally NOT consulted. A 102.9
 * EV / 24 LA / 392 ft flyout (Vientos case) qualifies as LEAN. A 100.6 EV
 * / 26 LA / 374 ft barrel with xBA .750 (Ben Rice case) qualifies as LEAN
 * via HIGH_XBA_DANGER + barrel.
 */
export function detectNearHrContact(event: NearHrContactEvent): NearHrContactResult {
  const ev = isFiniteNum(event.ev) ? event.ev : null;
  const la = isFiniteNum(event.la) ? event.la : null;
  const distance = isFiniteNum(event.distance) ? event.distance : null;
  const xba = isFiniteNum(event.xba) ? event.xba : null;
  const barrel = isBarrelEvent(event);

  if (ev === null || la === null || distance === null) {
    // Even with missing distance/LA, a hard-coded barrel tag is enough to
    // emit at least WATCH (Phase 2 STEP 5). Statcast barrel flag is itself
    // a high-EV/optimal-LA derivative — trusting it is the whole point.
    if (barrel && ev !== null && ev >= 100 && la !== null && la >= 20 && la <= 35) {
      return { tier: "lean", drivers: [...DRIVERS_BARREL], matchedPath: "BARREL_OVERRIDE_LEAN" };
    }
    if (barrel) {
      return { tier: "watch", drivers: [...DRIVERS_BARREL], matchedPath: "BARREL_OVERRIDE" };
    }
    return { tier: null, drivers: [], suppressionReason: "missing_statcast", matchedPath: null };
  }

  // 1. LEAN
  const meetsLean =
    ev >= 102 &&
    la >= 20 && la <= 32 &&
    distance >= 375 &&
    (xba === null || xba >= 0.5);
  if (meetsLean) {
    return { tier: "lean", drivers: [...DRIVERS_BASE], matchedPath: "LEAN" };
  }

  // 2. WATCH
  const meetsWatch =
    ev >= 98 &&
    la >= 20 && la <= 35 &&
    distance >= 350;
  if (meetsWatch) {
    // If this watch is ALSO a barrel, surface as lean — barrel + EV>=98
    // + LA 20-35 + dist>=350 is a textbook HR-shaped batted ball even
    // when distance falls just shy of the 375 ft LEAN gate.
    if (barrel) {
      return { tier: "lean", drivers: [...DRIVERS_BARREL], matchedPath: "BARREL_OVERRIDE_LEAN" };
    }
    return { tier: "watch", drivers: [...DRIVERS_BASE], matchedPath: "WATCH" };
  }

  // 3. HIGH_XBA_DANGER (Phase 2 STEP 4)
  const meetsHighXba =
    xba !== null && xba >= 0.65 &&
    ev >= 96 &&
    la >= 16 && la <= 34;
  if (meetsHighXba) {
    if (barrel) {
      return { tier: "lean", drivers: [...DRIVERS_HIGH_XBA_BARREL], matchedPath: "HIGH_XBA_DANGER_BARREL" };
    }
    return { tier: "watch", drivers: [...DRIVERS_HIGH_XBA], matchedPath: "HIGH_XBA_DANGER" };
  }

  // 4. BARREL_OVERRIDE (Phase 2 STEP 5)
  if (barrel) {
    if (ev >= 100 && la >= 20 && la <= 35) {
      return { tier: "lean", drivers: [...DRIVERS_BARREL], matchedPath: "BARREL_OVERRIDE_LEAN" };
    }
    return { tier: "watch", drivers: [...DRIVERS_BARREL], matchedPath: "BARREL_OVERRIDE" };
  }

  // 5. "Almost HR" outcome-aware paths (deep flyout / power double-triple /
  //    high-xBA hard out). Only adds catches the contact ladder above missed.
  const almostHr = detectAlmostHr(event, ev, la, distance, xba);
  if (almostHr) {
    return almostHr;
  }

  const closeToWatch =
    ev >= 95 &&
    la >= 18 && la <= 38 &&
    distance >= 320;
  if (closeToWatch) {
    return {
      tier: null,
      drivers: [],
      suppressionReason: `below_watch_threshold ev=${ev} la=${la} dist=${distance}`,
      matchedPath: null,
    };
  }

  return { tier: null, drivers: [], matchedPath: null };
}

/**
 * Phase 1 STEP 1 — was this AB an HR-danger setup that we missed?
 * Consulted ONLY for diagnostics (the caller logs it). Never affects the
 * tier returned by detectNearHrContact.
 */
function isMissedDangerPattern(ev: NearHrContactEvent, tier: NearHrTier | null): boolean {
  if (tier !== null) return false;
  const e = isFiniteNum(ev.ev) ? ev.ev : null;
  const l = isFiniteNum(ev.la) ? ev.la : null;
  const d = isFiniteNum(ev.distance) ? ev.distance : null;
  const x = isFiniteNum(ev.xba) ? ev.xba : null;
  if (isBarrelEvent(ev)) return true;
  if (e !== null && e >= 97 && l !== null && l >= 16 && l <= 34 && x !== null && x >= 0.6) return true;
  if (d !== null && d >= 365 && l !== null && l >= 20 && l <= 35) return true;
  return false;
}

/**
 * Scan the last N at-bats (most-recent first) and return the STRONGEST
 * near-HR tier seen across the window. Fixes a real-world miss: AB#3 was a
 * textbook lean (104.4 EV / 24° / 382 ft / barrel) but AB#4 was a flat
 * 99.6 mph 6° liner — looking only at AB#4 returned tier=null and the
 * engine "forgot" the lean signal, so the player stayed at peak score 0
 * and the eventual HR was graded uncalled.
 *
 * Phase 2 STEP 6 (Ben Rice repair, May 2026) — added repeated-danger
 * promotion across the window:
 *   if >=2 hard contacts AND >=1 elite signal in window
 *   then tier=lean, repeatedDanger=true
 * "hard contact"  = EV>=95 with LA in [15,35] OR xBA>=.6
 * "elite signal"  = EV>=100 OR xBA>=.65 OR isBarrel===true OR distance>=365
 *
 * This catches the Ben Rice pattern:
 *   AB1: 97.9 EV / 18 LA / 292 ft / xBA .680  → hard (xBA>=.6)
 *   AB2: 100.6 EV / 26 LA / 374 ft / barrel / xBA .750
 *        → both hard AND elite (EV>=100, xBA>=.65, isBarrel)
 * Two hards + one elite → repeated_danger → lean.
 *
 * Returns:
 *   - tier (lean wins over watch over null)
 *   - drivers
 *   - sourceAbIndex (most recent qualifying AB)
 *   - repeatedDanger flag
 *   - diagnostics[] for the caller to log (oldest→newest)
 */
export function detectNearHrContactPeak(
  events: NearHrContactEvent[],
  windowSize = 7,
): NearHrPeakResult {
  if (!events || events.length === 0) {
    return {
      tier: null,
      drivers: [],
      suppressionReason: "no_at_bat",
      sourceAbIndex: null,
      repeatedDanger: false,
      diagnostics: [],
      matchedPath: null,
    };
  }

  const start = Math.max(0, events.length - windowSize);
  // Build per-AB diagnostics (oldest→newest within window).
  const diagnostics: NearHrAbDiagnostic[] = [];
  for (let i = start; i < events.length; i++) {
    const e = events[i];
    const r = detectNearHrContact(e);
    diagnostics.push({
      abIndex: i,
      ev: isFiniteNum(e.ev) ? e.ev : null,
      la: isFiniteNum(e.la) ? e.la : null,
      distance: isFiniteNum(e.distance) ? e.distance : null,
      xba: isFiniteNum(e.xba) ? e.xba : null,
      isBarrel: isBarrelEvent(e),
      detectedTier: r.tier,
      matchedPath: r.matchedPath ?? null,
      rejectedReason: r.tier === null ? (r.suppressionReason ?? null) : null,
      missedPattern: isMissedDangerPattern(e, r.tier),
    });
  }

  // Phase 2 STEP 6 — repeated-danger pass across the window.
  let hardCount = 0;
  let eliteCount = 0;
  let lastEliteIdx: number | null = null;
  for (const d of diagnostics) {
    const e = isFiniteNum(d.ev) ? d.ev : null;
    const l = isFiniteNum(d.la) ? d.la : null;
    const dist = isFiniteNum(d.distance) ? d.distance : null;
    const x = isFiniteNum(d.xba) ? d.xba : null;
    // "Almost HR" outcome paths count as danger in the window: a deep flyout
    // or extra-base power that just missed clearing is real pre-HR evidence.
    const almostPath = d.matchedPath;
    const isAlmostHard =
      almostPath === "DEEP_FLYOUT_LEAN" ||
      almostPath === "DEEP_FLYOUT_WATCH" ||
      almostPath === "POWER_DOUBLE" ||
      almostPath === "POWER_TRIPLE" ||
      almostPath === "XBA_MISMATCH_DANGER";
    const isAlmostElite =
      almostPath === "DEEP_FLYOUT_LEAN" || almostPath === "POWER_TRIPLE";
    const isHard =
      (e !== null && e >= 95 && l !== null && l >= 15 && l <= 35) ||
      (x !== null && x >= 0.6) ||
      isAlmostHard;
    const isElite =
      (e !== null && e >= 100) ||
      (x !== null && x >= 0.65) ||
      d.isBarrel ||
      (dist !== null && dist >= 365) ||
      isAlmostElite;
    if (isHard) hardCount += 1;
    if (isElite) {
      eliteCount += 1;
      lastEliteIdx = d.abIndex;
    }
  }
  const repeatedDanger = hardCount >= 2 && eliteCount >= 1;

  // EV acceleration detection: rising exit velocity across sequential ABs is a
  // leading indicator not captured by static per-AB thresholds.
  // Fires a weak repeatedDanger (watch tier only, not lean) when the last 2 ABs
  // both qualify (EV >= 92) and their average exceeds the prior 2 ABs' average by >= 3 mph.
  let evAcceleration = false;
  if (!repeatedDanger && diagnostics.length >= 4) {
    const last2 = diagnostics.slice(-2);
    const prior2 = diagnostics.slice(-4, -2);
    const last2EVs = last2.map(d => d.ev ?? 0);
    const prior2EVs = prior2.map(d => d.ev ?? 0);
    const bothRecentQualify = last2.every(d => (d.ev ?? 0) >= 92);
    const recentAvg = (last2EVs[0] + last2EVs[1]) / 2;
    const priorAvg = (prior2EVs[0] + prior2EVs[1]) / 2;
    if (bothRecentQualify && recentAvg - priorAvg >= 3.0) {
      evAcceleration = true;
    }
  }

  // Walk newest→oldest for the per-AB strongest tier (lean wins).
  let bestTier: NearHrTier | null = null;
  let bestDrivers: string[] = [];
  let bestIdx: number | null = null;
  let bestPath: NearHrMatchedPath | null = null;
  for (let i = events.length - 1; i >= start; i--) {
    const r = detectNearHrContact(events[i]);
    if (r.tier === "lean") {
      bestTier = "lean";
      bestDrivers = r.drivers;
      bestIdx = i;
      bestPath = r.matchedPath ?? "LEAN";
      break;
    }
    if (r.tier === "watch" && bestTier === null) {
      bestTier = "watch";
      bestDrivers = r.drivers;
      bestIdx = i;
      bestPath = r.matchedPath ?? "WATCH";
    }
  }

  // Repeated-danger overrides single-AB watch into a window-wide lean.
  // Never demotes a per-AB lean.
  if (repeatedDanger && bestTier !== "lean") {
    return {
      tier: "lean",
      drivers: [...DRIVERS_REPEATED],
      sourceAbIndex: lastEliteIdx ?? bestIdx,
      repeatedDanger: true,
      diagnostics,
      matchedPath: "REPEATED_DANGER",
    };
  }

  if (bestTier) {
    return {
      tier: bestTier,
      drivers: bestDrivers,
      sourceAbIndex: bestIdx,
      repeatedDanger,
      diagnostics,
      matchedPath: bestPath,
    };
  }

  // EV acceleration: rising exit velocity without a qualifying individual AB.
  // Only promotes to watch (not lean) — a precursor signal, not a confirmed danger.
  if (evAcceleration) {
    return {
      tier: "watch",
      drivers: ["Exit velocity accelerating — rising contact quality"],
      sourceAbIndex: events.length - 1,
      repeatedDanger: false,
      diagnostics,
      matchedPath: "WATCH",
    };
  }

  // Fall back to the suppression reason of the most recent AB so the
  // existing [MLB_HR_WATCH_SUPPRESSED] diagnostics path keeps firing.
  const lastResult = detectNearHrContact(events[events.length - 1]);
  return {
    tier: null,
    drivers: [],
    suppressionReason: lastResult.suppressionReason,
    sourceAbIndex: null,
    repeatedDanger,
    diagnostics,
    matchedPath: null,
  };
}
