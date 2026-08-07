// PR7A.2 — retrosheet_discipline evidence payload validator invariants (non-vacuous).
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineEvidence.test.ts

import {
  RETROSHEET_DISCIPLINE_PROVIDERS,
  RETROSHEET_ATTRIBUTION_NOTICE,
  RETROSHEET_DISCIPLINE_NULL_REASONS,
  validateRetrosheetDisciplinePayload,
  retrosheetDisciplineActorType,
} from "./retrosheetDisciplineEvidence";
import { validateSourcePayload, EVIDENCE_KINDS } from "./plateHrV2Snapshots";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const rejects = (p: unknown, needle: string, msg: string) => {
  const r = validateRetrosheetDisciplinePayload(p);
  ok(!r.ok && r.reasons.some((x) => x.includes(needle)), `${msg} (got: ${r.reasons.join("|") || "OK"})`);
};
const accepts = (p: unknown, msg: string) => {
  const r = validateRetrosheetDisciplinePayload(p);
  ok(r.ok, `${msg} (got: ${r.reasons.join("|")})`);
};

function provenance() {
  return {
    datasetVersion: "retrosheet_2019_v1", dataThroughDate: "2019-09-14", seasonsCovered: [2019],
    window: { from: "2019-03-20", to: "2019-09-14" }, gameIds: ["ANA201904040", "ARI201908060"], gameCount: 2,
    attributionNotice: RETROSHEET_ATTRIBUTION_NOTICE, sequenceFloorMet: true, overallQuality: "full", nullReasons: [] as string[],
  };
}
function batterCounts() {
  return { pa: 100, k: 22, bb: 10, ibb: 1, hbp: 2, pitches: 380, swings: 180, whiffs: 40, contacts: 140, fouls: 90,
    calledStrikes: 70, takenPitches: 200, inPlay: 50, firstPitchStrikes: 55, twoStrikePa: 45, twoStrikeK: 22, twoStrikeSurvived: 23, codedPitchPa: 96 };
}
function batterSplits() {
  // internally consistent: swingsVs* = whiffsVs* + contactsVs*; totals ≤ overall.
  return { paVsL: 30, paVsR: 70, kVsL: 7, kVsR: 15, bbVsL: 3, bbVsR: 7,
    contactsVsL: 40, contactsVsR: 100, swingsVsL: 52, swingsVsR: 128, whiffsVsL: 12, whiffsVsR: 28 };
}
function validBatter(): any { return { actorType: "batter", provenance: provenance(), batter: { counts: batterCounts(), handSplits: batterSplits() } }; }
function validPitcher(): any {
  // NOTE: calledStrikes (900) > bf (800) is VALID — a called strike is per-pitch, so
  // the denominator is `pitches` (3000), not BF.
  return { actorType: "pitcher", provenance: provenance(), pitcher: {
    counts: { bf: 800, pitches: 3000, k: 210, bb: 60, ibb: 4, whiffs: 260, swings: 1200, calledStrikes: 900, firstPitchStrikes: 480 },
    handSplits: { bfVsL: 400, bfVsR: 400, kVsL: 110, kVsR: 100, bbVsL: 30, bbVsR: 30 }, pitcherThrows: "R" } };
}

// 1. valid payloads pass (directly + via dispatcher).
accepts(validBatter(), "valid batter payload passes");
accepts(validPitcher(), "valid pitcher payload passes");
ok(validateSourcePayload("retrosheet_discipline", validBatter()).ok, "valid batter passes via dispatch");
ok(EVIDENCE_KINDS.includes("retrosheet_discipline" as any), "retrosheet_discipline registered");
ok(RETROSHEET_DISCIPLINE_PROVIDERS.has("retrosheet") && RETROSHEET_DISCIPLINE_PROVIDERS.size === 1, "only retrosheet provider");
ok(retrosheetDisciplineActorType(validBatter()) === "batter" && retrosheetDisciplineActorType(validPitcher()) === "pitcher", "actorType helper resolves");

// 2. combined / actor-mismatch.
{ const p = validBatter(); p.pitcher = validPitcher().pitcher; rejects(p, "combined_batter_and_pitcher_payload", "combined payload rejected"); }
{ const p = validBatter(); p.actorType = "pitcher"; rejects(p, "pitcher_actor_missing_pitcher_block", "actorType pitcher but batter block rejected"); }
{ const p = validBatter(); p.actorType = "team"; rejects(p, "actorType_invalid", "unknown actorType rejected"); }

// 3. provenance hardening.
{ const p = validBatter(); delete p.provenance.gameIds; rejects(p, "provenance_gameIds_missing", "missing gameIds rejected"); }
{ const p = validBatter(); p.provenance.gameIds = ["G1", "G1"]; p.provenance.gameCount = 2; rejects(p, "provenance_gameIds_duplicate", "duplicate gameIds rejected"); }
{ const p = validBatter(); p.provenance.gameCount = 5; rejects(p, "provenance_gameCount_ne_gameIds_length", "gameCount != gameIds.length rejected"); }
{ const p = validBatter(); delete p.provenance.window; rejects(p, "provenance_window_missing", "missing window rejected"); }
{ const p = validBatter(); p.provenance.window = { from: "2019-09-14", to: "2019-03-20" }; rejects(p, "provenance_window_from_after_to", "window from>to rejected"); }
{ const p = validBatter(); p.provenance.attributionNotice = "obtained from Retrosheet"; rejects(p, "provenance_attribution_notice_mismatch", "bad attribution notice rejected"); }
{ const p = validBatter(); delete p.provenance.attributionNotice; rejects(p, "provenance_attribution_notice_mismatch", "missing attribution notice rejected"); }
// strict ISO
{ const p = validBatter(); p.provenance.dataThroughDate = "2019/09/14"; rejects(p, "dataThroughDate_not_strict_iso", "loose dataThroughDate rejected"); }
{ const p = validBatter(); p.provenance.window.from = "2019-13-40"; rejects(p, "window_from_not_strict_iso", "impossible window date rejected"); }
{ const p = validBatter(); p.provenance.dataThroughDate = "2019-09-14T00:00:00Z"; accepts(p, "full RFC3339 dataThroughDate accepted"); }

// 3b. provenance internal semantics.
{ const p = validBatter(); p.provenance.nullReasons = ["below_sequence_coverage"]; p.provenance.sequenceFloorMet = true; p.provenance.overallQuality = "degraded"; rejects(p, "below_sequence_coverage_xor_sequenceFloorMet", "below_sequence_coverage with floorMet=true rejected"); }
{ const p = validBatter(); p.provenance.sequenceFloorMet = false; p.provenance.nullReasons = []; p.provenance.overallQuality = "degraded"; rejects(p, "below_sequence_coverage_xor_sequenceFloorMet", "floorMet=false without below_sequence_coverage rejected"); }
{ const p = validBatter(); p.provenance.nullReasons = ["below_batter_pa_floor"]; p.provenance.overallQuality = "full"; rejects(p, "null_reasons_with_overallQuality_full", "null reasons with overallQuality=full rejected"); }

// 4. each floor null reason accepted (with consistent floor flag/quality); unknown/dup rejected.
for (const reason of RETROSHEET_DISCIPLINE_NULL_REASONS) {
  const p = validBatter();
  p.provenance.nullReasons = [reason];
  p.provenance.overallQuality = "degraded";
  p.provenance.sequenceFloorMet = reason !== "below_sequence_coverage";
  accepts(p, `nullReason '${reason}' accepted`);
}
ok(RETROSHEET_DISCIPLINE_NULL_REASONS.length === 5, "exactly 5 floor null reasons");
{ const p = validBatter(); p.provenance.nullReasons = ["below_made_up_floor"]; p.provenance.overallQuality = "degraded"; rejects(p, "provenance_nullReason_unknown", "unknown null reason rejected"); }

// 5. batter counts + hand-split consistency.
{ const p = validBatter(); p.batter.counts.k = -1; rejects(p, "not_nonneg_int:k", "negative count rejected"); }
{ const p = validBatter(); p.batter.counts.swings = 179; rejects(p, "swings_eq_whiffs_plus_contacts", "swings != whiffs+contacts rejected"); }
{ const p = validBatter(); p.batter.handSplits.swingsVsL = 53; rejects(p, "swingsVsL_eq_whiffsVsL_plus_contactsVsL", "split swings != whiffs+contacts rejected"); }
{ const p = validBatter(); p.batter.handSplits.kVsL = 20; p.batter.handSplits.kVsR = 15; rejects(p, "kVsL_plus_kVsR_gt_k", "split k totals > overall k rejected"); }
{ const p = validBatter(); p.batter.handSplits.paVsL = 40; p.batter.handSplits.paVsR = 70; rejects(p, "paVsL_plus_paVsR_gt_pa", "paVsL+paVsR > pa rejected"); }

// 6. pitcher: pitches denominator; calledStrikes <= pitches (NOT <= BF); vsL/vsR history.
ok(validPitcher().pitcher.counts.calledStrikes > validPitcher().pitcher.counts.bf, "fixture demonstrates calledStrikes > BF");
accepts(validPitcher(), "calledStrikes > BF is VALID when calledStrikes <= pitches");
{ const p = validPitcher(); p.pitcher.counts.calledStrikes = 3001; rejects(p, "pcalled_le_pitches", "calledStrikes > pitches rejected"); }
{ const p = validPitcher(); delete p.pitcher.counts.pitches; rejects(p, "pitcher_counts_not_nonneg_int:pitches", "pitcher requires pitches"); }
{ const p = validPitcher(); p.pitcher.batterHand = "L"; rejects(p, "pitcher_unexpected_field:batterHand", "pitcher rejects prediction-specific batterHand (removed)"); }
{ const p = validPitcher(); p.pitcher.handSplits.bfVsHand = 1; rejects(p, "pitcher_handSplits_unexpected_field:bfVsHand", "pitcher rejects legacy vsHand split (removed)"); }
{ const p = validPitcher(); p.pitcher.handSplits.kVsL = 401; rejects(p, "pkVsL_le_bfVsL", "kVsL > bfVsL rejected"); }
{ const p = validPitcher(); p.pitcher.handSplits.bfVsL = 500; rejects(p, "bfVsL_plus_bfVsR_gt_bf", "bfVsL+bfVsR > bf rejected"); }

// 7. non-canonical numbers rejected.
{ const p = validBatter(); p.batter.counts.pa = Infinity; rejects(p, "payload_noncanonical", "Infinity rejected"); }

console.log(`retrosheetDisciplineEvidence.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
