// ─────────────────────────────────────────────────────────────────────────────
// PR7A stage 5 (PR7A.3) — Retrosheet normalization ADAPTER (pure, deterministic).
//
// Transforms validated Chadwick/cwevent OUTPUT rows into the canonical PR7A batter/
// pitcher sufficient statistics, evidence payloads, null reasons, and V3 discipline
// feature fragments defined by the MERGED contract (plate_hr_v2_features_v3).
//
// PURE: no network, DB, env, clock, scheduler, cache, route, champion, or public
// dependency. Two deterministic layers:
//   1. PA normalization  — cwevent rows → canonical PA facts.
//   2. Actor aggregation — PA facts → evidence payloads + V3 fragments (floor-gated).
//
// STAGE-5 BOUNDARY: this module builds fragments/payloads only. It does NOT construct
// a prediction snapshot, wire capture, flip CURRENT, or remove the V3 training block.
// It is imported by NO production/champion/public/scheduled path (stage 6 gate).
//
// The frozen raw-row interpretation is the PR7A.0/7A.1 proof: the terminal
// BAT_EVENT_FL=T row carries the cumulative PITCH_SEQ_TX; the "." marker is stripped
// in one pass (never concatenate fragments); a BAT_EVENT_FL=F row is not a PA; a
// two-strike substitution charges RESP_BAT_ID, not the completing BAT_ID.
//
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineAdapter.test.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  plateHrV2ContactOpportunityV3FeaturesSchema,
  plateHrV2PitcherDisciplineFeaturesSchema,
  plateHrV2RetrosheetQualityBlockSchema,
  type PlateHrV2ContactOpportunityV3Features,
  type PlateHrV2PitcherDisciplineFeatures,
  type PlateHrV2RetrosheetQualityBlock,
  type PlateDisciplineFloorNullReason,
} from "./plateHrV2FeatureContract";
import {
  validateRetrosheetDisciplinePayload,
  type RetrosheetDisciplineEvidencePayload,
} from "./retrosheetDisciplineEvidence";

// ── Frozen capture-usability floors (contract §3.4) ───────────────────────────
export const RETROSHEET_DISCIPLINE_FLOORS = {
  sequenceCoverage: 0.90,
  batterOverallPa: 150,
  pitcherOverallBf: 300,
  batterHandSplitPa: 75,
  pitcherHandSplitBf: 150,
} as const;

// ── Frozen pitch-token classification (contract §1.4 / README) ────────────────
const BALL = new Set(["B", "I", "V", "P"]);
const CALLED = new Set(["C"]);
const WHIFF = new Set(["S", "M"]);
const FOUL = new Set(["F", "T", "L", "O", "R"]);
const INPLAY = new Set(["X", "Y"]);
const HBP = new Set(["H"]);
const MARKER = new Set([".", "+", "*", ">", "1", "2", "3", "N"]);
const UNCOUNTABLE = new Set(["U", "K", "Q"]);
// EVENT_CD (Retrosheet): 3=K, 14=BB, 15=IBB, 16=HBP; ball-in-play outcomes below.
const IN_PLAY_EVENT_CDS = new Set([2, 18, 19, 20, 21, 22, 23]);

// ── Input: a Chadwick cwevent OUTPUT row (the shape PR7A.1 anchored fixtures 02/03) ─
export interface RetrosheetCweventRow {
  GAME_ID: string;
  INN_CT?: number | string;
  BAT_HOME_ID?: number | string;
  BAT_ID: string;
  RESP_BAT_ID?: string;
  REMOVED_FOR_PH_BAT_ID?: string;
  BAT_HAND_CD?: string;
  RESP_BAT_HAND_CD?: string;
  PIT_ID?: string;
  RESP_PIT_ID?: string;
  PIT_HAND_CD?: string;
  RESP_PIT_HAND_CD?: string;
  PITCH_SEQ_TX: string;
  EVENT_TX?: string;
  EVENT_CD: number | string;
  BAT_EVENT_FL: string;
  BALLS_CT?: number | string;
  STRIKES_CT?: number | string;
}

export interface PaFact {
  gameId: string;
  inn: number;
  homeBat: number;
  responsibleBatterId: string; // charge PA/K here (RESP_BAT_ID)
  completingBatterId: string;  // BAT_ID
  pitcherId: string;
  batterHand: "L" | "R" | null;  // resolved batter hand → keys the PITCHER's split; null if "?"/unknown
  pitcherHand: "L" | "R" | null; // resolved pitcher hand → keys the BATTER's split; null if "?"/unknown
  pitcherThrows: "L" | "R" | null;
  sequenceComplete: boolean;
  // pitch-token counts (meaningful only when sequenceComplete)
  pitches: number; balls: number; calledStrikes: number; whiffs: number;
  fouls: number; inPlayPitch: number; takenPitches: number; swings: number; contacts: number;
  firstPitchStrike: boolean;
  reachedTwoStrikes: boolean;
  // outcome (from EVENT_CD; valid for all PAs)
  k: 0 | 1; bb: 0 | 1; ibb: 0 | 1; hbp: 0 | 1; inPlayTerminal: 0 | 1;
}

export type AdapterFailure = { ok: false; error: string; reasons: string[] };

function num(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return null;
}
function normHand(x: unknown): "L" | "R" | null { return x === "L" || x === "R" ? x : null; }
function stripMarkers(seq: string): string[] { return Array.from(seq).filter((c) => !MARKER.has(c)); }

/** Layer 1 — normalize cwevent rows into canonical PA facts. Fail-closed on an
 * unsupported pitch character, a duplicate terminal PA, or a terminal count that
 * does not reconcile with a supplied BALLS_CT/STRIKES_CT. Deterministic: PA facts
 * are canonically ordered (row order is not semantically significant for sums). */
export function normalizePlateAppearances(rows: readonly RetrosheetCweventRow[]): { ok: true; paFacts: PaFact[] } | AdapterFailure {
  const reasons: string[] = [];
  const facts: PaFact[] = [];
  const seen = new Set<string>();
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    if (r.BAT_EVENT_FL !== "T") continue; // an interruption / non-batting-event row is NOT a PA
    if (typeof r.BAT_ID !== "string" || r.BAT_ID.length === 0) { reasons.push(`row_${idx}_missing_bat_id`); continue; }
    const cd = num(r.EVENT_CD);
    if (cd == null) { reasons.push(`row_${idx}_missing_event_cd`); continue; }

    // duplicate terminal PA guard (order-independent composite key)
    const dupKey = [r.GAME_ID, r.INN_CT ?? "", r.BAT_HOME_ID ?? "", r.BAT_ID, r.PITCH_SEQ_TX, cd].join("|");
    if (seen.has(dupKey)) { reasons.push(`duplicate_terminal_pa:${dupKey}`); continue; }
    seen.add(dupKey);

    // strip the "." (and other non-pitch markers) in ONE pass — never concatenate fragments
    const toks = stripMarkers(r.PITCH_SEQ_TX ?? "");
    const unknown = toks.find((c) => !BALL.has(c) && !CALLED.has(c) && !WHIFF.has(c) && !FOUL.has(c) && !INPLAY.has(c) && !HBP.has(c) && !UNCOUNTABLE.has(c));
    if (unknown) { reasons.push(`unsupported_pitch_token:${unknown}`); continue; } // fail closed, never guess

    const hasUncountable = toks.some((c) => UNCOUNTABLE.has(c));
    const empty = toks.length === 0;
    const sequenceComplete = !empty && !hasUncountable;

    let balls = 0, calledStrikes = 0, whiffs = 0, fouls = 0, inPlayPitch = 0;
    let running = 0, reachedTwo = false;
    if (sequenceComplete) {
      for (const t of toks) {
        if (BALL.has(t)) balls++;
        else if (CALLED.has(t)) { calledStrikes++; if (running < 2) running++; }
        else if (WHIFF.has(t)) { whiffs++; if (running < 2) running++; }
        else if (FOUL.has(t)) { fouls++; if (running < 2) running++; }
        else if (INPLAY.has(t)) inPlayPitch++;
        if (running >= 2) reachedTwo = true;
      }
    }
    const contacts = fouls + inPlayPitch;
    const swings = whiffs + contacts;
    const takenPitches = balls + calledStrikes;
    const first = toks[0];
    const firstPitchStrike = sequenceComplete && !!first && (CALLED.has(first) || WHIFF.has(first) || FOUL.has(first) || INPLAY.has(first));

    // reconcile the terminal cumulative sequence with a supplied entering count
    if (sequenceComplete && r.BALLS_CT != null && r.STRIKES_CT != null) {
      const eb = num(r.BALLS_CT), es = num(r.STRIKES_CT);
      let cb = 0, cs = 0;
      for (let i = 0; i < toks.length - 1; i++) { const t = toks[i]; if (BALL.has(t)) cb++; else if (CALLED.has(t) || WHIFF.has(t) || FOUL.has(t)) { if (cs < 2) cs++; } }
      if (eb != null && es != null && (cb !== eb || cs !== es)) { reasons.push(`count_arithmetic_mismatch:${dupKey}:derived(${cb},${cs})!=cwevent(${eb},${es})`); continue; }
    }

    const isK = cd === 3;
    facts.push({
      gameId: r.GAME_ID,
      inn: num(r.INN_CT) ?? 0,
      homeBat: num(r.BAT_HOME_ID) ?? 0,
      responsibleBatterId: (typeof r.RESP_BAT_ID === "string" && r.RESP_BAT_ID.length > 0) ? r.RESP_BAT_ID : r.BAT_ID,
      completingBatterId: r.BAT_ID,
      pitcherId: (typeof r.RESP_PIT_ID === "string" && r.RESP_PIT_ID.length > 0) ? r.RESP_PIT_ID : (r.PIT_ID ?? ""),
      batterHand: normHand(r.RESP_BAT_HAND_CD ?? r.BAT_HAND_CD),
      pitcherHand: normHand(r.RESP_PIT_HAND_CD ?? r.PIT_HAND_CD),
      pitcherThrows: normHand(r.RESP_PIT_HAND_CD ?? r.PIT_HAND_CD),
      sequenceComplete,
      pitches: sequenceComplete ? toks.length : 0,
      balls, calledStrikes, whiffs, fouls, inPlayPitch, takenPitches, swings, contacts,
      firstPitchStrike,
      reachedTwoStrikes: reachedTwo,
      k: isK ? 1 : 0,
      bb: (cd === 14 || cd === 15) ? 1 : 0,
      ibb: cd === 15 ? 1 : 0,
      hbp: cd === 16 ? 1 : 0,
      inPlayTerminal: IN_PLAY_EVENT_CDS.has(cd) ? 1 : 0,
    });
  }
  if (reasons.length > 0) return { ok: false, error: "pa_normalization_failed", reasons };
  facts.sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : a.inn - b.inn || a.homeBat - b.homeBat || (a.completingBatterId < b.completingBatterId ? -1 : a.completingBatterId > b.completingBatterId ? 1 : (a.pitches - b.pitches))));
  return { ok: true, paFacts: facts };
}

// caller-supplied, never-synthesized provenance (contract §4)
export interface RetrosheetProvenanceInput {
  datasetVersion: string;
  dataThroughDate: string;
  seasonsCovered: number[];
  window: { from: string; to: string };
  gameIds: string[];
  attributionNotice: string;
}

const rate = (numr: number, den: number): number | null => (den > 0 ? (100 * numr) / den : null);
const coverageOf = (coded: number, pa: number): number | null => (pa > 0 ? coded / pa : null);

// ── Layer 2a — batter aggregation + fragments ─────────────────────────────────
export interface BatterDisciplineResult {
  ok: true;
  evidence: RetrosheetDisciplineEvidencePayload;
  contactOpportunity: PlateHrV2ContactOpportunityV3Features;
  dataQuality: PlateHrV2RetrosheetQualityBlock;
}

export function buildBatterDiscipline(args: { paFacts: readonly PaFact[]; batterId: string; provenance: RetrosheetProvenanceInput }): BatterDisciplineResult | AdapterFailure {
  const facts = args.paFacts.filter((f) => f.responsibleBatterId === args.batterId);
  const complete = facts.filter((f) => f.sequenceComplete);
  const sum = (arr: readonly PaFact[], k: (f: PaFact) => number) => arr.reduce((s, f) => s + k(f), 0);

  // raw sufficient statistics — outcome over ALL PAs, pitch-derived over COMPLETE PAs
  const pa = facts.length;
  const k = sum(facts, (f) => f.k), bb = sum(facts, (f) => f.bb), ibb = sum(facts, (f) => f.ibb), hbp = sum(facts, (f) => f.hbp);
  const inPlayTerminal = sum(facts, (f) => f.inPlayTerminal);
  const codedPitchPa = complete.length;
  const pitches = sum(complete, (f) => f.pitches), swings = sum(complete, (f) => f.swings), whiffs = sum(complete, (f) => f.whiffs);
  const contacts = sum(complete, (f) => f.contacts), fouls = sum(complete, (f) => f.fouls);
  const calledStrikes = sum(complete, (f) => f.calledStrikes), takenPitches = sum(complete, (f) => f.takenPitches), inPlayPitch = sum(complete, (f) => f.inPlayPitch);
  const firstPitchStrikes = sum(complete, (f) => (f.firstPitchStrike ? 1 : 0));
  const twoStrikePa = sum(complete, (f) => (f.reachedTwoStrikes ? 1 : 0));
  const twoStrikeK = sum(complete, (f) => (f.reachedTwoStrikes && f.k ? 1 : 0));
  const twoStrikeSurvived = sum(complete, (f) => (f.reachedTwoStrikes && !f.k ? 1 : 0));

  // hand splits keyed by the PITCHER's hand; unknown ("?"/null) withheld from both sides
  const bySide = (hand: "L" | "R", k2: (f: PaFact) => number, onlyComplete = false) => sum((onlyComplete ? complete : facts).filter((f) => f.pitcherHand === hand), k2);
  const paVsL = facts.filter((f) => f.pitcherHand === "L").length, paVsR = facts.filter((f) => f.pitcherHand === "R").length;
  const kVsL = bySide("L", (f) => f.k), kVsR = bySide("R", (f) => f.k);
  const bbVsL = bySide("L", (f) => f.bb), bbVsR = bySide("R", (f) => f.bb);
  const swingsVsL = bySide("L", (f) => f.swings, true), swingsVsR = bySide("R", (f) => f.swings, true);
  const whiffsVsL = bySide("L", (f) => f.whiffs, true), whiffsVsR = bySide("R", (f) => f.whiffs, true);
  const contactsVsL = bySide("L", (f) => f.contacts, true), contactsVsR = bySide("R", (f) => f.contacts, true);

  const coverage = coverageOf(codedPitchPa, pa);
  const sequenceFloorMet = coverage != null && coverage >= RETROSHEET_DISCIPLINE_FLOORS.sequenceCoverage;
  const belowPa = pa < RETROSHEET_DISCIPLINE_FLOORS.batterOverallPa;

  const nullReasons: PlateDisciplineFloorNullReason[] = [];
  if (!sequenceFloorMet) nullReasons.push("below_sequence_coverage");
  if (belowPa) nullReasons.push("below_batter_pa_floor");
  const splitBelow = (n: number) => n < RETROSHEET_DISCIPLINE_FLOORS.batterHandSplitPa;
  if ((splitBelow(paVsL) || splitBelow(paVsR)) && !nullReasons.includes("below_hand_split_pa_floor")) nullReasons.push("below_hand_split_pa_floor");

  // Rate gating. Outcome-only leaves (k/bb/inPlay) survive a coverage failure; ALL
  // batter rates null below the PA floor. Raw counts are ALWAYS preserved.
  const seqOk = sequenceFloorMet && !belowPa;
  const outOk = !belowPa;
  const contactOpportunity: PlateHrV2ContactOpportunityV3Features = plateHrV2ContactOpportunityV3FeaturesSchema.parse({
    kRatePct: outOk ? rate(k, pa) : null,
    bbRatePct: outOk ? rate(bb - ibb, pa) : null,
    whiffRatePct: seqOk ? rate(whiffs, swings) : null,
    contactRatePct: seqOk ? rate(contacts, swings) : null,
    zoneContactRatePct: null,
    chaseRatePct: null,
    foulStrikeRatePct: seqOk ? rate(fouls, swings) : null,
    firstPitchStrikeRatePct: seqOk ? rate(firstPitchStrikes, pa) : null,
    twoStrikeSurvivalRatePct: seqOk ? rate(twoStrikeSurvived, twoStrikePa) : null,
    inPlayRatePct: outOk ? rate(inPlayTerminal, pa) : null,
    batterPa: pa,
    codedPitchPa,
    pitchSequenceCoverage: coverage,
    kRatePctVsL: seqOk && !splitBelow(paVsL) ? rate(kVsL, paVsL) : null,
    kRatePctVsR: seqOk && !splitBelow(paVsR) ? rate(kVsR, paVsR) : null,
    bbRatePctVsL: seqOk && !splitBelow(paVsL) ? rate(bbVsL, paVsL) : null,
    bbRatePctVsR: seqOk && !splitBelow(paVsR) ? rate(bbVsR, paVsR) : null,
    contactRatePctVsL: seqOk && !splitBelow(paVsL) ? rate(contactsVsL, swingsVsL) : null,
    contactRatePctVsR: seqOk && !splitBelow(paVsR) ? rate(contactsVsR, swingsVsR) : null,
    whiffRatePctVsL: seqOk && !splitBelow(paVsL) ? rate(whiffsVsL, swingsVsL) : null,
    whiffRatePctVsR: seqOk && !splitBelow(paVsR) ? rate(whiffsVsR, swingsVsR) : null,
    paVsL, paVsR,
    extra: {},
  });

  const overallQuality: "full" | "degraded" | "missing" = pa === 0 ? "missing" : nullReasons.length > 0 ? "degraded" : "full";
  const dataQuality = plateHrV2RetrosheetQualityBlockSchema.parse({
    datasetVersion: args.provenance.datasetVersion,
    dataThroughDate: args.provenance.dataThroughDate,
    pitchSequenceCoverage: coverage,
    sequenceFloorMet,
    overallQuality,
    nullReasons,
  });

  const evidence: RetrosheetDisciplineEvidencePayload = {
    actorType: "batter",
    provenance: {
      ...args.provenance,
      gameCount: args.provenance.gameIds.length,
      sequenceFloorMet, overallQuality, nullReasons: [...nullReasons],
    },
    batter: {
      counts: { pa, k, bb, ibb, hbp, pitches, swings, whiffs, contacts, fouls, calledStrikes, takenPitches, inPlay: inPlayPitch, firstPitchStrikes, twoStrikePa, twoStrikeK, twoStrikeSurvived, codedPitchPa },
      handSplits: { paVsL, paVsR, kVsL, kVsR, bbVsL, bbVsR, contactsVsL, contactsVsR, swingsVsL, swingsVsR, whiffsVsL, whiffsVsR },
    },
  };
  const v = validateRetrosheetDisciplinePayload(evidence);
  if (!v.ok) return { ok: false, error: "batter_evidence_invalid", reasons: v.reasons };
  return { ok: true, evidence, contactOpportunity, dataQuality };
}

// ── Layer 2b — pitcher aggregation + fragments ────────────────────────────────
export interface PitcherDisciplineResult {
  ok: true;
  evidence: RetrosheetDisciplineEvidencePayload;
  pitcherDiscipline: PlateHrV2PitcherDisciplineFeatures;
  dataQuality: PlateHrV2RetrosheetQualityBlock;
}

export function buildPitcherDiscipline(args: { paFacts: readonly PaFact[]; pitcherId: string; provenance: RetrosheetProvenanceInput }): PitcherDisciplineResult | AdapterFailure {
  const facts = args.paFacts.filter((f) => f.pitcherId === args.pitcherId);
  const complete = facts.filter((f) => f.sequenceComplete);
  const sum = (arr: readonly PaFact[], k: (f: PaFact) => number) => arr.reduce((s, f) => s + k(f), 0);

  const bf = facts.length;
  const k = sum(facts, (f) => f.k), bb = sum(facts, (f) => f.bb), ibb = sum(facts, (f) => f.ibb);
  const pitches = sum(complete, (f) => f.pitches), swings = sum(complete, (f) => f.swings), whiffs = sum(complete, (f) => f.whiffs);
  const calledStrikes = sum(complete, (f) => f.calledStrikes);
  const firstPitchStrikes = sum(complete, (f) => (f.firstPitchStrike ? 1 : 0));
  const codedBf = complete.length;

  // pitcher hand splits keyed by the BATTER's hand; unknown withheld
  const bfVsL = facts.filter((f) => f.batterHand === "L").length, bfVsR = facts.filter((f) => f.batterHand === "R").length;
  const kVsL = sum(facts.filter((f) => f.batterHand === "L"), (f) => f.k), kVsR = sum(facts.filter((f) => f.batterHand === "R"), (f) => f.k);
  const bbVsL = sum(facts.filter((f) => f.batterHand === "L"), (f) => f.bb), bbVsR = sum(facts.filter((f) => f.batterHand === "R"), (f) => f.bb);
  // pitcherThrows: first non-null after canonical sort (deterministic)
  const pitcherThrows = facts.find((f) => f.pitcherThrows != null)?.pitcherThrows ?? null;

  const coverage = coverageOf(codedBf, bf);
  const sequenceFloorMet = coverage != null && coverage >= RETROSHEET_DISCIPLINE_FLOORS.sequenceCoverage;
  const belowBf = bf < RETROSHEET_DISCIPLINE_FLOORS.pitcherOverallBf;
  const splitBelow = (n: number) => n < RETROSHEET_DISCIPLINE_FLOORS.pitcherHandSplitBf;

  const nullReasons: PlateDisciplineFloorNullReason[] = [];
  if (!sequenceFloorMet) nullReasons.push("below_sequence_coverage");
  if (belowBf) nullReasons.push("below_pitcher_bf_floor");
  if ((splitBelow(bfVsL) || splitBelow(bfVsR)) && !nullReasons.includes("below_hand_split_bf_floor")) nullReasons.push("below_hand_split_bf_floor");

  const seqOk = sequenceFloorMet && !belowBf;
  const outOk = !belowBf;
  const pitcherDiscipline: PlateHrV2PitcherDisciplineFeatures = plateHrV2PitcherDisciplineFeaturesSchema.parse({
    pitcherKnown: bf > 0,
    pitcherThrows,
    pitcherKRatePct: outOk ? rate(k, bf) : null,
    pitcherBbRatePct: outOk ? rate(bb - ibb, bf) : null,
    pitcherWhiffRatePct: seqOk ? rate(whiffs, swings) : null,
    pitcherCalledStrikeRatePct: seqOk ? rate(calledStrikes, pitches) : null, // calledStrikes / pitches (NEVER / BF)
    pitcherFirstPitchStrikeRatePct: seqOk ? rate(firstPitchStrikes, bf) : null,
    pitcherKRatePctVsL: outOk && !splitBelow(bfVsL) ? rate(kVsL, bfVsL) : null,
    pitcherKRatePctVsR: outOk && !splitBelow(bfVsR) ? rate(kVsR, bfVsR) : null,
    pitcherBbRatePctVsL: outOk && !splitBelow(bfVsL) ? rate(bbVsL - 0, bfVsL) : null,
    pitcherBbRatePctVsR: outOk && !splitBelow(bfVsR) ? rate(bbVsR - 0, bfVsR) : null,
    pitcherPitches: pitches,
    pitcherBf: bf,
    pitcherBfVsL: bfVsL,
    pitcherBfVsR: bfVsR,
    extra: {},
  });

  const overallQuality: "full" | "degraded" | "missing" = bf === 0 ? "missing" : nullReasons.length > 0 ? "degraded" : "full";
  const dataQuality = plateHrV2RetrosheetQualityBlockSchema.parse({
    datasetVersion: args.provenance.datasetVersion,
    dataThroughDate: args.provenance.dataThroughDate,
    pitchSequenceCoverage: coverage,
    sequenceFloorMet,
    overallQuality,
    nullReasons,
  });

  const evidence: RetrosheetDisciplineEvidencePayload = {
    actorType: "pitcher",
    provenance: { ...args.provenance, gameCount: args.provenance.gameIds.length, sequenceFloorMet, overallQuality, nullReasons: [...nullReasons] },
    pitcher: {
      counts: { bf, pitches, k, bb, ibb, whiffs, swings, calledStrikes, firstPitchStrikes },
      handSplits: { bfVsL, bfVsR, kVsL, kVsR, bbVsL, bbVsR },
      pitcherThrows,
    },
  };
  const v = validateRetrosheetDisciplinePayload(evidence);
  if (!v.ok) return { ok: false, error: "pitcher_evidence_invalid", reasons: v.reasons };
  return { ok: true, evidence, pitcherDiscipline, dataQuality };
}

// ── Convenience row-based entry points (normalize → build) ────────────────────
export function buildBatterDisciplineFromRows(rows: readonly RetrosheetCweventRow[], batterId: string, provenance: RetrosheetProvenanceInput): BatterDisciplineResult | AdapterFailure {
  const n = normalizePlateAppearances(rows);
  if (!n.ok) return n;
  return buildBatterDiscipline({ paFacts: n.paFacts, batterId, provenance });
}
export function buildPitcherDisciplineFromRows(rows: readonly RetrosheetCweventRow[], pitcherId: string, provenance: RetrosheetProvenanceInput): PitcherDisciplineResult | AdapterFailure {
  const n = normalizePlateAppearances(rows);
  if (!n.ok) return n;
  return buildPitcherDiscipline({ paFacts: n.paFacts, pitcherId, provenance });
}
