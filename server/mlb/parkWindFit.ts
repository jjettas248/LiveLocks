/**
 * MLB Shared Park / Wind / Player-Fit Module
 * ===========================================
 *
 * One canonical place to answer: "given THIS hitter, does the current park
 * geometry and wind actually fit his handedness and pull/spray profile — or is
 * it neutral noise?"
 *
 * SHARED by design: HR Radar (live, PR1) and Pre-Game Power Radar (display, PR2)
 * both consume the SAME output. No duplicated park/wind math anywhere else.
 *
 * Hard guarantees (so it can never destabilize runtime):
 *  - PURE: no I/O, no caches, no clock. Deterministic for a given input.
 *  - ADDITIVE & no-op when data is missing: a missing venue, missing wind, or
 *    missing player spray ALWAYS collapses to a neutral 1.0 multiplier. It never
 *    invents a fit it cannot justify from real data.
 *  - BOUNDED: the player-fit multiplier is clamped to [FIT_MIN, FIT_MAX] so a
 *    single feature can never swing the per-PA HR rate past the engine's caps.
 *    It is a *supporting modifier on top of* the engine's existing generic
 *    environment multiplier — never a standalone trigger.
 *  - DISPLAY-READY: emits emoji + qualitative label + short explanation so the
 *    Pre-Game UI (PR2) renders verbatim without re-deriving model logic.
 *
 * Covers EVERY MLB venue the game feed returns (via the canonical park registry
 * in dataSources.ts + alias resolution), with a neutral fallback for unknown /
 * temporary / alternate venues. Players are handled DYNAMICALLY from their own
 * data (batter hand, pull rate, archetype) — never hardcoded by name.
 */

import { getVenueParkFactors, getStadiumCoords, isVenueIndoors } from "./dataSources";

// ── Bounds ───────────────────────────────────────────────────────────────────
// Tight, intentional clamp. The directional fit alone tops out near +7% and the
// suppression near -7%; Phase 1.5 caps still bind above this.
export const FIT_MIN = 0.93;
export const FIT_MAX = 1.07;

// ── Public types ───────────────────────────────────────────────────────────--
export type WindSector = "LF" | "CF" | "RF" | "IN" | "CROSS" | "CALM" | "UNKNOWN";
export type WindBlowing = "out" | "in" | "cross" | "calm" | "unknown";
export type FitClassification = "boost" | "suppress" | "neutral" | "unknown";
export type FitConfidence = "high" | "medium" | "low" | "none";

/** A resolved park profile — full registry coverage + neutral unknown fallback. */
export interface ParkWindProfile {
  venueName: string | null;
  resolved: boolean;        // matched a known venue (directly or via alias)
  isFallback: boolean;      // unknown/temporary venue → neutral fallback
  isIndoors: boolean;
  orientation: number | null; // home-plate→CF compass bearing (deg), null if unknown
  hrFactor: number;           // overall HR park factor (1.0 = neutral)
  hrLHB: number | null;       // HR park factor for LHB (short-porch geometry)
  hrRHB: number | null;       // HR park factor for RHB
  pullShortSide: "LF" | "RF" | null; // HR-friendly pull-side corner, if any
  classification: FitClassification; // park-geometry class: boost | suppress | neutral
}

/** A resolved wind vector relative to the field, with a confidence in the mapping. */
export interface WindVector {
  sector: WindSector;
  blowing: WindBlowing;
  confidence: FitConfidence;
  speedMph: number | null;
}

export interface PlayerParkWindFitInput {
  venueName?: string | null;
  batterHand?: string | null;       // "L" | "R" | "S"
  pullRatePercent?: number | null;  // % of BIP to pull side (real spray evidence)
  batterArchetype?: string | null;  // spray fallback when pull% missing
  // Wind sources — supply whatever the feed has; richer source wins.
  windString?: string | null;       // MLB feed raw, e.g. "12 mph, Out To LF"
  windDegrees?: number | null;      // meteorological bearing the wind blows FROM
  windDirectionCoarse?: "in" | "out" | "cross" | "calm" | null; // collapsed cache value
  windSpeedMph?: number | null;
  fieldOrientation?: number | null; // override; else derived from venue registry
  isIndoors?: boolean;              // override; else derived from venue registry
}

export interface PlayerParkWindFit {
  fitMultiplier: number;            // bounded [FIT_MIN, FIT_MAX], centered at 1.0
  classification: FitClassification;
  confidence: FitConfidence;
  windSector: WindSector;
  windBlowing: WindBlowing;
  windSpeedMph: number | null;
  emoji: string;
  label: string;                    // qualitative label (UI renders verbatim)
  explanation: string;              // short human explanation
  components: {
    broad: number;                  // hand-agnostic carry
    directional: number;            // pull-vs-sector fit
    geometry: number;               // short-porch park bonus
    suppression: number;            // wind-in penalty (negative)
  };
  park: ParkWindProfile;
}

// ── Park registry resolution ─────────────────────────────────────────────────

const NEUTRAL_FALLBACK_PROFILE = (venueName: string | null): ParkWindProfile => ({
  venueName: venueName ?? null,
  resolved: false,
  isFallback: true,
  isIndoors: false,
  orientation: null,
  hrFactor: 1.0,
  hrLHB: null,
  hrRHB: null,
  pullShortSide: null,
  classification: "neutral",
});

/**
 * Resolve a venue (by canonical name, alias, or fuzzy match in dataSources) into
 * a park-wind profile. Unknown / temporary / alternate venues return a neutral
 * fallback — never a crash, never an invented geometry.
 */
export function getParkWindProfile(venueName: string | null | undefined): ParkWindProfile {
  if (!venueName) return NEUTRAL_FALLBACK_PROFILE(null);

  const factors = getVenueParkFactors(venueName);
  const coords = getStadiumCoords(venueName);
  if (!factors) {
    // Unknown venue: still surface orientation if coords happened to fuzzy-match,
    // but keep park geometry strictly neutral (we have no real factor for it).
    const fb = NEUTRAL_FALLBACK_PROFILE(venueName);
    fb.orientation = coords?.orientation ?? null;
    fb.isIndoors = isVenueIndoors(venueName);
    return fb;
  }

  const hrLHB = factors.hrLHB ?? null;
  const hrRHB = factors.hrRHB ?? null;

  // Short-porch geometry: a park markedly friendlier to one hand's HR implies a
  // short pull-side corner. LHB pull → RF; RHB pull → LF. Require both a high
  // absolute factor AND a clear split so a flat park stays null.
  let pullShortSide: "LF" | "RF" | null = null;
  if (hrLHB != null && hrRHB != null) {
    if (hrLHB >= 1.12 && hrLHB - hrRHB >= 0.08) pullShortSide = "RF";
    else if (hrRHB >= 1.12 && hrRHB - hrLHB >= 0.08) pullShortSide = "LF";
  }

  let classification: FitClassification = "neutral";
  if (factors.hr >= 1.08) classification = "boost";
  else if (factors.hr <= 0.93) classification = "suppress";

  return {
    venueName,
    resolved: true,
    isFallback: false,
    isIndoors: factors.isIndoors,
    orientation: coords?.orientation ?? null,
    hrFactor: factors.hr,
    hrLHB,
    hrRHB,
    pullShortSide,
    classification,
  };
}

// ── Wind vector resolution ───────────────────────────────────────────────────

function speedScale(speed: number | null): number {
  if (speed == null) return 0.6;           // unknown speed → assume mild
  if (speed < 4) return 0;                  // effectively calm
  if (speed < 8) return 0.5;
  if (speed < 12) return 0.8;
  return 1.0;                               // 12+ mph
}

/**
 * Map the MLB feed's free-text wind string ("12 mph, Out To LF", "R To L",
 * "Calm", "In From RF") into a field-relative vector. This is the HIGH-confidence
 * path because the feed already states the sector explicitly.
 */
function parseWindString(raw: string): WindVector | null {
  const lower = raw.toLowerCase();
  const speedMatch = raw.match(/(\d+(?:\.\d+)?)/);
  const speedMph = speedMatch ? parseFloat(speedMatch[1]) : null;

  if (lower.includes("calm") || lower.includes("none") || lower.includes("still")) {
    return { sector: "CALM", blowing: "calm", confidence: "high", speedMph };
  }
  if (speedMph != null && speedMph < 4) {
    return { sector: "CALM", blowing: "calm", confidence: "high", speedMph };
  }

  const toLeft = /(to|toward)\s*(lf|left)/.test(lower);
  const toRight = /(to|toward)\s*(rf|right)/.test(lower);
  const toCenter = /(to|toward)\s*(cf|cen)/.test(lower);

  if (lower.includes("out")) {
    if (toLeft) return { sector: "LF", blowing: "out", confidence: "high", speedMph };
    if (toRight) return { sector: "RF", blowing: "out", confidence: "high", speedMph };
    if (toCenter) return { sector: "CF", blowing: "out", confidence: "high", speedMph };
    return { sector: "CF", blowing: "out", confidence: "medium", speedMph }; // "out" w/o sector
  }
  if (lower.includes("in")) {
    return { sector: "IN", blowing: "in", confidence: "high", speedMph };
  }
  // "L To R" / "R To L" / generic cross
  if (/\bl\s*to\s*r\b/.test(lower) || /\br\s*to\s*l\b/.test(lower) || lower.includes("cross")) {
    return { sector: "CROSS", blowing: "cross", confidence: "high", speedMph };
  }
  return null;
}

/**
 * Compute a field-relative sector from a meteorological wind bearing + the park's
 * home-plate→CF orientation. MEDIUM confidence (degrees can straddle a boundary).
 *
 * Convention: windDegrees is the bearing the wind blows FROM. The direction it
 * blows TOWARD, expressed relative to CF, is T = (windDegrees + 180 - orientation)
 * folded into (-180, 180]. T≈0 → out to CF; T>0 → toward RF (clockwise of CF);
 * T<0 → toward LF; |T|≈180 → straight in.
 */
function windVectorFromDegrees(
  windDegrees: number,
  orientation: number,
  speedMph: number | null,
): WindVector {
  if (speedMph != null && speedMph < 4) {
    return { sector: "CALM", blowing: "calm", confidence: "medium", speedMph };
  }
  let t = (windDegrees + 180 - orientation) % 360;
  if (t > 180) t -= 360;
  if (t <= -180) t += 360;
  const a = Math.abs(t);

  if (a >= 135) return { sector: "IN", blowing: "in", confidence: "medium", speedMph };
  if (a > 75) return { sector: "CROSS", blowing: "cross", confidence: "medium", speedMph };
  if (a <= 30) return { sector: "CF", blowing: "out", confidence: "medium", speedMph };
  // 30 < |t| <= 75 → a real outfield corner
  return { sector: t > 0 ? "RF" : "LF", blowing: "out", confidence: "medium", speedMph };
}

/**
 * Resolve the best available wind vector. Richest source wins:
 *   1. MLB feed wind string (states the sector) — high confidence
 *   2. meteorological degrees + park orientation — medium confidence
 *   3. collapsed coarse direction (in/out/cross/calm) — LOW confidence, no corner
 *   4. nothing → unknown
 */
export function resolveWindVector(
  input: PlayerParkWindFitInput,
  orientation: number | null,
): WindVector {
  const speed = input.windSpeedMph ?? null;

  if (input.windString && input.windString.trim()) {
    const v = parseWindString(input.windString);
    if (v) return { ...v, speedMph: v.speedMph ?? speed };
  }

  if (input.windDegrees != null && orientation != null) {
    return windVectorFromDegrees(input.windDegrees, orientation, speed);
  }

  const c = input.windDirectionCoarse;
  if (c === "calm") return { sector: "CALM", blowing: "calm", confidence: "low", speedMph: speed };
  if (c === "in") return { sector: "IN", blowing: "in", confidence: "low", speedMph: speed };
  if (c === "cross") return { sector: "CROSS", blowing: "cross", confidence: "low", speedMph: speed };
  // coarse "out" has NO corner — broad-only, low confidence
  if (c === "out") return { sector: "CF", blowing: "out", confidence: "low", speedMph: speed };

  return { sector: "UNKNOWN", blowing: "unknown", confidence: "none", speedMph: speed };
}

// ── Player pull-strength resolution ──────────────────────────────────────────

const POWER_PULL_ARCHETYPES = new Set(["elite_power", "power_first"]);

/**
 * Turn available spray evidence into a 0..1 pull strength, or null when there is
 * genuinely no signal. Real pull% wins; an explicit power archetype is a mild
 * fallback; otherwise null (we DO NOT invent a pull tendency).
 */
function resolvePullStrength(
  pullRatePercent: number | null | undefined,
  archetype: string | null | undefined,
): number | null {
  if (pullRatePercent != null && Number.isFinite(pullRatePercent)) {
    // 35% pull ≈ league-ish → 0; 55%+ → 1.0
    return Math.max(0, Math.min(1, (pullRatePercent - 35) / 20));
  }
  if (archetype && POWER_PULL_ARCHETYPES.has(archetype)) return 0.5;
  return null;
}

function clampFit(m: number): number {
  return Math.max(FIT_MIN, Math.min(FIT_MAX, m));
}

const NEUTRAL = (
  profile: ParkWindProfile,
  vector: WindVector,
  emoji: string,
  label: string,
  explanation: string,
  classification: FitClassification = "neutral",
): PlayerParkWindFit => ({
  fitMultiplier: 1.0,
  classification,
  confidence: vector.confidence,
  windSector: vector.sector,
  windBlowing: vector.blowing,
  windSpeedMph: vector.speedMph,
  emoji,
  label,
  explanation,
  components: { broad: 0, directional: 0, geometry: 0, suppression: 0 },
  park: profile,
});

// ── Main entry point ─────────────────────────────────────────────────────────

const HAND_LABEL: Record<string, string> = { L: "LHH", R: "RHH" };

/**
 * Compute the player-specific park/wind fit. Returns a bounded multiplier (a
 * supporting modifier on top of the engine's generic environment term) plus a
 * display contract. Neutral (1.0) whenever player or mapping data is missing.
 */
export function computePlayerParkWindFit(input: PlayerParkWindFitInput): PlayerParkWindFit {
  const profile = getParkWindProfile(input.venueName);
  const orientation = input.fieldOrientation ?? profile.orientation;
  const vector = resolveWindVector(input, orientation);
  const indoors = input.isIndoors ?? profile.isIndoors;

  // Roof closed → wind is irrelevant; neutral carry.
  if (indoors) {
    return NEUTRAL(profile, vector, "🏟️", "Roof closed · neutral carry",
      "Indoor/closed roof — wind does not affect carry.");
  }

  // Player-specific fit requires knowing the batter's hand. Unknown hand (or
  // switch hitter with no resolvable pull side) → no invented fit.
  const hand = (input.batterHand ?? "").toUpperCase();
  if (hand !== "L" && hand !== "R") {
    return NEUTRAL(profile, vector, "❔", "Park/wind fit unavailable",
      "Batter handedness unknown — cannot compute player-specific fit.", "unknown");
  }
  const handLabel = HAND_LABEL[hand];

  // Low-confidence (collapsed coarse direction) or absent wind data: the engine's
  // generic environment term already handles broad in/out carry. This module only
  // REFINES when it can confidently map a real outfield sector (MLB feed text or a
  // bearing + orientation), so defer (neutral) here — never double-count the wind.
  if (vector.confidence === "low" || vector.confidence === "none") {
    if (vector.blowing === "unknown") {
      return NEUTRAL(profile, vector, "❔", "Park/wind data unavailable",
        "No usable directional wind data — neutral.", "unknown");
    }
    return NEUTRAL(profile, vector, "🏟️", "Wind mapping low-confidence · neutral",
      "Wind direction not confidently mapped to a sector — neutral.");
  }

  switch (vector.blowing) {
    case "in": {
      const s = speedScale(vector.speedMph);
      const suppression = s >= 0.99 ? -0.05 : s >= 0.79 ? -0.03 : s > 0 ? -0.01 : 0;
      if (suppression === 0) {
        return NEUTRAL(profile, vector, "🏟️", "Light wind in · neutral",
          "Wind blowing in but too light to suppress carry.");
      }
      return {
        ...NEUTRAL(profile, vector, "⚠️", "Wind blowing in · carry suppressed",
          `Wind into the park suppresses fly-ball carry for ${handLabel}.`, "suppress"),
        fitMultiplier: clampFit(1 + suppression),
        components: { broad: 0, directional: 0, geometry: 0, suppression },
      };
    }

    case "cross": {
      // Crosswind never creates a strong boost unless we can confidently map it
      // to a real out-sector (which, by definition, "cross" is not).
      return NEUTRAL(profile, vector, "↔️", "Crosswind · mostly neutral",
        "Crosswind — no confident pull-side carry effect.");
    }

    case "calm": {
      return NEUTRAL(profile, vector, "🏟️", "Calm · neutral carry",
        "Calm conditions — no wind carry effect.");
    }

    case "out": {
      const scale = speedScale(vector.speedMph);

      // Out to CF → broad, hand-agnostic carry. Does not require spray data.
      if (vector.sector === "CF") {
        const broad = 0.035 * scale;
        if (broad <= 0) {
          return NEUTRAL(profile, vector, "🏟️", "Light wind out · neutral",
            "Wind out to center but too light for a meaningful boost.");
        }
        return {
          ...NEUTRAL(profile, vector, "🌬️", "Out to CF · broad carry boost",
            `Wind out to center field — broad carry boost for ${handLabel}.`, "boost"),
          fitMultiplier: clampFit(1 + broad),
          components: { broad, directional: 0, geometry: 0, suppression: 0 },
        };
      }

      // Corner wind (LF / RF) → directional, requires real pull/spray evidence.
      // LHH pull to RF; RHH pull to LF.
      const favoredHand = vector.sector === "LF" ? "R" : "L";
      const pullStrength = resolvePullStrength(input.pullRatePercent, input.batterArchetype);

      if (pullStrength == null) {
        // Missing spray data on a directional wind → neutral (do not invent).
        return NEUTRAL(profile, vector, "🏟️", `Wind out to ${vector.sector} · spray data unavailable`,
          "Wind out to a corner but no pull/spray data — neutral.");
      }

      if (hand !== favoredHand) {
        // Wrong-side pull: the wind out to this corner does little for an
        // opposite-field-of-the-wind pull hitter. Small residual broad carry only.
        const broad = 0.015 * scale;
        return {
          ...NEUTRAL(profile, vector, "🌬️", `Out to ${vector.sector} · slight carry`,
            `Wind out to ${vector.sector}; ${handLabel} pulls the other way — slight carry only.`, broad > 0.005 ? "boost" : "neutral"),
          fitMultiplier: clampFit(1 + broad),
          components: { broad, directional: 0, geometry: 0, suppression: 0 },
        };
      }

      // Favored side: wind out to the pull-side corner for THIS hand. Scale by
      // pull strength; park HR-friendliness amplifies, pitcher parks dampen.
      let directional = 0.06 * pullStrength * scale;
      if (profile.classification === "boost") directional *= 1.15;
      else if (profile.classification === "suppress") directional *= 0.7;

      // Short-porch geometry bonus: the park's HR-friendly pull corner lines up
      // with both the wind and the hitter's pull side. Modifies, never replaces.
      let geometry = 0;
      let emoji = "🌬️";
      let label = `Out to ${vector.sector} · favors ${handLabel} pull power`;
      if (profile.pullShortSide === vector.sector) {
        geometry = 0.012;
        emoji = "🏟️";
        label = `Short ${vector.sector} fit · boosts ${handLabel} pull profile`;
      }

      const broad = 0; // directional already encompasses the carry on this side
      return {
        ...NEUTRAL(profile, vector, emoji, label,
          `Wind out to ${vector.sector} fits ${handLabel} pull profile (pull strength ${(pullStrength * 100).toFixed(0)}%).`, "boost"),
        fitMultiplier: clampFit(1 + broad + directional + geometry),
        components: { broad, directional, geometry, suppression: 0 },
      };
    }

    default: {
      return NEUTRAL(profile, vector, "❔", "Park/wind data unavailable",
        "No usable wind data — neutral.", "unknown");
    }
  }
}
