// PR7A.3 — Retrosheet normalization adapter: fixture-driven + mutation + determinism.
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineAdapter.test.ts

import {
  normalizePlateAppearances,
  buildBatterDiscipline,
  buildPitcherDiscipline,
  buildBatterDisciplineFromRows,
  buildPitcherDisciplineFromRows,
  RETROSHEET_DISCIPLINE_FLOORS,
  type RetrosheetCweventRow,
  type PaFact,
  type RetrosheetProvenanceInput,
} from "./retrosheetDisciplineAdapter";
import { RETROSHEET_ATTRIBUTION_NOTICE } from "./retrosheetDisciplineEvidence";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }
const near = (a: number | null | undefined, b: number, t = 1e-9) => typeof a === "number" && Math.abs(a - b) <= t;

const PROV = (): RetrosheetProvenanceInput => ({
  datasetVersion: "rs_2019_v1", dataThroughDate: "2019-09-14", seasonsCovered: [2019],
  window: { from: "2019-03-20", to: "2019-09-14" }, gameIds: ["G1", "G2"], attributionNotice: RETROSHEET_ATTRIBUTION_NOTICE,
});
const row = (o: Partial<RetrosheetCweventRow> & Pick<RetrosheetCweventRow, "BAT_ID" | "PITCH_SEQ_TX" | "EVENT_CD">): RetrosheetCweventRow =>
  ({ GAME_ID: "G", BAT_EVENT_FL: "T", ...o });
const okOrFail = <T extends { ok: boolean }>(r: T, label: string): r is Extract<T, { ok: true }> => {
  if (!r.ok) fails.push(`${label} unexpectedly failed: ${JSON.stringify((r as any).reasons ?? (r as any).error)}`);
  return r.ok;
};

// ── Fixture 01 — normal complete game: exact counts + coverage + PA-floor gating ──
{
  const rows = [
    row({ BAT_ID: "ozunm001", RESP_BAT_ID: "ozunm001", INN_CT: 1, PITCH_SEQ_TX: "CBBFS", EVENT_CD: 3, BALLS_CT: 2, STRIKES_CT: 2 }),
    row({ BAT_ID: "ozunm001", RESP_BAT_ID: "ozunm001", INN_CT: 3, PITCH_SEQ_TX: "BCBBFB", EVENT_CD: 14, BALLS_CT: 3, STRIKES_CT: 2 }),
    row({ BAT_ID: "ozunm001", RESP_BAT_ID: "ozunm001", INN_CT: 5, PITCH_SEQ_TX: "CBX", EVENT_CD: 20, BALLS_CT: 1, STRIKES_CT: 1 }),
    row({ BAT_ID: "ozunm001", RESP_BAT_ID: "ozunm001", INN_CT: 7, PITCH_SEQ_TX: "CBFFFX", EVENT_CD: 2, BALLS_CT: 1, STRIKES_CT: 2 }),
  ];
  const r = buildBatterDisciplineFromRows(rows, "ozunm001", PROV());
  if (okOrFail(r, "01")) {
    const c = r.evidence.batter!.counts;
    const exp = { pa: 4, k: 1, bb: 1, ibb: 0, hbp: 0, pitches: 20, swings: 8, whiffs: 1, contacts: 7, fouls: 5, calledStrikes: 4, takenPitches: 12, inPlay: 2, firstPitchStrikes: 3, twoStrikePa: 3, twoStrikeK: 1, twoStrikeSurvived: 2, codedPitchPa: 4 };
    for (const [k, v] of Object.entries(exp)) ok((c as any)[k] === v, `01 batter count ${k}=${(c as any)[k]} != ${v}`);
    ok(near(r.contactOpportunity.pitchSequenceCoverage, 1.0), "01 coverage 1.0");
    ok(r.dataQuality.sequenceFloorMet === true, "01 sequenceFloorMet true");
    // pa=4 < 150 floor ⇒ all batter rates null (raw counts preserved above).
    ok(r.contactOpportunity.kRatePct === null && r.contactOpportunity.whiffRatePct === null, "01 rates null (below_batter_pa_floor)");
    ok(r.dataQuality.nullReasons.includes("below_batter_pa_floor"), "01 below_batter_pa_floor reason");
  }
}

// ── Rate arithmetic (≥150 PA so PA floor is met) — 40× fixture-01 cycle ──
{
  const cycle: RetrosheetCweventRow[] = [];
  for (let i = 0; i < 40; i++) {
    cycle.push(row({ BAT_ID: "b", RESP_BAT_ID: "b", INN_CT: i * 4 + 1, PITCH_SEQ_TX: "CBBFS", EVENT_CD: 3, BALLS_CT: 2, STRIKES_CT: 2 }));
    cycle.push(row({ BAT_ID: "b", RESP_BAT_ID: "b", INN_CT: i * 4 + 2, PITCH_SEQ_TX: "BCBBFB", EVENT_CD: 14, BALLS_CT: 3, STRIKES_CT: 2 }));
    cycle.push(row({ BAT_ID: "b", RESP_BAT_ID: "b", INN_CT: i * 4 + 3, PITCH_SEQ_TX: "CBX", EVENT_CD: 20, BALLS_CT: 1, STRIKES_CT: 1 }));
    cycle.push(row({ BAT_ID: "b", RESP_BAT_ID: "b", INN_CT: i * 4 + 4, PITCH_SEQ_TX: "CBFFFX", EVENT_CD: 2, BALLS_CT: 1, STRIKES_CT: 2 }));
  }
  const r = buildBatterDisciplineFromRows(cycle, "b", PROV());
  if (okOrFail(r, "rate-math")) {
    const co = r.contactOpportunity;
    ok(near(co.kRatePct, 25), `kRatePct 25 got ${co.kRatePct}`);
    ok(near(co.bbRatePct, 25), `bbRatePct 25 got ${co.bbRatePct}`);
    ok(near(co.whiffRatePct, 12.5), `whiffRatePct 12.5 got ${co.whiffRatePct}`);
    ok(near(co.contactRatePct, 87.5), `contactRatePct 87.5 got ${co.contactRatePct}`);
    ok(near(co.foulStrikeRatePct, 62.5), `foulStrikeRatePct 62.5 got ${co.foulStrikeRatePct}`);
    ok(near(co.firstPitchStrikeRatePct, 75), `firstPitchStrikeRatePct 75 got ${co.firstPitchStrikeRatePct}`);
    ok(near(co.twoStrikeSurvivalRatePct, 200 / 3), `twoStrikeSurvivalRatePct 66.67 got ${co.twoStrikeSurvivalRatePct}`);
    ok(near(co.inPlayRatePct, 50), `inPlayRatePct 50 got ${co.inPlayRatePct}`);
    ok(co.chaseRatePct === null && co.zoneContactRatePct === null, "chase/zoneContact null (no leakage)");
  }
}

// ── Fixture 02 — interrupted PA: F row not a PA, "." stripped once, one PA, no double-count ──
{
  const rows = [
    row({ BAT_ID: "forsl001", PITCH_SEQ_TX: "", EVENT_CD: 6, BAT_EVENT_FL: "F", INN_CT: 5, GAME_ID: "ANA201904040" }), // interruption
    row({ BAT_ID: "forsl001", RESP_BAT_ID: "forsl001", PITCH_SEQ_TX: ".BBCX", EVENT_CD: 20, BALLS_CT: 2, STRIKES_CT: 1, INN_CT: 5, GAME_ID: "ANA201904040" }),
  ];
  const n = normalizePlateAppearances(rows);
  if (okOrFail(n, "02 normalize")) {
    ok(n.paFacts.length === 1, `02 one PA only (F row not a PA), got ${n.paFacts.length}`);
    const f = n.paFacts[0];
    ok(f.pitches === 4 && f.balls === 2 && f.calledStrikes === 1 && f.inPlayPitch === 1 && f.swings === 1, "02 '.BBCX' stripped once → B,B,C,X");
  }
  const r = buildBatterDisciplineFromRows(rows, "forsl001", PROV());
  if (okOrFail(r, "02")) ok(r.evidence.batter!.counts.pa === 1 && r.evidence.batter!.counts.codedPitchPa === 1, "02 pa=1 codedPitchPa=1 (no double-count)");
}

// ── Fixture 03 — responsible-batter substitution: charge RESP_BAT_ID, not completing BAT_ID ──
{
  const rows = [row({ BAT_ID: "jonea003", RESP_BAT_ID: "dysoj001", REMOVED_FOR_PH_BAT_ID: "dysoj001", RESP_BAT_HAND_CD: "L", RESP_PIT_HAND_CD: "R", PIT_ID: "efliz001", RESP_PIT_ID: "efliz001", PITCH_SEQ_TX: "CC.FS", EVENT_CD: 3, BALLS_CT: 0, STRIKES_CT: 2, INN_CT: 8, GAME_ID: "ARI201908060" })];
  const resp = buildBatterDisciplineFromRows(rows, "dysoj001", PROV());
  const comp = buildBatterDisciplineFromRows(rows, "jonea003", PROV());
  if (okOrFail(resp, "03 resp") && okOrFail(comp, "03 comp")) {
    ok(resp.evidence.batter!.counts.pa === 1 && resp.evidence.batter!.counts.k === 1, "03 PA+K charged to RESP_BAT_ID (dysoj001)");
    ok(comp.evidence.batter!.counts.pa === 0 && comp.evidence.batter!.counts.k === 0, "03 completing batter (jonea003) charged nothing");
  }
}

// ── Fixture 04 — handedness split attribution ──
{
  const rows = [row({ BAT_ID: "switb001", RESP_BAT_ID: "switb001", RESP_BAT_HAND_CD: "L", RESP_PIT_HAND_CD: "R", PIT_ID: "pitcr001", RESP_PIT_ID: "pitcr001", PITCH_SEQ_TX: "CBFX", EVENT_CD: 20, BALLS_CT: 1, STRIKES_CT: 2, INN_CT: 2, GAME_ID: "LAN201907040" })];
  const b = buildBatterDisciplineFromRows(rows, "switb001", PROV());
  const p = buildPitcherDisciplineFromRows(rows, "pitcr001", PROV());
  if (okOrFail(b, "04 batter")) ok(b.evidence.batter!.handSplits.paVsR === 1 && b.evidence.batter!.handSplits.paVsL === 0, "04 batter vs-RHP split (paVsR=1)");
  if (okOrFail(p, "04 pitcher")) ok(p.evidence.pitcher!.handSplits.bfVsL === 1 && p.evidence.pitcher!.handSplits.bfVsR === 0, "04 pitcher vs-LHB split (bfVsL=1)");
}

// ── Fixture 05 — missing/incomplete sequence: fail closed only where sequence is required ──
{
  const rows = [
    row({ BAT_ID: "foo001", RESP_BAT_ID: "foo001", PITCH_SEQ_TX: "", EVENT_CD: 2, INN_CT: 2, GAME_ID: "NYA201908200" }),
    row({ BAT_ID: "foo001", RESP_BAT_ID: "foo001", PITCH_SEQ_TX: "CBUX", EVENT_CD: 2, INN_CT: 4, GAME_ID: "NYA201908200" }),
  ];
  const n = normalizePlateAppearances(rows);
  if (okOrFail(n, "05 normalize")) ok(n.paFacts.length === 2 && n.paFacts.every((f) => !f.sequenceComplete), "05 both PAs sequence-incomplete but retained");
  const r = buildBatterDisciplineFromRows(rows, "foo001", PROV());
  if (okOrFail(r, "05")) {
    ok(r.evidence.batter!.counts.pa === 2 && r.evidence.batter!.counts.codedPitchPa === 0, "05 pa=2 codedPitchPa=0");
    ok(near(r.contactOpportunity.pitchSequenceCoverage, 0), "05 coverage 0");
    ok(r.dataQuality.sequenceFloorMet === false && r.dataQuality.nullReasons.includes("below_sequence_coverage"), "05 below_sequence_coverage");
    ok(r.evidence.batter!.counts.k === 0 && r.evidence.batter!.counts.bb === 0, "05 raw outcome counts preserved (k0/bb0)");
  }
}

// ── Fixture 06 — unknown handedness: overall retained, only split withheld ──
{
  const rows = [row({ BAT_ID: "ovrb001", RESP_BAT_ID: "ovrb001", RESP_BAT_HAND_CD: "L", RESP_PIT_HAND_CD: "?", PITCH_SEQ_TX: "BCBFS", EVENT_CD: 3, BALLS_CT: 2, STRIKES_CT: 2, INN_CT: 3, GAME_ID: "BOS201909100" })];
  const r = buildBatterDisciplineFromRows(rows, "ovrb001", PROV());
  if (okOrFail(r, "06")) {
    const c = r.evidence.batter!.counts, h = r.evidence.batter!.handSplits;
    ok(c.pa === 1 && c.k === 1 && c.swings === 2 && c.whiffs === 1 && c.fouls === 1 && c.codedPitchPa === 1, "06 overall retained");
    ok(h.paVsL === 0 && h.paVsR === 0, "06 split withheld (unknown pitcher hand)");
  }
}

// ── PA-fact factory for aggregate-level fixtures (07/08) and mutations ──
function fact(o: Partial<PaFact> = {}): PaFact {
  return {
    gameId: "G", inn: 1, homeBat: 0, responsibleBatterId: "B", completingBatterId: "B", pitcherId: "P",
    batterHand: null, pitcherHand: null, pitcherThrows: null, sequenceComplete: true,
    pitches: 3, balls: 1, calledStrikes: 1, whiffs: 0, fouls: 0, inPlayPitch: 1, takenPitches: 2, swings: 1, contacts: 1,
    firstPitchStrike: true, reachedTwoStrikes: false, k: 0, bb: 0, ibb: 0, hbp: 0, inPlayTerminal: 1, ...o,
  };
}
const rep = (n: number, o: Partial<PaFact>) => Array.from({ length: n }, () => fact(o));

// ── Fixture 07 — coverage below 0.90 (PA floor met): sequence-derived null, outcome present ──
{
  const facts: PaFact[] = [
    ...rep(45, { k: 1, inPlayTerminal: 0 }),
    ...rep(15, { bb: 1, inPlayTerminal: 0 }),
    ...rep(60, { inPlayTerminal: 1 }),
    ...rep(15, { sequenceComplete: false, pitches: 0, swings: 0, whiffs: 0, contacts: 0, fouls: 0, calledStrikes: 0, takenPitches: 0, inPlayPitch: 0, inPlayTerminal: 1 }),
    ...rep(15, { sequenceComplete: false, pitches: 0, swings: 0, whiffs: 0, contacts: 0, fouls: 0, calledStrikes: 0, takenPitches: 0, inPlayPitch: 0, inPlayTerminal: 0 }),
  ];
  const r = buildBatterDiscipline({ paFacts: facts, batterId: "B", provenance: PROV() });
  if (okOrFail(r, "07")) {
    const co = r.contactOpportunity;
    ok(co.batterPa === 150 && co.codedPitchPa === 120 && near(co.pitchSequenceCoverage, 0.8), "07 pa150 coded120 coverage0.8");
    ok(r.dataQuality.sequenceFloorMet === false && r.dataQuality.nullReasons.includes("below_sequence_coverage"), "07 below_sequence_coverage");
    ok(!r.dataQuality.nullReasons.includes("below_batter_pa_floor"), "07 PA floor met (not below_batter_pa_floor)");
    ok(near(co.kRatePct, 30) && near(co.bbRatePct, 10) && near(co.inPlayRatePct, 50), "07 outcome-only rates present (30/10/50)");
    ok(co.whiffRatePct === null && co.contactRatePct === null && co.foulStrikeRatePct === null && co.firstPitchStrikeRatePct === null && co.twoStrikeSurvivalRatePct === null, "07 sequence-derived rates null");
    ok(r.evidence.batter!.counts.k === 45 && r.evidence.batter!.counts.bb === 15, "07 raw counts preserved");
  }
}

// ── Fixture 08 — floor boundaries (inclusive >=) ──
function batterPresentAt(pa: number): boolean {
  const r = buildBatterDiscipline({ paFacts: rep(pa, { k: 1, inPlayTerminal: 0 }), batterId: "B", provenance: PROV() });
  return r.ok ? r.contactOpportunity.kRatePct !== null : false;
}
ok(batterPresentAt(149) === false, "08 batter 149 PA → rates absent");
ok(batterPresentAt(150) === true, "08 batter 150 PA → rates present (>=)");
ok(batterPresentAt(151) === true, "08 batter 151 PA → rates present");

function pitcherPresentAt(bf: number): boolean {
  const r = buildPitcherDiscipline({ paFacts: rep(bf, { pitcherId: "P", k: 1, inPlayTerminal: 0 }), pitcherId: "P", provenance: PROV() });
  return r.ok ? r.pitcherDiscipline.pitcherKRatePct !== null : false;
}
ok(pitcherPresentAt(299) === false, "08 pitcher 299 BF → rates absent");
ok(pitcherPresentAt(300) === true, "08 pitcher 300 BF → rates present (>=)");
ok(pitcherPresentAt(301) === true, "08 pitcher 301 BF → rates present");

function batterSplitVsLPresent(paVsL: number): boolean {
  // overall >=150 so only the split floor gates; give the L side k so kVsL>0.
  const facts = [...rep(paVsL, { pitcherHand: "L", k: 1, inPlayTerminal: 0 }), ...rep(Math.max(0, 160 - paVsL), { pitcherHand: "R" })];
  const r = buildBatterDiscipline({ paFacts: facts, batterId: "B", provenance: PROV() });
  return r.ok ? r.contactOpportunity.kRatePctVsL !== null : false;
}
ok(batterSplitVsLPresent(74) === false, "08 batter split 74 PA → vsL absent");
ok(batterSplitVsLPresent(75) === true, "08 batter split 75 PA → vsL present (>=)");
ok(batterSplitVsLPresent(76) === true, "08 batter split 76 PA → vsL present");

function pitcherSplitVsLPresent(bfVsL: number): boolean {
  const facts = [...rep(bfVsL, { pitcherId: "P", batterHand: "L", k: 1, inPlayTerminal: 0 }), ...rep(Math.max(0, 320 - bfVsL), { pitcherId: "P", batterHand: "R" })];
  const r = buildPitcherDiscipline({ paFacts: facts, pitcherId: "P", provenance: PROV() });
  return r.ok ? r.pitcherDiscipline.pitcherKRatePctVsL !== null : false;
}
ok(pitcherSplitVsLPresent(149) === false, "08 pitcher split 149 BF → vsL absent");
ok(pitcherSplitVsLPresent(150) === true, "08 pitcher split 150 BF → vsL present (>=)");
ok(pitcherSplitVsLPresent(151) === true, "08 pitcher split 151 BF → vsL present");

// ── Mutation / non-vacuous ──
// duplicate terminal PA
{
  const r = normalizePlateAppearances([
    row({ BAT_ID: "b", PITCH_SEQ_TX: "CBX", EVENT_CD: 20, BALLS_CT: 1, STRIKES_CT: 1, INN_CT: 1 }),
    row({ BAT_ID: "b", PITCH_SEQ_TX: "CBX", EVENT_CD: 20, BALLS_CT: 1, STRIKES_CT: 1, INN_CT: 1 }),
  ]);
  ok(!r.ok && r.reasons.some((x) => x.startsWith("duplicate_terminal_pa")), "mutation: duplicate terminal PA rejected");
}
// malformed interruption / invalid count arithmetic (stripped seq doesn't reconcile with count)
{
  const r = normalizePlateAppearances([row({ BAT_ID: "b", PITCH_SEQ_TX: "CX", EVENT_CD: 20, BALLS_CT: 3, STRIKES_CT: 0, INN_CT: 1 })]);
  ok(!r.ok && r.reasons.some((x) => x.startsWith("count_arithmetic_mismatch")), "mutation: count arithmetic mismatch rejected");
}
// unsupported / invalid pitch token
{
  const r = normalizePlateAppearances([row({ BAT_ID: "b", PITCH_SEQ_TX: "CBZX", EVENT_CD: 20, INN_CT: 1 })]);
  ok(!r.ok && r.reasons.some((x) => x.startsWith("unsupported_pitch_token")), "mutation: unsupported pitch token rejected");
}
// missing provenance / bad attribution notice → evidence invalid
{
  const bad = { ...PROV(), attributionNotice: "obtained from Retrosheet" };
  const r = buildBatterDiscipline({ paFacts: rep(150, { k: 1 }), batterId: "B", provenance: bad });
  ok(!r.ok && r.error === "batter_evidence_invalid" && r.reasons.some((x) => x.includes("attribution")), "mutation: bad attribution notice → evidence invalid");
}
// duplicate gameIds → evidence invalid
{
  const bad = { ...PROV(), gameIds: ["G1", "G1"] };
  const r = buildBatterDiscipline({ paFacts: rep(150, { k: 1 }), batterId: "B", provenance: bad });
  ok(!r.ok && r.reasons.some((x) => x.includes("gameIds")), "mutation: duplicate gameIds → evidence invalid");
}
// denominator zero handling (swings=0 ⇒ whiffRatePct null, no crash) at pa>=150
{
  const r = buildBatterDiscipline({ paFacts: rep(150, { swings: 0, whiffs: 0, contacts: 0, fouls: 0, inPlayPitch: 0, pitches: 4, balls: 4, calledStrikes: 0, takenPitches: 4, firstPitchStrike: false, inPlayTerminal: 0, bb: 1, ibb: 0 }), batterId: "B", provenance: PROV() });
  ok(r.ok && r.contactOpportunity.whiffRatePct === null && r.contactOpportunity.contactRatePct === null, "mutation: zero-denominator swings ⇒ whiff/contact null (no crash)");
}
// coverage immediately below vs at threshold (PA floor met)
function coverageMet(coded: number, total: number): boolean {
  const facts = [...rep(coded, { k: 0, inPlayTerminal: 1 }), ...rep(total - coded, { sequenceComplete: false, pitches: 0, swings: 0, contacts: 0, fouls: 0, whiffs: 0, calledStrikes: 0, takenPitches: 0, inPlayPitch: 0, inPlayTerminal: 1 })];
  const r = buildBatterDiscipline({ paFacts: facts, batterId: "B", provenance: PROV() });
  return r.ok ? r.dataQuality.sequenceFloorMet : false;
}
ok(coverageMet(134, 150) === false, "coverage 0.893 < 0.90 → floor not met");
ok(coverageMet(135, 150) === true, "coverage 0.90 → floor met (>=)");
// pitcher calledStrikes > BF is valid (denominator is pitches, not BF); rate uses pitches
{
  const facts = rep(300, { pitcherId: "P", calledStrikes: 2, pitches: 5, swings: 1, whiffs: 0, contacts: 1, fouls: 0, inPlayPitch: 1, balls: 3, takenPitches: 5, firstPitchStrike: true, inPlayTerminal: 1, batterHand: "R" });
  const r = buildPitcherDiscipline({ paFacts: facts, pitcherId: "P", provenance: PROV() });
  if (okOrFail(r, "pitcher calledStrikes>BF")) {
    ok(r.evidence.pitcher!.counts.calledStrikes === 600 && r.evidence.pitcher!.counts.bf === 300 && r.evidence.pitcher!.counts.pitches === 1500, "pitcher calledStrikes(600) > BF(300), pitches=1500");
    ok(near(r.pitcherDiscipline.pitcherCalledStrikeRatePct, 40), `calledStrikeRate = calledStrikes/pitches = 40, got ${r.pitcherDiscipline.pitcherCalledStrikeRatePct}`);
  }
}
// legacy pitcher vsHand output must not exist
{
  const r = buildPitcherDiscipline({ paFacts: rep(300, { pitcherId: "P", batterHand: "R", k: 1, inPlayTerminal: 0 }), pitcherId: "P", provenance: PROV() });
  if (okOrFail(r, "pitcher keys")) {
    const keys = Object.keys(r.pitcherDiscipline);
    ok(!keys.includes("batterHand") && !keys.includes("pitcherBfVsHand") && !keys.includes("pitcherKRatePctVsHand"), "no legacy vsHand/batterHand keys in pitcherDiscipline output");
    ok(keys.includes("pitcherBfVsL") && keys.includes("pitcherBfVsR") && keys.includes("pitcherPitches"), "immutable vsL/vsR history + pitches present");
    ok(Object.keys(r.evidence.pitcher!.handSplits).sort().join(",") === "bbVsL,bbVsR,bfVsL,bfVsR,kVsL,kVsR", "evidence pitcher splits are vsL/vsR only");
  }
}

// ── Determinism — identical inputs (any order) ⇒ byte-identical serialized output ──
{
  const a = [
    row({ BAT_ID: "b", RESP_BAT_ID: "b", INN_CT: 1, PITCH_SEQ_TX: "CBX", EVENT_CD: 20, BALLS_CT: 1, STRIKES_CT: 1 }),
    row({ BAT_ID: "b", RESP_BAT_ID: "b", INN_CT: 3, PITCH_SEQ_TX: "CBBFS", EVENT_CD: 3, BALLS_CT: 2, STRIKES_CT: 2 }),
  ];
  const b = [a[1], a[0]]; // reversed order
  const r1 = buildBatterDisciplineFromRows(a, "b", PROV());
  const r2 = buildBatterDisciplineFromRows(b, "b", PROV());
  ok(r1.ok && r2.ok && JSON.stringify(r1) === JSON.stringify(r2), "determinism: row order does not change serialized output");
}

// ── Floors constant matches contract §3.4 ──
ok(RETROSHEET_DISCIPLINE_FLOORS.sequenceCoverage === 0.90 && RETROSHEET_DISCIPLINE_FLOORS.batterOverallPa === 150 && RETROSHEET_DISCIPLINE_FLOORS.pitcherOverallBf === 300 && RETROSHEET_DISCIPLINE_FLOORS.batterHandSplitPa === 75 && RETROSHEET_DISCIPLINE_FLOORS.pitcherHandSplitBf === 150, "floors match contract §3.4");

console.log(`retrosheetDisciplineAdapter.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
