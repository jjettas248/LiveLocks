// PR7A stage 4 — retrosheet_discipline evidence payload validator invariants.
// Run: npx tsx server/mlb/pregamePowerRadar/hrProbabilityV2/retrosheetDisciplineEvidence.test.ts

import {
  RETROSHEET_DISCIPLINE_PROVIDERS,
  validateRetrosheetDisciplinePayload,
  type RetrosheetDisciplineEvidencePayload,
} from "./retrosheetDisciplineEvidence";
import { validateSourcePayload, EVIDENCE_KINDS } from "./plateHrV2Snapshots";

let passed = 0;
const fails: string[] = [];
function ok(cond: boolean, msg: string): void { if (cond) passed++; else fails.push(msg); }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// A valid, internally-consistent payload.
function valid(): RetrosheetDisciplineEvidencePayload {
  return {
    provenance: { datasetVersion: "retrosheet_2019_v1", dataThroughDate: "2019-09-14", seasonsCovered: [2019], gameCount: 81 },
    batter: {
      counts: {
        pa: 100, k: 22, bb: 10, ibb: 1, hbp: 2, pitches: 380, swings: 180, whiffs: 40, contacts: 140, fouls: 90,
        calledStrikes: 70, takenPitches: 200, inPlay: 50, firstPitchStrikes: 55,
        twoStrikePa: 45, twoStrikeK: 22, twoStrikeSurvived: 23, codedPitchPa: 96,
      },
      handSplits: {
        paVsL: 30, paVsR: 70, kVsL: 7, kVsR: 15, bbVsL: 3, bbVsR: 7,
        contactsVsL: 40, contactsVsR: 100, swingsVsL: 55, swingsVsR: 125, whiffsVsL: 12, whiffsVsR: 28,
      },
    },
    pitcher: {
      counts: { bf: 800, k: 210, bb: 60, ibb: 4, whiffs: 260, swings: 1200, calledStrikes: 320, firstPitchStrikes: 480 },
      handSplits: { bfVsHand: 400, kVsHand: 110, bbVsHand: 28 },
      batterHand: "L", pitcherThrows: "R",
    },
  };
}

// 1. valid passes, both directly and via the snapshots dispatcher.
ok(validateRetrosheetDisciplinePayload(valid()).ok, "valid payload passes");
ok(validateSourcePayload("retrosheet_discipline", valid()).ok, "valid payload passes via validateSourcePayload dispatch");
ok(EVIDENCE_KINDS.includes("retrosheet_discipline" as any), "retrosheet_discipline registered in EVIDENCE_KINDS");

// 2. provider set is exactly {retrosheet}.
ok(RETROSHEET_DISCIPLINE_PROVIDERS.has("retrosheet") && RETROSHEET_DISCIPLINE_PROVIDERS.size === 1, "only 'retrosheet' provider authorized");

// 3. shape guards.
ok(!validateRetrosheetDisciplinePayload(null).ok, "null rejected");
ok(!validateRetrosheetDisciplinePayload([]).ok, "array rejected");
ok(!validateRetrosheetDisciplinePayload({}).ok, "empty object rejected");

// 4. closed keys at every level.
ok(!validateRetrosheetDisciplinePayload({ ...valid(), bogus: 1 } as any).ok, "extra top field rejected");
{ const p: any = clone(valid()); p.batter.counts.bogus = 1; ok(!validateRetrosheetDisciplinePayload(p).ok, "extra batter-count field rejected"); }
{ const p: any = clone(valid()); p.provenance.bogus = 1; ok(!validateRetrosheetDisciplinePayload(p).ok, "extra provenance field rejected"); }

// 5. non-negative integer enforcement.
{ const p: any = clone(valid()); p.batter.counts.k = -1; ok(!validateRetrosheetDisciplinePayload(p).ok, "negative count rejected"); }
{ const p: any = clone(valid()); p.batter.counts.k = 2.5; ok(!validateRetrosheetDisciplinePayload(p).ok, "non-integer count rejected"); }

// 6. internal-consistency invariants (non-vacuous).
{ const p: any = clone(valid()); p.batter.counts.swings = 179; ok(!validateRetrosheetDisciplinePayload(p).ok, "swings != whiffs+contacts rejected"); }
{ const p: any = clone(valid()); p.batter.counts.fouls = 89; ok(!validateRetrosheetDisciplinePayload(p).ok, "contacts != fouls+inPlay rejected"); }
{ const p: any = clone(valid()); p.batter.counts.twoStrikeSurvived = 22; ok(!validateRetrosheetDisciplinePayload(p).ok, "twoStrikePa != twoStrikeK+survived rejected"); }
{ const p: any = clone(valid()); p.batter.counts.k = 101; ok(!validateRetrosheetDisciplinePayload(p).ok, "k > pa rejected"); }
{ const p: any = clone(valid()); p.batter.counts.codedPitchPa = 101; ok(!validateRetrosheetDisciplinePayload(p).ok, "codedPitchPa > pa rejected"); }
{ const p: any = clone(valid()); p.batter.handSplits.paVsL = 40; p.batter.handSplits.paVsR = 70; ok(!validateRetrosheetDisciplinePayload(p).ok, "paVsL+paVsR > pa rejected"); }
{ const p: any = clone(valid()); p.batter.handSplits.whiffsVsL = 56; ok(!validateRetrosheetDisciplinePayload(p).ok, "whiffsVsL > swingsVsL rejected"); }

// 7. pitcher nullable; bad pitcher shapes rejected.
{ const p: any = clone(valid()); p.pitcher = null; ok(validateRetrosheetDisciplinePayload(p).ok, "null pitcher (unknown) allowed"); }
{ const p: any = clone(valid()); p.pitcher.batterHand = "X"; ok(!validateRetrosheetDisciplinePayload(p).ok, "invalid batterHand rejected"); }
{ const p: any = clone(valid()); p.pitcher.counts.k = 801; ok(!validateRetrosheetDisciplinePayload(p).ok, "pitcher k > bf rejected"); }
{ const p: any = clone(valid()); p.pitcher.handSplits.kVsHand = 401; ok(!validateRetrosheetDisciplinePayload(p).ok, "kVsHand > bfVsHand rejected"); }

// 8. non-canonical numbers rejected.
{ const p: any = clone(valid()); p.batter.counts.pa = Infinity; ok(!validateRetrosheetDisciplinePayload(p).ok, "Infinity rejected"); }

console.log(`retrosheetDisciplineEvidence.test: ${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log("  FAIL:", f);
process.exit(fails.length ? 1 : 0);
