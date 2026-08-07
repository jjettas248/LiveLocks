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

function provenance() {
  return {
    datasetVersion: "retrosheet_2019_v1", dataThroughDate: "2019-09-14", seasonsCovered: [2019],
    window: { from: "2019-03-20", to: "2019-09-14" },
    gameIds: ["ANA201904040", "ARI201908060"], gameCount: 2,
    attributionNotice: RETROSHEET_ATTRIBUTION_NOTICE,
    sequenceFloorMet: true, overallQuality: "full", nullReasons: [] as string[],
  };
}
function batterCounts() {
  return { pa: 100, k: 22, bb: 10, ibb: 1, hbp: 2, pitches: 380, swings: 180, whiffs: 40, contacts: 140, fouls: 90,
    calledStrikes: 70, takenPitches: 200, inPlay: 50, firstPitchStrikes: 55, twoStrikePa: 45, twoStrikeK: 22, twoStrikeSurvived: 23, codedPitchPa: 96 };
}
function batterSplits() {
  return { paVsL: 30, paVsR: 70, kVsL: 7, kVsR: 15, bbVsL: 3, bbVsR: 7,
    contactsVsL: 40, contactsVsR: 100, swingsVsL: 55, swingsVsR: 125, whiffsVsL: 12, whiffsVsR: 28 };
}
function validBatter(): any { return { actorType: "batter", provenance: provenance(), batter: { counts: batterCounts(), handSplits: batterSplits() } }; }
function validPitcher(): any {
  return { actorType: "pitcher", provenance: provenance(), pitcher: {
    counts: { bf: 800, k: 210, bb: 60, ibb: 4, whiffs: 260, swings: 1200, calledStrikes: 320, firstPitchStrikes: 480 },
    handSplits: { bfVsHand: 400, kVsHand: 110, bbVsHand: 28 }, batterHand: "L", pitcherThrows: "R" } };
}

// 1. valid batter + pitcher payloads pass (directly + via dispatcher).
ok(validateRetrosheetDisciplinePayload(validBatter()).ok, "valid batter payload passes");
ok(validateRetrosheetDisciplinePayload(validPitcher()).ok, "valid pitcher payload passes");
ok(validateSourcePayload("retrosheet_discipline", validBatter()).ok, "valid batter payload passes via dispatch");
ok(EVIDENCE_KINDS.includes("retrosheet_discipline" as any), "retrosheet_discipline registered");
ok(RETROSHEET_DISCIPLINE_PROVIDERS.has("retrosheet") && RETROSHEET_DISCIPLINE_PROVIDERS.size === 1, "only retrosheet provider");
ok(retrosheetDisciplineActorType(validBatter()) === "batter" && retrosheetDisciplineActorType(validPitcher()) === "pitcher", "actorType helper resolves");

// 2. combined batter+pitcher payload rejected.
{ const p = validBatter(); p.pitcher = validPitcher().pitcher; rejects(p, "combined_batter_and_pitcher_payload", "combined payload rejected"); }
// wrong actorType / block mismatch.
{ const p = validBatter(); p.actorType = "pitcher"; rejects(p, "pitcher_actor_missing_pitcher_block", "actorType pitcher but batter block => rejected"); }
{ const p = validBatter(); p.actorType = "team"; rejects(p, "actorType_invalid", "unknown actorType rejected"); }
ok(retrosheetDisciplineActorType((() => { const p = validBatter(); p.pitcher = validPitcher().pitcher; return p; })()) === null, "combined payload has no resolvable actor");

// 3. provenance hardening.
{ const p = validBatter(); delete p.provenance.gameIds; rejects(p, "provenance_gameIds_missing", "missing gameIds rejected"); }
{ const p = validBatter(); p.provenance.gameIds = ["G1", "G1"]; p.provenance.gameCount = 2; rejects(p, "provenance_gameIds_duplicate", "duplicate gameIds rejected"); }
{ const p = validBatter(); p.provenance.gameCount = 5; rejects(p, "provenance_gameCount_ne_gameIds_length", "gameCount != gameIds.length rejected"); }
{ const p = validBatter(); delete p.provenance.window; rejects(p, "provenance_window_missing", "missing window rejected"); }
{ const p = validBatter(); p.provenance.window = { from: "2019-09-14", to: "2019-03-20" }; rejects(p, "provenance_window_from_after_to", "window from>to rejected"); }
{ const p = validBatter(); p.provenance.attributionNotice = "obtained from Retrosheet"; rejects(p, "provenance_attribution_notice_mismatch", "bad attribution notice rejected"); }
{ const p = validBatter(); delete p.provenance.attributionNotice; rejects(p, "provenance_attribution_notice_mismatch", "missing attribution notice rejected"); }

// 4. each floor/null reason accepted; unknown rejected.
for (const reason of RETROSHEET_DISCIPLINE_NULL_REASONS) {
  const p = validBatter(); p.provenance.nullReasons = [reason];
  ok(validateRetrosheetDisciplinePayload(p).ok, `nullReason '${reason}' accepted`);
}
ok(RETROSHEET_DISCIPLINE_NULL_REASONS.length === 5, "exactly 5 floor null reasons");
{ const p = validBatter(); p.provenance.nullReasons = ["below_made_up_floor"]; rejects(p, "provenance_nullReason_unknown", "unknown null reason rejected"); }
{ const p = validBatter(); p.provenance.nullReasons = ["below_sequence_coverage", "below_sequence_coverage"]; rejects(p, "provenance_nullReasons_duplicate", "duplicate null reasons rejected"); }

// 5. non-negative int + internal consistency (non-vacuous).
{ const p = validBatter(); p.batter.counts.k = -1; rejects(p, "not_nonneg_int:k", "negative count rejected"); }
{ const p = validBatter(); p.batter.counts.swings = 179; rejects(p, "swings_eq_whiffs_plus_contacts", "swings != whiffs+contacts rejected"); }
{ const p = validBatter(); p.batter.counts.fouls = 89; rejects(p, "contacts_eq_fouls_plus_inplay", "contacts != fouls+inPlay rejected"); }
{ const p = validBatter(); p.batter.counts.twoStrikeSurvived = 22; rejects(p, "2kpa_eq_2kk_plus_surv", "twoStrikePa != 2kk+surv rejected"); }
{ const p = validBatter(); p.batter.counts.k = 101; rejects(p, "k_le_pa", "k > pa rejected"); }
{ const p = validBatter(); p.batter.handSplits.paVsL = 40; p.batter.handSplits.paVsR = 70; rejects(p, "paVsL_plus_paVsR_gt_pa", "paVsL+paVsR > pa rejected"); }

// 6. pitcher: 'S' resolved batter hand rejected; calledStrikes > BF (with calledStrikes <= a plausible pitches count) rejected.
{ const p = validPitcher(); p.pitcher.batterHand = "S"; rejects(p, "pitcher_batterHand_invalid", "'S' resolved batter hand rejected"); }
{ const p = validPitcher(); p.pitcher.counts.calledStrikes = 801; rejects(p, "pcalled_le_bf", "pitcher calledStrikes > bf rejected (even though it would be <= pitches)"); }
{ const p = validPitcher(); p.pitcher.handSplits.kVsHand = 401; rejects(p, "pkVsHand_le_bfVsHand", "kVsHand > bfVsHand rejected"); }

// 7. non-canonical numbers rejected.
{ const p = validBatter(); p.batter.counts.pa = Infinity; rejects(p, "payload_noncanonical", "Infinity rejected"); }

console.log(`retrosheetDisciplineEvidence.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
