// ─────────────────────────────────────────────────────────────────────────────
// PR7A — Retrosheet plate-discipline (no-location) EVIDENCE KIND contract.
//
// SHADOW-ONLY, ADDITIVE, PURE. This module defines the `retrosheet_discipline`
// evidence-kind payload contract and its strict validator. It has NO producer yet
// (the Retrosheet normalization adapter is PR7A stage 5, separately authorized) and
// is read by no champion/public path.
//
// STRUCTURAL ISOLATION (contract §2 / §6, enforced by
// retrosheetDisciplineIsolation.test.ts): this file imports NOTHING — in particular
// no Baseball Savant / MLB-Stats data-source module — and derives/proxies no pitch
// location or zone. The only authorized live source for PR7A is Retrosheet.
//
// The payload stores RAW COUNTS + provenance only (contract §3.2/§4). Every v3
// discipline rate is re-derivable from these counts by the adapter; storing counts
// (not just rates) lets PR8 re-shrink with alternative thresholds. Rates therefore
// do NOT live in this payload.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineEvidence.test.ts
// ─────────────────────────────────────────────────────────────────────────────

/** The only authorized provider for retrosheet_discipline evidence. */
export const RETROSHEET_DISCIPLINE_PROVIDERS: ReadonlySet<string> = new Set(["retrosheet"]);

export const RETROSHEET_DISCIPLINE_EVIDENCE_KIND = "retrosheet_discipline" as const;

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
export interface RetrosheetDisciplinePitcher {
  counts: { bf: number; k: number; bb: number; ibb: number; whiffs: number; swings: number; calledStrikes: number; firstPitchStrikes: number };
  handSplits: { bfVsHand: number; kVsHand: number; bbVsHand: number };
  batterHand: "L" | "R" | "S" | null;
  pitcherThrows: "L" | "R" | null;
}
export interface RetrosheetDisciplineEvidencePayload {
  provenance: { datasetVersion: string; dataThroughDate: string; seasonsCovered: number[]; gameCount: number };
  batter: { counts: RetrosheetDisciplineBatterCounts; handSplits: RetrosheetDisciplineBatterHandSplits };
  pitcher: RetrosheetDisciplinePitcher | null;
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
const PROVENANCE_KEYS = ["datasetVersion", "dataThroughDate", "seasonsCovered", "gameCount"] as const;

function isPlainObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}
function isNonNegInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}
/** Reject any value JSON would silently collapse (NaN/Infinity/undefined/-0 loss). */
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

/**
 * STRICT validation of a retrosheet_discipline evidence payload. CLOSED keys at
 * every level, non-negative integer counts, and internal-consistency invariants
 * (e.g. swings = whiffs + contacts, contacts = fouls + inPlay, twoStrikePa =
 * twoStrikeK + twoStrikeSurvived, sub-counts ≤ their denominators). Fail-closed;
 * never throws. Runs at write and strict read (wired via validateSourcePayload).
 */
export function validateRetrosheetDisciplinePayload(payload: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!isPlainObj(payload)) return { ok: false, reasons: ["payload_not_object"] };
  closedKeys(payload, ["provenance", "batter", "pitcher"], "top", reasons);

  // provenance
  const prov = payload.provenance;
  if (!isPlainObj(prov)) reasons.push("provenance_missing");
  else {
    closedKeys(prov, PROVENANCE_KEYS, "provenance", reasons);
    if (typeof prov.datasetVersion !== "string" || prov.datasetVersion.trim().length === 0) reasons.push("provenance_datasetVersion_empty");
    if (typeof prov.dataThroughDate !== "string" || prov.dataThroughDate.trim().length === 0) reasons.push("provenance_dataThroughDate_empty");
    if (!Array.isArray(prov.seasonsCovered) || prov.seasonsCovered.length === 0 || !prov.seasonsCovered.every((s) => Number.isInteger(s) && (s as number) >= 1900 && (s as number) <= 2100)) reasons.push("provenance_seasonsCovered_invalid");
    if (!isNonNegInt(prov.gameCount)) reasons.push("provenance_gameCount_not_nonneg_int");
  }

  // batter
  const batter = payload.batter;
  if (!isPlainObj(batter)) reasons.push("batter_missing");
  else {
    closedKeys(batter, ["counts", "handSplits"], "batter", reasons);
    const c = batter.counts;
    if (!isPlainObj(c)) reasons.push("batter_counts_missing");
    else {
      closedKeys(c, BATTER_COUNT_KEYS, "batter_counts", reasons);
      requireInts(c, BATTER_COUNT_KEYS, "batter_counts", reasons);
      // internal consistency
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
      if (isPlainObj(c)) { // hand PAs cannot exceed total PA (unknown-hand PAs allowed ⇒ ≤, not =)
        if (typeof hs.paVsL === "number" && typeof hs.paVsR === "number" && typeof c.pa === "number" && Number.isFinite(c.pa) && hs.paVsL + hs.paVsR > c.pa) reasons.push("inconsistent:paVsL_plus_paVsR_gt_pa");
      }
    }
  }

  // pitcher (nullable — absent/unknown pitcher is legal)
  const pitcher = payload.pitcher;
  if (pitcher !== null) {
    if (!isPlainObj(pitcher)) reasons.push("pitcher_not_object_or_null");
    else {
      closedKeys(pitcher, ["counts", "handSplits", "batterHand", "pitcherThrows"], "pitcher", reasons);
      if (!(pitcher.batterHand === null || pitcher.batterHand === "L" || pitcher.batterHand === "R" || pitcher.batterHand === "S")) reasons.push("pitcher_batterHand_invalid");
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
        if (isPlainObj(pc) && typeof ph.bfVsHand === "number" && typeof pc.bf === "number" && Number.isFinite(pc.bf)) leq(ph.bfVsHand, pc.bf, "bfVsHand_le_bf", reasons);
      }
    }
  }

  if (hasNonCanonicalNumber(payload)) reasons.push("payload_noncanonical");
  return { ok: reasons.length === 0, reasons };
}
