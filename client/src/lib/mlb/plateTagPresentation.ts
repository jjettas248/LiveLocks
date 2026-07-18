// Plate Radar tag/tone presentation — display-only visual hierarchy helpers.
//
// Pure, side-effect-free mapping from server-stamped values (driver keys/labels,
// BvP diagnostics fields, market setup labels, park/weather context + drivers)
// to a shared tone vocabulary and Tailwind classes. Never re-derives score10,
// tier, qualification, or any engine value — only formats what the server
// already computed.
//
// Deliberately uses minimal structural input types (not the component's
// PowerDriver/PregameDiagnostics interfaces) so this module has zero import
// dependency on PregamePowerRadar.tsx or any other component file — the
// component imports FROM here, never the reverse.

export type PlateTagTone = "standout" | "supporting" | "context" | "risk" | "neutral";

export type PlateTagCategory =
  | "power"
  | "pitcher"
  | "matchup"
  | "bvp"
  | "park"
  | "weather"
  | "lineup"
  | "market"
  | "form"
  | "warning"
  | "unknown";

export interface PlateTagPresentation {
  tone: PlateTagTone;
  category: PlateTagCategory;
  classes: string;
}

// ── Canonical tone → class palette. The ONLY place tone maps to color. ──────
const TONE_CLASSES: Record<PlateTagTone, string> = {
  standout: "bg-emerald-500/20 text-emerald-200 border-emerald-400/30 font-semibold",
  supporting: "bg-amber-500/15 text-amber-300 border-amber-500/25",
  context: "bg-sky-500/15 text-sky-300 border-sky-500/25",
  risk: "bg-rose-500/10 text-rose-300 border-rose-500/20",
  neutral: "bg-secondary text-muted-foreground border-border/40",
};

export function getPlateToneClasses(tone: PlateTagTone): string {
  return TONE_CLASSES[tone];
}

// ── §2: static tag → tone map ───────────────────────────────────────────────
// Exact-key entries first, exact-label entries second (label-only for tags with
// no stable key, e.g. warningTags strings and the day-keyed near-HR driver).
// fit_bvp / fit_bvp_bad are intentionally included here ONLY as a fallback for
// when full diagnostics context isn't available — the component always prefers
// getBvpPresentation()/getDriverPresentation() for these two keys.

interface TagEntry {
  tone: PlateTagTone;
  category: PlateTagCategory;
}

const KEY_MAP: Record<string, TagEntry> = {
  power_iso: { tone: "standout", category: "power" },
  power_hrfb: { tone: "standout", category: "power" },
  power_barrel: { tone: "supporting", category: "power" },
  power_hardhit: { tone: "supporting", category: "power" },
  power_maxev: { tone: "supporting", category: "power" },
  power_pullair: { tone: "supporting", category: "power" },
  power_low: { tone: "risk", category: "power" },

  pv_hr9: { tone: "supporting", category: "pitcher" },
  pv_era: { tone: "supporting", category: "pitcher" },
  pv_barrel: { tone: "supporting", category: "pitcher" },
  pv_stingy: { tone: "risk", category: "pitcher" },

  fit_platoon: { tone: "supporting", category: "matchup" },
  fit_ops_hand: { tone: "supporting", category: "matchup" },
  fit_pull_park: { tone: "supporting", category: "matchup" },
  // Fallback only — see note above.
  fit_bvp: { tone: "supporting", category: "bvp" },
  fit_bvp_bad: { tone: "risk", category: "bvp" },

  pw_roof: { tone: "context", category: "weather" },
  pw_wind_out: { tone: "supporting", category: "weather" },
  pw_wind_in: { tone: "risk", category: "weather" },
  pw_temp: { tone: "supporting", category: "weather" },
  pw_cold: { tone: "risk", category: "weather" },
  pw_park: { tone: "supporting", category: "park" },
  pw_park_pitcher: { tone: "risk", category: "park" },

  lo_top: { tone: "supporting", category: "lineup" },
  lo_rbi: { tone: "supporting", category: "lineup" },
  lo_bottom: { tone: "risk", category: "lineup" },
  lo_runenv: { tone: "supporting", category: "lineup" },
  lo_obp_ahead: { tone: "supporting", category: "lineup" },
  pos_batter_slot: { tone: "supporting", category: "lineup" },
  neg_batter_slot: { tone: "risk", category: "lineup" },
  pos_order_vuln: { tone: "supporting", category: "lineup" },
  neg_order_suppress: { tone: "risk", category: "lineup" },

  mkt_hr: { tone: "context", category: "market" },
  mkt_tb: { tone: "context", category: "market" },

  // Fixed key — the tiered near-HR driver uses a day-keyed key instead
  // (`near_hr_form_${dayKey}`), resolved via LABEL_MAP below.
  near_hr_form_consecutive: { tone: "standout", category: "form" },
};

const LABEL_MAP: Record<string, TagEntry> = {
  "Near-HR Contact (Strong)": { tone: "standout", category: "form" },
  "Near-HR Contact": { tone: "supporting", category: "form" },

  "Matchup Downgrade": { tone: "risk", category: "warning" },
  "Batter Power Only": { tone: "context", category: "warning" },
  "Needs Live Confirmation": { tone: "neutral", category: "warning" },
  // Fallback only — the component suppresses this string when the resolved
  // BvP row is already shown (diagnostics.bvpAvailable), so this entry is
  // only reached if that suppression doesn't apply.
  "Poor BvP History": { tone: "risk", category: "bvp" },
  "Pitcher Slot Suppression": { tone: "risk", category: "lineup" },
  "Weak From Lineup Slot": { tone: "risk", category: "lineup" },
};

const DIRECTION_FALLBACK: Record<"positive" | "negative" | "neutral", PlateTagTone> = {
  positive: "supporting",
  negative: "risk",
  neutral: "context",
};

export function getPlateTagPresentation(
  driverKeyOrLabel: string,
  direction: "positive" | "negative" | "neutral",
): PlateTagPresentation {
  const byKey = KEY_MAP[driverKeyOrLabel];
  if (byKey) return { ...byKey, classes: getPlateToneClasses(byKey.tone) };

  const byLabel = LABEL_MAP[driverKeyOrLabel];
  if (byLabel) return { ...byLabel, classes: getPlateToneClasses(byLabel.tone) };

  // Unrecognized tag: safe direction-based fallback. Never standout.
  const tone = DIRECTION_FALLBACK[direction];
  return { tone, category: "unknown", classes: getPlateToneClasses(tone) };
}

// ── §4: BvP resolver ─────────────────────────────────────────────────────────
// Confidence (sample size) and strength (direction) are separate axes. Positive
// direction never promotes to `standout` — there is no standout tier for BvP.

export interface BvpDiagnosticsInput {
  bvpAvailable: boolean;
  bvpSampleSize: number | null;
  bvpDirection: "positive" | "neutral" | "negative";
  /** Optional — absent on older/rehydrated diagnostics snapshots. */
  bvpHits?: number | null;
}

export interface BvpPresentation {
  tone: PlateTagTone;
  label: string;
  classes: string;
}

function buildBvpLabel(prefix: string, hits: number | null | undefined, sample: number): string {
  if (hits != null) return `${prefix} — ${hits} H in ${sample} AB`;
  return `${prefix} (${sample} AB)`;
}

export function getBvpPresentation(diag: BvpDiagnosticsInput): BvpPresentation | null {
  if (!diag.bvpAvailable || diag.bvpSampleSize == null) return null;

  const sample = diag.bvpSampleSize;
  const hits = diag.bvpHits;

  if (sample < 5) return null;

  if (sample <= 9) {
    const tone: PlateTagTone = "context";
    return { tone, label: buildBvpLabel("Limited BvP", hits, sample), classes: getPlateToneClasses(tone) };
  }

  if (diag.bvpDirection === "positive") {
    const tone: PlateTagTone = "supporting";
    return { tone, label: buildBvpLabel("Positive BvP", hits, sample), classes: getPlateToneClasses(tone) };
  }

  if (diag.bvpDirection === "negative") {
    const tone: PlateTagTone = "risk";
    return { tone, label: buildBvpLabel("Poor BvP", hits, sample), classes: getPlateToneClasses(tone) };
  }

  const tone: PlateTagTone = "neutral";
  return { tone, label: buildBvpLabel("Neutral BvP", hits, sample), classes: getPlateToneClasses(tone) };
}

// ── §5: market tier mapping ──────────────────────────────────────────────────

export type MarketSetupLabel = "Elite" | "Strong" | "Solid" | "Watch";

export interface MarketTierPresentation {
  displayLabel: string;
  tone: PlateTagTone;
  classes: string;
}

const MARKET_TIER_MAP: Record<MarketSetupLabel, { displayLabel: string; tone: PlateTagTone }> = {
  Elite: { displayLabel: "Prime", tone: "standout" },
  Strong: { displayLabel: "Qualified", tone: "supporting" },
  Solid: { displayLabel: "Solid", tone: "context" },
  Watch: { displayLabel: "Watch", tone: "neutral" },
};

export function getMarketTierPresentation(setupLabel?: MarketSetupLabel | null): MarketTierPresentation {
  const entry = (setupLabel && MARKET_TIER_MAP[setupLabel]) || MARKET_TIER_MAP.Watch;
  return { ...entry, classes: getPlateToneClasses(entry.tone) };
}

// ── §6: carry + weather ──────────────────────────────────────────────────────

export type CarryLabel =
  | "HR Carry"
  | "Carry Boost"
  | "Carry Suppressed"
  | "Neutral Air"
  | "Neutral Conditions"
  | "Conditions Unavailable";

export type CarryType = "boost" | "suppress" | "neutral" | "unknown";

/** Minimal structural shape — matches the fields this module needs from the
 * server-stamped park context, without importing the component's local type. */
export interface MinimalParkContext {
  temperatureF: number | null;
  windMph: number | null;
  windDirectionLabel: string | null;
  carryLabel: CarryLabel;
  carryType: CarryType;
}

/** Minimal structural shape for a driver — key + direction only. */
export interface MinimalDriver {
  key: string;
  direction: "positive" | "negative" | "neutral";
}

export interface CarryPresentation {
  tone: PlateTagTone;
  emoji: string;
  label: string;
  classes: string;
}

const CARRY_MAP: Record<CarryLabel, { emoji: string; tone: PlateTagTone }> = {
  "HR Carry": { emoji: "🔥", tone: "standout" },
  "Carry Boost": { emoji: "🌬️", tone: "supporting" },
  "Carry Suppressed": { emoji: "🧊", tone: "risk" },
  "Neutral Air": { emoji: "↔", tone: "context" },
  "Neutral Conditions": { emoji: "🏟️", tone: "neutral" },
  "Conditions Unavailable": { emoji: "🚫", tone: "neutral" },
};

export function getCarryPresentation(park: MinimalParkContext | null): CarryPresentation {
  const entry = (park && CARRY_MAP[park.carryLabel]) || CARRY_MAP["Conditions Unavailable"];
  const label = park?.carryLabel ?? "Conditions Unavailable";
  return { tone: entry.tone, emoji: entry.emoji, label, classes: getPlateToneClasses(entry.tone) };
}

export interface WeatherSecondaryPresentation {
  text: string;
  tone: PlateTagTone;
  classes: string;
}

/**
 * Secondary environment pills (temperature / wind / roof), built from the
 * driver array so wind/temp tone reflects which directional driver actually
 * fired (pw_wind_out/pw_wind_in/pw_temp/pw_cold) rather than being re-derived
 * from raw numbers. Roof-closed detection primarily uses the `pw_roof` driver
 * key; `carryLabel === "Neutral Air"` is only a documented fallback if that
 * driver is somehow absent.
 */
export function getWeatherSecondaryPresentations(
  park: MinimalParkContext | null,
  drivers: MinimalDriver[],
): WeatherSecondaryPresentation[] {
  const hasKey = (key: string) => drivers.some((d) => d.key === key);
  const pills: WeatherSecondaryPresentation[] = [];

  const roofClosed = hasKey("pw_roof") || park?.carryLabel === "Neutral Air";
  if (roofClosed) {
    pills.push({ text: "Roof Closed", tone: "neutral", classes: getPlateToneClasses("neutral") });
    return pills;
  }

  if (park?.temperatureF != null) {
    let tone: PlateTagTone = "context";
    if (hasKey("pw_cold")) tone = "risk";
    else if (hasKey("pw_temp")) tone = "supporting";
    pills.push({ text: `${Math.round(park.temperatureF)}°`, tone, classes: getPlateToneClasses(tone) });
  }

  if (park?.windMph != null) {
    let tone: PlateTagTone = "context";
    if (hasKey("pw_wind_in")) tone = "risk";
    else if (hasKey("pw_wind_out")) tone = "supporting";
    const label = park.windDirectionLabel ? `${park.windDirectionLabel} ${Math.round(park.windMph)} mph` : `${Math.round(park.windMph)} mph`;
    pills.push({ text: label, tone, classes: getPlateToneClasses(tone) });
  }

  return pills;
}
