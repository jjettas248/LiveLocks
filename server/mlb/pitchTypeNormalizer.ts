export type CanonicalPitchType =
  | "FF" | "SI" | "FC" | "SL" | "SW" | "CU" | "KC" | "CH" | "FS" | "KN" | "OT";

export type PitchFamily = "fastball" | "breaking" | "offspeed" | "other";

const CODE_DIRECT: Record<string, CanonicalPitchType> = {
  FF: "FF", FA: "FF",
  SI: "SI", FT: "SI", "2SF": "SI",
  FC: "FC",
  SL: "SL",
  SW: "SW", ST: "SW", SV: "SW",
  CU: "CU", CB: "CU", KU: "CU", CS: "CU",
  KC: "KC",
  CH: "CH",
  FS: "FS", FO: "FS", SC: "FS",
  KN: "KN",
};

const NAME_RULES: Array<{ test: RegExp; code: CanonicalPitchType }> = [
  { test: /\b(four[\s-]?seam|4[\s-]?seam)\b/i, code: "FF" },
  { test: /\b(sinker|two[\s-]?seam|2[\s-]?seam)\b/i, code: "SI" },
  { test: /\bcutter\b/i, code: "FC" },
  { test: /\bsweeper\b/i, code: "SW" },
  { test: /\bslurve\b/i, code: "SL" },
  { test: /\bslider\b/i, code: "SL" },
  { test: /\bknuckle[\s-]?curve\b/i, code: "KC" },
  { test: /\bknuckleball\b/i, code: "KN" },
  { test: /\b(curve|curveball|knuckler)\b/i, code: "CU" },
  { test: /\bchangeup\b|\bchange[\s-]?up\b|\bchange\b/i, code: "CH" },
  { test: /\b(splitter|split[\s-]?finger|forkball|screwball)\b/i, code: "FS" },
  { test: /\b(fastball|heater)\b/i, code: "FF" },
];

export function normalizePitchTypeCode(input: string | null | undefined): CanonicalPitchType {
  if (!input) return "OT";
  const trimmed = String(input).trim();
  if (!trimmed || /^unknown$/i.test(trimmed)) return "OT";

  const upper = trimmed.toUpperCase();
  if (CODE_DIRECT[upper]) return CODE_DIRECT[upper];

  for (const r of NAME_RULES) {
    if (r.test.test(trimmed)) return r.code;
  }
  return "OT";
}

export const PITCH_FAMILY: Record<CanonicalPitchType, PitchFamily> = {
  FF: "fastball", SI: "fastball", FC: "fastball",
  SL: "breaking", SW: "breaking", CU: "breaking", KC: "breaking",
  CH: "offspeed", FS: "offspeed", KN: "offspeed",
  OT: "other",
};

export function getPitchFamily(pitchType: string | null | undefined): PitchFamily {
  return PITCH_FAMILY[normalizePitchTypeCode(pitchType)];
}

export function getPitchDisplayLabel(
  pitchType: string | null | undefined,
  fallbackName?: string
): string {
  const code = normalizePitchTypeCode(pitchType);
  if (code === "OT" && fallbackName && fallbackName.trim()) return fallbackName.trim();
  return PITCH_DISPLAY_LABEL[code];
}

export const PITCH_DISPLAY_LABEL: Record<CanonicalPitchType, string> = {
  FF: "4-Seam",
  SI: "Sinker",
  FC: "Cutter",
  SL: "Slider",
  SW: "Sweeper",
  CU: "Curve",
  KC: "Knuckle Curve",
  CH: "Change",
  FS: "Splitter",
  KN: "Knuckleball",
  OT: "Other",
};
