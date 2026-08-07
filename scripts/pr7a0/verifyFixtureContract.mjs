// PR7A.1 — revised contract comparison (offline verifier, NOT wired into runtime).
//
// Validates each committed retrosheetDiscipline fixture against:
//   (a) SELF-CONSISTENCY: every plate appearance's declared discipline fields
//       (balls / calledStrikes / swingingStrikes / fouls / inPlay / takenPitches /
//        swings / entering count / firstPitchStrike / reachedTwoStrikes) recomputed
//       from its pitch tokens using the frozen token table (mirrors the fixture README).
//   (b) REAL-OUTPUT CROSS-CHECK: for cases whose raw.sourceFormat is
//       'chadwick_cwevent_output_row', the terminal record is located verbatim in the
//       committed PR7A.0 proof CSV and its PITCH_SEQ_TX / BALLS_CT / STRIKES_CT /
//       RESP_BAT_ID / EVENT_CD / BAT_EVENT_FL / REMOVED_FOR_PH_BAT_ID are matched exactly.
//   (c) COMPLETENESS cases: sequence-incomplete PAs must declare the correct
//       completenessReason (empty vs uncountable) and a null sequence contribution.
//   (d) AGGREGATE cases: coverage arithmetic and floor booleans are internally consistent.
//
// Exits non-zero if any case fails. Reads the committed proof; performs no network,
// no ingestion, no DB, and imports zero project code.
//
// Usage: node scripts/pr7a0/verifyFixtureContract.mjs \
//          --fixtures server/mlb/pregamePowerRadar/hrProbabilityV2/fixtures/retrosheetDiscipline \
//          --proof docs/plate/pr7a0-proof [--out <result.json>]

import fs from 'node:fs';
import path from 'node:path';

// ---- frozen pitch-token classification (mirrors fixture README §"Pitch-sequence token classification") ----
const BALL = new Set(['B', 'I', 'V', 'P']);
const CALLED = new Set(['C']);
const WHIFF = new Set(['S', 'M']);
const FOUL = new Set(['F', 'T', 'L', 'O', 'R']);
const INPLAY = new Set(['X', 'Y']);
const HBP = new Set(['H']);
const MARKER = new Set(['.', '+', '*', '>', '1', '2', '3', 'N']);
const UNCOUNTABLE = new Set(['U', 'K', 'Q']);

function getArg(name, fb = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fb;
}
const FIX_DIR = getArg('--fixtures');
const PROOF_DIR = getArg('--proof');
const OUT = getArg('--out');
if (!FIX_DIR || !PROOF_DIR) { console.error('missing --fixtures/--proof'); process.exit(2); }

const strip = (seq) => [...(seq || '')].filter((c) => !MARKER.has(c));

// recompute discipline stats from a pitch-token list (already stripped of markers)
function classify(tokens) {
  let balls = 0, calledStrikes = 0, swingingStrikes = 0, fouls = 0, inPlay = 0, hbp = 0;
  for (const t of tokens) {
    if (BALL.has(t)) balls++;
    else if (CALLED.has(t)) calledStrikes++;
    else if (WHIFF.has(t)) swingingStrikes++;
    else if (FOUL.has(t)) fouls++;
    else if (INPLAY.has(t)) inPlay++;
    else if (HBP.has(t)) hbp++;
  }
  const takenPitches = balls + calledStrikes;
  const swings = fouls + swingingStrikes + inPlay;
  // count entering the terminal pitch, capped at 2 strikes
  let cb = 0, cs = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (BALL.has(t)) cb++;
    else if (CALLED.has(t) || WHIFF.has(t) || FOUL.has(t)) { if (cs < 2) cs++; }
  }
  // reachedTwoStrikes: strikes hit 2 at any point across the whole sequence
  let running = 0, reachedTwo = false;
  for (const t of tokens) {
    if (CALLED.has(t) || WHIFF.has(t) || FOUL.has(t)) { if (running < 2) running++; }
    if (running >= 2) reachedTwo = true;
  }
  const first = tokens[0];
  const firstPitchStrike = !!first && (CALLED.has(first) || WHIFF.has(first) || FOUL.has(first) || INPLAY.has(first));
  return { balls, calledStrikes, swingingStrikes, fouls, inPlay, hbp, takenPitches, swings, enteringCount: { balls: cb, strikes: cs }, reachedTwoStrikes: reachedTwo, firstPitchStrike };
}

// ---- CSV loader (quoted, comma-delimited cwevent -a output) ----
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); rows.push(out);
  }
  return rows;
}
function loadCsvRows(file) {
  const parsed = parseCsv(fs.readFileSync(file, 'utf8'));
  const h = parsed[0].map((s) => s.replace(/^"|"$/g, ''));
  return parsed.slice(1).map((c) => {
    const o = {}; for (let j = 0; j < h.length; j++) o[h[j]] = (c[j] || '').replace(/^"|"$/g, ''); return o;
  });
}

const results = [];
const eq = (a, b) => String(a) === String(b);

function checkPa(caseId, i, pa) {
  const problems = [];
  const tokens = pa.reassembledPitches || pa.pitches;
  if (pa.sequenceComplete === false) return problems; // completeness handled separately
  if (!Array.isArray(tokens)) return problems;         // aggregate-only PA
  // tokens must equal the marker-stripped seq (proves "strip once, no concat")
  if (typeof pa.seq === 'string') {
    const stripped = strip(pa.seq).join('');
    if (stripped !== tokens.join('')) problems.push(`PA[${i}] stripped seq '${stripped}' != reassembledPitches '${tokens.join('')}'`);
  }
  const d = classify(tokens);
  const fields = ['balls', 'calledStrikes', 'swingingStrikes', 'fouls', 'inPlay', 'takenPitches', 'swings'];
  for (const f of fields) if (pa[f] !== undefined && !eq(pa[f], d[f])) problems.push(`PA[${i}].${f}: declared ${pa[f]} != recomputed ${d[f]}`);
  if (pa.count && (!eq(pa.count.balls, d.enteringCount.balls) || !eq(pa.count.strikes, d.enteringCount.strikes)))
    problems.push(`PA[${i}].count declared ${JSON.stringify(pa.count)} != recomputed ${JSON.stringify(d.enteringCount)}`);
  if (pa.firstPitchStrike !== undefined && pa.firstPitchStrike !== d.firstPitchStrike) problems.push(`PA[${i}].firstPitchStrike ${pa.firstPitchStrike} != ${d.firstPitchStrike}`);
  if (pa.reachedTwoStrikes !== undefined && pa.reachedTwoStrikes !== d.reachedTwoStrikes) problems.push(`PA[${i}].reachedTwoStrikes ${pa.reachedTwoStrikes} != ${d.reachedTwoStrikes}`);
  return problems;
}

function crossCheckReal(fx) {
  const problems = [];
  const rec = fx.raw && fx.raw.terminalBatterEventRecord;
  const csvName = fx.validatedAgainstProof && fx.validatedAgainstProof.cweventOutputFile;
  if (!rec || !csvName) { problems.push('real-anchored fixture missing terminalBatterEventRecord or cweventOutputFile'); return problems; }
  const csvPath = path.join(process.cwd(), csvName);
  if (!fs.existsSync(csvPath)) { problems.push(`proof CSV not found: ${csvName}`); return problems; }
  const rows = loadCsvRows(csvPath);
  const match = rows.find((r) => eq(r.BAT_ID, rec.BAT_ID) && eq(r.PITCH_SEQ_TX, rec.PITCH_SEQ_TX) && eq(r.INN_CT, rec.INN_CT));
  if (!match) { problems.push(`no real cwevent row for BAT_ID=${rec.BAT_ID} INN=${rec.INN_CT} SEQ=${rec.PITCH_SEQ_TX} in ${path.basename(csvName)}`); return problems; }
  for (const k of ['GAME_ID', 'RESP_BAT_ID', 'PITCH_SEQ_TX', 'EVENT_CD', 'BAT_EVENT_FL', 'BALLS_CT', 'STRIKES_CT', 'PIT_ID']) {
    if (rec[k] !== undefined && !eq(match[k], rec[k])) problems.push(`real ${k}='${match[k]}' != fixture '${rec[k]}'`);
  }
  if (rec.REMOVED_FOR_PH_BAT_ID !== undefined && !eq(match.REMOVED_FOR_PH_BAT_ID, rec.REMOVED_FOR_PH_BAT_ID))
    problems.push(`real REMOVED_FOR_PH_BAT_ID='${match.REMOVED_FOR_PH_BAT_ID}' != fixture '${rec.REMOVED_FOR_PH_BAT_ID}'`);
  return problems;
}

function checkCompleteness(caseId, pas) {
  const problems = [];
  for (let i = 0; i < pas.length; i++) {
    const pa = pas[i];
    if (pa.sequenceComplete !== false) continue;
    const stripped = strip(pa.seq);
    const hasUncountable = stripped.some((c) => UNCOUNTABLE.has(c));
    const isEmpty = stripped.length === 0;
    if (isEmpty && pa.completenessReason !== 'empty_sequence') problems.push(`PA[${i}] empty seq but reason='${pa.completenessReason}'`);
    if (!isEmpty && hasUncountable && pa.completenessReason !== 'uncountable_pitch_token') problems.push(`PA[${i}] uncountable seq but reason='${pa.completenessReason}'`);
    if (pa.sequenceDerivedContribution !== null && pa.sequenceDerivedContribution !== undefined) problems.push(`PA[${i}] incomplete but sequenceDerivedContribution not null`);
  }
  return problems;
}

function checkAggregate(fx) {
  const problems = [];
  const e = fx.expected || {};
  const cov = e.coverage;
  if (cov) {
    const expect = cov.batterPa ? +(cov.codedPitchPa / cov.batterPa).toFixed(4) : null;
    if (expect !== null && Math.abs(expect - cov.pitchSequenceCoverage) > 1e-6) problems.push(`coverage ${cov.pitchSequenceCoverage} != codedPitchPa/batterPa ${expect}`);
    if (cov.sequenceFloorMet !== (cov.pitchSequenceCoverage >= cov.coverageFloor)) problems.push(`sequenceFloorMet ${cov.sequenceFloorMet} inconsistent with coverage vs floor`);
  }
  const bo = e.batterOverall;
  if (Array.isArray(bo)) for (const b of bo) if (b.batterRatesPresent !== (b.pa >= (fx.floors?.batterOverallPa ?? 150))) problems.push(`batterOverall ${b.batterId} present flag inconsistent with pa vs floor`);
  const po = e.pitcherOverall;
  if (Array.isArray(po)) for (const p of po) if (p.pitcherRatesPresent !== (p.bf >= (fx.floors?.pitcherOverallBf ?? 300))) problems.push(`pitcherOverall ${p.pitcherId} present flag inconsistent with bf vs floor`);
  return problems;
}

const caseFiles = fs.readdirSync(path.join(FIX_DIR, 'cases')).filter((f) => f.endsWith('.json')).sort();
for (const cf of caseFiles) {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'cases', cf), 'utf8'));
  const problems = [];
  const pas = (fx.expected && fx.expected.plateAppearances) || [];
  for (let i = 0; i < pas.length; i++) problems.push(...checkPa(fx.case, i, pas[i]));
  problems.push(...checkCompleteness(fx.case, pas));
  problems.push(...checkAggregate(fx));
  const realAnchored = fx.raw && fx.raw.sourceFormat === 'chadwick_cwevent_output_row';
  if (realAnchored) problems.push(...crossCheckReal(fx));
  results.push({ case: fx.case, realAnchored, checks: pas.length, status: problems.length ? 'FAIL' : 'PASS', problems });
}

// global grammar backing from the committed proof
let grammarBacking = null;
try {
  const g = JSON.parse(fs.readFileSync(path.join(process.cwd(), PROOF_DIR, 'GRAMMAR_CROSSCHECK.json'), 'utf8'));
  grammarBacking = { checked: g.checked, matched: g.matched, matchRate: g.matchRate };
} catch { /* proof optional at parse time */ }

const allPass = results.every((r) => r.status === 'PASS');
const summary = {
  revised_contract_comparison: 'pr7a1',
  parser: 'Chadwick cwevent 0.10.0 (8f7e0ecd8984cd752e6aca5deba81b86fb369602)',
  grammarCrossCheckFromProof: grammarBacking,
  cases: results,
  overall: allPass ? 'PASS' : 'FAIL',
};
if (OUT) fs.writeFileSync(path.join(process.cwd(), OUT), JSON.stringify(summary, null, 2) + '\n');

console.log('PR7A.1 revised contract comparison');
if (grammarBacking) console.log(`  grammar cross-check (proof): ${grammarBacking.matched}/${grammarBacking.checked} rate ${grammarBacking.matchRate}`);
for (const r of results) {
  console.log(`  ${r.status.padEnd(4)} ${r.case}${r.realAnchored ? ' [real]' : ''}`);
  for (const p of r.problems) console.log(`       - ${p}`);
}
console.log(`  OVERALL: ${summary.overall}`);
process.exit(allPass ? 0 : 1);
