// ─────────────────────────────────────────────────────────────────────────────
// PR7A — Retrosheet plate-discipline (no-location) EVIDENCE KIND contract.
//
// SHADOW-ONLY, ADDITIVE, PURE. Defines the `retrosheet_discipline` evidence-kind
// payload contract and its strict validator. NO producer yet (the Retrosheet
// normalization adapter is PR7A stage 5, separately authorized); read by no
// champion/public path.
//
// STRUCTURAL ISOLATION (contract §2 / §6, enforced by
// retrosheetDisciplineIsolation.test.ts): this file imports NOTHING — in particular
// no Baseball Savant / MLB-Stats data-source module — and derives/proxies no pitch
// location or zone. The only authorized live source for PR7A is Retrosheet.
//
// A single evidence source carries EXACTLY ONE actor (batter XOR pitcher), matching
// its source `entityType`; a combined batter+pitcher payload is rejected. The payload
// stores RAW COUNTS + provenance only (contract §3.2/§4) — rates are re-derivable from
// counts (so PR8 can re-shrink) and therefore do NOT live here.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineEvidence.test.ts
// ─────────────────────────────────────────────────────────────────────────────

/** The only authorized provider for retrosheet_discipline evidence. */
export const RETROSHEET_DISCIPLINE_PROVIDERS: ReadonlySet<string> = new Set(["retrosheet"]);

export const RETROSHEET_DISCIPLINE_EVIDENCE_KIND = "retrosheet_discipline" as const;

/** The EXACT required Retrosheet attribution notice (contract §4.2 / §1.5). */
export const RETROSHEET_ATTRIBUTION_NOTICE =
  "The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at www.retrosheet.org.";

/** Closed set of floor null-with-reason codes (contract §3.4). Mirrors
 * PLATE_DISCIPLINE_FLOOR_NULL_REASONS in the feature contract; duplicated here to
 * keep this module import-free (structural isolation). Kept in sync by
 * retrosheetDisciplineIsolation.test.ts. */
export const RETROSHEET_DISCIPLINE_NULL_REASONS = [
  "below_sequence_coverage",
  "below_batter_pa_floor",
  "below_pitcher_bf_floor",
  "below_hand_split_pa_floor",
  "below_hand_split_bf_floor",
] as const;
export type RetrosheetDisciplineNullReason = (typeof RETROSHEET_DISCIPLINE_NULL_REASONS)[number];

export type RetrosheetDisciplineActorType = "batter" | "pitcher";

export interface RetrosheetDisciplineProvenance {
  datasetVersion: string;
  dataThroughDate: string;
  seasonsCovered: number[];
  window: { from: string; to: string };
  gameIds: string[];
  gameCount: number;
  attributionNotice: string;
  sequenceFloorMet: boolean;
  overallQuality: "full" | "degraded" | "missing";
  nullReasons: RetrosheetDisciplineNullReason[];
}
export interface RetrosheetDisciplineBatterCounts {
  pa: number; k: number; bb: number; ibb: number; hbp: number;
  pitches: number; swings: number; whiffs: number; contacts: number; fouls: number;
  calledStrikes: number; takenPitches: number; inPlay: number; firstPitchStrikes: number;
  twoStrikePa: number; twoStrikeK: number; twoStrikeSurvived: number; codedPitchPa: number;
}
export interface RetrosheetDisciplineBatterHandSplits {
  paVsL: number; paVsR: number; kVsL: number; kVsR: number; bbVsL: number; bbVsR: number;
  contactsVsL: number; contactsVsR: number; swingsVsL: number; swingsVsR: number;
  whiffsVsL: number; whiffsVsR: number;
}
export interface RetrosheetDisciplinePitcherBlock {
  counts: { bf: number; k: number; bb: number; ibb: number; whiffs: number; swings: number; calledStrikes: number; firstPitchStrikes: number };
  handSplits: { bfVsHand: number; kVsHand: number; bbVsHand: number };
  batterHand: "L" | "R" | null;   // resolved hand — never "S"
  pitcherThrows: "L" | "R" | null;
}
export interface RetrosheetDisciplineEvidencePayload {
  actorType: RetrosheetDisciplineActorType;
  provenance: RetrosheetDisciplineProvenance;
  batter?: { counts: RetrosheetDisciplineBatterCounts; handSplits: RetrosheetDisciplineBatterHandSplits };
  pitcher?: RetrosheetDisciplinePitcherBlock;
}

const BATTER_COUNT_KEYS = [
  "pa", "k", "bb", "ibb", "hbp", "pitches", "swings", "whiffs", "contacts", "fouls",
  "calledStrikes", "takenPitches", "inPlay", "firstPitchStrikes",
  "twoStrikePa", "twoStrikeK", "twoStrikeSurvived", "codedPitchPa",
] as const;
const BATTER_SPLIT_KEYS = [
  "paVsL", "paVsR", "kVsL", "kVsR", "bbVsL", "bbVsR",
  "contactsVsL", "contactsVsR", "swingsVsL", "swingsVsR", "whiffsVsL", "whiffsVsR",
] as const;
const PITCHER_COUNT_KEYS = ["bf", "k", "bb", "ibb", "whiffs", "swings", "calledStrikes", "firstPitchStrikes"] as const;
const PITCHER_SPLIT_KEYS = ["bfVsHand", "kVsHand", "bbVsHand"] as const;
const PROVENANCE_KEYS = ["datasetVersion", "dataThroughDate", "seasonsCovered", "window", "gameIds", "gameCount", "attributionNotice", "sequenceFloorMet", "overallQuality", "nullReasons"] as const;

function isPlainObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}
function isNonNegInt(x: unknown): x is number { return typeof x === "number" && Number.isInteger(x) && x >= 0; }
function isNonEmptyStr(x: unknown): x is string { return typeof x === "string" && x.trim().length > 0; }
function isIso(x: unknown): x is string { return typeof x === "string" && x.trim().length > 0 && Number.isFinite(Date.parse(x)); }
function hasNonCanonicalNumber(x: unknown): boolean {
  if (typeof x === "number") return !Number.isFinite(x);
  if (Array.isArray(x)) return x.some(hasNonCanonicalNumber);
  if (isPlainObj(x)) return Object.values(x).some(hasNonCanonicalNumber);
  return false;
}
function closedKeys(obj: Record<string, unknown>, allowed: readonly string[], prefix: string, reasons: string[]): void {
  const set = new Set<string>(allowed);
  for (const k of Object.keys(obj)) if (!set.has(k)) reasons.push(`${prefix}_unexpected_field:${k}`);
}
function requireInts(obj: Record<string, unknown>, keys: readonly string[], prefix: string, reasons: string[]): void {
  for (const k of keys) if (!isNonNegInt(obj[k])) reasons.push(`${prefix}_not_nonneg_int:${k}`);
}
function leq(a: unknown, b: unknown, label: string, reasons: string[]): void {
  if (typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && a > b) reasons.push(`inconsistent:${label}`);
}
function eqSum(total: unknown, parts: unknown[], label: string, reasons: string[]): void {
  if (typeof total !== "number" || !Number.isFinite(total)) return;
  let s = 0;
  for (const p of parts) { if (typeof p !== "number" || !Number.isFinite(p)) return; s += p; }
  if (total !== s) reasons.push(`inconsistent:${label}`);
}

function validateProvenance(prov: unknown, reasons: string[]): void {
  if (!isPlainObj(prov)) { reasons.push("provenance_missing"); return; }
  closedKeys(prov, PROVENANCE_KEYS, "provenance", reasons);
  if (!isNonEmptyStr(prov.datasetVersion)) reasons.push("provenance_datasetVersion_empty");
  if (!isNonEmptyStr(prov.dataThroughDate)) reasons.push("provenance_dataThroughDate_empty");
  if (!Array.isArray(prov.seasonsCovered) || prov.seasonsCovered.length === 0 || !prov.seasonsCovered.every((s) => Number.isInteger(s) && (s as number) >= 1900 && (s as number) <= 2100)) reasons.push("provenance_seasonsCovered_invalid");
  // coverage window
  if (!isPlainObj(prov.window)) reasons.push("provenance_window_missing");
  else {
    closedKeys(prov.window, ["from", "to"], "window", reasons);
    if (!isIso(prov.window.from)) reasons.push("provenance_window_from_invalid");
    if (!isIso(prov.window.to)) reasons.push("provenance_window_to_invalid");
    if (isIso(prov.window.from) && isIso(prov.window.to) && Date.parse(prov.window.from as string) > Date.parse(prov.window.to as string)) reasons.push("provenance_window_from_after_to");
  }
  // game ids: present, non-empty, unique; gameCount === gameIds.length
  if (!Array.isArray(prov.gameIds) || prov.gameIds.length === 0) reasons.push("provenance_gameIds_missing");
  else {
    if (!prov.gameIds.every(isNonEmptyStr)) reasons.push("provenance_gameIds_not_all_strings");
    if (new Set(prov.gameIds).size !== prov.gameIds.length) reasons.push("provenance_gameIds_duplicate");
    if (isNonNegInt(prov.gameCount) && prov.gameCount !== prov.gameIds.length) reasons.push("provenance_gameCount_ne_gameIds_length");
  }
  if (!isNonNegInt(prov.gameCount)) reasons.push("provenance_gameCount_not_nonneg_int");
  // attribution notice must be EXACT
  if (prov.attributionNotice !== RETROSHEET_ATTRIBUTION_NOTICE) reasons.push("provenance_attribution_notice_mismatch");
  if (typeof prov.sequenceFloorMet !== "boolean") reasons.push("provenance_sequenceFloorMet_not_boolean");
  if (!(prov.overallQuality === "full" || prov.overallQuality === "degraded" || prov.overallQuality === "missing")) reasons.push("provenance_overallQuality_invalid");
  const allowedReasons = new Set<string>(RETROSHEET_DISCIPLINE_NULL_REASONS);
  if (!Array.isArray(prov.nullReasons)) reasons.push("provenance_nullReasons_not_array");
  else {
    for (const r of prov.nullReasons) if (!allowedReasons.has(r as string)) reasons.push(`provenance_nullReason_unknown:${String(r)}`);
    if (new Set(prov.nullReasons).size !== prov.nullReasons.length) reasons.push("provenance_nullReasons_duplicate");
  }
}

function validateBatter(batter: unknown, reasons: string[]): void {
  if (!isPlainObj(batter)) { reasons.push("batter_missing"); return; }
  closedKeys(batter, ["counts", "handSplits"], "batter", reasons);
  const c = batter.counts;
  if (!isPlainObj(c)) reasons.push("batter_counts_missing");
  else {
    closedKeys(c, BATTER_COUNT_KEYS, "batter_counts", reasons);
    requireInts(c, BATTER_COUNT_KEYS, "batter_counts", reasons);
    leq(c.swings, c.pitches, "swings_le_pitches", reasons);
    leq(c.takenPitches, c.pitches, "taken_le_pitches", reasons);
    leq(c.calledStrikes, c.takenPitches, "called_le_taken", reasons);
    eqSum(c.swings, [c.whiffs, c.contacts], "swings_eq_whiffs_plus_contacts", reasons);
    eqSum(c.contacts, [c.fouls, c.inPlay], "contacts_eq_fouls_plus_inplay", reasons);
    leq(c.k, c.pa, "k_le_pa", reasons);
    leq(c.bb, c.pa, "bb_le_pa", reasons);
    leq(c.ibb, c.bb, "ibb_le_bb", reasons);
    leq(c.hbp, c.pa, "hbp_le_pa", reasons);
    leq(c.codedPitchPa, c.pa, "coded_le_pa", reasons);
    leq(c.firstPitchStrikes, c.pa, "fps_le_pa", reasons);
    leq(c.inPlay, c.pa, "inplay_le_pa", reasons);
    leq(c.twoStrikeK, c.twoStrikePa, "2kk_le_2kpa", reasons);
    leq(c.twoStrikeSurvived, c.twoStrikePa, "2ksurv_le_2kpa", reasons);
    eqSum(c.twoStrikePa, [c.twoStrikeK, c.twoStrikeSurvived], "2kpa_eq_2kk_plus_surv", reasons);
  }
  const hs = batter.handSplits;
  if (!isPlainObj(hs)) reasons.push("batter_handSplits_missing");
  else {
    closedKeys(hs, BATTER_SPLIT_KEYS, "batter_handSplits", reasons);
    requireInts(hs, BATTER_SPLIT_KEYS, "batter_handSplits", reasons);
    leq(hs.kVsL, hs.paVsL, "kVsL_le_paVsL", reasons);
    leq(hs.kVsR, hs.paVsR, "kVsR_le_paVsR", reasons);
    leq(hs.bbVsL, hs.paVsL, "bbVsL_le_paVsL", reasons);
    leq(hs.bbVsR, hs.paVsR, "bbVsR_le_paVsR", reasons);
    leq(hs.whiffsVsL, hs.swingsVsL, "whiffsVsL_le_swingsVsL", reasons);
    leq(hs.whiffsVsR, hs.swingsVsR, "whiffsVsR_le_swingsVsR", reasons);
    leq(hs.contactsVsL, hs.swingsVsL, "contactsVsL_le_swingsVsL", reasons);
    leq(hs.contactsVsR, hs.swingsVsR, "contactsVsR_le_swingsVsR", reasons);
    if (isPlainObj(c) && typeof hs.paVsL === "number" && typeof hs.paVsR === "number" && typeof c.pa === "number" && Number.isFinite(c.pa) && hs.paVsL + hs.paVsR > c.pa) reasons.push("inconsistent:paVsL_plus_paVsR_gt_pa");
  }
}

function validatePitcher(pitcher: unknown, reasons: string[]): void {
  if (!isPlainObj(pitcher)) { reasons.push("pitcher_missing"); return; }
  closedKeys(pitcher, ["counts", "handSplits", "batterHand", "pitcherThrows"], "pitcher", reasons);
  // RESOLVED batter hand — L/R/null only; "S" (or anything else) rejected.
  if (!(pitcher.batterHand === null || pitcher.batterHand === "L" || pitcher.batterHand === "R")) reasons.push("pitcher_batterHand_invalid");
  if (!(pitcher.pitcherThrows === null || pitcher.pitcherThrows === "L" || pitcher.pitcherThrows === "R")) reasons.push("pitcher_pitcherThrows_invalid");
  const pc = pitcher.counts;
  if (!isPlainObj(pc)) reasons.push("pitcher_counts_missing");
  else {
    closedKeys(pc, PITCHER_COUNT_KEYS, "pitcher_counts", reasons);
    requireInts(pc, PITCHER_COUNT_KEYS, "pitcher_counts", reasons);
    leq(pc.k, pc.bf, "pk_le_bf", reasons);
    leq(pc.bb, pc.bf, "pbb_le_bf", reasons);
    leq(pc.ibb, pc.bb, "pibb_le_bb", reasons);
    leq(pc.whiffs, pc.swings, "pwhiffs_le_swings", reasons);
    leq(pc.calledStrikes, pc.bf, "pcalled_le_bf", reasons);
    leq(pc.firstPitchStrikes, pc.bf, "pfps_le_bf", reasons);
  }
  const ph = pitcher.handSplits;
  if (!isPlainObj(ph)) reasons.push("pitcher_handSplits_missing");
  else {
    closedKeys(ph, PITCHER_SPLIT_KEYS, "pitcher_handSplits", reasons);
    requireInts(ph, PITCHER_SPLIT_KEYS, "pitcher_handSplits", reasons);
    leq(ph.kVsHand, ph.bfVsHand, "pkVsHand_le_bfVsHand", reasons);
    leq(ph.bbVsHand, ph.bfVsHand, "pbbVsHand_le_bfVsHand", reasons);
    if (isPlainObj(pc)) leq(ph.bfVsHand, pc.bf, "bfVsHand_le_bf", reasons);
  }
}

/**
 * STRICT validation of a retrosheet_discipline evidence payload. A source carries
 * EXACTLY ONE actor (batter XOR pitcher) matching `actorType`; a combined payload is
 * rejected. CLOSED keys everywhere, non-negative integer counts, internal-consistency
 * invariants, hardened provenance (present+unique gameIds, coverage window, EXACT
 * attribution notice, closed floor null-reasons), and resolved batter hand ∈ {L,R,null}.
 * Fail-closed; never throws.
 */
export function validateRetrosheetDisciplinePayload(payload: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!isPlainObj(payload)) return { ok: false, reasons: ["payload_not_object"] };
  closedKeys(payload, ["actorType", "provenance", "batter", "pitcher"], "top", reasons);

  const actorType = payload.actorType;
  const isBatter = actorType === "batter";
  const isPitcher = actorType === "pitcher";
  if (!isBatter && !isPitcher) reasons.push("actorType_invalid");

  // EXACTLY ONE actor block, matching actorType. A combined payload is rejected.
  const hasBatter = payload.batter !== undefined;
  const hasPitcher = payload.pitcher !== undefined;
  if (hasBatter && hasPitcher) reasons.push("combined_batter_and_pitcher_payload");
  if (isBatter) {
    if (!hasBatter) reasons.push("batter_actor_missing_batter_block");
    if (hasPitcher) reasons.push("batter_actor_has_pitcher_block");
  }
  if (isPitcher) {
    if (!hasPitcher) reasons.push("pitcher_actor_missing_pitcher_block");
    if (hasBatter) reasons.push("pitcher_actor_has_batter_block");
  }

  validateProvenance(payload.provenance, reasons);
  if (hasBatter) validateBatter(payload.batter, reasons);
  if (hasPitcher) validatePitcher(payload.pitcher, reasons);

  if (hasNonCanonicalNumber(payload)) reasons.push("payload_noncanonical");
  return { ok: reasons.length === 0, reasons };
}

/** The actor a payload declares, or null if it is not a valid single-actor payload.
 * Used by the strict reader to cross-check evidence `entityType` === payload actor. */
export function retrosheetDisciplineActorType(payload: unknown): RetrosheetDisciplineActorType | null {
  if (!isPlainObj(payload)) return null;
  if (payload.actorType === "batter" && payload.batter !== undefined && payload.pitcher === undefined) return "batter";
  if (payload.actorType === "pitcher" && payload.pitcher !== undefined && payload.batter === undefined) return "pitcher";
  return null;
}
