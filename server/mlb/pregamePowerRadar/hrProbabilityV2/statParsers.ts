// Plate HR V2 — shared, blank-safe stat parsers + malformed-data guards (PR4.2).
// PURE. One source of truth for the three Savant-row aggregators so denominators
// can never be corrupted by blank cells or unrecognized/out-of-range values.

/** Parse a CSV cell to a finite number, or null. Crucially, "" / whitespace /
 * "null" → null (Number("") is 0, which would silently corrupt denominators). */
export function parseOptionalNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || t.toLowerCase() === "null") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Frozen set of recognized batted-ball types. A BBE is counted ONLY for these
 * (an unrecognized/blank bb_type must never increment a BBE denominator). */
export const RECOGNIZED_BB_TYPES: ReadonlySet<string> = new Set([
  "ground_ball", "line_drive", "fly_ball", "popup",
]);

export function isRecognizedBbType(v: unknown): boolean {
  return typeof v === "string" && RECOGNIZED_BB_TYPES.has(v.trim().toLowerCase());
}

/** Physically valid launch angle range (degrees). */
export function isValidLaunchAngle(la: number | null | undefined): la is number {
  return la != null && la >= -90 && la <= 90;
}

/** Valid exit velocity range (mph) — matches the existing production guard. */
export function isValidExitVelocity(ev: number | null | undefined): ev is number {
  return ev != null && ev > 0 && ev <= 130;
}

export const XWOBA_ON_CONTACT_MIN = 0;
export const XWOBA_ON_CONTACT_MAX = 2.0;
export function isValidXwobaOnContact(x: number | null | undefined): x is number {
  return x != null && x >= XWOBA_ON_CONTACT_MIN && x <= XWOBA_ON_CONTACT_MAX;
}

/** Valid xSLG-on-contact range. */
export const XSLG_ON_CONTACT_MIN = 0;
export const XSLG_ON_CONTACT_MAX = 4.0;
export function isValidXslgOnContact(x: number | null | undefined): x is number {
  return x != null && x >= XSLG_ON_CONTACT_MIN && x <= XSLG_ON_CONTACT_MAX;
}
